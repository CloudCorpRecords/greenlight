/**
 * Keyword Race Check tests (v0.20.0).
 *
 * The regression fixtures model the verified sveltejs/kit field case:
 * issue #17465 (root route $types.d.ts deleted and regenerated on every
 * sync run) was raced by PR #17453, "fix: correctly cache type
 * generation" (opened 2026-10-15), whose body describes the same
 * problem — "cache meta data file and root route types were being
 * deleted on every run" — without EVER mentioning #17465. Link-based
 * checks missed it; keywords alone must catch it.
 *
 * Pure functions are driven directly; the pipeline runs on injected
 * deps; the xray integration runs through the setFetchImpl seam.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setFetchImpl } from "../src/github.js";
import {
  extractKeywords,
  specialTokens,
  wordTokens,
  scoreCandidate,
  racecheckIssue,
  applyRaceDemotion,
  searchSeeds,
  type RaceIssue,
  type RacePRCandidate,
} from "../src/racecheck.js";
import { xrayIssue } from "../src/xray.js";

afterEach(() => setFetchImpl(null));

// --- the verified Svelte fixtures ---

const SVELTE_ISSUE: RaceIssue = {
  title: "Root route $types.d.ts is deleted and regenerated on every sync run",
  body:
    "When running the sync command, the root route's $types.d.ts file is deleted " +
    "and then regenerated from scratch on every run. This breaks the type " +
    "generation caching and makes every sync slow.",
  labels: ["bug"],
  author: "reporter",
};

const SVELTE_RACER: RacePRCandidate = {
  number: 17453,
  title: "fix: correctly cache type generation",
  body:
    "This PR is an attempt to fix the type generation caching which was broken " +
    "(as discovered by a contributor) as the cache meta data file and root route " +
    "types were being deleted on every run",
  author: "racer",
  createdAt: "2026-10-15T07:50:26Z",
  url: "https://github.com/sveltejs/kit/pull/17453",
};

const depsFor = (issue: RaceIssue, prs: RacePRCandidate[], files: Record<number, string[]> = {}) => ({
  fetchIssue: async () => issue,
  searchOpenPRs: async () => [],
  listOpenPRs: async () => prs,
  fetchFiles: async (_o: string, _r: string, n: number) => files[n] ?? [],
});

describe("extractKeywords", () => {
  it("captures $types.d.ts as a rare term and a named file", () => {
    const kw = extractKeywords(SVELTE_ISSUE);
    assert.ok(kw.rare.includes("$types.d.ts"), `rare: ${kw.rare.join(",")}`);
    assert.ok(kw.files.includes("$types.d.ts"), `files: ${kw.files.join(",")}`);
    assert.ok(kw.terms.includes("deleted"), `terms: ${kw.terms.join(",")}`);
    assert.ok(kw.terms.includes("regenerated"), `terms: ${kw.terms.join(",")}`);
  });

  it("filters stopwords and generic problem words out of terms", () => {
    const kw = extractKeywords({
      title: "Fix the error in the app",
      body: "An error occurs. The app is broken and the problem fails.",
      labels: [],
      author: "x",
    });
    assert.deepEqual(kw.terms, [], `terms should be empty, got ${kw.terms.join(",")}`);
    assert.deepEqual(kw.rare, []);
  });

  it("delimiter-aware: oauth2 is one token, never oauth + 2", () => {
    assert.deepEqual(wordTokens("oauth2 token"), ["oauth2", "token"]);
    assert.ok(!specialTokens("oauth2").includes("oauth"));
    const kw = extractKeywords({
      title: "OAuth2 token refresh stops working",
      body: "",
      labels: [],
      author: "x",
    });
    assert.ok(kw.terms.includes("oauth2"), `terms: ${kw.terms.join(",")}`);
    assert.ok(!kw.terms.includes("oauth"));
    assert.ok(!kw.terms.includes("2"));
  });

  it("captures CamelCase and snake_case identifiers as rare terms", () => {
    const kw = extractKeywords({
      title: "View transition promise never resolves",
      body: "The currentTransition.updateCallbackDone promise and the sync_init hook are involved.",
      labels: [],
      author: "x",
    });
    assert.ok(kw.rare.includes("updatecallbackdone"), `rare: ${kw.rare.join(",")}`);
    assert.ok(kw.rare.includes("sync_init"), `rare: ${kw.rare.join(",")}`);
  });

  it("captures quoted strings as phrases and their words as terms", () => {
    const kw = extractKeywords({
      title: "Startup crash",
      body: 'It prints "segmentation fault in worker" and exits.',
      labels: [],
      author: "x",
    });
    assert.ok(kw.phrases.includes("segmentation fault worker"), `phrases: ${kw.phrases.join(" | ")}`);
    assert.ok(kw.terms.includes("segmentation"));
  });

  it("searchSeeds prefers named files, then longest terms, capped at 3", () => {
    const seeds = searchSeeds(extractKeywords(SVELTE_ISSUE));
    assert.equal(seeds[0], "$types.d.ts");
    assert.ok(seeds.length <= 3);
  });
});

describe("scoreCandidate thresholds", () => {
  const kw = extractKeywords(SVELTE_ISSUE);

  it("two significant term matches -> RACE", () => {
    const s = scoreCandidate(kw, { title: "Keep deleted files regenerated properly", body: "" });
    assert.equal(s.verdict, "RACE");
    assert.ok(s.termHits.length + s.phraseHits.length >= 2);
  });

  it("one rare term match -> RACE", () => {
    const s = scoreCandidate(kw, { title: "chore: ignore $types.d.ts in lint", body: "" });
    assert.equal(s.verdict, "RACE");
    assert.deepEqual(s.rareHits, ["$types.d.ts"]);
  });

  it("exactly one term match -> SUSPECT", () => {
    const s = scoreCandidate(kw, { title: "Tidy the sync command output", body: "" });
    assert.equal(s.verdict, "SUSPECT");
    assert.deepEqual(s.termHits, ["sync"]);
  });

  it("a shared changed file -> RACE even with no text overlap", () => {
    const kw2 = extractKeywords({
      title: "Importer drops rows",
      body: "The importer in src/sync/types.ts drops rows silently.",
      labels: [],
      author: "x",
    });
    const s = scoreCandidate(kw2, { title: "Unrelated cleanup", body: "tidy" }, ["src/sync/types.ts", "README.md"]);
    assert.equal(s.verdict, "RACE");
    assert.deepEqual(s.fileHits, ["src/sync/types.ts"]);
  });

  it("no overlap -> no verdict", () => {
    const s = scoreCandidate(kw, { title: "Improve README installation docs", body: "documentation" });
    assert.equal(s.verdict, null);
  });
});

describe("racecheckIssue pipeline (injected deps)", () => {
  it("Svelte fixture: flags PR #17453 from keywords alone, with no issue link present", async () => {
    // The fixture's defining property: the racer never names the issue.
    assert.ok(!SVELTE_RACER.title.includes("17465") && !SVELTE_RACER.body.includes("17465"));
    const result = await racecheckIssue("sveltejs", "kit", 17465, depsFor(SVELTE_ISSUE, [SVELTE_RACER]));
    assert.equal(result.verdict, "RACE");
    assert.equal(result.matches.length, 1);
    const m = result.matches[0];
    assert.equal(m.number, 17453);
    assert.equal(m.author, "racer");
    assert.equal(m.createdAt, "2026-10-15T07:50:26Z");
    assert.ok(m.matchedKeywords.length >= 2, `matched: ${m.matchedKeywords.join(",")}`);
    assert.ok(m.evidence.includes("#17453"), m.evidence);
    assert.ok(m.evidence.includes("root"), m.evidence);
    assert.ok(result.reasons[0].includes("keyword race"), result.reasons[0]);
  });

  it("also catches the racer when it arrives via search instead of the list", async () => {
    const deps = {
      fetchIssue: async () => SVELTE_ISSUE,
      searchOpenPRs: async () => [SVELTE_RACER],
      listOpenPRs: async () => [],
      fetchFiles: async () => [],
    };
    const result = await racecheckIssue("sveltejs", "kit", 17465, deps);
    assert.equal(result.verdict, "RACE");
    assert.equal(result.matches[0].number, 17453);
  });

  it("generic-only overlap stays CLEAR", async () => {
    const issue: RaceIssue = {
      title: "Error in the app",
      body: "An error occurs when using the app.",
      labels: [],
      author: "x",
    };
    const pr: RacePRCandidate = {
      number: 9,
      title: "Fix error handling in the app",
      body: "This fixes the error and the broken problem.",
      author: "y",
      createdAt: "2026-10-01T00:00:00Z",
      url: "https://github.com/o/r/pull/9",
    };
    const result = await racecheckIssue("o", "r", 5, depsFor(issue, [pr]));
    assert.equal(result.verdict, "CLEAR");
    assert.equal(result.matches.length, 0);
  });

  it("a single weak term overlap is SUSPECT, never RACE", async () => {
    const issue: RaceIssue = {
      title: "Dark mode toggle contrast",
      body: "",
      labels: [],
      author: "x",
    };
    const pr: RacePRCandidate = {
      number: 12,
      title: "Improve toggle accessibility labels",
      body: "",
      author: "y",
      createdAt: "2026-10-02T00:00:00Z",
      url: "https://github.com/o/r/pull/12",
    };
    const result = await racecheckIssue("o", "r", 7, depsFor(issue, [pr]));
    assert.equal(result.verdict, "SUSPECT");
    assert.deepEqual(result.matches[0].termHits, ["toggle"]);
  });

  it("unrelated open PRs stay CLEAR", async () => {
    const prs: RacePRCandidate[] = [
      { number: 21, title: "Bump dependencies", body: "weekly bump", author: "bot2", createdAt: "2026-10-10T00:00:00Z", url: "https://github.com/sveltejs/kit/pull/21" },
      { number: 22, title: "Docs: new tutorial page", body: "adds a tutorial", author: "docwriter", createdAt: "2026-10-11T00:00:00Z", url: "https://github.com/sveltejs/kit/pull/22" },
    ];
    const result = await racecheckIssue("sveltejs", "kit", 17465, depsFor(SVELTE_ISSUE, prs));
    assert.equal(result.verdict, "CLEAR");
    assert.equal(result.matches.length, 0);
  });

  it("pure file overlap (no keyword overlap) is RACE when the pool is small", async () => {
    const issue: RaceIssue = {
      title: "Importer drops rows silently",
      body: "The importer in src/sync/types.ts drops rows.",
      labels: [],
      author: "x",
    };
    const pr: RacePRCandidate = {
      number: 31,
      title: "Refactor internals",
      body: "no overlap words here",
      author: "y",
      createdAt: "2026-10-03T00:00:00Z",
      url: "https://github.com/o/r/pull/31",
    };
    const result = await racecheckIssue("o", "r", 8, depsFor(issue, [pr], { 31: ["src/sync/types.ts"] }));
    assert.equal(result.verdict, "RACE");
    assert.deepEqual(result.matches[0].fileHits, ["src/sync/types.ts"]);
  });

  it("an unreadable issue is ERROR, not CLEAR", async () => {
    const deps = {
      fetchIssue: async () => { throw new Error("boom"); },
      searchOpenPRs: async () => [],
      listOpenPRs: async () => [],
      fetchFiles: async () => [],
    };
    const result = await racecheckIssue("o", "r", 1, deps);
    assert.equal(result.verdict, "ERROR");
  });
});

describe("applyRaceDemotion", () => {
  const rc = (verdict: "RACE" | "SUSPECT" | "CLEAR") => ({
    owner: "o", repo: "r", number: 1, url: "u", title: "t",
    verdict,
    keywords: { rare: [], terms: [], phrases: [], files: [] },
    matches: verdict === "CLEAR" ? [] : [{
      number: 17453, title: "fix: correctly cache type generation", author: "racer",
      createdAt: "2026-10-15T07:50:26Z", url: "https://github.com/sveltejs/kit/pull/17453",
      verdict: verdict as "RACE" | "SUSPECT",
      matchedKeywords: ["root", "route"], rareHits: [], phraseHits: ["root route"], termHits: [],
      fileHits: [], evidence: "#17453 \"fix: correctly cache type generation\" by @racer",
    }],
    reasons: [], apiCalls: 0,
  });

  it("RACE demotes GO to TAKEN with the keyword-race flag", () => {
    const target = { verdict: "GO", reasons: ["clean"], flags: [] as string[] };
    assert.equal(applyRaceDemotion(target, rc("RACE")), true);
    assert.equal(target.verdict, "TAKEN");
    assert.ok(target.flags.includes("keyword-race"));
    assert.ok(target.reasons[0].includes("17453"));
  });

  it("SUSPECT demotes GO to RISKY, and never touches TAKEN", () => {
    const go = { verdict: "GO", reasons: [] as string[], flags: [] as string[] };
    assert.equal(applyRaceDemotion(go, rc("SUSPECT")), true);
    assert.equal(go.verdict, "RISKY");
    const taken = { verdict: "TAKEN", reasons: [] as string[], flags: [] as string[] };
    assert.equal(applyRaceDemotion(taken, rc("RACE")), false);
    assert.equal(taken.verdict, "TAKEN");
  });

  it("CLEAR changes nothing", () => {
    const target = { verdict: "GO", reasons: [] as string[], flags: [] as string[] };
    assert.equal(applyRaceDemotion(target, rc("CLEAR")), false);
    assert.equal(target.verdict, "GO");
  });
});

describe("xray integration: the keyword race demotes a link-clean issue", () => {
  it("svelte-shaped repo: xray GO becomes TAKEN with flag keyword-race", async () => {
    const repo = `race-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    const issuePayload = {
      number: 17465,
      title: SVELTE_ISSUE.title,
      body: SVELTE_ISSUE.body,
      state: "open",
      labels: [],
      user: { login: "reporter" },
      html_url: `https://github.com/acme/${repo}/issues/17465`,
    };
    const racerPayload = {
      number: 17453,
      title: SVELTE_RACER.title,
      body: SVELTE_RACER.body,
      state: "open",
      merged_at: null,
      created_at: SVELTE_RACER.createdAt,
      user: { login: "racer" },
      html_url: `https://github.com/acme/${repo}/pull/17453`,
    };
    const impl = (async (url: string) => {
      const u = String(url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (u.includes("/timeline")) return json([]);
      if (u.includes("/comments")) return json([]);
      if (u.includes("/pulls?state=open")) return json([racerPayload]);
      if (u.includes("/pulls/17453/files")) return json([]);
      if (u.includes("/search/issues")) return json({ items: [] });
      if (u.includes(`/issues/17465`)) return json(issuePayload);
      return json({ message: `not mocked: ${u}` }, 404);
    }) as typeof fetch;
    setFetchImpl(impl);

    const result = await xrayIssue("acme", repo, 17465);
    assert.equal(result.verdict, "TAKEN", `reasons: ${result.reasons.join(" | ")}`);
    assert.ok(result.flags.includes("keyword-race"), `flags: ${result.flags.join(",")}`);
    assert.equal(result.racecheck?.verdict, "RACE");
    assert.equal(result.racecheck?.matches[0].number, 17453);
  });
});
