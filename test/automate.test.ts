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
  detectBranchPattern,
  suggestBranchName,
  extractVerifyCommands,
  gatherRepoConventions,
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
  closedRefs: string[] = [];
  async listClosedPullHeadRefs() {
    return this.closedRefs;
  }
  rootNames: string[] = [];
  async repoRootNames() {
    return this.rootNames;
  }
  rootFiles: Record<string, string> = {};
  async fetchRootFile(_owner: string, _repo: string, path: string) {
    return this.rootFiles[path];
  }
  recentCommits: string[] = [];
  async listRecentCommitMessages() {
    return this.recentCommits;
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
  it("claim-first repo: normal intent comment, NOT the assignment-request variant", () => {
    const snap = makeSnapshot({
      contributing: "Do not claim an issue silently. Comment before starting work.",
    });
    const gates = parseGates(snap.contributing);
    assert.equal(gates.find((g) => g.kind === "claim_first")!.detected, true);
    const body = buildClaimComment(snap, gates, "tester");
    assert.ok(body.includes("commenting first per the repo's contribution guidelines"), body);
    assert.ok(!body.includes("assign this issue to me"), body);
    assert.ok(!body.includes("won't start work until it's assigned"), body);
  });
});

describe("gateActions", () => {
  it("renders a claim-first action", () => {
    const actions = gateActions(parseGates("Comment before starting work on the issue."));
    assert.ok(actions.some((a) => a.includes("greenlight claim") && a.includes("comment-first")), actions.join(" | "));
  });
});

describe("detectBranchPattern", () => {
  const pdfcnRefs = [
    "feat/business-letter-block",
    "feat/resume-block",
    "feat/cover-letter-block",
    "feat/project-proposal-block",
    "feat/quarterly-report-block",
  ];
  it("finds the dominant suffix token (pdfcn style)", () => {
    const p = detectBranchPattern(pdfcnRefs)!;
    assert.equal(p.prefix, "feat");
    assert.equal(p.suffix, "block");
  });
  it("returns undefined for mixed refs with no dominant pattern", () => {
    assert.equal(detectBranchPattern(["feat/a", "fix/b", "docs/c", "chore/d"]), undefined);
  });
  it("returns undefined below the 3-branch threshold", () => {
    assert.equal(
      detectBranchPattern(["feat/x-block", "feat/y-block", "fix/z-other"]),
      undefined
    );
  });
  it("numeric last tokens yield a prefix-only pattern (no suffix)", () => {
    const p = detectBranchPattern(["feat/resume-61", "feat/addresses-71", "feat/letter-60"])!;
    assert.equal(p.prefix, "feat");
    assert.equal(p.suffix, null);
  });
  it("prefix-only pattern collapses back to the default name", () => {
    const s = suggestBranchName("block: Resume", 61, ["feat/resume-9", "feat/other-8", "feat/more-7"]);
    assert.equal(s.branch, "feat/resume-61");
    assert.equal(s.note, "");
  });
});

describe("suggestBranchName", () => {
  const pdfcnRefs = [
    "feat/business-letter-block",
    "feat/resume-block",
    "feat/cover-letter-block",
    "feat/project-proposal-block",
  ];
  it("uses the repo suffix pattern instead of the issue number", () => {
    const s = suggestBranchName("block: Quarterly Report", 65, pdfcnRefs);
    assert.equal(s.branch, "feat/quarterly-report-block");
    assert.equal(s.defaultName, "feat/quarterly-report-65");
    assert.ok(s.note.includes("-block"), s.note);
  });
  it("falls back to the default with no pattern", () => {
    const s = suggestBranchName("block: Quarterly Report", 65, ["feat/a", "fix/b"]);
    assert.equal(s.branch, "feat/quarterly-report-65");
    assert.equal(s.note, "");
  });
  it("adopts a dominant non-feat prefix and keeps the number when there is no suffix", () => {
    const s = suggestBranchName("fix: parser bug", 12, ["fix/a-1", "fix/b-2", "fix/c-3"]);
    assert.equal(s.branch, "fix/parser-bug-12");
    assert.ok(s.note.includes("fix/"), s.note);
  });
  it("does not double the suffix when the title already ends with it", () => {
    const s = suggestBranchName("block: Report block", 65, [
      "feat/a-block",
      "feat/b-block",
      "feat/c-block",
    ]);
    assert.equal(s.branch, "feat/report-block");
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
    assert.equal(plan.branchDefault, "feat/quarterly-report-65");
    assert.equal(plan.branchPatternNote, "");
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

  it("learns the branch convention from recent closed PRs", async () => {
    client.closedRefs = [
      "feat/business-letter-block",
      "feat/resume-block",
      "feat/cover-letter-block",
      "feat/project-proposal-block",
    ];
    const plan = await prepIssue(client, makeSnapshot(), { dir, yes: false });
    assert.equal(plan.branch, "feat/quarterly-report-block");
    assert.equal(plan.branchDefault, "feat/quarterly-report-65");
    assert.ok(plan.branchPatternNote.includes("-block"), plan.branchPatternNote);
    assert.ok(existsSync(plan.prepFile), "PREP.md was written");
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

  it("PREP.md shows the learned branch pattern alongside the default", () => {
    const snap = makeSnapshot();
    const doc = renderPrepDoc({
      snapshot: snap,
      verdict: { verdict: "GO", reasons: ["fine"], claims: [], gates: [], flags: [] },
      gates: [],
      branch: "feat/quarterly-report-block",
      branchDefault: "feat/quarterly-report-65",
      branchNote: "repo convention from recent PRs: feat/<slug>-block",
      viewer: "tester",
      issueUrl: snap.sourceUrl,
    });
    assert.ok(doc.includes("feat/quarterly-report-block"), "suggested branch present");
    assert.ok(doc.includes("feat/quarterly-report-65"), "default branch present");
  });

  it("gateActions maps every gate kind to an action", () => {
    const gates = parseGates(
      "Ask to be assigned before submitting a PR. Vouched authors only. Sign the CLA. Sign off every commit (DCO). Start a discussion before opening a PR. Comment before starting work."
    );
    const actions = gateActions(gates);
    assert.ok(actions.some((a) => a.includes("assign")), "assignment action");
    assert.ok(actions.some((a) => a.includes("vouch")), "vouch action");
    assert.ok(actions.some((a) => a.includes("Contributor License Agreement")), "CLA action");
    assert.ok(actions.some((a) => a.includes("git commit -s")), "DCO action");
    assert.ok(actions.some((a) => a.includes("discussion")), "discussion action");
    assert.ok(actions.some((a) => a.includes("comment-first")), "claim-first action");
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

describe("extractVerifyCommands", () => {
  it("finds backticked run commands in house-rules text", () => {
    assert.deepEqual(
      extractVerifyCommands("Run `pnpm verify` as one command, not `npm test`."),
      ["pnpm verify", "npm test"]
    );
  });

  it("dedupes and caps at five", () => {
    const cmds = extractVerifyCommands("`pnpm a` `pnpm a` `pnpm b` `pnpm c` `pnpm d` `pnpm e` `pnpm f`");
    assert.deepEqual(cmds, ["pnpm a", "pnpm b", "pnpm c", "pnpm d", "pnpm e"]);
  });

  it("returns nothing when no commands are quoted", () => {
    assert.deepEqual(extractVerifyCommands("Run the checks."), []);
  });
});

describe("gatherRepoConventions", () => {
  const snapshotFor = (houseRules: { file: string; text: string }[]): IssueSnapshot => ({
    sourceUrl: "https://github.com/reticlehq/reticle/issues/894",
    owner: "reticlehq",
    repo: "reticle",
    number: 894,
    state: "open",
    title: "The destructive-action block names a retry a flow cannot perform",
    author: "divshekhar",
    assignees: [],
    labels: [],
    comments: [],
    linkedPRs: [],
    createdAt: "2026-09-08T10:00:00Z",
    updatedAt: "2026-10-13T10:00:00Z",
    houseRules,
  });

  it("detects house rules, verify command, .changes dir, scripts, and commit style", async () => {
    const client = new FakeClient();
    client.rootNames = ["AGENTS.md", ".changes", "package.json"];
    client.rootFiles["package.json"] = JSON.stringify({
      scripts: { test: "vitest", verify: "turbo run verify", lint: "eslint ." },
    });
    client.recentCommits = [
      "fix(browser): judge selectable items by their own label",
      "feat(server): fall back to the connected tab",
      "chore(release): 3.7.0",
    ];
    const c = await gatherRepoConventions(
      client,
      snapshotFor([
        { file: "AGENTS.md", text: "Run `pnpm verify` as one command." },
        { file: "CONTRIBUTING.md", text: "Comment before starting work." },
      ])
    );
    assert.ok(c);
    assert.deepEqual(c.houseRuleFiles, ["AGENTS.md", "CONTRIBUTING.md"]);
    assert.deepEqual(c.verifyCommands, ["pnpm verify"]);
    assert.equal(c.changesDir, true);
    assert.equal(c.changesDirName, ".changes");
    assert.deepEqual(c.packageScripts, ["test", "verify", "lint"]);
    assert.equal(c.conventionalCommits, true);
    assert.ok(c.exampleCommit!.startsWith("fix(browser):"));
  });

  it("returns undefined when nothing is detectable", async () => {
    const client = new FakeClient();
    const c = await gatherRepoConventions(client, snapshotFor([]));
    assert.equal(c, undefined);
  });

  it("survives failing probes individually", async () => {
    const client = new FakeClient();
    client.rootNames = [];
    const c = await gatherRepoConventions(
      client,
      snapshotFor([{ file: "AGENTS.md", text: "Run the checks first." }])
    );
    assert.ok(c);
    assert.deepEqual(c.houseRuleFiles, ["AGENTS.md"]);
    assert.deepEqual(c.verifyCommands, []);
    assert.equal(c.changesDir, false);
    assert.deepEqual(c.packageScripts, []);
    assert.equal(c.conventionalCommits, false);
  });

  it("does not claim Conventional Commits for a mixed history", async () => {
    const client = new FakeClient();
    client.recentCommits = [
      "fix: thing",
      "random message here",
      "another random one",
      "wip",
    ];
    const c = await gatherRepoConventions(client, snapshotFor([]));
    assert.ok(c === undefined || c.conventionalCommits === false);
  });

  it("renders the conventions section in PREP.md", async () => {
    const client = new FakeClient();
    client.rootNames = [".changes"];
    const plan = await prepIssue(
      client,
      snapshotFor([{ file: "AGENTS.md", text: "Run `pnpm verify` as one command." }]),
      { yes: false, dir: "/tmp/greenlight-prep-test" }
    );
    assert.ok(plan.conventions);
    const doc = readFileSync(plan.prepFile, "utf8");
    assert.ok(doc.includes("## Repo conventions"));
    assert.ok(doc.includes("AGENTS.md"));
    assert.ok(doc.includes("pnpm verify"));
    assert.ok(doc.includes(".changes"));
  });
});
