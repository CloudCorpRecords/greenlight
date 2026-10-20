/**
 * Behavioral gate detection (v0.16.0).
 *
 * Field data (2026-10-19, PR wave): spotDL/spotify-downloader is classed
 * "open" in the Agent Policy Index (no policy file bans agents), yet its
 * maintainer rejects AI-built contributions in practice: issue #2371 drew
 * three PRs, all closed unmerged, with PR #2494 closed on a comment
 * calling the submission "AI slop". Policy-file gate detection cannot see
 * this shape, so the index misleads contributors into burning builds. This
 * module closes that gap with a bounded, deterministic pass over recent
 * closed-unmerged PRs.
 *
 * Design (deliberately conservative; read before changing):
 *   - Scope: the 15 most recent CLOSED-UNMERGED PRs within a 12-month
 *     recency bound (v0.17.1; stale closures are excluded before any
 *     comment fetch, with a "stale signal" note when the newest closure
 *     itself is older than the bound). The closed-PR list is
 *     walked (newest first, up to 3 pages of 30) until 15 unmerged PRs are
 *     collected, because merged PRs carry no closure evidence and an
 *     active repo's unmerged closures can sit pages deep. Evidence fetches
 *     (first page, per_page=100) run only for those unmerged PRs, on all
 *     three surfaces (issue comments, reviews, review comments), so the
 *     total cost is 1-3 list calls + up to 3 pages x 15 PRs (48 max).
 *   - Maintainer-side only: comment author_association must be OWNER,
 *     MEMBER, or COLLABORATOR, and the comment author must not be the PR
 *     author (a maintainer closing their own PR is not evidence against
 *     outsiders).
 *   - A comment counts as AI-rejection evidence when it contains an
 *     AI-attribution term AND a rejection/closure term (or matches one of
 *     the explicit strong phrases below). Welcoming overrides
 *     ("AI-assisted PRs are welcome") suppress the signal so open repos
 *     do not false-positive.
 *   - Detection threshold: strength >= 2, where strength is the number of
 *     DISTINCT closed-unmerged PRs carrying at least one matching
 *     maintainer comment. A single weak signal is carried in evidence
 *     with detected=false: a warning, not a behavioral policy. A single
 *     STRONG signal (an explicit phrase like "AI slop" or an invoked "AI
 *     policy" on closure) detects on its own: the phrase is unambiguous
 *     maintainer intent, and corroboration would only delay the warning.
 *
 * This is behavior inference from maintainer actions, not policy text:
 * verdicts should treat a detected behavioral gate as a hard reason to
 * skip the repo, the same way agents_banned is treated.
 */
import { apiGet, apiCallsUsed } from "./github.js";

export interface BehavioralClosedPR {
  number: number;
  url: string;
  author: string;
  closedAt: string;
}

/**
 * One maintainer-authored text blob on a closed-unmerged PR.
 * v0.18.0 (item 5): maintainer rejections often live in review bodies
 * and line comments, not issue comments, so all three surfaces feed the
 * same matcher. `source` defaults to "comment" for older callers.
 */
export interface BehavioralMaintainerComment {
  pr: number;
  author: string;
  association: string;
  body: string;
  url: string;
  source?: "comment" | "review" | "review_comment";
}

export interface BehavioralSignal {
  pr: number;
  author: string;
  /** Truncated quote (240 chars) that fired the matcher. */
  quote: string;
  url: string;
  /** True for explicit phrases like "AI slop"; weaker signals can still count toward strength. */
  strong: boolean;
  /** Which surface carried the evidence: "comment" | "review" | "review_comment". */
  source?: "comment" | "review" | "review_comment";
}

export interface BehavioralGate {
  /** True when strength >= threshold: the maintainer rejects AI-built PRs in practice. */
  detected: boolean;
  /** Distinct closed-unmerged PRs with at least one matching maintainer comment. */
  strength: number;
  /** Detection needs strength >= threshold. Always 2; a lone PR is a warning, not a policy. */
  threshold: number;
  evidence: BehavioralSignal[];
  /** Transparency: PRs scanned, maintainer comments seen, why nothing fired. */
  notes: string[];
  note: string;
}

/** Maximum closed-unmerged PRs examined per repo. Keeps the pass bounded. */
export const BEHAVIORAL_MAX_PRS = 15;

/**
 * Recency bound (v0.17.1): closures older than this many months are
 * excluded from evidence. Maintainer posture changes; a two-year-old
 * rejection spree is history, not a current behavioral gate, and a
 * quiet repo should not pay 18 calls for stale signal.
 */
export const BEHAVIORAL_RECENCY_MONTHS = 12;

/**
 * Pure: split closed-unmerged PRs (newest first) at the recency cutoff.
 * A PR with an unparseable closedAt is kept (missing data must never
 * silently discard evidence). `newestClosedAt` reports the newest
 * closure seen, stale or not, so callers can flag stale-signal repos.
 */
export function partitionByRecency(
  prs: BehavioralClosedPR[],
  nowMs: number,
  months: number = BEHAVIORAL_RECENCY_MONTHS
): { fresh: BehavioralClosedPR[]; staleCount: number; newestClosedAt: string | null } {
  const cutoff = nowMs - months * 30.44 * 24 * 60 * 60 * 1000;
  const fresh: BehavioralClosedPR[] = [];
  let staleCount = 0;
  let newestClosedAt: string | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const p of prs) {
    const t = Date.parse(p.closedAt);
    if (Number.isFinite(t)) {
      if (t > newestMs) {
        newestMs = t;
        newestClosedAt = p.closedAt;
      }
      if (t < cutoff) {
        staleCount++;
        continue;
      }
    }
    fresh.push(p);
  }
  return { fresh, staleCount, newestClosedAt };
}
/**
 * API cost contract (v0.18.0, item 5): 1-3 calls to walk the closed-PR
 * list (stops early once 15 unmerged PRs are found) plus up to three
 * evidence pages per closed-unmerged PR (issue comments, reviews,
 * review comments).
 */
export const BEHAVIORAL_MAX_API_CALLS = 3 + 3 * BEHAVIORAL_MAX_PRS;

const AI_TERMS =
  /\b(ai|a\.i\.|llm|llms|chatgpt|copilot|Muse|gemini|gpt-?4|gpt-?3|generated|slop)\b/i;
const REJECTION_TERMS =
  /\b(clos(?:e|ed|ing|ure)?|not\s+accept(?:ing|s)?|won['’]t|will\s+not|do\s+not|don['’]t|reject(?:ed|s|ion)?|declin(?:e|ed)|low[\s-]?effort|slop|refus(?:e|ed|ing)|spam|not\s+welcome|polic(?:y|ies))\b/i;
/** Explicit phrases: unmistakable even without the two-term rule. */
const STRONG_PHRASES = [
  /\bai\s+slop\b/i,
  /\bno\s+ai[-\s]?(prs?|contributions?|code|submissions?)\b/i,
  /\bwe\s+(do\s+not|don['’]t|won['’]t)\s+accept\s+ai/i,
  /\bno\s+(ai|llm)[-\s]?generated\b/i,
  /\bai[-\s]?(llm\s+)?polic(y|ies)\b/i,
];
/** Welcoming language suppresses the signal: "AI-assisted PRs are welcome" must never fire. */
const WELCOMING =
  /\bwelcom(e|ing)\b[^.!?]{0,80}\b(ai|ai[-\s]assisted|contributions?|contributors?|prs?)\b/i;

/** Pure: does one comment body read as maintainer AI-rejection evidence? */
export function matchAiRejection(body: string): { matched: boolean; strong: boolean } {
  const text = body.replace(/\s+/g, " ");
  if (WELCOMING.test(text)) return { matched: false, strong: false };
  for (const p of STRONG_PHRASES) {
    if (p.test(text)) return { matched: true, strong: true };
  }
  if (AI_TERMS.test(text) && REJECTION_TERMS.test(text)) {
    return { matched: true, strong: /\bslop\b/i.test(text) };
  }
  return { matched: false, strong: false };
}

function truncateQuote(body: string, limit = 240): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "\u2026" : flat;
}

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Pure core: fold maintainer comments on closed-unmerged PRs into a gate
 * verdict. The live fetcher below builds these two inputs; tests drive
 * this function with fixtures, so the threshold logic never depends on
 * the network. Comments whose association is not maintainer-side are
 * ignored here too, so the pure contract is complete.
 */
export function detectBehavioralGateFromData(
  prs: BehavioralClosedPR[],
  comments: BehavioralMaintainerComment[]
): BehavioralGate {
  const prByNumber = new Map(prs.map((p) => [p.number, p]));
  const evidence: BehavioralSignal[] = [];
  const prsWithSignal = new Set<number>();
  const notes: string[] = [];
  notes.push(
    `scanned ${prs.length} closed-unmerged PRs, ${comments.length} maintainer-authored texts on them (issue comments, reviews, review comments)`
  );

  for (const c of comments) {
    if (!MAINTAINER_ASSOCIATIONS.has(String(c.association ?? ""))) continue;
    const pr = prByNumber.get(c.pr);
    if (!pr) continue;
    // A maintainer closing their own PR is not evidence against outsiders.
    if (c.author.toLowerCase() === pr.author.toLowerCase()) continue;
    const { matched, strong } = matchAiRejection(c.body);
    if (!matched) continue;
    evidence.push({
      pr: c.pr,
      author: c.author,
      quote: truncateQuote(c.body),
      url: c.url,
      strong,
      source: c.source ?? "comment",
    });
    prsWithSignal.add(c.pr);
  }

  const strength = prsWithSignal.size;
  const threshold = 2;
  const hasStrong = evidence.some((e) => e.strong);
  // Two independent PRs make it a behavioral policy; one explicit
  // strong phrase (e.g. "AI slop", an invoked "AI policy" on closure)
  // is unambiguous maintainer intent and detects on its own.
  const detected = strength >= threshold || (strength >= 1 && hasStrong);
  const note = detected
    ? `maintainer rejects AI-built PRs in practice: ${strength} closed-unmerged PR${strength === 1 ? "" : "s"} carr${strength === 1 ? "ies" : "y"} AI-rejection comments${hasStrong ? ", including an explicit rejection phrase" : ""}`
    : strength === 0
      ? "no maintainer AI-rejection evidence found on recent closed-unmerged PRs"
      : `only ${strength} closed-unmerged PR with AI-rejection evidence and no explicit phrase (threshold ${threshold}): warning, not a behavioral gate`;
  if (!detected && evidence.length > 0) {
    notes.push("signals exist but stay below the detection threshold");
  }
  return { detected, strength, threshold, evidence, notes, note };
}

interface PrListItem {
  number: number;
  html_url: string;
  user?: { login?: string };
  merged_at: string | null;
  state: string;
  closed_at?: string;
  draft?: boolean;
}

interface CommentListItem {
  id: number;
  body?: string;
  html_url: string;
  user?: { login?: string };
  author_association?: string;
}

/**
 * Live pass: walk the closed-PR list (newest first) until 15
 * closed-unmerged PRs are collected, fetch comments on those PRs, and run
 * the pure core. Returns the gate verdict; throws on API failure (the
 * friction pipeline treats a failure as "signal unavailable", never as
 * detected).
 */
export async function detectBehavioralGate(
  owner: string,
  repo: string,
  opts: { now?: number } = {}
): Promise<BehavioralGate> {
  const nowMs = opts.now ?? Date.now();
  const callsBefore = apiCallsUsed();
  const closedUnmerged: BehavioralClosedPR[] = [];
  for (let page = 1; page <= 3 && closedUnmerged.length < BEHAVIORAL_MAX_PRS; page++) {
    const items = (await apiGet(
      `/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30&page=${page}`
    )) as PrListItem[];
    if (!items || items.length === 0) break;
    for (const p of items) {
      if (closedUnmerged.length >= BEHAVIORAL_MAX_PRS) break;
      if (p.state === "closed" && !p.merged_at) {
        closedUnmerged.push({
          number: p.number,
          url: p.html_url,
          author: String(p.user?.login ?? ""),
          closedAt: String(p.closed_at ?? ""),
        });
      }
    }
    if (items.length < 30) break;
  }

  // v0.17.1: drop stale closures before paying comment calls for them.
  const recency = partitionByRecency(closedUnmerged, nowMs);
  const live = recency.fresh;

  // v0.18.0 (item 5): maintainer rejections live on three surfaces.
  // One bounded page each: issue comments, reviews, review comments.
  const comments: BehavioralMaintainerComment[] = [];
  for (const pr of live) {
    const issueComments = (await apiGet(
      `/repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=100`
    )) as CommentListItem[];
    for (const c of issueComments ?? []) {
      comments.push({
        pr: pr.number,
        author: String(c.user?.login ?? ""),
        association: String(c.author_association ?? ""),
        body: String(c.body ?? ""),
        url: c.html_url,
        source: "comment",
      });
    }
    const reviews = (await apiGet(
      `/repos/${owner}/${repo}/pulls/${pr.number}/reviews?per_page=100`
    )) as CommentListItem[];
    for (const r of reviews ?? []) {
      const body = String(r.body ?? "").trim();
      if (!body) continue; // bare APPROVE/REQUEST_CHANGES votes carry no text
      comments.push({
        pr: pr.number,
        author: String(r.user?.login ?? ""),
        association: String(r.author_association ?? ""),
        body,
        url: r.html_url,
        source: "review",
      });
    }
    const reviewComments = (await apiGet(
      `/repos/${owner}/${repo}/pulls/${pr.number}/comments?per_page=100`
    )) as CommentListItem[];
    for (const c of reviewComments ?? []) {
      comments.push({
        pr: pr.number,
        author: String(c.user?.login ?? ""),
        association: String(c.author_association ?? ""),
        body: String(c.body ?? ""),
        url: c.html_url,
        source: "review_comment",
      });
    }
  }
  const gate = detectBehavioralGateFromData(live, comments);
  if (recency.staleCount > 0) {
    gate.notes.push(
      `excluded ${recency.staleCount} closed-unmerged PR${recency.staleCount === 1 ? "" : "s"} older than the ${BEHAVIORAL_RECENCY_MONTHS}-month recency bound`
    );
  }
  if (recency.newestClosedAt !== null) {
    const newestMs = Date.parse(recency.newestClosedAt);
    if (
      Number.isFinite(newestMs) &&
      newestMs < nowMs - BEHAVIORAL_RECENCY_MONTHS * 30.44 * 24 * 60 * 60 * 1000
    ) {
      gate.notes.push(
        `stale signal: newest closed-unmerged PR closed ${recency.newestClosedAt.slice(0, 10)}, ` +
          `older than the ${BEHAVIORAL_RECENCY_MONTHS}-month bound; behavioral evidence may be stale`
      );
    }
  }
  gate.notes.push(`API calls used: ${apiCallsUsed() - callsBefore}`);
  return gate;
}
