/**
 * PR Brief tests: target parsing, file-area classification, and the
 * assembly pipeline with fully injected deps (no network).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseBriefTarget,
  fileArea,
  briefPR,
  type BriefDeps,
  type PullDetailFull,
  type ReviewStateItem,
} from "../src/brief.js";

describe("parseBriefTarget", () => {
  it("accepts a full pull-request URL", () => {
    assert.deepEqual(parseBriefTarget("https://github.com/usebruno/bruno/pull/9569"), {
      owner: "usebruno",
      repo: "bruno",
      number: 9569,
    });
  });
  it("accepts the owner/repo#N shorthand", () => {
    assert.deepEqual(parseBriefTarget("usebruno/bruno#9569"), {
      owner: "usebruno",
      repo: "bruno",
      number: 9569,
    });
  });
  it("rejects an issues URL and other garbage", () => {
    assert.throws(() => parseBriefTarget("https://github.com/o/r/issues/1"), /Not a PR target/);
    assert.throws(() => parseBriefTarget("o/r"), /Not a PR target/);
  });
});

describe("fileArea", () => {
  const cases: Array<[string, string]> = [
    ["src/index.ts", "source"],
    ["packages/bruno-js/src/sandbox.ts", "source"],
    ["packages/cli/tests/runner.spec.js", "tests"],
    ["test/xray.test.ts", "tests"],
    ["__tests__/a.test.js", "tests"],
    [".github/workflows/ci.yml", "generated"],
    ["package-lock.json", "generated"],
    ["dist/cli.js", "generated"],
    ["package.json", "config"],
    ["tsconfig.json", "config"],
    ["Dockerfile", "config"],
    ["docs/guide.md", "docs"],
    ["README.md", "docs"],
    ["src/logo.png", "other"],
  ];
  for (const [path, area] of cases) {
    it(`${path} -> ${area}`, () => {
      assert.equal(fileArea(path), area);
    });
  }
});

const detail = (over: Partial<PullDetailFull> = {}): PullDetailFull => ({
  title: "fix: evaluate dynamic variables once",
  author: "CloudCorpRecords",
  state: "open",
  merged: false,
  draft: false,
  url: "https://github.com/o/r/pull/1",
  createdAt: "2026-10-18T00:00:00Z",
  baseRef: "main",
  mergeable: true,
  mergeableState: "clean",
  ...over,
});

const reviewDeps = (findings: string[]) => ({
  reviewDeps: {
    fetchPull: async () => ({ title: "t", author: "CloudCorpRecords" }),
    fetchReviews: async () => [],
    fetchReviewComments: async () =>
      findings.map((body) => ({
        id: 1,
        user: { login: "coderabbitai[bot]" },
        body,
        path: "src/index.ts",
        line: 10,
        diff_hunk: "@@ -1,2 +1,2 @@\n const x = token_xyz;\n const y = 2;",
        pull_request_review_id: 7,
        original_line: 10,
      })),
    fetchIssueComments: async () => [],
  },
  ciDeps: {
    fetchPull: async () => ({
      title: "t",
      baseRef: "main",
      baseSha: "base1",
      headSha: "head1",
      changedFiles: ["src/index.ts"],
    }),
    fetchHeadChecks: async () => [],
    fetchBaseRecords: async () => [],
  },
});

describe("briefPR assembly (injected deps)", () => {
  const files = () => [
    { filename: "src/index.ts", status: "modified" as const, additions: 40, deletions: 5, area: fileArea("src/index.ts") },
    { filename: "test/xray.test.ts", status: "added" as const, additions: 120, deletions: 0, area: fileArea("test/xray.test.ts") },
  ];

  it("classifies a real finding, notes test evidence, ends with a look-first line", async () => {
    const deps: BriefDeps = {
      fetchPullDetail: async () => detail(),
      fetchPullFiles: async () => files(),
      fetchReviews: async () => [] as ReviewStateItem[],
      ...reviewDeps(["`token_xyz` is hardcoded here; consider a named constant"]),
    };
    const r = await briefPR("o/r#1", deps);
    assert.equal(r.number, 1);
    assert.equal(r.size.filesChanged, 2);
    assert.equal(r.size.additions, 160);
    assert.ok(r.areas.some((g) => g.area === "source" && g.files.includes("src/index.ts")));
    assert.ok(r.areas.some((g) => g.area === "tests"));
    assert.ok(r.testEvidence.newOrChangedTestFiles.includes("test/xray.test.ts"));
    const real = r.review.findings.filter((f) => f.class === "likely-real");
    assert.ok(real.length >= 1, `expected a likely-real finding, got ${JSON.stringify(r.review.counts)}`);
    assert.ok(r.lookFirst.startsWith("Start here:"), `lookFirst: ${r.lookFirst}`);
    assert.ok(/token_xyz/.test(r.lookFirst));
    assert.deepEqual(r.blockers, []);
  });

  it("a question-style bot comment becomes needs-decision, not noise", async () => {
    const deps: BriefDeps = {
      fetchPullDetail: async () => detail(),
      fetchPullFiles: async () => files(),
      fetchReviews: async () => [] as ReviewStateItem[],
      ...reviewDeps(["should this also apply to the electron pipeline?"]),
    };
    const r = await briefPR("o/r#1", deps);
    assert.ok(
      r.review.findings.some((f) => f.class === "needs-decision"),
      `counts: ${JSON.stringify(r.review.counts)}`
    );
  });

  it("flags no test evidence explicitly when no test files are touched", async () => {
    const deps: BriefDeps = {
      fetchPullDetail: async () => detail(),
      fetchPullFiles: async () => [
        { filename: "src/index.ts", status: "modified" as const, additions: 5, deletions: 2, area: fileArea("src/index.ts") },
      ],
      fetchReviews: async () => [] as ReviewStateItem[],
      ...reviewDeps([]),
    };
    const r = await briefPR("o/r#1", deps);
    assert.ok(/not visible/.test(r.testEvidence.note), `note: ${r.testEvidence.note}`);
  });

  it("lists merge conflicts and unresolved change requests as blockers", async () => {
    const deps: BriefDeps = {
      fetchPullDetail: async () => detail({ mergeable: false, mergeableState: "dirty" }),
      fetchPullFiles: async () => files(),
      fetchReviews: async () => [
        { state: "CHANGES_REQUESTED", author: "pooja-bruno", dismissed: false },
        { state: "CHANGES_REQUESTED", author: "CloudCorpRecords", dismissed: false },
      ] as ReviewStateItem[],
      ...reviewDeps([]),
    };
    const r = await briefPR("o/r#1", deps);
    assert.ok(r.blockers.some((b) => /merge conflicts/.test(b)), `blockers: ${r.blockers.join("; ")}`);
    assert.ok(
      r.blockers.some((b) => /pooja-bruno/.test(b)),
      `blockers: ${r.blockers.join("; ")}`
    );
    // The PR author's own change request is their reply, not a blocker.
    assert.ok(!r.blockers.some((b) => /CloudCorpRecords/.test(b)));
    assert.ok(r.lookFirst.startsWith("Start here:"), `lookFirst: ${r.lookFirst}`);
    assert.ok(/change request/.test(r.lookFirst), `lookFirst: ${r.lookFirst}`);
  });

  it("flags a missing changeset when the repo requires one", async () => {
    const deps: BriefDeps = {
      fetchPullDetail: async () => detail(),
      fetchPullFiles: async () => files(),
      fetchReviews: async () => [] as ReviewStateItem[],
      fetchContributingText: async () =>
        "## Contributing\nAll PRs must include a changeset: run `npx changeset`.",
      ...reviewDeps([]),
    };
    const r = await briefPR("o/r#1", deps);
    assert.ok(
      r.blockers.some((b) => /changeset/.test(b)),
      `blockers: ${r.blockers.join("; ")}`
    );
  });

  it("does not invent findings: degraded sources become unverified notes", async () => {
    const deps: BriefDeps = {
      fetchPullDetail: async () => detail(),
      fetchPullFiles: async () => {
        throw new Error("network down");
      },
      fetchReviews: async () => {
        throw new Error("network down");
      },
      ...reviewDeps([]),
    };
    const r = await briefPR("o/r#1", deps);
    assert.ok(r.unverified.some((u) => /file list/i.test(u)));
    assert.ok(r.unverified.some((u) => /review list/i.test(u)));
    // No fabricated area breakdown, no fabricated blockers.
    assert.deepEqual(r.areas, []);
    assert.deepEqual(r.blockers, []);
  });
});
