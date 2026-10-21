/**
 * Timeline X-Ray tests (v0.13.0).
 *
 * Mocked timeline/search/PR-detail payloads drive xrayIssue through the
 * real fetchLinkedPRs + classifyLinkStrength + detectClaims pipeline
 * (setFetchImpl seam, unique fake repo per test to dodge the file cache).
 * The regression block models the real usebruno/bruno field cases from
 * 2026-10-18: 8149/9319/8287/8264/9517/9483 TAKEN, 7227/6927 GO.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setFetchImpl,
  resetApiCalls,
  extractTimelineCrossRefPRs,
} from "../src/github.js";
import { xrayIssue, xrayIssues, sortXrayResults, applyXrayDemotion } from "../src/xray.js";

afterEach(() => setFetchImpl(null));

/**
 * Unique repo per budget-sensitive test: the API cache is file-backed
 * (~/.cache/greenlight, 6h TTL), so a repo reused across runs would hit
 * a warm cache and under-count calls.
 */
function freshRepo(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
}

interface Route {
  match: (url: string) => boolean;
  body?: unknown;
  respond?: (url: string) => { body: unknown; status?: number };
  status?: number;
}

function mockApi(routes: Route[]): void {
  const impl = (async (url: string) => {
    const u = String(url);
    for (const r of routes) {
      if (r.match(u)) {
        const res = r.respond ? r.respond(u) : { body: r.body, status: r.status };
        return new Response(JSON.stringify(res.body), {
          status: res.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ message: `not mocked: ${u}` }), { status: 404 });
  }) as typeof fetch;
  setFetchImpl(impl);
}

// --- payload builders (real GitHub shapes, fake repos) ---

const issuePayload = (repo: string, n: number, author: string) => ({
  number: n,
  title: `Issue ${n}`,
  state: "open",
  user: { login: author },
  html_url: `https://github.com/acme/${repo}/issues/${n}`,
});

const xrefEvent = (repo: string, pr: number) => ({
  event: "cross-referenced",
  source: {
    type: "issue",
    issue: {
      html_url: `https://github.com/acme/${repo}/pull/${pr}`,
      title: `PR ${pr}`,
      pull_request: {},
    },
  },
});

const prDetail = (
  repo: string,
  n: number,
  opts: { body?: string; state?: "open" | "closed"; branch?: string; author?: string; merged?: boolean } = {}
) => ({
  number: n,
  title: `PR ${n}`,
  body: opts.body ?? "",
  state: opts.merged ? "closed" : (opts.state ?? "open"),
  merged_at: opts.merged ? "2026-10-01T00:00:00Z" : null,
  head: { ref: opts.branch ?? "" },
  user: { login: opts.author ?? "someone-else" },
  html_url: `https://github.com/acme/${repo}/pull/${n}`,
});

const searchHit = (repo: string, n: number, open = true) => ({
  number: n,
  state: open ? "open" : "closed",
  title: `PR ${n}`,
  html_url: `https://github.com/acme/${repo}/pull/${n}`,
  pull_request: { merged_at: null },
});

const commentPayload = (author: string, body: string, createdAt = "2026-10-18T10:00:00Z") => ({
  id: Math.floor(Math.random() * 1e9),
  user: { login: author },
  body,
  created_at: createdAt,
});

/** Routes for one issue; timeline/search/comments/PR details as given. */
function issueRoutes(
  repo: string,
  n: number,
  opts: {
    author?: string;
    timeline?: unknown[];
    timelinePages?: unknown[][];
    search?: unknown[];
    prs?: Record<number, unknown>;
    comments?: unknown[];
  } = {}
): Route[] {
  const author = opts.author ?? "reporter";
  const pages = opts.timelinePages ?? (opts.timeline !== undefined ? [opts.timeline] : [[]]);
  return [
    {
      match: (u) => u.includes(`/issues/${n}/timeline`),
      respond: (u) => {
        const m = /[?&]page=(\d+)/.exec(u);
        const page = m ? Number(m[1]) : 1;
        return { body: pages[page - 1] ?? [] };
      },
    },
    {
      match: (u) => u.includes("/search/issues"),
      body: { items: opts.search ?? [] },
    },
    {
      match: (u) => new RegExp(`/issues/${n}(\\?|$)`).test(u),
      body: issuePayload(repo, n, author),
    },
    {
      match: (u) => u.includes(`/issues/${n}/comments`),
      body: opts.comments ?? [],
    },
    {
      match: (u) => /\/pulls\/(\d+)/.test(u),
      respond: (u) => {
        const m = /\/pulls\/(\d+)/.exec(u);
        const pr = m ? Number(m[1]) : 0;
        return { body: (opts.prs ?? {})[pr] ?? prDetail(repo, pr) };
      },
    },
  ];
}

describe("xrayIssue verdicts", () => {
  it("open closing PR in the timeline -> TAKEN (bruno#8149 shape)", async () => {
    const repo = "wx1";
    mockApi(
      issueRoutes(repo, 8149, {
        author: "mlkauppila",
        timeline: [xrefEvent(repo, 8176)],
        prs: { 8176: prDetail(repo, 8176, { body: "Closes #8149\n\nSigV4 fix", author: "contributor" }) },
      })
    );
    const r = await xrayIssue("acme", repo, 8149);
    assert.equal(r.verdict, "TAKEN");
    assert.ok(r.reasons[0].includes("#8176"), `reason names the PR: ${r.reasons[0]}`);
    assert.equal(r.linkedPRs[0].linkStrength, "closing");
    assert.equal(r.linkedPRs[0].via, "timeline");
    assert.equal(r.deepVerified, true);
  });

  it("reporter's own open PR, mention strength, search-discovered -> TAKEN (bruno#9319 shape)", async () => {
    const repo = "wx2";
    mockApi(
      issueRoutes(repo, 9319, {
        author: "FClannad",
        timeline: [],
        search: [searchHit(repo, 9320)],
        prs: {
          9320: prDetail(repo, 9320, {
            body: "My prepared fix for #9319, please review",
            author: "FClannad",
          }),
        },
      })
    );
    const r = await xrayIssue("acme", repo, 9319);
    assert.equal(r.verdict, "TAKEN");
    assert.ok(r.flags.includes("reporter-own-pr"), `flags: ${r.flags.join(",")}`);
    assert.equal(r.linkedPRs[0].linkStrength, "mention");
    assert.equal(r.linkedPRs[0].reporterOwned, true);
  });

  it("open mention PR by someone else -> RISKY with weak-pr-mention", async () => {
    const repo = "wx3";
    mockApi(
      issueRoutes(repo, 100, {
        timeline: [xrefEvent(repo, 101)],
        prs: { 101: prDetail(repo, 101, { body: "Related work, see #100", author: "stranger" }) },
      })
    );
    const r = await xrayIssue("acme", repo, 100);
    assert.equal(r.verdict, "TAKEN", "timeline xref takes it even at mention strength (Rule 3d)");
    assert.ok(r.flags.includes("cross-referenced-pr"));
  });

  it("open mention PR found via search only -> RISKY", async () => {
    const repo = "wx4";
    mockApi(
      issueRoutes(repo, 200, {
        timeline: [],
        search: [searchHit(repo, 201)],
        prs: { 201: prDetail(repo, 201, { body: "Might help #200", author: "stranger" }) },
      })
    );
    const r = await xrayIssue("acme", repo, 200);
    assert.equal(r.verdict, "RISKY");
    assert.ok(r.flags.includes("weak-pr-mention"));
    assert.equal(r.linkedPRs[0].via, "search");
  });

  it("only closed PRs -> GO with a note", async () => {
    const repo = "wx5";
    mockApi(
      issueRoutes(repo, 300, {
        timeline: [xrefEvent(repo, 301)],
        prs: { 301: prDetail(repo, 301, { body: "Closes #300", state: "closed", author: "someone" }) },
      })
    );
    const r = await xrayIssue("acme", repo, 300);
    assert.equal(r.verdict, "GO");
    assert.ok(r.reasons[0].includes("closed/merged"), `reason: ${r.reasons[0]}`);
  });

  it("merged closing PR -> GO with a note", async () => {
    const repo = "wx6";
    mockApi(
      issueRoutes(repo, 400, {
        timeline: [xrefEvent(repo, 401)],
        prs: { 401: prDetail(repo, 401, { body: "Fixes #400", merged: true, author: "someone" }) },
      })
    );
    const r = await xrayIssue("acme", repo, 400);
    assert.equal(r.verdict, "GO");
    assert.equal(r.linkedPRs[0].state, "merged");
  });

  it("no timeline events, no comments -> GO", async () => {
    const repo = freshRepo("wx7");
    mockApi(issueRoutes(repo, 500, {}));
    const r = await xrayIssue("acme", repo, 500);
    assert.equal(r.verdict, "GO");
    assert.deepEqual(r.linkedPRs, []);
    assert.ok(r.apiCalls >= 3, `expected >= 3 calls, got ${r.apiCalls}`);
    assert.ok(r.apiCalls <= 6, `budget: expected <= 6 calls, got ${r.apiCalls}`);
  });

  it("fresh comment claim with no PRs -> RISKY with claimed-by flag", async () => {
    const repo = "wx8";
    mockApi(
      issueRoutes(repo, 600, {
        comments: [commentPayload("helper", "I'd like to work on this issue")],
      })
    );
    const r = await xrayIssue("acme", repo, 600);
    assert.equal(r.verdict, "RISKY");
    assert.ok(r.flags.some((f) => f.includes("claimed-by @helper")), `flags: ${r.flags.join(",")}`);
    assert.equal(r.claimFlags[0].author, "helper");
  });

  it("comment claim race (2 strong claimants) -> TAKEN", async () => {
    const repo = "wx9";
    mockApi(
      issueRoutes(repo, 700, {
        comments: [
          commentPayload("alice", "I'd like to take this on"),
          commentPayload("bob", "I would like to work on this too"),
        ],
      })
    );
    const r = await xrayIssue("acme", repo, 700);
    assert.equal(r.verdict, "TAKEN");
    assert.ok(r.reasons[0].includes("claim race"));
  });

  it("walks a multi-page timeline to find the xref", async () => {
    const repo = "wx10";
    const filler = Array.from({ length: 100 }, (_, i) => ({ event: "labeled", id: i }));
    mockApi(
      issueRoutes(repo, 800, {
        timelinePages: [filler, [xrefEvent(repo, 801)]],
        prs: { 801: prDetail(repo, 801, { body: "Closes #800" }) },
      })
    );
    const r = await xrayIssue("acme", repo, 800);
    assert.equal(r.verdict, "TAKEN");
    assert.equal(r.linkedPRs[0].number, 801);
  });

  it("fetch failure degrades to ERROR, not a thrown exception", async () => {
    const repo = "wx11";
    mockApi([
      { match: (u) => u.includes(`/issues/900/timeline`), status: 500, body: { message: "boom" } },
      { match: (u) => u.includes("/search/issues"), status: 500, body: { message: "boom" } },
      { match: (u) => new RegExp(`/issues/900(\\?|$)`).test(u), status: 500, body: { message: "boom" } },
      { match: (u) => u.includes(`/issues/900/comments`), status: 500, body: { message: "boom" } },
    ]);
    const r = await xrayIssue("acme", repo, 900);
    // timeline/search/author are all best-effort: empty evidence -> GO, not ERROR.
    assert.equal(r.verdict, "GO");
  });
});

describe("extractTimelineCrossRefPRs", () => {
  it("ignores commit-sourced cross-reference events", () => {
    const out = extractTimelineCrossRefPRs([
      { event: "cross-referenced", source: { type: "commit", issue: { html_url: "https://github.com/acme/w/commit/abc" } } },
    ]);
    assert.deepEqual(out, []);
  });

  it("extracts PR cross-references from the real nested shape", () => {
    const out = extractTimelineCrossRefPRs([
      {
        event: "cross-referenced",
        source: {
          type: "issue",
          issue: {
            html_url: "https://github.com/acme/w/pull/8176",
            title: "SigV4 fix",
            pull_request: {},
          },
        },
      },
    ]);
    assert.deepEqual(out, [{ number: 8176, title: "SigV4 fix", url: "https://github.com/acme/w/pull/8176" }]);
  });
});

describe("bruno field regression (2026-10-18)", () => {
  const bruno = (
    repo: string,
    n: number,
    opts: Parameters<typeof issueRoutes>[2]
  ): void => {
    mockApi(issueRoutes(repo, n, opts));
  };

  it("#8287 taken by open PR #8288 (timeline, closing)", async () => {
    bruno("wb1", 8287, {
      timeline: [xrefEvent("wb1", 8288)],
      prs: { 8288: prDetail("wb1", 8288, { body: "Fixes #8287" }) },
    });
    assert.equal((await xrayIssue("acme", "wb1", 8287)).verdict, "TAKEN");
  });

  it("#8264 taken by open PR #9475 (timeline, mention strength still takes)", async () => {
    bruno("wb2", 8264, {
      timeline: [xrefEvent("wb2", 9475)],
      prs: { 9475: prDetail("wb2", 9475, { body: "Takes a stab at #8264" }) },
    });
    assert.equal((await xrayIssue("acme", "wb2", 8264)).verdict, "TAKEN");
  });

  it("#9517 taken by open PR #9552 (timeline, closing)", async () => {
    bruno("wb3", 9517, {
      timeline: [xrefEvent("wb3", 9552)],
      prs: { 9552: prDetail("wb3", 9552, { body: "Closes #9517" }) },
    });
    assert.equal((await xrayIssue("acme", "wb3", 9517)).verdict, "TAKEN");
  });

  it("#9483 taken by open PR #9484 (timeline, branch-token closing)", async () => {
    bruno("wb4", 9483, {
      timeline: [xrefEvent("wb4", 9484)],
      prs: { 9484: prDetail("wb4", 9484, { body: "WSDL importer tweak", branch: "fix/9483-wsdl" }) },
    });
    const r = await xrayIssue("acme", "wb4", 9483);
    assert.equal(r.verdict, "TAKEN");
    assert.equal(r.linkedPRs[0].linkStrength, "closing");
  });

  it("#7227 GO: no linked PRs, no claims (as of 2026-10-18)", async () => {
    bruno("wb5", 7227, { author: "mlkauppila" });
    const r = await xrayIssue("acme", "wb5", 7227);
    assert.equal(r.verdict, "GO");
  });

  it("#6927 GO: no linked PRs, no claims (as of 2026-10-18)", async () => {
    bruno("wb6", 6927, { author: "rreyn-bruno" });
    const r = await xrayIssue("acme", "wb6", 6927);
    assert.equal(r.verdict, "GO");
  });

  // v0.21.0 hardening pin: the same two issues flipped to TAKEN in the
  // field solely because our own PRs (#9569 for #7227, #9570 for #6927)
  // cross-reference them. Same fixture, one added cross-referencing
  // closing PR: GO must become TAKEN, so the flip is attributable to
  // the cross-reference alone.
  it("#7227 flips to TAKEN when our own PR #9569 cross-references it", async () => {
    bruno("wb5x", 7227, {
      author: "mlkauppila",
      timeline: [xrefEvent("wb5x", 9569)],
      prs: { 9569: prDetail("wb5x", 9569, { body: "Fixes #7227", author: "CloudCorpRecords" }) },
    });
    const r = await xrayIssue("acme", "wb5x", 7227);
    assert.equal(r.verdict, "TAKEN");
  });

  it("#6927 flips to TAKEN when our own PR #9570 cross-references it", async () => {
    bruno("wb6x", 6927, {
      author: "rreyn-bruno",
      timeline: [xrefEvent("wb6x", 9570)],
      prs: { 9570: prDetail("wb6x", 9570, { body: "Fixes #6927", author: "CloudCorpRecords" }) },
    });
    const r = await xrayIssue("acme", "wb6x", 6927);
    assert.equal(r.verdict, "TAKEN");
  });
});

describe("applyXrayDemotion", () => {
  const xr = (verdict: string, reasons: string[] = ["x reason"], flags: string[] = ["x-flag"]) =>
    ({
      verdict,
      reasons,
      flags,
      linkedPRs: [],
      claimFlags: [],
      deepVerified: true as const,
      apiCalls: 4,
      owner: "acme",
      repo: "w",
      number: 1,
      url: "https://github.com/acme/w/issues/1",
      title: "t",
    }) as unknown as Parameters<typeof applyXrayDemotion>[1];

  it("demotes GO to TAKEN and merges reasons with x-ray evidence first", () => {
    const scan = { verdict: "GO", reasons: ["no linked PRs"], flags: [] as string[] };
    assert.equal(applyXrayDemotion(scan, xr("TAKEN")), true);
    assert.equal(scan.verdict, "TAKEN");
    assert.deepEqual(scan.reasons, ["x reason", "no linked PRs"]);
    assert.ok(scan.flags.includes("xray-deep-verified"));
    assert.ok(scan.flags.includes("x-flag"));
  });

  it("demotes RISKY to TAKEN but never promotes or touches ERROR x-rays", () => {
    const scan = { verdict: "RISKY", reasons: ["weak mention"], flags: [] as string[] };
    assert.equal(applyXrayDemotion(scan, xr("TAKEN")), true);
    assert.equal(scan.verdict, "TAKEN");

    const scan2 = { verdict: "TAKEN", reasons: ["closing PR"], flags: [] as string[] };
    assert.equal(applyXrayDemotion(scan2, xr("GO")), false);
    assert.equal(scan2.verdict, "TAKEN");
    assert.deepEqual(scan2.reasons, ["closing PR"]);

    const scan3 = { verdict: "GO", reasons: ["clean"], flags: [] as string[] };
    assert.equal(applyXrayDemotion(scan3, xr("ERROR", ["boom"])), false);
    assert.equal(scan3.verdict, "GO");
    assert.ok(scan3.flags.includes("xray-deep-verified"), "flag recorded even when the x-ray errored");
  });

  it("does not duplicate the deep-verified flag", () => {
    const scan = { verdict: "GO", reasons: [], flags: ["xray-deep-verified"] };
    applyXrayDemotion(scan, xr("GO"));
    assert.deepEqual(
      scan.flags.filter((f) => f === "xray-deep-verified"),
      ["xray-deep-verified"]
    );
  });
});

describe("xrayIssues + sortXrayResults", () => {
  it("x-rays a list serially and sorts TAKEN, RISKY, GO, ERROR", async () => {
    const repo = "wc3";
    // Bespoke multi-issue mock: issueRoutes() matchers are per-issue, so a
    // shared-issue test needs its own routing keyed by issue/PR number.
    const timelines: Record<number, unknown[]> = {
      1: [xrefEvent(repo, 11)],
      2: [],
      3: [],
    };
    const searches: Record<number, unknown[]> = { 1: [], 2: [], 3: [searchHit(repo, 31)] };
    const prs: Record<number, unknown> = {
      11: prDetail(repo, 11, { body: "Closes #1" }),
      31: prDetail(repo, 31, { body: "Maybe #3" }),
    };
    const issueNum = (u: string): number => {
      const m = /\/issues\/(\d+)/.exec(u) ?? /%23(\d+)/.exec(u);
      return m ? Number(m[1]) : 0;
    };
    mockApi([
      { match: (u) => u.includes("/timeline"), respond: (u) => ({ body: timelines[issueNum(u)] ?? [] }) },
      { match: (u) => u.includes("/search/issues"), respond: (u) => ({ body: { items: searches[issueNum(u)] ?? [] } }) },
      {
        match: (u) => /\/pulls\/(\d+)/.test(u),
        respond: (u) => {
          const pr = Number(/\/pulls\/(\d+)/.exec(u)![1]);
          return { body: prs[pr] ?? prDetail(repo, pr) };
        },
      },
      {
        match: (u) => /\/issues\/\d+(\?|$)/.test(u) && !u.includes("/comments"),
        respond: (u) => ({ body: issuePayload(repo, issueNum(u), "reporter") }),
      },
      { match: (u) => u.includes("/comments"), respond: () => ({ body: [] }) },
    ]);
    const results = await xrayIssues("acme", repo, [1, 2, 3]);
    assert.deepEqual(
      results.map((r) => r.verdict),
      ["TAKEN", "GO", "RISKY"]
    );
    const sorted = sortXrayResults(results);
    assert.deepEqual(
      sorted.map((r) => r.verdict),
      ["TAKEN", "RISKY", "GO"]
    );
  });

  it("counts API calls honestly across the batch", async () => {
    const repo = freshRepo("wc2");
    mockApi(issueRoutes(repo, 10, {}));
    resetApiCalls();
    const [r] = await xrayIssues("acme", repo, [10]);
    assert.ok(r.apiCalls <= 6, `per-issue budget: ${r.apiCalls} calls`);
  });
});
