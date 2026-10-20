/**
 * The Greenlight Claim Protocol core engine (Phase 1, Greenlight v0.4.0).
 *
 * Implements SPEC.md sections 3 (the claim), 4 (policy file) and 5.1 (status
 * payload) as pure functions over injected data: no network, no dates other
 * than the caller's `now`, no exceptions on bad input.
 *
 * Design commitments carried over from the spec:
 * - GitHub is the source of truth: a claim is a comment carrying the marker
 *   `<!-- greenlight-claim v1 -->`, ordered by the comment's own created_at
 *   (ties broken by comment id). The engine never invents timestamps.
 * - Claims are leases, not property: expiry is computed lazily by any reader.
 * - The state machine replays events chronologically (claims, heartbeats,
 *   releases, PR links), so a later build phase (the Ledger indexer) and the
 *   client-side CLI share one truth.
 *
 * Spec ambiguities resolved here (each is flagged DECISION in a comment):
 * 1. A second protocol claim by the same author while their earlier claim is
 *    still alive is treated as a heartbeat, not a new claim (anti-squatting).
 * 2. A promoted claim restarts its lease at promotion time: its expiry is
 *    promotion + lease (capped by promotion + tenure cap). Without this, long
 *    queues would be born dead.
 * 3. A rocket reaction carries no timestamp in our input shape, so it counts
 *    as a heartbeat "as of now" (extends expiry to now + lease).
 * 4. A linked PR in state "closed" (not merged) keeps the claim "linked"
 *    (lease frozen); the claim does not quietly resume.
 * 5. A mergedPrNumber that is not among linkedPrs is synthesized as a linked
 *    merged PR with createdAt = now. It freezes the current holder; it does
 *    not resurrect a claim that already expired before the merge was known
 *    (expiry is lazy but materialized, not speculative).
 * 6. Heartbeats only count after a claim's activation; a queued claimant's
 *    earlier comments do not pre-extend the lease.
 * 7. Comments with unparseable createdAt are skipped entirely (they cannot be
 *    ordered, and ordering is the whole game).
 */

import type { Verdict } from "./types.js";

export const PROTOCOL_VERSION = 1;
export const CLAIM_MARKER = "<!-- greenlight-claim v1 -->";
export const RELEASE_MARKER = "<!-- greenlight-claim release -->";
/** Spec 3.4: squatting budget, indexed active claims per account. */
export const MAX_ACTIVE_CLAIMS_PER_ACCOUNT = 5;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Policy (spec section 4)
// ---------------------------------------------------------------------------

/** Repo claim policy, from `.greenlight/claims.json`. */
export interface ClaimsPolicy {
  protocol: 1;
  lease_days: number;
  tenure_cap_days: number;
  queue: boolean;
  who_can_claim: string;
  maintainers: string[];
  /** True when the policy text could not be parsed or named another protocol
   *  version; the rest of the fields are the safe defaults. */
  invalid?: boolean;
}

export function defaultClaimsPolicy(): ClaimsPolicy {
  return {
    protocol: 1,
    lease_days: 7,
    tenure_cap_days: 28,
    queue: true,
    who_can_claim: "anyone",
    maintainers: [],
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Parse a `.greenlight/claims.json` body. Never throws: bad JSON (or a
 * protocol version this engine cannot read) degrades to the defaults with
 * `invalid: true`.
 */
export function parseClaimsPolicy(jsonText: string): ClaimsPolicy {
  const base = defaultClaimsPolicy();
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { ...base, invalid: true };
  }
  if (typeof raw !== "object" || raw === null) return { ...base, invalid: true };
  const r = raw as Record<string, unknown>;
  // DECISION: a policy naming a different protocol version is unreadable to
  // this engine; fall back to defaults rather than half-applying it.
  if (r.protocol !== PROTOCOL_VERSION) return { ...base, invalid: true };
  const lease_days = clampInt(r.lease_days, base.lease_days, 1, 30);
  // DECISION: an explicit tenure_cap_days is never overridden. The
  // Math.max guard against a cap shorter than one lease applies only when
  // the file's value is absent or invalid; a maintainer who writes
  // {"lease_days": 30, "tenure_cap_days": 28} means 28, and the engine
  // honors it. Field lesson 2026-10-19: Math.max(tenureCapRaw, lease_days)
  // silently turned that into 30.
  const rawCap = r.tenure_cap_days;
  const capNum = typeof rawCap === "number" ? rawCap : Number(rawCap);
  const capExplicit =
    Number.isInteger(capNum) &&
    capNum >= 1 &&
    capNum <= Number.MAX_SAFE_INTEGER;
  const tenure_cap_days = capExplicit
    ? Math.trunc(capNum)
    : Math.max(base.tenure_cap_days, lease_days);
  const who =
    typeof r.who_can_claim === "string" && r.who_can_claim.trim() !== ""
      ? r.who_can_claim.trim()
      : base.who_can_claim;
  const maintainers = Array.isArray(r.maintainers)
    ? r.maintainers.filter((m): m is string => typeof m === "string")
    : [];
  return {
    protocol: 1,
    lease_days,
    tenure_cap_days,
    queue: typeof r.queue === "boolean" ? r.queue : true,
    who_can_claim: who,
    maintainers,
  };
}

// ---------------------------------------------------------------------------
// Marker parsing (spec section 3.1)
// ---------------------------------------------------------------------------

export interface ParsedClaimComment {
  isClaim: boolean;
  isRelease: boolean;
  plan: string | null;
  etaDays: number | null;
  queueOk: boolean | null;
}

const PLAN_RE = /^\s*plan\s*:\s*(.+?)\s*$/i;
const ETA_RE = /^\s*eta-days\s*:\s*(\d+)\s*$/i;
const QUEUE_OK_RE = /^\s*queue-ok\s*:\s*(yes|no|true|false)\s*$/i;

/**
 * Detect a protocol claim (or release) comment and parse the optional
 * structured lines after the marker. Unknown lines are ignored; the marker
 * alone is a valid claim.
 */
export function parseClaimComment(body: string): ParsedClaimComment {
  const out: ParsedClaimComment = {
    isClaim: false,
    isRelease: false,
    plan: null,
    etaDays: null,
    queueOk: null,
  };
  if (typeof body !== "string") return out;
  const claimIdx = body.indexOf(CLAIM_MARKER);
  out.isRelease = body.includes(RELEASE_MARKER);
  if (claimIdx < 0) return out;
  out.isClaim = true;
  const after = body.slice(claimIdx + CLAIM_MARKER.length);
  for (const line of after.split("\n")) {
    const plan = PLAN_RE.exec(line);
    if (plan) {
      out.plan = plan[1];
      continue;
    }
    const eta = ETA_RE.exec(line);
    if (eta) {
      out.etaDays = parseInt(eta[1], 10);
      continue;
    }
    const q = QUEUE_OK_RE.exec(line);
    if (q) {
      out.queueOk = q[1].toLowerCase() === "yes" || q[1].toLowerCase() === "true";
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One issue comment, as seen by the protocol engine. */
export interface ProtocolCommentInput {
  author: string;
  body: string;
  createdAt: string; // ISO timestamp; unparseable values are skipped (DECISION 7)
  id: number | string;
  url?: string;
}

/** A reaction on a comment. No timestamp in this shape (see DECISION 3). */
export interface ProtocolReactionInput {
  commentId: number | string;
  user: string;
  content: string; // GitHub reaction content, e.g. "rocket", "hooray"
}

/**
 * A PR with closing intent toward the issue. Callers pre-classify link
 * strength (reuse guard's extractors); this engine only needs the timing.
 */
export interface ProtocolLinkedPrInput {
  number: number;
  state: "open" | "closed" | "merged";
  createdAt: string; // ISO, when the closing-intent link was created
}

export interface ClaimStateInput {
  comments: ProtocolCommentInput[];
  reactions?: ProtocolReactionInput[];
  linkedPrs?: ProtocolLinkedPrInput[];
  /** A PR known to have merged fixing this issue (used when linkedPrs lacks it). */
  mergedPrNumber?: number | null;
  policy?: ClaimsPolicy;
  /** ISO "now". Defaults to the real current time; pass explicitly in tests. */
  now?: string;
  repo?: string;
  issue?: number;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type ClaimStateName =
  | "active"
  | "linked"
  | "linked-dead"
  | "completed"
  | "released"
  | "expired"
  | "queued";

export interface ClaimHistoryEvent {
  event: string;
  at: string;
  by: string;
}

/** One protocol claim in the chain, fully resolved. */
export interface ResolvedClaim {
  /** 1-based position in the chronological chain (1 = head). */
  position: number;
  claimant: string;
  claimedAt: string;
  commentId: number | string;
  commentUrl: string | null;
  plan: string | null;
  etaDays: number | null;
  queueOk: boolean | null;
  state: ClaimStateName;
  /** When this claim's lease started (claimedAt, or promotion time). */
  activatedAt: string;
  expiresAt: string;
  lastHeartbeatAt: string;
  linkedPr: number | null;
  history: ClaimHistoryEvent[];
}

/** The SPEC 3.2 record shape, as stored in the Ledger and returned by the API. */
export interface ProtocolClaimRecord {
  v: 1;
  repo: string | null;
  issue: number | null;
  claimant: string;
  claimed_at: string;
  comment_url: string | null;
  state: ClaimStateName;
  lease_days: number;
  expires_at: string;
  last_heartbeat_at: string;
  linked_pr: number | null;
  queue_position: number;
  history: ClaimHistoryEvent[];
  over_cap?: boolean;
}

export interface ProtocolComputation {
  /** Every protocol claim ever posted, in claimed_at order (ties by id). */
  claims: ResolvedClaim[];
  /** The claim holding the issue at `now`, or null when the issue is free. */
  active: ResolvedClaim | null;
  /** Claims waiting behind the holder (positions 2+). */
  queue: ResolvedClaim[];
  /** The SPEC 3.2 record for the active claim, or null. */
  activeRecord: ProtocolClaimRecord | null;
  policy: ClaimsPolicy;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

function toMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

interface ClaimNode {
  claimant: string;
  claimedAtMs: number;
  commentId: number | string;
  commentUrl: string | null;
  plan: string | null;
  etaDays: number | null;
  queueOk: boolean | null;
  releaseAtMs: number | null;
  heartbeatMs: number[];
}

function compareIds(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Replay the claim chain for one issue and resolve every claim's state at
 * `now`. Pure: no network, no exceptions on messy input.
 */
export function computeClaimState(input: ClaimStateInput): ProtocolComputation {
  const policy = input.policy ?? defaultClaimsPolicy();
  const nowMs = input.now ? toMs(input.now) ?? Date.now() : Date.now();
  const leaseMs = policy.lease_days * DAY_MS;
  const tenureMs = policy.tenure_cap_days * DAY_MS;

  // 1. Parse claim comments into nodes, in chronological order.
  const rawNodes: ClaimNode[] = [];
  for (const c of input.comments ?? []) {
    const at = toMs(c.createdAt);
    if (at === null) continue; // DECISION 7: unordered comments are unusable
    const parsed = parseClaimComment(c.body);
    if (!parsed.isClaim) continue;
    rawNodes.push({
      claimant: c.author,
      claimedAtMs: at,
      commentId: c.id,
      commentUrl: c.url ?? null,
      plan: parsed.plan,
      etaDays: parsed.etaDays,
      queueOk: parsed.queueOk,
      releaseAtMs: null,
      heartbeatMs: [],
    });
  }
  rawNodes.sort((a, b) => a.claimedAtMs - b.claimedAtMs || compareIds(a.commentId, b.commentId));

  // 2. Release markers: earliest release comment by the claimant, strictly
  //    after their claim comment.
  for (const node of rawNodes) {
    let earliest: number | null = null;
    for (const c of input.comments ?? []) {
      const at = toMs(c.createdAt);
      if (at === null || at <= node.claimedAtMs) continue;
      if (c.author !== node.claimant) continue;
      if (!c.body.includes(RELEASE_MARKER)) continue;
      if (earliest === null || at < earliest) earliest = at;
    }
    node.releaseAtMs = earliest;
  }

  // 3. DECISION 1: a second protocol claim by the same author while their
  //    earlier claim is still alive is a heartbeat, not a new claim.
  //    Process per author: keep a claim only if the previous kept claim had
  //    already ended (by release or by its natural expiry) before this one.
  const kept: ClaimNode[] = [];
  for (const node of rawNodes) {
    const prev = [...kept].reverse().find((k) => k.claimant === node.claimant);
    if (prev) {
      const prevExpiry = Math.min(prev.claimedAtMs + leaseMs, prev.claimedAtMs + tenureMs);
      const prevEnd = Math.min(prevExpiry, prev.releaseAtMs ?? Number.POSITIVE_INFINITY);
      if (prevEnd > node.claimedAtMs) {
        // Duplicate: the comment still counts as a heartbeat below.
        continue;
      }
    }
    kept.push(node);
  }
  kept.sort((a, b) => a.claimedAtMs - b.claimedAtMs || compareIds(a.commentId, b.commentId));

  // 4. Heartbeats: any later comment by the claimant (excluding release
  //    comments), plus rocket reactions on their own claim comment (DECISION 3:
  //    reactions count as of `now`). Kept-node claim comments are excluded
  //    from each other's heartbeat lists so a re-claim after expiry is not
  //    also a heartbeat; dropped duplicate claims DO count.
  const keptCommentIds = new Set(kept.map((k) => String(k.commentId)));
  const duplicateClaimComments = new Set(
    rawNodes.filter((n) => !kept.includes(n)).map((n) => String(n.commentId))
  );
  for (const node of kept) {
    const beats: number[] = [];
    for (const c of input.comments ?? []) {
      const at = toMs(c.createdAt);
      if (at === null || at <= node.claimedAtMs) continue;
      if (c.author !== node.claimant) continue;
      if (c.body.includes(RELEASE_MARKER)) continue;
      // Heartbeats after the release ended the claim do not count.
      if (node.releaseAtMs !== null && at >= node.releaseAtMs) continue;
      const cid = String(c.id);
      if (keptCommentIds.has(cid) && !duplicateClaimComments.has(cid)) continue;
      beats.push(at);
    }
    for (const r of input.reactions ?? []) {
      if (String(r.commentId) !== String(node.commentId)) continue;
      if (r.user !== node.claimant) continue;
      if (r.content !== "rocket") continue;
      beats.push(nowMs); // DECISION 3
    }
    node.heartbeatMs = beats.sort((a, b) => a - b);
  }

  // 5. Link events (closing-intent PRs). Effective list, with the
  //    mergedPrNumber fallback synthesized (DECISION 5).
  interface LinkEvent {
    number: number;
    state: "open" | "closed" | "merged";
    createdAtMs: number;
  }
  const links: LinkEvent[] = [];
  for (const p of input.linkedPrs ?? []) {
    const at = toMs(p.createdAt);
    if (at === null) continue;
    links.push({ number: p.number, state: p.state, createdAtMs: at });
  }
  if (input.mergedPrNumber != null && !links.some((l) => l.number === input.mergedPrNumber)) {
    links.push({ number: input.mergedPrNumber, state: "merged", createdAtMs: nowMs });
  }
  links.sort((a, b) => a.createdAtMs - b.createdAtMs);

  // 6. Replay: each claim activates when the previous one ends. A closing-
  //    intent PR that lands while a claim is alive freezes its lease (the
  //    claim becomes linked, then completed if the PR merges): review
  //    timelines belong to maintainers, never cost the claimant.
  interface Resolved extends ResolvedClaim {
    startMs: number;
    endMs: number;
    expiryMs: number;
    releaseMs: number | null;
  }
  const resolved: Resolved[] = [];
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < kept.length; i++) {
    const node = kept[i];
    const startMs = Math.max(node.claimedAtMs, prevEnd);
    // DECISION 6: only heartbeats after activation extend the lease.
    const beatsAfterStart = node.heartbeatMs.filter((h) => h > startMs);
    const lastHb = beatsAfterStart.length > 0 ? beatsAfterStart[beatsAfterStart.length - 1] : startMs;
    // DECISION 2: a promoted claim's tenure restarts at promotion time, and
    // its lease restarts there too, so a queue can never be born dead.
    const capBase = i === 0 ? node.claimedAtMs : startMs;
    const expiryMs = Math.min(lastHb + leaseMs, capBase + tenureMs);
    const releaseMs = node.releaseAtMs;
    const hardEnd = Math.min(expiryMs, releaseMs ?? Number.POSITIVE_INFINITY);

    const history: ClaimHistoryEvent[] = [
      { event: "claimed", at: iso(node.claimedAtMs), by: node.claimant },
    ];
    if (i > 0) history.push({ event: "promoted", at: iso(startMs), by: node.claimant });
    for (const h of beatsAfterStart) history.push({ event: "heartbeat", at: iso(h), by: node.claimant });

    // A link that lands while the claim is alive (and not already released)
    // freezes the lease. It is evaluated against the claim's natural end so
    // a PR that arrives after expiry belongs to whoever holds the issue then.
    const linkWindow = links.filter(
      (l) => l.createdAtMs >= startMs && l.createdAtMs <= Math.min(hardEnd, nowMs)
    );
    const linkBeforeRelease = linkWindow.filter((l) => releaseMs === null || l.createdAtMs <= releaseMs);
    const firstLink = linkBeforeRelease[0] ?? null;

    let endMs = hardEnd;
    let linkedPr: number | null = null;
    if (firstLink) {
      // DECISION 4: even a closed (unmerged) linked PR keeps the lease
      // frozen; the claim does not quietly resume.
      endMs = Number.POSITIVE_INFINITY;
      linkedPr = firstLink.number;
      history.push({ event: "linked", at: iso(firstLink.createdAtMs), by: node.claimant });
      const mergedLink = linkBeforeRelease.find(
        (l) => l.state === "merged" || l.number === input.mergedPrNumber
      );
      if (mergedLink) {
        history.push({ event: "completed", at: iso(mergedLink.createdAtMs), by: "protocol" });
      }
    }

    resolved.push({
      position: i + 1,
      claimant: node.claimant,
      claimedAt: iso(node.claimedAtMs),
      commentId: node.commentId,
      commentUrl: node.commentUrl,
      plan: node.plan,
      etaDays: node.etaDays,
      queueOk: node.queueOk,
      state: "queued",
      activatedAt: iso(startMs),
      expiresAt: iso(Math.min(expiryMs, capBase + tenureMs)),
      lastHeartbeatAt: iso(lastHb),
      linkedPr,
      history,
      startMs,
      endMs,
      expiryMs,
      releaseMs,
    });
    prevEnd = endMs;
  }

  // 7. Resolve each claim's state at `now`.
  const holderIdx = resolved.findIndex((r) => r.startMs <= nowMs && nowMs < r.endMs);
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    if (holderIdx === -1 || i < holderIdx) {
      // Terminal: the earlier of release or expiry decides. A release that
      // lands exactly at expiry is credited to the explicit release.
      const released = r.releaseMs !== null && r.releaseMs <= r.expiryMs;
      if (released) {
        r.state = "released";
        r.history.push({ event: "released", at: iso(r.endMs), by: r.claimant });
      } else {
        r.state = "expired";
        r.history.push({ event: "expired", at: iso(r.endMs), by: "protocol" });
      }
    } else if (i === holderIdx) {
      // The walk already recorded the linked/completed history event.
      r.state = r.linkedPr !== null ? (r.history.some((h) => h.event === "completed") ? "completed" : "linked") : "active";
    } else {
      r.state = "queued";
    }
  }

  function strip(r: Resolved): ResolvedClaim {
    const { startMs: _s, endMs: _e, expiryMs: _x, releaseMs: _r, ...rest } = r;
    void _s;
    void _e;
    void _x;
    void _r;
    return rest;
  }
  const active = holderIdx === -1 ? null : resolved[holderIdx];
  const queue = holderIdx === -1 ? [] : resolved.slice(holderIdx + 1);
  // A claim whose chain ended is never "queued": nothing waits on it.
  const visibleQueue = holderIdx === -1 ? [] : queue;

  return {
    claims: resolved.map(strip),
    active: active ? strip(active) : null,
    queue: visibleQueue.map(strip),
    activeRecord: active ? toRecord(active) : null,
    policy,
  };

  function toRecord(r: Resolved): ProtocolClaimRecord {
    return {
      v: 1,
      repo: input.repo ?? null,
      issue: input.issue ?? null,
      claimant: r.claimant,
      claimed_at: r.claimedAt,
      comment_url: r.commentUrl,
      state: r.state,
      lease_days: policy.lease_days,
      expires_at: r.expiresAt,
      last_heartbeat_at: r.lastHeartbeatAt,
      linked_pr: r.linkedPr,
      queue_position: r.position,
      history: r.history,
    };
  }

}

/**
 * Spec 3.4: mark claims whose claimant holds more than the squatting budget
 * of active claims. `activeCounts` maps login -> active claim count (the
 * caller supplies it from the Ledger or another computation; nothing is
 * fetched here). Returns new records; the input is untouched.
 */
export function applyOverCap(
  records: ProtocolClaimRecord[],
  activeCounts: Record<string, number>
): ProtocolClaimRecord[] {
  return records.map((r) =>
    (activeCounts[r.claimant] ?? 0) > MAX_ACTIVE_CLAIMS_PER_ACCOUNT
      ? { ...r, over_cap: true }
      : r
  );
}

// ---------------------------------------------------------------------------
// Status payload (spec section 5.1)
// ---------------------------------------------------------------------------

export interface StatusCompetingPr {
  number: number;
  author: string;
  state: "open" | "closed" | "merged";
  url?: string;
}

export interface StatusGate {
  kind: string;
  detected: boolean;
  evidence?: string;
}

export interface IssueStatusArgs {
  issueUrl: string;
  computation: ProtocolComputation;
  competingPrs?: StatusCompetingPr[];
  gates?: StatusGate[];
  /** Null when the repo has no policy file (protocol works as a signal only). */
  repoProtocol: { honored: boolean; lease_days: number } | null;
  checkedAt?: string;
  staleAfterSeconds?: number;
}

export interface IssueStatusPayload {
  issue: string;
  /** Null when there are no protocol claims: the verdict is the caller's. */
  verdict: Verdict | null;
  reason: string | null;
  claim: {
    state: ClaimStateName;
    claimant: string;
    claimed_at: string;
    expires_at: string;
    queue: Array<{ claimant: string; position: number; claimed_at: string }>;
    over_cap?: boolean;
    /** The linked PR number, when the claim is linked (or linked-dead). */
    linked_pr?: number | null;
  } | null;
  protocol_note: string | null;
  competing_prs: StatusCompetingPr[];
  gates: StatusGate[];
  repo_protocol: { honored: boolean; lease_days: number } | null;
  checked_at: string;
  stale_after_seconds: number;
}

function shortDate(isoTs: string): string {
  return isoTs.slice(0, 10);
}

/**
 * CLI-side derivation (v0.9.2, Product Signals row 36): a protocol claim
 * that is LINKED but whose linked PR closed unmerged is LINKED-DEAD.
 * The engine (computeClaimState) keeps it "linked" so the lease never
 * quietly resumes; this derivation is what the CLI shows and acts on.
 * The hosted API has its own derivation and is out of scope.
 */
export function deriveDisplayClaimState(
  state: ClaimStateName,
  linkedPr: number | null,
  competingPrs: Array<{ number: number; state: string }>
): ClaimStateName {
  if (state !== "linked" || linkedPr == null) return state;
  const pr = competingPrs.find((p) => p.number === linkedPr);
  return pr && pr.state === "closed" ? "linked-dead" : state;
}


/**
 * Build the SPEC 5.1 issue-status payload from a protocol computation plus
 * caller-supplied context (competing PRs, gates). Verdict mapping:
 * active protocol claim -> TAKEN (expiry in the reason); a completed claim
 * -> TAKEN naming the merged PR; expired-only history -> GO with a note;
 * no protocol claims at all -> verdict null, claim null.
 */
export function buildIssueStatus(args: IssueStatusArgs): IssueStatusPayload {
  const comp = args.computation;
  const competing = args.competingPrs ?? [];
  const openRaces = competing.filter((p) => p.state === "open");
  const checkedAt = args.checkedAt ?? new Date().toISOString();
  const staleAfterSeconds = args.staleAfterSeconds ?? 21600;

  let verdict: Verdict | null = null;
  let reason: string | null = null;
  let claim: IssueStatusPayload["claim"] = null;
  let protocolNote: string | null = null;

  if (comp.activeRecord) {
    const a = comp.activeRecord;
    const queueDesc =
      comp.queue.length > 0
        ? `; queue: ${comp.queue.map((q) => `@${q.claimant} (#${q.position})`).join(", ")}`
        : "";
    const raceDesc = openRaces.length > 0 ? `; open competing PRs: ${openRaces.map((p) => `#${p.number}`).join(", ")}` : "";
    // v0.9.2: linked-dead is derived here, on the CLI side, from the
    // linked PR's live state (see deriveDisplayClaimState).
    const displayState = deriveDisplayClaimState(a.state, a.linked_pr, competing);
    claim = {
      state: displayState,
      claimant: a.claimant,
      claimed_at: a.claimed_at,
      expires_at: a.expires_at,
      queue: comp.queue.map((q) => ({
        claimant: q.claimant,
        position: q.position,
        claimed_at: q.claimedAt,
      })),
      ...(a.over_cap ? { over_cap: true as const } : {}),
      ...(a.linked_pr != null ? { linked_pr: a.linked_pr } : {}),
    };
    if (a.state === "completed") {
      // DECISION: a completed claim means the issue is done, not free. TAKEN
      // with the merged PR named is the honest pre-flight answer.
      verdict = "TAKEN";
      reason = `Protocol claim completed: @${a.claimant}'s linked PR (#${a.linked_pr}) merged; this issue is done${raceDesc}.`;
      protocolNote = "The protocol claim on this issue completed with a merged PR.";
    } else if (displayState === "linked-dead") {
      // The claim's lease froze on a PR that died: nobody is working this
      // issue, but the stale marker still needs an explicit release.
      verdict = "GO";
      reason =
        `Protocol claim linked-dead: @${a.claimant}'s linked PR (#${a.linked_pr}) closed unmerged; ` +
        `the issue is free to work. Release the stale claim before re-claiming: ` +
        `post a comment on ${args.issueUrl} containing <!-- greenlight-claim release -->` +
        raceDesc +
        ".";
      protocolNote =
        `A protocol claim is linked to a pull request that closed unmerged. ` +
        `The issue is free, but the stale claim should be released explicitly.`;
    } else {
      verdict = "TAKEN";
      reason =
        `Protocol claim ${displayState}: @${a.claimant} holds this issue until ${shortDate(a.expires_at)}` +
        queueDesc +
        raceDesc +
        ".";
      protocolNote =
        displayState === "linked"
          ? "A protocol claim is linked to a pull request; review is in the maintainer's hands."
          : "An active protocol claim governs this issue.";
    }
  } else if (comp.claims.length > 0) {
    const last = comp.claims[comp.claims.length - 1];
    verdict = "GO";
    reason = `Only expired or released protocol claims on this issue (last: @${last.claimant}, ${last.state} ${shortDate(last.expiresAt)}); it is free to claim.`;
    protocolNote = "Past protocol claims have all ended; no active lease.";
  } else {
    protocolNote = "No protocol claims found on this issue.";
  }

  return {
    issue: args.issueUrl,
    verdict,
    reason,
    claim,
    protocol_note: protocolNote,
    competing_prs: competing,
    gates: args.gates ?? [],
    repo_protocol: args.repoProtocol,
    checked_at: checkedAt,
    stale_after_seconds: staleAfterSeconds,
  };
}
