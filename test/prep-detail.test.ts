import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectClaPath,
  detectChangesetConvention,
  detectSatelliteRepo,
  detectFixLivesHere,
  buildHouseRulesSummary,
  gatherPrepDetail,
  type PolicyText,
} from "../src/prep-detail.js";
import { renderPrepDoc } from "../src/automate.js";
import type { IssueSnapshot, VerdictResult } from "../src/types.js";

const src = (file: string, text: string): PolicyText => ({ file, text });

const goVerdict: VerdictResult = { verdict: "GO", reasons: ["looks landable"], claims: [], gates: [], flags: [] };

function makeSnapshot(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    sourceUrl: "https://github.com/o/r/issues/1",
    owner: "o",
    repo: "r",
    number: 1,
    state: "open",
    title: "feat: something useful",
    author: "someone",
    assignees: [],
    labels: [],
    comments: [],
    linkedPRs: [],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
    ...over,
  };
}

describe("detectClaPath: fastmcp shape (cla-assistant + assignment)", () => {
  const sources = [
    src("CONTRIBUTING.md", "Sign the CLA with CLA Assistant before submitting a PR.\nPlease request an assignment before submitting a PR; you must be assigned first."),
  ];
  it("names cla-assistant with the signature phrase", () => {
    const c = detectClaPath(sources);
    assert.equal(c.kind, "cla-assistant");
    assert.equal(c.link, "https://cla-assistant.io");
    assert.equal(c.signaturePhrase, "I have read the CLA Document and I hereby sign the CLA");
  });
});

describe("detectClaPath: n8n shape (custom CLA bot)", () => {
  const sources = [
    src("CONTRIBUTING.md", "Please sign our CLA at https://cla-bot-prod.users.n8n.cloud/webhook/cla via GitHub OAuth before we can merge your PR."),
  ];
  it("extracts the custom signing page URL", () => {
    const c = detectClaPath(sources);
    assert.equal(c.kind, "custom-cla-bot");
    assert.equal(c.link, "https://cla-bot-prod.users.n8n.cloud/webhook/cla");
  });
});

describe("detectClaPath: reticle shape (DCO instead of CLA)", () => {
  const sources = [
    src("AGENTS.md", "Comment on the issue before starting work. All commits must carry a Signed-off-by trailer; DCO is enforced by a check."),
  ];
  it("names DCO with the git commit -s instruction", () => {
    const c = detectClaPath(sources);
    assert.equal(c.kind, "dco");
    assert.match(c.method, /git commit -s/);
  });
});

describe("detectClaPath: no signing requirement", () => {
  it("returns kind none with a plain statement", () => {
    const c = detectClaPath([src("CONTRIBUTING.md", "Thanks for contributing! Please write clear commit messages.")]);
    assert.equal(c.kind, "none");
    assert.match(c.method, /No CLA or DCO requirement detected/);
  });
});

describe("detectClaPath: CLA plus DCO notes both", () => {
  it("keeps the CLA primary and notes the DCO", () => {
    const c = detectClaPath([
      src("CONTRIBUTING.md", "Sign the Contributor License Agreement via CLA Assistant. Also add a Signed-off-by trailer to every commit (DCO)."),
    ]);
    assert.equal(c.kind, "cla-assistant");
    assert.equal(c.notes.length, 1);
    assert.match(c.notes[0], /DCO/);
  });
});

describe("detectChangesetConvention", () => {
  it("changesets: pattern and issue-numbered example", () => {
    const c = detectChangesetConvention({
      rootNames: [".changeset", "package.json"],
      policyText: "",
      issueNumber: 123,
      slug: "fix-timeout",
    });
    assert.equal(c?.style, "changesets");
    assert.equal(c?.pattern, ".changeset/*.md");
    assert.equal(c?.example, ".changeset/123-fix-timeout.md");
  });
  it("reticle .changes/ shape: one file per issue", () => {
    const c = detectChangesetConvention({
      rootNames: [".changes", "AGENTS.md"],
      policyText: "",
      issueNumber: 1147,
      slug: "blocker",
    });
    assert.equal(c?.style, "changes-dir");
    assert.equal(c?.example, ".changes/1147-blocker.md");
  });
  it("towncrier: towncrier.toml config", () => {
    const c = detectChangesetConvention({
      rootNames: ["towncrier.toml"],
      policyText: "",
      issueNumber: 42,
      slug: "thing",
    });
    assert.equal(c?.style, "towncrier");
    assert.equal(c?.example, "newsfragments/42.bugfix.md");
  });
  it("towncrier: [tool.towncrier] in pyproject", () => {
    const c = detectChangesetConvention({
      rootNames: ["pyproject.toml"],
      policyText: "",
      pyprojectText: '[project]\nname = "x"\n\n[tool.towncrier]\ndirectory = "newsfragments"',
      issueNumber: 42,
      slug: "thing",
    });
    assert.equal(c?.style, "towncrier");
  });
  it("changelog-notes: CONTRIBUTING asks for a changelog entry", () => {
    const c = detectChangesetConvention({
      rootNames: [],
      policyText: "Please update the CHANGELOG with a note about your change under Unreleased.",
      policySource: "CONTRIBUTING.md",
      issueNumber: 7,
      slug: "x",
    });
    assert.equal(c?.style, "changelog-notes");
    assert.equal(c?.pattern, "CHANGELOG.md");
  });
  it("returns undefined when nothing is detectable", () => {
    const c = detectChangesetConvention({ rootNames: ["README.md"], policyText: "no release notes here", issueNumber: 1, slug: "x" });
    assert.equal(c, undefined);
  });
});

describe("detectSatelliteRepo", () => {
  it("fires on a companion bot repo named in policy text", () => {
    const hit = detectSatelliteRepo(
      "actualbudget",
      "actual",
      "The approved label is applied by our label bot, whose source lives at github.com/actualbudget/actual-gh-bot."
    );
    assert.equal(hit?.candidate, "actualbudget/actual-gh-bot");
  });
  it("does not fire on a docs repo without bot/backend context", () => {
    const hit = detectSatelliteRepo(
      "composiohq",
      "composio",
      "Full documentation lives at github.com/composiohq/composio-docs."
    );
    assert.equal(hit, undefined);
  });
  it("ignores the repo being prepped", () => {
    const hit = detectSatelliteRepo(
      "o",
      "r",
      "The bot lives at github.com/o/r/actions; nothing else."
    );
    assert.equal(hit, undefined);
  });
});

describe("detectFixLivesHere: composio shape (server-side warning fires)", () => {
  it("warns when the quoted error text has zero hits in the repo", async () => {
    const body = 'The import fails with `Invalid connection status: expected INITIALIZING but got ACTIVE` (HTTP 422, code 1706).';
    const warnings = await detectFixLivesHere({
      owner: "composiohq",
      repo: "composio",
      issueBody: body,
      policyText: "",
      deps: { codeSearch: async () => 0 },
    });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].kind, "server-side");
    assert.match(warnings[0].line, /may not be buildable from this repo/);
  });
  it("stays quiet when the error text exists in the repo", async () => {
    const warnings = await detectFixLivesHere({
      owner: "o",
      repo: "r",
      issueBody: "It says `timeout waiting for response` in the logs.",
      policyText: "",
      deps: { codeSearch: async () => 3 },
    });
    assert.equal(warnings.length, 0);
  });
  it("emits nothing when the code search fails", async () => {
    const warnings = await detectFixLivesHere({
      owner: "o",
      repo: "r",
      issueBody: "It says `timeout waiting for response` in the logs.",
      policyText: "",
      deps: { codeSearch: async () => { throw new Error("rate limited"); } },
    });
    assert.equal(warnings.length, 0);
  });
});

describe("buildHouseRulesSummary", () => {
  it("names assignment claim style with its source", () => {
    const lines = buildHouseRulesSummary({
      gates: [{ kind: "assignment_required", detected: true, evidence: "x", source: "CONTRIBUTING.md" }],
      policyText: "",
      policyFiles: ["CONTRIBUTING.md"],
    });
    assert.match(lines[0], /request assignment/);
    assert.match(lines[0], /CONTRIBUTING\.md/);
  });
  it("names draft-first and conventional commits norms", () => {
    const lines = buildHouseRulesSummary({
      gates: [],
      policyText: "Commits follow Conventional Commits. Please open your PR as a draft for early review.",
      policyFiles: ["CONTRIBUTING.md"],
    });
    assert.ok(lines.some((l) => /Conventional Commits/.test(l)), "title convention line");
    assert.ok(lines.some((l) => /Draft-first/.test(l)), "draft-first line");
  });
  it("prefers the house-rules verify command for the test command", () => {
    const lines = buildHouseRulesSummary({
      gates: [],
      policyText: "",
      policyFiles: [],
      conventions: {
        houseRuleFiles: ["AGENTS.md"],
        verifyCommands: ["pnpm verify"],
        changesDir: false,
        packageScripts: ["test"],
        conventionalCommits: false,
      },
    });
    assert.ok(lines.some((l) => /`pnpm verify`/.test(l)), "verify command line");
  });
  it("states plainly when no claim ritual exists", () => {
    const lines = buildHouseRulesSummary({ gates: [], policyText: "thanks for contributing", policyFiles: ["CONTRIBUTING.md"] });
    assert.ok(lines.some((l) => /none required/.test(l)), "none-required line");
  });
});

describe("gatherPrepDetail: end to end with injected probes", () => {
  it("assembles CLA, changeset, warnings, and house rules", async () => {
    const detail = await gatherPrepDetail({
      owner: "reticlehq",
      repo: "reticle",
      issueNumber: 1147,
      slug: "blocker",
      policyTexts: [
        src("AGENTS.md", "Comment on the issue before starting work. All commits must carry a Signed-off-by trailer (DCO). Commits follow Conventional Commits. Open as a draft for early review."),
      ],
      contributing: "Reticle contribution guide.",
      issueBody: "The fixture reports `weird error in fixture loader` when run.",
      conventions: {
        houseRuleFiles: ["AGENTS.md"],
        verifyCommands: ["pnpm verify"],
        changesDir: true,
        changesDirName: ".changes",
        packageScripts: ["test"],
        conventionalCommits: true,
      },
      deps: {
        rootNames: async () => [".changes", "AGENTS.md", "package.json"],
        codeSearch: async () => 0, // error text absent -> server-side warning fires
      },
    });
    assert.equal(detail.claPath.kind, "dco");
    assert.equal(detail.changeset?.style, "changes-dir");
    assert.equal(detail.changeset?.example, ".changes/1147-blocker.md");
    assert.ok(detail.fixLivesHereWarnings.some((w) => w.kind === "server-side"), "server-side warning");
    assert.ok(detail.houseRulesSummary.some((l) => /comment on the issue before starting/i.test(l)), "comment-first line");
    assert.ok(detail.houseRulesSummary.some((l) => /Draft-first/.test(l)), "draft-first line");
  });
});

describe("renderPrepDoc: new v0.3.7 sections", () => {
  it("renders warnings, house rules, signing, and changeset sections", () => {
    const doc = renderPrepDoc({
      snapshot: makeSnapshot({ owner: "o", repo: "r", number: 42, title: "fix timeout" }),
      verdict: goVerdict,
      gates: [],
      branch: "feat/fix-timeout-42",
      viewer: "tester",
      issueUrl: "https://github.com/o/r/issues/42",
      prepDetail: {
        claPath: {
          kind: "cla-assistant",
          method: "Sign via CLA Assistant.",
          link: "https://cla-assistant.io",
          signaturePhrase: "I have read the CLA Document and I hereby sign the CLA",
          sources: ["CONTRIBUTING.md"],
          notes: [],
        },
        changeset: {
          style: "changesets",
          pattern: ".changeset/*.md",
          example: ".changeset/42-fix-timeout.md",
          note: "one file per change",
          source: "repo root",
        },
        fixLivesHereWarnings: [
          { kind: "server-side", line: "WARNING: the fix may not be buildable from this repo. evidence here." },
        ],
        houseRulesSummary: ["Claim style: none required (CONTRIBUTING.md)."],
      },
    });
    assert.match(doc, /## Fix-lives-here warnings/);
    assert.match(doc, /may not be buildable from this repo/);
    assert.match(doc, /## House rules/);
    assert.match(doc, /## Signing/);
    assert.match(doc, /I have read the CLA Document and I hereby sign the CLA/);
    assert.match(doc, /\.changeset\/42-fix-timeout\.md/);
    // Warnings come before the Gates section.
    assert.ok(doc.indexOf("## Fix-lives-here warnings") < doc.indexOf("## Gates"));
  });
});
