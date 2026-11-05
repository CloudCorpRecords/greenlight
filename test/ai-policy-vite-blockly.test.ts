import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGates } from "../src/gates.js";
import { scoreIssue } from "../src/verdict.js";
import type { IssueSnapshot } from "../src/types.js";

/**
 * Field cases 2026-11-05 (v0.26.0): the two AI-policy misses Rene named.
 *
 * vitejs/vite PR #23808 was closed 2026-10-18 as bot/LLM-created.
 * Greenlight 0.25.0 check on vitejs/vite#23990 returned GATED only via
 * the behavioral pass: every policy gate read false and the live class
 * was "open", because no pattern matched Vite's CONTRIBUTING AI Policy
 * ("Never let an LLM speak for you"). Friction scored vite 93 with
 * zero policy gates detected.
 *
 * RaspberryPiFoundation/blockly PR #10629 was closed 2026-10-26: AI is
 * banned on good-first-issues and fully AI-written prose is banned on
 * any PR. Greenlight 0.25.0 check returned GO ("no blocking gates")
 * for blockly good-first-issue #4784 and GO for non-GFI #10453,
 * because it parsed blockly's AGENTS.md and extracted only the
 * disclosure line from a section that also says, in bold, "Do not
 * work on `good first issue`s" and "Do not write pull request
 * descriptions or GitHub comments."
 *
 * The policy excerpts below are verbatim from the repos (fetched
 * 2026-11-05 via the gh proxy).
 */

const VITE_AI_POLICY = `## AI Policy

We welcome the thoughtful use of AI tools when contributing to Vite, but ask all contributors to follow two core principles:

1. **Never let an LLM speak for you** - all comments, issues, and PR descriptions should be written in your own words, reflecting your own understanding.
2. **Never let an LLM think for you** - only submit contributions you fully understand and can explain.

If we find that these principles were not followed, we may close the issue or pull request directly.`;

const BLOCKLY_AGENTS_AI_POLICY = `## AI policy

Contributions to Blockly are governed by the AI policy. Read it before helping with anything that will become a pull request. What it means for you:

- **Do not write pull request descriptions or GitHub comments.** They must be written by the human contributor. You may translate text they have written, and you may review a draft they have written, but do not draft one or rewrite theirs wholesale.
- **Do not work on \`good first issue\`s.** If the task is an issue with that label, do not write code or PR text for it. Those issues exist so new contributors learn Blockly by solving them themselves. Explain this, and suggest they ask questions on the issue.
- **Remind the contributor to disclose AI use.** If you helped produce anything that will be submitted, tell them the PR description needs a sentence or two saying how, and to what extent, AI was used.`;

const BLOCKLY_MDX_AI_POLICY = `# AI Policy

## Human in the loop
PR summaries and GitHub comments should be written by a human unless you need AI translation support. AI tools often produce verbose summaries even for small changes, which makes them difficult to review.

## Good first issues
The purpose of solving a \`good first issue\` is to learn about Blockly and the workflows that we use. Therefore, AI should not be used to write code or PR summaries when solving a \`good first issue\`.

## AI disclosure
If AI tools were used to create content that is submitted as part of a PR, please disclose this in the PR summary.

## Enforcement
The Blockly team may close PRs that violate this policy or are otherwise too lengthy to review efficiently.`;

function gate(text: string, kind: string) {
  return parseGates(text).find((g) => g.kind === kind)!;
}

function snapshot(partial: Partial<IssueSnapshot>): IssueSnapshot {
  return {
    sourceUrl: "https://github.com/example/example/issues/1",
    owner: "example",
    repo: "example",
    number: 1,
    state: "open",
    title: "Example issue",
    author: "someone",
    assignees: [],
    labels: [],
    comments: [],
    linkedPRs: [],
    createdAt: "2026-11-01T10:00:00Z",
    updatedAt: "2026-11-04T10:00:00Z",
    ...partial,
  } as IssueSnapshot;
}

const NOW = new Date("2026-11-05T12:00:00Z");

describe("vite AI policy (field case vitejs/vite#23808)", () => {
  it("detects the human-written-prose rule", () => {
    const g = gate(VITE_AI_POLICY, "ai_prose_human");
    assert.equal(g.detected, true);
    assert.ok(g.evidence.length > 0);
  });

  it("does NOT read vite as agents_banned (AI tools are welcomed under the principles)", () => {
    assert.equal(gate(VITE_AI_POLICY, "agents_banned").detected, false);
    assert.equal(gate(VITE_AI_POLICY, "ai_label_scoped_ban").detected, false);
  });

  it("check on a vite issue is never a silent GO: RISKY with the prose rule quoted", () => {
    const result = scoreIssue(
      snapshot({
        sourceUrl: "https://github.com/vitejs/vite/issues/23990",
        owner: "vitejs",
        repo: "vite",
        number: 23990,
        contributing: VITE_AI_POLICY,
      }),
      NOW
    );
    assert.notEqual(result.verdict, "GO");
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("ai-prose-human"));
    assert.ok(result.reasons.some((r) => r.includes("human-written PR prose")));
  });
});

describe("blockly AI policy (field case RaspberryPiFoundation/blockly#10629)", () => {
  it("AGENTS.md summary: detects the label-scoped ban AND the prose rule AND disclosure", () => {
    assert.equal(gate(BLOCKLY_AGENTS_AI_POLICY, "ai_label_scoped_ban").detected, true);
    assert.equal(gate(BLOCKLY_AGENTS_AI_POLICY, "ai_prose_human").detected, true);
    assert.equal(gate(BLOCKLY_AGENTS_AI_POLICY, "agents_disclosure").detected, true);
  });

  it("docs ai_policy.mdx: detects the label-scoped ban AND the prose rule", () => {
    assert.equal(gate(BLOCKLY_MDX_AI_POLICY, "ai_label_scoped_ban").detected, true);
    assert.equal(gate(BLOCKLY_MDX_AI_POLICY, "ai_prose_human").detected, true);
  });

  it("a good-first-issue is GATED, not GO (the #10629 miss)", () => {
    const result = scoreIssue(
      snapshot({
        sourceUrl: "https://github.com/RaspberryPiFoundation/blockly/issues/4784",
        owner: "RaspberryPiFoundation",
        repo: "blockly",
        number: 4784,
        labels: ["help wanted", "good first issue"],
        houseRules: [{ file: "AGENTS.md", text: BLOCKLY_AGENTS_AI_POLICY }],
      }),
      NOW
    );
    assert.equal(result.verdict, "GATED", `reasons: ${result.reasons.join(" | ")}`);
    assert.ok(result.flags.includes("ai-label-scoped-ban"));
    assert.ok(result.reasons.some((r) => r.includes("bans AI on good-first-issue")));
  });

  it("a non-GFI issue is not gated by the ban, but never a silent GO: RISKY with both rules named", () => {
    const result = scoreIssue(
      snapshot({
        sourceUrl: "https://github.com/RaspberryPiFoundation/blockly/issues/10453",
        owner: "RaspberryPiFoundation",
        repo: "blockly",
        number: 10453,
        labels: ["help wanted"],
        houseRules: [{ file: "AGENTS.md", text: BLOCKLY_AGENTS_AI_POLICY }],
      }),
      NOW
    );
    assert.equal(result.verdict, "RISKY", `reasons: ${result.reasons.join(" | ")}`);
    assert.ok(result.flags.includes("ai-prose-human"));
    assert.ok(result.flags.includes("ai-label-scoped-ban"));
    assert.ok(result.reasons.some((r) => r.includes("does not carry that label")));
  });
});

describe("no false positives on ordinary policy prose", () => {
  it("a repo that merely welcomes AI tools with disclosure fires neither new gate", () => {
    const text =
      "We welcome contributions from everyone. If you use AI tools, please disclose AI use in your PR description. Good first issues are a great place to start.";
    assert.equal(gate(text, "ai_prose_human").detected, false);
    assert.equal(gate(text, "ai_label_scoped_ban").detected, false);
  });

  it("plain contributing text fires neither new gate", () => {
    const text =
      "Run the tests before opening a pull request. Sign the Contributor License Agreement. Comment before starting work on an issue.";
    assert.equal(gate(text, "ai_prose_human").detected, false);
    assert.equal(gate(text, "ai_label_scoped_ban").detected, false);
  });
});
