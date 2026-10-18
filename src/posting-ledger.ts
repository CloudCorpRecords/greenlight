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
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  statSync,
  unlinkSync,
} from "node:fs";

/** Surfaces that post through this ledger. */
export type PostingKind = "claim" | "release" | "heartbeat" | "pr" | "comment";

export type PostingOutcome = "confirmed" | "blocked" | "unconfirmed" | "superseded";

export interface PostingLedgerEntry {
  /** ISO timestamp of the attempt. */
  ts: string;
  /**
   * Unique entry id (v0.10.0). Two posts in the same millisecond share a
   * ts, so finishPost matches on this, never on ts alone. Older entries
   * may lack it; matching falls back to ts + targetUrl for those.
   */
  id?: string;
  kind: PostingKind;
  /** Canonical target, e.g. https://github.com/owner/repo/issues/123. */
  targetUrl: string;
  outcome: PostingOutcome;
  /** Short human note, e.g. "comment #6238115199" or "403 Blocked". */
  note?: string;
  /**
   * Which agent recorded the entry (v0.10.0). GREENLIGHT_AGENT_ID when set,
   * otherwise "<hostname>:<pid>" captured at write time. Older entries may
   * lack it; pacing counts every entry regardless.
   */
  agent?: string;
}

/**
 * The identity stamped on each ledger entry. Operators running several
 * agents (or machines) in parallel set GREENLIGHT_AGENT_ID per agent
 * (e.g. "worker-a", "cron-scan") so the ledger shows who posted what.
 * Unset, the tool falls back to "<hostname>:<pid>".
 */
export function agentId(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.GREENLIGHT_AGENT_ID ?? "").trim();
  if (fromEnv.length > 0) return fromEnv;
  return `${hostname()}:${process.pid}`;
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

/** Lock-file path for the atomic ledger operations below. */
function ledgerLockPath(path: string): string {
  return `${path}.lock`;
}

const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Exclusive lock around read-modify-write, so concurrent agents cannot
 * both read an empty-looking ledger and race past the daily cap or the
 * claim cadence. Implemented with an exclusive-create lock file and a
 * staleness rule (a lock older than 30s is a crashed holder and is
 * stolen), so a dead process can never wedge the ledger forever.
 */
export function withLedgerLock<T>(path: string, fn: () => T): T {
  const lp = ledgerLockPath(path);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lp, "wx");
      try {
        writeFileSync(fd, `${process.pid}`);
      } catch {
        // Best effort: the lock's existence is the signal, not its content.
      }
      closeSync(fd);
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      try {
        const st = statSync(lp);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try {
            unlinkSync(lp);
          } catch {
            // Lost the race to steal it; loop back and re-check.
          }
          continue;
        }
      } catch {
        // Lock vanished between checks; loop back and re-create it.
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out acquiring posting-ledger lock for ${path}`);
      }
      sleepMs(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lp);
    } catch {
      // Another process already stole and released it; nothing to do.
    }
  }
}

function writeLedger(path: string, ledger: PostingLedger): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2));
}

export function appendLedgerEntry(
  entry: Omit<PostingLedgerEntry, "ts" | "agent"> & { ts?: string; agent?: string },
  path: string = defaultLedgerPath()
): PostingLedgerEntry {
  const full: PostingLedgerEntry = {
    ts: new Date().toISOString(),
    agent: agentId(),
    ...entry,
  };
  try {
    withLedgerLock(path, () => {
      const ledger = readLedger(path);
      ledger.entries.push(full);
      writeLedger(path, ledger);
    });
  } catch {
    // The ledger is advisory: a lock or write failure must never break posting.
    // Fall through and still return the entry we meant to record.
  }
  return full;
}

/**
 * Result of reserving a post under the lock: the pacing check and the
 * ledger write happen in one critical section, so two agents cannot both
 * observe an allowed window and both post. The reservation is recorded
 * immediately with outcome "unconfirmed"; finishPost updates it once the
 * post resolves.
 */
export interface ReserveResult {
  allowed: boolean;
  reason: string | null;
  /** The reserved entry (matched by ts + targetUrl in finishPost), or null. */
  entry: PostingLedgerEntry | null;
  decision: PacingDecision;
}

export function reservePost(
  path: string,
  entry: Omit<PostingLedgerEntry, "ts" | "agent" | "outcome"> & {
    outcome?: PostingOutcome;
    agent?: string;
  },
  config: PacingConfig,
  nowMs: number,
  opts: { force?: boolean } = {}
): ReserveResult {
  return withLedgerLock(path, () => {
    const ledger = readLedger(path);
    const decision = checkPacing(ledger, nowMs, config);
    if (!decision.allowed && !opts.force) {
      return { allowed: false, reason: decision.reason, entry: null, decision };
    }
    const full: PostingLedgerEntry = {
      ts: new Date(nowMs).toISOString(),
      agent: agentId(),
      outcome: "unconfirmed",
      ...entry,
      // Unique per reservation: two posts in the same millisecond must
      // not share an identity (finishPost matches on this). The caller's
      // partial never overrides it.
      id: randomUUID(),
    };
    ledger.entries.push(full);
    writeLedger(path, ledger);
    return { allowed: true, reason: null, entry: full, decision };
  });
}

/** Update a reserved entry's outcome under the lock (matched by ts + targetUrl). */
export function finishPost(
  path: string,
  entry: PostingLedgerEntry,
  outcome: PostingOutcome,
  note?: string
): void {
  try {
    withLedgerLock(path, () => {
      const ledger = readLedger(path);
      // Match on the reservation id: ts + targetUrl is not unique when
      // two posts land in the same millisecond. Entries written before
      // ids existed fall back to ts + targetUrl.
      const stored = entry.id
        ? ledger.entries.find((e) => e.id === entry.id)
        : ledger.entries.find(
            (e) => e.ts === entry.ts && e.targetUrl === entry.targetUrl
          );
      if (stored) {
        stored.outcome = outcome;
        if (note !== undefined) stored.note = note;
        writeLedger(path, ledger);
      }
    });
  } catch {
    // Advisory, like every ledger write.
  }
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
