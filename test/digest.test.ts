/**
 * Tests for the repo-level maintainer digest: pure section builders over
 * injected data, four corpus fixtures driving the full orchestration seam
 * (network injected, never live), and the ci-triage widening (base
 * window 12 + legacy commit-status fallback mapping).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  digestRepo,
  extractPRIssueKeys,
  groupPRsByIssue,
  buildRace,
  buildClaimConflicts,
  buildStaleClaims,
  buildAssignmentConflicts,
  buildDigestSummary,
  renderDigestMarkdown,
  DEFAULT_DIGEST_LIMIT,
  type DigestPR,
  type DigestIssueKey,
  type DigestIssueMeta,
} from "../src/digest.js";
import { BASE_COMMIT_WINDOW, mapStatusToRecord } from "../src/ci-triage.js";
import type { CommentSignal, LinkedPR } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-16T00:00:00Z");

function comment(author: string, body: string, createdAt: string): CommentSignal {
  return { author, body, createdAt };
}

function pr(number: number, fields: Partial<DigestPR> = {}): DigestPR {
  return {
    number,
    title: `Fix #${number}`,
    body: `Fixes #${number}`,
    author: "me",
    headRef: `fix/${number}-x`,
    createdAt: "2026-10-15T12:00:00Z",
    url: `https://github.com/o/r/pull/${number}`,
    ...fields,
  };
}

function key(owner: string, repo: string, number: number): DigestIssueKey {
  return { owner, repo, number, label: owner === "o" && repo === "r" ? `#${number}` : `${owner}/${repo}#${number}` };
}

describe("extractPRIssueKeys", () => {
  it("finds same-repo closing links", () => {
    const keys = extractPRIssueKeys(pr(51, { title: "Fix #123", body: "This fixes #123 and touches #124.", headRef: "fix/x" }), "o", "r");
    assert.deepEqual(keys.map((k) => k.number), [123]);
  });
  it("finds cross-repo closing references", () => {
    const keys = extractPRIssueKeys(
      pr(61, { title: "Fix widget", body: "Fixes acme/widgets#123", headRef: "fix/x" }),
      "o",
      "r"
    );
    assert.deepEqual(
      keys.map((k) => k.label),
      ["acme/widgets#123"]
    );
  });
  it("ignores plain mentions without closing intent", () => {
    const keys = extractPRIssueKeys(pr(62, { title: "Docs", body: "see also #123, related to acme/widgets#124", headRef: "docs" }), "o", "r");
    assert.deepEqual(keys, []);
  });
});

describe("groupPRsByIssue", () => {
  it("groups two PRs on the same issue into one race group", () => {
    const groups = groupPRsByIssue(
      [pr(51, { title: "Fix #123", body: "Fixes #123", headRef: "a" }), pr(52, { title: "Fix #123", body: "Closes #123", headRef: "b" })],
      "o",
      "r"
    );
    assert.equal(groups.size, 1);
    const g = groups.get("o/r#123");
    assert.ok(g);
    assert.equal(g.prs.length, 2);
  });
  it("keeps same-repo and cross-repo issues separate", () => {
    const groups = groupPRsByIssue(
      [pr(61, { title: "A", body: "Fixes acme/widgets#123", headRef: "a" }), pr(62, { title: "B", body: "Fixes #123", headRef: "b" })],
      "o",
      "r"
    );
    assert.equal(groups.size, 2);
  });
});

describe("buildRace", () => {
  it("arbitrates with first claim and first PR", () => {
    const group = { key: key("o", "r", 123), prs: [pr(51, { author: "me", createdAt: "2026-10-15T12:00:00Z" }), pr(52, { author: "rival", createdAt: "2026-10-16T09:00:00Z" })] };
    const race = buildRace(
      group,
      "Issue 123",
      "https://github.com/o/r/issues/123",
      [comment("rival", "I would like to take this on", "2026-10-12T10:00:00Z")],
      NOW
    );
    assert.ok(race.arbitration.includes("first claim: @rival on 2026-10-12"));
    assert.ok(race.arbitration.includes("first PR opened: #51 by @me on 2026-10-15"));
    assert.ok(race.arbitration.includes("#52 by @rival"));
    assert.equal(race.earliestClaim?.author, "rival");
  });
  it("says so when the issue has no claims", () => {
    const race = buildRace({ key: key("o", "r", 123), prs: [pr(51)] }, "Issue 123", "https://github.com/o/r/issues/123", [], NOW);
    assert.equal(race.earliestClaim, null);
    assert.ok(race.arbitration.includes("no claim comments"));
  });
});

describe("buildClaimConflicts", () => {
  const issueData = new Map([
    [
      "o/r#200",
      {
        key: key("o", "r", 200),
        title: "Issue 200",
        url: "https://github.com/o/r/issues/200",
        author: "reporter",
        comments: [comment("stranger", "I'll take this", "2026-10-12T08:00:00Z")],
      },
    ],
  ]);
  it("flags a foreign claim that predates the PR", () => {
    const conflicts = buildClaimConflicts({
      prs: [pr(60, { author: "newbie", body: "Fixes #200", createdAt: "2026-10-15T10:00:00Z" })],
      prOwner: "o",
      prRepo: "r",
      issueData,
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].foreignClaims[0].author, "stranger");
  });
  it("treats the author's own claim as a pass", () => {
    const data = new Map([
      [
        "o/r#200",
        {
          key: key("o", "r", 200),
          title: "Issue 200",
          url: "https://github.com/o/r/issues/200",
          author: "reporter",
          comments: [comment("newbie", "I'll take this", "2026-10-12T08:00:00Z")],
        },
      ],
    ]);
    const conflicts = buildClaimConflicts({ prs: [pr(60, { author: "newbie", body: "Fixes #200" })], prOwner: "o", prRepo: "r", issueData: data });
    assert.equal(conflicts.length, 0);
  });
  it("ignores claims posted after the PR", () => {
    const data = new Map([
      [
        "o/r#200",
        {
          key: key("o", "r", 200),
          title: "Issue 200",
          url: "https://github.com/o/r/issues/200",
          author: "reporter",
          comments: [comment("stranger", "I'll take this", "2026-10-20T08:00:00Z")],
        },
      ],
    ]);
    const conflicts = buildClaimConflicts({ prs: [pr(60, { author: "newbie", body: "Fixes #200", createdAt: "2026-10-15T10:00:00Z" })], prOwner: "o", prRepo: "r", issueData: data });
    assert.equal(conflicts.length, 0);
  });
});

describe("buildStaleClaims", () => {
  const cand = (over: Record<string, unknown> = {}) => ({
    key: key("o", "r", 300),
    title: "Issue 300",
    url: "https://github.com/o/r/issues/300",
    comments: [comment("staleclaimer", "I will take this", "2026-09-25T10:00:00Z")],
    linkedPRs: [] as LinkedPR[],
    ...over,
  });
  it("flags a 21-day-old claim with a nudge action", () => {
    const out = buildStaleClaims([cand()], NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].ageDays, 21);
    assert.equal(out[0].action, "nudge @staleclaimer");
  });
  it("says release the claim at 30+ days", () => {
    const out = buildStaleClaims(
      [cand({ comments: [comment("ancient", "I would like to work on this", "2026-08-01T10:00:00Z")] })],
      NOW
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].action, "release the claim");
  });
  it("skips a stale-claimed issue that has an open PR", () => {
    const out = buildStaleClaims(
      [cand({ linkedPRs: [{ number: 99, state: "open", title: "WIP", url: "u", linkStrength: "closing" } as LinkedPR] })],
      NOW
    );
    assert.equal(out.length, 0);
  });
  it("skips fresh claims", () => {
    const out = buildStaleClaims([cand({ comments: [comment("fresh", "I'll take this", "2026-10-14T10:00:00Z")] })], NOW);
    assert.equal(out.length, 0);
  });
});

describe("buildAssignmentConflicts", () => {
  const assigneesByIssue = new Map([
    ["o/r#400", { key: key("o", "r", 400), title: "I400", url: "u", assignees: ["someone"] }],
    ["o/r#401", { key: key("o", "r", 401), title: "I401", url: "u", assignees: [] }],
  ]);
  it("flags PRs not among the assignees, including unassigned issues", () => {
    const out = buildAssignmentConflicts({
      prs: [pr(70, { author: "outsider", body: "Fixes #400" }), pr(71, { author: "newbie", body: "Fixes #401" })],
      prOwner: "o",
      prRepo: "r",
      assignmentRequired: true,
      assigneesByIssue,
    });
    assert.equal(out.length, 2);
    assert.deepEqual(out[1].assignees, []);
  });
  it("does nothing when the gate is off", () => {
    const out = buildAssignmentConflicts({
      prs: [pr(70, { author: "outsider", body: "Fixes #400" })],
      prOwner: "o",
      prRepo: "r",
      assignmentRequired: false,
      assigneesByIssue,
    });
    assert.equal(out.length, 0);
  });
});

describe("buildDigestSummary", () => {
  it("pluralizes and states the cap", () => {
    const s = buildDigestSummary({ repo: "o/r", races: 2, claimConflicts: 1, staleClaims: 0, assignmentConflicts: 0, prCap: 50, trueOpenPRs: 87 });
    assert.ok(s.includes("2 races"));
    assert.ok(s.includes("1 claimed-by-other conflict"));
    assert.ok(s.includes("showing 50 of 87 open PRs"));
  });
  it("omits the cap note when uncapped", () => {
    const s = buildDigestSummary({ repo: "o/r", races: 0, claimConflicts: 0, staleClaims: 0, assignmentConflicts: 0, prCap: 50, trueOpenPRs: 3 });
    assert.ok(!s.includes("showing"));
    assert.ok(s.includes("0 races"));
  });
});

describe("digest corpus fixtures", () => {
  const dir = join(__dirname, "fixtures", "digest-cases");
  const names = readdirSync(dir).filter((f) => f.endsWith(".json"));

  function metaFor(fx: Record<string, unknown>): Map<string, DigestIssueMeta> {
    const map = new Map<string, DigestIssueMeta>();
    const byRef: Record<string, Record<string, unknown>> = (fx.issuesByRef as Record<string, Record<string, unknown>>) ?? {};
    const [repoOwner, repoName] = String(fx.repo).split("/");
    const sameRepoIssues: Record<string, unknown>[] = ((fx.issues ?? []) as Record<string, unknown>[]);
    for (const i of sameRepoIssues) {
      byRef[`${repoOwner}/${repoName}#${i.number}`] = i;
    }
    for (const [ref, i] of Object.entries(byRef)) {
      const [o, rest] = ref.split("/");
      const [r, n] = rest.split("#");
      map.set(ref.toLowerCase(), {
        number: Number(i.number),
        title: String(i.title ?? ""),
        state: String(i.state ?? "open"),
        author: String(i.author ?? ""),
        url: String(i.url ?? `https://github.com/${o}/${r}/issues/${n}`),
        commentsCount: Number(i.commentsCount ?? 0),
        assignees: ((i.assignees ?? []) as string[]).map(String),
      });
    }
    return map;
  }

  function commentsFor(fx: Record<string, unknown>, owner: string, repo: string, number: number): CommentSignal[] {
    const ref = `${owner}/${repo}#${number}`.toLowerCase();
    const byRef: Record<string, Record<string, unknown>> = (fx.issuesByRef as Record<string, Record<string, unknown>>) ?? {};
    const sameRepoIssues: Record<string, unknown>[] = ((fx.issues ?? []) as Record<string, unknown>[]);
    const hit = byRef[ref] ?? sameRepoIssues.find((i) => Number(i.number) === number);
    return ((hit?.comments ?? []) as Array<Record<string, string>>).map((c) => ({
      author: c.author,
      body: c.body,
      createdAt: c.createdAt,
    }));
  }

  async function runFixture(name: string) {
    const fx = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    const meta = metaFor(fx);
    const openList: Record<string, unknown>[] = ((fx.openIssues ?? fx.issues ?? []) as Record<string, unknown>[]);
    const now = new Date(String(fx.now ?? "2026-10-16T00:00:00Z"));
    const [owner, repo] = String(fx.repo).split("/");
    const limit = typeof fx.limit === "number" ? fx.limit : DEFAULT_DIGEST_LIMIT;
    const result = await digestRepo(
      owner,
      repo,
      limit,
      {
        listOpenPRs: async () => ({ prs: (fx.pulls ?? []) as DigestPR[], total: (fx.pullsTotal as number | null) ?? null }),
        listOpenIssues: async () => ({
          issues: openList.map((i) => ({
            number: Number(i.number),
            title: String(i.title ?? ""),
            user: { login: String(i.author ?? "") },
            state: String(i.state ?? "open"),
            comments: Number(i.commentsCount ?? 0),
            html_url: String(i.url ?? ""),
            assignees: ((i.assignees ?? []) as string[]).map((a) => ({ login: a })),
          })),
          total: (fx.issuesTotal as number | null) ?? null,
        }),
        fetchIssueMeta: async (o, r, n) => {
          const m = meta.get(`${o}/${r}#${n}`.toLowerCase());
          if (!m) throw new Error(`no fixture issue ${o}/${r}#${n}`);
          return m;
        },
        fetchIssueComments: async (o, r, n) => commentsFor(fx, o, r, n),
        fetchLinkedPRs: async (o, r, n) => {
          const byRef: Record<string, LinkedPR[]> = (fx.linkedPRs as Record<string, LinkedPR[]>) ?? {};
          return byRef[`${o}/${r}#${n}`] ?? byRef[String(n)] ?? [];
        },
        fetchContributing: async () => (typeof fx.contributing === "string" ? fx.contributing : undefined),
      },
      { now }
    );
    return { fx, result };
  }

  it("loads the five digest fixtures", () => {
    assert.equal(names.length, 5);
  });

  it("race-stale-conflict: one race, two claimed-by-other, one stale, three assignment conflicts", async () => {
    const { fx, result } = await runFixture("race-stale-conflict.json");
    const expect = fx.expect as Record<string, unknown>;
    assert.equal(result.races.length, expect.races);
    // claimConflicts in the fixture means strong-claim conflicts; the soft
    // foreign claim on #200 (bare-take) still flags but renders as possible
    // interest, not a counted conflict.
    const strongConflicts = result.claimConflicts.filter((c) => c.foreignClaims.some((f) => f.strength === "strong")).length;
    assert.equal(strongConflicts, expect.claimConflicts);
    assert.equal(result.claimConflicts.length, expect.totalClaimFlags);
    assert.equal(result.staleClaims.length, expect.staleClaims);
    assert.equal(result.assignmentConflicts.length, expect.assignmentConflicts);
    for (const bit of expect.summaryContains as string[]) {
      assert.ok(result.summary.includes(bit), `summary should include "${bit}": ${result.summary}`);
    }
    // Race arbitration names the first claimant and the first PR.
    const race = result.races[0];
    assert.ok(race.arbitration.includes("first claim: @rival on 2026-10-12"));
    assert.ok(race.arbitration.includes("first PR opened: #51 by @me"));
    // The stale claim reads as a nudge (21 days).
    assert.equal(result.staleClaims[0].action, "nudge @staleclaimer");
    // The markdown carries all sections and the update-in-place marker is not needed here.
    assert.ok(result.markdown.includes("## PR races (1)"));
    assert.ok(result.markdown.includes("## Stale claims (1)"));
    // The soft foreign claim on #200 renders as possible interest, not a conflict.
    assert.ok(result.markdown.includes("Possible interest"));
  });

  it("clean: every section zero, summary says so", async () => {
    const { fx, result } = await runFixture("clean.json");
    const expect = fx.expect as Record<string, unknown>;
    assert.equal(result.races.length, 0);
    assert.equal(result.claimConflicts.length, 0);
    assert.equal(result.staleClaims.length, 0);
    assert.equal(result.assignmentConflicts.length, 0);
    assert.ok(result.markdown.includes("Nothing needs attention"));
    for (const bit of expect.summaryContains as string[]) {
      assert.ok(result.summary.includes(bit));
    }
  });

  it("capped: the summary states the cap and the true total", async () => {
    const { fx, result } = await runFixture("capped.json");
    for (const bit of (fx.expect as Record<string, unknown>).summaryContains as string[]) {
      assert.ok(result.summary.includes(bit), `summary should include "${bit}": ${result.summary}`);
    }
    assert.equal(result.prCap, 2);
    assert.equal(result.trueOpenPRs, 5);
  });

  it("pr-not-issue: version-token branches link nothing, PR-number groups are skipped with a note", async () => {
    const { fx, result } = await runFixture("pr-not-issue.json");
    const expect = fx.expect as Record<string, unknown>;
    assert.equal(result.races.length, expect.races);
    assert.equal(result.claimConflicts.length, expect.claimConflicts);
    assert.equal(result.assignmentConflicts.length, expect.assignmentConflicts);
    for (const bit of (expect.degradedContains as string[])) {
      assert.ok(result.degraded.some((d) => d.note.includes(bit)), `degraded should note "${bit}"`);
    }
    assert.ok(result.markdown.includes("Could not compute"));
  });

  it("cross-repo: a claim on the referenced repo's issue conflicts with the PR", async () => {
    const { fx, result } = await runFixture("cross-repo.json");
    const expect = fx.expect as Record<string, unknown>;
    assert.equal(result.races.length, expect.races);
    assert.equal(result.claimConflicts.length, expect.claimConflicts);
    assert.equal(result.claimConflicts[0].issue.label, "acme/widgets#123");
    assert.equal(result.claimConflicts[0].foreignClaims[0].author, "external-claimer");
  });
});

describe("ci-triage widening", () => {
  it("the base comparison window is 12 commits", () => {
    assert.equal(BASE_COMMIT_WINDOW, 12);
  });
  it("maps legacy commit statuses to check records", () => {
    const ok = mapStatusToRecord({ context: "continuous-integration/travis-ci", state: "success", updated_at: "2026-10-15T10:00:00Z" });
    assert.equal(ok.conclusion, "success");
    assert.equal(ok.name, "continuous-integration/travis-ci");
    assert.equal(ok.completedAt, "2026-10-15T10:00:00Z");
    const bad = mapStatusToRecord({ context: "ci/legacy", state: "failure", updated_at: "" });
    assert.equal(bad.conclusion, "failure");
    const err = mapStatusToRecord({ context: "ci/legacy", state: "error", updated_at: "" });
    assert.equal(err.conclusion, "failure");
  });
});
