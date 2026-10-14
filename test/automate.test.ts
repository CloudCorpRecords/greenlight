import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimIssue,
  prepIssue,
  openPr,
  branchSlugFor,
  buildClaimComment,
  renderPrepDoc,
  gateActions,
  AutomationRefusal,
  type GitHubClient,
} from "../src/automate.js";
import { parseGates } from "../src/gates.js";
import type { IssueSnapshot, LinkedPR } from "../src/types.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function closingPR(number: number, state: LinkedPR["state"] = "open"): LinkedPR {
  return { number, state, title: "feat: thing", url: `https://github.com/o/r/pull/${number}`, linkStrength: "closing" };
}

/** Minimal snapshot factory; tests stay fully offline. */
function makeSnapshot(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    sourceUrl: "https://github.com/shadcn-labs/pdfcn/issues/65",
    owner: "shadcn-labs",
    repo: "pdfcn",
    number: 65,
    state: "open",
    title: "block: Quarterly Report",
    author: "Aniket-508",
    assignees: [],
    labels: ["good first issue", "help wanted"],
    comments: [],
    linkedPRs: [],
    createdAt: daysAgo(20),
    updatedAt: daysAgo(1),
    ...over,
  };
}

class FakeClient implements GitHubClient {
  writes: string[] = [];
  viewer: string | undefined = "tester";
  defaultBranch = "main";
  fork = true;
  branchSha: string | undefined = "abc123def";
  aheadBy = 2;
  aheadCommits: Array<{ sha: string; message: string }> = [
    { sha: "c1a2b3c", message: "feat(blocks): add Quarterly Report block (takumi)\n\nSigned-off-by: tester <t@x.io>" },
    { sha: "d4e5f6d", message: "chore(registry): regenerate output\n\nSigned-off-by: tester <t@x.io>" },
  ];
  commentUrl = "https://github.com/shadcn-labs/pdfcn/issues/65#issuecomment-9";
  prUrl = "https://github.com/shadcn-labs/pdfcn/pull/99";

  async getRepo() {
    return { defaultBranch: this.defaultBranch };
  }
  async getViewer() {
    if (!this.viewer) throw new Error("401");
    return this.viewer;
  }
  async forkExists() {
    return this.fork;
  }
  async createFork() {
    this.writes.push("createFork");
  }
  async getBranchSha(_viewer: string, _repo: string, branch: string) {
    if (branch === this.defaultBranch) return "base-sha-000";
    return this.branchSha;
  }
  async createBranch() {
    this.writes.push("createBranch");
  }
  async compareCommits() {
    return { aheadBy: this.aheadBy, commits: this.aheadCommits };
  }
  async postIssueComment() {
    this.writes.push("postIssueComment");
    return this.commentUrl;
  }
  async createPullRequest() {
    this.writes.push("createPullRequest");
    return this.prUrl;
  }
}

describe("branchSlugFor", () => {
  it("strips a block: label", () => {
    assert.equal(branchSlugFor("block: Resume", 61), "feat/resume-61");
  });
  it("strips a component: label", () => {
    assert.equal(branchSlugFor("component: Addresses", 71), "feat/addresses-71");
  });
  it("caps the slug at 40 chars", () => {
    const slug = branchSlugFor("feat: Build an official pdfcn agent skill for AI coding assistants", 15);
    assert.equal(slug, "feat/build-an-official-pdfcn-agent-skill-for-15");
    assert.ok(!slug.includes("--"), "no double dashes");
    assert.ok(slug.endsWith("-15"), "ends with the issue number");
  });
  it("handles special chars and parentheses", () => {
    const slug = branchSlugFor("fix: history rollback fails to discard messages (repro)", 32);
    assert.ok(slug.startsWith("feat/history-rollback-fails"), `got: ${slug}`);
    assert.ok(slug.endsWith("-32"), `ends with the issue number, got: ${slug}`);
    assert.ok(!slug.includes("--"), "no double dashes");
    assert.ok(!slug.includes("(") && !slug.includes(")"), "parens removed");
  });
  it("falls back to work when the title slugifies to nothing", () => {
    assert.equal(branchSlugFor("!!!", 1), "feat/work-1");
  });
});

describe("buildClaimComment", () => {
  it("plain repo: states intent and comment-first process", () => {
    const snap = makeSnapshot();
    const body = buildClaimComment(snap, parseGates(snap.contributing), "tester");
    assert.ok(body.includes("take this on"), body);
    assert.ok(body.includes("commenting first per the repo's contribution guidelines"), body);
    assert.ok(!body.includes("assign this issue to me"), body);
  });
  it("assignment-gated repo: asks for assignment and promises no early work", () => {
    const snap = makeSnapshot({
      contributing: "Please ask to be assigned before submitting a PR. Wait for a maintainer to assign you.",
    });
    const body = buildClaimComment(snap, parseGates(snap.contributing), "tester");
    assert.ok(body.includes("assign this issue to me"), body);
    assert.ok(body.includes("won't start work until it's assigned"), body);
  });
  it("DCO repo: commits to sign-off", () => {
    const snap = makeSnapshot({ contributing: "Sign off every commit with git commit -s (DCO)." });
    const body = buildClaimComment(snap, parseGates(snap.contributing));
    assert.ok(body.includes("git commit -s"), body);
  });
});

describe("claimIssue", () => {
  let client: FakeClient;
  beforeEach(() => {
    client = new FakeClient();
  });

  it("dry run plans the claim without posting", async () => {
    const plan = await claimIssue(client, makeSnapshot(), { yes: false, force: false });
    assert.equal(plan.executed, false);
    assert.equal(plan.commentUrl, null);
    assert.ok(plan.commentBody.length > 0);
    assert.equal(client.writes.length, 0);
  });

  it("executes with yes=true (needs a token)", async () => {
    process.env.GITHUB_TOKEN = "fake-test-token";
    try {
      const plan = await claimIssue(client, makeSnapshot(), { yes: true, force: false });
      assert.equal(plan.executed, true);
      assert.equal(plan.commentUrl, client.commentUrl);
      assert.deepEqual(client.writes, ["postIssueComment"]);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("refuses a TAKEN verdict without --force", async () => {
    const snap = makeSnapshot({ linkedPRs: [closingPR(95)] });
    await assert.rejects(
      claimIssue(client, snap, { yes: false, force: false }),
      (err: unknown) => err instanceof AutomationRefusal && /TAKEN/.test(err.message)
    );
    assert.equal(client.writes.length, 0);
  });

  it("refuses a STALE verdict without --force", async () => {
    const snap = makeSnapshot({ updatedAt: daysAgo(200) });
    await assert.rejects(
      claimIssue(client, snap, { yes: false, force: false }),
      (err: unknown) => err instanceof AutomationRefusal && /STALE/.test(err.message)
    );
    assert.equal(client.writes.length, 0);
  });

  it("--force overrides a STALE refusal", async () => {
    const snap = makeSnapshot({ updatedAt: daysAgo(200) });
    const plan = await claimIssue(client, snap, { yes: false, force: true });
    assert.equal(plan.executed, false);
    assert.ok(plan.commentBody.length > 0);
    assert.equal(client.writes.length, 0);
  });

  it("refuses a vouch-gated repo (a vouch cannot be automated)", async () => {
    const snap = makeSnapshot({
      contributing: "Contributors must be vouched by a maintainer; unvouched PRs are auto-closed.",
    });
    await assert.rejects(
      claimIssue(client, snap, { yes: false, force: true }),
      (err: unknown) => err instanceof AutomationRefusal && /vouch/i.test(err.message)
    );
    assert.equal(client.writes.length, 0);
  });
});

describe("prepIssue", () => {
  let client: FakeClient;
  let dir: string;
  beforeEach(() => {
    client = new FakeClient();
    dir = mkdtempSync(join(tmpdir(), "greenlight-prep-test-"));
  });

  it("dry run writes PREP.md but makes zero GitHub writes", async () => {
    const plan = await prepIssue(client, makeSnapshot(), { dir, yes: false });
    assert.equal(plan.branch, "feat/quarterly-report-65");
    assert.equal(plan.forkReady, true);
    assert.equal(plan.branchReady, true);
    assert.equal(plan.forkCreated, false);
    assert.equal(plan.branchCreated, false);
    assert.equal(client.writes.length, 0);
    assert.ok(existsSync(plan.prepFile), "PREP.md was written");
  });

  it("execute mode creates a missing fork and branch (needs a token)", async () => {
    process.env.GITHUB_TOKEN = "fake-test-token";
    try {
      client.fork = false;
      client.branchSha = undefined;
      const plan = await prepIssue(client, makeSnapshot(), { dir, yes: true });
      assert.equal(plan.forkCreated, true);
      assert.equal(plan.branchCreated, true);
      assert.deepEqual(client.writes, ["createFork", "createBranch"]);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("PREP.md includes gates and the DCO reminder for DCO repos", () => {
    const snap = makeSnapshot({ contributing: "Sign off every commit with git commit -s (DCO)." });
    const doc = renderPrepDoc({
      snapshot: snap,
      verdict: { verdict: "GO", reasons: ["fine"], claims: [], gates: parseGates(snap.contributing), flags: [] },
      gates: parseGates(snap.contributing),
      branch: "feat/quarterly-report-65",
      viewer: "tester",
      issueUrl: snap.sourceUrl,
    });
    assert.ok(doc.includes("git commit -s"), "DCO reminder present");
    assert.ok(doc.includes("feat/quarterly-report-65"), "branch present");
    assert.ok(doc.includes("greenlight pr"), "next commands present");
  });

  it("gateActions maps every gate kind to an action", () => {
    const gates = parseGates(
      "Ask to be assigned before submitting a PR. Vouched authors only. Sign the CLA. Sign off every commit (DCO). Start a discussion before opening a PR."
    );
    const actions = gateActions(gates);
    assert.ok(actions.some((a) => a.includes("assign")), "assignment action");
    assert.ok(actions.some((a) => a.includes("vouch")), "vouch action");
    assert.ok(actions.some((a) => a.includes("Contributor License Agreement")), "CLA action");
    assert.ok(actions.some((a) => a.includes("git commit -s")), "DCO action");
    assert.ok(actions.some((a) => a.includes("discussion")), "discussion action");
  });
});

describe("openPr", () => {
  let client: FakeClient;
  beforeEach(() => {
    client = new FakeClient();
  });

  it("dry run composes the PR with zero writes", async () => {
    const plan = await openPr(client, makeSnapshot(), { branch: "feat/quarterly-report-65", yes: false });
    assert.equal(plan.executed, false);
    assert.equal(plan.prUrl, null);
    assert.ok(plan.title.startsWith("chore(registry):"), `title from latest commit subject, got: ${plan.title}`);
    assert.ok(plan.body.startsWith("Closes #65."), "body opens with the closing keyword");
    assert.ok(plan.checks.some((c) => c.includes("2 commit(s) ahead")), "ahead check recorded");
    assert.equal(client.writes.length, 0);
  });

  it("executes with yes=true (needs a token)", async () => {
    process.env.GITHUB_TOKEN = "fake-test-token";
    try {
      const plan = await openPr(client, makeSnapshot(), { branch: "feat/quarterly-report-65", yes: true });
      assert.equal(plan.executed, true);
      assert.equal(plan.prUrl, client.prUrl);
      assert.deepEqual(client.writes, ["createPullRequest"]);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("title override is respected", async () => {
    const plan = await openPr(client, makeSnapshot(), { branch: "feat/x", title: "Custom title", yes: false });
    assert.equal(plan.title, "Custom title");
  });

  it("refuses when the branch is missing on the fork", async () => {
    client.branchSha = undefined;
    await assert.rejects(
      openPr(client, makeSnapshot(), { branch: "feat/nope-1", yes: false }),
      (err: unknown) => err instanceof AutomationRefusal && /does not exist/.test(err.message)
    );
    assert.equal(client.writes.length, 0);
  });

  it("refuses when the branch is not ahead of upstream", async () => {
    client.aheadBy = 0;
    client.aheadCommits = [];
    await assert.rejects(
      openPr(client, makeSnapshot(), { branch: "feat/empty-1", yes: false }),
      (err: unknown) => err instanceof AutomationRefusal && /not ahead/.test(err.message)
    );
    assert.equal(client.writes.length, 0);
  });

  it("DCO check fails and lists the unsigned commits", async () => {
    const snap = makeSnapshot({ contributing: "Sign off every commit with git commit -s (DCO)." });
    client.aheadCommits = [
      { sha: "aaa1111", message: "feat: done\n\nSigned-off-by: tester <t@x.io>" },
      { sha: "bbb2222", message: "fix: forgot the sign-off" },
    ];
    await assert.rejects(
      openPr(client, snap, { branch: "feat/dco-1", yes: false }),
      (err: unknown) =>
        err instanceof AutomationRefusal &&
        /Signed-off-by/.test(err.message) &&
        /bbb2222/.test(err.message) &&
        /fix: forgot the sign-off/.test(err.message)
    );
    assert.equal(client.writes.length, 0);
  });

  it("DCO check passes when every commit is signed", async () => {
    const snap = makeSnapshot({ contributing: "Sign off every commit with git commit -s (DCO)." });
    const plan = await openPr(client, snap, { branch: "feat/dco-ok-1", yes: false });
    assert.ok(plan.checks.some((c) => c.includes("DCO")), `DCO check recorded, got: ${plan.checks.join(" | ")}`);
    assert.equal(client.writes.length, 0);
  });
});
