import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreFriction, attachBehavioralGate } from "../src/friction.js";
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

describe("v0.9.3 outsider share unit contract", () => {
  it("attachOutsiderShare emits the fraction and the 0-100 percent side by side", async () => {
    const { attachOutsiderShare } = await import("../src/friction.js");
    const report = scoreFriction(base());
    report.mergeVelocity = { mergedPRs: 28, externalShare: 0.71, medianMergeDays: 2.1 };
    attachOutsiderShare(report);
    assert.equal(report.outsider_merge_share, 0.71);
    assert.equal(report.outsider_merge_share_pct, 71);
  });

  it("prefers signals.externalPRMergeRate when both are present", async () => {
    const { attachOutsiderShare } = await import("../src/friction.js");
    const report = scoreFriction(base({ externalPRMergeRate: 0.5 }));
    report.mergeVelocity = { mergedPRs: 28, externalShare: 0.9, medianMergeDays: 2.1 };
    attachOutsiderShare(report);
    assert.equal(report.outsider_merge_share, 0.5);
    assert.equal(report.outsider_merge_share_pct, 50);
  });

  it("leaves both null when the share is uncomputable", async () => {
    const { attachOutsiderShare } = await import("../src/friction.js");
    const report = scoreFriction(base());
    attachOutsiderShare(report);
    assert.equal(report.outsider_merge_share, null);
    assert.equal(report.outsider_merge_share_pct, null);
  });
});

describe("scoped intake pause (v0.17.0)", () => {
  it("a scoped pause costs half the blanket pause", () => {
    const scoped = scoreFriction(base({ gates: gatesOn(["scoped_prs_paused"]) }));
    const blanket = scoreFriction(base({ gates: gatesOn(["unsolicited_prs_paused"]) }));
    assert.equal(scoped.score, 100 - 20);
    assert.equal(blanket.score, 100 - 40);
    assert.ok(scoped.reasons.some((x) => x.includes("-20")));
  });
});

describe("v0.17.1 canonical behavioral_gate location (item 12)", () => {
  it("top-level behavioral_gate is canonical; signals.behavioralGate is an identical mirror", () => {
    const gate = {
      detected: true,
      strength: 2,
      threshold: 2,
      evidence: [],
      notes: [],
      note: "maintainer rejects AI-built PRs in practice",
    };
    const report = attachBehavioralGate(scoreFriction(base()), gate);
    assert.equal(report.behavioral_gate, gate, "canonical top-level field is set");
    assert.equal(
      report.signals.behavioralGate,
      gate,
      "the documented mirror carries the same value"
    );
    assert.deepEqual(
      report.behavioral_gate,
      report.signals.behavioralGate,
      "the two locations never disagree"
    );
  });

  it("null gates stay null in both locations", () => {
    const report = attachBehavioralGate(scoreFriction(base()), null);
    assert.equal(report.behavioral_gate, null);
    assert.equal(report.signals.behavioralGate, null);
  });
});

describe("v0.18.0 external merge-rate score term (item 11)", () => {
  const gated = () => gatesOn(["collaborators_only"]);

  it("a high outsider merge rate scores above an identical zero-outsider repo", () => {
    const high = scoreFriction(base({ gates: gated(), externalPRMergeRate: 0.9 }));
    const low = scoreFriction(base({ gates: gated(), externalPRMergeRate: 0.0 }));
    assert.equal(high.score, 50 + (0.9 - 0.5) * 40, "100 - 50 + 16");
    assert.equal(low.score, 50 + (0.0 - 0.5) * 40, "100 - 50 - 20");
    assert.ok(high.score > low.score);
  });

  it("the term is exposed in the JSON with its percent sibling", () => {
    const r = scoreFriction(base({ externalPRMergeRate: 0.75 }));
    assert.equal(r.signals.externalPRMergeRate, 0.75);
    assert.equal(r.signals.externalPRMergeRate_pct, 75);
    assert.ok(
      r.reasons.some((x) => x.includes("external PR merge rate 75%") && x.includes("+10.0")),
      "the reason quotes the term contribution"
    );
  });

  it("null rate keeps the old neutral behavior", () => {
    const r = scoreFriction(base());
    assert.equal(r.score, 100);
    assert.ok(!r.reasons.some((x) => x.includes("external PR merge rate")));
  });
});
