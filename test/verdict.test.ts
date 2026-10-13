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

  it("fastmcp-5718 is GATED with assignment evidence", () => {
    const result = scoreIssue(load("fastmcp-5718.json"), NOW);
    assert.ok(result.reasons.some((r) => r.includes("assignment")));
    assert.ok(result.gates.some((g) => g.kind === "assignment_required" && g.detected));
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
