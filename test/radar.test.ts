/**
 * PR Radar tests: clustering rules, keep heuristic, and the API budget.
 * All network goes through injected deps; the live smoke runs separately.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractIssueRefs,
  branchIssueRefs,
  closingIssueForPR,
  titleTokens,
  titlePrefilterHit,
  filesOverlap,
  clusterPairs,
  suggestKeep,
  radarPRs,
  type RadarPR,
} from "../src/radar.js";

const pr = (over: Partial<RadarPR>): RadarPR => ({
  number: 1,
  title: "fix something",
  body: "",
  author: "alice",
  branch: "fix-1",
  headSha: "abc123",
  createdAt: "2026-10-01T00:00:00Z",
  url: "https://github.com/o/r/pull/1",
  draft: false,
  ...over,
});

describe("extractIssueRefs", () => {
  it("collects #N refs deduplicated", () => {
    assert.deepEqual(extractIssueRefs("Fixes #100 and also #100, see #101"), [100, 101]);
  });
  it("ignores non-number hash tokens", () => {
    assert.deepEqual(extractIssueRefs("fixes #abc and C# stuff"), []);
  });
});

describe("closingIssueForPR", () => {
  it("closing keyword in body -> the issue", () => {
    const p = pr({ number: 8176, title: "fix: sigv4 signing", body: "Fixes #8149" });
    assert.equal(closingIssueForPR(p), 8149);
  });
  it("bare mention only -> undefined (issue #1 rule: mentions never cluster)", () => {
    const p = pr({ number: 91, title: "x", body: "related: #61 and #62", branch: "docs-touch" });
    assert.equal(closingIssueForPR(p), undefined);
  });
  it("issue number as branch token -> the issue", () => {
    const p = pr({ number: 9484, title: "wsdl importer tweak", body: "for the importer", branch: "fix-9483-wsdl" });
    assert.equal(closingIssueForPR(p), 9483);
  });
  it("issue number in the PR title -> the issue", () => {
    const p = pr({ number: 9552, title: "#9517: fix multipart curl error", body: "" });
    assert.equal(closingIssueForPR(p), 9517);
  });
  it("alphanumeric identifiers like oauth2 never yield phantom issue numbers", () => {
    const p = pr({ number: 5115, title: "interpolate credentialsId in the token viewer", body: "body", branch: "bugfix/oauth2-credentialsId-interpolation" });
    assert.equal(closingIssueForPR(p), undefined);
  });
  it("posthog false positive: HTTP status code in branch is not issue #500", () => {
    // Source: PostHog/posthog seeding report, cluster 1 (false positive).
    // Branches "vojtab/fix-mcp-oauth-500" and
    // "posthog-code/fix-experiment-exposure-500-missing-variants" were parsed
    // as issue #500; both PRs are about different things ("500 errors" text).
    const a = pr({ number: 57688, title: "fix(mcp): prevent 500 errors for OAuth bearer", body: "", branch: "vojtab/fix-mcp-oauth-500" });
    const b = pr({ number: 73576, title: "fix(experiments): descriptive error when flag loses variants", body: "", branch: "posthog-code/fix-experiment-exposure-500-missing-variants" });
    assert.equal(closingIssueForPR(a), undefined);
    assert.equal(closingIssueForPR(b), undefined);
  });
  it("supabase false positive: GitHub web-UI patch-N branches are not issues", () => {
    // Source: supabase/supabase seeding report, clusters 1 and 2 (false
    // positives). Branches "inian-patch-1" and "patch-2" are GitHub's
    // auto-generated names for web-UI file edits, not issue references.
    const a = pr({ number: 34900, title: "Update access-control.mdx", body: "", branch: "inian-patch-1" });
    const b = pr({ number: 35203, title: "docs: fix JS syntax errors", body: "", branch: "patch-2" });
    assert.equal(closingIssueForPR(a), undefined);
    assert.equal(closingIssueForPR(b), undefined);
  });
  it("the PR's own number is never a self-cluster", () => {
    const p = pr({ number: 100, title: "PR #100", body: "Closes #100", branch: "docs-touch" });
    assert.equal(closingIssueForPR(p), undefined);
  });
});

describe("branchIssueRefs", () => {
  it("keeps genuine conventions: prefix token, segment start, trailing word-number", () => {
    // fix-9483-wsdl: existing genuine convention (bruno-era regression guard).
    assert.deepEqual(branchIssueRefs("fix-9483-wsdl"), [9483]);
    // feat/61-resume-block: issue-first segment convention.
    assert.deepEqual(branchIssueRefs("feat/61-resume-block"), [61]);
    // supabase #43910 genuine cluster: trailing number after a word.
    assert.deepEqual(branchIssueRefs("fix/studio-sms-template-newlines-6435"), [6435]);
    // n8n #9074 genuine cluster: bare mid-branch 3+ digit token.
    assert.deepEqual(branchIssueRefs("pay-852-partial-workflow-executions-with-run-data-and-merge-node"), [852]);
    // n8n #10758 retry branch: 852 still extracted, trailing "-2" is a counter.
    assert.deepEqual(branchIssueRefs("pay-852-partial-workflow-executions-with-run-data-and-merge-node-try-2"), [852]);
    // explicit # marker always counts.
    assert.deepEqual(branchIssueRefs("docs/#42997-clarify"), [42997]);
  });
  it("rejects web-UI patch-N branches (supabase/langfuse false positives)", () => {
    // Sources: supabase/supabase seeding report clusters 1-2,
    // langfuse/langfuse seeding report cluster 2.
    assert.deepEqual(branchIssueRefs("inian-patch-1"), []);
    assert.deepEqual(branchIssueRefs("patch-2"), []);
    assert.deepEqual(branchIssueRefs("patch-1"), []);
    assert.deepEqual(branchIssueRefs("someuser-patch-1"), []);
  });
  it("rejects HTTP status codes without an explicit marker (posthog false positive)", () => {
    // Source: PostHog/posthog seeding report cluster 1.
    assert.deepEqual(branchIssueRefs("vojtab/fix-mcp-oauth-500"), []);
    assert.deepEqual(branchIssueRefs("posthog-code/fix-experiment-exposure-500-missing-variants"), []);
    assert.deepEqual(branchIssueRefs("fix-mcp-oauth-404"), []); // unmarked status code
    assert.deepEqual(branchIssueRefs("issue-404-page"), [404]); // explicit prefix still counts
  });
  it("rejects version numbers and numeric sub-counters (n8n false positive)", () => {
    // Source: n8n-io/n8n seeding report cluster 2 (link rejected):
    // "shorten-changelog-prior-to-1.0" (version) and
    // "claude/task-22584764486-1" (bot task counter).
    assert.deepEqual(branchIssueRefs("shorten-changelog-prior-to-1.0"), []);
    assert.deepEqual(branchIssueRefs("claude/task-22584764486-1"), []);
  });
  it("rejects bare mid-branch/trailing counters under 100 (langfuse false positive)", () => {
    // Source: langfuse/langfuse seeding report cluster 3:
    // "bundle-size-3-migrate" parsed as issue #3. Also "-try-2" style retries.
    assert.deepEqual(branchIssueRefs("bundle-size-3-migrate"), []);
    assert.deepEqual(branchIssueRefs("copilot/fix-thing-try-2"), []);
  });
  it("rejects alphanumeric version tokens like oauth2", () => {
    assert.deepEqual(branchIssueRefs("bugfix/oauth2-credentialsId-interpolation"), []);
  });
});

describe("titlePrefilterHit", () => {
  it("overlapping significant tokens pass the gate", () => {
    const a = pr({ title: "Fix multipart form data error in curl import" });
    const b = pr({ title: "fix: multipart curl import form-data parsing" });
    assert.ok(titlePrefilterHit(a, b));
  });
  it("unrelated titles fail the gate, so no file fetch is spent", () => {
    const a = pr({ title: "Fix multipart form data error in curl import" });
    const b = pr({ title: "Bump electron version for windows installer" });
    assert.ok(!titlePrefilterHit(a, b));
  });
  it("stopwords and short tokens do not count", () => {
    const a = pr({ title: "Fix the bug in a new way" });
    const b = pr({ title: "Add the thing to a new file" });
    assert.ok(!titlePrefilterHit(a, b));
  });
});

describe("filesOverlap", () => {
  it("identical sets overlap at 1.0 with a shared dir", () => {
    const r = filesOverlap(
      ["packages/bruno-converters/src/a.js", "packages/bruno-converters/src/b.js"],
      ["packages/bruno-converters/src/a.js", "packages/bruno-converters/src/b.js"]
    );
    assert.ok(r.overlap);
    assert.equal(r.jaccard, 1);
    assert.equal(r.sharedDir, "packages");
  });
  it("disjoint sets never overlap", () => {
    const r = filesOverlap(["src/a.js"], ["docs/b.md"]);
    assert.ok(!r.overlap);
  });
  it("below the 0.6 threshold does not cluster", () => {
    const r = filesOverlap(["a/1.js", "a/2.js", "a/3.js", "a/4.js", "a/5.js"], ["a/1.js", "b/9.js"]);
    assert.ok(!r.overlap);
    assert.ok(r.jaccard < 0.6);
  });
  it("same filenames but no shared top-level directory do not cluster", () => {
    const r = filesOverlap(["x/utils.js", "x/a.js", "x/b.js"], ["y/utils.js", "y/a.js", "y/b.js"]);
    assert.ok(!r.overlap);
  });
});

describe("clusterPairs", () => {
  it("groups transitively: A~B and B~C put all three together", () => {
    assert.deepEqual(clusterPairs([1, 2, 3, 4], [[1, 2], [2, 3]]), [[1, 2, 3]]);
  });
  it("singletons never form clusters", () => {
    assert.deepEqual(clusterPairs([1, 2], []), []);
  });
});

describe("suggestKeep", () => {
  it("picks the earliest opened and labels the reason a heuristic", () => {
    const older = pr({ number: 10, createdAt: "2026-09-01T00:00:00Z", changedFiles: ["a.js"] });
    const newer = pr({ number: 11, createdAt: "2026-10-01T00:00:00Z", changedFiles: ["a.js", "b.js"] });
    const { keep, reason } = suggestKeep([newer, older], new Map());
    assert.equal(keep, 10);
    assert.ok(/heuristic/i.test(reason), `reason must say heuristic: ${reason}`);
    assert.ok(/not a verdict/i.test(reason));
  });
  it("prefers green CI among the top two only when it changes nothing about age ordering text", () => {
    const a = pr({ number: 1, createdAt: "2026-09-01T00:00:00Z" });
    const b = pr({ number: 2, createdAt: "2026-09-02T00:00:00Z" });
    const { keep, reason } = suggestKeep([a, b], new Map([[2, "success"]]));
    assert.equal(keep, 1);
    assert.ok(reason.includes("#2 has green CI"), `reason: ${reason}`);
  });
});

describe("radarPRs pipeline (injected deps)", () => {
  const listOpenPRs = async (): Promise<RadarPR[]> => [
    pr({ number: 1, title: "fix: enum validation", body: "Fixes #100", author: "alice", branch: "fix-100", createdAt: "2026-10-01T00:00:00Z" }),
    pr({ number: 2, title: "fix: enum validation retry", body: "Closes #100", author: "bob", branch: "fix/100-enum", createdAt: "2026-10-05T00:00:00Z" }),
    pr({ number: 3, title: "Fix multipart form data error in curl import", body: "body", author: "carol", branch: "fix-multipart", createdAt: "2026-10-02T00:00:00Z" }),
    pr({ number: 4, title: "fix: multipart curl import form-data parsing", body: "body", author: "dave", branch: "multipart-fix", createdAt: "2026-10-03T00:00:00Z" }),
    pr({ number: 5, title: "Bump electron version for windows installer", body: "chore", author: "erin", branch: "bump-electron", createdAt: "2026-10-04T00:00:00Z" }),
  ];
  const files: Record<number, string[]> = {
    3: ["packages/bruno-cli/src/a.js", "packages/bruno-cli/src/b.js", "packages/bruno-cli/src/c.js"],
    4: ["packages/bruno-cli/src/a.js", "packages/bruno-cli/src/b.js", "packages/bruno-cli/src/c.js", "packages/bruno-cli/src/d.js"],
  };
  let fileFetches = 0;
  const deps = {
    listOpenPRs,
    fetchFiles: async (_o: string, _r: string, n: number) => {
      fileFetches++;
      return files[n] ?? [];
    },
    fetchCombinedState: async () => "success",
  };

  it("clusters by closing issue, by file overlap, and leaves the loner unclustered", async () => {
    const r = await radarPRs("o", "r", { limit: 25 }, deps);
    assert.equal(r.prsScanned, 5);
    assert.equal(r.clusters.length, 2);
    const sameIssue = r.clusters.find((c) => c.kind === "same-issue")!;
    assert.deepEqual(sameIssue.prs, [1, 2]);
    assert.equal(sameIssue.issue!.number, 100);
    assert.equal(sameIssue.suggestedKeep, 1);
    const overlap = r.clusters.find((c) => c.kind === "file-overlap")!;
    assert.deepEqual(overlap.prs, [3, 4]);
    assert.ok(overlap.suggestedKeepReason.includes("heuristic"));
    assert.deepEqual(r.unclustered, [5]);
  });

  it("file lists are fetched only for title-prefiltered pairs (budget)", async () => {
    fileFetches = 0;
    await radarPRs("o", "r", { limit: 25 }, deps);
    // Pair (3,4) passes the title gate; (5) pairs with nothing; (1,2) never reach pass B.
    assert.equal(fileFetches, 2, `expected 2 file fetches, got ${fileFetches}`);
  });

  it("reports the measured API call count (0 when deps are injected)", async () => {
    const r = await radarPRs("o", "r", { limit: 25 }, deps);
    assert.equal(typeof r.apiCalls, "number");
  });

  it("a failing file fetch removes that PR from overlap consideration, not the run", async () => {
    const badDeps = {
      ...deps,
      fetchFiles: async () => {
        throw new Error("boom");
      },
    };
    const r = await radarPRs("o", "r", { limit: 25 }, badDeps);
    assert.equal(r.clusters.length, 1); // only the same-issue cluster survives
    assert.deepEqual(r.unclustered.sort((a, b) => a - b), [3, 4, 5]);
  });
});
