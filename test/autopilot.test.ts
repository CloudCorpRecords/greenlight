/**
 * Autopilot end-to-end tests with fully injected dependencies (v0.11.0).
 *
 * Report mode classifies feedback and plans fixes; --apply performs the
 * mechanical DCO surgery against the fake Git Data API; a repo recorded as
 * blocked in the capability ledger is skipped; watermarks advance.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAutopilot,
  loadAutopilotState,
  repoIsBlocked,
  recordCapability,
  loadCapabilities,
  type AutopilotPull,
  type AutopilotDeps,
  type CapabilityRecord,
} from "../src/autopilot.js";
import type { CommitObject } from "../src/autopilot-git.js";

function pull(over: Partial<AutopilotPull> = {}): AutopilotPull {
  return {
    owner: "o",
    repo: "r",
    number: 1,
    url: "https://github.com/o/r/pull/1",
    title: "Test PR",
    author: "CloudCorpRecords",
    headSha: "head1",
    baseRef: "main",
    baseSha: "base1",
    mergeable: true,
    mergeableState: "clean",
    forkOwner: "CloudCorpRecords",
    forkRepo: "r",
    forkBranch: "fix/x",
    forkCloneUrl: "https://github.com/CloudCorpRecords/r.git",
    ...over,
  };
}

function deps(over: Partial<AutopilotDeps> = {}): AutopilotDeps {
  return {
    expectedForkOwner: "CloudCorpRecords",
    discoverPrs: async () => [
      { owner: "o", repo: "r", number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "open" as const, merged: false, author: "CloudCorpRecords", createdAt: "", updatedAt: "" },
    ],
    fetchPr: async () => pull(),
    triageCi: async () => ({ checks: [] }),
    fetchReviewSources: async () => ({
      reviews: [],
      reviewComments: [],
      issueComments: [],
      maxIds: { reviewId: 0, reviewCommentId: 0, issueCommentId: 0 },
    }),
    ...over,
  };
}

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-test-"));
  return {
    state: join(dir, "autopilot.json"),
    replies: join(dir, "replies.json"),
    caps: join(dir, "caps.json"),
  };
}

describe("capability ledger", () => {
  it("degrades gracefully when the file is absent", () => {
    const records = loadCapabilities("/tmp/definitely-not-here-12345.json");
    assert.deepEqual(records, []);
    assert.equal(repoIsBlocked(records, "o/r"), null);
  });

  it("detects a blocked repo", () => {
    const records: CapabilityRecord[] = [
      { repo: "o/r", action: "pr_create", outcome: "blocked-422", evidence: "user is blocked", at: "2026-10-18T00:00:00Z" },
    ];
    const hit = repoIsBlocked(records, "o/r");
    assert.ok(hit);
    assert.equal(hit.outcome, "blocked-422");
  });

  it("records and reads back in a canonical shape", () => {
    const p = tmpPaths();
    recordCapability(p.caps, { repo: "o/r", action: "pr_create", outcome: "ok", evidence: "PR #1", at: "t" });
    const records = loadCapabilities(p.caps);
    assert.equal(records.length, 1);
    assert.equal(records[0].evidence, "PR #1");
  });
});

describe("runAutopilot report mode", () => {
  it("classifies CI and review feedback, plans fixes, writes watermarks", async () => {
    const p = tmpPaths();
    const run = await runAutopilot({
      statePath: p.state,
      repliesPath: p.replies,
      capabilitiesPath: p.caps,
      deps: deps({
        triageCi: async () => ({
          checks: [
            { name: "build", conclusion: "failure", class: "likely-yours", evidence: "compile error", failureLines: ["error TS1"] } as never,
            { name: "flaky", conclusion: "failure", class: "pre-existing", evidence: "flaky on base" } as never,
          ],
        }),
        fetchReviewSources: async () => ({
          reviews: [{ id: 7, state: "CHANGES_REQUESTED", body: "please fix", user: { login: "maintainer" } }],
          reviewComments: [],
          issueComments: [],
          maxIds: { reviewId: 7, reviewCommentId: 0, issueCommentId: 0 },
        }),
      }),
    });
    assert.equal(run.summary.prsScanned, 1);
    assert.equal(run.summary.fixesPushed, 0);
    assert.equal(run.summary.itemsByKind.ci_failure, 2);
    assert.equal(run.summary.ciIntroduced, 1);
    assert.equal(run.summary.ciPreExistingOrExternal, 1);
    assert.equal(run.summary.itemsByKind.review_change_request, 1);
    assert.equal(run.summary.itemsByKind.maintainer_question, 1);
    assert.ok(run.summary.plans > 0);
    // Watermark advanced.
    const state = loadAutopilotState(p.state);
    assert.equal(state.prs["https://github.com/o/r/pull/1"].lastReviewId, 7);
    assert.equal(state.prs["https://github.com/o/r/pull/1"].lastHeadSha, "head1");
    // No replies queued for plans.
    assert.ok(!existsSync(p.replies));
    // Footer carries the version.
    assert.ok(run.markdown.includes("Greenlight autopilot v"));
  });

  it("verifies bot findings and queues a rebuttal draft for false positives", async () => {
    const p = tmpPaths();
    const run = await runAutopilot({
      statePath: p.state,
      repliesPath: p.replies,
      capabilitiesPath: p.caps,
      deps: deps({
        fetchReviewSources: async () => ({
          reviews: [],
          reviewComments: [
            {
              id: 9,
              body: "Remove `function phantom() {}` before merging.",
              user: { login: "cubic-dev-ai" },
              path: "src/x.ts",
            },
          ],
          issueComments: [],
          maxIds: { reviewId: 0, reviewCommentId: 9, issueCommentId: 0 },
        }),
        fetchFileAtHead: async () => "export const x = 1;",
      }),
    });
    assert.equal(run.summary.botVerdicts.falsePositive, 1);
    assert.equal(run.summary.repliesQueued, 1);
    const replies = JSON.parse(readFileSync(p.replies, "utf8")) as { replies: Array<{ draft: string; queuedReason: string }> };
    assert.equal(replies.replies.length, 1);
    assert.ok(replies.replies[0].queuedReason.includes("comment block"));
    assert.ok(replies.replies[0].draft.includes("phantom"));
  });

  it("skips repos recorded as blocked", async () => {
    const p = tmpPaths();
    recordCapability(p.caps, {
      repo: "o/r",
      action: "pr_create",
      outcome: "blocked-422",
      evidence: "user is blocked",
      at: "2026-10-18T00:00:00Z",
    });
    const run = await runAutopilot({
      statePath: p.state,
      repliesPath: p.replies,
      capabilitiesPath: p.caps,
      deps: deps(),
    });
    assert.equal(run.summary.prsSkippedBlocked, 1);
    assert.equal(run.summary.prsScanned, 0);
  });
});

describe("runAutopilot --apply", () => {
  it("fixes a DCO gap with tree-identical surgery and drafts a reply", async () => {
    const p = tmpPaths();
    const commits: Record<string, CommitObject> = {
      a: {
        sha: "a", treeSha: "tree-a", message: "first\n\nSigned-off-by: Rene Turcios <x@y>",
        parents: [], authorName: "R", authorEmail: "e", committerName: "R", committerEmail: "e",
      },
      b: {
        sha: "b", treeSha: "tree-b", message: "second",
        parents: ["a"], authorName: "R", authorEmail: "e", committerName: "R", committerEmail: "e",
      },
    };
    const created: string[] = [];
    const moved: Array<{ branch: string; sha: string; force: boolean }> = [];
    const gitOps = {
      getCommit: async (_o: string, _r: string, sha: string) => {
        const c = commits[sha];
        if (!c) throw new Error("unknown " + sha);
        return c;
      },
      createCommit: async (_o: string, _r: string, args: { message: string; tree: string; parents: string[] }) => {
        const sha = "new-" + args.tree;
        created.push(sha);
        commits[sha] = { sha, treeSha: args.tree, message: args.message, parents: args.parents, authorName: "R", authorEmail: "e", committerName: "R", committerEmail: "e" };
        return sha;
      },
      updateRef: async (_o: string, _r: string, branch: string, sha: string, force: boolean) => {
        assert.equal(branch, "fix/x");
        assert.ok(force);
        moved.push({ branch, sha, force });
      },
      getRef: async () => "b",
      createBlob: async () => "blob",
      createTree: async () => "tree",
    };
    const run = await runAutopilot({
      statePath: p.state,
      repliesPath: p.replies,
      capabilitiesPath: p.caps,
      apply: true,
      maxFixes: 5,
      deps: deps({
        fetchPrCommits: async () => ["a", "b"],
        gitOps: gitOps as never,
      }),
    });
    // One DCO fix applied: b rewritten, a anchored.
    assert.equal(run.summary.fixesPushed, 1);
    assert.equal(run.perPr[0].fixes[0].kind, "dco");
    assert.equal(run.perPr[0].fixes[0].oldHead, "b");
    assert.equal(run.perPr[0].fixes[0].newHead, "new-tree-b");
    assert.deepEqual(moved, [{ branch: "fix/x", sha: "new-tree-b", force: true }]);
    // The replacement commit carries the sign-off and the same tree.
    assert.ok(commits["new-tree-b"].message.includes("Signed-off-by: Rene Turcios"));
    assert.equal(commits["new-tree-b"].treeSha, "tree-b");
    // A reply draft queued for the fix.
    assert.equal(run.summary.repliesQueued, 1);
    // Capability outcome recorded.
    const caps = loadCapabilities(p.caps);
    assert.ok(caps.some((c) => c.action === "autopilot_fix:dco" && c.outcome === "ok"));
  });
});
