import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectClaims, isBotAuthor, strongClaimants } from "../src/claims.js";
import type { CommentSignal } from "../src/types.js";

const NOW = new Date("2026-10-13T12:00:00Z");

function comment(author: string, body: string, createdAt = "2026-10-12T10:00:00Z"): CommentSignal {
  return { author, body, createdAt };
}

describe("isBotAuthor", () => {
  it("flags bot accounts", () => {
    assert.equal(isBotAuthor("dependabot[bot]"), true);
    assert.equal(isBotAuthor("github-actions[bot]"), true);
    assert.equal(isBotAuthor("claw-sweeper[bot]"), true);
    assert.equal(isBotAuthor("dependabot"), true);
    assert.equal(isBotAuthor("github-actions"), true);
  });
  it("does not flag humans", () => {
    assert.equal(isBotAuthor("Kylinny"), false);
    assert.equal(isBotAuthor("mdiniz97"), false);
  });
});

describe("detectClaims", () => {
  it("detects explicit claim phrases as strong", () => {
    const claims = detectClaims("reporter", [comment("Kylinny", "I would like to work on this issue. Please assign it to me.")], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].author, "Kylinny");
    assert.equal(claims[0].strength, "strong");
  });

  it("detects fix-ready and PR announcements as strong", () => {
    const claims = detectClaims("reporter", [
      comment("dev1", "The fix is ready on my fork."),
      comment("dev2", "I have opened a PR for this."),
    ], NOW);
    assert.equal(strongClaimants(claims).length, 2);
  });

  it("detects soft offers as soft, not strong", () => {
    const claims = detectClaims("reporter", [comment("dev3", "I am happy to fix this if no one is on it.")], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].strength, "soft");
    assert.equal(strongClaimants(claims).length, 0);
  });

  it("ignores bot comments", () => {
    const claims = detectClaims("reporter", [comment("claw-sweeper[bot]", "I will take this on.")], NOW);
    assert.equal(claims.length, 0);
  });

  it("ignores the issue author unless they announce a ready fix", () => {
    const claims = detectClaims("reporter", [
      comment("reporter", "I would like to work on this."),
      comment("reporter", "Fix is ready, PR incoming."),
    ], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].phrase, "fix-ready");
  });

  it("dedupes to one signal per author, keeping the strongest", () => {
    const claims = detectClaims("reporter", [
      comment("dev4", "Happy to fix this.", "2026-10-10T10:00:00Z"),
      comment("dev4", "Please assign it to me, I have started.", "2026-10-12T10:00:00Z"),
    ], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].strength, "strong");
  });

  it("computes ageDays from the fixed now", () => {
    const claims = detectClaims("reporter", [comment("dev5", "I will take this on.", "2026-08-11T05:00:00Z")], NOW);
    assert.equal(claims[0].ageDays, 63);
  });

  it("returns no signals for discussion comments", () => {
    const claims = detectClaims("reporter", [comment("dev6", "I can reproduce this on macOS 15.")], NOW);
    assert.equal(claims.length, 0);
  });
});

describe("partial claim detection (reticle#691)", () => {
  it("detects a scoped claim as strong and partial", () => {
    const claims = detectClaims("reporter", [comment("kushals256", "Taking the remaining fallback ask.")], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].author, "kushals256");
    assert.equal(claims[0].strength, "strong");
    assert.equal(claims[0].scope, "partial");
    assert.equal(claims[0].scopeWord, "remaining");
    assert.equal(claims[0].phrase, "partial-taking");
  });

  it("detects the other scoped phrasings", () => {
    const cases: Array<[string, string]> = [
      ["I'll take the fallback part of this.", "partial-will-take"],
      ["claiming this half for now.", "partial-claiming"],
      ["working on the remaining piece locally.", "partial-working-on"],
    ];
    for (const [body, phrase] of cases) {
      const claims = detectClaims("reporter", [comment("dev", body)], NOW);
      assert.equal(claims.length, 1, body);
      assert.equal(claims[0].scope, "partial", body);
      assert.equal(claims[0].phrase, phrase, body);
      assert.ok(claims[0].scopeWord, body);
    }
  });

  it("keeps whole-issue claims scoped full", () => {
    const claims = detectClaims("reporter", [comment("dev", "I would like to work on this issue.")], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].scope, "full");
    assert.equal(claims[0].scopeWord, undefined);
  });

  it("'taking this on' with no scope word stays a full claim", () => {
    const claims = detectClaims("reporter", [comment("dev", "I will be taking this on tomorrow.")], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].scope, "full");
    assert.equal(claims[0].phrase, "taking-it");
  });
});
