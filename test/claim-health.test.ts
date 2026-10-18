/**
 * claim-health bucketing tests, incl. the v0.9.2 linked-dead bucket
 * (Product Signals row 36).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bucketClaim, type ClaimHealthInput } from "../src/claim-health.js";
import type { MyClaim } from "../src/claims-registry.js";
import type { IssueStatusPayload } from "../src/protocol.js";

function claim(over: Partial<MyClaim> = {}): MyClaim {
  return {
    issueUrl: "https://github.com/o/r/issues/5",
    owner: "o",
    repo: "r",
    number: 5,
    postedAt: "2026-10-16T10:00:00Z",
    ...over,
  };
}

function status(over: Partial<IssueStatusPayload> = {}): IssueStatusPayload {
  return {
    issue: "https://github.com/o/r/issues/5",
    verdict: null,
    reason: null,
    claim: null,
    protocol_note: null,
    competing_prs: [],
    gates: [],
    repo_protocol: null,
    checked_at: "2026-10-17T00:00:00Z",
    stale_after_seconds: 21600,
    ...over,
  };
}

function linkedDeadStatus(): IssueStatusPayload {
  return status({
    claim: {
      state: "linked-dead",
      claimant: "alice",
      claimed_at: "2026-10-16T10:00:00Z",
      expires_at: "2026-10-23T10:00:00Z",
      queue: [],
      linked_pr: 9,
    },
    competing_prs: [{ number: 9, author: "alice", state: "closed", url: "https://github.com/o/r/pull/9" }],
  });
}

describe("bucketClaim", () => {
  it("linked-dead: closed-unmerged linked PR with a release prompt", () => {
    const h = bucketClaim({
      claim: claim(),
      status: linkedDeadStatus(),
      issueUpdatedAt: null,
      now: new Date("2026-10-17T12:00:00Z"),
    });
    assert.equal(h.bucket, "linked-dead");
    assert.ok(h.detail.includes("#9"), h.detail);
    assert.ok(h.detail.includes("closed unmerged"), h.detail);
    assert.ok(h.detail.includes("greenlight-claim release"), h.detail);
    assert.equal(h.prUrl, "https://github.com/o/r/pull/9");
  });

  it("linked: open PR stays linked, not linked-dead", () => {
    const s = linkedDeadStatus();
    s.claim = { ...s.claim!, state: "linked" };
    s.competing_prs = [{ number: 9, author: "alice", state: "open", url: "https://github.com/o/r/pull/9" }];
    const h = bucketClaim({ claim: claim({ claimant: "alice" }), status: s, issueUpdatedAt: null, now: new Date("2026-10-17T12:00:00Z") });
    assert.equal(h.bucket, "linked");
  });

  it("expired claim goes to queue-lost", () => {
    const s = status({
      claim: {
        state: "expired",
        claimant: "alice",
        claimed_at: "2026-10-01T10:00:00Z",
        expires_at: "2026-10-08T10:00:00Z",
        queue: [],
      },
    });
    const h = bucketClaim({ claim: claim(), status: s, issueUpdatedAt: null, now: new Date("2026-10-17T12:00:00Z") });
    assert.equal(h.bucket, "queue-lost");
  });
});
