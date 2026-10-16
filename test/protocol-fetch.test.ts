/**
 * Tests for the Claim Protocol wiring layer: policy fetch behavior, the
 * reactions-only-for-marker-comments rule, and the check/guard merge
 * precedence. Every network path uses injected fetchers; the API is never
 * touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assembleProtocolState,
  fetchProtocolState,
  mergeProtocolVerdict,
  type FetchedComment,
  type ClaimsPolicyFetch,
} from "../src/protocol-fetch.js";
import {
  defaultClaimsPolicy,
  CLAIM_MARKER,
  type IssueStatusPayload,
} from "../src/protocol.js";
import type { VerdictResult } from "../src/types.js";

function policyFetch(overrides: Partial<ClaimsPolicyFetch> = {}): ClaimsPolicyFetch {
  return {
    honored: false,
    policy: defaultClaimsPolicy(),
    invalid: false,
    ...overrides,
  };
}

function markerComment(author: string, createdAt: string, id = 1): FetchedComment {
  return {
    id,
    author,
    body: `I'll take this.\n\n${CLAIM_MARKER}\nplan: fix it\n`,
    createdAt,
    url: `https://github.com/o/r/issues/1#issuecomment-${id}`,
  };
}

function legacyResult(overrides: Partial<VerdictResult> = {}): VerdictResult {
  return {
    verdict: "GO",
    reasons: [],
    flags: [],
    claims: [],
    gates: [],
    ...overrides,
  };
}

function takenStatus(reason: string): IssueStatusPayload {
  return {
    issue: "https://github.com/o/r/issues/1",
    verdict: "TAKEN",
    reason,
    claim: {
      state: "active",
      claimant: "rival",
      claimed_at: "2026-10-13T10:00:00Z",
      expires_at: "2026-10-20T10:00:00Z",
      queue: [{ claimant: "next", position: 2, claimed_at: "2026-10-14T10:00:00Z" }],
    },
    protocol_note: "An active protocol claim governs this issue.",
    competing_prs: [],
    gates: [],
    repo_protocol: null,
    checked_at: "2026-10-15T12:00:00Z",
    stale_after_seconds: 21600,
  };
}

describe("policy fetch", () => {
  it("honored when the policy file parses", async () => {
    const result = await fetchProtocolState("o", "r", 1, {
      fetchComments: async () => [],
      fetchPolicy: async () => ({
        honored: true,
        policy: { ...defaultClaimsPolicy(), lease_days: 10 },
        invalid: false,
      }),
      fetchLinkedPRs: async () => [],
    });
    assert.deepEqual(result.repoProtocol, { honored: true, lease_days: 10 });
    assert.equal(result.policyInvalid, false);
    assert.equal(result.computation.active, null);
  });

  it("not honored on 404, and flags an invalid file", async () => {
    const missing = await fetchProtocolState("o", "r", 1, {
      fetchComments: async () => [],
      fetchPolicy: async () => policyFetch({ honored: false }),
      fetchLinkedPRs: async () => [],
    });
    assert.equal(missing.repoProtocol, null);
    assert.equal(missing.policyInvalid, false);

    const invalid = await fetchProtocolState("o", "r", 1, {
      fetchComments: async () => [],
      fetchPolicy: async () =>
        policyFetch({ honored: true, invalid: true, policy: { ...defaultClaimsPolicy(), invalid: true } }),
      fetchLinkedPRs: async () => [],
    });
    assert.deepEqual(invalid.repoProtocol, { honored: true, lease_days: 7 });
    assert.equal(invalid.policyInvalid, true);
  });
});

describe("reactions are fetched only for marker comments", () => {
  it("skips the reactions call for plain comments", async () => {
    const reactionCalls: Array<number | string> = [];
    const result = await fetchProtocolState("o", "r", 1, {
      fetchComments: async () => [
        markerComment("rival", "2026-10-13T10:00:00Z", 11),
        { id: 12, author: "bystander", body: "any update?", createdAt: "2026-10-14T10:00:00Z" },
      ],
      fetchReactions: async (_o, _r, id) => {
        reactionCalls.push(id);
        return [];
      },
      fetchPolicy: async () => policyFetch(),
      fetchLinkedPRs: async () => [],
      now: () => "2026-10-15T12:00:00Z",
    });
    assert.deepEqual(reactionCalls, [11]);
    assert.ok(result.computation.active);
    assert.equal(result.computation.active.claimant, "rival");
  });
});

describe("mergeProtocolVerdict precedence", () => {
  it("protocol TAKEN wins over a legacy RISKY claim, dropping the claim reason", () => {
    const legacy = legacyResult({
      verdict: "RISKY",
      reasons: ['claimed by alice 3 day(s) ago ("I\'ll take this")'],
      flags: ["claimed"],
      claims: [
        {
          author: "alice",
          createdAt: "2026-10-12T10:00:00Z",
          ageDays: 3,
          strength: "strong",
          phrase: "bare-take",
          scope: "full",
        },
      ],
    });
    const merged = mergeProtocolVerdict(legacy, takenStatus("Protocol claim active: @rival holds this issue until 2026-10-20."));
    assert.equal(merged.verdict, "TAKEN");
    assert.ok(merged.reasons[0].includes("@rival"), merged.reasons.join(" | "));
    assert.ok(!merged.reasons.some((r) => r.includes("claimed by alice")), merged.reasons.join(" | "));
    assert.ok(!merged.flags.includes("claimed"), merged.flags.join(","));
    assert.ok(merged.flags.includes("protocol-claim"));
    assert.equal(merged.protocolLines.length, 3);
  });

  it("protocol TAKEN merges with a legacy cross-referenced PR TAKEN", () => {
    const legacy = legacyResult({
      verdict: "TAKEN",
      reasons: ["open PR(s) cross-referenced in the issue timeline: #1987 \"Fix\" (https://x/1987)"],
      flags: ["cross-referenced-pr"],
    });
    const merged = mergeProtocolVerdict(legacy, takenStatus("Protocol claim active: @rival holds this issue until 2026-10-20."));
    assert.equal(merged.verdict, "TAKEN");
    assert.ok(merged.reasons[0].includes("@rival"));
    assert.ok(merged.reasons.some((r) => r.includes("#1987")), merged.reasons.join(" | "));
    assert.ok(merged.flags.includes("cross-referenced-pr"));
  });

  it("gates are never overridden by a protocol claim", () => {
    const legacy = legacyResult({
      verdict: "GATED",
      reasons: ["repo gate blocks outside PRs: assignment required"],
      flags: [],
    });
    const merged = mergeProtocolVerdict(legacy, takenStatus("Protocol claim active: @rival holds this issue until 2026-10-20."));
    assert.equal(merged.verdict, "GATED");
    assert.ok(merged.reasons[0].includes("assignment required"));
  });

  it("expired-only history appends a note without changing the verdict", () => {
    const legacy = legacyResult({ verdict: "GO", reasons: ["nothing found"] });
    const status = takenStatus("unused");
    status.verdict = "GO";
    status.reason = "Only expired or released protocol claims on this issue (last: @old, expired 2026-09-01); it is free to claim.";
    status.claim = null;
    status.protocol_note = "Past protocol claims have all ended; no active lease.";
    const merged = mergeProtocolVerdict(legacy, status);
    assert.equal(merged.verdict, "GO");
    assert.ok(merged.reasons.includes(status.reason));
    assert.ok(merged.flags.includes("protocol-expired"));
    assert.equal(merged.protocolLines.length, 1);
  });

  it("no protocol claims leaves the legacy verdict untouched", () => {
    const legacy = legacyResult({ verdict: "RISKY", reasons: ["something"] });
    const status = takenStatus("unused");
    status.verdict = null;
    status.reason = null;
    status.claim = null;
    status.protocol_note = "No protocol claims found on this issue.";
    const merged = mergeProtocolVerdict(legacy, status);
    assert.equal(merged.verdict, "RISKY");
    assert.deepEqual(merged.reasons, ["something"]);
    assert.equal(merged.protocolLines.length, 1);
  });
});

describe("assembleProtocolState", () => {
  it("returns null verdict and claim when no marker comments exist", () => {
    const result = assembleProtocolState(
      "o",
      "r",
      1,
      [{ id: 1, author: "a", body: "looks good", createdAt: "2026-10-13T10:00:00Z" }],
      [],
      [],
      null,
      policyFetch(),
      "2026-10-15T12:00:00Z"
    );
    assert.equal(result.computation.active, null);
    assert.equal(result.computation.claims.length, 0);
  });

  it("resolves an active claim with expiry and queue", () => {
    const result = assembleProtocolState(
      "o",
      "r",
      1,
      [
        markerComment("rival", "2026-10-13T10:00:00Z", 11),
        {
          id: 12,
          author: "next",
          body: `I can take this too.\n\n${CLAIM_MARKER}\n`,
          createdAt: "2026-10-14T10:00:00Z",
        },
      ],
      [],
      [],
      null,
      policyFetch({ honored: true, policy: { ...defaultClaimsPolicy(), lease_days: 7 } }),
      "2026-10-15T12:00:00Z"
    );
    const active = result.computation.active;
    assert.ok(active);
    assert.equal(active.claimant, "rival");
    assert.equal(active.expiresAt.slice(0, 10), "2026-10-20");
    assert.equal(result.computation.queue.length, 1);
    assert.equal(result.computation.queue[0].claimant, "next");
    assert.deepEqual(result.repoProtocol, { honored: true, lease_days: 7 });
  });
});
