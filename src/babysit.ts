/**
 * PR Babysitter. Rene has dozens of open PRs and no time to watch them;
 * this is the cron-friendly "what needs me right now" report.
 *
 * For each PR it runs the existing engines (CI triage, review triage,
 * guard), diffs the result against a stored watermark (~/.greenlight/
 * babysit.json or --state), and returns ONE prioritized action list:
 *
 *   needs you now — new likely-real review findings, CI newly failing on
 *   your code, merge conflicts, new guard flags, checks stuck >2h
 *   waiting on them — checks still running, CI green with no feedback yet
 *   quiet — nothing needs you
 *
 * The first run (no watermark) reports the full picture and says so.
 * Exit code 0 always unless usage is wrong; --fail-on-action gives exit 3
 * when "needs you now" is non-empty, for cron alerting.
 */
import { apiGet, parsePullUrl } from "./github.js";
import { triagePr, type CiTriageResult, type CiTriageVerdict } from "./ci-triage.js";
import { triageReview as defaultTriageReview, type ReviewTriageResult, type ClassifiedFinding } from "./review-triage.js";
import { guardPr, type GuardResult } from "./guard.js";
import { computeIssueStatus } from "./protocol-fetch.js";
import type { IssueStatusPayload } from "./protocol.js";
import {
  defaultRegistryPath,
  loadRegistry,
  removeClaim,
  registryExists,
  type MyClaim,
} from "./claims-registry.js";
import { bucketClaim, type ClaimBucket } from "./claim-health.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const BABYSIT_VERSION = "0.9.0";

/** Checks pending longer than this are reported as stuck, not just running. */
export const STUCK_CHECK_MINUTES = 120;

/** Cap on discovered PRs per --mine run; the summary always states the cap. */
export const MINE_DISCOVERY_CAP = 100;

export interface BabysitPull {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  state: string;
  headSha: string;
  baseRef: string;
  /** GitHub may report null while it computes mergeability: unknown, not clean. */
  mergeable: boolean | null;
  mergeableState: string | null;
  url: string;
}

export interface BabysitCheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  startedAt: string | null;
  detailsUrl?: string;
}

export interface BabysitDeps {
  fetchPr?: (owner: string, repo: string, number: number) => Promise<BabysitPull>;
  fetchCheckRuns?: (owner: string, repo: string, headSha: string) => Promise<BabysitCheckRun[]>;
  triageCi?: (prUrl: string) => Promise<CiTriageResult>;
  triageReview?: (prUrl: string) => Promise<ReviewTriageResult>;
  guard?: (prUrl: string) => Promise<GuardResult>;
  discoverPrs?: (author: string, repos: string[]) => Promise<string[]>;
  /** Protocol status per registered claim; the default hits the API. */
  computeStatus?: (owner: string, repo: string, number: number) => Promise<{ status: IssueStatusPayload; issueUpdatedAt: string | null }>;
}

interface PullApiItem {
  title?: unknown;
  user?: { login?: unknown };
  state?: unknown;
  head?: { sha?: unknown };
  base?: { ref?: unknown };
  mergeable?: unknown;
  mergeable_state?: unknown;
  html_url?: unknown;
}

interface CheckRunApiItem {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  started_at?: unknown;
  details_url?: unknown;
}

interface SearchApiItem {
  items?: Array<{ html_url?: unknown }>;
  total_count?: unknown;
}

async function defaultFetchPr(owner: string, repo: string, number: number): Promise<BabysitPull> {
  const p = (await apiGet(`/repos/${owner}/${repo}/pulls/${number}`)) as PullApiItem;
  return {
    owner,
    repo,
    number,
    title: String(p.title ?? ""),
    author: String(p.user?.login ?? "unknown"),
    state: String(p.state ?? "open"),
    headSha: String(p.head?.sha ?? ""),
    baseRef: String(p.base?.ref ?? ""),
    mergeable: typeof p.mergeable === "boolean" ? p.mergeable : null,
    mergeableState: typeof p.mergeable_state === "string" ? p.mergeable_state : null,
    url: String(p.html_url ?? `https://github.com/${owner}/${repo}/pull/${number}`),
  };
}

/**
 * Workflow runs waiting on maintainer approval are the check-runs API's
 * blind spot: GitHub does not surface them as check runs on the commit
 * (mealie-recipes/mealie#8753: the actions runs API reported three
 * action_required workflow runs while check-runs showed only two benign
 * entries). Merge the two sources so the approval gate is visible. Pure;
 * tests drive it with fixtures.
 */
export function mergeActionRequiredRuns(
  existing: BabysitCheckRun[],
  actionRequiredNames: string[]
): BabysitCheckRun[] {
  const names = new Set(existing.map((r) => r.name));
  const out = [...existing];
  for (const name of actionRequiredNames) {
    if (!names.has(name)) {
      out.push({ name, status: "completed", conclusion: "action_required", startedAt: null });
      names.add(name);
    }
  }
  return out;
}

async function fetchActionRequiredWorkflowRuns(owner: string, repo: string, headSha: string): Promise<string[]> {
  try {
    const data = (await apiGet(
      `/repos/${owner}/${repo}/actions/runs?head_sha=${headSha}&per_page=20`
    )) as { workflow_runs?: Array<{ name?: unknown; conclusion?: unknown }> };
    return (data.workflow_runs ?? [])
      .filter((r) => String(r.conclusion ?? "") === "action_required")
      .map((r) => String(r.name ?? "unknown workflow"));
  } catch {
    return [];
  }
}

async function defaultFetchCheckRuns(
  owner: string,
  repo: string,
  headSha: string
): Promise<BabysitCheckRun[]> {
  if (!headSha) return [];
  const out: BabysitCheckRun[] = [];
  for (let page = 1; page <= 3; page++) {
    const data = (await apiGet(
      `/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100&page=${page}`
    )) as { check_runs?: CheckRunApiItem[] };
    const runs = data?.check_runs ?? [];
    for (const r of runs) {
      out.push({
        name: String(r.name ?? "unknown"),
        status: String(r.status ?? ""),
        conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
        startedAt: typeof r.started_at === "string" ? r.started_at : null,
        detailsUrl: typeof r.details_url === "string" ? r.details_url : undefined,
      });
    }
    if (runs.length < 100) break;
  }
  return mergeActionRequiredRuns(out, await fetchActionRequiredWorkflowRuns(owner, repo, headSha));
}

async function defaultDiscoverPrs(author: string, repos: string[]): Promise<string[]> {
  const urls: string[] = [];
  for (const ref of repos) {
    const m = /^([^/]+)\/([^/]+)$/.exec(ref.trim());
    if (!m) continue;
    for (let page = 1; page <= 2 && urls.length < MINE_DISCOVERY_CAP; page++) {
      const q = encodeURIComponent(`repo:${m[1]}/${m[2]} is:pr is:open author:${author}`);
      const data = (await apiGet(`/search/issues?q=${q}&per_page=100&page=${page}`)) as SearchApiItem;
      for (const item of data?.items ?? []) {
        if (typeof item.html_url === "string" && urls.length < MINE_DISCOVERY_CAP) urls.push(item.html_url);
      }
      if ((data?.items ?? []).length < 100) break;
    }
  }
  return urls;
}

/* ------------------------------------------------------------------ */
/* State (watermarks)                                                  */
/* ------------------------------------------------------------------ */

export interface BabysitWatermark {
  headSha: string;
  seenReviewIds: string[];
  seenGuardFlags: string[];
  lastCiVerdict?: string;
  lastMergeableState?: string | null;
  checkedAt: string;
}

export interface BabysitStateFile {
  version: 1;
  watermarks: Record<string, BabysitWatermark>;
}

export function defaultStatePath(): string {
  return join(homedir(), ".greenlight", "babysit.json");
}

export function loadState(path: string): BabysitStateFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BabysitStateFile>;
    if (parsed && typeof parsed === "object" && parsed.watermarks && typeof parsed.watermarks === "object") {
      return { version: 1, watermarks: parsed.watermarks as Record<string, BabysitWatermark> };
    }
  } catch {
    // Missing or broken state: start fresh. The run says so.
  }
  return { version: 1, watermarks: {} };
}

export function saveState(path: string, state: BabysitStateFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function watermarkKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

/** Deterministic identity for a review finding, for "new since last run". */
export function reviewFindingId(f: Pick<ClassifiedFinding, "author" | "path" | "line" | "summary">): string {
  return [f.author, f.path ?? "", String(f.line ?? ""), f.summary].join("|");
}

/** Deterministic identity for a guard finding, for "new since last run". */
export function guardFlagId(check: string, title: string): string {
  return `${check}|${title}`;
}

/* ------------------------------------------------------------------ */
/* Per-PR report (pure over injected data)                             */
/* ------------------------------------------------------------------ */

export type ActionUrgency = "now" | "waiting";

export interface BabysitAction {
  urgency: ActionUrgency;
  pr: string;
  text: string;
  next: string;
}

export interface BabysitPrInput {
  prUrl: string;
  pr: BabysitPull;
  checkRuns: BabysitCheckRun[];
  ci: CiTriageResult;
  review: ReviewTriageResult;
  guard: GuardResult;
  watermark: BabysitWatermark | null;
  now?: Date;
}

export interface BabysitPrReport {
  pr: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  headSha: string;
  headChanged: boolean;
  /** Set when the PR is no longer open: "merged" or "closed". No actions; the PR drops to the quiet list. */
  resolution?: "merged" | "closed";
  conflicts: boolean;
  mergeableState: string | null;
  ciVerdict: CiTriageVerdict;
  yoursFailing: string[];
  pendingChecks: string[];
  stuckChecks: string[];
  newLikelyReal: ClassifiedFinding[];
  newNeedsDecision: ClassifiedFinding[];
  newGuardFlags: string[];
  guardSummary: string;
  actions: BabysitAction[];
}

function minutesPending(run: BabysitCheckRun, now: Date): number | null {
  if (!run.startedAt) return null;
  const t = new Date(run.startedAt).getTime();
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 60000;
}

/**
 * Build the per-PR report. Pure: everything network-shaped comes in on
 * the input, so fixtures can prove the change detection and ordering.
 */
export function buildPrReport(input: BabysitPrInput): BabysitPrReport {
  const { prUrl, pr, checkRuns, ci, review, guard, watermark } = input;
  const now = input.now ?? new Date();
  const actions: BabysitAction[] = [];

  const headChanged = watermark !== null && watermark.headSha !== "" && pr.headSha !== "" && watermark.headSha !== pr.headSha;

  // CI: which failing checks are actually yours (or lean yours).
  const yoursFailing: string[] = [];
  for (const c of ci.checks) {
    if (c.class === "likely-yours") yoursFailing.push(c.name);
    else if (c.class === "indeterminate" && c.lean === "yours") yoursFailing.push(`${c.name} (lean: yours)`);
  }

  // Pending check runs, with the stuck (>2h) split.
  const pending: string[] = [];
  const stuck: string[] = [];
  for (const r of checkRuns) {
    if (r.status === "completed") continue;
    if (r.conclusion && !["neutral", "skipped"].includes(r.conclusion)) continue;
    const age = minutesPending(r, now);
    if (age !== null && age > STUCK_CHECK_MINUTES) stuck.push(`${r.name} (${Math.round(age)}m)`);
    else pending.push(r.name);
  }

  // New review findings since the watermark.
  const seenReviews = new Set(watermark?.seenReviewIds ?? []);
  const actionable = review.findings.filter((f) => f.class === "likely-real" || f.class === "needs-decision");
  const newFindings = actionable.filter((f) => !seenReviews.has(reviewFindingId(f)));
  const newLikelyReal = newFindings.filter((f) => f.class === "likely-real");
  const newNeedsDecision = newFindings.filter((f) => f.class === "needs-decision");

  // New guard flags since the watermark.
  const seenFlags = new Set(watermark?.seenGuardFlags ?? []);
  const newGuardFlags = guard.findings
    .filter((f) => f.severity === "flag" && !seenFlags.has(guardFlagId(f.check, f.title)))
    .map((f) => f.title);

  const conflicts = pr.mergeable === false || pr.mergeableState === "dirty";

  const tag = `${pr.owner}/${pr.repo}#${pr.number}`;
  const add = (urgency: ActionUrgency, text: string, next: string) => {
    actions.push({ urgency, pr: tag, text, next });
  };

  // ---- needs you now ----
  if (conflicts) {
    add("now", `Merge conflicts with ${pr.baseRef}`, "Rebase onto the base branch, resolve the conflicts, and push.");
  }
  if (yoursFailing.length > 0) {
    add(
      "now",
      `CI failing on your code: ${yoursFailing.join(", ")}`,
      "Fix the failures and push; the triage evidence names the base comparison for each check."
    );
  }
  if (newLikelyReal.length > 0) {
    add(
      "now",
      `${newLikelyReal.length} new review finding${newLikelyReal.length === 1 ? "" : "s"} that look real: ${newLikelyReal
        .slice(0, 3)
        .map((f) => f.summary)
        .join("; ")}${newLikelyReal.length > 3 ? ` (+${newLikelyReal.length - 3} more)` : ""}`,
      "Work through them and adapt the drafted replies; review triage has the reply text."
    );
  }
  if (newNeedsDecision.length > 0) {
    add(
      "now",
      `${newNeedsDecision.length} new review finding${newNeedsDecision.length === 1 ? "" : "s"} need your call: ${newNeedsDecision
        .slice(0, 2)
        .map((f) => f.summary)
        .join("; ")}`,
      "Decide each one (accept or push back) and reply; the drafts are in the review triage."
    );
  }
  if (newGuardFlags.length > 0) {
    add("now", `Guard flagged ${newGuardFlags.length} new thing${newGuardFlags.length === 1 ? "" : "s"}: ${newGuardFlags.slice(0, 3).join("; ")}`, "Read the guard comment; competing-fix and claim flags usually mean the issue is being worked by someone else.");
  }
  if (stuck.length > 0) {
    add(
      "now",
      `Checks stuck for over 2 hours: ${stuck.join(", ")}`,
      "The runs look wedged; re-run the failed/stuck checks or close and reopen the PR to retrigger."
    );
  }

  // ---- waiting on them ----
  if (pending.length > 0) {
    add("waiting", `Checks still running: ${pending.slice(0, 5).join(", ")}${pending.length > 5 ? ` (+${pending.length - 5} more)` : ""}`, "Nothing to do yet; this report updates when they finish.");
  }
  // GitHub's maintainer-approval gate (conclusion action_required on the
  // check runs, e.g. fork PRs touching workflow files): the run never
  // executed, so this is a waiting state on the maintainer, never a green
  // or failing one. Field case: mealie-recipes/mealie#8753.
  const approvalWaiting =
    ci.checks.some((c) => c.class === "external-blocker" && c.conclusion === "action_required") ||
    checkRuns.some((r) => r.status === "completed" && r.conclusion === "action_required");
  if (approvalWaiting) {
    add(
      "waiting",
      "checks waiting on maintainer workflow approval",
      "A maintainer must approve the workflow run before it executes (typical for fork PRs touching workflow files); there is nothing for you to fix."
    );
  }
  const externalBlocked = ci.checks.some((c) => c.class === "external-blocker" && c.conclusion !== "action_required");
  if (externalBlocked) {
    add("waiting", "CI blocked by the repo's own infrastructure (deploy/auth), not your code", "Nothing to fix; mention it to the maintainer if it persists.");
  }
  const calm =
    actions.length === 0 &&
    ci.verdict === "NO FAILURES" &&
    review.verdict === "NO FINDINGS" &&
    !conflicts &&
    pending.length === 0 &&
    stuck.length === 0;
  if (calm) {
    add(
      "waiting",
      "Checks green, no review feedback yet",
      "Nothing owed. Ping the maintainer after a few days if it stays quiet."
    );
  }

  return {
    pr: tag,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    author: pr.author,
    headSha: pr.headSha,
    headChanged,
    conflicts,
    mergeableState: pr.mergeableState,
    ciVerdict: ci.verdict,
    yoursFailing,
    pendingChecks: pending,
    stuckChecks: stuck,
    newLikelyReal,
    newNeedsDecision,
    newGuardFlags,
    guardSummary: guard.summary,
    actions,
  };
}

/** The watermark to store after a report, so the next run diffs against it. */
export function watermarkFromReport(report: BabysitPrReport, review: ReviewTriageResult, guard: GuardResult, now: Date): BabysitWatermark {
  return {
    headSha: report.headSha,
    seenReviewIds: review.findings.map((f) => reviewFindingId(f)),
    seenGuardFlags: guard.findings.filter((f) => f.severity === "flag").map((f) => guardFlagId(f.check, f.title)),
    lastCiVerdict: report.ciVerdict,
    lastMergeableState: report.mergeableState,
    checkedAt: now.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

export interface BabysitRunOptions {
  /** Comma-joined or array PR URLs. */
  prs?: string[];
  /** Discover this author's open PRs across these repos (search API). */
  mine?: boolean;
  repos?: string[];
  author?: string;
  statePath?: string;
  deps?: BabysitDeps;
  now?: Date;
  /** Only run the claims section (skip the PR scan entirely). */
  claimsOnly?: boolean;
  /** Override path for the my-claims registry. */
  claimsRegistryPath?: string;
}

/** One registered claim, bucketed for the report. */
export interface BabysitClaimReport {
  claim: MyClaim;
  bucket: ClaimBucket;
  detail: string;
  prUrl?: string;
  error?: string;
}

async function defaultComputeStatus(
  owner: string,
  repo: string,
  number: number
): Promise<{ status: IssueStatusPayload; issueUpdatedAt: string | null }> {
  const { status, snapshot } = await computeIssueStatus(owner, repo, number);
  return { status, issueUpdatedAt: snapshot.updatedAt ?? null };
}

export interface BabysitRun {
  reports: BabysitPrReport[];
  needsYouNow: BabysitAction[];
  waitingOnThem: BabysitAction[];
  quiet: string[];
  firstRun: boolean;
  prsChecked: number;
  /** Claims section (empty when the registry has no claims). */
  claims: BabysitClaimReport[];
  /** Claim issues that resolved this run (merged/closed/released) and were retired from the registry. */
  retiredClaims: string[];
  /** True when the registry file did not exist at all. */
  claimsRegistryMissing: boolean;
  /** True when this run skipped the PR scan (--claims-only). */
  claimsOnly: boolean;
  markdown: string;
  json: Record<string, unknown>;
}

function renderMarkdown(reports: BabysitPrReport[], run: Omit<BabysitRun, "markdown" | "json">): string {
  const lines: string[] = [];
  if (run.claimsOnly) {
    lines.push(`**Claims babysitter: ${run.claims.length} active claims** (${run.retiredClaims.length} retired this run)`);
  } else {
    lines.push(`**PR babysitter: ${run.needsYouNow.length} need you now, ${run.waitingOnThem.length} waiting, ${run.quiet.length} quiet** (${run.prsChecked} PRs checked)`);
  }
  if (run.firstRun) lines.push("_First run: no watermarks yet, so this is the full picture. Reruns report what changed since the last check._");
  lines.push("");
  const section = (title: string, items: BabysitAction[]) => {
    lines.push(`## ${title}`);
    if (items.length === 0) {
      lines.push("_None._");
    } else {
      for (const a of items) {
        lines.push(`- **${a.pr}** — ${a.text}`);
        lines.push(`  Next: ${a.next}`);
      }
    }
    lines.push("");
  };
  section("Needs you now", run.needsYouNow);
  section("Waiting on them", run.waitingOnThem);
  lines.push("## Quiet");
  if (run.quiet.length === 0) lines.push("_None._");
  else for (const q of run.quiet) lines.push(`- ${q}`);
  lines.push("");

  // Claims section (v0.9.0): the operator's registered claims, bucketed.
  if (run.claimsRegistryMissing) {
    lines.push("## My claims");
    lines.push("_No claims registry yet: `greenlight claim --register <issue-url>` records one._");
    lines.push("");
  } else if (run.claims.length > 0 || run.retiredClaims.length > 0) {
    lines.push(`## My claims (${run.claims.length} active)`);
    const order: ClaimBucket[] = ["linked", "queue-lost", "expiring", "heartbeat-due", "unlinked-stale", "healthy-active"];
    for (const bucket of order) {
      const group = run.claims.filter((c) => c.bucket === bucket);
      if (group.length === 0) continue;
      lines.push(`### ${bucket}`);
      for (const c of group) {
        if (c.error) lines.push(`- ${c.claim.issueUrl} — could not read status: ${c.error}`);
        else lines.push(`- ${c.detail}${c.prUrl ? ` (${c.prUrl})` : ""}`);
      }
      lines.push("");
    }
    for (const r of run.retiredClaims) lines.push(`_${r}_`);
    if (run.retiredClaims.length > 0) lines.push("");
  }
  for (const r of reports) {
    if (r.headChanged) lines.push(`_${r.pr}: new head ${r.headSha.slice(0, 7)} since the last check._`);
  }
  lines.push(`_Checked with Greenlight babysit v${BABYSIT_VERSION}._`);
  return lines.join("\n");
}

/**
 * The full babysit run: discover PRs (or take the list), fetch each PR's
 * signals, diff against watermarks, write the new watermarks, render.
 * Exit-0-friendly: per-PR failures degrade to an action item, never a
 * thrown error (usage errors are the caller's problem).
 */
export async function babysit(opts: BabysitRunOptions): Promise<BabysitRun> {
  const deps = opts.deps ?? {};
  const now = opts.now ?? new Date();
  const statePath = opts.statePath ?? defaultStatePath();
  const state = loadState(statePath);
  const firstRun = Object.keys(state.watermarks).length === 0;

  let prUrls = [...(opts.prs ?? [])];
  if (opts.mine) {
    const author = opts.author ?? "CloudCorpRecords";
    const repos = opts.repos ?? [];
    const discover = deps.discoverPrs ?? defaultDiscoverPrs;
    try {
      const found = await discover(author, repos);
      prUrls = found.slice(0, MINE_DISCOVERY_CAP);
    } catch (err) {
      prUrls = [];
      // Discovery failing degrades to an empty run with the reason stated.
      const run: BabysitRun = {
        reports: [],
        needsYouNow: [],
        waitingOnThem: [],
        quiet: [],
        firstRun,
        prsChecked: 0,
        claims: [],
        retiredClaims: [],
        claimsRegistryMissing: true,
        claimsOnly: false,
        markdown: `**PR babysitter: could not discover PRs** — ${err instanceof Error ? err.message : String(err)}`,
        json: { error: err instanceof Error ? err.message : String(err) },
      };
      return run;
    }
  }

  const reports: BabysitPrReport[] = [];
  const fetchPr = deps.fetchPr ?? defaultFetchPr;
  const fetchCheckRuns = deps.fetchCheckRuns ?? defaultFetchCheckRuns;
  const triageCi = deps.triageCi ?? triagePr;
  const triageReview = deps.triageReview ?? defaultTriageReview;
  const guard = deps.guard ?? guardPr;

  for (const prUrl of prUrls) {
    try {
      const { owner, repo, number } = parsePullUrl(prUrl);
      const pr = await fetchPr(owner, repo, number);
      if (pr.state !== "open") {
        // A closed or merged PR is done being babysat: it lands on the
        // quiet list with its resolution, and its watermark is retired so a
        // reopen shows up as a fresh full picture.
        const resolution = pr.state === "merged" ? "merged" : "closed";
        const tag = watermarkKey(owner, repo, number);
        reports.push({
          pr: tag, owner, repo, number,
          title: pr.title, author: pr.author,
          headSha: pr.headSha, headChanged: false,
          resolution,
          conflicts: false, mergeableState: null,
          ciVerdict: "INDETERMINATE",
          yoursFailing: [], pendingChecks: [], stuckChecks: [],
          newLikelyReal: [], newNeedsDecision: [], newGuardFlags: [],
          guardSummary: "",
          actions: [],
        });
        delete state.watermarks[tag];
        continue;
      }
      const [checkRuns, ci, review, guardResult] = await Promise.all([
        fetchCheckRuns(owner, repo, pr.headSha).catch(() => [] as BabysitCheckRun[]),
        triageCi(prUrl).catch(() => null),
        triageReview(prUrl).catch(() => null),
        guard(prUrl).catch(() => null),
      ]);
      if (!ci || !review || !guardResult) {
        reports.push({
          pr: watermarkKey(owner, repo, number),
          owner, repo, number,
          title: pr.title, author: pr.author,
          headSha: pr.headSha, headChanged: false,
          conflicts: false, mergeableState: pr.mergeableState,
          ciVerdict: "INDETERMINATE",
          yoursFailing: [], pendingChecks: [], stuckChecks: [],
          newLikelyReal: [], newNeedsDecision: [], newGuardFlags: [],
          guardSummary: "",
          actions: [{
            urgency: "waiting",
            pr: watermarkKey(owner, repo, number),
            text: "Could not read this PR's signals this run (API hiccup)",
            next: "Rerun the babysitter; this is a transient gap, not a finding.",
          }],
        });
        continue;
      }
      const key = watermarkKey(owner, repo, number);
      const report = buildPrReport({
        prUrl,
        pr,
        checkRuns,
        ci,
        review,
        guard: guardResult,
        watermark: state.watermarks[key] ?? null,
        now,
      });
      reports.push(report);
      state.watermarks[key] = watermarkFromReport(report, review, guardResult, now);
    } catch (err) {
      const tag = prUrl;
      reports.push({
        pr: tag, owner: "", repo: "", number: 0,
        title: "", author: "",
        headSha: "", headChanged: false,
        conflicts: false, mergeableState: null,
        ciVerdict: "INDETERMINATE",
        yoursFailing: [], pendingChecks: [], stuckChecks: [],
        newLikelyReal: [], newNeedsDecision: [], newGuardFlags: [],
        guardSummary: "",
        actions: [{
          urgency: "waiting",
          pr: tag,
          text: `Could not check this PR: ${err instanceof Error ? err.message : String(err)}`,
          next: "Check the URL and rerun.",
        }],
      });
    }
  }

  saveState(statePath, state);

  const needsYouNow = reports.flatMap((r) => r.actions.filter((a) => a.urgency === "now"));
  const waitingOnThem = reports.flatMap((r) => r.actions.filter((a) => a.urgency === "waiting"));
  const withActions = new Set([...needsYouNow, ...waitingOnThem].map((a) => a.pr));
  const quiet = reports
    .filter((r) => !withActions.has(r.pr))
    .map((r) =>
      r.resolution
        ? `${r.pr} "${r.title}" — ${r.resolution} since the last check`
        : `${r.pr} "${r.title}" — nothing needs you`
    );

  // Claims section (v0.9.0): bucket every registered claim by its live
  // protocol status. Claims whose issue resolved (merged/closed issue, a
  // completed protocol claim, a released claim) retire from the registry.
  const computeStatus = deps.computeStatus ?? defaultComputeStatus;
  const registryPath = opts.claimsRegistryPath ?? defaultRegistryPath();
  const claimsRegistryMissing = !registryExists(registryPath);
  const claims: BabysitClaimReport[] = [];
  const retiredClaims: string[] = [];
  if (!claimsRegistryMissing) {
    for (const claimEntry of loadRegistry(registryPath).claims) {
      try {
        const { status, issueUpdatedAt } = await computeStatus(claimEntry.owner, claimEntry.repo, claimEntry.number);
        const claimState = status.claim?.state;
        if (claimState === "completed" || claimState === "released") {
          // A completed or released claim is done: retire it.
          if (removeClaim(registryPath, claimEntry.issueUrl)) {
            retiredClaims.push(`${claimEntry.owner}/${claimEntry.repo}#${claimEntry.number} "${claimEntry.issueUrl}" — claim ${claimState ?? "resolved"}; retired from the registry`);
          }
          continue;
        }
        const h = bucketClaim({ claim: claimEntry, status, issueUpdatedAt, now });
        claims.push({ claim: claimEntry, bucket: h.bucket, detail: h.detail, prUrl: h.prUrl });
      } catch (err) {
        claims.push({ claim: claimEntry, bucket: "healthy-active", detail: "", error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const partial: Omit<BabysitRun, "markdown" | "json"> = {
    reports, needsYouNow, waitingOnThem, quiet, firstRun, prsChecked: reports.length,
    claims, retiredClaims, claimsRegistryMissing, claimsOnly: opts.claimsOnly ?? false,
  };
  const markdown = renderMarkdown(reports, partial);
  const json = {
    prsChecked: partial.prsChecked,
    firstRun,
    needsYouNow: needsYouNow.map((a) => ({ pr: a.pr, text: a.text, next: a.next })),
    waitingOnThem: waitingOnThem.map((a) => ({ pr: a.pr, text: a.text, next: a.next })),
    quiet,
    claims: claims.map((c) => ({ issue: c.claim.issueUrl, bucket: c.bucket, detail: c.detail, prUrl: c.prUrl ?? null, error: c.error ?? null })),
    retiredClaims,
    reports: reports.map((r) => ({
      pr: r.pr, title: r.title, headSha: r.headSha, headChanged: r.headChanged,
      conflicts: r.conflicts, ciVerdict: r.ciVerdict,
      yoursFailing: r.yoursFailing, pendingChecks: r.pendingChecks, stuckChecks: r.stuckChecks,
      newLikelyReal: r.newLikelyReal.map((f) => f.summary),
      newNeedsDecision: r.newNeedsDecision.map((f) => f.summary),
      newGuardFlags: r.newGuardFlags, guardSummary: r.guardSummary,
    })),
  };
  return { ...partial, markdown, json };
}
