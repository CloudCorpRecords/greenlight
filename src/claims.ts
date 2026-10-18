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
  /**
   * Extra check on a regex match (v0.9.2): return false to reject the
   * match. Used where a pure regex cannot see negation or the actor in
   * the same clause ("I'm not working on this", "Are you working on
   * this?"). `match.index` is where the regex matched.
   */
  guard?: (body: string, match: RegExpExecArray) => boolean;
}

// Strong: explicit claim of work or a concrete "I am doing it" statement.
const STRONG_PATTERNS: ClaimPattern[] = [
  // "I'd like to work on this issue" — formbricks/formbricks#9504
  // (2026-10-17): the contracted form missed the old "i would like".
  // The trailing guard keeps "take this opportunity to ..." out, the
  // same idiom the like-to-take pattern below protects.
  { name: "explicit-claim", regex: /\bi(['’]d| would) like to (work on|take|handle) (this|it)\b(?! (opportunity|moment|time) to)/i, strength: "strong" },
  { name: "please-assign", regex: /please assign (this|it|me)/i, strength: "strong" },
  { name: "assign-to-me", regex: /\bassign (it |this )?to me\b/i, strength: "strong" },
  { name: "assign-request", regex: /\bassign me\b/i, strength: "strong" },
  // "If that's okay, I'll work on it and open a PR." — the same
  // formbricks thread: "it" is as much a claim as "this". The lookahead
  // keeps "take it into account / offline / under / as" from matching.
  { name: "will-take", regex: /\bi (will|shall) (take|work on|handle) (this|it)\b(?!\s+(?:into|offline|under|as|for granted)\b)/i, strength: "strong" },
  // "It's yours @08abhinav, thanks!" — batrapulkit/squidbrake#79
  // (2026-10-17): a maintainer handing the issue to a contributor is an
  // assignment, the strongest taken-signal there is.
  { name: "its-yours", regex: /\bit(?:['’]s| is)(?: all)? yours\b/i, strength: "strong" },
  // "I've packaged a clean, production-verified fix for this" —
  // dubinc/dub#4659 (2026-10-17), and "I also prepared and tested a fix
  // for this issue" — formbricks#9504's second claimant. A concrete
  // fix-in-hand claim. The not/n't guard keeps "I have not prepared a
  // fix" from matching.
  { name: "fix-packaged", regex: /\bi(?:['’]ve| have| also| just)?\s+(?!(?:not|n['’]t)\s)(?:packaged|prepared|completed|finished)\s+(?:(?:a|the|my|this)\s+)?(?:[\w.,-]+\s+){0,6}fix\b/i, strength: "strong" },
  { name: "working-on", regex: /i(['’]| a)m (currently |now )?working on this/i, strength: "strong" },
  { name: "taking-it", regex: /\btak(e|ing) this (on|up)\b/i, strength: "strong" },
  { name: "pr-opened", regex: /i(['’]ve| have) opened (a |the )?pr\b/i, strength: "strong" },
  { name: "fix-ready", regex: /\bfix (is )?ready\b/i, strength: "strong" },
  { name: "fix-in-progress", regex: /\bfix is in progress\b/i, strength: "strong" },
  { name: "pr-incoming", regex: /\bpr (is |will be |to be )?(incoming|coming|ready|prepared)\b/i, strength: "strong" },
  { name: "started-work", regex: /\bi(['’]ve| have) started (working )?on this/i, strength: "strong" },
  { name: "want-to-work", regex: /i(['’]d| would) like to (take|pick) (this|it) (on|up)/i, strength: "strong" },
  // "Hi, I'd like to take this. Plan: ..." — the fastmcp #5743 claim (2026-10-14) that scan
  // missed because want-to-work above demands a trailing "on"/"up". The negative lookahead
  // keeps "I'd like to take this opportunity to thank ..." from counting as a claim.
  { name: "like-to-take", regex: /\bi(['’]d| would) like to take (this|it)\b(?! (opportunity|moment|time) to)/i, strength: "strong" },
  // "/attempt #1234" (or "/claim #1234") — bot-style commands some contributors post to
  // announce they are taking the issue. tscircuit/tscircuit#5563 (2026-10-15) carried five
  // of these from one contributor before anyone linked the actual fix PRs; without this
  // pattern the issue scored clean while every sub-bug already had work in flight.
  { name: "attempt-command", regex: /^\s*\/(attempt|claim)\b/i, strength: "strong" },
  // Bare short takes: "I'll take this", "let me take this", "taking this".
  // Soft, not strong: a bare take with no plan and no assignment ask is a
  // statement of intent, in the same family as "I can take this"
  // (can-take, soft) and "I'm going to take a look at this one"
  // (take-a-look, soft). It never caps a verdict alone. The guard does
  // report soft foreign claims, so these still surface to a maintainer.
  // Phrase-boundary rule: the take must end the clause or be followed
  // only by punctuation (or "on"/"up", which the stronger taking-it
  // pattern already caught earlier in the list). The negative lookahead
  // rejects the common non-claim continuations: "take this into account",
  // "take this offline", "take this opportunity to ...", "take this
  // with a grain of salt".
  {
    name: "bare-take",
    regex: /\b(?:i(?:['’]ll| will) take|let me take|i take|taking) (?:this|it)(?: one)?\b(?!\s+(?:[a-z][\w-]*\s+){0,2}(?:into|off(?:line)?|opportunity|opportunities|moment|time|with|under|as)\b)/i,
    strength: "soft",
  },
];

// Soft: interest or an offer, not a claim. Used only to soften confidence, not to mark TAKEN.
const SOFT_PATTERNS: ClaimPattern[] = [
  // "I'd be happy to implement the proposed fix" — formbricks#9504
  // (2026-10-17): the happy-to family missed the implementation verbs.
  { name: "soft-offer", regex: /\bhappy to (fix|work|help|take|implement|submit|contribute|open|review)\b/i, strength: "soft" },
  // Bare "Working on this." — ollama/ollama#19078 (2026-10-17): the
  // whole comment was three words. The morning eval caught it through
  // the AI layer; with the layer down, the patterns missed it. Soft,
  // not strong: no plan, no assignment ask. The guard rejects negations
  // ("I'm not working on this"), non-actors ("Nobody is working on
  // this"), and questions addressed at someone else ("Are you working
  // on this?"). The strong working-on pattern above owns "I'm working
  // on this" and runs first, so this never downgrades it.
  {
    name: "bare-working-on",
    regex: /\bworking on (?:this|it|a fix|the fix)\b/i,
    strength: "soft",
    guard: (body, match) => {
      const clause = (body.slice(0, match.index).split(/[.!?\n]/).pop() ?? "").toLowerCase();
      if (/\b(not|n't|never|nobody|no one|none)\b/.test(clause)) return false;
      if (/\bi(?:['’]m| am)\b/.test(clause)) return false;
      if (/\b(you|u)\b/.test(clause)) return false;
      return true;
    },
  },
  { name: "can-take", regex: /i can take this/i, strength: "soft" },
  { name: "interested", regex: /\binterested in (working on|taking|this)\b/i, strength: "soft" },
  { name: "looking-into", regex: /\blooking into this\b/i, strength: "soft" },
  { name: "have-fork", regex: /\b(my fork|on my fork|branch on my fork)\b/i, strength: "soft" },
  // "I'm going to take a look at this one" — actualbudget/actual#6643 (2026-10-15):
  // pnlabs-dev posted this two months ago and nothing landed. A soft claim
  // with a date, so its age can be weighed; it never caps the verdict alone.
  { name: "take-a-look", regex: /\b(take a|taking a) look at this/i, strength: "soft" },
  // "If not, I can pick it up." and "Can i still work on this, is this open."
  // — firecrawl#839 (2026-10-16): real claim comments every pattern missed.
  // The pick-up family is soft, like can-take. False-positive care: the
  // negative lookahead after "up" blocks physical-pickup contexts ("pick it
  // up from the store"), and "pick up the pace" never matches because the
  // regex demands "this"/"it" right after "pick". A true claim's clause
  // ends at "up" or continues with punctuation/intent, never a preposition
  // of place.
  {
    name: "pick-up-offer",
    regex: /\b(?:i can|i(?:['’]ll| will)|let me|(?:can|could) i) pick (?:this|it) up\b(?!\s+(?:from|at|in|on|off|out)\b)/i,
    strength: "soft",
  },
  // "Can i still work on this, is this open." — the same firecrawl thread:
  // an availability ask paired with work intent. Soft, like the offer above.
  { name: "work-availability", regex: /\bcan i (still |please )?work on this\b/i, strength: "soft" },
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
  { name: "partial-will-take", regex: /i(['’]ll| will) take (the|this)\b.{0,30}?\b(part|half|ask|fallback)\b/i, strength: "strong" },
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
      if (!m) continue;
      // v0.9.2: a guard can reject a regex match the pattern alone
      // cannot judge (negation, the actor). Rejected matches fall
      // through to the next pattern, not out of detection.
      if (pattern.guard && !pattern.guard(comment.body, m)) continue;
      matched = pattern;
      if (pattern.name.startsWith("partial-")) {
        // Partial patterns carry the scope word in the second capture group.
        scopeWord = (m[2] ?? "").toLowerCase() || undefined;
      }
      break; // partial and strong patterns come first, so first match wins
    }
    if (!matched) continue;

    // Skip the issue author unless they announce real work in progress,
    // or assign the issue to someone else (v0.9.2: "It's yours @x" is an
    // assignment, not a self-claim — batrapulkit/squidbrake#79).
    if (
      author === issueAuthor &&
      matched.name !== "fix-ready" &&
      matched.name !== "fix-in-progress" &&
      matched.name !== "pr-opened" &&
      matched.name !== "its-yours"
    ) {
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
