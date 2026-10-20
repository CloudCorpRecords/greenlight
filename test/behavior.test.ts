/**
 * Behavioral gate detection (v0.16.0).
 *
 * Fixtures model the 2026-10-19 spotDL field case: spotDL/spotify-
 * downloader carries no agent policy, yet its maintainer closed three
 * PRs on issue #2371 unmerged, with PR #2494 closed on an "AI slop"
 * comment. The negative fixtures pin the conservative matcher:
 * welcoming language and neutral AI mentions must never fire, and a
 * single weak signal stays below the detection threshold by design.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  matchAiRejection,
  detectBehavioralGateFromData,
  partitionByRecency,
  BEHAVIORAL_RECENCY_MONTHS,
  type BehavioralClosedPR,
  type BehavioralMaintainerComment,
} from "../src/behavior.js";
import { scoreFriction } from "../src/friction.js";

const pr = (number: number, author: string): BehavioralClosedPR => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  author,
  closedAt: "2026-09-01T00:00:00Z",
});

const comment = (
  prNumber: number,
  author: string,
  body: string,
  association = "OWNER"
): BehavioralMaintainerComment => ({
  pr: prNumber,
  author,
  association,
  body,
  url: `https://github.com/o/r/pull/${prNumber}#issuecomment-1`,
});

const baseSignals = {
  owner: "o",
  repo: "r",
  gates: [],
  externalPRMergeRate: null,
  medianFirstReviewHours: null,
  maintainerIssueResponseHours: null,
  openGoodFirstIssueCount: null,
  behavioralGate: null,
};

describe("matchAiRejection", () => {
  it("fires on the spotDL pattern", () => {
    const r = matchAiRejection("This is AI slop. Closing.");
    assert.equal(r.matched, true);
    assert.equal(r.strong, true);
  });

  it("fires on AI term plus rejection language", () => {
    assert.equal(
      matchAiRejection("We do not accept AI-generated PRs in this repo.").matched,
      true
    );
    assert.equal(
      matchAiRejection("Closing: this looks like a low-effort LLM submission.").matched,
      true
    );
  });

  it("never fires on welcoming language", () => {
    assert.equal(
      matchAiRejection("AI-assisted PRs are welcome here, thanks for contributing!").matched,
      false
    );
    assert.equal(
      matchAiRejection("We welcome AI-assisted contributions.").matched,
      false
    );
  });

  it("does not fire on neutral AI mentions without rejection", () => {
    assert.equal(
      matchAiRejection("I used ChatGPT to help debug the error in the test.").matched,
      false
    );
    assert.equal(
      matchAiRejection("This is a discussion about whether to add Copilot to the dev container.").matched,
      false
    );
  });

  it("does not fire on plain closes without AI attribution", () => {
    assert.equal(
      matchAiRejection("Closing: this does not fit the roadmap.").matched,
      false
    );
  });
});

describe("detectBehavioralGateFromData", () => {
  it("detects the spotDL shape: two independent PRs with maintainer AI-rejection comments", () => {
    const prs = [pr(2494, "contrib1"), pr(2480, "contrib2")];
    const comments = [
      comment(2494, "maintainer", "This is AI slop. Closing."),
      comment(2480, "maintainer", "We do not accept AI-generated PRs here.", "MEMBER"),
    ];
    const gate = detectBehavioralGateFromData(prs, comments);
    assert.equal(gate.detected, true);
    assert.equal(gate.strength, 2);
    assert.equal(gate.threshold, 2);
    assert.equal(gate.evidence.length, 2);
    assert.ok(gate.evidence.some((e) => e.pr === 2494));
    assert.ok(gate.evidence.every((e) => e.url.includes("github.com/o/r/pull/")));
  });

  it("stays quiet on a welcoming repo", () => {
    const gate = detectBehavioralGateFromData(
      [pr(10, "contrib")],
      [comment(10, "maintainer", "AI-assisted PRs are welcome here, thanks!")]
    );
    assert.equal(gate.detected, false);
    assert.equal(gate.strength, 0);
    assert.equal(gate.evidence.length, 0);
  });

  it("ignores non-maintainer comments even with AI-rejection words", () => {
    const gate = detectBehavioralGateFromData(
      [pr(10, "contrib1"), pr(11, "contrib2")],
      [
        comment(10, "random", "This is AI slop. Closing.", "NONE"),
        comment(11, "random2", "We do not accept AI-generated PRs.", "CONTRIBUTOR"),
      ]
    );
    assert.equal(gate.detected, false);
    assert.equal(gate.strength, 0);
  });

  it("ignores a maintainer closing their own PR", () => {
    const gate = detectBehavioralGateFromData(
      [pr(10, "maintainer")],
      [comment(10, "maintainer", "This is AI slop. Closing my own PR.")]
    );
    assert.equal(gate.detected, false);
    assert.equal(gate.strength, 0);
  });

  it("ignores comments on PRs that are not closed-unmerged", () => {
    const gate = detectBehavioralGateFromData(
      [pr(10, "contrib")],
      [comment(99, "maintainer", "This is AI slop. Closing.")]
    );
    assert.equal(gate.detected, false);
    assert.equal(gate.evidence.length, 0);
  });

  it("a single weak signal stays below the threshold by design", () => {
    const gate = detectBehavioralGateFromData(
      [pr(10, "contrib")],
      [comment(10, "maintainer", "Closing; this looks AI-generated and we cannot verify it.")]
    );
    assert.equal(gate.detected, false);
    assert.equal(gate.strength, 1);
    assert.equal(gate.evidence.length, 1);
    assert.ok(gate.note.includes("threshold"));
  });

  it("a single explicit rejection phrase detects on its own", () => {
    const gate = detectBehavioralGateFromData(
      [pr(10, "contrib")],
      [comment(10, "maintainer", "This is AI slop. Closing.")]
    );
    assert.equal(gate.detected, true);
    assert.equal(gate.strength, 1);
    assert.equal(gate.evidence[0].strong, true);
  });

  it("an invoked AI policy on closure counts as a strong signal", () => {
    const gate = detectBehavioralGateFromData(
      [pr(10, "contrib")],
      [comment(10, "maintainer", "Closing under our AI policy.")]
    );
    assert.equal(gate.detected, true);
    assert.equal(gate.evidence[0].strong, true);
  });

  it("truncates long quotes", () => {
    const long = "AI slop. Closing. " + "x".repeat(500);
    const gate = detectBehavioralGateFromData(
      [pr(10, "c1"), pr(11, "c2")],
      [comment(10, "maintainer", long), comment(11, "maintainer", long)]
    );
    assert.ok(gate.evidence[0].quote.length <= 240);
  });
});

describe("friction behavioral penalty", () => {
  it("applies -20 with a reason when a behavioral gate is detected", () => {
    const gate = detectBehavioralGateFromData(
      [pr(1, "a"), pr(2, "b")],
      [
        comment(1, "maintainer", "AI slop. Closing."),
        comment(2, "maintainer", "We do not accept AI-generated PRs."),
      ]
    );
    assert.equal(gate.detected, true);
    const r = scoreFriction({ ...baseSignals, behavioralGate: gate });
    assert.equal(r.score, 80);
    assert.ok(r.reasons.some((x) => x.includes("behavioral gate")));
    assert.ok(r.reasons.some((x) => x.includes("-20")));
  });

  it("changes nothing when the pass was skipped or found nothing", () => {
    const r = scoreFriction(baseSignals);
    assert.equal(r.score, 100);
  });
});

describe("v0.17.1 behavioral recency bound (item 18)", () => {
  const NOW = Date.parse("2026-10-19T00:00:00Z");
  const oldPr = (number: number): BehavioralClosedPR => ({
    number,
    url: `https://github.com/o/r/pull/${number}`,
    author: "a",
    closedAt: "2024-06-01T00:00:00Z",
  });
  const freshPr = (number: number): BehavioralClosedPR => ({
    number,
    url: `https://github.com/o/r/pull/${number}`,
    author: "a",
    closedAt: "2026-10-01T00:00:00Z",
  });

  it("excludes closures older than the 12-month bound", () => {
    assert.equal(BEHAVIORAL_RECENCY_MONTHS, 12);
    const r = partitionByRecency([freshPr(1), oldPr(2), oldPr(3)], NOW);
    assert.deepEqual(
      r.fresh.map((p) => p.number),
      [1]
    );
    assert.equal(r.staleCount, 2);
    assert.equal(r.newestClosedAt, "2026-10-01T00:00:00Z");
  });

  it("keeps PRs with an unparseable closedAt (missing data never discards evidence)", () => {
    const weird: BehavioralClosedPR = {
      number: 9,
      url: "u",
      author: "a",
      closedAt: "",
    };
    const r = partitionByRecency([weird], NOW);
    assert.equal(r.fresh.length, 1);
    assert.equal(r.staleCount, 0);
  });

  it("reports the newest closure so callers can flag stale-signal repos", () => {
    const r = partitionByRecency([oldPr(2), oldPr(3)], NOW);
    assert.equal(r.fresh.length, 0);
    assert.equal(r.staleCount, 2);
    assert.equal(r.newestClosedAt, "2024-06-01T00:00:00Z");
  });
});

describe("v0.18.0 behavioral evidence from reviews and review comments (item 5)", () => {
  const rev = (
    prNumber: number,
    author: string,
    body: string,
    source: "review" | "review_comment" = "review"
  ): BehavioralMaintainerComment => ({
    pr: prNumber,
    author,
    association: "OWNER",
    body,
    url: `https://github.com/o/r/pull/${prNumber}#review-1`,
    source,
  });

  it("a maintainer review carrying an explicit rejection phrase fires, with its source on the evidence", () => {
    const gate = detectBehavioralGateFromData(
      [pr(1, "outsider"), pr(2, "outsider")],
      [
        rev(1, "maintainer", "AI slop. Closing this."),
        rev(2, "maintainer", "This looks AI-generated. We do not accept those here.", "review_comment"),
      ]
    );
    assert.equal(gate.detected, true);
    assert.equal(gate.strength, 2);
    assert.ok(gate.evidence.some((e) => e.source === "review"), "review evidence labeled");
    assert.ok(gate.evidence.some((e) => e.source === "review_comment"), "review comment evidence labeled");
  });

  it("an empty review body is meaningless on its own but never fabricates a signal", () => {
    // Empty bodies are skipped by the live fetcher; the pure core only
    // sees texts, so assert the matcher never fires on whitespace.
    const gate = detectBehavioralGateFromData(
      [pr(1, "outsider")],
      [{ pr: 1, author: "maintainer", association: "OWNER", body: "  ", url: "u", source: "review" }]
    );
    assert.equal(gate.strength, 0);
    assert.equal(gate.detected, false);
  });
});
