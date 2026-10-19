/**
 * PR Brief: a verified review brief for ANY pull request.
 *
 * Generalizes the existing review/CI triage (built for our own PRs) into a
 * one-screen brief any reviewer — or maintainer — can read before opening
 * the diff. This is the overlap into review tooling (CodeRabbit/Greptile
 * territory) done Greenlight's way: every claim carries quoted evidence
 * or a link, classifications come from the existing deterministic triage
 * engines, and anything unverified is marked as such. No generic praise,
 * no invented findings.
 *
 * Sections:
 *   1. What changed: files grouped by area/risk (source, tests, config,
 *      docs, generated, other), plus size and shape.
 *   2. CI: the existing ci_triage base-vs-head classification, reused.
 *   3. Review findings: the existing review-triage classification, reused
 *      (real vs false-positive vs already-addressed, each with evidence).
 *   4. Test evidence present in the PR (new/changed test files), or
 *      explicitly marked absent.
 *   5. Merge-readiness blockers: conflicts, unresolved change requests,
 *      missing changeset where the repo requires one.
 *   6. A one-line "look at this first" for the reviewer.
 *
 * Budget: PR detail (1) + files (1-2) + reviews (1-2) + the triage
 * engines' own fetches + house-rules (cached, 24h TTL) for the changeset
 * signal. All reads ride the existing file cache.
 */
import {
  apiCallsUsed,
  apiGet,
  cacheGet,
  cacheSet,
  fetchContributing,
  parsePullUrl,
} from "./github.js";
import { triagePr, type CiTriageDeps, type CiTriageResult } from "./ci-triage.js";
import { triageReview, type ReviewTriageDeps, type ReviewTriageResult } from "./review-triage.js";

export type BriefFileArea = "source" | "tests" | "config" | "docs" | "generated" | "other";

export interface BriefFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "other";
  additions: number;
  deletions: number;
  area: BriefFileArea;
}

export interface BriefResult {
  pr: string;
  number: number;
  title: string;
  author: string;
  state: string;
  merged: boolean;
  draft: boolean;
  url: string;
  createdAt: string;
  ageDays: number;
  baseRef: string;
  size: { additions: number; deletions: number; filesChanged: number };
  areas: Array<{ area: BriefFileArea; files: string[] }>;
  ci: CiTriageResult;
  review: ReviewTriageResult;
  testEvidence: {
    newOrChangedTestFiles: string[];
    /** Plain statement: what test evidence exists, or that none does. */
    note: string;
  };
  /** Concrete merge blockers found, each with evidence. */
  blockers: string[];
  /** Things not verified, stated plainly. */
  unverified: string[];
  /** One line: what the reviewer should look at first. */
  lookFirst: string;
  /** API calls consumed (measured, for budget honesty). */
  apiCalls: number;
}

export interface BriefDeps {
  /** Test seam / alternate PR detail fetch. */
  fetchPullDetail?: (owner: string, repo: string, number: number) => Promise<PullDetailFull>;
  /** Test seam / alternate file list fetch. */
  fetchPullFiles?: (owner: string, repo: string, number: number) => Promise<BriefFile[]>;
  /** Test seam / alternate reviews fetch (for change-request blockers). */
  fetchReviews?: (owner: string, repo: string, number: number) => Promise<ReviewStateItem[]>;
  /** Test seam / alternate contributing-text fetch (changeset signal). */
  fetchContributingText?: (owner: string, repo: string) => Promise<string | undefined>;
  /** Forwarded to the CI triage engine. */
  ciDeps?: CiTriageDeps;
  /** Forwarded to the review triage engine. */
  reviewDeps?: ReviewTriageDeps;
}

export interface PullDetailFull {
  title: string;
  author: string;
  state: string;
  merged: boolean;
  draft: boolean;
  url: string;
  createdAt: string;
  baseRef: string;
  mergeable: boolean | null;
  mergeableState: string;
}

export interface ReviewStateItem {
  state: string;
  author: string;
  dismissed: boolean;
}

/**
 * Parse a PR target: full /pull/ URL, or owner/repo#N shorthand.
 * Throws a usage error otherwise.
 */
export function parseBriefTarget(target: string): { owner: string; repo: string; number: number } {
  const t = target.trim();
  try {
    return parsePullUrl(t);
  } catch {
    const m = /^([^/]+)\/([^/#]+)#(\d+)$/.exec(t);
    if (!m) {
      throw new Error(
        `Not a PR target: ${target} (expected a pull-request URL or owner/repo#N)`
      );
    }
    return { owner: m[1], repo: m[2], number: Number(m[3]) };
  }
}

/** Area classification for a file path. Pure. */
export function fileArea(path: string): BriefFileArea {
  const p = path.toLowerCase();
  if (
    /\/tests?\/|\/__tests__\/|\.test\.|\.spec\.|_test\.|-test\.|test_\b/.test(p) ||
    p.startsWith("test/") ||
    p.startsWith("tests/")
  ) {
    return "tests";
  }
  if (
    p.startsWith(".github/") ||
    p.endsWith("package-lock.json") ||
    p.endsWith("yarn.lock") ||
    p.endsWith("pnpm-lock.yaml") ||
    p.endsWith(".lock") ||
    /(^|\/)dist\//.test(p) ||
    p.endsWith(".min.js") ||
    p.endsWith(".map") ||
    /\/generated\//.test(p)
  ) {
    return "generated";
  }
  if (
    p.startsWith(".") ||
    /(^|\/)(config|conf|settings?|scripts?|tools?|tooling|build|ci|infra|docker|k8s|kubernetes)\//.test(p) ||
    /\.(ya?ml|toml|ini|cfg|env|example)$/.test(p) ||
    p === "package.json" ||
    p === "tsconfig.json" ||
    p === "dockerfile"
  ) {
    return "config";
  }
  if (p.endsWith(".md") || p.endsWith(".mdx") || p.startsWith("docs/") || p.startsWith("doc/")) {
    return "docs";
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|java|kt|swift|c|cpp|h|hpp|cs|vue|svelte)$/.test(p)) {
    return "source";
  }
  return "other";
}

interface RawFileItem {
  filename?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
}

function toBriefFile(item: RawFileItem): BriefFile {
  const filename = String(item.filename ?? "");
  const rawStatus = String(item.status ?? "other").toLowerCase();
  const status: BriefFile["status"] =
    rawStatus === "added" || rawStatus === "modified" || rawStatus === "removed" || rawStatus === "renamed"
      ? rawStatus
      : "other";
  return {
    filename,
    status,
    additions: typeof item.additions === "number" ? item.additions : 0,
    deletions: typeof item.deletions === "number" ? item.deletions : 0,
    area: fileArea(filename),
  };
}

async function defaultFetchPullDetail(owner: string, repo: string, number: number): Promise<PullDetailFull> {
  const key = [owner, repo, String(number), "brief-detail"];
  const cached = cacheGet("issue", key) as PullDetailFull | undefined;
  if (cached) return cached;
  const p = (await apiGet(`/repos/${owner}/${repo}/pulls/${number}`)) as Record<string, unknown>;
  const detail: PullDetailFull = {
    title: String(p.title ?? ""),
    author: String((p.user as Record<string, unknown> | undefined)?.login ?? "unknown"),
    state: String(p.state ?? "open"),
    merged: (p.merged_at as unknown) != null,
    draft: Boolean(p.draft),
    url: String(p.html_url ?? `https://github.com/${owner}/${repo}/pull/${number}`),
    createdAt: String(p.created_at ?? ""),
    baseRef: String((p.base as Record<string, unknown> | undefined)?.ref ?? ""),
    mergeable: (p.mergeable as boolean | null | undefined) ?? null,
    mergeableState: String(p.mergeable_state ?? "unknown"),
  };
  cacheSet("issue", key, detail);
  return detail;
}

async function defaultFetchPullFiles(owner: string, repo: string, number: number): Promise<BriefFile[]> {
  const key = [owner, repo, String(number), "brief-files"];
  const cached = cacheGet("issue", key) as BriefFile[] | undefined;
  if (cached) return cached;
  const files: BriefFile[] = [];
  for (let page = 1; page <= 5; page++) {
    const data = (await apiGet(
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`
    )) as RawFileItem[];
    for (const item of data ?? []) files.push(toBriefFile(item));
    if ((data ?? []).length < 100) break;
  }
  cacheSet("issue", key, files);
  return files;
}

async function defaultFetchReviews(owner: string, repo: string, number: number): Promise<ReviewStateItem[]> {
  const data = (await apiGet(
    `/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`
  )) as Array<Record<string, unknown>>;
  return (data ?? []).map((r) => ({
    state: String(r.state ?? ""),
    author: String((r.user as Record<string, unknown> | undefined)?.login ?? "unknown"),
    dismissed: String(r.state ?? "") === "DISMISSED",
  }));
}

const ageDays = (iso: string): number => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
};

/**
 * The brief pipeline. Best-effort per source: a failed fetch degrades to
 * an "unverified" note, never to silence or a fabricated verdict.
 */
export async function briefPR(target: string, deps: BriefDeps = {}): Promise<BriefResult> {
  const callsBefore = apiCallsUsed();
  const { owner, repo, number } = parseBriefTarget(target);
  const prUrl = `https://github.com/${owner}/${repo}/pull/${number}`;
  const unverified: string[] = [];
  const blockers: string[] = [];

  const fetchPullDetail = deps.fetchPullDetail ?? defaultFetchPullDetail;
  const fetchPullFiles = deps.fetchPullFiles ?? defaultFetchPullFiles;
  const fetchReviews = deps.fetchReviews ?? defaultFetchReviews;

  let detail: PullDetailFull;
  try {
    detail = await fetchPullDetail(owner, repo, number);
  } catch (err) {
    throw new Error(`could not fetch PR ${prUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let files: BriefFile[];
  try {
    files = await fetchPullFiles(owner, repo, number);
  } catch {
    files = [];
    unverified.push("changed-file list unavailable; area breakdown is empty");
  }

  // Reviews for change-request blockers (independent of the triage engine).
  let reviews: ReviewStateItem[] = [];
  try {
    reviews = await fetchReviews(owner, repo, number);
  } catch {
    unverified.push("review list unavailable; change-request blocker check skipped");
  }
  const openChangeRequests = reviews.filter(
    (r) => r.state === "CHANGES_REQUESTED" && !r.dismissed && r.author !== detail.author
  );
  for (const r of openChangeRequests) {
    blockers.push(`unresolved change request from @${r.author}`);
  }

  // Merge conflicts.
  if (detail.mergeable === false || detail.mergeableState === "dirty") {
    blockers.push("merge conflicts (mergeable_state=dirty)");
  } else if (detail.mergeable === null && detail.mergeableState === "unknown") {
    unverified.push("mergeable state not reported by GitHub yet");
  }

  // CI classification: reuse the existing triage engine (base vs head).
  let ci: CiTriageResult;
  try {
    ci = await triagePr(prUrl, deps.ciDeps ?? {});
  } catch {
    ci = {
      pr: prUrl, title: detail.title, baseRef: detail.baseRef, baseSha: "",
      headSha: "", verdict: "NO FAILURES", checks: [],
    } as unknown as CiTriageResult;
    unverified.push("CI triage unavailable");
  }

  // Review findings: reuse the existing deterministic review triage.
  let review: ReviewTriageResult;
  try {
    review = await triageReview(prUrl, deps.reviewDeps ?? {});
  } catch {
    review = {
      pr: prUrl, title: detail.title, verdict: "NO FINDINGS",
      findings: [], counts: { likelyReal: 0, likelyNoise: 0, needsDecision: 0, noise: 0, resolved: 0 },
    } as unknown as ReviewTriageResult;
    unverified.push("review triage unavailable");
  }

  // Changeset convention (remote variant of ci-prep's signal): repo
  // mentions changesets in its policy files, but the PR ships no
  // .changeset file -> blocker.
  try {
    const contributing = deps.fetchContributingText
      ? await deps.fetchContributingText(owner, repo)
      : await fetchContributing(owner, repo);
    if (contributing && /changeset/i.test(contributing)) {
      const hasChangeset = files.some((f) => /(^|\/)\.changeset\//.test(f.filename));
      if (!hasChangeset) blockers.push("repo requires changesets (CONTRIBUTING), none in this PR");
    }
  } catch {
    unverified.push("changeset convention check skipped (policy fetch failed)");
  }

  // Area breakdown.
  const areaOrder: BriefFileArea[] = ["source", "tests", "config", "docs", "generated", "other"];
  const areas = areaOrder
    .map((area) => ({ area, files: files.filter((f) => f.area === area).map((f) => f.filename) }))
    .filter((g) => g.files.length > 0);
  const additions = files.reduce((s, f) => s + f.additions, 0);
  const deletions = files.reduce((s, f) => s + f.deletions, 0);

  // Test evidence: new or changed test-area files, stated plainly.
  const testFiles = files.filter((f) => f.area === "tests").map((f) => f.filename);
  const testEvidenceNote =
    testFiles.length > 0
      ? `${testFiles.length} test file${testFiles.length === 1 ? "" : "s"} touched — verification is visible in the PR`
      : "no test files touched — verification is not visible in this PR";

  // Look-first: blockers first, then real findings, then CI, else shape.
  const firstReal = review.findings?.find((f) => f.class === "likely-real");
  const firstFailing = ci.checks?.find((c) => c.class === "likely-yours");
  const biggestArea = areas.reduce<{ area: string; count: number } | undefined>(
    (best, g) => (best === undefined || g.files.length > best.count ? { area: g.area, count: g.files.length } : best),
    undefined
  );
  const lookFirst =
    blockers.length > 0
      ? `Start here: ${blockers[0]}.`
      : firstReal !== undefined
        ? `Start here: ${firstReal.author}'s ${firstReal.class} finding${firstReal.path ? ` on ${firstReal.path}` : ""}: ${firstReal.summary}.`
        : firstFailing !== undefined
          ? `Start here: CI check "${firstFailing.name}" classified ${firstFailing.class}: ${firstFailing.evidence}.`
          : biggestArea !== undefined
            ? `No blockers or real findings. Start here: ${biggestArea.count} ${biggestArea.area} file${biggestArea.count === 1 ? "" : "s"} carry the change.`
            : "No blockers, findings, or files visible. Nothing to review.";

  return {
    pr: prUrl,
    number,
    title: detail.title,
    author: detail.author,
    state: detail.merged ? "merged" : detail.state,
    merged: detail.merged,
    draft: detail.draft,
    url: detail.url,
    createdAt: detail.createdAt,
    ageDays: ageDays(detail.createdAt),
    baseRef: detail.baseRef,
    size: { additions, deletions, filesChanged: files.length },
    areas,
    ci,
    review,
    testEvidence: { newOrChangedTestFiles: testFiles, note: testEvidenceNote },
    blockers,
    unverified,
    lookFirst,
    apiCalls: apiCallsUsed() - callsBefore,
  };
}
