import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGates, parseGatesFromSources, parseGatefileJson, hardGates, gateLabel } from "../src/gates.js";

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

  it("detects maintainer-only PR shops in their own workflow language", () => {
    // The two field phrasings from 2026-10-15 (MCP inspector AGENTS.md, MCP
    // servers CONTRIBUTING.md). Both repos take issues and prompts, not
    // outside PRs, and both scored GO before these patterns existed.
    const inspector = parseGates(
      "Pull requests against this repo are opened by the **repo maintainers** only. Anyone else opens a detailed issue instead.",
    );
    assert.equal(inspector.find((x) => x.kind === "collaborators_only")!.detected, true);
    const servers = parseGates(
      "**We accept issues, not pull requests.** Design and implementation are done by the repository maintainers.",
    );
    assert.equal(servers.find((x) => x.kind === "collaborators_only")!.detected, true);
  });

  it("parses a gatefile contribution-gates.json into Greenlight gates", () => {
    const doc = JSON.stringify({
      version: 1,
      repo: "acme/widgets",
      generatedFrom: ["CONTRIBUTING.md"],
      gates: [
        { id: "no_direct_prs", kind: "no_direct_prs", severity: "block", evidence: "Maintainers open all PRs", source: "CONTRIBUTING.md" },
        { id: "discuss_first", kind: "discuss_first", severity: "warn", evidence: "Open a discussion first", source: "CONTRIBUTING.md" },
        { id: "dco_required", kind: "dco_required", severity: "warn", evidence: "Sign off commits", source: "CONTRIBUTING.md" },
        { id: "future_kind", kind: "some_future_kind", severity: "warn", evidence: "?", source: "CONTRIBUTING.md" },
      ],
      conventions: {},
    });
    const gates = parseGatefileJson(doc);
    assert.deepEqual(gates.map((g) => g.kind).sort(), ["collaborators_only", "dco_required", "discussion_first"]);
    assert.ok(gates.every((g) => g.detected));
    assert.ok(gates.find((g) => g.kind === "collaborators_only")!.evidence.startsWith("gatefile:"));
  });

  it("rejects a document that is not a gates file", () => {
    assert.throws(() => parseGatefileJson('{"hello": true}'), /not a contribution-gates\.json/);
    assert.throws(() => parseGatefileJson("not json"));
  });

  it("does not fire collaborators_only on ordinary maintainer language", () => {
    const gates = parseGates(
      "Only maintainers can merge pull requests and apply the release label. Contributors should open pull requests against the dev branch.",
    );
    assert.equal(gates.find((x) => x.kind === "collaborators_only")!.detected, false);
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

describe("parseGatesFromSources", () => {
  it("finds gates in AGENTS.md when CONTRIBUTING is silent (reticle style)", () => {
    const gates = parseGatesFromSources([
      {
        file: "AGENTS.md",
        text: "Claim the issue before you start, with a comment. Every commit needs a Signed-off-by line (DCO). Add one file to .changes/ for a user-facing change. Run `pnpm verify` as one command.",
      },
    ]);
    const claim = gates.find((x) => x.kind === "claim_first")!;
    const dco = gates.find((x) => x.kind === "dco_required")!;
    assert.equal(claim.detected, true);
    assert.equal(claim.source, "AGENTS.md");
    assert.equal(dco.detected, true);
    assert.equal(dco.source, "AGENTS.md");
    assert.equal(gates.find((x) => x.kind === "assignment_required")!.detected, false);
  });

  it("merges without duplicating kinds, preferring CONTRIBUTING evidence on ties", () => {
    const gates = parseGatesFromSources([
      {
        file: "CONTRIBUTING.md",
        text: "Comment before starting work on an issue to claim it.",
      },
      {
        file: "AGENTS.md",
        text: "Before you start, claim the issue with a comment in the thread.",
      },
    ]);
    const claim = gates.filter((x) => x.kind === "claim_first");
    assert.equal(claim.length, 1, "exactly one gate entry per kind");
    assert.equal(claim[0].detected, true);
    assert.equal(claim[0].source, "CONTRIBUTING.md");
  });

  it("reads CLAUDE.md as well", () => {
    const gates = parseGatesFromSources([
      { file: "CLAUDE.md", text: "All outside contributors need a vouch from a community member." },
    ]);
    assert.equal(gates.find((x) => x.kind === "vouch_required")!.detected, true);
    assert.equal(gates.find((x) => x.kind === "vouch_required")!.source, "CLAUDE.md");
  });

  it("returns all seven kinds even when nothing matches", () => {
    const gates = parseGatesFromSources([{ file: "AGENTS.md", text: "Run the linter." }]);
    assert.equal(gates.length, 7);
    assert.ok(gates.every((g) => g.detected === false));
  });
});
