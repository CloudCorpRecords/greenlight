import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerifiedComment,
  suggestsVerifiedComment,
  verifiedCommentSuggestion,
  parseNoteFile,
} from "../src/verify-comment.js";
import { parseGates } from "../src/gates.js";

const ISSUE = "https://github.com/modelcontextprotocol/inspector/issues/2723";

describe("buildVerifiedComment", () => {
  it("renders all sections with real content", () => {
    const { markdown, gaps } = buildVerifiedComment(
      ISSUE,
      {
        claim: "TUI tests append to the developer's real ~/.mcp-inspector/auth.log",
        environment: "modelcontextprotocol/inspector @ 3a4b5c6, 2026-10-15, macOS",
        reproduction: ["point HOME at a scratch dir", "run vitest run __tests__/App.test.tsx"],
        observed: "155 lines appear in the scratch HOME's auth.log",
        expected: "test runs leave the developer's home directory untouched",
        rootCause: "clients/tui/__tests__/setup.ts does not isolate the log dir",
        fixSketch: "per-test-file temp dir via fs.mkdtempSync, set MCP_INSPECTOR_LOG_DIR, remove on exit",
        ran: "vitest run __tests__/App.test.tsx: 130 passed",
        verifiedBy: "@CloudCorpRecords",
      },
      "0.5.0"
    );
    for (const h of [
      "## Claim of the problem",
      "## Environment",
      "## Reproduction",
      "## Observed vs expected",
      "## Root cause",
      "## Proposed fix",
      "## Verification",
    ]) {
      assert.ok(markdown.includes(h), `missing section ${h}`);
    }
    assert.ok(markdown.includes("1. point HOME at a scratch dir"));
    assert.ok(markdown.includes("2. run vitest run __tests__/App.test.tsx"));
    assert.ok(markdown.includes(ISSUE));
    assert.ok(markdown.includes("Greenlight v0.5.0"));
    assert.ok(markdown.includes("nothing here was posted automatically"));
    assert.deepEqual(gaps, []);
  });

  it("renders explicit gaps instead of inventing filler", () => {
    const { markdown, gaps } = buildVerifiedComment(ISSUE, { claim: "something is wrong" }, "0.5.0");
    assert.ok(markdown.includes("Repro: not yet run"));
    assert.ok(markdown.includes("not yet isolated"));
    assert.ok(markdown.includes("not sketched yet"));
    assert.ok(markdown.includes("not recorded"));
    assert.deepEqual(
      [...gaps].sort(),
      ["environment", "fix-sketch", "observed/expected", "reproduction", "root-cause", "verification"].sort()
    );
    // No plausible-looking content may appear for unfilled sections.
    assert.ok(!markdown.includes("vitest"));
    assert.ok(!markdown.includes("auth.log"));
  });

  it("carries the marker comment", () => {
    const { markdown } = buildVerifiedComment(ISSUE, {}, "0.5.0");
    assert.ok(markdown.includes("<!-- greenlight-verified-comment v1 -->"));
  });
});

describe("suggestsVerifiedComment", () => {
  it("fires for the inspector's maintainer-only policy text", () => {
    const gates = parseGates("Pull requests against this repo are opened by the repo maintainers only");
    assert.equal(suggestsVerifiedComment(gates), true);
  });

  it("fires for the servers 'accept issues, not pull requests' text", () => {
    const gates = parseGates("We accept issues, not pull requests");
    assert.equal(suggestsVerifiedComment(gates), true);
  });

  it("does not fire for a plain CLA repo or a clean repo", () => {
    assert.equal(
      suggestsVerifiedComment(parseGates("Please sign the CLA before contributing.")),
      false
    );
    assert.equal(suggestsVerifiedComment(parseGates("Thanks for contributing!")), false);
  });

  it("does not fire for unsolicited_prs_paused (a different class)", () => {
    assert.equal(
      suggestsVerifiedComment(
        parseGates("We've temporarily paused unsolicited pull requests from outside the core team.")
      ),
      false
    );
  });

  it("the suggestion names the command and the issue URL", () => {
    const s = verifiedCommentSuggestion(ISSUE);
    assert.ok(s.includes("greenlight verify-comment"));
    assert.ok(s.includes(ISSUE));
  });
});

describe("parseNoteFile", () => {
  it("maps headings onto fields and numbers the repro", () => {
    const { fields, additionalNotes } = parseNoteFile(
      `# Claim\n\nThe log leaks.\n\n## Environment\n\nrepo @ abc123\n\n## Repro\n\n- step one\n- step two\n\n## Root cause\n\nsetup.ts line 12\n`
    );
    assert.equal(fields.claim, "The log leaks.");
    assert.equal(fields.environment, "repo @ abc123");
    assert.deepEqual(fields.reproduction, ["step one", "step two"]);
    assert.equal(fields.rootCause, "setup.ts line 12");
    assert.equal(additionalNotes, "");
  });

  it("keeps unmapped sections instead of dropping them", () => {
    const { fields, additionalNotes } = parseNoteFile(`## Notes\n\nsome extra context\n`);
    assert.equal(fields.claim, undefined);
    assert.ok(additionalNotes.includes("some extra context"));
    assert.ok(additionalNotes.includes("### Notes"));
  });

  it("treats unheaded leading text as the claim", () => {
    const { fields } = parseNoteFile(`The log leaks into home.\n\n## Ran\n\nvitest run\n`);
    assert.equal(fields.claim, "The log leaks into home.");
    assert.equal(fields.ran, "vitest run");
  });
});
