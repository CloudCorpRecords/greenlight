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
];

// Soft: interest or an offer, not a claim. Used only to soften confidence, not to mark TAKEN.
const SOFT_PATTERNS: ClaimPattern[] = [
  { name: "soft-offer", regex: /happy to (fix|work|help|take)/i, strength: "soft" },
  { name: "can-take", regex: /i can take this/i, strength: "soft" },
  { name: "interested", regex: /\binterested in (working on|taking|this)\b/i, strength: "soft" },
  { name: "looking-into", regex: /\blooking into this\b/i, strength: "soft" },
  { name: "have-fork", regex: /\b(my fork|on my fork|branch on my fork)\b/i, strength: "soft" },
];

const ALL_PATTERNS = [...STRONG_PATTERNS, ...SOFT_PATTERNS];

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
    for (const pattern of ALL_PATTERNS) {
      if (pattern.regex.test(comment.body)) {
        matched = pattern;
        break; // strong patterns come first, so first match wins
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
