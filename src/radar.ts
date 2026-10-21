/**
 * PR Radar: maintainer-side duplicate / competing PR detection.
 *
 * The maintainer control-room wedge from the roadmap. In the AI-PR era,
 * maintainers drown in overlapping submissions: two contributors solving
 * the same issue, three bots regenerating the same migration, an old
 * stalled PR superseded by a fresh one. Review bots (CodeRabbit, Greptile)
 * live inside one repo's pipeline and do not answer "which of these open
 * PRs are doing the same work?" — that is the boundary layer Greenlight
 * owns, and every claim here carries quoted evidence, never a generic
 * AI opinion.
 *
 * Clustering (documented, deterministic):
 *   (a) same linked issue: a PR whose title/body/branch has CLOSING
 *       strength against an issue number it references (reusing
 *       classifyLinkStrength from linkstrength.js — the same machinery
 *       the check pipeline and Timeline X-Ray use; a bare "#N" mention
 *       is explicitly not enough, cf. issue #1).
 *   (b) no shared closing issue, but high changed-file overlap: pairs are
 *       cheaply pre-filtered by title-token overlap (Jaccard >= 0.4 on
 *       significant title tokens) so file lists are fetched only for
 *       plausible pairs; then Jaccard similarity on the full filename sets
 *       >= 0.6 AND a shared top-level directory -> cluster. File-list
 *       fetches are cached.
 *   Clusters are connected components over the pair graph: if A overlaps B
 *   and B overlaps C, all three land in one cluster even when A and C
 *   only touch lightly.
 *
 * Suggested keep (always labeled heuristic, never a verdict): earliest
 * opened wins ties by PR number; within a cluster the pick is the earliest
 * created_at, then the PR touching the most files, then the greenest
 * combined CI state (fetched only for the top two age candidates, so CI
 * never costs more than 2 calls per cluster).
 *
 * Budget (measured and reported in output):
 *   PR list: 1 call per 100 PRs (capped at 2 pages); linked-issue
 *   classification is free (title/body/branch regex); file lists: 1 call
 *   per 100 files per pre-filtered PR; CI status: <= 2 calls per cluster.
 *   Everything rides the existing file cache.
 */
import { apiCallsUsed, apiGet, cacheGet, cacheSet } from "./github.js";
import { classifyLinkStrength } from "./linkstrength.js";

/** One open PR, as the radar sees it. */
export interface RadarPR {
  number: number;
  title: string;
  body: string;
  author: string;
  branch: string;
  headSha: string;
  createdAt: string;
  url: string;
  draft: boolean;
  /** Fetched lazily, only for pre-filtered overlap candidates. */
  changedFiles?: string[];
}

export type RadarClusterKind = "same-issue" | "file-overlap";

export interface RadarCluster {
  kind: RadarClusterKind;
  /** Set for same-issue clusters. */
  issue?: { number: number; url: string };
  prs: number[];
  authors: string[];
  evidence: string[];
  /** A heuristic suggestion only: which PR to keep reviewing. */
  suggestedKeep: number;
  suggestedKeepReason: string;
}

export interface RadarResult {
  repo: string;
  prsScanned: number;
  clusters: RadarCluster[];
  /** PR numbers that matched nothing. */
  unclustered: number[];
  /** API calls consumed (measured, for budget honesty). */
  apiCalls: number;
}

export interface RadarDeps {
  /** Test seam / alternate listing. Default: live PR list via apiGet. */
  listOpenPRs?: (owner: string, repo: string, limit: number) => Promise<RadarPR[]>;
  /** Test seam for the file-list fetch. Default: live, cached. */
  fetchFiles?: (owner: string, repo: string, prNumber: number) => Promise<string[]>;
  /** Test seam for combined CI status. Default: live, only for top-2 age candidates. */
  fetchCombinedState?: (owner: string, repo: string, sha: string) => Promise<string>;
}

const MAX_PR_PAGES = 2;
const JACCARD_FILE_THRESHOLD = 0.6;
const JACCARD_TITLE_PREFILTER = 0.4;

interface RawPullItem {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  user?: { login?: unknown };
  head?: { ref?: unknown; sha?: unknown };
  created_at?: unknown;
  html_url?: unknown;
  draft?: unknown;
}

function toRadarPR(item: RawPullItem): RadarPR {
  return {
    number: Number(item.number ?? 0),
    title: String(item.title ?? ""),
    body: String(item.body ?? ""),
    author: String(item.user?.login ?? "unknown"),
    branch: String(item.head?.ref ?? ""),
    headSha: String(item.head?.sha ?? ""),
    createdAt: String(item.created_at ?? ""),
    url: String(item.html_url ?? ""),
    draft: Boolean(item.draft),
  };
}

async function defaultListOpenPRs(owner: string, repo: string, limit: number): Promise<RadarPR[]> {
  const key = [owner, repo, `open-prs-${limit}`];
  const cached = cacheGet("search", key) as RadarPR[] | undefined;
  if (cached) return cached;
  const out: RadarPR[] = [];
  for (let page = 1; page <= MAX_PR_PAGES && out.length < limit; page++) {
    const data = (await apiGet(
      `/repos/${owner}/${repo}/pulls?state=open&sort=created&direction=asc&per_page=100&page=${page}`
    )) as RawPullItem[];
    out.push(...(data ?? []).map(toRadarPR));
    if ((data ?? []).length < 100) break;
  }
  const sliced = out.slice(0, limit);
  cacheSet("search", key, sliced);
  return sliced;
}

async function defaultFetchFiles(owner: string, repo: string, prNumber: number): Promise<string[]> {
  const key = [owner, repo, String(prNumber), "files"];
  const cached = cacheGet("search", key) as string[] | undefined;
  if (cached) return cached;
  const files: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const data = (await apiGet(
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`
    )) as Array<{ filename?: unknown }>;
    for (const f of data ?? []) {
      if (typeof f.filename === "string") files.push(f.filename);
    }
    if ((data ?? []).length < 100) break;
  }
  cacheSet("search", key, files);
  return files;
}

async function defaultFetchCombinedState(owner: string, repo: string, sha: string): Promise<string> {
  if (!sha) return "unknown";
  try {
    const data = (await apiGet(`/repos/${owner}/${repo}/commits/${sha}/status`)) as {
      state?: unknown;
    };
    return String(data.state ?? "unknown");
  } catch {
    return "unknown";
  }
}

/** Issue numbers referenced in a PR title/body, deduplicated. */
export function extractIssueRefs(text: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  const re = /#(\d{1,6})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (n > 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * Tokens that, immediately before a number in a branch name, mark it as an
 * intentional issue reference ("fix-9483-wsdl", "issue-61"). Pure data.
 */
const ISSUE_PREFIX_TOKENS = new Set([
  "fix",
  "fixes",
  "fixed",
  "bug",
  "bugfix",
  "hotfix",
  "issue",
  "issues",
  "feat",
  "feature",
  "pr",
  "gh",
  "ticket",
]);

/**
 * Common HTTP status codes. A bare one in a branch name ("fix-mcp-oauth-500",
 * "fix-experiment-exposure-500-missing-variants") is an error code, not an
 * issue number; it only counts with an explicit marker (#N or a prefix token).
 */
const HTTP_STATUS_CODES = new Set([
  400, 401, 402, 403, 404, 405, 406, 408, 409, 410, 413, 414, 415, 416, 417, 418,
  421, 422, 423, 425, 426, 428, 429, 431, 451,
  500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511,
]);

/**
 * Issue numbers referenced by a branch name, deduplicated. Pure.
 *
 * A number counts ONLY under a defensible convention:
 *  - explicit "#N" marker in the branch;
 *  - an issue-prefix token immediately before it ("fix-9483-wsdl", "issue-61");
 *  - first token of a branch segment ("feat/61-resume-block", "123-fix-x");
 *  - trailing token at the end of the branch when it is a 3+ digit,
 *    non-status-code number preceded by a word ("fix/studio-sms-...-6435");
 *  - bare mid-branch token when it is a 3+ digit, non-status-code number
 *    ("pay-852-partial-...").
 * Never counted: GitHub web-UI "patch-N" names (patch-1, inian-patch-1),
 * version numbers (1.0, 2.73.0-rc.5), task counters paired with a
 * sub-counter (claude/task-22584764486-1, bot/task-987654-2),
 * bare counters under 100 mid/trailing
 * (bundle-size-3-migrate, ...-try-2), and alphanumerics like "oauth2"
 * (letter boundaries are not delimiters).
 *
 * Found by the maintainer-seeding runs: the seeding reports document 6
 * false-positive same-issue clusters, all from branch numbers that are not
 * issue references (supabase #1/#2 from patch-N branches, posthog #500
 * from "500 errors" branches, n8n #1 from "prior-to-1.0" and a bot task
 * counter, langfuse #1/#3 from patch-1 and bundle-size-3-migrate). Each is
 * pinned by a regression test naming the source.
 */
export function branchIssueRefs(branch: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  const add = (n: number) => {
    if (n > 0 && n <= 999999 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  for (const segment of branch.split("/")) {
    // Word tokens with raw offsets (letters/digits; "oauth2" stays one token).
    const tokens: Array<{ text: string; index: number }> = [];
    const re = /[A-Za-z0-9]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(segment)) !== null) {
      tokens.push({ text: m[0], index: m.index });
    }
    for (let i = 0; i < tokens.length; i++) {
      const { text: w, index } = tokens[i];
      if (!/^\d+$/.test(w)) continue;
      const n = Number(w);
      const prev = i > 0 ? tokens[i - 1].text.toLowerCase() : "";
      const after = segment.slice(index + w.length, index + w.length + 2);
      if (/^\.\d/.test(after)) continue; // version: "1.0", "2.73.0-rc.5"
      if (prev === "patch") continue; // GitHub web-UI branch: patch-1, inian-patch-1
      if (/^\d+$/.test(prev)) continue; // sub-counter after a number: task-22584764486-1
      const marked =
        new RegExp(`#${n}\\b`).test(branch) || ISSUE_PREFIX_TOKENS.has(prev);
      if (marked) {
        add(n);
        continue;
      }
      if (i === 0) {
        // Issue-first branch convention: "feat/61-resume-block", "123-fix-x".
        add(n);
        continue;
      }
      const next = i + 1 < tokens.length ? tokens[i + 1].text : "";
      // v0.21.0: a bare number immediately followed by another numeric
      // token is a counter namespace, not an issue ref: bot branches like
      // "bot/task-987654-2" pair a task/run ID with a sub-counter. The
      // existing rule only skipped the sub-counter itself; a 6-digit task
      // ID under the 999999 cap still leaked through as a phantom issue.
      if (/^\d+$/.test(next)) continue;
      if (HTTP_STATUS_CODES.has(n)) continue; // unmarked status code: an error code.
      if (n >= 100) add(n); // bare 3+ digit token, mid-branch or trailing.
      // Bare 1-2 digit tokens mid-branch or trailing ("-3-", "-try-2") are
      // counters, not issues.
    }
  }
  return out;
}

/**
 * The issue a PR is really working on: the referenced issue number for
 * which classifyLinkStrength says "closing". Bare mentions (pdfcn #91
 * listing sibling issues) never cluster. Candidate numbers come from
 * title/body #N refs AND branchIssueRefs (the tightened branch rule set,
 * so "oauth2", "patch-N", status codes, versions, and counters never
 * yield candidates); both go through the same classifyLinkStrength
 * gate. Pure.
 */
export function closingIssueForPR(pr: RadarPR): number | undefined {
  const candidates: number[] = [];
  for (const n of extractIssueRefs(`${pr.title}\n${pr.body}`)) {
    if (n !== pr.number && !candidates.includes(n)) candidates.push(n);
  }
  for (const n of branchIssueRefs(pr.branch)) {
    if (n !== pr.number && !candidates.includes(n)) candidates.push(n);
  }
  for (const n of candidates) {
    if (
      classifyLinkStrength({ title: pr.title, body: pr.body, branch: pr.branch, issueNumber: n }) ===
      "closing"
    ) {
      return n;
    }
  }
  return undefined;
}

const STOPWORDS = new Set(
  "the,a,an,and,or,of,to,in,for,on,with,by,from,fix,fixes,fixed,add,adds,added,update,updates,updated,support,bug,issue,feature,request,via,into,vs,new,old,all,use,used,this,that,these,those,are,is,was,were,be,been,as,at,it,its,it’s,i".split(",")
);

/** Significant lowercase title tokens for the cheap overlap pre-filter. Pure. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const topLevel = (path: string): string => path.split("/")[0] ?? "";

/**
 * Two PRs are overlap candidates when their title tokens overlap enough.
 * Pure; the expensive file fetch happens only past this gate.
 */
export function titlePrefilterHit(a: RadarPR, b: RadarPR): boolean {
  const ta = new Set(titleTokens(a.title));
  const tb = new Set(titleTokens(b.title));
  if (ta.size === 0 || tb.size === 0) return false;
  return jaccard(ta, tb) >= JACCARD_TITLE_PREFILTER;
}

/** Full file-set Jaccard; requires a shared top-level directory too. Pure. */
export function filesOverlap(a: string[], b: string[]): { overlap: boolean; jaccard: number; sharedDir?: string } {
  const sa = new Set(a);
  const sb = new Set(b);
  const j = jaccard(sa, sb);
  if (j < JACCARD_FILE_THRESHOLD) return { overlap: false, jaccard: j };
  const dirsA = new Set(a.map(topLevel));
  const shared = b.map(topLevel).find((d) => dirsA.has(d) && d !== "");
  if (!shared) return { overlap: false, jaccard: j };
  return { overlap: true, jaccard: j, sharedDir: shared };
}

/** Connected components over PR numbers. Pure. */
export function clusterPairs(members: number[], pairs: Array<[number, number]>): number[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    const p = parent.get(x) ?? x;
    if (p !== x) parent.set(x, find(p));
    return parent.get(x) ?? x;
  };
  const union = (a: number, b: number) => parent.set(find(a), find(b));
  for (const n of members) parent.set(n, n);
  for (const [a, b] of pairs) union(a, b);
  const groups = new Map<number, number[]>();
  for (const n of members) {
    const r = find(n);
    const g = groups.get(r) ?? [];
    g.push(n);
    groups.set(r, g);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Heuristic keep pick: earliest opened, then most files, then greenest CI. */
export function suggestKeep(
  cluster: RadarPR[],
  ciState: Map<number, string>
): { keep: number; reason: string } {
  const sorted = [...cluster].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.number - b.number;
  });
  const byFiles = [...sorted].sort((a, b) => (b.changedFiles?.length ?? 0) - (a.changedFiles?.length ?? 0));
  const oldest = sorted[0];
  const mostFiles = byFiles[0];
  const reasons: string[] = [`earliest opened (${oldest.createdAt.slice(0, 10)})`];
  let keep = oldest.number;
  if (mostFiles.number !== oldest.number) {
    reasons.push(`touches most files (#${mostFiles.number}: ${mostFiles.changedFiles?.length ?? 0})`);
  }
  // Greenest CI only among the top-2 age candidates (budget-capped).
  const green = sorted.slice(0, 2).find((p) => ciState.get(p.number) === "success");
  if (green && green.number !== keep) {
    reasons.push(`#${green.number} has green CI`);
  }
  return {
    keep,
    reason: `heuristic: ${reasons.join("; ")} — suggestion only, not a verdict`,
  };
}

const ageDays = (iso: string): number => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
};

/**
 * The radar pipeline. Best-effort: a failed file fetch removes that PR
 * from overlap consideration instead of failing the whole run.
 */
export async function radarPRs(
  owner: string,
  repo: string,
  opts: { limit?: number } = {},
  deps: RadarDeps = {}
): Promise<RadarResult> {
  const callsBefore = apiCallsUsed();
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const listOpenPRs = deps.listOpenPRs ?? defaultListOpenPRs;
  const fetchFiles = deps.fetchFiles ?? defaultFetchFiles;
  const fetchCombinedState = deps.fetchCombinedState ?? defaultFetchCombinedState;

  const prs = await listOpenPRs(owner, repo, limit);
  const byNumber = new Map(prs.map((p) => [p.number, p]));

  // Pass A: same-issue clusters via closing-strength links.
  const issueGroups = new Map<number, RadarPR[]>();
  for (const pr of prs) {
    const issue = closingIssueForPR(pr);
    if (issue === undefined) continue;
    const g = issueGroups.get(issue) ?? [];
    g.push(pr);
    issueGroups.set(issue, g);
  }
  const clustered = new Set<number>();
  const clusters: RadarCluster[] = [];
  for (const [issue, group] of issueGroups) {
    if (group.length < 2) continue;
    for (const p of group) clustered.add(p.number);
    const ciState = await ciStateFor(owner, repo, group, fetchCombinedState);
    const { keep, reason } = suggestKeep(group, ciState);
    clusters.push({
      kind: "same-issue",
      issue: { number: issue, url: `https://github.com/${owner}/${repo}/issues/${issue}` },
      prs: group.map((p) => p.number).sort((a, b) => a - b),
      authors: [...new Set(group.map((p) => p.author))],
      evidence: group.map(
        (p) => `#${p.number} "${p.title}" by @${p.author} (${ageDays(p.createdAt)}d old) closes #${issue} (${p.url})`
      ),
      suggestedKeep: keep,
      suggestedKeepReason: reason,
    });
  }

  // Pass B: file-overlap clusters among the rest. Files fetched only for
  // title-prefiltered pairs; a PR failing its fetch just sits out.
  const rest = prs.filter((p) => !clustered.has(p.number));
  const pairs: Array<[number, number]> = [];
  const evidenceForPair = new Map<string, string>();
  const fileCache = new Map<number, string[] | null>();
  const filesOf = async (p: RadarPR): Promise<string[] | null> => {
    if (fileCache.has(p.number)) return fileCache.get(p.number)!;
    try {
      const f = await fetchFiles(owner, repo, p.number);
      p.changedFiles = f;
      fileCache.set(p.number, f);
      return f;
    } catch {
      fileCache.set(p.number, null);
      return null;
    }
  };
  for (let i = 0; i < rest.length; i++) {
    for (let j = i + 1; j < rest.length; j++) {
      const a = rest[i];
      const b = rest[j];
      if (!titlePrefilterHit(a, b)) continue;
      const fa = await filesOf(a);
      const fb = await filesOf(b);
      if (!fa || !fb) continue;
      const fo = filesOverlap(fa, fb);
      if (!fo.overlap) continue;
      pairs.push([a.number, b.number]);
      evidenceForPair.set(
        `${Math.min(a.number, b.number)}-${Math.max(a.number, b.number)}`,
        `file overlap ${(fo.jaccard * 100).toFixed(0)}% (Jaccard) in ${fo.sharedDir ?? "?"}`
      );
    }
  }
  for (const group of clusterPairs(rest.map((p) => p.number), pairs)) {
    for (const n of group) clustered.add(n);
    const members = group.map((n) => byNumber.get(n)!);
    const ciState = await ciStateFor(owner, repo, members, fetchCombinedState);
    const { keep, reason } = suggestKeep(members, ciState);
    const ev: string[] = [];
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const k = `${Math.min(group[i], group[j])}-${Math.max(group[i], group[j])}`;
        if (evidenceForPair.has(k)) ev.push(`#${group[i]} ~ #${group[j]}: ${evidenceForPair.get(k)}`);
      }
    }
    clusters.push({
      kind: "file-overlap",
      prs: [...group].sort((a, b) => a - b),
      authors: [...new Set(members.map((p) => p.author))],
      evidence: ev,
      suggestedKeep: keep,
      suggestedKeepReason: reason,
    });
  }

  const unclustered = prs.map((p) => p.number).filter((n) => !clustered.has(n));
  return {
    repo: `${owner}/${repo}`,
    prsScanned: prs.length,
    clusters: clusters.sort((a, b) => a.prs[0] - b.prs[0]),
    unclustered,
    apiCalls: apiCallsUsed() - callsBefore,
  };
}

async function ciStateFor(
  owner: string,
  repo: string,
  group: RadarPR[],
  fetchCombinedState: (owner: string, repo: string, sha: string) => Promise<string>
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const byAge = [...group].sort((a, b) => a.number - b.number).slice(0, 2);
  for (const p of byAge) {
    try {
      out.set(p.number, await fetchCombinedState(owner, repo, p.headSha));
    } catch {
      out.set(p.number, "unknown");
    }
  }
  return out;
}
