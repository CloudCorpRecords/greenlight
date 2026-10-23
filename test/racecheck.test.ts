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
  suppressByDocumentFrequency,
  stripUrls,
  isDependencyBotAuthor,
  isDependencyBotBranch,
  isBotShapedDependencyCandidate,
  isDependencyFile,
  isDependencyOnlyFileList,
  isDependencyUpdateBotPR,
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

  it("three term matches with two title-derived -> RACE (v0.20.1 bar)", () => {
    const s = scoreCandidate(kw, { title: "Deleted entries regenerated during sync", body: "" });
    assert.equal(s.verdict, "RACE");
    assert.ok(s.termHits.length >= 3);
    assert.ok(s.titleTermHits.length >= 2);
  });

  it("two term matches alone stay SUSPECT (v0.20.1 bar)", () => {
    const s = scoreCandidate(kw, { title: "Deleted entries cleaned during sync runs", body: "" });
    assert.equal(s.verdict, "SUSPECT");
    assert.equal(s.termHits.length, 2);
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

  it("a shared changed file alone -> SUSPECT, never RACE (v0.20.1)", () => {
    const kw2 = extractKeywords({
      title: "Importer drops rows",
      body: "The importer in src/sync/importer.ts drops rows silently.",
      labels: [],
      author: "x",
    });
    const s = scoreCandidate(kw2, { title: "Unrelated cleanup", body: "tidy" }, ["src/sync/importer.ts", "README.md"]);
    assert.equal(s.verdict, "SUSPECT");
    assert.deepEqual(s.fileHits, ["src/sync/importer.ts"]);
  });

  it("a shared changed file PLUS a bare term hit -> SUSPECT (v0.20.1, cubrid #882 lesson)", () => {
    const kw2 = extractKeywords({
      title: "Importer drops rows",
      body: "The importer in src/sync/importer.ts drops rows silently.",
      labels: [],
      author: "x",
    });
    const s = scoreCandidate(kw2, { title: "Importer cleanup", body: "tidy" }, ["src/sync/importer.ts"]);
    assert.equal(s.verdict, "SUSPECT");
    assert.deepEqual(s.fileHits, ["src/sync/importer.ts"]);
    assert.ok(s.termHits.includes("importer"));
  });

  it("a shared changed file PLUS a rare hit -> RACE (v0.20.1)", () => {
    const kw2 = extractKeywords({
      title: "Importer drops rows",
      body: "The importer in src/sync/importer.ts drops rows silently.",
      labels: [],
      author: "x",
    });
    const s = scoreCandidate(kw2, { title: "Unrelated cleanup", body: "also touches importer.ts" }, ["src/sync/importer.ts"]);
    assert.equal(s.verdict, "RACE");
    assert.deepEqual(s.fileHits, ["src/sync/importer.ts"]);
    assert.ok(s.rareHits.includes("importer.ts"));
  });

  it("the repo package prefix is stripped from rare tokens, keeping the distinctive remainder", () => {
    const kw = extractKeywords(
      {
        title: "Namespace of reflected timezone types",
        body: "The classes `sqlalchemy_cubrid.TIMESTAMPTZ` and `sqlalchemy_cubrid.types` live in `sqlalchemy_cubrid/types.py`; root is `sqlalchemy_cubrid/__init__.py`.",
        labels: [],
        author: "x",
      },
      { owner: "cubrid-lab", repo: "sqlalchemy-cubrid" }
    );
    assert.ok(kw.rare.includes("timestamptz"), `rare: ${kw.rare.join(",")}`);
    assert.ok(!kw.rare.includes("sqlalchemy_cubrid"), `rare: ${kw.rare.join(",")}`);
    assert.ok(!kw.files.includes("types.py") && !kw.rare.includes("types.py"), `files: ${kw.files.join(",")} rare: ${kw.rare.join(",")}`);
    assert.ok(!kw.files.some((f) => f.endsWith("__init__.py")), `files: ${kw.files.join(",")}`);
  });

  it("two body-only term matches cap at SUSPECT (v0.20.1 title-term rule)", () => {
    const kw2 = extractKeywords({
      title: "Improve rendering speed",
      body: "The logs mention \"zephyr\" and \"quill\" as slow paths.",
      labels: [],
      author: "x",
    });
    const s = scoreCandidate(kw2, { title: "Pipeline throughput work", body: "Optimizes the zephyr and quill stages." });
    assert.equal(s.verdict, "SUSPECT");
    assert.equal(s.termHits.length, 2);
    assert.equal(s.titleTermHits.length, 0);
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

  it("pure file overlap (no keyword overlap) is SUSPECT, not RACE (v0.20.1)", async () => {
    const issue: RaceIssue = {
      title: "Importer drops rows silently",
      body: "The importer in src/sync/importer.ts drops rows.",
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
    const result = await racecheckIssue("o", "r", 8, depsFor(issue, [pr], { 31: ["src/sync/importer.ts"] }));
    assert.equal(result.verdict, "SUSPECT");
    assert.deepEqual(result.matches[0].fileHits, ["src/sync/importer.ts"]);
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

describe("v0.20.1 precision: extraction discipline", () => {
  it("GitHub label names are never keywords", () => {
    const kw = extractKeywords({
      title: "Dark mode toggle contrast",
      body: "",
      labels: ["help wanted", "good first issue", "hacktoberfest", "beginner", "easy"],
      author: "x",
    });
    for (const w of ["help", "wanted", "good", "beginner", "easy", "hacktoberfest"]) {
      assert.ok(!kw.terms.includes(w), `label word leaked into terms: ${w}`);
    }
    assert.ok(kw.terms.includes("toggle"));
    assert.ok(kw.terms.includes("contrast"));
  });

  it("URLs and long quoted strings contribute no terms; their identifiers stay rare-only", () => {
    const kw = extractKeywords({
      title: "Root route types deleted on sync",
      body:
        "In `write_all_types` (https://github.com/sveltejs/kit/blob/73bf98/packages/kit/src/core/sync/write_types/index.js#L44-L55), " +
        "the cleanup loop deletes the root file. The quoted path \"packages/kit/src/core/sync/write_types/index.js\" shows it, " +
        "and a long note says \"the quick brown fox jumps over the lazy dog again and again and again and again\".",
      labels: [],
      author: "x",
    });
    for (const w of ["packages", "kit", "src", "core", "index", "generated", "blob", "master", "quick", "brown", "fox"]) {
      assert.ok(!kw.terms.includes(w), `noise word leaked into terms: ${w} (${kw.terms.join(",")})`);
    }
    assert.ok(kw.rare.includes("write_all_types"), `rare: ${kw.rare.join(",")}`);
    assert.ok(!kw.files.some((f) => f.endsWith("index.js")), `files: ${kw.files.join(",")}`);
  });

  it("stripUrls keeps only the basename of a URL", () => {
    const out = stripUrls("see https://github.com/o/r/blob/main/src/parser.ts#L3 for details");
    assert.ok(!out.includes("blob") && !out.includes("github"), out);
    assert.ok(out.includes("parser.ts"), out);
  });

  it("pure version tokens are not rare", () => {
    const toks = specialTokens("targets python 3.10 and node 20.5 and release 0.20.0");
    assert.ok(!toks.includes("3.10"), toks.join(","));
    assert.ok(!toks.includes("20.5"), toks.join(","));
    assert.ok(!toks.includes("0.20.0"), toks.join(","));
  });

  it("generic config filenames are never rare or named files", () => {
    const kw = extractKeywords({
      title: "Config parsing breaks on empty input",
      body: "The pyproject.toml and package.json are read first, but parser.ts is where it breaks.",
      labels: [],
      author: "x",
    });
    assert.ok(!kw.files.includes("pyproject.toml") && !kw.rare.includes("pyproject.toml"));
    assert.ok(!kw.files.includes("package.json") && !kw.rare.includes("package.json"));
    assert.ok(kw.files.includes("parser.ts"), `files: ${kw.files.join(",")}`);
  });

  it("owner and repo name tokens are never keywords", () => {
    const kw = extractKeywords(
      { title: "Cubrid dialect drops sqlalchemy connections", body: "", labels: [], author: "x" },
      { owner: "cubrid-lab", repo: "sqlalchemy-cubrid" }
    );
    assert.ok(!kw.terms.includes("cubrid") && !kw.terms.includes("sqlalchemy"), kw.terms.join(","));
    assert.ok(kw.terms.includes("dialect") && kw.terms.includes("connections"));
  });
});

describe("v0.20.1 precision: document-frequency suppression", () => {
  it("drops terms present in >25% (and >=2) of the corpus, keeps distinctive ones", () => {
    const kw = {
      rare: [], terms: ["ruff", "passes", "namespace"], phrases: [], files: [],
      titleTerms: ["ruff", "namespace"], titlePhrases: [],
    };
    const corpus = [0, 1, 2, 3].map((i) => ({
      title: `pr ${i}`,
      body: "checks: ruff check passes, pytest passes",
    }));
    const { keywords, suppressed } = suppressByDocumentFrequency(kw, corpus);
    assert.deepEqual([...suppressed].sort(), ["passes", "ruff"]);
    assert.deepEqual(keywords.terms, ["namespace"]);
    assert.deepEqual(keywords.titleTerms, ["namespace"]);
  });

  it("keeps a genuine phrase that appears in a small share of a large corpus", () => {
    const kw = {
      rare: [], terms: ["boilerplate"], phrases: ["root route"], files: [],
      titleTerms: [], titlePhrases: ["root route"],
    };
    const corpus = Array.from({ length: 10 }, (_, i) => ({
      title: `pr ${i}`,
      body: i === 0 ? "the root route types" : i >= 1 && i < 4 ? "boilerplate text" : "unrelated words here",
    }));
    const { keywords, suppressed } = suppressByDocumentFrequency(kw, corpus);
    assert.ok(suppressed.includes("boilerplate"), suppressed.join(",")); // 3/10 = 30% > 25%
    assert.deepEqual(keywords.phrases, ["root route"]); // 1/10 stays
  });

  it("never suppresses on a one-document corpus", () => {
    const kw = { rare: [], terms: ["ruff"], phrases: [], files: [], titleTerms: ["ruff"], titlePhrases: [] };
    const { suppressed } = suppressByDocumentFrequency(kw, [{ title: "x", body: "ruff ruff" }]);
    assert.deepEqual(suppressed, []);
  });
});

describe("v0.20.1 precision: the four failed v0.20.0 controls, as fixtures", () => {
  it("sloptotal #21 model: template vocabulary cannot RACE", async () => {
    const issue: RaceIssue = {
      title: "Enable ruff's import sorting rule (I) and fix what it reports",
      body:
        "`pyproject.toml` selects only ruff's `E`, `F` and `W` rules, so imports are ordered however each file happened to grow. " +
        "Add \"I\" to `[tool.ruff.lint] select`, run `ruff check --fix app tests scripts`, and check that `pytest -q` still passes. " +
        "Keep `app/main.py`'s intentional late import.",
      labels: ["help wanted", "good first issue", "tooling", "beginner", "easy", "hacktoberfest"],
      author: "maintainer",
    };
    const prs: RacePRCandidate[] = [
      {
        number: 44, title: "Add a sloptotal CLI, Python client and MCP server",
        body: "Adds cli.py and a Python client. Install via pip; entry points live in pyproject.toml. Checks: ruff check passes, pytest passes. Import sorting is handled by ruff.",
        author: "a", createdAt: "2026-09-01T00:00:00Z", url: "https://github.com/pablocaeg/sloptotal/pull/44",
      },
      {
        number: 121, title: "Fix HTML page for missing reports",
        body: "The reports page 404s when a report was deleted. Checks: ruff check passes, pytest passes.",
        author: "b", createdAt: "2026-09-02T00:00:00Z", url: "https://github.com/pablocaeg/sloptotal/pull/121",
      },
      {
        number: 118, title: "Refactor feedback handling in report.js",
        body: "Moves feedback rendering out of report.js; reports rendering is unchanged. Checks: ruff check passes, pytest passes.",
        author: "c", createdAt: "2026-09-03T00:00:00Z", url: "https://github.com/pablocaeg/sloptotal/pull/118",
      },
    ];
    const result = await racecheckIssue("pablocaeg", "sloptotal", 21, depsFor(issue, prs));
    assert.notEqual(result.verdict, "RACE", `matches: ${result.matches.map((m) => m.evidence).join(" | ")}`);
    assert.ok(result.matches.every((m) => m.verdict === "SUSPECT"));
    assert.ok(result.reasons.join(" ").includes("ruff"), `reasons: ${result.reasons.join(" | ")}`);
  });

  it("cubrid #882 model: shared type vocabulary cannot RACE", async () => {
    const issue: RaceIssue = {
      title: "docs(types): correct the namespace of reflected timezone types",
      body:
        "## Problem\nREADME's timezone-reflection limitation names `sqlalchemy_cubrid.TIMESTAMPTZ` and the related timezone types. " +
        "These classes live in `sqlalchemy_cubrid.types`, but the package root does not export them.",
      labels: ["documentation", "priority: low", "size: S", "status: in progress"],
      author: "maintainer",
    };
    const prs: RacePRCandidate[] = [
      {
        number: 980, title: "chore(types)!: remove the deprecated display_width and values type arguments",
        body: "Removes the deprecated display_width and values type arguments. Reflected types no longer accept them.",
        author: "us", createdAt: "2026-10-18T00:00:00Z", url: "https://github.com/cubrid-lab/sqlalchemy-cubrid/pull/980",
      },
      {
        number: 910, title: "chore(main): release 1.11.2",
        body: "Release 1.11.2. See the changelog for the full list of changes in this release.",
        author: "maintainer", createdAt: "2026-10-10T00:00:00Z", url: "https://github.com/cubrid-lab/sqlalchemy-cubrid/pull/910",
      },
    ];
    const result = await racecheckIssue("cubrid-lab", "sqlalchemy-cubrid", 882, depsFor(issue, prs));
    assert.notEqual(result.verdict, "RACE", `matches: ${result.matches.map((m) => m.evidence).join(" | ")}`);
    assert.ok(result.matches.every((m) => m.verdict === "SUSPECT"));
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

describe("v0.21.1 dependency-bot exclusion (sveltejs/kit PR #17481 regression)", () => {
  // Modeled on the verified live case: PR sveltejs/kit#17481,
  // "chore(deps): update all non-major dependencies" by renovate[bot]
  // on branch renovate/all-minor-patch, files package.json and
  // pnpm-lock.yaml only. Its body is a dependency table plus the
  // upstream release notes of the bumped packages; those notes share
  // enough problem vocabulary with issue #17465 (root, deleted,
  // regenerated, sync) to clear the RACE-by-terms bar even though the
  // PR cannot be implementing the issue. Verified against the live
  // API on 2026-10-22: the real body scores RACE against the real
  // issue with the pre-fix scorer.
  const RENOVATE_PR: RacePRCandidate = {
    number: 17481,
    title: "chore(deps): update all non-major dependencies",
    body:
      "This PR contains the following updates:\n\n" +
      "| Package | Change | Age | Confidence |\n|---|---|---|---|\n" +
      "| [oxfmt](https://oxc.rs) | `^0.73.0` -> `^0.74.0` | | |\n" +
      "| [pnpm](https://pnpm.io) | `12.11.2` -> `12.14.0` | | |\n\n" +
      "---\n\n### Release Notes\n\n" +
      "<details><summary>oxc-project/oxc (oxfmt)</summary>\n\n" +
      "Bug Fixes\n" +
      "- formatter: deleted cache entries are regenerated on every sync pass\n" +
      "- formatter: root config discovery keeps its previous behavior\n" +
      "</details>",
    author: "renovate[bot]",
    createdAt: "2026-10-19T00:00:00Z",
    url: "https://github.com/sveltejs/kit/pull/17481",
    headRef: "renovate/all-minor-patch",
  } as RacePRCandidate;
  const DEP_ONLY_FILES = ["package.json", "pnpm-lock.yaml"];

  it("the renovate fixture text-matches at RACE level on its own (precondition)", () => {
    const s = scoreCandidate(extractKeywords(SVELTE_ISSUE), RENOVATE_PR);
    assert.equal(s.verdict, "RACE", `score: ${JSON.stringify(s)}`);
  });

  it("a renovate dependency-only PR does not produce RACE and is reported as ignored", async () => {
    const result = await racecheckIssue(
      "sveltejs", "kit", 17465,
      depsFor(SVELTE_ISSUE, [RENOVATE_PR], { 17481: DEP_ONLY_FILES })
    );
    assert.equal(result.verdict, "CLEAR", `matches: ${result.matches.map((m) => m.evidence).join(" | ")}`);
    assert.equal(result.matches.length, 0);
    assert.equal(result.ignoredMatches?.length, 1, `ignored: ${JSON.stringify(result.ignoredMatches)}`);
    assert.equal(result.ignoredMatches?.[0].number, 17481);
    assert.equal(result.ignoredMatches?.[0].author, "renovate[bot]");
    assert.ok(
      (result.ignoredMatches?.[0].ignoreReason ?? "").includes("dependency"),
      result.ignoredMatches?.[0].ignoreReason
    );
    assert.ok(result.reasons.join(" ").includes("17481"), `reasons: ${result.reasons.join(" | ")}`);
  });

  it("a renovate PR that also touches a source file still counts", async () => {
    const files = [...DEP_ONLY_FILES, "packages/kit/src/core/sync/write_types/index.js"];
    const result = await racecheckIssue(
      "sveltejs", "kit", 17465,
      depsFor(SVELTE_ISSUE, [RENOVATE_PR], { 17481: files })
    );
    assert.equal(result.verdict, "RACE");
    assert.equal(result.matches[0].number, 17481);
    assert.equal(result.ignoredMatches?.length ?? 0, 0);
  });

  it("a human PR with the same title, body and dep-only files still counts", async () => {
    const human: RacePRCandidate = {
      ...RENOVATE_PR,
      author: "human-dev",
      headRef: "chore/deps-refresh",
    } as RacePRCandidate;
    const result = await racecheckIssue(
      "sveltejs", "kit", 17465,
      depsFor(SVELTE_ISSUE, [human], { 17481: DEP_ONLY_FILES })
    );
    assert.equal(result.verdict, "RACE");
    assert.equal(result.matches[0].number, 17481);
    assert.equal(result.ignoredMatches?.length ?? 0, 0);
  });

  it("a dependabot dependency-only PR is ignored the same way", async () => {
    const dependabot: RacePRCandidate = {
      ...RENOVATE_PR,
      number: 17482,
      title: "chore(deps): bump lodash from 4.17.20 to 4.17.21",
      author: "dependabot[bot]",
      headRef: "dependabot/npm_and_yarn/lodash-4.17.21",
      url: "https://github.com/sveltejs/kit/pull/17482",
    } as RacePRCandidate;
    const result = await racecheckIssue(
      "sveltejs", "kit", 17465,
      depsFor(SVELTE_ISSUE, [dependabot], { 17482: ["package.json", "package-lock.json"] })
    );
    assert.equal(result.verdict, "CLEAR");
    assert.equal(result.ignoredMatches?.length, 1);
    assert.equal(result.ignoredMatches?.[0].number, 17482);
  });

  it("a renovate/* branch alone marks the candidate as bot-shaped", async () => {
    const branchOnly: RacePRCandidate = {
      ...RENOVATE_PR,
      author: "octocat",
    } as RacePRCandidate;
    const result = await racecheckIssue(
      "sveltejs", "kit", 17465,
      depsFor(SVELTE_ISSUE, [branchOnly], { 17481: DEP_ONLY_FILES })
    );
    assert.equal(result.verdict, "CLEAR");
    assert.equal(result.ignoredMatches?.length, 1);
  });

  it("a bot-shaped PR whose files cannot be shown dep-only still counts (fail open)", async () => {
    const result = await racecheckIssue(
      "sveltejs", "kit", 17465,
      depsFor(SVELTE_ISSUE, [RENOVATE_PR], {})
    );
    assert.equal(result.verdict, "RACE");
    assert.equal(result.matches[0].number, 17481);
    assert.equal(result.ignoredMatches?.length ?? 0, 0);
  });

  it("helper predicates: bot shape, dependency files, and the combined exclusion", () => {
    assert.equal(isDependencyBotAuthor("renovate[bot]"), true);
    assert.equal(isDependencyBotAuthor("dependabot[bot]"), true);
    assert.equal(isDependencyBotAuthor("dependabot-preview[bot]"), true);
    assert.equal(isDependencyBotAuthor("my-renovate-fork[bot]"), true);
    assert.equal(isDependencyBotAuthor("github-actions[bot]"), false);
    assert.equal(isDependencyBotAuthor("racer"), false);
    assert.equal(isDependencyBotBranch("renovate/all-minor-patch"), true);
    assert.equal(isDependencyBotBranch("dependabot/npm_and_yarn/lodash-4.17.21"), true);
    assert.equal(isDependencyBotBranch("feat/renovate-ui"), false);
    assert.equal(isDependencyBotBranch(undefined), false);
    assert.equal(isBotShapedDependencyCandidate({ author: "x", headRef: "renovate/foo" }), true);
    assert.equal(isBotShapedDependencyCandidate({ author: "x" }), false);

    for (const f of [
      "package.json", "packages/kit/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
      "yarn.lock", "bun.lockb", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum",
      "requirements.txt", "requirements-dev.txt", "requirements/base.txt",
      "Pipfile.lock", "poetry.lock", "composer.json", "Gemfile.lock", "pom.xml",
    ]) {
      assert.equal(isDependencyFile(f), true, f);
    }
    for (const f of [
      "src/index.ts", "packages/kit/src/routes/+page.svelte", "README.md",
      ".github/workflows/ci.yml", "vite.config.ts", "svelte.config.js",
    ]) {
      assert.equal(isDependencyFile(f), false, f);
    }
    assert.equal(isDependencyOnlyFileList(["package.json", "pnpm-lock.yaml"]), true);
    assert.equal(isDependencyOnlyFileList(["package.json", "src/index.ts"]), false);
    assert.equal(isDependencyOnlyFileList([]), false);

    assert.equal(
      isDependencyUpdateBotPR({ author: "renovate[bot]", headRef: "renovate/x" }, ["package.json"]),
      true
    );
    assert.equal(
      isDependencyUpdateBotPR({ author: "renovate[bot]" }, ["package.json", "src/a.ts"]),
      false
    );
    assert.equal(
      isDependencyUpdateBotPR({ author: "human" }, ["package.json"]),
      false
    );
  });

  it("with a genuine racer also present, the verdict is RACE from the racer and the bot PR is only ignored", async () => {
    const result = await racecheckIssue(
      "sveltejs", "kit", 17465,
      depsFor(SVELTE_ISSUE, [RENOVATE_PR, SVELTE_RACER], { 17481: DEP_ONLY_FILES })
    );
    assert.equal(result.verdict, "RACE");
    assert.deepEqual(result.matches.map((m) => m.number), [17453]);
    assert.equal(result.ignoredMatches?.length, 1);
    assert.equal(result.ignoredMatches?.[0].number, 17481);
  });
});

// --- v0.21.2 (GL-1): prose abbreviations and generic-term false RACE ---
// Field case (production validation 2026-10-22): usebruno/bruno#9611, a
// clean feature request, racechecked RACE with 15 RACE matches whose only
// rare hit was "e.g" — the prose abbreviation harvested by specialTokens —
// and sveltejs/kit#17529 graded a "Version Packages" release-train PR and
// an @font-face PR as RACE on generic title terms alone.

const BRUNO_9611_ISSUE: RaceIssue = {
  title: "Display of combined docs at the requests",
  body:
    "Bruno should display the combined documentation of a request, e.g. the docs " +
    "inherited from the folder. For example a folder structure with a \"Public Subfolder\" " +
    "and a \"Restricted Subfolder\" should show the combined docs, e.g. in the docs tab. " +
    "The api response image should be included.",
  labels: ["enhancement"],
  author: "reporter",
};

describe("v0.21.2 GL-1: abbreviation rare tokens", () => {
  it("specialTokens does not harvest prose abbreviations (e.g, i.e) as rare tokens", () => {
    const toks = specialTokens("Use the combined docs, e.g. the folder docs, i.e. inherited ones.");
    assert.ok(!toks.includes("e.g"), `tokens: ${toks.join(",")}`);
    assert.ok(!toks.includes("i.e"), `tokens: ${toks.join(",")}`);
  });

  it("extractKeywords on the bruno #9611 model yields no abbreviation rare token", () => {
    const kw = extractKeywords(BRUNO_9611_ISSUE, { owner: "usebruno", repo: "bruno" });
    assert.ok(!kw.rare.includes("e.g"), `rare: ${kw.rare.join(",")}`);
    assert.ok(!kw.rare.includes("i.e"), `rare: ${kw.rare.join(",")}`);
  });

  it("a PR matching only the abbreviation plus generic terms is not RACE", () => {
    const kw = extractKeywords(BRUNO_9611_ISSUE, { owner: "usebruno", repo: "bruno" });
    const s = scoreCandidate(kw, {
      title: "fix: collection runner iteration data files",
      body: "The runner reads data files, e.g. csv files, and shows an image of the api response.",
    });
    assert.notEqual(s.verdict, "RACE", `score: ${JSON.stringify(s)}`);
  });

  it("pipeline: bruno #9611 model with e.g-laden unrelated PRs is not RACE and does not demote to TAKEN", async () => {
    const prs: RacePRCandidate[] = [7666, 9061, 9376].map((n) => ({
      number: n,
      title: `unrelated PR ${n}`,
      body: "This change touches the api docs, e.g. an image link in the response.",
      author: "someone",
      createdAt: "2026-10-01T00:00:00Z",
      url: `https://github.com/usebruno/bruno/pull/${n}`,
    }));
    const result = await racecheckIssue("usebruno", "bruno", 9611, depsFor(BRUNO_9611_ISSUE, prs));
    assert.notEqual(result.verdict, "RACE", `matches: ${result.matches.map((m) => m.evidence).join(" | ")}`);
    assert.ok(!result.matches.some((m) => m.verdict === "RACE"));
    const target = { verdict: "GO", reasons: [] as string[], flags: [] as string[] };
    applyRaceDemotion(target, result);
    assert.notEqual(target.verdict, "TAKEN");
  });
});

describe("v0.21.2 GL-1: non-file rare hits need corroboration for RACE", () => {
  const kwId = extractKeywords({
    title: "View transition promise never resolves",
    body: "The currentTransition.updateCallbackDone promise and the sync_init hook are involved.",
    labels: [],
    author: "x",
  });

  it("a single non-file rare hit alone is SUSPECT, not RACE", () => {
    const s = scoreCandidate(kwId, { title: "Cleanup", body: "Notes on updateCallbackDone timing." });
    assert.equal(s.verdict, "SUSPECT", `score: ${JSON.stringify(s)}`);
    assert.deepEqual(s.rareHits, ["updatecallbackdone"]);
  });

  it("two distinct non-file rare hits corroborate to RACE", () => {
    const s = scoreCandidate(kwId, {
      title: "Cleanup",
      body: "Notes on updateCallbackDone timing and the sync_init hook.",
    });
    assert.equal(s.verdict, "RACE", `score: ${JSON.stringify(s)}`);
    assert.ok(s.rareHits.length >= 2);
  });

  it("a single non-file rare hit plus a phrase hit is RACE", () => {
    const s = scoreCandidate(kwId, {
      title: "View transition promise never resolves",
      body: "updateCallbackDone timing",
    });
    assert.equal(s.verdict, "RACE", `score: ${JSON.stringify(s)}`);
  });
});

describe("v0.21.2 GL-1: term-only RACE needs distinctive title terms", () => {
  it("generic title terms alone (Version Packages model) do not reach RACE", () => {
    const kw = {
      rare: [] as string[],
      terms: ["adapter", "cloudflare", "platform", "proxy", "keeps", "reloads", "env", "wrangler", "stale"],
      phrases: [] as string[],
      files: [] as string[],
      titleTerms: ["adapter", "cloudflare", "proxy", "keeps", "reloads", "env"],
      titlePhrases: [] as string[],
    };
    const s = scoreCandidate(kw, {
      title: "Version Packages",
      body: "These adapter platform packages keep the cloudflare proxy reloads working in every env.",
    });
    assert.notEqual(s.verdict, "RACE", `score: ${JSON.stringify(s)}`);
  });

  it("distinctive title terms still reach RACE by terms", () => {
    const kw = extractKeywords(SVELTE_ISSUE);
    const s = scoreCandidate(kw, { title: "Deleted entries regenerated during sync", body: "" });
    assert.equal(s.verdict, "RACE");
  });
});

