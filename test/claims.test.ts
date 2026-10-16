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

  it("detects a bare 'I'd like to take this' as a strong claim", () => {
    // fastmcp #5743, 2026-10-14: scan reported no claim signals for this
    // comment because the older pattern demanded a trailing "on"/"up".
    const claims = detectClaims("reporter", [
      comment("anishgurjar", "Hi, I'd like to take this. Plan: give sync tools a way to see that their deadline has passed."),
    ], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].strength, "strong");
  });

  it("does not read 'take this opportunity to thank' as a claim", () => {
    const claims = detectClaims("reporter", [
      comment("dev9", "I'd like to take this opportunity to thank the maintainers for the report."),
    ], NOW);
    assert.equal(claims.length, 0);
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

describe("attempt-command claims (field case 2026-10-15)", () => {
  it("treats a /attempt command as a strong claim (tscircuit/tscircuit#5563)", () => {
    const claims = detectClaims("DurandA", [comment("TassioSales", "/attempt #5563")], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].author, "TassioSales");
    assert.equal(claims[0].strength, "strong");
    assert.equal(claims[0].phrase, "attempt-command");
    assert.equal(claims[0].scope, "full");
  });

  it("treats /claim as a strong claim too", () => {
    const claims = detectClaims("reporter", [comment("dev", "/claim #123")], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].strength, "strong");
  });

  it("does not treat a quoted /attempt as a claim", () => {
    // The pattern is anchored to the start of the comment; a casual
    // mention mid-sentence must not count.
    const claims = detectClaims("reporter", [comment("dev", "run /attempt to try it")], NOW);
    assert.equal(claims.length, 0);
  });

  it("detects 'take a look at this one' as a soft claim with a date (actualbudget #6643)", () => {
    // pnlabs-dev, 2026-08-20: a soft claim two months old with nothing
    // landing. Soft, so it never caps a verdict alone; the age travels
    // with the signal so the verdict can show it.
    const claims = detectClaims("reporter", [
      comment("pnlabs-dev", "I'm going to take a look at this one.", "2026-08-20T12:00:00Z"),
    ], new Date("2026-10-15T12:00:00Z"));
    assert.equal(claims.length, 1);
    assert.equal(claims[0].strength, "soft");
    assert.equal(claims[0].phrase, "take-a-look");
    assert.equal(claims[0].ageDays, 56);
  });

  it("does not read 'take a look' prose about unrelated things as a claim", () => {
    const claims = detectClaims("reporter", [
      comment("dev", "Please take a look at the README when you get a chance."),
    ], NOW);
    // "take a look at the" matches the pattern but refers to a doc, not the
    // issue; the regex is intentionally narrow ("at this") to avoid this,
    // so this must stay empty.
    assert.equal(claims.length, 0);
  });
});

describe("bare-take soft claims (field case 2026-10-16)", () => {
  it("detects the common bare claim phrasings as soft", () => {
    const bodies = [
      "I'll take this",
      "I'll take it.",
      "I take this.",
      "Taking this.",
      "I'll take this one",
      "let me take this",
      "I'll take this, I have a patch in mind.",
    ];
    for (const body of bodies) {
      const claims = detectClaims("reporter", [comment("dev", body)], NOW);
      assert.equal(claims.length, 1, body);
      assert.equal(claims[0].strength, "soft", body);
      assert.equal(claims[0].phrase, "bare-take", body);
    }
  });

  it("does not read non-claim continuations as claims", () => {
    const bodies = [
      "I'll take this into account.",
      "I'll take this offline.",
      "Take this with a grain of salt, but the repro looks right.",
      "I'll take this opportunity to thank the maintainers for the report.",
      "I'd like to take this opportunity to help, if that's okay.",
      "Taking this offline for now, will report back.",
    ];
    for (const body of bodies) {
      const claims = detectClaims("reporter", [comment("dev", body)], NOW);
      assert.equal(claims.length, 0, body);
    }
  });

  it("keeps 'take this on' strong via taking-it, not bare-take", () => {
    const claims = detectClaims("reporter", [comment("dev", "I'll take this on.")], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].strength, "strong");
    assert.equal(claims[0].phrase, "taking-it");
  });

  it("a bare take with a plan is still just a soft signal on its own", () => {
    // The plan detail does not promote it; "like-to-take" style strong
    // claims carry an explicit "I'd like to" commitment shape.
    const claims = detectClaims("reporter", [comment("dev", "I'll take this. Plan: rewrite the widget loop.")], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].strength, "soft");
  });
});

describe("pick-up family and work-availability (firecrawl#839)", () => {
  it("detects 'I can pick it up' style claims as soft", () => {
    // firecrawl#839 (2026-10-16): "If not, I can pick it up." was missed by
    // every existing pattern.
    const bodies = [
      "If not, I can pick it up.",
      "I can pick this up.",
      "I'll pick this up tomorrow.",
      "let me pick it up",
      "Can I pick this up?",
    ];
    for (const body of bodies) {
      const claims = detectClaims("reporter", [comment("dev", body)], NOW);
      assert.equal(claims.length, 1, body);
      assert.equal(claims[0].strength, "soft", body);
      assert.equal(claims[0].phrase, "pick-up-offer", body);
    }
  });

  it("detects availability asks paired with work intent as soft", () => {
    // The other missed firecrawl#839 comment.
    const bodies = [
      "Can i still work on this, is this open.",
      "Can I work on this?",
      "Can I please work on this?",
    ];
    for (const body of bodies) {
      const claims = detectClaims("reporter", [comment("dev", body)], NOW);
      assert.equal(claims.length, 1, body);
      assert.equal(claims[0].strength, "soft", body);
      assert.equal(claims[0].phrase, "work-availability", body);
    }
  });

  it("does not read physical pickups or the pace idiom as claims", () => {
    const bodies = [
      "I can pick it up from the store on my way home.",
      "Can I pick it up from the office tomorrow?",
      "Let's pick up the pace on this one.",
      "We should pick up the pace here.",
    ];
    for (const body of bodies) {
      const claims = detectClaims("reporter", [comment("dev", body)], NOW);
      assert.equal(claims.length, 0, body);
    }
  });
});
