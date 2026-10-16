/**
 * Field validation corpus: thirteen real cases from the contribution campaign,
 * frozen as offline fixtures. This is the product's validation story:
 * every verdict rule is pinned to a case that actually happened:
 *
 *   01 pdfcn #61        own closing PR open              -> TAKEN
 *   02 pdfcn #71        PR closing another issue mentions -> RISKY (weak-pr-mention)
 *   03 pdfcn #65        claim-first + DCO, no claims      -> RISKY (claim-first, not GATED)
 *   04 squidbrake #74   comment-first gate only           -> RISKY (claim-first)
 *   05 fastmcp-style    "ask to be assigned"              -> GATED
 *   06 reticle #691     scoped claim on part of the work  -> RISKY (partial-claim)
 *   07 reticle #894     half shipped via merged PRs       -> RISKY (partially-addressed)
 *   08 trigger.dev-style vouch required                   -> GATED
 *   09 clean small repo  no gates/claims/PRs              -> GO
 *   10 python-sdk #3287  60-day-old claim, no PR          -> RISKY (stale_claim, not TAKEN)
 *   11 tscircuit #5563   fix PRs linked in comments       -> RISKY (attempt-linked-pr)
 *   12 n8n #41215        duplicate of completed issue    -> RISKY (duplicate-of-closed)
 *   13 activepieces       paused unsolicited PRs + workflow -> GATED
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreIssue } from "../src/verdict.js";
import type { IssueSnapshot, Verdict } from "../src/types.js";

const CASES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cases");

interface CorpusCase {
  name: string;
  now: string;
  snapshot: IssueSnapshot;
  expect: { verdict: Verdict; flags: string[] };
}

const files = readdirSync(CASES).filter((f) => f.endsWith(".json")).sort();
assert.ok(files.length >= 10, `expected at least 10 corpus cases, found ${files.length}`);

describe("field validation corpus", () => {
  for (const file of files) {
    it(file, () => {
      const c = JSON.parse(readFileSync(join(CASES, file), "utf8")) as CorpusCase;
      assert.ok(c.name, "case has a name");
      assert.ok(c.snapshot.sourceUrl, "case records its source issue URL");
      const result = scoreIssue(c.snapshot, new Date(c.now));
      assert.equal(
        result.verdict,
        c.expect.verdict,
        `${c.name} | reasons: ${result.reasons.join(" | ")}`
      );
      for (const flag of c.expect.flags) {
        assert.ok(
          result.flags.includes(flag),
          `${c.name}: expected flag "${flag}", got [${result.flags.join(", ")}]`
        );
      }
      assert.ok(result.reasons.length > 0, "every verdict explains itself");
    });
  }
});
