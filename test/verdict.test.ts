import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreIssue } from "../src/verdict.js";
import type { IssueSnapshot, Verdict } from "../src/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
// Fixed reference date matching the hand-verified vetting day (2026-10-13).
const NOW = new Date("2026-10-13T12:00:00Z");

function load(name: string): IssueSnapshot {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as IssueSnapshot;
}

const EXPECTED: Record<string, Verdict> = {
  "squidbrake-74.json": "GO",
  "fastmcp-5718.json": "GATED",
  "langchain-41185.json": "TAKEN",
  "pdfcn-58.json": "RISKY",
  "python-sdk-3287.json": "RISKY",
  "assignee-case.json": "TAKEN",
  "linked-pr-case.json": "TAKEN",
  "stale-case.json": "STALE",
  "closed-case.json": "TAKEN",
  "pdfcn-61-mention.json": "RISKY",
  "pdfcn-61-closing.json": "TAKEN",
};

describe("fixture verdicts reproduce hand-verified cases", () => {
  for (const [file, expected] of Object.entries(EXPECTED)) {
    it(`${file} -> ${expected}`, () => {
      const snapshot = load(file);
      assert.ok(snapshot.sourceUrl, "fixture records its source issue URL");
      const result = scoreIssue(snapshot, NOW);
      assert.equal(result.verdict, expected, `reasons: ${result.reasons.join(" | ")}`);
      assert.ok(result.reasons.length > 0, "every verdict explains itself");
    });
  }
});

describe("verdict details", () => {
  it("pdfcn-58 is RISKY with the claimed flag (claimed same day)", () => {
    const result = scoreIssue(load("pdfcn-58.json"), NOW);
    assert.ok(result.flags.includes("claimed"));
    assert.equal(result.claims[0].author, "ukir-rrrr");
  });

  it("python-sdk-3287 is RISKY with the stale_claim flag (63-day-old claim, no PR)", () => {
    const result = scoreIssue(load("python-sdk-3287.json"), NOW);
    assert.ok(result.flags.includes("stale_claim"));
    assert.equal(result.claims[0].author, "HaoChiBao");
  });

  it("langchain-41185 is a claim race (3 strong claimants)", () => {
    const result = scoreIssue(load("langchain-41185.json"), NOW);
    assert.ok(result.reasons[0].includes("claim race"));
    assert.equal(result.claims.filter((c) => c.strength === "strong").length, 3);
  });

  it("a mere PR mention does not take the issue (issue #1 regression)", () => {
    // PR #91 closes #70 and lists siblings #60-#65 in its body; it must not
    // mark #61 as TAKEN.
    const result = scoreIssue(load("pdfcn-61-mention.json"), NOW);
    assert.notEqual(result.verdict, "TAKEN");
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("weak-pr-mention"));
    assert.ok(result.reasons.some((r) => r.includes("mentions this issue but does not close it")));
    assert.ok(result.reasons.some((r) => r.includes("#91")));
  });

  it("a closing PR still takes the issue", () => {
    const result = scoreIssue(load("pdfcn-61-closing.json"), NOW);
    assert.equal(result.verdict, "TAKEN");
    assert.ok(result.reasons[0].includes("closes this issue"));
    assert.ok(result.reasons[0].includes("#91"));
  });

  it("an old cache entry without linkStrength is treated as a mention, not a close", () => {
    const snapshot = load("pdfcn-61-mention.json");
    delete (snapshot.linkedPRs[0] as Record<string, unknown>).linkStrength;
    const result = scoreIssue(snapshot, NOW);
    assert.notEqual(result.verdict, "TAKEN");
    assert.ok(result.flags.includes("weak-pr-mention"));
  });

  it("fastmcp-5718 is GATED with assignment evidence", () => {
    const result = scoreIssue(load("fastmcp-5718.json"), NOW);
    assert.ok(result.reasons.some((r) => r.includes("assignment")));
    assert.ok(result.gates.some((g) => g.kind === "assignment_required" && g.detected));
  });

  it("claim-first repo caps a clean issue at RISKY, never GATED (pdfcn style)", () => {
    const base = load("pdfcn-58.json");
    const snapshot: IssueSnapshot = {
      ...base,
      comments: [],
      linkedPRs: [],
      contributing: "Do not claim an issue silently. Comment before starting work. All commits need a Signed-off-by line per the DCO.",
      updatedAt: NOW.toISOString(),
    };
    const result = scoreIssue(snapshot, NOW);
    assert.notEqual(result.verdict, "GATED");
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.reasons.some((r) => r.includes("claim first")));
    assert.ok(result.flags.includes("claim_first"));
    assert.ok(result.gates.some((g) => g.kind === "claim_first" && g.detected));
    assert.ok(result.gates.some((g) => g.kind === "dco_required" && g.detected));
    assert.ok(!result.gates.some((g) => g.kind === "assignment_required" && g.detected));
  });

  it("claim-first note stacks onto a weak-PR-mention RISKY", () => {
    const base = load("pdfcn-61-mention.json");
    const snapshot: IssueSnapshot = {
      ...base,
      contributing: "Do not claim an issue silently. Comment before starting work.",
    };
    const result = scoreIssue(snapshot, NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("weak-pr-mention"));
    assert.ok(result.flags.includes("claim_first"));
  });

  it("all fixture files are valid snapshots", () => {
    for (const file of readdirSync(FIXTURES)) {
      if (!file.endsWith(".json")) continue;
      const s = load(file);
      assert.ok(s.owner && s.repo && Number.isInteger(s.number), `${file} has owner/repo/number`);
      assert.ok(["open", "closed"].includes(s.state), `${file} has a valid state`);
    }
  });
});

describe("partial claims (reticle#691 near-miss)", () => {
  function clean(): IssueSnapshot {
    const base = load("pdfcn-58.json");
    return {
      ...base,
      comments: [],
      linkedPRs: [],
      commentMentionedPRs: [],
      contributing: undefined,
      updatedAt: NOW.toISOString(),
    };
  }
  function withComments(comments: Array<{ author: string; body: string; createdAt?: string }>): IssueSnapshot {
    const snap = clean();
    snap.comments = comments.map((c) => ({
      author: c.author,
      body: c.body,
      createdAt: c.createdAt ?? "2026-10-12T10:00:00Z",
    }));
    return snap;
  }

  it("a fresh scoped claim downgrades GO to RISKY, never TAKEN", () => {
    const result = scoreIssue(withComments([{ author: "kushals256", body: "Taking the remaining fallback ask." }]), NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("claimed"));
    assert.ok(result.flags.includes("partial-claim"));
    assert.ok(
      result.reasons.some((r) => r.includes("kushals256") && r.includes("the remaining part") && r.includes("the rest may still be open")),
      `reasons: ${result.reasons.join(" | ")}`
    );
    assert.equal(result.claims[0].scope, "partial");
  });

  it("two scoped claims do not form a claim race", () => {
    const result = scoreIssue(withComments([
      { author: "dev1", body: "Taking the remaining fallback ask." },
      { author: "dev2", body: "I'll take the fallback part instead." },
    ]), NOW);
    assert.notEqual(result.verdict, "TAKEN");
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("partial-claim"));
  });

  it("a whole-issue claim still wins over a scoped one", () => {
    const result = scoreIssue(withComments([
      { author: "dev1", body: "I would like to work on this issue." },
      { author: "dev2", body: "Taking the remaining fallback ask." },
    ]), NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.reasons.some((r) => r.includes('claimed by dev1 1 day(s) ago ("explicit-claim")')));
    assert.ok(!result.flags.includes("partial-claim"));
  });

  it("a stale scoped claim behaves like a stale claim", () => {
    const result = scoreIssue(withComments([
      { author: "dev1", body: "Taking the remaining fallback ask.", createdAt: "2026-07-01T10:00:00Z" },
    ]), NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("stale_claim"));
    assert.ok(result.reasons.some((r) => r.includes("stale partial claim by dev1")));
  });
});

describe("comment-mentioned PR cross-check", () => {
  function clean(): IssueSnapshot {
    const base = load("pdfcn-58.json");
    return {
      ...base,
      comments: [],
      linkedPRs: [],
      commentMentionedPRs: [],
      contributing: undefined,
      updatedAt: NOW.toISOString(),
    };
  }

  it("an open PR cited in comments that mentions the issue downgrades GO to RISKY", () => {
    const snap = clean();
    snap.commentMentionedPRs = [{ number: 861, url: "https://github.com/r/r/pull/861", state: "open", mentionsIssue: true }];
    const result = scoreIssue(snap, NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("comment-mentioned-pr"));
    assert.ok(result.reasons.some((r) => r.includes("PR #861 referenced in comments may already cover part of this issue")));
    assert.notEqual(result.verdict, "TAKEN");
  });

  it("a cited PR that does not mention the issue leaves GO alone", () => {
    const snap = clean();
    snap.commentMentionedPRs = [{ number: 861, url: "https://github.com/r/r/pull/861", state: "open", mentionsIssue: false }];
    const result = scoreIssue(snap, NOW);
    assert.equal(result.verdict, "GO");
    assert.ok(!result.flags.includes("comment-mentioned-pr"));
  });

  it("a merged cited PR is an informational note, never a downgrade", () => {
    const snap = clean();
    snap.commentMentionedPRs = [{ number: 861, url: "https://github.com/r/r/pull/861", state: "merged", mentionsIssue: true }];
    const result = scoreIssue(snap, NOW);
    assert.equal(result.verdict, "GO");
    assert.ok(!result.flags.includes("comment-mentioned-pr"));
    assert.ok(result.reasons.some((r) => r.includes("PR #861 (merged) referenced in comments; issue may be partially addressed")));
  });

  it("a closed (unmerged) cited PR changes nothing", () => {
    const snap = clean();
    snap.commentMentionedPRs = [{ number: 861, url: "https://github.com/r/r/pull/861", state: "closed", mentionsIssue: true }];
    const result = scoreIssue(snap, NOW);
    assert.equal(result.verdict, "GO");
    assert.ok(!result.flags.includes("comment-mentioned-pr"));
  });
});
