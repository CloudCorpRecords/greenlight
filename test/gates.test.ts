import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGates, parseGatesFromSources, parseGatefileJson, hardGates, gateLabel, detectWorkflowGates, detectStaleBotGate } from "../src/gates.js";

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

  it("returns all gates (now eleven) with false when nothing matches", () => {
    const gates = parseGates("Thanks for contributing! Just open a PR.");
    assert.equal(gates.length, 13); // 13 kinds since stale_bot
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

  it("returns all eleven kinds even when nothing matches", () => {
    const gates = parseGatesFromSources([{ file: "AGENTS.md", text: "Run the linter." }]);
    assert.equal(gates.length, 13); // 13 kinds since stale_bot
    assert.ok(gates.every((g) => g.detected === false));
  });
});

describe("paused and auto-closed outside PRs (field case 2026-10-15)", () => {
  const ACTIVEPIECES_TEXT =
    "We've temporarily paused unsolicited pull requests from outside the core team. " +
    "We are not accepting external contributions at this time due to the volume of AI-generated PRs.";

  it("detects unsolicited_prs_paused from activepieces-style contributing text", () => {
    const gates = parseGates(ACTIVEPIECES_TEXT);
    const g = gates.find((x) => x.kind === "unsolicited_prs_paused")!;
    assert.equal(g.detected, true);
    assert.ok(g.evidence.includes("paused"), `evidence: ${g.evidence}`);
  });

  it("paused unsolicited PRs are a hard gate with a label", () => {
    const gates = parseGates(ACTIVEPIECES_TEXT);
    assert.ok(hardGates(gates).some((g) => g.kind === "unsolicited_prs_paused"));
    assert.equal(gateLabel("unsolicited_prs_paused"), "unsolicited PRs paused");
  });

  it("detects external_prs_closed from prose about automatic closing", () => {
    const gates = parseGates(
      "Our automation automatically closes external pull requests that were not invited by a maintainer."
    );
    const g = gates.find((x) => x.kind === "external_prs_closed")!;
    assert.equal(g.detected, true);
    assert.equal(gateLabel("external_prs_closed"), "external PRs closed by automation");
    assert.ok(hardGates(gates).some((x) => x.kind === "external_prs_closed"));
  });

  it("detectWorkflowGates flags a suspiciously named workflow file", () => {
    const gates = detectWorkflowGates([
      { name: "close-external-prs.yml", content: "name: Close external PRs\non: pull_request_target\n" },
      { name: "ci.yml", content: "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n" },
    ]);
    assert.equal(gates.length, 1);
    assert.equal(gates[0].kind, "external_prs_closed");
    assert.equal(gates[0].detected, true);
    assert.ok(gates[0].evidence.includes("close-external-prs.yml"));
    assert.equal(gates[0].source, ".github/workflows/close-external-prs.yml");
  });

  it("detectWorkflowGates flags by content when the name is innocent", () => {
    const gates = detectWorkflowGates([
      {
        name: "cleanup.yml",
        content:
          "name: cleanup\non: pull_request_target\njobs:\n  auto-close:\n    runs-on: ubuntu-latest\n" +
          "    steps:\n      - run: gh pr close ${{ github.event.number }} # auto-close PRs from outside contributors\n",
      },
    ]);
    assert.equal(gates.length, 1);
    assert.equal(gates[0].kind, "external_prs_closed");
    assert.ok(gates[0].evidence.includes("cleanup.yml"));
  });

  it("detectWorkflowGates stays quiet on ordinary workflows", () => {
    const gates = detectWorkflowGates([
      { name: "ci.yml", content: "name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n" },
      { name: "publish.yml" },
    ]);
    assert.deepEqual(gates, []);
  });
});

describe("stale bot detection (closed-unmerged dataset case: tscircuit/circuit-to-svg#858)", () => {
  // The repo's real .github/workflows/stalebot.yml (fetched live
  // 2026-10-27, PR section verbatim): PRs go stale after 2 idle days
  // and are closed 1 day after the mark. PR #858 died exactly on this
  // clock with zero human reviews.
  const TSCIRCUIT_STALEBOT =
    "name: 'Close stale issues and PRs'\n" +
    "on:\n  schedule:\n    - cron: '30 1 * * *'\n" +
    "jobs:\n  stale:\n    runs-on: ubuntu-latest\n    steps:\n" +
    "      - uses: actions/stale@v9\n" +
    "        with:\n" +
    "          stale-pr-message: 'This PR has been automatically marked as stale because it has had no recent activity. It will be closed if no further activity occurs.'\n" +
    "          close-pr-message: 'This PR was closed because it has been inactive for 1 day since being marked as stale.'\n" +
    "          days-before-pr-stale: 2\n" +
    "          days-before-pr-close: 1\n" +
    "          exempt-pr-labels: 'pinned,security,help-wanted'\n" +
    "          stale-pr-label: 'no-pr-activity'\n";

  it("flags actions/stale with the parsed PR window", () => {
    const gates = detectWorkflowGates([{ name: "stalebot.yml", content: TSCIRCUIT_STALEBOT }]);
    assert.equal(gates.length, 1);
    const g = gates[0];
    assert.equal(g.kind, "stale_bot");
    assert.equal(g.detected, true);
    assert.equal(g.source, ".github/workflows/stalebot.yml");
    assert.ok(g.evidence.includes("stale after 2 idle days"), g.evidence);
    assert.ok(g.evidence.includes("closed 1 day after the mark"), g.evidence);
    assert.equal(gateLabel("stale_bot"), "stale bot auto-closes inactive PRs");
    // A lifecycle clock is a risk to price, never an intake block.
    assert.ok(!hardGates(gates).some((x) => x.kind === "stale_bot"));
  });

  it("falls back to the generic window, then to action defaults", () => {
    const generic = detectStaleBotGate([
      { name: "stale.yml", content: "steps:\n  - uses: actions/stale@v5\n    with:\n      days-before-stale: 30\n      days-before-close: 5\n" },
    ]);
    assert.ok(generic);
    assert.ok(generic.evidence.includes("stale after 30 idle days"), generic.evidence);
    assert.ok(generic.evidence.includes("closed 5 days after the mark"), generic.evidence);
    const defaults = detectStaleBotGate([
      { name: "stale.yml", content: "steps:\n  - uses: actions/stale@v9\n" },
    ]);
    assert.ok(defaults);
    assert.ok(defaults.evidence.includes("stale after 60 idle days"), defaults.evidence);
    assert.ok(defaults.evidence.includes("closed 7 days after the mark"), defaults.evidence);
  });

  it("stays quiet when the bot never auto-closes PRs (close window -1)", () => {
    const g = detectStaleBotGate([
      { name: "stale.yml", content: "steps:\n  - uses: actions/stale@v9\n    with:\n      days-before-pr-stale: 10\n      days-before-pr-close: -1\n" },
    ]);
    assert.equal(g, null);
  });

  it("stays quiet when 'stale' is only a word in an ordinary workflow", () => {
    const gates = detectWorkflowGates([
      { name: "ci.yml", content: "name: CI\njobs:\n  test:\n    steps:\n      - run: echo 'clearing stale cache'\n" },
    ]);
    assert.deepEqual(gates, []);
  });

  it("flags a stale-named workflow whose content is not fetchable, defaults disclosed", () => {
    const g = detectStaleBotGate([{ name: "stale.yml" }]);
    assert.ok(g);
    assert.equal(g.kind, "stale_bot");
    assert.ok(g.evidence.includes("defaults assumed"), g.evidence);
  });

  it("parseGates catches repos that document the bot in prose", () => {
    const gates = parseGates(
      "Inactive PRs are handled by our stale bot: a PR is marked as stale after 30 days and will be closed if no further activity occurs."
    );
    const g = gates.find((x) => x.kind === "stale_bot")!;
    assert.equal(g.detected, true);
    assert.ok(!hardGates(gates).some((x) => x.kind === "stale_bot"));
  });
});

describe("agent policy gates (v0.9.0)", () => {
  it("detects an agent ban in AGENTS.md style prose", () => {
    const text =
      "Contributions may only be submitted by a human who fully understands them and can explain them. " +
      "Contributions by autonomous agents are not allowed. " +
      "Do not draft or post PR titles, PR descriptions, issues, or discussion comments.";
    const gates = parseGatesFromSources([
      { file: "CONTRIBUTING.md", text: "# Contributing\nFork and PR." },
      { file: "AGENTS.md", text },
    ]);
    const g = gates.find((x) => x.kind === "agents_banned")!;
    assert.equal(g.detected, true);
    assert.equal(g.source, "AGENTS.md");
    assert.ok(g.evidence.length > 0);
    assert.ok(hardGates(gates).some((x) => x.kind === "agents_banned"));
    assert.equal(gateLabel("agents_banned"), "agent contributions banned");
    // The disclosure rule must not fire on a ban: the repo says nothing about disclosure.
    assert.equal(gates.find((x) => x.kind === "agents_disclosure")!.detected, false);
  });

  it("detects an AI disclosure requirement in actual's style", () => {
    const text =
      "AI Usage Policy: If you use AI assistance on a pull request, you must include an AI disclosure " +
      "sentence in the PR description, and prefix the PR title and your commits with [AI].";
    const gates = parseGatesFromSources([{ file: "AGENTS.md", text }]);
    const g = gates.find((x) => x.kind === "agents_disclosure")!;
    assert.equal(g.detected, true);
    assert.equal(g.source, "AGENTS.md");
    // A disclosure requirement is a flag, never a hard block.
    assert.ok(!hardGates(gates).some((x) => x.kind === "agents_disclosure"));
    assert.equal(gateLabel("agents_disclosure"), "AI disclosure required");
    assert.equal(gates.find((x) => x.kind === "agents_banned")!.detected, false);
  });

  it("stays byte-identical quiet when no agent policy exists", () => {
    const gates = parseGates("# Contributing\n\nFork, branch, and open a PR. Tests must pass.");
    assert.equal(gates.length, 13); // 13 kinds since stale_bot
    for (const g of gates) {
      assert.equal(g.detected, false, g.kind);
      assert.equal(g.evidence, "");
    }
  });
});

describe("gate pattern round 2 (v0.16.2 field cases)", () => {
  it("detects starship's detached-subject autonomous-agent prohibition", () => {
    const text =
      "## Low-Effort Contributions & Prohibition of Autonomous Agents\n" +
      "Contributions via OpenClaw, or any other unsupervised autonomous agent " +
      "operating in an automated loop, are strictly prohibited.";
    const gates = parseGatesFromSources([{ file: "AI_POLICY.md", text }]);
    const g = gates.find((x) => x.kind === "agents_banned")!;
    assert.equal(g.detected, true);
    assert.ok(hardGates(gates).some((x) => x.kind === "agents_banned"));
  });

  it("detects starship's ban alongside its disclosure requirement", () => {
    const text =
      "Every Pull Request that utilizes AI-assisted tooling must disclose its usage. " +
      "Contributions via OpenClaw, or any other unsupervised autonomous agent " +
      "operating in an automated loop, are strictly prohibited.";
    const gates = parseGatesFromSources([{ file: "AI_POLICY.md", text }]);
    assert.equal(gates.find((x) => x.kind === "agents_banned")!.detected, true);
    assert.equal(gates.find((x) => x.kind === "agents_disclosure")!.detected, true);
  });

  it("detects postiz's AI-generated-PR refusal and close-right prose", () => {
    const text =
      "To ensure the quality and maintainability of the codebase, we do not accept " +
      "Pull Requests generated primarily by AI tools, or that seem AI-generated. " +
      "We reserve the right to close any PR that appears to be AI-generated without further review.";
    const gates = parseGates(text);
    const g = gates.find((x) => x.kind === "agents_banned")!;
    assert.equal(g.detected, true);
    assert.ok(g.evidence.length > 0);
  });

  it("detects documenso's unreviewed-AI-code block as a scoped ban", () => {
    const text =
      "All AI-generated code must be thoroughly reviewed by the contributor before " +
      "submitting a PR. If we detect that contributors are simply throwing " +
      "AI-generated code over the wall without proper review, they will be blocked " +
      "from the repository.";
    const gates = parseGates(text);
    assert.equal(gates.find((x) => x.kind === "agents_banned")!.detected, true);
  });

  it("does not fire the ban on a plain review mandate without enforcement", () => {
    const gates = parseGates(
      "All AI-generated code must be thoroughly reviewed by the contributor before submitting a PR."
    );
    assert.equal(gates.find((x) => x.kind === "agents_banned")!.detected, false);
  });

  it("does not fire 'strictly prohibited' without an agent-ish subject", () => {
    const gates = parseGates(
      "Spam, harassment, and plagiarism are strictly prohibited. We welcome AI-assisted contributions."
    );
    assert.equal(gates.find((x) => x.kind === "agents_banned")!.detected, false);
  });

  it("does not fire the close-right pattern on stale-issue cleanup", () => {
    const gates = parseGates(
      "We reserve the right to close stale issues that have had no activity for 90 days."
    );
    assert.equal(gates.find((x) => x.kind === "agents_banned")!.detected, false);
  });

  it("does not fire on formbricks' agent-session-link rule (rows 48-49)", () => {
    const gates = parseGates(
      "Never put an agent session link in a PR description, PR or review comment, " +
      "commit message, or anything the maintainer sees."
    );
    assert.equal(gates.find((x) => x.kind === "agents_banned")!.detected, false);
  });

  it("does not fire on medusa's policy with no AI clause (rows 48-49)", () => {
    const gates = parseGates(
      "# Contributing\n\nFork, branch, and open a PR. Add a changeset for every " +
      "user-facing change. Generate a changeset with the CLI before opening the PR."
    );
    assert.equal(gates.find((x) => x.kind === "agents_banned")!.detected, false);
  });
});

describe("scoped intake pause (v0.17.0)", () => {
  it("detects prettier's scoped pause and demotes the blanket pause", () => {
    const gates = parseGatesFromSources([
      { file: "CONTRIBUTING.md", text: "We are not accepting pull requests that add new formatting options." },
    ]);
    const scoped = gates.find((g) => g.kind === "scoped_prs_paused")!;
    const blanket = gates.find((g) => g.kind === "unsolicited_prs_paused")!;
    assert.equal(scoped.detected, true);
    assert.equal(gateLabel("scoped_prs_paused"), "scoped PR pause (only some PR kinds refused)");
    assert.equal(blanket.detected, false);
    assert.ok(!hardGates(gates).some((g) => g.kind === "unsolicited_prs_paused"));
  });

  it("detects a blanket pause (streamlit shape) without the scoped kind", () => {
    const gates = parseGatesFromSources([
      { file: "CONTRIBUTING.md", text: "We've temporarily paused unsolicited pull requests from outside the core team until further notice." },
    ]);
    assert.equal(gates.find((g) => g.kind === "unsolicited_prs_paused")!.detected, true);
    assert.equal(gates.find((g) => g.kind === "scoped_prs_paused")!.detected, false);
  });

  it("keeps both kinds when a file has a blanket and a scoped sentence", () => {
    const gates = parseGatesFromSources([
      {
        file: "CONTRIBUTING.md",
        text: "Unsolicited pull requests are paused for now. Also, we are not accepting new features this quarter.",
      },
    ]);
    assert.equal(gates.find((g) => g.kind === "unsolicited_prs_paused")!.detected, true);
    assert.equal(gates.find((g) => g.kind === "scoped_prs_paused")!.detected, true);
  });

  it("does not fire either pause on a welcoming guide", () => {
    const gates = parseGatesFromSources([
      { file: "CONTRIBUTING.md", text: "We welcome all pull requests; new features included. Please read the style guide first." },
    ]);
    assert.equal(gates.find((g) => g.kind === "unsolicited_prs_paused")!.detected, false);
    assert.equal(gates.find((g) => g.kind === "scoped_prs_paused")!.detected, false);
  });
});

describe("agent ban shapes from the 2026-10-29 index drift audit (v0.24.0)", () => {
  it("detects the gleam shape: plain 'do not accept contributions from AI agents'", () => {
    const gates = parseGates(
      "We do not accept contributions from AI agents. Bug reports, pull request descriptions, and comments must be written by a human, not by AI."
    );
    assert.equal(gates.find((g) => g.kind === "agents_banned")!.detected, true);
  });

  it("detects gleam variants: contributions from AI agents are not accepted; AI agents not welcome", () => {
    const a = parseGates("Contributions from AI agents are not accepted.");
    assert.equal(a.find((g) => g.kind === "agents_banned")!.detected, true);
    const b = parseGates("Please note: AI agents are not welcome in this repository.");
    assert.equal(b.find((g) => g.kind === "agents_banned")!.detected, true);
    const c = parseGates("We don't accept pull requests from LLM agents.");
    assert.equal(c.find((g) => g.kind === "agents_banned")!.detected, true);
  });

  it("detects the beets AI_POLICY shape: review-only agents, no agent PR creation, no AI good-first work", () => {
    const gates = parseGates(
      "Agents may only do code review. Agent PR creation is not permitted. AI is not for good-first-contribution issues; pick those up as a human."
    );
    assert.equal(gates.find((g) => g.kind === "agents_banned")!.detected, true);
  });

  it("does not fire agents_banned on a bug-report-scoped AI ban (PostHog shape)", () => {
    const gates = parseGates(
      "AI-generated bug reports will be closed without review. We cannot triage generated issues. For code, fork the repo and send a pull request."
    );
    assert.equal(gates.find((g) => g.kind === "agents_banned")!.detected, false);
  });

  it("does not fire the new shapes on ordinary AI discussion", () => {
    const gates = parseGates(
      "This project uses AI agents in its CI pipeline. Contributions from everyone are welcome; see the style guide."
    );
    assert.equal(gates.find((g) => g.kind === "agents_banned")!.detected, false);
  });
});
