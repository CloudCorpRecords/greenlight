import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreIssue } from "../src/verdict.js";
import { parseGatefileJson } from "../src/gates.js";
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
  "pdfcn-61-mention.json": "RISKY",
  "pdfcn-61-closing.json": "TAKEN",
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

  it("a mere PR mention does not take the issue (issue #1 regression)", () => {
    // PR #91 closes #70 and lists siblings #60-#65 in its body; it must not
    // mark #61 as TAKEN.
    const result = scoreIssue(load("pdfcn-61-mention.json"), NOW);
    assert.notEqual(result.verdict, "TAKEN");
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("weak-pr-mention"));
    assert.ok(result.reasons.some((r) => r.includes("mentions this issue but does not close it")));
    assert.ok(result.reasons.some((r) => r.includes("#91")));
  });

  it("a closing PR still takes the issue", () => {
    const result = scoreIssue(load("pdfcn-61-closing.json"), NOW);
    assert.equal(result.verdict, "TAKEN");
    assert.ok(result.reasons[0].includes("closes this issue"));
    assert.ok(result.reasons[0].includes("#91"));
  });

  it("an old cache entry without linkStrength is treated as a mention, not a close", () => {
    const snapshot = load("pdfcn-61-mention.json");
    delete (snapshot.linkedPRs[0] as Record<string, unknown>).linkStrength;
    const result = scoreIssue(snapshot, NOW);
    assert.notEqual(result.verdict, "TAKEN");
    assert.ok(result.flags.includes("weak-pr-mention"));
  });

  it("fastmcp-5718 is GATED with assignment evidence", () => {
    const result = scoreIssue(load("fastmcp-5718.json"), NOW);
    assert.ok(result.reasons.some((r) => r.includes("assignment")));
    assert.ok(result.gates.some((g) => g.kind === "assignment_required" && g.detected));
  });

  it("a gatefile gates document gates a clean issue (no_direct_prs -> GATED)", () => {
    const base = load("pdfcn-58.json");
    const snapshot: IssueSnapshot = {
      ...base,
      comments: [],
      linkedPRs: [],
      contributing: "Contributions welcome, just open a PR.",
      externalGates: parseGatefileJson(JSON.stringify({
        version: 1,
        repo: "shadcn-labs/pdfcn",
        gates: [
          { id: "no_direct_prs", kind: "no_direct_prs", severity: "block", evidence: "Maintainers open all PRs", source: "CONTRIBUTING.md" },
        ],
      })),
      updatedAt: NOW.toISOString(),
    };
    const result = scoreIssue(snapshot, NOW);
    assert.equal(result.verdict, "GATED");
    assert.ok(result.gates.some((g) => g.kind === "collaborators_only" && g.detected && g.evidence.startsWith("gatefile:")));
  });

  it("claim-first repo caps a clean issue at RISKY, never GATED (pdfcn style)", () => {
    const base = load("pdfcn-58.json");
    const snapshot: IssueSnapshot = {
      ...base,
      comments: [],
      linkedPRs: [],
      contributing: "Do not claim an issue silently. Comment before starting work. All commits need a Signed-off-by line per the DCO.",
      updatedAt: NOW.toISOString(),
    };
    const result = scoreIssue(snapshot, NOW);
    assert.notEqual(result.verdict, "GATED");
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.reasons.some((r) => r.includes("claim first")));
    assert.ok(result.flags.includes("claim_first"));
    assert.ok(result.gates.some((g) => g.kind === "claim_first" && g.detected));
    assert.ok(result.gates.some((g) => g.kind === "dco_required" && g.detected));
    assert.ok(!result.gates.some((g) => g.kind === "assignment_required" && g.detected));
  });

  it("claim-first note stacks onto a weak-PR-mention RISKY", () => {
    const base = load("pdfcn-61-mention.json");
    const snapshot: IssueSnapshot = {
      ...base,
      contributing: "Do not claim an issue silently. Comment before starting work.",
    };
    const result = scoreIssue(snapshot, NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("weak-pr-mention"));
    assert.ok(result.flags.includes("claim_first"));
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

describe("partial claims (reticle#691 near-miss)", () => {
  function clean(): IssueSnapshot {
    const base = load("pdfcn-58.json");
    return {
      ...base,
      comments: [],
      linkedPRs: [],
      commentMentionedPRs: [],
      contributing: undefined,
      updatedAt: NOW.toISOString(),
    };
  }
  function withComments(comments: Array<{ author: string; body: string; createdAt?: string }>): IssueSnapshot {
    const snap = clean();
    snap.comments = comments.map((c) => ({
      author: c.author,
      body: c.body,
      createdAt: c.createdAt ?? "2026-10-12T10:00:00Z",
    }));
    return snap;
  }

  it("a fresh scoped claim downgrades GO to RISKY, never TAKEN", () => {
    const result = scoreIssue(withComments([{ author: "kushals256", body: "Taking the remaining fallback ask." }]), NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("claimed"));
    assert.ok(result.flags.includes("partial-claim"));
    assert.ok(
      result.reasons.some((r) => r.includes("kushals256") && r.includes("the remaining part") && r.includes("the rest may still be open")),
      `reasons: ${result.reasons.join(" | ")}`
    );
    assert.equal(result.claims[0].scope, "partial");
  });

  it("two scoped claims do not form a claim race", () => {
    const result = scoreIssue(withComments([
      { author: "dev1", body: "Taking the remaining fallback ask." },
      { author: "dev2", body: "I'll take the fallback part instead." },
    ]), NOW);
    assert.notEqual(result.verdict, "TAKEN");
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("partial-claim"));
  });

  it("a whole-issue claim still wins over a scoped one", () => {
    const result = scoreIssue(withComments([
      { author: "dev1", body: "I would like to work on this issue." },
      { author: "dev2", body: "Taking the remaining fallback ask." },
    ]), NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.reasons.some((r) => r.includes('claimed by dev1 1 day(s) ago ("explicit-claim")')));
    assert.ok(!result.flags.includes("partial-claim"));
  });

  it("a stale scoped claim behaves like a stale claim", () => {
    const result = scoreIssue(withComments([
      { author: "dev1", body: "Taking the remaining fallback ask.", createdAt: "2026-07-01T10:00:00Z" },
    ]), NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("stale_claim"));
    assert.ok(result.reasons.some((r) => r.includes("stale partial claim by dev1")));
  });
});

describe("comment-mentioned PR cross-check", () => {
  function clean(): IssueSnapshot {
    const base = load("pdfcn-58.json");
    return {
      ...base,
      comments: [],
      linkedPRs: [],
      commentMentionedPRs: [],
      contributing: undefined,
      updatedAt: NOW.toISOString(),
    };
  }

  it("an open PR cited in comments that mentions the issue downgrades GO to RISKY", () => {
    const snap = clean();
    snap.commentMentionedPRs = [{ number: 861, url: "https://github.com/r/r/pull/861", state: "open", mentionsIssue: true }];
    const result = scoreIssue(snap, NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("comment-mentioned-pr"));
    assert.ok(result.reasons.some((r) => r.includes("PR #861 referenced in comments may already cover part of this issue")));
    assert.notEqual(result.verdict, "TAKEN");
  });

  it("a cited PR that does not mention the issue leaves GO alone", () => {
    const snap = clean();
    snap.commentMentionedPRs = [{ number: 861, url: "https://github.com/r/r/pull/861", state: "open", mentionsIssue: false }];
    const result = scoreIssue(snap, NOW);
    assert.equal(result.verdict, "GO");
    assert.ok(!result.flags.includes("comment-mentioned-pr"));
  });

  it("a merged cited PR that references the issue is partially-addressed, never TAKEN (rule 12)", () => {
    const snap = clean();
    snap.commentMentionedPRs = [{ number: 861, url: "https://github.com/r/r/pull/861", state: "merged", mentionsIssue: true }];
    const result = scoreIssue(snap, NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(!result.flags.includes("comment-mentioned-pr"));
    assert.ok(result.flags.includes("partially-addressed"));
    assert.ok(result.reasons.some((r) => r.includes("PR #861, merged") && r.includes("scope your work to what remains")));
  });

  it("a closed (unmerged) cited PR changes nothing", () => {
    const snap = clean();
    snap.commentMentionedPRs = [{ number: 861, url: "https://github.com/r/r/pull/861", state: "closed", mentionsIssue: true }];
    const result = scoreIssue(snap, NOW);
    assert.equal(result.verdict, "GO");
    assert.ok(!result.flags.includes("comment-mentioned-pr"));
  });
});

describe("partially-addressed (rule 12)", () => {
  const base = (): IssueSnapshot => ({
    sourceUrl: "https://github.com/reticlehq/reticle/issues/894",
    owner: "reticlehq",
    repo: "reticle",
    number: 894,
    state: "open",
    title: "The destructive-action block names a retry a flow cannot perform",
    author: "divshekhar",
    assignees: [],
    labels: ["bug", "help wanted"],
    comments: [],
    linkedPRs: [],
    createdAt: "2026-09-08T10:00:00Z",
    updatedAt: "2026-10-13T10:00:00Z",
    contributing: "",
  });

  it("merged PRs referencing the issue downgrade GO to RISKY with the flag", () => {
    const s = base();
    s.commentMentionedPRs = [
      { number: 905, url: "https://github.com/reticlehq/reticle/pull/905", state: "merged", mentionsIssue: true },
      { number: 915, url: "https://github.com/reticlehq/reticle/pull/915", state: "merged", mentionsIssue: true },
    ];
    const r = scoreIssue(s, new Date("2026-10-14T12:00:00Z"));
    assert.equal(r.verdict, "RISKY");
    assert.ok(r.flags.includes("partially-addressed"));
    assert.ok(r.reasons.some((x) => x.includes("PR #905, merged") && x.includes("scope your work to what remains")));
  });

  it("maintainer comment signals alone are enough", () => {
    const s = base();
    s.comments = [
      {
        author: "divshekhar",
        body: "Half addressed so far. Leaving this open for half B.",
        createdAt: "2026-10-12T10:00:00Z",
      },
    ];
    const r = scoreIssue(s, new Date("2026-10-14T12:00:00Z"));
    assert.equal(r.verdict, "RISKY");
    assert.ok(r.flags.includes("partially-addressed"));
    assert.ok(r.reasons.some((x) => x.includes("maintainer comment")));
  });

  it("detects 'Shipped in v3.1.0' next to the issue reference", () => {
    const s = base();
    s.comments = [
      {
        author: "divshekhar",
        body: "Shipped in v3.1.0 (2026-09-18) for #894, verified by commit ancestry.",
        createdAt: "2026-09-18T10:00:00Z",
      },
    ];
    const r = scoreIssue(s, new Date("2026-10-14T12:00:00Z"));
    assert.equal(r.verdict, "RISKY");
    assert.ok(r.flags.includes("partially-addressed"));
  });

  it("does not fire on a plain open issue", () => {
    const s = base();
    s.comments = [
      { author: "a", body: "I can reproduce this on Linux.", createdAt: "2026-10-10T10:00:00Z" },
    ];
    const r = scoreIssue(s, new Date("2026-10-14T12:00:00Z"));
    assert.equal(r.verdict, "GO");
    assert.ok(!r.flags.includes("partially-addressed"));
  });

  it("does not fire on a merged PR that does not reference the issue", () => {
    const s = base();
    s.commentMentionedPRs = [
      { number: 900, url: "https://github.com/reticlehq/reticle/pull/900", state: "merged", mentionsIssue: false },
    ];
    const r = scoreIssue(s, new Date("2026-10-14T12:00:00Z"));
    assert.equal(r.verdict, "GO");
    assert.ok(!r.flags.includes("partially-addressed"));
  });

  it("never produces TAKEN from partial signals alone", () => {
    const s = base();
    s.commentMentionedPRs = [
      { number: 905, url: "https://github.com/reticlehq/reticle/pull/905", state: "merged", mentionsIssue: true },
    ];
    s.comments = [
      { author: "divshekhar", body: "Half addressed by #905, still open for the rest.", createdAt: "2026-10-12T10:00:00Z" },
    ];
    const r = scoreIssue(s, new Date("2026-10-14T12:00:00Z"));
    assert.notEqual(r.verdict, "TAKEN");
    assert.equal(r.verdict, "RISKY");
  });

  it("adds the reason to an already-RISKY verdict without changing it", () => {
    const s = base();
    s.comments = [
      { author: "divshekhar", body: "Half addressed by #905, still open for the rest.", createdAt: "2026-10-12T10:00:00Z" },
    ];
    // weak mention makes it RISKY first via rule 10
    s.linkedPRs = [
      { number: 920, state: "open", title: "related refactor", url: "https://github.com/reticlehq/reticle/pull/920", linkStrength: "mention" },
    ];
    const r = scoreIssue(s, new Date("2026-10-14T12:00:00Z"));
    assert.equal(r.verdict, "RISKY");
    assert.ok(r.flags.includes("partially-addressed"));
    assert.ok(r.flags.includes("weak-pr-mention"));
  });
});

describe("fromAuthor tagging on mentioned PRs", () => {
  const base = (): IssueSnapshot => ({
    sourceUrl: "https://github.com/reticlehq/reticle/issues/894",
    owner: "reticlehq",
    repo: "reticle",
    number: 894,
    state: "open",
    title: "The destructive-action block names a retry a flow cannot perform",
    author: "divshekhar",
    assignees: [],
    labels: ["bug", "help wanted"],
    comments: [],
    linkedPRs: [],
    createdAt: "2026-09-08T10:00:00Z",
    updatedAt: "2026-10-13T10:00:00Z",
    contributing: "",
  });

  it("an open PR cited only by the issue author does not downgrade", () => {
    const s = base();
    s.commentMentionedPRs = [
      {
        number: 1620,
        url: "https://github.com/reticlehq/reticle/pull/1620",
        state: "open",
        mentionsIssue: true,
        fromAuthor: true,
      },
    ];
    const r = scoreIssue(s, new Date("2026-10-14T12:00:00Z"));
    assert.equal(r.verdict, "GO");
    assert.ok(!r.flags.includes("comment-mentioned-pr"));
  });

  it("a merged PR cited by the issue author still feeds partially-addressed", () => {
    const s = base();
    s.commentMentionedPRs = [
      {
        number: 905,
        url: "https://github.com/reticlehq/reticle/pull/905",
        state: "merged",
        mentionsIssue: true,
        fromAuthor: true,
      },
    ];
    const r = scoreIssue(s, new Date("2026-10-14T12:00:00Z"));
    assert.equal(r.verdict, "RISKY");
    assert.ok(r.flags.includes("partially-addressed"));
    assert.ok(r.reasons.some((x) => x.includes("PR #905, merged")));
  });

  it("an open PR cited by someone else still downgrades", () => {
    const s = base();
    s.commentMentionedPRs = [
      {
        number: 1620,
        url: "https://github.com/reticlehq/reticle/pull/1620",
        state: "open",
        mentionsIssue: true,
        fromAuthor: false,
      },
    ];
    const r = scoreIssue(s, new Date("2026-10-14T12:00:00Z"));
    assert.equal(r.verdict, "RISKY");
    assert.ok(r.flags.includes("comment-mentioned-pr"));
  });
});

describe("partially-addressed via maintainer-cited merged PRs", () => {
  const base = (): IssueSnapshot => ({
    sourceUrl: "https://github.com/reticlehq/reticle/issues/894",
    owner: "reticlehq",
    repo: "reticle",
    number: 894,
    state: "open",
    title: "The destructive-action block names a retry a flow cannot perform",
    author: "divshekhar",
    assignees: [],
    labels: ["bug", "help wanted"],
    comments: [],
    linkedPRs: [],
    createdAt: "2026-09-08T10:00:00Z",
    updatedAt: "2026-10-13T10:00:00Z",
    contributing: "",
  });

  it("names a merged PR cited in a shipped-work comment even when the PR body never mentions the issue", () => {
    const s = base();
    s.comments = [
      {
        author: "divshekhar",
        body: "Half addressed by #905, merged to main in #915. Leaving this open for half B.",
        createdAt: "2026-10-12T10:00:00Z",
      },
    ];
    s.commentMentionedPRs = [
      {
        number: 915,
        url: "https://github.com/reticlehq/reticle/pull/915",
        state: "merged",
        mentionsIssue: false, // the PR body never names the issue
        fromAuthor: true,
      },
    ];
    s.linkedPRs = [
      { number: 905, state: "merged", title: "fix(server): land half A", url: "https://github.com/reticlehq/reticle/pull/905", linkStrength: "mention" },
    ];
    const r = scoreIssue(s, new Date("2026-10-14T12:00:00Z"));
    assert.equal(r.verdict, "RISKY");
    assert.ok(r.flags.includes("partially-addressed"));
    assert.ok(r.reasons.some((x) => x.includes("PR #915, merged")));
    assert.ok(r.reasons.some((x) => x.includes("PR #905, merged")));
  });
});

describe("duplicate-of and attempt-linked races (field cases 2026-10-15)", () => {
  const clean = () => load("squidbrake-74.json");

  it("duplicate of a completed issue is RISKY (n8n #41215 pattern)", () => {
    const snapshot: IssueSnapshot = {
      ...clean(),
      duplicateOf: [
        {
          number: 40803,
          url: "https://github.com/n8n-io/n8n/issues/40803",
          state: "closed",
          stateReason: "completed",
        },
      ],
    };
    const result = scoreIssue(snapshot, NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("duplicate-of-closed"));
    assert.ok(result.reasons.some((r) => r.includes("marked duplicate of #40803")));
    assert.ok(result.reasons.some((r) => r.includes("closed as completed")));
  });

  it("duplicate of an open issue keeps the verdict but warns with the URL", () => {
    const snapshot: IssueSnapshot = {
      ...clean(),
      duplicateOf: [
        {
          number: 555,
          url: "https://github.com/acme/widget/issues/555",
          state: "open",
        },
      ],
    };
    const result = scoreIssue(snapshot, NOW);
    assert.equal(result.verdict, "GO");
    assert.ok(result.flags.includes("duplicate-of-open"));
    assert.ok(
      result.reasons.some(
        (r) => r.includes("#555") && r.includes("still open") && r.includes("https://github.com/acme/widget/issues/555")
      )
    );
  });

  it("an attempt-linked open PR is RISKY with the URL quoted (tscircuit #5563 pattern)", () => {
    const snapshot: IssueSnapshot = {
      ...clean(),
      commentMentionedPRs: [
        {
          number: 4575,
          url: "https://github.com/tscircuit/core/pull/4575",
          state: "open",
          mentionsIssue: false,
          attemptLinked: true,
        },
      ],
    };
    const result = scoreIssue(snapshot, NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("attempt-linked-pr"));
    assert.ok(result.reasons.some((r) => r.includes("https://github.com/tscircuit/core/pull/4575")));
  });

  it("a /attempt comment is a strong claim (same #5563 case)", () => {
    const snapshot: IssueSnapshot = {
      ...clean(),
      comments: [{ author: "TassioSales", body: "/attempt #5563", createdAt: "2026-10-12T15:13:46Z" }],
    };
    const result = scoreIssue(snapshot, NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("claimed"));
    assert.equal(result.claims[0].phrase, "attempt-command");
  });

  it("workflow-detected external_prs_closed gates a clean issue", () => {
    const snapshot: IssueSnapshot = {
      ...clean(),
      workflowGates: [
        {
          kind: "external_prs_closed",
          detected: true,
          evidence: "workflow file: close-external-prs.yml",
          source: ".github/workflows/close-external-prs.yml",
        },
      ],
    };
    const result = scoreIssue(snapshot, NOW);
    assert.equal(result.verdict, "GATED");
    assert.ok(result.reasons.some((r) => r.includes("external PRs closed by automation")));
    assert.ok(result.reasons.some((r) => r.includes("close-external-prs.yml")));
  });

  it("paused unsolicited PRs in house rules gate a clean issue", () => {
    const snapshot: IssueSnapshot = {
      ...clean(),
      houseRules: [
        {
          file: "CONTRIBUTING.md",
          text: "We've temporarily paused unsolicited pull requests from outside the core team.",
        },
      ],
    };
    const result = scoreIssue(snapshot, NOW);
    assert.equal(result.verdict, "GATED");
    assert.ok(result.reasons.some((r) => r.includes("unsolicited PRs paused")));
    assert.ok(result.reasons.some((r) => r.includes("paused")));
  });
});

describe("behavioral gate caps verdicts at GATED (v0.16.2)", () => {
  function clean(): IssueSnapshot {
    const base = load("pdfcn-58.json");
    return {
      ...base,
      comments: [],
      linkedPRs: [],
      commentMentionedPRs: [],
      contributing: undefined,
      updatedAt: NOW.toISOString(),
    };
  }

  function spotDLGate(): IssueSnapshot["behavioralGate"] {
    return {
      detected: true,
      strength: 2,
      threshold: 2,
      evidence: [
        {
          pr: 2494,
          author: "maintainer",
          quote: "Closing this as AI slop.",
          url: "https://github.com/spotDL/spotify-downloader/pull/2494",
          strong: true,
        },
        {
          pr: 2501,
          author: "maintainer",
          quote: "We do not accept AI-generated PRs here.",
          url: "https://github.com/spotDL/spotify-downloader/pull/2501",
          strong: true,
        },
      ],
      notes: [],
      note: "2 closed-unmerged PRs with maintainer AI-rejection comments",
    };
  }

  it("a detected behavioral gate caps a clean issue at GATED with the evidence quoted", () => {
    const result = scoreIssue({ ...clean(), behavioralGate: spotDLGate() }, NOW);
    assert.equal(result.verdict, "GATED");
    assert.ok(result.flags.includes("behavioral-gate"));
    assert.ok(result.reasons.some((r) => r.includes("rejects AI-built PRs in practice")));
    assert.ok(result.reasons.some((r) => r.includes("2494")));
    assert.ok(result.reasons.some((r) => r.includes("AI slop")));
  });

  it("an undetected behavioral gate does not change the verdict", () => {
    const gate = spotDLGate()!;
    const result = scoreIssue({ ...clean(), behavioralGate: { ...gate, detected: false, strength: 1 } }, NOW);
    assert.equal(result.verdict, "GO");
    assert.ok(!result.flags.includes("behavioral-gate"));
  });

  it("a null behavioral gate leaves the verdict alone", () => {
    const result = scoreIssue({ ...clean(), behavioralGate: null }, NOW);
    assert.equal(result.verdict, "GO");
  });
});

describe("scoped intake pause (v0.17.0)", () => {
  function clean(): IssueSnapshot {
    const base = load("pdfcn-58.json");
    return {
      ...base,
      comments: [],
      linkedPRs: [],
      commentMentionedPRs: [],
      contributing: undefined,
      updatedAt: NOW.toISOString(),
    };
  }

  it("caps a clean issue at RISKY with the refused scope quoted", () => {
    const snapshot = clean();
    const result = scoreIssue(
      {
        ...snapshot,
        houseRules: [
          {
            file: "CONTRIBUTING.md",
            text: "We are not accepting pull requests that add new formatting options.",
          },
        ],
      },
      NOW
    );
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("scoped-pause"));
    assert.ok(result.reasons.some((r) => r.includes("scoped intake pause")));
    assert.ok(result.reasons.some((r) => r.includes("formatting options")));
  });

  it("a blanket pause still gates (scoped demotion does not leak)", () => {
    const snapshot = clean();
    const result = scoreIssue(
      {
        ...snapshot,
        houseRules: [
          {
            file: "CONTRIBUTING.md",
            text: "We've temporarily paused unsolicited pull requests from outside the core team.",
          },
        ],
      },
      NOW
    );
    assert.equal(result.verdict, "GATED");
    assert.ok(!result.flags.includes("scoped-pause"));
  });
});

describe("staleness decay (v0.19.0, item 17)", () => {
  function clean(): IssueSnapshot {
    const base = load("pdfcn-58.json");
    return {
      ...base,
      comments: [],
      linkedPRs: [],
      commentMentionedPRs: [],
      contributing: undefined,
      updatedAt: NOW.toISOString(),
    };
  }
  function withComments(comments: Array<{ author: string; body: string; createdAt?: string }>): IssueSnapshot {
    const snap = clean();
    snap.comments = comments.map((c) => ({
      author: c.author,
      body: c.body,
      createdAt: c.createdAt ?? "2026-10-12T10:00:00Z",
    }));
    return snap;
  }
  // NOW is 2026-10-13T12:00:00Z: 2026-03-27 is exactly 200 days before,
  // 2024-11-27 is exactly 685 days before, 2026-04-16 is exactly 180.
  const D200 = "2026-03-27T12:00:00Z";
  const D685 = "2024-11-27T12:00:00Z";
  const D180 = "2026-04-16T12:00:00Z";

  it("STALE_SIGNAL_DAYS is the documented 180-day threshold", async () => {
    const { STALE_SIGNAL_DAYS } = await import("../src/verdict.js");
    assert.equal(STALE_SIGNAL_DAYS, 180);
  });

  it("two strong claims aged 200 days with no PRs do not form a claim race (a)", () => {
    const result = scoreIssue(withComments([
      { author: "dev1", body: "I would like to work on this issue.", createdAt: D200 },
      { author: "dev2", body: "Please assign this to me.", createdAt: D200 },
    ]), NOW);
    assert.notEqual(result.verdict, "TAKEN");
    assert.ok(!result.reasons.some((r) => r.includes("claim race")), `reasons: ${result.reasons.join(" | ")}`);
    assert.ok(result.flags.includes("stale-signal"));
    assert.ok(result.reasons.some((r) => r.includes("stale signal: claim by dev1 200 day(s) ago") && r.includes("down-weighted")));
    assert.ok(result.reasons.some((r) => r.includes("stale signal: claim by dev2 200 day(s) ago") && r.includes("down-weighted")));
    assert.ok(!result.flags.includes("claimed"));
    assert.equal(result.verdict, "GO");
  });

  it("a single strong claim aged 685 days does not downgrade a clean issue (b, llama.cpp field case)", () => {
    const result = scoreIssue(withComments([
      { author: "ancient-claimer", body: "I would like to work on this issue.", createdAt: D685 },
    ]), NOW);
    assert.equal(result.verdict, "GO");
    assert.ok(result.flags.includes("stale-signal"));
    assert.ok(!result.flags.includes("stale_claim"));
    assert.ok(
      result.reasons.some((r) => r.includes("stale signal: claim by ancient-claimer 685 day(s) ago") && r.includes("down-weighted")),
      `reasons: ${result.reasons.join(" | ")}`
    );
  });

  it("a fresh 3-day-old claim is unchanged: RISKY with the claimed flag (c)", () => {
    const result = scoreIssue(withComments([
      { author: "dev1", body: "I would like to work on this issue.", createdAt: "2026-10-10T12:00:00Z" },
    ]), NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("claimed"));
    assert.ok(!result.flags.includes("stale-signal"));
    assert.ok(result.reasons.some((r) => r.includes("claimed by dev1 3 day(s) ago")));
  });

  it("a claim aged 200 days with an open closing PR takes the PR path, no stale-signal (d)", () => {
    const snap = withComments([
      { author: "dev1", body: "I would like to work on this issue.", createdAt: D200 },
    ]);
    snap.linkedPRs = [
      { number: 700, state: "open", title: "fix: the thing", url: "https://github.com/shadcn-labs/pdfcn/pull/700", linkStrength: "closing" },
    ];
    const result = scoreIssue(snap, NOW);
    assert.equal(result.verdict, "TAKEN");
    assert.ok(result.reasons[0].includes("closes this issue"));
    assert.ok(!result.flags.includes("stale-signal"));
  });

  it("a claim at exactly 180 days is not decayed: the stale_claim band still applies", () => {
    const result = scoreIssue(withComments([
      { author: "dev1", body: "I would like to work on this issue.", createdAt: D180 },
    ]), NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("stale_claim"));
    assert.ok(!result.flags.includes("stale-signal"));
    assert.ok(result.reasons.some((r) => r.includes("stale claim by dev1 180 day(s) ago")));
  });

  it("a stale partial claim aged 200 days decays too: no partial-claim RISKY", () => {
    const result = scoreIssue(withComments([
      { author: "dev1", body: "Taking the remaining fallback ask.", createdAt: D200 },
    ]), NOW);
    assert.equal(result.verdict, "GO");
    assert.ok(result.flags.includes("stale-signal"));
    assert.ok(!result.flags.includes("partial-claim"));
    assert.ok(!result.flags.includes("stale_claim"));
    assert.ok(result.reasons.some((r) => r.includes("stale signal: claim by dev1 200 day(s) ago")));
  });

  it("a decayed soft claim loses the weak-claim treatment and keeps only the disclosure", () => {
    const result = scoreIssue(withComments([
      { author: "dev1", body: "I'm going to take a look at this one.", createdAt: D200 },
    ]), NOW);
    assert.equal(result.verdict, "GO");
    assert.ok(result.flags.includes("stale-signal"));
    assert.ok(!result.flags.includes("weak-claim"));
    assert.ok(result.reasons.some((r) => r.includes("stale signal: claim by dev1 200 day(s) ago")));
  });

  it("a fresh claim still wins alongside an ancient one, and the ancient one is disclosed", () => {
    const result = scoreIssue(withComments([
      { author: "old-timer", body: "I would like to work on this issue.", createdAt: D200 },
      { author: "fresh-dev", body: "Please assign this to me.", createdAt: "2026-10-10T12:00:00Z" },
    ]), NOW);
    assert.equal(result.verdict, "RISKY");
    assert.ok(result.flags.includes("claimed"));
    assert.ok(result.flags.includes("stale-signal"));
    assert.ok(!result.reasons.some((r) => r.includes("claim race")));
    assert.ok(result.reasons.some((r) => r.includes("claimed by fresh-dev 3 day(s) ago")));
    assert.ok(result.reasons.some((r) => r.includes("stale signal: claim by old-timer 200 day(s) ago")));
  });
});
