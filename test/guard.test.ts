/**
 * Tests for the maintainer guard: pure detectors over injected data,
 * six corpus fixtures in campaign style, and the orchestration seam
 * (network injected, never live).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractLinkedIssueNumbers,
  findCompetingPRs,
  splitIssueClaims,
  commitHasSignoff,
  checkMissingArtifacts,
  checkFirstTime,
  buildGuardSummary,
  renderGuardMarkdown,
  readGuardConfig,
  defaultGuardConfig,
  guardPr,
  GUARD_COMMENT_MARKER,
  type GuardPullDetail,
  type GuardIssueDetail,
  type GuardRepoConventions,
} from "../src/guard.js";

/** Minimal structural YAML check: indentation-based key paths. */
function yamlGet(doc: string, path: string[]): unknown {
  const lines = doc.split("\n");
  let indent = -1;
  const stack: Array<{ indent: number; key: string }> = [];
  let result: unknown;
  for (const raw of lines) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const m = /^(\s*)([^:#\s][^:]*):(.*)$/.exec(raw);
    if (!m) continue;
    const level = m[1].length;
    const key = m[2].trim();
    while (stack.length > 0 && stack[stack.length - 1].indent >= level) stack.pop();
    stack.push({ indent: level, key });
    const keys = stack.map((s) => s.key);
    if (keys.join("/") === path.join("/")) {
      result = m[3].trim();
    }
  }
  return result;
}
import type { LinkedPR, CommentSignal } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function comment(author: string, body: string, createdAt: string): CommentSignal {
  return { author, body, createdAt };
}

describe("extractLinkedIssueNumbers", () => {
  it("finds closing keywords in the body", () => {
    assert.deepEqual(
      extractLinkedIssueNumbers("Add the thing", "This fixes #123 and also touches #124.", "fix/stuff"),
      [123]
    );
  });
  it("finds #N in the title", () => {
    assert.deepEqual(extractLinkedIssueNumbers("#61: add resume block", "no body links", ""), [61]);
  });
  it("finds the issue number as a token in the branch name", () => {
    assert.deepEqual(extractLinkedIssueNumbers("Fix", "no links", "fix/61-resume-block"), [61]);
  });
  it("does not match bare mentions without closing intent", () => {
    assert.deepEqual(extractLinkedIssueNumbers("Fix", "related to #61, see also #62", ""), []);
  });
  it("claims the branch's own number, not a near miss", () => {
    // feat/610-x claims issue 610; it must never be read as a claim on 61.
    assert.deepEqual(extractLinkedIssueNumbers("Fix", "no links", "feat/610-x"), [610]);
    assert.deepEqual(extractLinkedIssueNumbers("#61 fix", "no links", "feat/610-x"), [61, 610]);
  });
});

describe("findCompetingPRs", () => {
  const linked: LinkedPR[] = [
    { number: 47, state: "open", title: "Fix the thing", url: "u47", linkStrength: "closing" },
    { number: 48, state: "open", title: "Mentioned", url: "u48", linkStrength: "mention" },
    { number: 49, state: "merged", title: "Old fix", url: "u49", linkStrength: "closing" },
    { number: 50, state: "closed", title: "Abandoned", url: "u50", linkStrength: "closing" },
    { number: 51, state: "open", title: "My PR", url: "u51", linkStrength: "closing" },
  ];
  const authors = new Map([[47, "rival"], [51, "me"]]);
  it("returns only other open closing-strength PRs", () => {
    const out = findCompetingPRs(123, linked, 51, authors);
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 47);
    assert.equal(out[0].author, "rival");
    assert.equal(out[0].issueNumber, 123);
  });
  it("returns empty when there is no competition", () => {
    assert.equal(findCompetingPRs(123, linked.slice(3), 51, authors).length, 0);
  });
});

describe("splitIssueClaims", () => {
  const issueAuthor = "reporter";
  const prCreated = "2026-10-15T12:00:00Z";
  it("flags a foreign strong claim that predates the PR", () => {
    const { foreign, authorClaimed } = splitIssueClaims(
      issueAuthor,
      [comment("rival", "I would like to take this on", "2026-10-12T10:00:00Z")],
      "me",
      prCreated,
      123
    );
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0].author, "rival");
    assert.equal(foreign[0].claimedByAuthor, false);
    assert.equal(authorClaimed, null);
  });
  it("ignores claims posted after the PR", () => {
    const { foreign } = splitIssueClaims(
      issueAuthor,
      [comment("rival", "I would like to take this on", "2026-10-16T10:00:00Z")],
      "me",
      prCreated,
      123
    );
    assert.equal(foreign.length, 0);
  });
  it("treats the author's own claim as a pass", () => {
    const { foreign, authorClaimed } = splitIssueClaims(
      issueAuthor,
      [comment("me", "I'll take this on", "2026-10-13T10:00:00Z")],
      "me",
      prCreated,
      123
    );
    assert.equal(foreign.length, 0);
    assert.ok(authorClaimed);
    assert.equal(authorClaimed.author, "me");
    assert.equal(authorClaimed.claimedByAuthor, true);
  });
});

describe("commitHasSignoff", () => {
  it("detects a Signed-off-by trailer", () => {
    assert.equal(commitHasSignoff("fix: thing\n\nSigned-off-by: Rene Turcios <x@y.z>"), true);
  });
  it("is false without one", () => {
    assert.equal(commitHasSignoff("fix: thing\n\nReviewed-by: someone"), false);
  });
});

describe("checkMissingArtifacts", () => {
  const base = {
    conventions: { dcoRequired: false, claRequired: false } as GuardRepoConventions,
    changedFiles: ["src/a.ts"],
    commits: [{ sha: "abc1234", message: "fix: x\n\nSigned-off-by: Me <m@e>" }],
    prLabels: [],
    prAuthor: "me",
    prComments: [],
  };
  it("flags a missing .changes/ file", () => {
    const findings = checkMissingArtifacts({
      ...base,
      conventions: { dcoRequired: false, claRequired: false, changesetDir: ".changes", changesetExample: ".changes/123-slug.md" },
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, "changeset-missing");
    assert.ok(findings[0].evidence.join(" ").includes(".changes/123-slug.md"));
  });
  it("passes when the .changeset/ file is present", () => {
    const findings = checkMissingArtifacts({
      ...base,
      changedFiles: ["src/a.ts", ".changeset/123-slug.md"],
      conventions: { dcoRequired: false, claRequired: false, changesetDir: ".changeset" },
    });
    assert.equal(findings.length, 0);
  });
  it("flags unsigned commits on a DCO repo", () => {
    const findings = checkMissingArtifacts({
      ...base,
      conventions: { dcoRequired: true, claRequired: false },
      commits: [
        { sha: "aaa1111", message: "fix: x" },
        { sha: "bbb2222", message: "fix: y\n\nSigned-off-by: Me <m@e>" },
      ],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, "dco-missing");
    assert.ok(findings[0].title.includes("1 of 2"));
  });
  it("flags CLA status not visible with careful wording", () => {
    const findings = checkMissingArtifacts({
      ...base,
      conventions: { dcoRequired: false, claRequired: true },
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, "cla-status");
    assert.ok(findings[0].evidence.join(" ").includes("absence of evidence"));
  });
  it("passes CLA when the cla-signed label exists", () => {
    const findings = checkMissingArtifacts({
      ...base,
      conventions: { dcoRequired: false, claRequired: true },
      prLabels: ["cla-signed"],
    });
    assert.equal(findings.length, 0);
  });
  it("passes CLA when the author signed in a comment", () => {
    const findings = checkMissingArtifacts({
      ...base,
      conventions: { dcoRequired: false, claRequired: true },
      prComments: [comment("me", "I have read the CLA Document and I hereby sign the CLA", "2026-10-15T13:00:00Z")],
    });
    assert.equal(findings.length, 0);
  });
});

describe("checkFirstTime", () => {
  it("notes a first-time contributor", () => {
    const f = checkFirstTime("newbie", 0);
    assert.ok(f);
    assert.equal(f.severity, "note");
    assert.ok(f.evidence[0].includes("no previously merged PRs"));
  });
  it("returns null with prior merges or a failed lookup", () => {
    assert.equal(checkFirstTime("regular", 5), null);
    assert.equal(checkFirstTime("ghost", null), null);
  });
});

describe("buildGuardSummary and markdown", () => {
  it("says nothing flagged when there are no flags", () => {
    const { summary, hasFindings } = buildGuardSummary([{ check: "first-time", severity: "note", title: "t", evidence: [] }]);
    assert.equal(summary, "Greenlight guard: nothing flagged");
    assert.equal(hasFindings, false);
  });
  it("counts flags and sets hasFindings", () => {
    const { summary, hasFindings } = buildGuardSummary([
      { check: "a", severity: "flag", title: "t", evidence: ["e"] },
      { check: "b", severity: "flag", title: "t", evidence: ["e"] },
      { check: "c", severity: "note", title: "t", evidence: [] },
    ]);
    assert.equal(summary, "Greenlight guard: 2 things to check");
    assert.equal(hasFindings, true);
  });
  it("renders markdown with the hidden marker and the summary", () => {
    const md = renderGuardMarkdown({
      pr: "https://github.com/o/r/pull/1",
      number: 1,
      repo: "o/r",
      title: "Fix",
      author: "me",
      linkedIssues: [],
      competingPRs: [],
      claims: [],
      findings: [{ check: "dco-missing", severity: "flag", title: "DCO sign-off missing", evidence: ["e1"] }],
      summary: "Greenlight guard: 1 thing to check",
      hasFindings: true,
    });
    assert.ok(md.startsWith(GUARD_COMMENT_MARKER));
    assert.ok(md.includes("**Greenlight guard: 1 thing to check**"));
    assert.ok(md.includes("**1. DCO sign-off missing**"));
  });
});

describe("readGuardConfig", () => {
  it("defaults everything to on when the file is missing", () => {
    const cfg = readGuardConfig("/tmp/definitely-not-a-dir-greenlight");
    assert.deepEqual(cfg, defaultGuardConfig());
  });
});

describe("guard corpus fixtures", () => {
  const dir = join(__dirname, "fixtures", "guard-cases");
  const names = readdirSync(dir).filter((f) => f.endsWith(".json"));
  it("loads the six guard fixtures", () => {
    assert.equal(names.length, 6);
  });
  for (const name of names) {
    it(`fixture ${name} has the expected shape`, () => {
      const fx = JSON.parse(readFileSync(join(dir, name), "utf8"));
      assert.ok(fx.prUrl);
      assert.ok(fx.pull);
      assert.ok(Array.isArray(fx.expectFlags));
    });
  }
});

/**
 * Drive the full guard with injected deps for each fixture. The fixture
 * carries the PR, the issue comments, linked PRs, conventions, commits,
 * and labels; the network is never touched.
 */
async function runFixture(name: string) {
  const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", "guard-cases", name), "utf8"));
  const pull: GuardPullDetail = fx.pull;
  const issues: Record<string, GuardIssueDetail> = fx.issues ?? {};
  const linkedPRs: Record<string, LinkedPR[]> = fx.linkedPRs ?? {};
  const authors: Record<string, string> = fx.authors ?? {};
  const conventions: GuardRepoConventions = fx.conventions ?? { dcoRequired: false, claRequired: false };
  const result = await guardPr(fx.prUrl, {
    fetchPull: async () => pull,
    fetchIssue: async (_o, _r, n) => {
      const issue = issues[String(n)];
      if (!issue) throw new Error(`no fixture issue ${n}`);
      return issue;
    },
    fetchLinkedPRs: async (_o, _r, n) => linkedPRs[String(n)] ?? [],
    fetchPRAuthor: async (_o, _r, n) => authors[String(n)] ?? "unknown",
    fetchConventions: async () => conventions,
    fetchPriorMerged: async () => (typeof fx.priorMerged === "number" ? fx.priorMerged : null),
  });
  return { fx, result };
}

describe("action.yml is a valid composite action", () => {
  const doc = readFileSync(join(__dirname, "..", "action.yml"), "utf8");
  it("has no tabs and the required top-level keys", () => {
    assert.ok(!/\t/.test(doc), "action.yml must not contain tabs");
    assert.equal(yamlGet(doc, ["name"]), "Greenlight Guard");
    assert.ok((yamlGet(doc, ["description"]) as string).length > 0);
    assert.equal(yamlGet(doc, ["runs", "using"]), "composite");
  });
  it("runs setup-node, the guard via npx, and github-script", () => {
    assert.ok(doc.includes("actions/setup-node@v4"));
    assert.ok(doc.includes("npx -y @reneturcios/greenlight@latest guard"));
    assert.ok(doc.includes("actions/github-script@v7"));
    assert.ok(doc.includes("greenlight-guard"), "must use the hidden comment marker");
  });
  it("tolerates exit code 3 (findings) as a non-error", () => {
    assert.ok(/-ne 3/.test(doc) || /!= 3/.test(doc), "exit code 3 must be treated as expected");
  });
  it("finds and updates its own comment instead of spamming", () => {
    assert.ok(doc.includes("existing"), "must look up the existing comment");
    assert.ok(doc.includes("updateComment"), "must update the existing comment");
  });
});

describe("guard-workflow.yml example is complete", () => {
  const doc = readFileSync(join(__dirname, "..", "examples", "guard-workflow.yml"), "utf8");
  it("triggers on PR events with pull-requests write permission", () => {
    assert.ok(doc.includes("pull_request"));
    assert.ok(doc.includes("pull-requests: write"));
    assert.ok(doc.includes("CloudCorpRecords/greenlight@"));
  });
  it("points at .greenlight-guard.json for per-repo toggles", () => {
    assert.ok(doc.includes(".greenlight-guard.json"));
  });
});

describe("guard fixture scenarios", () => {
  it("competing-fix flags the other open PR", async () => {
    const { result } = await runFixture("competing-fix.json");
    assert.ok(result.hasFindings);
    assert.ok(result.findings.some((f) => f.check === "competing-fix" && f.severity === "flag"));
    assert.ok(result.markdown.includes("#47"));
  });
  it("foreign-claim flags the earlier claim with claimant and date", async () => {
    const { result } = await runFixture("foreign-claim.json");
    const flag = result.findings.find((f) => f.check === "other-claim");
    assert.ok(flag);
    assert.ok(flag.evidence.join(" ").includes("@rival"));
    assert.ok(flag.evidence.join(" ").includes("2026-10-12"));
  });
  it("author-claim is a note, not a flag", async () => {
    const { result } = await runFixture("author-claim.json");
    assert.equal(result.hasFindings, false);
    assert.ok(result.findings.some((f) => f.check === "author-claim" && f.severity === "note"));
  });
  it("changeset-missing flags the expected pattern", async () => {
    const { result } = await runFixture("changeset-missing.json");
    const flag = result.findings.find((f) => f.check === "changeset-missing");
    assert.ok(flag);
    assert.ok(flag.evidence.join(" ").includes(".changes/123-"));
  });
  it("dco-missing flags unsigned commits", async () => {
    const { result } = await runFixture("dco-missing.json");
    const flag = result.findings.find((f) => f.check === "dco-missing");
    assert.ok(flag);
    assert.ok(flag.title.includes("2 of 2"));
  });
  it("clean PR flags nothing and renders the nothing-flagged summary", async () => {
    const { result } = await runFixture("clean.json");
    assert.equal(result.hasFindings, false);
    assert.equal(result.summary, "Greenlight guard: nothing flagged");
    assert.ok(result.markdown.includes("nothing flagged"));
  });
});
