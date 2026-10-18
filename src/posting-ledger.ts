/**
 * Posting ledger: the pacing layer (v0.9.2).
 *
 * Field lesson 2026-10-17: the campaign's claim-posting pace tripped
 * GitHub's account-level anti-spam flag (403 "Blocked" on issue-comment
 * creation), freezing all campaign posting for hours. The ledger makes
 * posting cadence visible and bounded:
 *
 *   - every post the tool attempts is recorded (timestamp, kind, target,
 *     outcome) at ~/.greenlight/posting-ledger.json,
 *   - claim posts enforce a minimum interval (default 90s, jittered),
 *   - claim posts obey a daily soft cap (default 25 per rolling 24h),
 *   - a post that fails with a block or an uncertain network error is
 *     marked UNCONFIRMED, and the tool reconciles against the API before
 *     ever posting to the same target again (never blind-retries).
 *
 * All time-dependent decisions take an explicit `nowMs`, so the tests
 * drive them with an injected clock.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** Surfaces that post through this ledger. */
export type PostingKind = "claim" | "release" | "heartbeat" | "pr" | "comment";

export type PostingOutcome = "confirmed" | "blocked" | "unconfirmed" | "superseded";

export interface PostingLedgerEntry {
  /** ISO timestamp of the attempt. */
  ts: string;
  kind: PostingKind;
  /** Canonical target, e.g. https://github.com/owner/repo/issues/123. */
  targetUrl: string;
  outcome: PostingOutcome;
  /** Short human note, e.g. "comment #6238115199" or "403 Blocked". */
  note?: string;
}

export interface PostingLedger {
  v: 1;
  entries: PostingLedgerEntry[];
}

export function defaultLedgerPath(): string {
  return join(homedir(), ".greenlight", "posting-ledger.json");
}

export function emptyLedger(): PostingLedger {
  return { v: 1, entries: [] };
}

/** Read the ledger; a missing or corrupt file means an empty ledger. */
export function readLedger(path: string = defaultLedgerPath()): PostingLedger {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PostingLedger>;
    if (raw && Array.isArray(raw.entries)) {
      return {
        v: 1,
        entries: raw.entries.filter(
          (e): e is PostingLedgerEntry =>
            !!e && typeof e.ts === "string" && typeof e.targetUrl === "string"
        ),
      };
    }
  } catch {
    // fall through to the empty ledger
  }
  return emptyLedger();
}

export function appendLedgerEntry(
  entry: Omit<PostingLedgerEntry, "ts"> & { ts?: string },
  path: string = defaultLedgerPath()
): PostingLedgerEntry {
  const full: PostingLedgerEntry = { ts: new Date().toISOString(), ...entry };
  const ledger = readLedger(path);
  ledger.entries.push(full);
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(ledger, null, 2));
  } catch {
    // The ledger is advisory: a write failure must never break posting.
  }
  return full;
}

/** Comment-class writes (the surface GitHub's anti-spam flag watches). */
export const COMMENT_KINDS: PostingKind[] = ["claim", "release", "heartbeat", "comment"];

export interface PacingConfig {
  /** Minimum seconds between comment-class posts. Default 90. */
  minIntervalS: number;
  /** Jitter added on top of the interval, seconds. Default 25% of the interval. */
  jitterS: number;
  /** Max claim posts per rolling 24h; 0 disables. Default 25. */
  dailyCap: number;
}

export function pacingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PacingConfig {
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const minIntervalS = num(env.GREENLIGHT_CLAIM_MIN_INTERVAL_S, 90);
  return {
    minIntervalS,
    jitterS: minIntervalS * 0.25,
    dailyCap: num(env.GREENLIGHT_CLAIM_DAILY_CAP, 25),
  };
}

export interface PacingDecision {
  allowed: boolean;
  /** Claim posts attempted in the last rolling 24h (blocked included). */
  postsToday: number;
  /** Comment-class posts in the last rolling 24h. */
  commentsToday: number;
  /** Unconfirmed entries still awaiting reconciliation. */
  unconfirmedCount: number;
  /** When the next comment-class post may go (ISO), or null when now. */
  nextAllowedAt: string | null;
  /** Human reason when not allowed. */
  reason: string | null;
  config: PacingConfig;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function checkPacing(
  ledger: PostingLedger,
  nowMs: number,
  config: PacingConfig
): PacingDecision {
  const dayAgo = nowMs - DAY_MS;
  const postsToday = ledger.entries.filter(
    (e) => e.kind === "claim" && Date.parse(e.ts) >= dayAgo
  ).length;
  const commentsToday = ledger.entries.filter(
    (e) => COMMENT_KINDS.includes(e.kind) && Date.parse(e.ts) >= dayAgo
  ).length;
  const unconfirmedCount = ledger.entries.filter((e) => e.outcome === "unconfirmed").length;

  const lastComment = [...ledger.entries]
    .filter((e) => COMMENT_KINDS.includes(e.kind))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];

  let nextAllowedAt: string | null = null;
  let reason: string | null = null;

  if (config.dailyCap > 0 && postsToday >= config.dailyCap) {
    reason =
      `daily claim cap reached (${postsToday} claim posts in the last 24h, cap ${config.dailyCap}); ` +
      `set GREENLIGHT_CLAIM_DAILY_CAP=0 to disable, or pass --force to override (the override is ledgered)`;
  } else if (lastComment) {
    const waitMs = (config.minIntervalS + config.jitterS) * 1000;
    const elapsed = nowMs - Date.parse(lastComment.ts);
    if (elapsed < waitMs) {
      nextAllowedAt = new Date(Date.parse(lastComment.ts) + waitMs).toISOString();
      reason =
        `pacing: last ${lastComment.kind} post was ${Math.round(elapsed / 1000)}s ago; ` +
        `earliest allowed ${nextAllowedAt}. Pass --force to override (the override is ledgered)`;
    }
  }

  return {
    allowed: reason === null,
    postsToday,
    commentsToday,
    unconfirmedCount,
    nextAllowedAt,
    reason,
    config,
  };
}

/**
 * A pending write for this target that never got a confirmed outcome.
 * The tool must reconcile it before posting to the same target again.
 */
export function pendingEntryFor(
  ledger: PostingLedger,
  targetUrl: string
): PostingLedgerEntry | null {
  const pend = ledger.entries.filter(
    (e) => e.targetUrl === targetUrl && e.outcome === "unconfirmed"
  );
  if (pend.length === 0) return null;
  return pend.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
}

export type ReconcileOutcome = "confirmed" | "not-landed" | "unknown";

/**
 * Re-read the target and reconcile one unconfirmed entry:
 * the confirm callback returns true when the post actually landed.
 * A landed post is marked confirmed (the caller must not repost).
 * A post verified absent is marked superseded: the caller may make a
 * fresh attempt, and this entry stops blocking later reconciliations.
 * Returns "unknown" when the re-read itself fails (keep the entry
 * unconfirmed; never blind-retry).
 */
export async function reconcileEntry(
  path: string,
  entry: PostingLedgerEntry,
  confirm: (entry: PostingLedgerEntry) => Promise<boolean>
): Promise<ReconcileOutcome> {
  let landed: boolean;
  try {
    landed = await confirm(entry);
  } catch {
    return "unknown";
  }
  const ledger = readLedger(path);
  const stored = ledger.entries.find(
    (e) => e.ts === entry.ts && e.targetUrl === entry.targetUrl
  );
  if (stored) {
    stored.outcome = landed ? "confirmed" : "superseded";
    try {
      writeFileSync(path, JSON.stringify(ledger, null, 2));
    } catch {
      // advisory only
    }
  }
  return landed ? "confirmed" : "not-landed";
}

/** Classify a failed post attempt's error into a ledger outcome. */
export function outcomeForError(err: unknown): PostingOutcome {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // GitHub's anti-spam block and rate limits: the account is gated, not
  // the request malformed. Both can lift; the ledger keeps them visible.
  if (/blocked/.test(msg) || /rate limit/.test(msg)) return "blocked";
  return "unconfirmed";
}

/** One-line pacing summary for `greenlight status`. */
export function pacingSummary(decision: PacingDecision): string[] {
  const lines = [
    `pacing: ${decision.postsToday} claim posts in the last 24h (cap ${decision.config.dailyCap === 0 ? "disabled" : decision.config.dailyCap}), ${decision.commentsToday} comment-class posts`,
    decision.nextAllowedAt
      ? `  next claim post allowed at ${decision.nextAllowedAt}`
      : `  claim posting is allowed now`,
  ];
  if (decision.unconfirmedCount > 0) {
    lines.push(
      `  ${decision.unconfirmedCount} unconfirmed post${decision.unconfirmedCount === 1 ? "" : "s"} awaiting reconciliation`
    );
  }
  return lines;
}
