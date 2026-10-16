/**
 * CI failure triage. Answers the question every contributor asks on a red
 * PR: "is this failure mine or pre-existing?"
 *
 * The classifier is a pure function over injected data (no network), so
 * the rules are unit-testable and pinned to the campaign's real cases:
 *
 *   - reticle #1620: windows install-gate failing identically on base
 *     (leftover-process flake) -> pre-existing
 *   - reticle #1633: fixture-based test failing in an untouched package,
 *     same check intermittent on base -> pre-existing
 *   - a unit-test check failing only on head in a package the PR touched
 *     -> likely-yours
 *   - Vercel "Authorization required" -> external-blocker (not the PR)
 *
 * Rule order per failing head check:
 *   1. external-blocker: the check name matches a known deploy/auth
 *      pattern (Vercel, Netlify, deploy previews). Evidence quotes the match.
 *   2. pre-existing: the same check name failed in the recent base
 *      window (exact variant first, then the matrix family, e.g. a windows
 *      install-gate flake with no exact-variant history). Evidence quotes
 *      base failure counts and the last failure time.
 *   3. likely-yours: failing on head, passing (or absent but with base
 *      history present) on base, AND the PR touches files plausibly
 *      related to the check (path token or semantic token match).
 *   4. indeterminate: failing on head with no base signal to compare
 *      against. Carries a lean ("pre-existing" when the PR does not touch
 *      the check's area, "yours" when it does) and says why.
 *
 * The live fetch layer is best-effort: base history and annotations each
 * degrade to "no evidence" on failure rather than guessing.
 */
import { apiGet, parsePullUrl } from "./github.js";

export type CiCheckClass = "pre-existing" | "likely-yours" | "indeterminate" | "external-blocker";

export type CiTriageVerdict = "ALL PRE-EXISTING" | "HAS LIKELY-YOURS" | "INDETERMINATE" | "NO FAILURES";

/** A failing check run on the PR head. */
export interface HeadCheck {
  name: string;
  conclusion: string;
  detailsUrl?: string;
  /** First meaningful failure lines from check-run annotations, best-effort. */
  failureLines?: string[];
}

/** One check-run result from the base branch's recent window. */
export interface BaseCheckRecord {
  name: string;
  conclusion: string;
  completedAt: string; // ISO timestamp
}

export interface ClassifiedCheck {
  name: string;
  conclusion: string;
  class: CiCheckClass;
  /** Human-readable evidence: base status, times, or the linked file. */
  evidence: string;
  /** On indeterminate only: which way it leans and why is in evidence. */
  lean?: "pre-existing" | "yours";
  failureLines?: string[];
  detailsUrl?: string;
}

export interface CiTriageInput {
  prUrl: string;
  prTitle: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  headChecks: HeadCheck[];
  baseRecords: BaseCheckRecord[];
  changedFiles: string[];
}

export interface CiTriageResult {
  pr: string;
  title: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  checks: ClassifiedCheck[];
  verdict: CiTriageVerdict;
}

/** Conclusions that count as "this check failed". "stale" (superseded by a newer push) is not a failure. */
const FAILING = new Set(["failure", "timed_out", "action_required"]);

/** Check-name patterns that mean the failure is infrastructure, not the PR. */
const EXTERNAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /vercel/i, label: "Vercel" },
  { pattern: /netlify/i, label: "Netlify" },
  { pattern: /authorization required/i, label: "authorization required" },
  { pattern: /deploy(ment)?\s*(preview|check)?/i, label: "deploy" },
  { pattern: /preview/i, label: "preview" },
  { pattern: /cloudflare pages/i, label: "Cloudflare Pages" },
];

/** Matrix suffixes ("name (windows-latest)") are family, not identity. */
export function stripMatrix(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

/** Case and whitespace are noise; the matrix suffix is kept so exact
 * variants match first and families match second. */
export function normalizeCheckName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Path segments that describe CI environments, not code areas. Ignored for file linking. */
const ENV_TOKENS = new Set([
  "windows", "macos", "ubuntu", "linux", "node", "nodejs", "python", "npm", "pnpm", "yarn",
  "run", "ci", "on", "the", "with", "and", "or", "e2e",
]);

/** Check-name tokens that semantically relate to file shapes. */
const SEMANTIC_TOKENS: Array<{ tokens: Set<string>; fileTest: RegExp }> = [
  { tokens: new Set(["lint", "eslint", "prettier", "format"]), fileTest: /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb)$/i },
  { tokens: new Set(["test", "tests", "unit", "spec", "jest", "vitest", "mocha", "pytest", "coverage"]), fileTest: /(^|\/)(test|tests|__tests__|spec)\b|\.test\.|\.spec\./i },
  { tokens: new Set(["typecheck", "tsc", "mypy", "pyright"]), fileTest: /\.(ts|tsx|py)$/i },
  { tokens: new Set(["build", "compile"]), fileTest: /\.(ts|tsx|js|jsx|py|go|rs)$/i },
];

const MAX_LINKED_EVIDENCE = 3;

/**
 * Files the PR touched that plausibly relate to a check, by path-token or
 * semantic-token match. Explainable by design: the caller quotes the
 * returned paths as the link evidence.
 */
export function checkTouchesFiles(checkName: string, files: string[]): string[] {
  const tokens = checkName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !ENV_TOKENS.has(t));
  const linked = new Set<string>();
  for (const file of files) {
    const fl = file.toLowerCase();
    const segs = fl.split("/");
    const stem = (segs.pop() ?? "").replace(/\.[a-z0-9]+$/, "");
    for (const t of tokens) {
      if (stem.includes(t)) {
        linked.add(file);
        break;
      }
      if (segs.some((s) => s === t || (t.length > 4 && s.includes(t)))) {
        linked.add(file);
        break;
      }
      if (SEMANTIC_TOKENS.some((g) => g.tokens.has(t) && g.fileTest.test(fl))) {
        linked.add(file);
        break;
      }
    }
  }
  return [...linked].slice(0, MAX_LINKED_EVIDENCE);
}

/**
 * Classify one failing head check against base records and changed files.
 * now is injected so tests pin ages.
 */
export function classifyCheck(
  head: HeadCheck,
  baseRecords: BaseCheckRecord[],
  changedFiles: string[]
): ClassifiedCheck {
  const name = head.name;
  for (const { pattern, label } of EXTERNAL_PATTERNS) {
    if (pattern.test(name)) {
      return {
        name,
        conclusion: head.conclusion,
        class: "external-blocker",
        evidence: `check name matches the ${label} deploy/auth pattern; this failure is infrastructure, not the PR`,
        detailsUrl: head.detailsUrl,
        failureLines: head.failureLines,
      };
    }
  }

  const wanted = normalizeCheckName(name);
  const family = stripMatrix(wanted);
  const baseForCheck = baseRecords.filter((r) => normalizeCheckName(r.name) === wanted);
  const baseFamilyFailures = baseRecords.filter(
    (r) => FAILING.has(r.conclusion) && stripMatrix(normalizeCheckName(r.name)) === family
  );
  const baseFailures = baseForCheck.filter((r) => FAILING.has(r.conclusion));
  if (baseFailures.length > 0) {
    baseFailures.sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
    const total = baseForCheck.length;
    const lastAt = baseFailures[0].completedAt ? `, last at ${baseFailures[0].completedAt}` : "";
    return {
      name,
      conclusion: head.conclusion,
      class: "pre-existing",
      evidence: `same check failing on base: ${baseFailures.length} of ${total} recent base run${total === 1 ? "" : "s"}${lastAt}`,
      detailsUrl: head.detailsUrl,
      failureLines: head.failureLines,
    };
  }
  if (baseFamilyFailures.length > 0) {
    baseFamilyFailures.sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
    const familyRuns = baseRecords.filter((r) => stripMatrix(normalizeCheckName(r.name)) === family).length;
    const lastAt = baseFamilyFailures[0].completedAt ? `, last at ${baseFamilyFailures[0].completedAt}` : "";
    return {
      name,
      conclusion: head.conclusion,
      class: "pre-existing",
      evidence: `check family "${family}" failing on base: ${baseFamilyFailures.length} of ${familyRuns} family runs${lastAt}`,
      detailsUrl: head.detailsUrl,
      failureLines: head.failureLines,
    };
  }

  const linked = checkTouchesFiles(name, changedFiles);
  if (baseForCheck.length > 0 && linked.length > 0) {
    return {
      name,
      conclusion: head.conclusion,
      class: "likely-yours",
      evidence: `passing on base but failing on head, and the PR touches ${linked.join(", ")} which relates to this check`,
      detailsUrl: head.detailsUrl,
      failureLines: head.failureLines,
    };
  }

  if (linked.length > 0) {
    return {
      name,
      conclusion: head.conclusion,
      class: "indeterminate",
      lean: "yours",
      evidence: `no base history for this check to compare against; the PR touches ${linked.join(", ")} which relates to it, so it leans yours`,
      detailsUrl: head.detailsUrl,
      failureLines: head.failureLines,
    };
  }
  return {
    name,
    conclusion: head.conclusion,
    class: "indeterminate",
    lean: "pre-existing",
    evidence: `no base history for this check to compare against; none of the PR's files relate to it, so it leans pre-existing (an unrelated flake is more likely than a new failure caused by this PR)`,
    detailsUrl: head.detailsUrl,
    failureLines: head.failureLines,
  };
}

/** Roll up per-check classes into the one-line verdict. */
export function triageVerdict(checks: ClassifiedCheck[]): CiTriageVerdict {
  if (checks.length === 0) return "NO FAILURES";
  if (checks.some((c) => c.class === "likely-yours")) return "HAS LIKELY-YOURS";
  if (checks.some((c) => c.class === "indeterminate")) return "INDETERMINATE";
  return "ALL PRE-EXISTING";
}

/** The pure engine: classify every failing head check, then roll up. */
export function classifyCiTriage(input: CiTriageInput): CiTriageResult {
  const checks = input.headChecks.map((h) => classifyCheck(h, input.baseRecords, input.changedFiles));
  return {
    pr: input.prUrl,
    title: input.prTitle,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    headSha: input.headSha,
    checks,
    verdict: triageVerdict(checks),
  };
}

export interface PullDetail {
  title: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
}

interface PullApiItem {
  title?: unknown;
  base?: { ref?: unknown; sha?: unknown };
  head?: { sha?: unknown };
}

interface FileApiItem {
  filename?: unknown;
}

interface CheckRunApiItem {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  details_url?: unknown;
  completed_at?: unknown;
}

interface AnnotationApiItem {
  annotation_level?: unknown;
  message?: unknown;
}

/** Test seam: every network call behind a named function. */
export interface CiTriageDeps {
  fetchPull?: (owner: string, repo: string, number: number) => Promise<PullDetail>;
  fetchHeadChecks?: (owner: string, repo: string, headSha: string) => Promise<HeadCheck[]>;
  fetchBaseRecords?: (owner: string, repo: string, baseRef: string) => Promise<BaseCheckRecord[]>;
}

async function fetchPullFiles(owner: string, repo: string, number: number): Promise<string[]> {
  const files: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const data = (await apiGet(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`)) as FileApiItem[];
    for (const f of data ?? []) {
      if (typeof f.filename === "string") files.push(f.filename);
    }
    if ((data ?? []).length < 100) break;
  }
  return files;
}

async function defaultFetchPull(owner: string, repo: string, number: number): Promise<PullDetail> {
  const p = (await apiGet(`/repos/${owner}/${repo}/pulls/${number}`)) as PullApiItem;
  return {
    title: String(p.title ?? ""),
    baseRef: String(p.base?.ref ?? ""),
    baseSha: String(p.base?.sha ?? ""),
    headSha: String(p.head?.sha ?? ""),
    changedFiles: await fetchPullFiles(owner, repo, number),
  };
}

const ANNOTATION_FETCH_LIMIT = 6;

async function fetchFailureLines(owner: string, repo: string, checkRunId: number): Promise<string[]> {
  try {
    const data = (await apiGet(
      `/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations?per_page=50`
    )) as AnnotationApiItem[];
    const lines: string[] = [];
    for (const a of data ?? []) {
      const level = String(a.annotation_level ?? "");
      if (level !== "failure" && level !== "error") continue;
      const msg = String(a.message ?? "").trim();
      if (msg) lines.push(msg.split("\n")[0].slice(0, 240));
      if (lines.length >= 3) break;
    }
    return lines;
  } catch {
    return [];
  }
}

async function defaultFetchHeadChecks(owner: string, repo: string, headSha: string): Promise<HeadCheck[]> {
  const data = (await apiGet(`/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`)) as {
    check_runs?: CheckRunApiItem[];
  };
  const failing = (data.check_runs ?? []).filter(
    (c) => c.status === "completed" && FAILING.has(String(c.conclusion ?? ""))
  );
  const out: HeadCheck[] = [];
  let annotationBudget = ANNOTATION_FETCH_LIMIT;
  for (const c of failing) {
    const id = typeof c.id === "number" ? c.id : undefined;
    let failureLines: string[] | undefined;
    if (id !== undefined && annotationBudget > 0) {
      annotationBudget -= 1;
      const lines = await fetchFailureLines(owner, repo, id);
      if (lines.length > 0) failureLines = lines;
    }
    out.push({
      name: String(c.name ?? "unnamed check"),
      conclusion: String(c.conclusion ?? "unknown"),
      detailsUrl: typeof c.details_url === "string" ? c.details_url : undefined,
      failureLines,
    });
  }
  return out;
}

/**
 * How many recent base-branch commits to inspect for each check's history.
 * Widened from 5 to 12: a short window misread long-running flakes (like
 * the reticle windows install-gate) as yours instead of pre-existing.
 */
export const BASE_COMMIT_WINDOW = 12;

/**
 * Legacy commit statuses (the combined status endpoint) as fallback
 * evidence when a commit has no check runs. Older CI (Travis, Jenkins,
 * AppVeyor) reports here instead of check runs; without this fallback the
 * triage sees "no base history" and mislabels legacy-backed failures as
 * indeterminate. States map to the same conclusion vocabulary: success
 * stays success, failure and error both read as failure, pending reads as
 * pending (harmless: it is not in the FAILING set).
 */
export function mapStatusToRecord(status: { context?: unknown; state?: unknown; updated_at?: unknown }): BaseCheckRecord {
  const state = String(status.state ?? "");
  return {
    name: String(status.context ?? "unnamed status"),
    conclusion: state === "failure" || state === "error" ? "failure" : state === "success" ? "success" : "pending",
    completedAt: typeof status.updated_at === "string" ? status.updated_at : "",
  };
}

async function defaultFetchBaseRecords(owner: string, repo: string, baseRef: string): Promise<BaseCheckRecord[]> {
  const records: BaseCheckRecord[] = [];
  let commits: Array<{ sha?: unknown }>;
  try {
    commits = (await apiGet(
      `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(baseRef)}&per_page=${BASE_COMMIT_WINDOW}`
    )) as Array<{ sha?: unknown }>;
  } catch {
    return records;
  }
  for (const commit of commits ?? []) {
    const sha = typeof commit.sha === "string" ? commit.sha : undefined;
    if (!sha) continue;
    try {
      const data = (await apiGet(`/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`)) as {
        check_runs?: CheckRunApiItem[];
      };
      const runs = data.check_runs ?? [];
      if (runs.length > 0) {
        for (const c of runs) {
          if (c.status !== "completed" || !c.conclusion) continue;
          records.push({
            name: String(c.name ?? "unnamed check"),
            conclusion: String(c.conclusion),
            completedAt: typeof c.completed_at === "string" ? c.completed_at : "",
          });
        }
        continue;
      }
      // No check runs on this commit: fall back to the legacy combined
      // status endpoint (Travis/Jenkins/AppVeyor report there). One extra
      // call per such commit, only when check runs are absent.
      try {
        const statusData = (await apiGet(`/repos/${owner}/${repo}/commits/${sha}/status`)) as {
          statuses?: Array<{ context?: unknown; state?: unknown; updated_at?: unknown }>;
        };
        for (const s of statusData.statuses ?? []) {
          records.push(mapStatusToRecord(s));
        }
      } catch {
        // A commit with neither signal contributes nothing; keep going.
      }
    } catch {
      // One bad commit in the window is not the whole story; keep going.
    }
  }
  // completedAt: check-runs list on commits lacks completed_at in some shapes;
  // fall back to "recent run" ordering when absent.
  return records;
}

/**
 * Full triage for a PR URL. Best-effort: if the base window cannot be
 * read, every check is classified without base data (indeterminate with a
 * lean) rather than erroring.
 */
export async function triagePr(prUrl: string, deps: CiTriageDeps = {}): Promise<CiTriageResult> {
  const { owner, repo, number } = parsePullUrl(prUrl);
  const fetchPull = deps.fetchPull ?? defaultFetchPull;
  const fetchHeadChecks = deps.fetchHeadChecks ?? defaultFetchHeadChecks;
  const fetchBaseRecords = deps.fetchBaseRecords ?? defaultFetchBaseRecords;

  const pull = await fetchPull(owner, repo, number);
  const headChecks = await fetchHeadChecks(owner, repo, pull.headSha);
  let baseRecords: BaseCheckRecord[];
  try {
    baseRecords = await fetchBaseRecords(owner, repo, pull.baseRef);
  } catch {
    baseRecords = [];
  }

  return classifyCiTriage({
    prUrl,
    prTitle: pull.title,
    baseRef: pull.baseRef,
    baseSha: pull.baseSha,
    headSha: pull.headSha,
    headChecks,
    baseRecords,
    changedFiles: pull.changedFiles,
  });
}
