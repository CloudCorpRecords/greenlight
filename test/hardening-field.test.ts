/**
 * Hardening batch 1 (v0.21.0): adversarial field regressions that were not
 * already pinned elsewhere. Each case names the field failure it models.
 * Cases already pinned before this batch (named in the v0.21.0 manifest):
 * pdfcn bare-mention (linkstrength.test.ts, cases.test.ts, verdict.test.ts),
 * radar phantoms oauth2/500/patch-N/bot-task-counter (radar.test.ts),
 * Bruno xray TAKEN set (xray.test.ts), spotDL behavioral gate
 * (behavior.test.ts), babysit transient bucket (babysit.test.ts),
 * action_required honesty (ci-triage.test.ts, babysit.test.ts) and the
 * actual 422 preflight NO-GO (preflight.test.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGates } from "../src/gates.js";
import { classifyCiTriage, type HeadCheck } from "../src/ci-triage.js";

describe("hardening: transformers assignment-gate false positive", () => {
  // Field case: huggingface/transformers was classified assignment-gated.
  // Its contributing docs carry an issue-template URL whose query string
  // contains "assignees="; parseGates collapsed the document to one line,
  // so /assign.*before (submitting|opening)/ spanned from the URL parameter
  // to an unrelated "Before submitting a PR" later in the doc. A URL query
  // parameter is not an assignment gate.
  const templateDoc = [
    "# Contributing",
    "",
    "To report a problem, please use [the bug template](https://github.com/huggingface/transformers/issues/new?assignees=&labels=bug&template=bug_report.md) when filing.",
    "",
    "Before submitting a PR, run the test suite and check the style guide.",
  ].join("\n");

  it("an assignees= template URL is not an assignment gate", () => {
    const gates = parseGates(templateDoc);
    const assignment = gates.find((g) => g.kind === "assignment_required");
    assert.ok(assignment, "assignment gate entry exists");
    assert.equal(assignment.detected, false, `evidence was: ${assignment.evidence}`);
  });

  it("a bare assignees= token without a scheme is not an assignment gate either", () => {
    const doc = "File bugs at github.com/acme/widgets/issues/new?assignees=&labels=bug before submitting a PR, thanks.";
    const gates = parseGates(doc);
    assert.equal(gates.find((g) => g.kind === "assignment_required")?.detected, false);
  });

  it("genuine assignment prose still fires after URL stripping", () => {
    const doc = [
      "# Contributing",
      "",
      "Please ask to be assigned on the issue before opening a PR.",
      "File bugs at https://github.com/acme/widgets/issues/new?assignees=&labels=bug if you find one.",
    ].join("\n");
    const gates = parseGates(doc);
    assert.equal(gates.find((g) => g.kind === "assignment_required")?.detected, true);
  });

  it("URL stripping does not eat prose gates elsewhere in the doc", () => {
    const doc = [
      "Sign the contributor license agreement before we can merge.",
      "See https://example.com/cla for the form.",
    ].join("\n");
    const gates = parseGates(doc);
    assert.equal(gates.find((g) => g.kind === "cla_required")?.detected, true);
  });
});

describe("hardening: fork-PR honesty (action_required suites)", () => {
  // Dogfood lesson (v0.20.x): a fork PR whose whole suite sits in
  // action_required is waiting on a maintainer, full stop. Triage must
  // report warnings/indeterminate, never a code failure of ours and never
  // anything that reads as fixed or passing.
  const check = (name: string, conclusion: string): HeadCheck => ({ name, conclusion });

  it("a full action_required suite yields no likely-yours and no yours verdict", () => {
    const result = classifyCiTriage({
      prUrl: "https://github.com/acme/widgets/pull/42",
      prTitle: "fix: something",
      baseRef: "main",
      baseSha: "base000",
      headSha: "head111",
      headChecks: [
        check("build", "action_required"),
        check("test (20)", "action_required"),
        check("lint", "action_required"),
      ],
      baseRecords: [],
      changedFiles: [".github/workflows/ci.yml", "src/index.ts"],
    });
    assert.deepEqual(
      result.checks.map((c) => c.class),
      ["external-blocker", "external-blocker", "external-blocker"]
    );
    // The verdict may say there are no CODE failures (there are none);
    // it must never say the suite passed, never blame the PR, and never
    // read as indeterminate-but-probably-fine.
    assert.equal(result.verdict, "NO CODE FAILURES");
    assert.notEqual(result.verdict, "HAS LIKELY-YOURS");
    assert.notEqual(result.verdict, "NO FAILURES");
    assert.ok(result.checks.every((c) => c.evidence.includes("action_required")));
  });

  it("mixed action_required plus a genuinely passing check still claims nothing about failures", () => {
    const result = classifyCiTriage({
      prUrl: "https://github.com/acme/widgets/pull/43",
      prTitle: "fix: something else",
      baseRef: "main",
      baseSha: "base000",
      headSha: "head111",
      headChecks: [check("build", "action_required")],
      baseRecords: [],
      changedFiles: ["src/index.ts"],
    });
    assert.equal(result.checks[0].class, "external-blocker");
    assert.ok(result.checks[0].evidence.includes("waiting on maintainer approval"));
  });
});
