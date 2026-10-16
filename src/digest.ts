/**
 * Repo-level maintainer digest. The guard answers "what is wrong with THIS
 * PR"; the digest answers "what needs my attention across my whole repo":
 * PR races (two open PRs fixing one issue), claimed-by-other conflicts,
 * stale claims, and assignment-gate conflicts.
 *
 * Four sections, all evidence-carrying, all degradable. A section that
 * cannot be computed says so and why, never silently empty.
 *
 * API budget discipline (unauthenticated: 60 calls/hr): the digest is
 * front-loaded with cheap list calls. Issue comments — the expensive part
 * — are fetched ONLY for linked issues whose issue metadata shows
 * comments > 0, and full timeline walks only happen for candidate stale
 * claims, never for every issue. Each fetch step below names its own
 * budget behavior.
 */
import { apiGet, fetchComments, fetchLinkedPRs, fetchContributing } from "./github.js";
import { parseGates } from "./gates.js";
import { detectClaims, isBotAuthor } from "./claims.js";
import { extractLinkedIssueNumbers, extractCrossRepoIssues, splitIssueClaims, type GuardClaim } from "./guard.js";
import type { CommentSignal, LinkedPR } from "./types.js";

export const DIGEST_VERSION = "0.3.11";

/** Default cap for list fetches; --limit overrides. The true total is always reported. */
export const DEFAULT_DIGEST_LIMIT = 50;
/** A claim on an open issue with no open PR after this many days is stale. */
export const STALE_CLAIM_DAYS = 14;
/** At this age the suggested action flips from "nudge" to "release". */
export const RELEASE_CLAIM_DAYS = 30;

export interface DigestPR {
  number: number;
  title: string;
  body: string;
  author: string;
  headRef: string;
  createdAt: string;
  url: string;
}

/** An issue this digest cares about, with its repo (cross-repo links supported). */
export interface DigestIssueKey {
  owner: string;
  repo: string;
  number: number;
  /** "#4668" for same-repo, "acme/widgets#123" for cross-repo. */
  label: string;
}

export interface DigestRace {
  issue: DigestIssueKey;
  issueTitle: string;
  issueUrl: string;
  prs: DigestPR[];
  /** The earliest claim on the issue, if any. */
  earliestClaim: { author: string; createdAt: string; strength: string; phrase: string } | null;
  /** "first claim: @x on DATE; first PR opened: #N by @y on DATE; the other PR(s) duplicate effort". */
  arbitration: string;
}

export interface DigestClaimConflict {
  pr: DigestPR;
  issue: DigestIssueKey;
  issueTitle: string;
  issueUrl: string;
  foreignClaims: GuardClaim[];
}

export interface DigestStaleClaim {
  issue: DigestIssueKey;
  issueTitle: string;
  issueUrl: string;
  claimant: string;
  claimDate: string;
  ageDays: number;
  /** "nudge @x" under 30 days, "release the claim" at 30+. */
  action: string;
}

export interface DigestAssignmentConflict {
  pr: DigestPR;
  issue: DigestIssueKey;
  issueTitle: string;
  issueUrl: string;
  /** Current assignees, or [] when the issue is assigned to nobody. */
  assignees: string[];
}

export interface DigestSectionNote {
  section: string;
  note: string;
}

export interface DigestResult {
  repo: string;
  races: DigestRace[];
  claimConflicts: DigestClaimConflict[];
  staleClaims: DigestStaleClaim[];
  assignmentConflicts: DigestAssignmentConflict[];
  /** Sections that could not be computed, with the reason why. */
  degraded: DigestSectionNote[];
  /** "# of sections zero" friendly summary header. */
  summary: string;
  prCap: number;
  trueOpenPRs: number | null;
  issueCap: number;
  trueOpenIssues: number | null;
  /** True when at least one race exists (--fail-on-race maps this to exit code 3). */
  hasRaces: boolean;
  markdown: string;
}

export interface DigestIssueMeta {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  commentsCount: number;
  assignees: string[];
  /** Full comments, fetched only when the candidate needs claims (see budget notes). */
  comments?: CommentSignal[];
}

/* ------------------------------------------------------------------ */
/* Pure section builders                                               */
/* ------------------------------------------------------------------ */

/**
 * Issue keys a PR links to: same-repo closing links plus cross-repo
 * closing references (guard's extractors, reused exactly).
 */
export function extractPRIssueKeys(pull: DigestPR, prOwner: string, prRepo: string): DigestIssueKey[] {
  const out: DigestIssueKey[] = [];
  const seen = new Set<string>();
  for (const n of extractLinkedIssueNumbers(pull.title, pull.body, pull.headRef)) {
    const label = `#${n}`;
    if (!seen.has(label)) {
      seen.add(label);
      out.push({ owner: prOwner, repo: prRepo, number: n, label });
    }
  }
  for (const r of extractCrossRepoIssues(pull.title, pull.body, prOwner, prRepo)) {
    const label = `${r.owner}/${r.repo}#${r.number}`;
    if (!seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      out.push({ owner: r.owner, repo: r.repo, number: r.number, label });
    }
  }
  return out;
}

/** Group open PRs by issue key; groups of 2+ are races. */
export function groupPRsByIssue(prs: DigestPR[], prOwner: string, prRepo: string): Map<string, { key: DigestIssueKey; prs: DigestPR[] }> {
  const groups = new Map<string, { key: DigestIssueKey; prs: DigestPR[] }>();
  for (const pr of prs) {
    for (const key of extractPRIssueKeys(pr, prOwner, prRepo)) {
      const mapKey = `${key.owner.toLowerCase()}/${key.repo.toLowerCase()}#${key.number}`;
      const g = groups.get(mapKey);
      if (g) {
        if (!g.prs.some((p) => p.number === pr.number)) g.prs.push(pr);
      } else {
        groups.set(mapKey, { key, prs: [pr] });
      }
    }
  }
  return groups;
}

function earliestOf<T>(items: T[], by: (t: T) => string): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (!best || by(item) < by(best)) best = item;
  }
  return best;
}

/**
 * One race: earliest claim (author + date) and earliest PR opened, with a
 * one-line arbitration summary. Pure: issue comments and PR groups are
 * injected.
 */
export function buildRace(
  group: { key: DigestIssueKey; prs: DigestPR[] },
  issueTitle: string,
  issueUrl: string,
  comments: CommentSignal[],
  now: Date = new Date()
): DigestRace {
  const claims = detectClaims("", comments, now).filter((c) => !isBotAuthor(c.author));
  claims.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = claims[0] ?? null;
  const firstPr = earliestOf(group.prs, (p) => p.createdAt) ?? group.prs[0];
  const otherPrs = group.prs.filter((p) => p.number !== firstPr.number);
  const arbitration = [
    first
      ? `first claim: @${first.author} on ${first.createdAt.slice(0, 10)}`
      : "no claim comments on this issue",
    `first PR opened: #${firstPr.number} by @${firstPr.author} on ${firstPr.createdAt.slice(0, 10)}`,
    otherPrs.length > 0
      ? `the other PR(s) duplicate effort: ${otherPrs.map((p) => `#${p.number} by @${p.author}`).join(", ")}`
      : "no other PRs",
  ].join("; ");
  return {
    issue: group.key,
    issueTitle,
    issueUrl,
    prs: [...group.prs].sort((a, b) => a.number - b.number),
    earliestClaim: first
      ? { author: first.author, createdAt: first.createdAt, strength: first.strength, phrase: first.phrase }
      : null,
    arbitration,
  };
}

/**
 * Claimed-by-other conflicts: open PRs whose linked issue carries a claim
 * by someone other than the PR author that predates the PR. Pure: per-issue
 * comments and author are injected; splitIssueClaims (guard) does the
 * actual matching.
 */
export function buildClaimConflicts(args: {
  prs: DigestPR[];
  prOwner: string;
  prRepo: string;
  issueData: Map<string, { key: DigestIssueKey; title: string; url: string; author: string; comments: CommentSignal[] }>;
}): DigestClaimConflict[] {
  const conflicts: DigestClaimConflict[] = [];
  for (const pr of args.prs) {
    for (const key of extractPRIssueKeys(pr, args.prOwner, args.prRepo)) {
      const mapKey = `${key.owner.toLowerCase()}/${key.repo.toLowerCase()}#${key.number}`;
      const data = args.issueData.get(mapKey);
      if (!data) continue;
      const { foreign } = splitIssueClaims(data.author, data.comments, pr.author, pr.createdAt, key.number);
      if (foreign.length > 0) {
        conflicts.push({ pr, issue: key, issueTitle: data.title, issueUrl: data.url, foreignClaims: foreign });
      }
    }
  }
  return conflicts;
}

/**
 * Stale claims: open issues with a claim older than STALE_CLAIM_DAYS and
 * NO open PR linked in the issue's timeline. Pure: claims come from
 * injected comments; the timeline result is injected as LinkedPR[].
 */
export function buildStaleClaims(
  candidates: Array<{
    key: DigestIssueKey;
    title: string;
    url: string;
    comments: CommentSignal[];
    linkedPRs: LinkedPR[];
  }>,
  now: Date = new Date()
): DigestStaleClaim[] {
  const out: DigestStaleClaim[] = [];
  for (const c of candidates) {
    const claims = detectClaims("", c.comments, now).filter((x) => !isBotAuthor(x.author));
    const hasOpenPR = c.linkedPRs.some((pr) => pr.state === "open");
    if (hasOpenPR) continue;
    for (const claim of claims) {
      if (claim.ageDays >= STALE_CLAIM_DAYS) {
        out.push({
          issue: c.key,
          issueTitle: c.title,
          issueUrl: c.url,
          claimant: claim.author,
          claimDate: claim.createdAt,
          ageDays: claim.ageDays,
          action: claim.ageDays >= RELEASE_CLAIM_DAYS ? "release the claim" : `nudge @${claim.author}`,
        });
      }
    }
  }
  out.sort((a, b) => b.ageDays - a.ageDays);
  return out;
}

/**
 * Assignment-gate conflicts: only runs when the repo's gates say
 * assignment is required. A PR whose author is not among the issue's
 * assignees is flagged; "assigned to nobody" is its own flavor.
 */
export function buildAssignmentConflicts(args: {
  prs: DigestPR[];
  prOwner: string;
  prRepo: string;
  assignmentRequired: boolean;
  assigneesByIssue: Map<string, { key: DigestIssueKey; title: string; url: string; assignees: string[] }>;
}): DigestAssignmentConflict[] {
  if (!args.assignmentRequired) return [];
  const conflicts: DigestAssignmentConflict[] = [];
  for (const pr of args.prs) {
    for (const key of extractPRIssueKeys(pr, args.prOwner, args.prRepo)) {
      const mapKey = `${key.owner.toLowerCase()}/${key.repo.toLowerCase()}#${key.number}`;
      const data = args.assigneesByIssue.get(mapKey);
      if (!data) continue;
      const mine = data.assignees.some((a) => a.toLowerCase() === pr.author.toLowerCase());
      if (!mine) {
        conflicts.push({ pr, issue: key, issueTitle: data.title, issueUrl: data.url, assignees: data.assignees });
      }
    }
  }
  return conflicts;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function buildDigestSummary(args: {
  repo: string;
  races: number;
  claimConflicts: number;
  staleClaims: number;
  assignmentConflicts: number;
  prCap: number;
  trueOpenPRs: number | null;
}): string {
  const capped =
    args.trueOpenPRs !== null && args.trueOpenPRs > args.prCap
      ? ` (showing ${args.prCap} of ${args.trueOpenPRs} open PRs)`
      : "";
  return `Digest for ${args.repo}${capped}: ${args.races} ${plural(args.races, "race", "races")}, ${args.claimConflicts} claimed-by-other ${plural(args.claimConflicts, "conflict", "conflicts")}, ${args.staleClaims} stale ${plural(args.staleClaims, "claim", "claims")}, ${args.assignmentConflicts} assignment ${plural(args.assignmentConflicts, "conflict", "conflicts")}`;
}

export function renderDigestMarkdown(result: DigestResult): string {
  const lines: string[] = [`# ${result.summary}`, ""];

  if (result.races.length > 0) {
    lines.push(`## PR races (${result.races.length})`);
    for (const race of result.races) {
      lines.push(`### ${race.issue.label}: ${race.issueTitle}`);
      lines.push(`- ${race.issueUrl}`);
      lines.push(`- open PRs: ${race.prs.map((p) => `#${p.number} by @${p.author} ("${p.title.slice(0, 60)}")`).join("; ")}`);
      lines.push(`- arbitration: ${race.arbitration}`);
      lines.push("");
    }
  }

  // Conflicts are strong foreign claims (someone actually claimed the work).
  // Soft foreign claims ("happy to help", "interested in this") render as
  // "possible interest", not conflicts: live runs showed soft patterns
  // matching polite offers that are not claims of work.
  const strongConflicts = result.claimConflicts.filter((c) => c.foreignClaims.some((f) => f.strength === "strong"));
  const softOnly = result.claimConflicts.filter((c) => !c.foreignClaims.some((f) => f.strength === "strong"));
  if (result.claimConflicts.length > 0) {
    lines.push(`## Claimed-by-other conflicts (${strongConflicts.length})`);
    for (const c of strongConflicts) {
      lines.push(
        `- PR #${c.pr.number} by @${c.pr.author} fixes ${c.issue.label} ("${c.issueTitle.slice(0, 60)}") but ${c.foreignClaims
          .filter((f) => f.strength === "strong")
          .map((f) => `@${f.author} claimed it on ${f.createdAt.slice(0, 10)}`)
          .join("; ")}`
      );
      lines.push(`  ${c.issueUrl}`);
    }
    if (softOnly.length > 0) {
      lines.push("");
      lines.push(`Possible interest (soft claims, not firm):`);
      for (const c of softOnly) {
        lines.push(
          `- PR #${c.pr.number} by @${c.pr.author} fixes ${c.issue.label}: ${c.foreignClaims
            .map((f) => `@${f.author} on ${f.createdAt.slice(0, 10)} ("${f.phrase}")`)
            .join("; ")}`
        );
      }
    }
    lines.push("");
  }

  if (result.staleClaims.length > 0) {
    lines.push(`## Stale claims (${result.staleClaims.length})`);
    for (const s of result.staleClaims) {
      lines.push(
        `- ${s.issue.label} "${s.issueTitle.slice(0, 60)}": @${s.claimant} claimed on ${s.claimDate.slice(0, 10)} (${s.ageDays} days ago), no open PR — suggested action: ${s.action}`
      );
      lines.push(`  ${s.issueUrl}`);
    }
    lines.push("");
  }

  if (result.assignmentConflicts.length > 0) {
    lines.push(`## Assignment-gate conflicts (${result.assignmentConflicts.length})`);
    for (const a of result.assignmentConflicts) {
      const assigneeText = a.assignees.length > 0 ? `assigned to ${a.assignees.map((x) => `@${x}`).join(", ")}` : "assigned to nobody";
      lines.push(`- PR #${a.pr.number} by @${a.pr.author} fixes ${a.issue.label} which is ${assigneeText} (repo requires assignment before a PR)`);
      lines.push(`  ${a.issueUrl}`);
    }
    lines.push("");
  }

  if (result.degraded.length > 0) {
    lines.push(`## Could not compute`);
    for (const d of result.degraded) lines.push(`- ${d.section}: ${d.note}`);
    lines.push("");
  }

  const zero = result.races.length === 0 && result.claimConflicts.length === 0 && result.staleClaims.length === 0 && result.assignmentConflicts.length === 0;
  if (zero && result.degraded.length === 0) {
    lines.push("_Nothing needs attention:_ no PR races, no claimed-by-other conflicts, no stale claims, no assignment conflicts.");
    lines.push("");
  }

  lines.push("---");
  lines.push(
    `_Generated with [Greenlight digest](https://github.com/CloudCorpRecords/greenlight) v${DIGEST_VERSION}; findings are signals, verify before acting._`
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Fetch layer (test-seam, mirrors guard)                              */
/* ------------------------------------------------------------------ */

interface PullApiItem {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  user?: { login?: unknown };
  head?: { ref?: unknown };
  created_at?: unknown;
  html_url?: unknown;
}

interface IssueListItem {
  number?: unknown;
  title?: unknown;
  user?: { login?: unknown };
  state?: unknown;
  comments?: unknown;
  html_url?: unknown;
  assignees?: Array<{ login?: unknown }>;
  pull_request?: unknown;
}

export interface DigestDeps {
  listOpenPRs?: (owner: string, repo: string, limit: number) => Promise<{ prs: DigestPR[]; total: number | null }>;
  listOpenIssues?: (owner: string, repo: string, limit: number) => Promise<{ issues: IssueListItem[]; total: number | null }>;
  fetchIssueMeta?: (owner: string, repo: string, number: number) => Promise<DigestIssueMeta>;
  fetchIssueComments?: (owner: string, repo: string, number: number) => Promise<CommentSignal[]>;
  fetchLinkedPRs?: (owner: string, repo: string, issueNumber: number) => Promise<LinkedPR[]>;
  fetchContributing?: (owner: string, repo: string) => Promise<string | undefined>;
}

/**
 * Budget notes (the live layer):
 * - listOpenPRs: 1 pulls call (+ up to 5 pages at limit 50); the true total
 *   comes from one search call. Cached per repo for the 6h CLI window.
 * - listOpenIssues: same shape against the issues endpoint (PRs filtered
 *   out via the pull_request key). Same true-total treatment.
 * - fetchIssueMeta: 1 call per distinct linked issue (title, author,
 *   assignees, comments count). NOT called for issues with no PR linked.
 * - fetchIssueComments: called only when meta.commentsCount > 0 AND the
 *   section needs claims. Never for comment-less issues.
 * - fetchLinkedPRs (timeline + search): called only for candidate stale
 *   claims, never for every issue.
 */
async function defaultListOpenPRs(owner: string, repo: string, limit: number): Promise<{ prs: DigestPR[]; total: number | null }> {
  const prs: DigestPR[] = [];
  let total: number | null = null;
  try {
    // Newest first: the cap keeps the most recent open PRs, which is what a
    // maintainer triages. The summary always states the cap and the true
    // total, so nothing is silently dropped.
    const data = (await apiGet(
      `/repos/${owner}/${repo}/pulls?state=open&sort=created&direction=desc&per_page=${Math.min(limit, 100)}&page=1`
    )) as PullApiItem[];
    for (const p of data ?? []) {
      prs.push({
        number: Number(p.number),
        title: String(p.title ?? ""),
        body: String(p.body ?? ""),
        author: String(p.user?.login ?? ""),
        headRef: String(p.head?.ref ?? ""),
        createdAt: String(p.created_at ?? ""),
        url: String(p.html_url ?? `https://github.com/${owner}/${repo}/pull/${p.number}`),
      });
      if (prs.length >= limit) break;
    }
  } catch {
    return { prs: [], total: null };
  }
  try {
    const q = encodeURIComponent(`repo:${owner}/${repo} type:pr state:open`);
    const search = (await apiGet(`/search/issues?q=${q}&per_page=1`)) as { total_count?: unknown };
    total = typeof search.total_count === "number" ? search.total_count : null;
  } catch {
    // total stays null: the summary states the cap without the true total
  }
  return { prs, total };
}

async function defaultListOpenIssues(owner: string, repo: string, limit: number): Promise<{ issues: IssueListItem[]; total: number | null }> {
  let data: IssueListItem[] = [];
  let total: number | null = null;
  try {
    data = (await apiGet(
      `/repos/${owner}/${repo}/issues?state=open&per_page=${Math.min(limit, 100)}&page=1`
    )) as IssueListItem[];
    // The issues endpoint returns PRs too; the digest only wants issues.
    data = (data ?? []).filter((i) => !i.pull_request);
  } catch {
    return { issues: [], total: null };
  }
  try {
    const q = encodeURIComponent(`repo:${owner}/${repo} type:issue state:open`);
    const search = (await apiGet(`/search/issues?q=${q}&per_page=1`)) as { total_count?: unknown };
    total = typeof search.total_count === "number" ? search.total_count : null;
  } catch {
    // total stays null
  }
  return { issues: data.slice(0, limit), total };
}

async function defaultFetchIssueMeta(owner: string, repo: string, number: number): Promise<DigestIssueMeta> {
  const issue = (await apiGet(`/repos/${owner}/${repo}/issues/${number}`)) as IssueListItem;
  return {
    number,
    title: String(issue.title ?? ""),
    state: String(issue.state ?? ""),
    author: String(issue.user?.login ?? ""),
    url: String(issue.html_url ?? `https://github.com/${owner}/${repo}/issues/${number}`),
    commentsCount: typeof issue.comments === "number" ? issue.comments : 0,
    assignees: (issue.assignees ?? []).map((a) => String(a.login ?? "")),
  };
}

/**
 * Full digest for owner/repo. Best-effort throughout: a section whose
 * data cannot be read is recorded in `degraded` with the reason, never
 * presented as a clean zero.
 */
export async function digestRepo(
  owner: string,
  repo: string,
  limit: number,
  deps: DigestDeps = {},
  opts: { now?: Date } = {}
): Promise<DigestResult> {
  const now = opts.now ?? new Date();
  const listOpenPRs = deps.listOpenPRs ?? defaultListOpenPRs;
  const listOpenIssues = deps.listOpenIssues ?? defaultListOpenIssues;
  const fetchIssueMeta = deps.fetchIssueMeta ?? defaultFetchIssueMeta;
  const fetchIssueComments = deps.fetchIssueComments ?? fetchComments;
  const fetchRepoLinkedPRs = deps.fetchLinkedPRs ?? fetchLinkedPRs;
  const fetchRepoContributing = deps.fetchContributing ?? fetchContributing;

  const degraded: DigestSectionNote[] = [];

  // 1. The cheap lists first (2-3 calls total).
  const { prs, total: trueOpenPRs } = await listOpenPRs(owner, repo, limit);
  const { issues: openIssues, total: trueOpenIssues } = await listOpenIssues(owner, repo, limit);
  let contributing: string | undefined;
  try {
    contributing = await fetchRepoContributing(owner, repo);
  } catch {
    contributing = undefined;
  }

  const races: DigestRace[] = [];
  const claimConflicts: DigestClaimConflict[] = [];
  const staleClaims: DigestStaleClaim[] = [];
  const assignmentConflicts: DigestAssignmentConflict[] = [];

  // 2. Linked issues across open PRs. One meta call per DISTINCT linked
  //    issue (not per PR): budget discipline for race/conflict sections.
  const groups = groupPRsByIssue(prs, owner, repo);
  const metaByKey = new Map<string, DigestIssueMeta>();
  const metaKey = (k: DigestIssueKey) => `${k.owner.toLowerCase()}/${k.repo.toLowerCase()}#${k.number}`;
  const fetchMeta = async (key: DigestIssueKey): Promise<DigestIssueMeta | null> => {
    const m = metaKey(key);
    const cached = metaByKey.get(m);
    if (cached) return cached;
    try {
      const meta = await fetchIssueMeta(key.owner, key.repo, key.number);
      metaByKey.set(m, meta);
      return meta;
    } catch {
      degraded.push({ section: `issue ${key.label}`, note: "issue metadata could not be read" });
      return null;
    }
  };
  const fetchCommentsIfAny = async (key: DigestIssueKey, meta: DigestIssueMeta): Promise<CommentSignal[]> => {
    // Comments are the expensive part: skip entirely when the issue has none.
    if (meta.commentsCount <= 0) return [];
    try {
      return await fetchIssueComments(key.owner, key.repo, key.number);
    } catch {
      degraded.push({ section: `issue ${key.label}`, note: "comments could not be read; claim checks skipped for this issue" });
      return [];
    }
  };

  // 3. Races: only groups of 2+ open PRs need issue data.
  // A group keyed on a number that resolves to a PR (not an issue) is not
  // a race: skip it with a note instead of reporting a phantom race.
  const raceGroups = [...groups.values()].filter((g) => g.prs.length >= 2);
  // Group keys that resolve to PRs, not issues, are skipped in every
  // section that treats them as issues (races, claimed-by-other,
  // assignment). Stale claims come from the issues endpoint, which is
  // already PR-filtered.
  const notIssueKeys = new Set<string>();
  for (const group of raceGroups) {
    const meta = await fetchMeta(group.key);
    if (meta && meta.url.includes("/pull/")) {
      degraded.push({ section: `race ${group.key.label}`, note: "skipped: resolves to a PR, not an issue" });
      notIssueKeys.add(metaKey(group.key));
      continue;
    }
    const comments = meta ? await fetchCommentsIfAny(group.key, meta) : [];
    races.push(
      buildRace(
        group,
        meta?.title ?? "(title unavailable)",
        meta?.url ?? `https://github.com/${group.key.owner}/${group.key.repo}/issues/${group.key.number}`,
        comments,
        now
      )
    );
  }

  // 4. Claimed-by-other conflicts: meta + comments only for distinct
  //    linked issues that have comments. Claim-free issues cost one meta
  //    call and no comment call.
  {
    const issueData = new Map<string, { key: DigestIssueKey; title: string; url: string; author: string; comments: CommentSignal[] }>();
    for (const { key } of groups.values()) {
      if (notIssueKeys.has(metaKey(key))) continue;
      const meta = await fetchMeta(key);
      if (!meta) continue;
      const comments = await fetchCommentsIfAny(key, meta);
      issueData.set(metaKey(key), { key, title: meta.title, url: meta.url, author: meta.author, comments });
    }
    for (const c of buildClaimConflicts({ prs, prOwner: owner, prRepo: repo, issueData })) {
      claimConflicts.push(c);
    }
  }

  // 5. Stale claims: comments fetched only for open issues with
  //    commentsCount > 0; the timeline walk (fetchLinkedPRs) only for
  //    candidates that actually carry a claim older than 14 days.
  {
    const candidates: Array<{ key: DigestIssueKey; title: string; url: string; comments: CommentSignal[]; linkedPRs: LinkedPR[] }> = [];
    for (const item of openIssues) {
      const number = Number(item.number);
      const commentsCount = typeof item.comments === "number" ? item.comments : 0;
      if (commentsCount <= 0) continue;
      let comments: CommentSignal[];
      try {
        comments = await fetchIssueComments(owner, repo, number);
      } catch {
        degraded.push({ section: `stale-claims #${number}`, note: "comments could not be read; this issue was skipped" });
        continue;
      }
      const claims = detectClaims(String(item.user?.login ?? ""), comments).filter((c) => !isBotAuthor(c.author));
      if (!claims.some((c) => c.ageDays >= STALE_CLAIM_DAYS)) continue;
      let linked: LinkedPR[] = [];
      try {
        linked = await fetchRepoLinkedPRs(owner, repo, number);
      } catch {
        linked = [];
        degraded.push({ section: `stale-claims #${number}`, note: "timeline could not be read; assuming no linked PRs" });
      }
      candidates.push({
        key: { owner, repo, number, label: `#${number}` },
        title: String(item.title ?? ""),
        url: String(item.html_url ?? `https://github.com/${owner}/${repo}/issues/${number}`),
        comments,
        linkedPRs: linked,
      });
    }
    for (const s of buildStaleClaims(candidates, now)) staleClaims.push(s);
  }

  // 6. Assignment-gate conflicts: only when the repo's gates require
  //    assignment. Assignees come from the meta already fetched above;
  //    no new calls beyond those.
  {
    let assignmentRequired = false;
    try {
      const gates = parseGates(contributing, { collaboratorsOnlyPolicy: false });
      assignmentRequired = gates.some((g) => g.kind === "assignment_required" && g.detected);
    } catch {
      degraded.push({ section: "assignment conflicts", note: "repo gates could not be parsed" });
    }
    if (assignmentRequired) {
      const assigneesByIssue = new Map<string, { key: DigestIssueKey; title: string; url: string; assignees: string[] }>();
      for (const { key } of groups.values()) {
        if (notIssueKeys.has(metaKey(key))) continue;
        const meta = metaByKey.get(metaKey(key));
        if (!meta) continue;
        assigneesByIssue.set(metaKey(key), { key, title: meta.title, url: meta.url, assignees: meta.assignees });
      }
      for (const c of buildAssignmentConflicts({ prs, prOwner: owner, prRepo: repo, assignmentRequired, assigneesByIssue })) {
        assignmentConflicts.push(c);
      }
    }
  }

  const summary = buildDigestSummary({
    repo: `${owner}/${repo}`,
    races: races.length,
    // The header counts strong-claim conflicts; soft interest is noted in
    // the section body, not counted as a conflict.
    claimConflicts: claimConflicts.filter((c) => c.foreignClaims.some((f) => f.strength === "strong")).length,
    staleClaims: staleClaims.length,
    assignmentConflicts: assignmentConflicts.length,
    prCap: limit,
    trueOpenPRs,
  });

  const result: DigestResult = {
    repo: `${owner}/${repo}`,
    races,
    claimConflicts,
    staleClaims,
    assignmentConflicts,
    degraded,
    summary,
    prCap: limit,
    trueOpenPRs,
    issueCap: limit,
    trueOpenIssues,
    hasRaces: races.length > 0,
    markdown: "",
  };
  result.markdown = renderDigestMarkdown(result);
  return result;
}
