import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGates, hardGates, gateLabel } from "../src/gates.js";

describe("parseGates", () => {
  it("detects assignment requirement (FastMCP style)", () => {
    const gates = parseGates('Before submitting a PR, please ask to be assigned the issue. Issues must be assigned to you or carry a "prs welcome" label.');
    const g = gates.find((x) => x.kind === "assignment_required")!;
    assert.equal(g.detected, true);
    assert.ok(g.evidence.length > 0);
  });

  it("does not treat a bare 'prs welcome' label as an assignment gate", () => {
    const gates = parseGates('Issues must carry a "prs welcome" label for an outside PR to be considered.');
    assert.equal(gates.find((x) => x.kind === "assignment_required")!.detected, false);
  });

  it("detects claim-first ritual (pdfcn style), not assignment", () => {
    const gates = parseGates("Do not claim an issue silently. Comment before starting work, and check the thread first. All commits need a Signed-off-by line per the DCO.");
    assert.equal(gates.find((x) => x.kind === "claim_first")!.detected, true);
    assert.equal(gates.find((x) => x.kind === "assignment_required")!.detected, false);
    assert.equal(gates.find((x) => x.kind === "dco_required")!.detected, true);
  });

  it("detects claim-before-start phrasing", () => {
    const gates = parseGates("Please claim the issue before you start working on it.");
    assert.equal(gates.find((x) => x.kind === "claim_first")!.detected, true);
    assert.equal(gates.find((x) => x.kind === "assignment_required")!.detected, false);
  });

  it("detects vouch requirement (trigger.dev style)", () => {
    const gates = parseGates("We auto-close PRs from unvouched authors. Please file a vouch request first.");
    assert.equal(gates.find((x) => x.kind === "vouch_required")!.detected, true);
  });

  it("detects CLA, DCO, discussion-first", () => {
    const gates = parseGates("You must sign the Contributor License Agreement. All commits need a Signed-off-by line per the DCO. Please start a discussion before opening a PR.");
    assert.equal(gates.find((x) => x.kind === "cla_required")!.detected, true);
    assert.equal(gates.find((x) => x.kind === "dco_required")!.detected, true);
    assert.equal(gates.find((x) => x.kind === "discussion_first")!.detected, true);
  });

  it("detects collaborators_only from text and from policy flag", () => {
    const fromText = parseGates("This repo is collaborators only for PR creation.");
    assert.equal(fromText.find((x) => x.kind === "collaborators_only")!.detected, true);
    const fromFlag = parseGates(undefined, { collaboratorsOnlyPolicy: true });
    const g = fromFlag.find((x) => x.kind === "collaborators_only")!;
    assert.equal(g.detected, true);
    assert.ok(g.evidence.includes("repo policy"));
  });

  it("returns all gates with false when nothing matches", () => {
    const gates = parseGates("Thanks for contributing! Just open a PR.");
    assert.equal(gates.length, 7);
    assert.ok(gates.every((g) => !g.detected));
  });

  it("handles undefined contributing text", () => {
    const gates = parseGates(undefined);
    assert.ok(gates.every((g) => !g.detected));
  });
});

describe("hardGates", () => {
  it("returns only assignment, vouch, collaborators_only", () => {
    const gates = parseGates("Sign the CLA. Ask to be assigned first. Vouch needed for new authors.");
    const hard = hardGates(gates).map((g) => g.kind).sort();
    assert.deepEqual(hard, ["assignment_required", "vouch_required"]);
  });

  it("claim-first is a soft gate, never hard", () => {
    const gates = parseGates("Comment before starting work on the issue.");
    const hard = hardGates(gates).map((g) => g.kind);
    assert.ok(!hard.includes("claim_first"));
  });
});

describe("gateLabel", () => {
  it("labels every gate kind", () => {
    for (const g of parseGates("sign the CLA and DCO, discuss before PR, get assigned, get vouched, collaborators only, comment before starting work")) {
      assert.ok(gateLabel(g.kind).length > 0);
    }
    assert.equal(gateLabel("claim_first"), "comment first before starting");
  });
});
