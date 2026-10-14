import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreFriction } from "../src/friction.js";
import type { Gate } from "../src/types.js";

function gatesOn(kinds: Gate["kind"][]): Gate[] {
  return kinds.map((kind) => ({ kind, detected: true, evidence: "test" }));
}

const base = (overrides: Record<string, unknown> = {}) => ({
  owner: "o",
  repo: "r",
  gates: [],
  externalPRMergeRate: null,
  medianFirstReviewHours: null,
  maintainerIssueResponseHours: null,
  openGoodFirstIssueCount: null,
  ...overrides,
});

describe("scoreFriction", () => {
  it("scores 100 for a clean repo with no gates or penalties", () => {
    const r = scoreFriction(base());
    assert.equal(r.score, 100);
  });

  it("applies gate weights (documented formula)", () => {
    const r = scoreFriction(base({ gates: gatesOn(["assignment_required", "dco_required"]) }));
    assert.equal(r.score, 100 - 25 - 5);
    assert.ok(r.reasons.some((x) => x.includes("-25")));
  });

  it("collaborators_only + vouch is harsh", () => {
    const r = scoreFriction(base({ gates: gatesOn(["collaborators_only", "vouch_required"]) }));
    assert.equal(r.score, 100 - 50 - 35);
  });

  it("clamps at 0 and 100", () => {
    const low = scoreFriction(base({ gates: gatesOn(["collaborators_only", "vouch_required", "assignment_required"]) }));
    assert.ok(low.score >= 0);
    const high = scoreFriction(base({ gates: [], externalPRMergeRate: 1, openGoodFirstIssueCount: 100 }));
    assert.ok(high.score <= 100);
  });

  it("rewards high external merge rates and punishes zero", () => {
    const good = scoreFriction(base({ externalPRMergeRate: 1 }));
    const bad = scoreFriction(base({ externalPRMergeRate: 0 }));
    assert.equal(good.score, 100); // 100 + 20 clamped
    assert.equal(bad.score, 80);
  });

  it("penalizes slow first reviews, capped", () => {
    const slow = scoreFriction(base({ medianFirstReviewHours: 24 * 30 }));
    assert.equal(slow.score, 100 - 14);
    const week = scoreFriction(base({ medianFirstReviewHours: 24 * 7 }));
    assert.equal(week.score, 100 - 7);
  });

  it("bonuses good-first-issue counts, capped at +10", () => {
    const r = scoreFriction(base({ openGoodFirstIssueCount: 50 }));
    assert.equal(r.score, 100); // 100 + 10 clamped
  });

  it("reproduces hand-verified index entries", () => {
    // FastMCP: assignment gate, nothing else computed -> 75
    const fastmcp = scoreFriction(base({ gates: gatesOn(["assignment_required"]) }));
    assert.equal(fastmcp.score, 75);
    // trigger.dev: vouch gate -> 65
    const trigger = scoreFriction(base({ gates: gatesOn(["vouch_required"]) }));
    assert.equal(trigger.score, 65);
    // squidbrake: comment-first claim ritual is a soft gate -> 95
    const squid = scoreFriction(base({ gates: gatesOn(["claim_first"]) }));
    assert.equal(squid.score, 95);
  });

  it("claim-first is a soft friction weight (-5, less than assignment)", () => {
    const soft = scoreFriction(base({ gates: gatesOn(["claim_first"]) }));
    const hard = scoreFriction(base({ gates: gatesOn(["assignment_required"]) }));
    assert.equal(soft.score, 95);
    assert.ok(soft.score > hard.score);
    assert.ok(soft.reasons.some((x) => x.includes("comment first before starting") && x.includes("-5")));
  });
});
