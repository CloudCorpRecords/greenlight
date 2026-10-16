/**
 * Tests for the maintainer guard: pure detectors over injected data,
 * nine corpus fixtures in campaign style, and the orchestration seam
 * (network injected, never live).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractLinkedIssueNumbers,
  extractCrossRepoIssues,
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
import { detectChangesetConvention } from "../src/prep-detail.js";
import { titleSlug } from "../src/automate.js";
import { assembleProtocolState } from "../src/protocol-fetch.js";
import { defaultClaimsPolicy, CLAIM_MARKER } from "../src/protocol.js";

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
  it("does not claim version numbers in dependabot branches as issues", () => {
    // dependabot/npm_and_yarn/vitest-5.0.4 must not read as issues #5 or #4.
    // Found live: the digest grouped dependabot bump PRs into phantom
    // races on ancient PRs #1/#4/#5 in ComposioHQ/composio (2026-10-16).
    assert.deepEqual(
      extractLinkedIssueNumbers("chore(deps): bump vitest from 4.1.11 to 5.0.4", "", "dependabot/npm_and_yarn/vitest-5.0.4"),
      []
    );
    assert.deepEqual(
      extractLinkedIssueNumbers("chore(deps): bump qs from 6.15.3 to 6.16.0", "", "dependabot/npm_and_yarn/qs-6.16.0"),
      []
    );
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
  it("loads the nine guard fixtures", () => {
    assert.equal(names.length, 9);
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
    fetchIssue: async (o, r, n) => {
      const issue = issues[`${o}/${r}#${n}`] ?? issues[String(n)];
      if (!issue) throw new Error(`no fixture issue ${n}`);
      return issue;
    },
    fetchLinkedPRs: async (o, r, n) => linkedPRs[`${o}/${r}#${n}`] ?? linkedPRs[String(n)] ?? [],
    fetchPRAuthor: async (_o, _r, n) => authors[String(n)] ?? "unknown",
    fetchConventions: async () => conventions,
    fetchPriorMerged: async () => (typeof fx.priorMerged === "number" ? fx.priorMerged : null),
    fetchProtocol: async (o, r, n) => {
      const input = fx.protocolInput;
      if (!input) return null;
      // The fixture's protocol input drives the real engine; the network
      // is never touched, but the claim math is the production code path.
      return assembleProtocolState(
        o,
        r,
        n,
        input.comments ?? [],
        input.reactions ?? [],
        [],
        null,
        {
          honored: true,
          policy: input.policy ?? defaultClaimsPolicy(),
          invalid: false,
        },
        "2026-10-15T12:00:00Z"
      );
    },
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
  it("stale-claim flags the old claim and notes its age", async () => {
    // firecrawl#839 shape: "If not, I can pick it up." posted 374 days
    // before the PR. The flag must survive, with an age annotation.
    const { result } = await runFixture("stale-claim.json");
    const flag = result.findings.find((f) => f.check === "other-claim");
    assert.ok(flag);
    const text = flag.evidence.join(" ");
    assert.ok(text.includes("@rival"));
    assert.ok(text.includes("374 days"));
    assert.ok(text.includes("may have been abandoned"));
    assert.equal(flag.severity, "flag");
  });
  it("changeset example uses a title slug, never a doubled number", () => {
    // Regression for the guard rendering ".changeset/4668-pr-4668.md":
    // the slug fed to detectChangesetConvention must be a title slug
    // (what prep passes), not `pr-<issueNumber>`.
    const convention = detectChangesetConvention({
      rootNames: [".changeset"],
      policyText: "",
      issueNumber: 4668,
      slug: titleSlug("Fix time format"),
    });
    assert.ok(convention);
    assert.equal(convention.example, ".changeset/4668-fix-time-format.md");
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
  it("protocol-foreign-claim flags an active protocol claim held by someone else", async () => {
    const { result } = await runFixture("protocol-foreign-claim.json");
    const flag = result.findings.find((f) => f.check === "protocol-claim");
    assert.ok(flag, JSON.stringify(result.findings.map((f) => f.check)));
    assert.equal(flag.severity, "flag");
    assert.ok(flag.title.includes("@rival"), flag.title);
    const evidence = flag.evidence.join(" ");
    assert.ok(evidence.includes("2026-10-13"), evidence); // claimed date
    assert.ok(evidence.includes("2026-10-20"), evidence); // expiry: 7-day lease
    assert.ok(evidence.includes("join it instead of duplicating"), evidence);
  });

  it("protocol claim branches: author-held is a note, completed is neither", async () => {
    const pull: GuardPullDetail = {
      title: "Fix #300",
      body: "Fixes #300",
      author: "me",
      headRef: "fix/300-x",
      createdAt: "2026-10-15T12:00:00Z",
      labels: [],
      changedFiles: ["src/widget.ts"],
      commits: [{ sha: "aaa1111111", message: "fix: widget\n\nSigned-off-by: Me <me@example.com>" }],
      comments: [],
    };
    const runWithProtocol = (comments: Array<{ id: number; author: string; body: string; createdAt: string }>, linkedPrInputs: Array<{ number: number; state: "open" | "closed" | "merged"; createdAt: string }> = []) =>
      guardPr("https://github.com/o/r/pull/70", {
        fetchPull: async () => pull,
        fetchIssue: async () => ({ number: 300, title: "Issue 300", author: "reporter", state: "open", comments: [] }),
        fetchLinkedPRs: async () => [],
        fetchPRAuthor: async () => "unknown",
        fetchConventions: async () => ({ dcoRequired: false, claRequired: false }),
        fetchPriorMerged: async () => 1,
        fetchProtocol: async (o, r, n) =>
          assembleProtocolState(
            o,
            r,
            n,
            comments.map((c) => ({ ...c, url: `https://github.com/o/r/issues/300#issuecomment-${c.id}` })),
            [],
            linkedPrInputs,
            null,
            { honored: true, policy: defaultClaimsPolicy(), invalid: false },
            "2026-10-15T12:00:00Z"
          ),
      });

    const authorHeld = await runWithProtocol([
      { id: 1, author: "me", body: `I'll take this.\n\n${CLAIM_MARKER}\n`, createdAt: "2026-10-13T10:00:00Z" },
    ]);
    const note = authorHeld.findings.find((f) => f.check === "protocol-claim");
    assert.ok(note, "author-held claim must produce a protocol-claim finding");
    assert.equal(note.severity, "note");

    const completed = await runWithProtocol(
      [{ id: 1, author: "rival", body: `I'll take this.\n\n${CLAIM_MARKER}\n`, createdAt: "2026-10-10T10:00:00Z" }],
      [{ number: 55, state: "merged", createdAt: "2026-10-11T10:00:00Z" }]
    );
    assert.ok(
      !completed.findings.some((f) => f.check === "protocol-claim"),
      "completed claims are neither flag nor note"
    );
  });
  it("cross-repo fixture flags the competing fix and the foreign claim with cross-repo evidence", async () => {
    // PR opened in otherorg/repo-b with body "Fixes acme/widgets#123";
    // the widgets issue has a foreign strong claim predating the PR and
    // another open PR in widgets claiming it.
    const { result } = await runFixture("cross-repo.json");
    assert.equal(result.hasFindings, true);
    const checks = result.findings.map((f) => f.check).sort();
    assert.deepEqual(checks, ["competing-fix", "other-claim"]);
    const comp = result.findings.find((f) => f.check === "competing-fix");
    assert.ok(comp);
    assert.ok(comp.title.includes("acme/widgets#123"), comp.title);
    assert.ok(comp.evidence.join(" ").includes("acme/widgets#123"));
    assert.ok(comp.evidence.join(" ").includes("#99"), "names the competing PR");
    const claim = result.findings.find((f) => f.check === "other-claim");
    assert.ok(claim);
    assert.ok(claim.evidence.join(" ").includes("acme/widgets#123"));
    assert.ok(claim.evidence.join(" ").includes("@rival"));
    // The linked issue resolves to the referenced repo's issue page.
    assert.ok(result.linkedIssues.some((i) => i.url === "https://github.com/acme/widgets/issues/123"));
    // The claims and competing PRs carry the cross-repo reference.
    assert.ok(result.claims.some((c) => c.issueRef === "acme/widgets#123"));
    assert.ok(result.competingPRs.some((c) => c.issueRef === "acme/widgets#123"));
  });
});

describe("extractCrossRepoIssues", () => {
  const own = (title: string, body: string) => extractCrossRepoIssues(title, body, "otherorg", "repo-b");

  it("parses 'Fixes owner/repo#123' as a cross-repo closing reference", () => {
    assert.deepEqual(own("Fix widgets", "Fixes acme/widgets#123"), [
      { owner: "acme", repo: "widgets", number: 123 },
    ]);
  });

  it("parses closing keyword plus a full issue URL", () => {
    assert.deepEqual(own("Fix widgets", "Closes https://github.com/acme/widgets/issues/123"), [
      { owner: "acme", repo: "widgets", number: 123 },
    ]);
  });

  it("parses an issue URL in the title as author intent", () => {
    assert.deepEqual(own("https://github.com/acme/widgets/issues/123: fix the bug", "no links"), [
      { owner: "acme", repo: "widgets", number: 123 },
    ]);
  });

  it("ignores plain mentions without closing intent", () => {
    assert.deepEqual(own("Fix widgets", "see acme/widgets#123 for context, related to foo/bar#7"), []);
  });

  it("does not treat same-repo '#123' as cross-repo", () => {
    assert.deepEqual(own("Fix #123", "Fixes #123"), []);
  });

  it("skips references pointing back at the PR's own repo", () => {
    assert.deepEqual(own("Fix", "Fixes otherorg/repo-b#61"), []);
  });

  it("collects multiple references and dedupes", () => {
    assert.deepEqual(own("Fix", "Fixes acme/widgets#123 and closes foo/bar#456. Also fixes acme/widgets#123."), [
      { owner: "acme", repo: "widgets", number: 123 },
      { owner: "foo", repo: "bar", number: 456 },
    ]);
  });

  it("requires the reference to follow a closing keyword, not the keyword itself later", () => {
    // "Fixes the widget. acme/widgets#123 is the issue" — the reference
    // is not aimed at a closing keyword, so it must not count.
    assert.deepEqual(own("Fix", "Fixes the widget. acme/widgets#123 is the issue"), []);
  });
});
