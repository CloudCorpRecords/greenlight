/**
 * Autopilot (v0.11.0): PR feedback that fixes itself.
 *
 * Open PRs die waiting on bot reviews, CI failures, drift conflicts, and
 * DCO gaps between manual babysit sweeps. Autopilot closes that loop:
 *
 *   1. Collect feedback per open PR (reviews, review comments, issue
 *      comments, check conclusions), incremental via watermarks.
 *   2. Classify every item and verify bot findings against the code at head
 *      (REAL / FALSE_POSITIVE / NEEDS_HUMAN).
 *   3. Triage CI: introduced vs pre-existing against the base branch.
 *   4. In --apply mode, fix the mechanical items: DCO gaps (message-only
 *      surgery with byte-identical trees), merge conflicts (mechanical
 *      only, anything else aborts), formatting (whitespace-only diffs).
 *      No speculative source edits, ever.
 *   5. Never post comments: replies are drafted and queued behind the
 *      account's comment block.
 *
 * Default run is report-only. --apply performs fixes, capped by
 * --max-fixes (default 5). Autopilot consumes the v0.10.1 capability
 * ledger when present (degrading gracefully when absent) and records new
 * outcomes as it observes them.
 */
import { apiGet } from "./github.js";
import { fetchAuthorCensus, type CensusPr } from "./sync.js";
import { defaultAccountAuthor } from "./babysit.js";
import { triagePr, type ClassifiedCheck } from "./ci-triage.js";
import {
  loadCapabilities,
  prCreateBlockReason,
  defaultCapabilitiesPath,
  type CapabilitiesFile,
  type CapabilityAction,
} from "./capabilities.js";
import {
  triageReview,
  authorKindOf,
  type ReviewTriageDeps,
} from "./review-triage.js";
import { defaultPackageVersion } from "./doctor.js";
import {
  applyDcoSurgery,
  hasSignoff,
  DCO_SIGNOFF_LINE,
  defaultGitOps,
  type GitOps,
} from "./autopilot-git.js";
import {
  classifyReviewItem,
  verifyBotFinding,
  feedbackFromCiChecks,
  summarizeFeedback,
  type FeedbackItem,
  type FeedbackKind,
} from "./autopilot-triage.js";
import {
  conflictFileStrategy,
  parseConflictHunks,
  resolveVersionBumpHunk,
  resolveChangelogMerge,
  lockfileManager,
  diffIsFormattingOnly,
  detectFormatter,
  defaultGitRunner,
  type GitRunner,
  type ConflictHunk,
} from "./autopilot-fixes.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Rene's identity for fix commits. Standing signatory authority, non-legal. */
export const AUTOPILOT_COMMITTER = { name: "Rene Turcios", email: "95189389+CloudCorpRecords@users.noreply.github.com" };

export interface AutopilotPull {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeable: boolean | null;
  mergeableState: string | null;
  forkOwner: string;
  forkRepo: string;
  forkBranch: string;
  forkCloneUrl: string;
}

export interface PrWatermark {
  lastHeadSha: string;
  lastReviewId: number;
  lastReviewCommentId: number;
  lastIssueCommentId: number;
  checkConclusions: Record<string, string>;
}

export interface AutopilotState {
  version: number;
  prs: Record<string, PrWatermark>;
}

export function defaultAutopilotStatePath(): string {
  return join(homedir(), ".greenlight", "autopilot.json");
}

export function defaultRepliesPath(): string {
  return join(homedir(), ".greenlight", "autopilot-replies.json");
}

/**
 * Autopilot consumes the v0.10.1 capability ledger (src/capabilities.ts)
 * rather than duplicating it: loadCapabilities reads the canonical
 * ~/.greenlight/capabilities.json shape, prCreateBlockReason answers the
 * skip question, and fix outcomes are appended with autopilot-scoped
 * actions so they never shadow the ledger's pr_create/claim outcomes.
 */
export function recordAutopilotFixOutcome(
  capsPath: string,
  repo: string,
  kind: "dco" | "merge-conflict" | "format",
  outcome: "ok" | "failed-other",
  evidence: string,
  at: string = new Date().toISOString()
): void {
  try {
    const file: CapabilitiesFile = loadCapabilities(capsPath);
    file.entries.push({
      repo: repo.toLowerCase(),
      action: ("autopilot_fix:" + kind) as CapabilityAction,
      outcome,
      evidence: evidence.slice(0, 280),
      at,
    });
    mkdirSync(dirName(capsPath), { recursive: true });
    writeFileSync(capsPath, JSON.stringify(file, null, 2) + "\n");
  } catch {
    // Best effort: a ledger that cannot be written is a missed memory.
  }
}

function dirName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : ".";
}

function emptyWatermark(): PrWatermark {
  return { lastHeadSha: "", lastReviewId: 0, lastReviewCommentId: 0, lastIssueCommentId: 0, checkConclusions: {} };
}

export function loadAutopilotState(path: string): AutopilotState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as AutopilotState;
    if (raw && typeof raw === "object" && raw.prs) return { version: 1, prs: raw.prs };
  } catch { /* first run */ }
  return { version: 1, prs: {} };
}

export function saveAutopilotState(path: string, state: AutopilotState): void {
  mkdirSync(join(homedir(), ".greenlight"), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export interface AutopilotFix {
  kind: "dco" | "merge-conflict" | "format";
  itemId: string;
  oldHead: string;
  newHead: string;
  detail: string;
}

export interface AutopilotPlan {
  itemId: string;
  kind: FeedbackKind;
  title: string;
  plan: string;
}

export interface ReplyDraft {
  pr: string;
  itemId: string;
  kind: FeedbackKind;
  draft: string;
  queuedAt: string;
  queuedReason: string;
}

export interface PrReport {
  pr: AutopilotPull | null;
  url: string;
  skipped?: string;
  items: FeedbackItem[];
  fixes: AutopilotFix[];
  plans: AutopilotPlan[];
  replyDrafts: number;
  error?: string;
}

export interface AutopilotSummary {
  prsScanned: number;
  prsSkippedBlocked: number;
  prsErrored: number;
  itemsFound: number;
  fixesPushed: number;
  plans: number;
  repliesQueued: number;
  itemsByKind: Record<FeedbackKind, number>;
  botVerdicts: { real: number; falsePositive: number; needsHuman: number };
  ciIntroduced: number;
  ciPreExistingOrExternal: number;
}

export interface AutopilotRun {
  perPr: PrReport[];
  summary: AutopilotSummary;
  json: Record<string, unknown>;
  markdown: string;
}

export interface AutopilotDeps {
  discoverPrs?: (author: string) => Promise<CensusPr[]>;
  fetchPr?: (owner: string, repo: string, number: number) => Promise<AutopilotPull>;
  triageCi?: (prUrl: string) => Promise<{ checks: ClassifiedCheck[] }>;
  fetchReviewSources?: (
    owner: string,
    repo: string,
    number: number,
    since: { reviewId: number; reviewCommentId: number; issueCommentId: number }
  ) => Promise<{
    reviews: Array<{ id: number; state?: string; body?: string; user?: { login?: string } }>;
    reviewComments: Array<{ id: number; body?: string; user?: { login?: string }; path?: string; line?: number; diff_hunk?: string; pull_request_review_id?: number }>;
    issueComments: Array<{ id: number; body?: string; user?: { login?: string } }>;
    maxIds: { reviewId: number; reviewCommentId: number; issueCommentId: number };
  }>;
  fetchFileAtHead?: (owner: string, repo: string, headSha: string, path: string) => Promise<string | null>;
  /** PR commit SHAs, oldest first. Defaults to the pulls/commits endpoint. */
  fetchPrCommits?: (owner: string, repo: string, number: number) => Promise<string[]>;
  gitOps?: GitOps;
  gitRunner?: GitRunner;
  runInDir?: (cwd: string, label: string) => Promise<void>;
  cloneFork?: (cloneUrl: string, branch: string, dest: string) => Promise<void>;
  expectedForkOwner?: string;
}

export interface AutopilotRunOptions {
  author?: string;
  prs?: string[];
  maxPrs?: number;
  apply?: boolean;
  maxFixes?: number;
  statePath?: string;
  repliesPath?: string;
  capabilitiesPath?: string;
  concurrency?: number;
  deps?: AutopilotDeps;
}

async function paged<T>(base: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 3; page++) {
    const data = ((await apiGet(`${base}?per_page=100&page=${page}`)) as T[]) ?? [];
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

const numOf = (v: unknown): number => (typeof v === "number" ? v : 0);
const strOf = (v: unknown): string => (typeof v === "string" ? v : "");

async function defaultDiscoverPrs(author: string): Promise<CensusPr[]> {
  return (await fetchAuthorCensus(author)).filter((p) => p.state === "open");
}

async function defaultFetchPr(owner: string, repo: string, number: number): Promise<AutopilotPull> {
  const p = (await apiGet(`/repos/${owner}/${repo}/pulls/${number}`)) as {
    title?: unknown;
    user?: { login?: unknown };
    head?: { sha?: unknown; ref?: unknown; repo?: { owner?: { login?: unknown }; name?: unknown; clone_url?: unknown } };
    base?: { ref?: unknown; sha?: unknown };
    mergeable?: unknown;
    mergeable_state?: unknown;
    html_url?: unknown;
  };
  const headRepo = p.head?.repo;
  return {
    owner,
    repo,
    number,
    url: strOf(p.html_url) || `https://github.com/${owner}/${repo}/pull/${number}`,
    title: strOf(p.title),
    author: strOf(p.user?.login),
    headSha: strOf(p.head?.sha),
    baseRef: strOf(p.base?.ref),
    baseSha: strOf(p.base?.sha),
    mergeable: typeof p.mergeable === "boolean" ? p.mergeable : null,
    mergeableState: typeof p.mergeable_state === "string" ? p.mergeable_state : null,
    forkOwner: strOf(headRepo?.owner?.login),
    forkRepo: strOf(headRepo?.name),
    forkBranch: strOf(p.head?.ref),
    forkCloneUrl: strOf(headRepo?.clone_url),
  };
}

async function defaultFetchReviewSources(
  owner: string,
  repo: string,
  number: number,
  since: { reviewId: number; reviewCommentId: number; issueCommentId: number }
) {
  const [reviews, reviewComments, issueComments] = await Promise.all([
    paged<{ id?: unknown; state?: unknown; body?: unknown; user?: { login?: unknown } }>(`/repos/${owner}/${repo}/pulls/${number}/reviews`),
    paged<{ id?: unknown; body?: unknown; user?: { login?: unknown }; path?: unknown; line?: unknown; diff_hunk?: unknown; pull_request_review_id?: unknown }>(`/repos/${owner}/${repo}/pulls/${number}/comments`),
    paged<{ id?: unknown; body?: unknown; user?: { login?: unknown } }>(`/repos/${owner}/${repo}/issues/${number}/comments`),
  ]);
  const newReviews = reviews.filter((r) => numOf(r.id) > since.reviewId);
  const newReviewComments = reviewComments.filter((c) => numOf(c.id) > since.reviewCommentId);
  const newIssueComments = issueComments.filter((c) => numOf(c.id) > since.issueCommentId);
  const max = (arr: Array<{ id?: unknown }>, prev: number) =>
    arr.reduce((m, x) => Math.max(m, numOf(x.id)), prev);
  return {
    reviews: newReviews.map((r) => ({ id: numOf(r.id), state: strOf(r.state), body: strOf(r.body), user: { login: strOf(r.user?.login) } })),
    reviewComments: newReviewComments.map((c) => ({
      id: numOf(c.id),
      body: strOf(c.body),
      user: { login: strOf(c.user?.login) },
      path: typeof c.path === "string" ? c.path : undefined,
      line: typeof c.line === "number" ? c.line : undefined,
      diff_hunk: typeof c.diff_hunk === "string" ? c.diff_hunk : undefined,
      pull_request_review_id: typeof c.pull_request_review_id === "number" ? c.pull_request_review_id : undefined,
    })),
    issueComments: newIssueComments.map((c) => ({ id: numOf(c.id), body: strOf(c.body), user: { login: strOf(c.user?.login) } })),
    maxIds: {
      reviewId: max(reviews, since.reviewId),
      reviewCommentId: max(reviewComments, since.reviewCommentId),
      issueCommentId: max(issueComments, since.issueCommentId),
    },
  };
}

async function defaultFetchFileAtHead(
  owner: string,
  repo: string,
  headSha: string,
  path: string
): Promise<string | null> {
  try {
    const data = (await apiGet(
      `/repos/${owner}/${repo}/contents/${path}?ref=${headSha}`
    )) as { content?: unknown; encoding?: unknown };
    if (strOf(data.encoding) !== "base64" || typeof data.content !== "string") return null;
    return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
}

interface PrCommitItem {
  sha?: unknown;
}

async function defaultFetchPrCommits(owner: string, repo: string, number: number): Promise<string[]> {
  const items = (await apiGet(`/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`)) as PrCommitItem[];
  return (items ?? []).map((c) => strOf(c.sha)).filter(Boolean);
}

/**
 * Draft reply for a fixed item: what a human would post on the PR.
 * Autopilot never posts; these queue in autopilot-replies.json.
 */
export function draftForFix(item: FeedbackItem, fix: AutopilotFix): string {
  switch (fix.kind) {
    case "dco":
      return `Fixed the DCO sign-off gap: all commits on this branch now carry the Signed-off-by trailer. No code changes, only commit messages (commit trees are byte-identical).`;
    case "merge-conflict":
      return `Rebased onto the latest base and resolved the conflicts mechanically (${fix.detail}). Please let me know if anything looks off.`;
    case "format":
      return `Ran the repo formatter; this push is formatting-only (verified whitespace-only diff).`;
    default:
      return `Addressed: ${item.title}`;
  }
}

/** Draft reply for a rebutted bot finding. */
export function draftForRebuttal(item: FeedbackItem): string {
  return `Looked into this again: ${item.evidence ?? "the flagged code does not match what is at the PR head"}. Leaving it as is, happy to be shown otherwise.`;
}

async function defaultCloneFork(cloneUrl: string, branch: string, dest: string): Promise<void> {
  const git = defaultGitRunner();
  await git.run(tmpdir(), ["clone", "--no-checkout", cloneUrl, dest]);
  await git.run(dest, ["fetch", "origin", branch]);
  await git.run(dest, ["checkout", "-B", "autopilot-fix", `origin/${branch}`]);
}

async function runAutopilotOnPr(
  pr: AutopilotPull,
  watermark: PrWatermark,
  opts: AutopilotRunOptions,
  deps: AutopilotDeps,
  capabilities: CapabilitiesFile,
  capsPath: string,
  state: AutopilotState,
  expectedForkOwner: string
): Promise<PrReport> {
  const items: FeedbackItem[] = [];
  const fixes: AutopilotFix[] = [];
  const plans: AutopilotPlan[] = [];
  const drafts: ReplyDraft[] = [];

  // Capability gate: never rebuild where PR creation is blocked.
  const blockReason = prCreateBlockReason(capabilities, `${pr.owner}/${pr.repo}`);
  if (blockReason) {
    return { pr, url: pr.url, skipped: `capability ledger: ${blockReason}`, items, fixes, plans, replyDrafts: 0 };
  }

  // 1. Review feedback (incremental).
  const fetchReviewSources = deps.fetchReviewSources ?? defaultFetchReviewSources;
  const sources = await fetchReviewSources(pr.owner, pr.repo, pr.number, {
    reviewId: watermark.lastReviewId,
    reviewCommentId: watermark.lastReviewCommentId,
    issueCommentId: watermark.lastIssueCommentId,
  });
  const triageDeps: ReviewTriageDeps = {
    fetchPull: async () => ({ title: pr.title, author: pr.author }),
    fetchReviews: async () => sources.reviews as never[],
    fetchReviewComments: async () => sources.reviewComments as never[],
    fetchIssueComments: async () => sources.issueComments as never[],
  };
  const reviewResult = await triageReview(pr.url, triageDeps).catch(() => null);
  // Review-level verdicts: an APPROVED or CHANGES_REQUESTED review is an
  // actionable item in its own right, independent of comment classification.
  for (const r of sources.reviews) {
    const state = (r.state ?? "").toUpperCase();
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") continue;
    const login = r.user?.login ?? "unknown";
    if (login === pr.author) continue;
    items.push({
      id: `review:${r.id}`,
      kind: state === "APPROVED" ? "approval" : "review_change_request",
      title: `${login} ${state === "APPROVED" ? "approved" : "requested changes"}${r.body ? ": " + r.body.slice(0, 100) : ""}`,
      body: r.body ?? "",
      author: login,
      authorKind: authorKindOf(login),
      url: pr.url,
    });
  }
  if (reviewResult) {
    for (const f of reviewResult.findings) {
      if (f.author === pr.author) continue;
      const kind = classifyReviewItem({ body: f.summary, author: f.author, authorKind: f.authorKind });
      items.push({
        id: `finding:${f.author}:${f.summary.slice(0, 60)}`,
        kind: f.class === "likely-noise" ? "other" : kind,
        title: f.summary.slice(0, 120),
        body: f.summary,
        author: f.author,
        authorKind: f.authorKind,
        path: f.path,
        line: f.line,
        evidence: f.reason,
        draftReply: f.draft || undefined,
      });
    }
  }

  // 2. CI triage (introduced vs pre-existing).
  const triageCi = deps.triageCi ?? triagePr;
  const ciResult = await triageCi(pr.url).catch(() => null);
  if (ciResult && "checks" in ciResult) {
    for (const item of feedbackFromCiChecks(ciResult.checks as ClassifiedCheck[])) items.push(item);
  }

  // 3. Merge conflict state.
  if (pr.mergeableState === "dirty" || pr.mergeable === false) {
    items.push({
      id: `merge-conflict:${pr.headSha}`,
      kind: "merge_conflict",
      title: "Branch has merge conflicts with the base",
      body: `mergeable_state=${pr.mergeableState}`,
      author: "github",
      authorKind: "bot",
    });
  }

  // 4. DCO gaps: inspect commit messages.
  const fetchPrCommits = deps.fetchPrCommits ?? defaultFetchPrCommits;
  const commitShas = await fetchPrCommits(pr.owner, pr.repo, pr.number).catch(() => [] as string[]);
  const gitOps = deps.gitOps ?? defaultGitOps();
  const commitObjs = [];
  for (const sha of commitShas) {
    try {
      commitObjs.push(await gitOps.getCommit(pr.owner, pr.repo, sha));
    } catch { /* skip unreadable */ }
  }
  const unsigned = commitObjs.filter((c) => !hasSignoff(c.message));
  if (unsigned.length > 0) {
    items.push({
      id: `dco:${pr.headSha}`,
      kind: "dco_gap",
      title: `DCO: ${unsigned.length} commit(s) lack a Signed-off-by trailer`,
      body: `unsigned: ${unsigned.map((c) => c.sha.slice(0, 8)).join(", ")}`,
      author: "autopilot",
      authorKind: "bot",
      evidence: `${unsigned.length} of ${commitObjs.length} commits lack the trailer`,
    });
  }

  // 5. Verify bot findings against head.
  const fetchFileAtHead = deps.fetchFileAtHead ?? defaultFetchFileAtHead;
  for (const item of items) {
    if (item.kind === "bot_finding") {
      const { verdict, evidence } = await verifyBotFinding(item, {
        fetchFileAtHead: (path) => fetchFileAtHead(pr.owner, pr.repo, pr.headSha, path),
      }).catch(() => ({ verdict: "NEEDS_HUMAN" as const, evidence: "verification errored" }));
      item.verdict = verdict;
      item.evidence = evidence;
      if (verdict === "FALSE_POSITIVE" && item.draftReply) {
        drafts.push({
          pr: pr.url,
          itemId: item.id,
          kind: item.kind,
          draft: item.draftReply,
          queuedAt: new Date().toISOString(),
          queuedReason: "queued behind the GitHub comment block",
        });
      } else if (verdict === "FALSE_POSITIVE") {
        drafts.push({
          pr: pr.url,
          itemId: item.id,
          kind: item.kind,
          draft: draftForRebuttal(item),
          queuedAt: new Date().toISOString(),
          queuedReason: "queued behind the GitHub comment block",
        });
      }
    }
  }

  // 6. Apply fixes (report-only by default).
  const apply = !!opts.apply;
  const maxFixes = opts.maxFixes ?? 5;
  let fixesUsed = 0;
  const canFix = () => apply && fixesUsed < maxFixes;

  const forkOk =
    pr.forkOwner.toLowerCase() === expectedForkOwner.toLowerCase() && pr.forkRepo.length > 0 && pr.forkBranch.length > 0;

  if (apply && !forkOk) {
    plans.push({
      itemId: "guard:fork",
      kind: "other",
      title: "Fork ownership",
      plan: `refusing fixes: branch ${pr.forkBranch} is on ${pr.forkOwner}/${pr.forkRepo}, not the ${expectedForkOwner} fork`,
    });
  }

  // 6a. DCO surgery.
  const dcoItem = items.find((i) => i.kind === "dco_gap");
  if (dcoItem) {
    if (canFix() && forkOk) {
      try {
        const res = await applyDcoSurgery(pr.forkOwner, pr.forkRepo, pr.forkBranch, commitObjs, gitOps);
        fixes.push({
          kind: "dco",
          itemId: dcoItem.id,
          oldHead: res.oldHead,
          newHead: res.newHead,
          detail: `${res.fixed} commit(s) signed, ${res.anchored} anchored, trees byte-identical`,
        });
        fixesUsed += 1;
        drafts.push({
          pr: pr.url,
          itemId: dcoItem.id,
          kind: dcoItem.kind,
          draft: draftForFix(dcoItem, fixes[fixes.length - 1]),
          queuedAt: new Date().toISOString(),
          queuedReason: "queued behind the GitHub comment block",
        });
        recordAutopilotFixOutcome(capsPath, `${pr.owner}/${pr.repo}`, "dco", "ok",
          `${res.oldHead.slice(0, 8)} -> ${res.newHead.slice(0, 8)}`);
      } catch (err) {
        plans.push({
          itemId: dcoItem.id,
          kind: dcoItem.kind,
          title: dcoItem.title,
          plan: `DCO surgery failed and was rolled back before the ref move: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else if (!apply) {
      plans.push({
        itemId: dcoItem.id,
        kind: dcoItem.kind,
        title: dcoItem.title,
        plan: `report-only run: rerun with --apply to append the sign-off to ${unsigned.length} commit(s) (message-only, trees byte-identical)`,
      });
    }
  }

  // 6b. Merge conflicts: mechanical only.
  const conflictItem = items.find((i) => i.kind === "merge_conflict");
  if (conflictItem) {
    if (canFix() && forkOk) {
      const fix = await attemptMergeFix(pr, deps, expectedForkOwner).catch((err) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : String(err),
      }));
      if (fix.ok) {
        fixes.push({
          kind: "merge-conflict",
          itemId: conflictItem.id,
          oldHead: fix.oldHead,
          newHead: fix.newHead,
          detail: fix.detail,
        });
        fixesUsed += 1;
        drafts.push({
          pr: pr.url,
          itemId: conflictItem.id,
          kind: conflictItem.kind,
          draft: draftForFix(conflictItem, fixes[fixes.length - 1]),
          queuedAt: new Date().toISOString(),
          queuedReason: "queued behind the GitHub comment block",
        });
        recordAutopilotFixOutcome(capsPath, `${pr.owner}/${pr.repo}`, "merge-conflict", "ok", fix.detail);
      } else {
        plans.push({
          itemId: conflictItem.id,
          kind: conflictItem.kind,
          title: conflictItem.title,
          plan: fix.reason,
        });
      }
    } else if (!apply) {
      plans.push({
        itemId: conflictItem.id,
        kind: conflictItem.kind,
        title: conflictItem.title,
        plan: "report-only run: rerun with --apply to attempt a mechanical merge (lockfiles, changelog, version bumps only; anything else aborts)",
      });
    }
  }

  // 6c. Format fix for introduced CI failures that name formatting/lint.
  if (canFix() && forkOk) {
    const fmtCandidate = items.find(
      (i) =>
        i.kind === "ci_failure" &&
        i.verdict === "REAL" &&
        /lint|format|prettier|eslint|style/i.test(`${i.title} ${i.body}`)
    );
    if (fmtCandidate) {
      const fix = await attemptFormatFix(pr, deps, gitOps).catch((err) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : String(err),
      }));
      if (fix.ok) {
        fixes.push({ kind: "format", itemId: fmtCandidate.id, oldHead: fix.oldHead, newHead: fix.newHead, detail: fix.detail });
        fixesUsed += 1;
        drafts.push({
          pr: pr.url,
          itemId: fmtCandidate.id,
          kind: fmtCandidate.kind,
          draft: draftForFix(fmtCandidate, fixes[fixes.length - 1]),
          queuedAt: new Date().toISOString(),
          queuedReason: "queued behind the GitHub comment block",
        });
        recordAutopilotFixOutcome(capsPath, `${pr.owner}/${pr.repo}`, "format", "ok", fix.detail);
      } else {
        plans.push({ itemId: fmtCandidate.id, kind: fmtCandidate.kind, title: fmtCandidate.title, plan: fix.reason });
      }
    }
  }

  // 7. Plans for everything else actionable.
  for (const item of items) {
    if (item.kind === "bot_finding" && item.verdict === "REAL") {
      plans.push({
        itemId: item.id,
        kind: item.kind,
        title: item.title,
        plan: `real finding, no mechanical fix available: ${item.evidence ?? "see item"}`,
      });
    }
    if (item.kind === "review_change_request" || item.kind === "maintainer_question") {
      plans.push({
        itemId: item.id,
        kind: item.kind,
        title: item.title,
        plan: `needs Rene's judgment; a reply draft ${item.draftReply ? "is queued" : "was not available"}`,
      });
    }
    if (item.kind === "ci_failure" && item.verdict === "REAL" && !/lint|format|prettier|eslint|style/i.test(`${item.title} ${item.body}`)) {
      plans.push({
        itemId: item.id,
        kind: item.kind,
        title: item.title,
        plan: `introduced failure with no mechanical fix: ${item.evidence ?? "see CI logs"}`,
      });
    }
  }

  // Update watermark.
  state.prs[pr.url] = {
    lastHeadSha: pr.headSha,
    lastReviewId: Math.max(watermark.lastReviewId, sources.maxIds.reviewId),
    lastReviewCommentId: Math.max(watermark.lastReviewCommentId, sources.maxIds.reviewCommentId),
    lastIssueCommentId: Math.max(watermark.lastIssueCommentId, sources.maxIds.issueCommentId),
    checkConclusions: watermark.checkConclusions,
  };

  return { pr, url: pr.url, items, fixes, plans, replyDrafts: drafts.length, error: undefined, __drafts: drafts } as PrReport & { __drafts: ReplyDraft[] };
}

/**
 * Mechanical merge of the current base into the fork branch. Local git does
 * the merge computation in a temp clone; the merged tree is committed
 * through the Git Data API and the branch ref fast-forwarded. Returns
 * ok:false with a NEEDS_HUMAN reason whenever a conflict is not mechanical.
 */
export async function attemptMergeFix(
  pr: AutopilotPull,
  deps: AutopilotDeps,
  expectedForkOwner: string
): Promise<{ ok: true; oldHead: string; newHead: string; detail: string } | { ok: false; reason: string }> {
  if (pr.forkOwner.toLowerCase() !== expectedForkOwner.toLowerCase()) {
    return { ok: false, reason: `NEEDS_HUMAN: branch is on ${pr.forkOwner}, not ${expectedForkOwner}` };
  }
  const git = deps.gitRunner ?? defaultGitRunner();
  const cloneFork = deps.cloneFork ?? defaultCloneFork;
  const gitOps = deps.gitOps ?? defaultGitOps();
  const work = mkdtempSync(join(tmpdir(), "autopilot-merge-"));
  try {
    await cloneFork(pr.forkCloneUrl, pr.forkBranch, work);
    const upstreamUrl = `https://github.com/${pr.owner}/${pr.repo}.git`;
    await git.run(work, ["fetch", upstreamUrl, pr.baseRef]);
    const mergeBase = (await git.run(work, ["merge-base", "HEAD", "FETCH_HEAD"])).stdout.trim();
    const baseHead = (await git.run(work, ["rev-parse", "FETCH_HEAD"])).stdout.trim();
    const oldHead = (await git.run(work, ["rev-parse", "HEAD"])).stdout.trim();
    let conflicted: string[] = [];
    try {
      await git.run(work, ["merge", "--no-commit", "--no-ff", "FETCH_HEAD"]);
    } catch {
      conflicted = (await git.run(work, ["diff", "--name-only", "--diff-filter=U"])).stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (conflicted.length > 0) {
      const unresolvable: string[] = [];
      for (const file of conflicted) {
        const strategy = conflictFileStrategy(file);
        if (strategy === "lockfile") {
          const manager = lockfileManager(file);
          if (!manager) {
            unresolvable.push(file);
            continue;
          }
          const regenCmds: Record<string, string[]> = {
            npm: ["npm", "install", "--package-lock-only", "--no-audit", "--no-fund"],
            pnpm: ["pnpm", "install", "--lockfile-only"],
            yarn: ["yarn", "install", "--mode", "update-lockfile"],
            bun: ["bun", "install", "--lockfile-only"],
            cargo: ["cargo", "generate-lockfile"],
            go: ["go", "mod", "tidy"],
          };
          const cmd = regenCmds[manager];
          if (!cmd) {
            unresolvable.push(file);
            continue;
          }
          try {
            await git.run(work, cmd);
            await git.run(work, ["add", file]);
          } catch {
            unresolvable.push(file);
          }
          continue;
        }
        // Version-bump and changelog resolution on text conflicts.
        const oursText = (await git.run(work, ["show", `:2:${file}`])).stdout;
        const theirsText = (await git.run(work, ["show", `:3:${file}`])).stdout;
        const baseText = (await git.run(work, ["show", `:1:${file}`])).stdout;
        if (strategy === "changelog") {
          const resolved = resolveChangelogMerge(baseText, oursText, theirsText);
          writeFileSync(join(work, file), resolved);
          await git.run(work, ["add", file]);
          continue;
        }
        const baseLines = baseText.split("\n");
        // Resolve every hunk in the working file mechanically; an empty
        // result means some hunk was not mechanical.
        const resolvedText = await resolveHunksInFile(git, work, file, baseLines);
        if (resolvedText === "") {
          unresolvable.push(file);
          continue;
        }
        writeFileSync(join(work, file), resolvedText);
        await git.run(work, ["add", file]);
      }
      if (unresolvable.length > 0) {
        return {
          ok: false,
          reason: `NEEDS_HUMAN: ${unresolvable.length} conflicted file(s) are not mechanical: ${unresolvable.join(", ")}`,
        };
      }
    }
    const mergedTree = (await git.run(work, ["write-tree"])).stdout.trim();
    const message = `Merge ${pr.baseRef} into ${pr.forkBranch}\n\nAutopilot mechanical merge (conflicts resolved: ${conflicted.length > 0 ? conflicted.join(", ") : "none"})\n\n${DCO_SIGNOFF_LINE}`;
    const newHead = await gitOps.createCommit(pr.forkOwner, pr.forkRepo, {
      message,
      tree: mergedTree,
      parents: [oldHead, baseHead],
      author: { ...AUTOPILOT_COMMITTER },
      committer: { ...AUTOPILOT_COMMITTER },
    });
    await gitOps.updateRef(pr.forkOwner, pr.forkRepo, pr.forkBranch, newHead, false);
    const verifyTree = (await gitOps.getCommit(pr.forkOwner, pr.forkRepo, newHead)).treeSha;
    if (verifyTree !== mergedTree) throw new Error("merge commit tree mismatch after ref update");
    void mergeBase;
    return {
      ok: true,
      oldHead,
      newHead,
      detail: `merged ${pr.baseRef}@${baseHead.slice(0, 8)}; ${conflicted.length} conflicted file(s) resolved mechanically`,
    };
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch { /* temp cleanup is best-effort */ }
  }
}

/**
 * Resolve every conflict hunk in a working file using the mechanical
 * resolvers; returns "" when any hunk is not mechanical. Base content comes
 * from git stage 1 for the file.
 */
async function resolveHunksInFile(git: GitRunner, work: string, file: string, baseLines: string[]): Promise<string> {
  const text = readFileSync(join(work, file), "utf8");
  const hunks = parseConflictHunks(text);
  if (!hunks) return "";
  // Align base lines to hunks: compare each hunk's surroundings. For the
  // mechanical case we only accept single-line hunks where exactly one side
  // kept a base token and the other is a strict increase.
  const lines = text.split("\n");
  const out: string[] = [];
  let hunkIdx = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      const hunk = hunks[hunkIdx++];
      // Find the base single line: the first line that differs between
      // ours/theirs is resolved token-wise against a base candidate.
      const baseLine = findBaseLine(baseLines, hunk);
      const resolved = baseLine !== null ? resolveVersionBumpHunk(hunk, [baseLine]) : null;
      if (!resolved) return "";
      out.push(...resolved.resolved);
      while (i < lines.length && !lines[i].startsWith(">>>>>>>")) i++;
      i++;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}

/** Heuristic base line for a single-line hunk: a base line sharing the most tokens. */
function findBaseLine(baseLines: string[], hunk: ConflictHunk): string | null {
  if (hunk.ours.length !== 1 || hunk.theirs.length !== 1) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const line of baseLines) {
    const a = new Set(line.split(/\s+/));
    const scoreOurs = hunk.ours[0].split(/\s+/).filter((t) => a.has(t)).length;
    const scoreTheirs = hunk.theirs[0].split(/\s+/).filter((t) => a.has(t)).length;
    const score = Math.max(scoreOurs, scoreTheirs);
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  return bestScore > 0 ? best : null;
}

async function attemptFormatFix(
  pr: AutopilotPull,
  deps: AutopilotDeps,
  gitOps: GitOps
): Promise<{ ok: true; oldHead: string; newHead: string; detail: string } | { ok: false; reason: string }> {
  const git = deps.gitRunner ?? defaultGitRunner();
  const cloneFork = deps.cloneFork ?? defaultCloneFork;
  const work = mkdtempSync(join(tmpdir(), "autopilot-format-"));
  try {
    await cloneFork(pr.forkCloneUrl, pr.forkBranch, work);
    const oldHead = (await git.run(work, ["rev-parse", "HEAD"])).stdout.trim();
    const files = (await git.run(work, ["ls-files"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    let scripts: Record<string, string> = {};
    try {
      const pkg = JSON.parse(readFileSync(join(work, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      scripts = pkg.scripts ?? {};
    } catch { /* no package.json */ }
    const formatter = detectFormatter(files, scripts);
    if (!formatter) return { ok: false, reason: "no formatter path found (no format script, prettier, or eslint --fix)" };
    try {
      await git.run(work, formatter.cmd);
    } catch (err) {
      return { ok: false, reason: `formatter failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!(await diffIsFormattingOnly(git, work))) {
      return { ok: false, reason: "formatter changed non-whitespace content: refusing (not formatting-only)" };
    }
    const newTree = (await git.run(work, ["write-tree"])).stdout.trim();
    if (newTree === (await git.run(work, ["rev-parse", "HEAD^{tree}"])).stdout.trim()) {
      return { ok: false, reason: "formatter produced no changes" };
    }
    const message = `Apply ${formatter.name} (formatting only)\n\nAutopilot: whitespace-only diff verified via git diff -w\n\n${DCO_SIGNOFF_LINE}`;
    const newHead = await gitOps.createCommit(pr.forkOwner, pr.forkRepo, {
      message,
      tree: newTree,
      parents: [oldHead],
      author: { ...AUTOPILOT_COMMITTER },
      committer: { ...AUTOPILOT_COMMITTER },
    });
    await gitOps.updateRef(pr.forkOwner, pr.forkRepo, pr.forkBranch, newHead, false);
    return { ok: true, oldHead, newHead, detail: `formatter ${formatter.name}; whitespace-only diff` };
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
}

/** Persist reply drafts to the replies file, appending to any existing queue. */
export function saveReplyDrafts(path: string, drafts: ReplyDraft[]): number {
  let existing: ReplyDraft[] = [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { replies?: unknown };
    if (Array.isArray(raw.replies)) existing = raw.replies.filter((r) => r && typeof r === "object") as ReplyDraft[];
  } catch { /* new queue */ }
  mkdirSync(join(homedir(), ".greenlight"), { recursive: true });
  writeFileSync(path, JSON.stringify({ replies: [...existing, ...drafts] }, null, 2));
  return drafts.length;
}

const KIND_LABEL: Record<FeedbackKind, string> = {
  ci_failure: "CI failure",
  review_change_request: "Change request",
  bot_finding: "Bot finding",
  merge_conflict: "Merge conflict",
  dco_gap: "DCO gap",
  maintainer_question: "Maintainer question",
  approval: "Approval",
  other: "Other",
};

export function autopilotMarkdown(run: { perPr: PrReport[]; summary: AutopilotSummary }): string {
  const v = defaultPackageVersion();
  const lines: string[] = [];
  lines.push(`# Autopilot report`);
  lines.push(``);
  const s = run.summary;
  lines.push(
    `Scanned ${s.prsScanned} PR(s)${s.prsSkippedBlocked > 0 ? ` (${s.prsSkippedBlocked} skipped: capability-blocked)` : ""}: ` +
      `${s.itemsFound} feedback item(s), ${s.fixesPushed} fix(es) pushed, ${s.plans} plan(s), ${s.repliesQueued} reply draft(s) queued.`
  );
  for (const r of run.perPr) {
    lines.push(``);
    lines.push(`## ${r.url}`);
    if (r.skipped) {
      lines.push(`Skipped: ${r.skipped}`);
      continue;
    }
    if (r.error) {
      lines.push(`Error: ${r.error}`);
      continue;
    }
    if (r.items.length === 0 && r.fixes.length === 0) {
      lines.push(`Quiet: no new feedback.`);
      continue;
    }
    for (const item of r.items) {
      const verdict = item.verdict ? ` [${item.verdict}]` : "";
      lines.push(`- [${KIND_LABEL[item.kind]}]${verdict} ${item.title}`);
      if (item.evidence) lines.push(`  evidence: ${item.evidence.slice(0, 200)}`);
    }
    for (const f of r.fixes) {
      lines.push(`- FIX pushed (${f.kind}): ${f.oldHead.slice(0, 8)} -> ${f.newHead.slice(0, 8)} (${f.detail})`);
    }
    for (const p of r.plans) {
      lines.push(`- PLAN [${KIND_LABEL[p.kind]}]: ${p.title}: ${p.plan}`);
    }
  }
  lines.push(``);
  lines.push(`Greenlight autopilot v${v}`);
  return lines.join("\n");
}

export function autopilotJson(run: { perPr: PrReport[]; summary: AutopilotSummary }): Record<string, unknown> {
  return {
    perPr: run.perPr.map((r) => ({
      url: r.url,
      skipped: r.skipped ?? null,
      error: r.error ?? null,
      items: r.items.map((i) => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        author: i.author,
        authorKind: i.authorKind,
        verdict: i.verdict ?? null,
        evidence: i.evidence ?? null,
        url: i.url ?? null,
      })),
      fixes: r.fixes.map((f) => ({ kind: f.kind, itemId: f.itemId, oldHead: f.oldHead, newHead: f.newHead, detail: f.detail })),
      plans: r.plans,
    })),
    summary: run.summary,
    version: defaultPackageVersion(),
  };
}

async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Run Autopilot. Report-only by default; --apply performs fixes.
 * Returns the run with markdown and json renderings.
 */
export async function runAutopilot(opts: AutopilotRunOptions): Promise<AutopilotRun> {
  const deps = opts.deps ?? {};
  const author = opts.author ?? defaultAccountAuthor();
  const expectedForkOwner = deps.expectedForkOwner ?? defaultAccountAuthor();
  const statePath = opts.statePath ?? defaultAutopilotStatePath();
  const repliesPath = opts.repliesPath ?? defaultRepliesPath();
  const capsPath = opts.capabilitiesPath ?? defaultCapabilitiesPath();
  const state = loadAutopilotState(statePath);
  const capabilities: CapabilitiesFile = loadCapabilities(capsPath);

  let urls: string[] = [];
  if (opts.prs && opts.prs.length > 0) {
    urls = opts.prs;
  } else {
    const discover = deps.discoverPrs ?? defaultDiscoverPrs;
    const census = await discover(author);
    urls = census.map((p) => p.url);
  }
  const maxPrs = opts.maxPrs ?? 50;
  urls = urls.slice(0, maxPrs);

  const fetchPr = deps.fetchPr ?? defaultFetchPr;

  const perPr = await pool(urls, opts.concurrency ?? 3, async (url) => {
    try {
      const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
      if (!m) return { pr: null, url, skipped: "not a PR url", items: [], fixes: [], plans: [], replyDrafts: 0 } as PrReport;
      const pr = await fetchPr(m[1], m[2], Number(m[3]));
      const watermark = state.prs[url] ?? emptyWatermark();
      const report = await runAutopilotOnPr(pr, watermark, opts, { ...deps, fetchPr }, capabilities, capsPath, state, expectedForkOwner);
      const drafts = (report as PrReport & { __drafts?: ReplyDraft[] }).__drafts ?? [];
      if (drafts.length > 0) saveReplyDrafts(repliesPath, drafts);
      delete (report as PrReport & { __drafts?: ReplyDraft[] }).__drafts;
      report.replyDrafts = drafts.length;
      return report;
    } catch (err) {
      return {
        pr: null,
        url,
        items: [],
        fixes: [],
        plans: [],
        replyDrafts: 0,
        error: err instanceof Error ? err.message : String(err),
      } as PrReport;
    }
  });

  saveAutopilotState(statePath, state);

  const summary: AutopilotSummary = {
    prsScanned: perPr.filter((r) => !r.skipped && !r.error).length,
    prsSkippedBlocked: perPr.filter((r) => !!r.skipped).length,
    prsErrored: perPr.filter((r) => !!r.error).length,
    itemsFound: 0,
    fixesPushed: 0,
    plans: 0,
    repliesQueued: 0,
    itemsByKind: {
      ci_failure: 0, review_change_request: 0, bot_finding: 0, merge_conflict: 0,
      dco_gap: 0, maintainer_question: 0, approval: 0, other: 0,
    },
    botVerdicts: { real: 0, falsePositive: 0, needsHuman: 0 },
    ciIntroduced: 0,
    ciPreExistingOrExternal: 0,
  };
  for (const r of perPr) {
    summary.itemsFound += r.items.length;
    summary.fixesPushed += r.fixes.length;
    summary.plans += r.plans.length;
    summary.repliesQueued += r.replyDrafts;
    const fb = summarizeFeedback(r.items);
    for (const k of Object.keys(summary.itemsByKind) as FeedbackKind[]) summary.itemsByKind[k] += fb.byKind[k];
    summary.botVerdicts.real += fb.botFindingsReal;
    summary.botVerdicts.falsePositive += fb.botFindingsFalsePositive;
    summary.botVerdicts.needsHuman += fb.botFindingsNeedsHuman;
    summary.ciIntroduced += fb.ciIntroduced;
    summary.ciPreExistingOrExternal += fb.ciPreExistingOrExternal;
  }

  const run = { perPr, summary };
  return { perPr, summary, json: autopilotJson(run), markdown: autopilotMarkdown(run) };
}

// Re-export for callers that only need the author kind helper.
export { authorKindOf as autopilotAuthorKindOf };
