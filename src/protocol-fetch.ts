/**
 * Claim Protocol wiring (Greenlight v0.4.0): fetch layer, status assembly,
 * and the check/guard integration points.
 *
 * The engine itself (src/protocol.ts) is pure: it never touches the network.
 * This module assembles the engine's inputs from the GitHub API, computes
 * issue status payloads, and merges protocol verdicts with the legacy
 * check verdicts. All network access goes through injectable fetchers
 * (the GuardDeps seam pattern), so every path is unit-testable without
 * touching the API.
 *
 * Precedence (protocol vs legacy verdict), documented here because two
 * engines now speak: the protocol verdict overrides legacy *claim
 * inference* only. It never overrides gates, and it never overrides
 * cross-referenced PR evidence. When both the protocol and a
 * cross-referenced PR say TAKEN, the reasons merge.
 */

import {
  apiGet,
  ApiNotFoundError,
  parseIssueUrl,
  buildIssueSnapshot,
  fetchLinkedPRs,
  fetchContributing,
  detectRepoPolicy,
  countStarterIssues,
} from "./github.js";
import { scoreIssue } from "./verdict.js";
import { applyLlmClaims } from "./llm-claims.js";
import type { LLMClaimFlag } from "./types.js";
import { parseGates } from "./gates.js";
import { fetchMergeVelocity } from "./merge-velocity.js";
import { scoreFriction } from "./friction.js";
import { isClosingPR } from "./linkstrength.js";
import {
  computeClaimState,
  parseClaimsPolicy,
  parseClaimComment,
  defaultClaimsPolicy,
  buildIssueStatus,
  type ClaimsPolicy,
  type ProtocolComputation,
  type ProtocolCommentInput,
  type ProtocolReactionInput,
  type ProtocolLinkedPrInput,
  type IssueStatusPayload,
} from "./protocol.js";
import type {
  IssueSnapshot,
  Verdict,
  VerdictResult,
  ClaimSignal,
  Gate,
  LinkedPR,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Injected fetchers (network seam)                                    */
/* ------------------------------------------------------------------ */

/** One issue comment with the identity fields the protocol engine needs. */
export interface FetchedComment {
  id: number | string;
  author: string;
  body: string;
  createdAt: string;
  url?: string;
}

/** One reaction on a comment. */
export interface FetchedReaction {
  commentId: number | string;
  user: string;
  content: string;
}

/** Result of reading the repo's `.greenlight/claims.json` policy file. */
export interface ClaimsPolicyFetch {
  /** True when the file exists and parsed (even when invalid); false on 404. */
  honored: boolean;
  policy: ClaimsPolicy;
  /** True when the file existed but could not be parsed: defaults apply. */
  invalid: boolean;
}

export interface ProtocolFetchDeps {
  fetchComments?: (owner: string, repo: string, number: number) => Promise<FetchedComment[]>;
  /** Called only for comments carrying the claim marker. */
  fetchReactions?: (owner: string, repo: string, commentId: number | string) => Promise<FetchedReaction[]>;
  fetchLinkedPRs?: (owner: string, repo: string, number: number) => Promise<LinkedPR[]>;
  fetchPolicy?: (owner: string, repo: string) => Promise<ClaimsPolicyFetch>;
  /** Test seam for the issue snapshot (defaults to the live builder). */
  fetchSnapshot?: (owner: string, repo: string, number: number) => Promise<IssueSnapshot>;
  now?: () => string;
}

async function paginate<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 5; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = (await apiGet(`${path}${sep}per_page=100&page=${page}`)) as T[];
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

interface CommentApiItem {
  id?: unknown;
  user?: { login?: unknown };
  body?: unknown;
  created_at?: unknown;
  html_url?: unknown;
}

async function defaultFetchComments(owner: string, repo: string, number: number): Promise<FetchedComment[]> {
  const data = await paginate<CommentApiItem>(`/repos/${owner}/${repo}/issues/${number}/comments`);
  return data.map((c) => ({
    id: typeof c.id === "number" ? c.id : String(c.id ?? ""),
    author: String(c.user?.login ?? "unknown"),
    body: String(c.body ?? ""),
    createdAt: String(c.created_at ?? ""),
    url: typeof c.html_url === "string" ? c.html_url : undefined,
  }));
}

interface ReactionApiItem {
  user?: { login?: unknown };
  content?: unknown;
}

async function defaultFetchReactions(
  owner: string,
  repo: string,
  commentId: number | string
): Promise<FetchedReaction[]> {
  try {
    const data = (await apiGet(
      `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`
    )) as ReactionApiItem[];
    return (data ?? []).map((r) => ({
      commentId,
      user: String(r.user?.login ?? "unknown"),
      content: String(r.content ?? ""),
    }));
  } catch {
    return [];
  }
}

/**
 * Read `.greenlight/claims.json` from the repo's default branch. 404 means
 * the repo has not adopted the protocol (honored: false); any other failure
 * degrades the same way rather than claiming protocol state we cannot see.
 */
async function defaultFetchPolicy(owner: string, repo: string): Promise<ClaimsPolicyFetch> {
  try {
    const repoInfo = (await apiGet(`/repos/${owner}/${repo}`)) as { default_branch?: unknown };
    const branch = typeof repoInfo.default_branch === "string" ? repoInfo.default_branch : "main";
    const file = (await apiGet(
      `/repos/${owner}/${repo}/contents/.greenlight/claims.json?ref=${encodeURIComponent(branch)}`
    )) as { content?: unknown; encoding?: unknown };
    if (typeof file.content !== "string") {
      return { honored: false, policy: defaultClaimsPolicy(), invalid: false };
    }
    const text = Buffer.from(file.content, "base64").toString("utf8");
    const policy = parseClaimsPolicy(text);
    return { honored: true, policy, invalid: !!policy.invalid };
  } catch (err) {
    if (err instanceof ApiNotFoundError) {
      return { honored: false, policy: defaultClaimsPolicy(), invalid: false };
    }
    return { honored: false, policy: defaultClaimsPolicy(), invalid: false };
  }
}

/* ------------------------------------------------------------------ */
/* Assembly: network shapes -> engine shapes                           */
/* ------------------------------------------------------------------ */

export interface ProtocolFetchResult {
  computation: ProtocolComputation;
  repoProtocol: { honored: boolean; lease_days: number } | null;
  policyInvalid: boolean;
  issueUrl: string;
  /**
   * Detail fetched for closing-strength linked PRs (author, timing, merged
   * state), shared with the status payload so the caller's other machinery
   * does not refetch the same PRs.
   */
  linkedPrDetails: Array<{
    number: number;
    author: string;
    state: "open" | "closed" | "merged";
    url: string;
    createdAt: string | null;
  }>;
}

/**
 * Assemble a protocol state from already-fetched data. Pure: the unit
 * tests drive every integration path through this without the network.
 */
export function assembleProtocolState(
  owner: string,
  repo: string,
  number: number,
  comments: FetchedComment[],
  reactions: FetchedReaction[],
  linkedPrInputs: ProtocolLinkedPrInput[],
  mergedPrNumber: number | null,
  policyFetch: ClaimsPolicyFetch,
  nowIso?: string
): ProtocolFetchResult {
  const inputs: ProtocolCommentInput[] = comments.map((c) => ({
    author: c.author,
    body: c.body,
    createdAt: c.createdAt,
    id: c.id,
    url: c.url,
  }));
  const reactionInputs: ProtocolReactionInput[] = reactions.map((r) => ({
    commentId: r.commentId,
    user: r.user,
    content: r.content,
  }));
  const computation = computeClaimState({
    comments: inputs,
    reactions: reactionInputs,
    linkedPrs: linkedPrInputs,
    mergedPrNumber,
    policy: policyFetch.policy,
    now: nowIso,
    repo: `${owner}/${repo}`,
    issue: number,
  });
  return {
    computation,
    repoProtocol: policyFetch.honored
      ? { honored: true, lease_days: policyFetch.policy.lease_days }
      : null,
    policyInvalid: policyFetch.invalid,
    issueUrl: `https://github.com/${owner}/${repo}/issues/${number}`,
    linkedPrDetails: [],
  };
}

interface PrDetailApi {
  created_at?: unknown;
  merged_at?: unknown;
  state?: unknown;
  user?: { login?: unknown };
}

/**
 * Full protocol fetch for one issue: comments, reactions on marker
 * comments only, the repo policy, and timing detail for closing-strength
 * linked PRs. Best-effort: anything unreadable degrades to "no evidence".
 */
export async function fetchProtocolState(
  owner: string,
  repo: string,
  number: number,
  deps: ProtocolFetchDeps = {}
): Promise<ProtocolFetchResult> {
  const nowIso = (deps.now ?? (() => new Date().toISOString()))();
  const fetchComments = deps.fetchComments ?? defaultFetchComments;
  const fetchReactions = deps.fetchReactions ?? defaultFetchReactions;
  const fetchPRs = deps.fetchLinkedPRs ?? fetchLinkedPRs;
  const fetchPolicy = deps.fetchPolicy ?? defaultFetchPolicy;

  let comments: FetchedComment[] = [];
  try {
    comments = await fetchComments(owner, repo, number);
  } catch {
    comments = [];
  }

  const markerComments = comments.filter((c) => parseClaimComment(c.body).isClaim);

  // Reactions are fetched only for marker comments: the heartbeat signal
  // exists only where a protocol claim exists, and each reaction list is
  // its own API call.
  const reactions: FetchedReaction[] = [];
  for (const mc of markerComments) {
    try {
      const rs = await fetchReactions(owner, repo, mc.id);
      for (const r of rs) reactions.push({ ...r, commentId: mc.id });
    } catch {
      // A missing reactions list just means no heartbeats from reactions.
    }
  }

  let policyFetch: ClaimsPolicyFetch;
  try {
    policyFetch = await fetchPolicy(owner, repo);
  } catch {
    policyFetch = { honored: false, policy: defaultClaimsPolicy(), invalid: false };
  }

  let linked: LinkedPR[] = [];
  try {
    linked = await fetchPRs(owner, repo, number);
  } catch {
    linked = [];
  }
  const closing = linked.filter((p) => p.linkStrength === "closing");

  // Detail for closing PRs: author and created_at feed the status payload
  // and the engine's link timing. The engine only needs timing when
  // protocol claims exist, but the payload wants authors either way, so one
  // pass serves both. A failed detail fetch degrades: the PR stays in the
  // payload from snapshot data, and merged ones still reach the engine
  // through the mergedPrNumber fallback (the engine synthesizes timing for
  // those; see DECISION 5 in protocol.ts).
  const details: ProtocolFetchResult["linkedPrDetails"] = [];
  const linkedPrInputs: ProtocolLinkedPrInput[] = [];
  let mergedPrNumber: number | null = null;
  for (const p of closing) {
    try {
      const d = (await apiGet(`/repos/${owner}/${repo}/pulls/${p.number}`)) as PrDetailApi;
      const merged = d.merged_at != null;
      const state = merged ? "merged" : p.state === "closed" ? "closed" : "open";
      const createdAt = typeof d.created_at === "string" ? d.created_at : null;
      const author = String(d.user?.login ?? "unknown");
      details.push({ number: p.number, author, state, url: p.url, createdAt });
      if (createdAt) {
        linkedPrInputs.push({ number: p.number, state, createdAt });
      } else if (merged && mergedPrNumber === null) {
        mergedPrNumber = p.number;
      }
      if (merged && mergedPrNumber === null) mergedPrNumber = p.number;
    } catch {
      details.push({ number: p.number, author: "unknown", state: p.state, url: p.url, createdAt: null });
      if (p.state === "merged" && mergedPrNumber === null) mergedPrNumber = p.number;
    }
  }

  const result = assembleProtocolState(
    owner,
    repo,
    number,
    comments,
    reactions,
    linkedPrInputs,
    mergedPrNumber,
    policyFetch,
    nowIso
  );
  result.linkedPrDetails = details;
  return result;
}

/* ------------------------------------------------------------------ */
/* Status: legacy snapshot + protocol, merged                          */
/* ------------------------------------------------------------------ */

export interface IssueStatusComputation {
  snapshot: IssueSnapshot;
  legacy: VerdictResult;
  status: IssueStatusPayload;
  computation: ProtocolComputation;
  repoProtocol: { honored: boolean; lease_days: number } | null;
  policyInvalid: boolean;
}

export interface ComputeStatusOptions {
  externalGates?: Gate[];
  deps?: ProtocolFetchDeps;
}

/**
 * The full pre-flight computation for one issue: the legacy verdict
 * machinery plus the protocol state, assembled into the SPEC 5.1 payload.
 */
export async function computeIssueStatus(
  owner: string,
  repo: string,
  number: number,
  opts: ComputeStatusOptions = {}
): Promise<IssueStatusComputation> {
  const deps = opts.deps ?? {};
  const fetchSnapshot = deps.fetchSnapshot ?? buildIssueSnapshot;
  const snapshot = await fetchSnapshot(owner, repo, number);
  if (opts.externalGates) snapshot.externalGates = opts.externalGates;
  const legacy = scoreIssue(snapshot);
  const proto = await fetchProtocolState(owner, repo, number, deps);

  const competingPrs = proto.linkedPrDetails.map((d) => ({
    number: d.number,
    author: d.author,
    state: d.state,
    url: d.url,
  }));
  const gates = legacy.gates.map((g) => ({
    kind: g.kind,
    detected: g.detected,
    ...(typeof g.evidence === "string" && g.evidence ? { evidence: g.evidence } : {}),
  }));
  const status = buildIssueStatus({
    issueUrl: snapshot.sourceUrl,
    computation: proto.computation,
    competingPrs,
    gates,
    repoProtocol: proto.repoProtocol,
    checkedAt: new Date().toISOString(),
  });
  return {
    snapshot,
    legacy,
    status,
    computation: proto.computation,
    repoProtocol: proto.repoProtocol,
    policyInvalid: proto.policyInvalid,
  };
}

/* ------------------------------------------------------------------ */
/* Verdict merge: the precedence rule                                  */
/* ------------------------------------------------------------------ */

/**
 * Reason prefixes produced by the legacy verdict engine's claim rules
 * (rules 4, 5/5b, 6/6b, and warning W in verdict.ts). When the protocol
 * holds a live claim, these lines are the ones the protocol supersedes;
 * every other reason (PR evidence, gates, duplicates, bounty, decay)
 * survives the merge.
 */
const CLAIM_REASON_PREFIXES = [
  "claim race: ",
  "claimed by ",
  "stale claim by ",
  "stale partial claim by ",
  "soft claim by ",
  // Optional Fireworks layer (llm-claims.ts): AI claim inference is legacy
  // claim inference, so a live protocol claim supersedes it the same way.
  "possible claim by ",
];

function isClaimDerivedReason(reason: string): boolean {
  if (CLAIM_REASON_PREFIXES.some((p) => reason.startsWith(p))) return true;
  // Rule 5b fresh partial: "<author> claimed the <scope> part ...; the rest may still be open"
  return / claimed .*; the rest may still be open$/.test(reason);
}

/** Flags the legacy engine sets for claim inference; the protocol replaces them. */
const CLAIM_DERIVED_FLAGS = ["claimed", "stale_claim", "partial-claim", "weak-claim", "llm-claim"];

export interface MergedCheckResult {
  verdict: Verdict;
  reasons: string[];
  flags: string[];
  claims: ClaimSignal[];
  gates: Gate[];
  protocol: {
    verdict: Verdict | null;
    reason: string | null;
    claim: IssueStatusPayload["claim"];
    protocol_note: string | null;
    repo_protocol: { honored: boolean; lease_days: number } | null;
  };
  /** One to three plain lines for the text renderer. */
  protocolLines: string[];
  /** AI claim-intent flags from the optional LLM layer; rides along for transparency. */
  llm_claims?: LLMClaimFlag[];
}

/**
 * Merge the protocol verdict with the legacy verdict.
 *
 * Precedence: the protocol verdict overrides legacy *claim inference*.
 * It never overrides gates, and it never overrides cross-referenced PR
 * evidence. When both the protocol and a cross-referenced PR say TAKEN,
 * the reasons merge (protocol reason first, PR evidence kept).
 */
export function mergeProtocolVerdict(
  legacy: VerdictResult,
  status: IssueStatusPayload
): MergedCheckResult {
  const protocolField: MergedCheckResult["protocol"] = {
    verdict: status.verdict,
    reason: status.reason,
    claim: status.claim,
    protocol_note: status.protocol_note,
    repo_protocol: status.repo_protocol,
  };
  const protocolLines: string[] = [];

  if (status.verdict === "TAKEN" && status.claim) {
    const c = status.claim;
    protocolLines.push(
      `protocol claim: @${c.claimant} holds this issue until ${c.expires_at.slice(0, 10)} (state: ${c.state})`
    );
    if (c.queue.length > 0) {
      protocolLines.push(`queue: ${c.queue.map((q) => `@${q.claimant} (#${q.position})`).join(", ")}`);
    }
    if (status.protocol_note) protocolLines.push(status.protocol_note);

    if (legacy.verdict === "GATED") {
      // Gates are ritual, not inference: a repo that blocks outside PRs
      // blocks them no matter who holds a claim. The protocol becomes
      // context, not a verdict.
      return {
        verdict: "GATED",
        reasons: [...legacy.reasons, status.reason ?? "protocol claim active"],
        flags: [...legacy.flags, "protocol-claim"],
        claims: legacy.claims,
        gates: legacy.gates,
        protocol: protocolField,
        protocolLines,
        llm_claims: legacy.llm_claims,
      };
    }
    // Protocol wins over the legacy claim assessment; PR-derived evidence
    // (open closing PR, cross-referenced PRs) survives the merge.
    const keptReasons = legacy.reasons.filter((r) => !isClaimDerivedReason(r));
    const keptFlags = legacy.flags.filter((f) => !CLAIM_DERIVED_FLAGS.includes(f));
    return {
      verdict: "TAKEN",
      reasons: [status.reason ?? "protocol claim active", ...keptReasons],
      flags: ["protocol-claim", ...keptFlags],
      claims: legacy.claims,
      gates: legacy.gates,
      protocol: protocolField,
      protocolLines,
      llm_claims: legacy.llm_claims,
    };
  }

  if (status.verdict === "GO") {
    // Expired-only history: the protocol has nothing live, so the verdict
    // stands and the note rides along.
    protocolLines.push(
      status.protocol_note ?? "past protocol claims have all ended; no active lease"
    );
    return {
      verdict: legacy.verdict,
      reasons: [...legacy.reasons, status.reason ?? status.protocol_note ?? "protocol: no active claims"],
      flags: [...legacy.flags, "protocol-expired"],
      claims: legacy.claims,
      gates: legacy.gates,
      protocol: protocolField,
      protocolLines,
      llm_claims: legacy.llm_claims,
    };
  }

  // No protocol claims at all: legacy stands, one quiet line.
  protocolLines.push(status.protocol_note ?? "no protocol claims on this issue");
  return {
    verdict: legacy.verdict,
    reasons: legacy.reasons,
    flags: legacy.flags,
    claims: legacy.claims,
    gates: legacy.gates,
    protocol: protocolField,
    protocolLines,
    llm_claims: legacy.llm_claims,
  };
}

export interface CheckWithProtocolOptions {
  externalGates?: Gate[];
  deps?: ProtocolFetchDeps;
}

/** The `check` command's full pipeline: legacy verdict, optional AI claim layer, merged with protocol. */
export async function checkIssueWithProtocol(
  owner: string,
  repo: string,
  number: number,
  opts: CheckWithProtocolOptions = {}
): Promise<{
  snapshot: IssueSnapshot;
  legacy: VerdictResult;
  status: IssueStatusPayload;
  merged: MergedCheckResult;
}> {
  const { snapshot, legacy, status } = await computeIssueStatus(owner, repo, number, opts);
  // The optional Fireworks layer runs on the legacy verdict, before the
  // protocol merge: it is a no-op unless FIREWORKS_API_KEY is set, and it
  // can only ever downgrade GO to RISKY, never TAKEN or GATED.
  const legacyWithLlm = await applyLlmClaims(snapshot, legacy);
  return { snapshot, legacy: legacyWithLlm, status, merged: mergeProtocolVerdict(legacyWithLlm, status) };
}

