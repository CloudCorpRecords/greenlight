/**
 * Claim-comment heuristics.
 *
 * Problem this solves: an issue shows "unassigned" while 2-5 volunteers
 * already claimed it in the comments (seen on langchain-ai/langchain#41185
 * with 3 claimants, and on shadcn-labs/pdfcn#58 claimed the same day).
 * These patterns detect those claims so the verdict engine can mark the
 * issue TAKEN or RISKY before anyone writes code.
 */
import type { ClaimSignal, CommentSignal } from "./types.js";

interface ClaimPattern {
  name: string;
  regex: RegExp;
  strength: "strong" | "soft";
}

// Strong: explicit claim of work or a concrete "I am doing it" statement.
const STRONG_PATTERNS: ClaimPattern[] = [
  { name: "explicit-claim", regex: /i would like to (work on|take|handle) this/i, strength: "strong" },
  { name: "please-assign", regex: /please assign (this|it|me)/i, strength: "strong" },
  { name: "assign-to-me", regex: /\bassign (it |this )?to me\b/i, strength: "strong" },
  { name: "assign-request", regex: /\bassign me\b/i, strength: "strong" },
  { name: "will-take", regex: /i (will|shall) (take|work on|handle) this/i, strength: "strong" },
  { name: "working-on", regex: /i('| a)m (currently |now )?working on this/i, strength: "strong" },
  { name: "taking-it", regex: /\btak(e|ing) this (on|up)\b/i, strength: "strong" },
  { name: "pr-opened", regex: /i('ve| have) opened (a |the )?pr\b/i, strength: "strong" },
  { name: "fix-ready", regex: /\bfix (is )?ready\b/i, strength: "strong" },
  { name: "fix-in-progress", regex: /\bfix is in progress\b/i, strength: "strong" },
  { name: "pr-incoming", regex: /\bpr (is |will be |to be )?(incoming|coming|ready|prepared)\b/i, strength: "strong" },
  { name: "started-work", regex: /\bi('ve| have) started (working )?on this/i, strength: "strong" },
  { name: "want-to-work", regex: /i('d| would) like to (take|pick) (this|it) (on|up)/i, strength: "strong" },
  // "Hi, I'd like to take this. Plan: ..." — the fastmcp #5743 claim (2026-10-14) that scan
  // missed because want-to-work above demands a trailing "on"/"up". The negative lookahead
  // keeps "I'd like to take this opportunity to thank ..." from counting as a claim.
  { name: "like-to-take", regex: /\bi('d| would) like to take (this|it)\b(?! (opportunity|moment|time) to)/i, strength: "strong" },
  // "/attempt #1234" (or "/claim #1234") — bot-style commands some contributors post to
  // announce they are taking the issue. tscircuit/tscircuit#5563 (2026-10-15) carried five
  // of these from one contributor before anyone linked the actual fix PRs; without this
  // pattern the issue scored clean while every sub-bug already had work in flight.
  { name: "attempt-command", regex: /^\s*\/(attempt|claim)\b/i, strength: "strong" },
];

// Soft: interest or an offer, not a claim. Used only to soften confidence, not to mark TAKEN.
const SOFT_PATTERNS: ClaimPattern[] = [
  { name: "soft-offer", regex: /happy to (fix|work|help|take)/i, strength: "soft" },
  { name: "can-take", regex: /i can take this/i, strength: "soft" },
  { name: "interested", regex: /\binterested in (working on|taking|this)\b/i, strength: "soft" },
  { name: "looking-into", regex: /\blooking into this\b/i, strength: "soft" },
  { name: "have-fork", regex: /\b(my fork|on my fork|branch on my fork)\b/i, strength: "soft" },
  // "I'm going to take a look at this one" — actualbudget/actual#6643 (2026-10-15):
  // pnlabs-dev posted this two months ago and nothing landed. A soft claim
  // with a date, so its age can be weighed; it never caps the verdict alone.
  { name: "take-a-look", regex: /\b(take a|taking a) look at this/i, strength: "soft" },
];

// Scoped claims: the author takes part of the issue, not the whole thing.
// Seen on reticlehq/reticle#691 ("Taking the remaining fallback ask") where
// a scoped claim plus a cited PR were both missed, nearly causing duplicate
// work. Each pattern carries a capture group for the scope word. These are
// checked before the whole-issue patterns (more specific wins) and record
// scope: "partial" instead of "full".
const PARTIAL_PATTERNS: ClaimPattern[] = [
  { name: "partial-taking", regex: /taking (the|this|on)\b.{0,40}?\b(ask|part|half|piece|fallback|remaining)\b/i, strength: "strong" },
  { name: "partial-claiming", regex: /claiming (the|this)\b.{0,30}?\b(part|half|ask)\b/i, strength: "strong" },
  { name: "partial-working-on", regex: /working on (the|this)\b.{0,30}?\b(part|half|piece)\b/i, strength: "strong" },
  { name: "partial-will-take", regex: /i('ll| will) take (the|this)\b.{0,30}?\b(part|half|ask|fallback)\b/i, strength: "strong" },
];

const ALL_PATTERNS = [...PARTIAL_PATTERNS, ...STRONG_PATTERNS, ...SOFT_PATTERNS];

// Authors that are not humans claiming work.
const BOT_NAME_PATTERNS = [
  /\[bot\]$/i,
  /^dependabot/i,
  /^github-actions/i,
  /sweeper/i,
  /open-swe/i,
  /yolo\d*-bot/i,
  /claw-bot/i,
];

export function isBotAuthor(login: string): boolean {
  return BOT_NAME_PATTERNS.some((re) => re.test(login));
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)));
}

/**
 * Scan comments for claim signals. Bot comments are skipped. The issue
 * author is skipped unless they announce a ready/in-progress fix (reporters
 * sometimes finish the work themselves, e.g. langchain-ai/langchain#41141).
 * Returns at most one signal per author, keeping the strongest match.
 */
export function detectClaims(
  issueAuthor: string,
  comments: CommentSignal[],
  now: Date = new Date()
): ClaimSignal[] {
  const byAuthor = new Map<string, ClaimSignal>();

  for (const comment of comments) {
    const author = comment.author;
    if (isBotAuthor(author)) continue;

    let matched: ClaimPattern | undefined;
    let scopeWord: string | undefined;
    for (const pattern of ALL_PATTERNS) {
      const m = pattern.regex.exec(comment.body);
      if (m) {
        matched = pattern;
        if (pattern.name.startsWith("partial-")) {
          // Partial patterns carry the scope word in the second capture group.
          scopeWord = (m[2] ?? "").toLowerCase() || undefined;
        }
        break; // partial and strong patterns come first, so first match wins
      }
    }
    if (!matched) continue;

    // Skip the issue author unless they announce real work in progress.
    if (author === issueAuthor && matched.name !== "fix-ready" && matched.name !== "fix-in-progress" && matched.name !== "pr-opened") {
      continue;
    }

    const existing = byAuthor.get(author);
    const signal: ClaimSignal = {
      author,
      createdAt: comment.createdAt,
      ageDays: daysBetween(new Date(comment.createdAt), now),
      strength: matched.strength,
      phrase: matched.name,
      scope: matched.name.startsWith("partial-") ? "partial" : "full",
      ...(scopeWord ? { scopeWord } : {}),
    };
    if (!existing) {
      byAuthor.set(author, signal);
    } else if (existing.strength === "soft" && signal.strength === "strong") {
      byAuthor.set(author, signal);
    }
  }

  return [...byAuthor.values()].sort((a, b) => a.ageDays - b.ageDays);
}

/** Count distinct authors with a strong claim signal. */
export function strongClaimants(claims: ClaimSignal[]): ClaimSignal[] {
  return claims.filter((c) => c.strength === "strong");
}
