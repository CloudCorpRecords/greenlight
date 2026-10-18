import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  extractPRReferences,
  fetchCommentMentionedPRs,
  fetchHouseRules,
  apiGet,
  apiPost,
  setFetchImpl,
  requestTimeoutMs,
  RequestTimeoutError,
  WriteBlockedError,
  RateLimitError,
  type PullRefDetail,
} from "../src/github.js";
import { classifyBabysitError } from "../src/babysit.js";
import type { CommentSignal } from "../src/types.js";

function comment(author: string, body: string): CommentSignal {
  return { author, body, createdAt: "2026-10-12T10:00:00Z" };
}

const pull = (n: number, title: string, body: string, merged = false, state: "open" | "closed" = "open"): PullRefDetail => ({
  number: n,
  state,
  merged,
  title,
  body,
  url: `https://github.com/acme/widget/pull/${n}`,
});

describe("extractPRReferences", () => {
  it("extracts bare #NNN refs and full PR URLs, deduped in order", () => {
    const refs = extractPRReferences(
      [
        comment("a", "Just a heads-up that PR #861 covers that work."),
        comment("b", "See https://github.com/acme/widget/pull/902 too. #861 again."),
      ],
      "acme",
      "widget"
    );
    assert.deepEqual(refs, [861, 902]);
  });

  it("ignores full URLs from other repos", () => {
    const refs = extractPRReferences(
      [comment("a", "Upstream fix: https://github.com/other/thing/pull/123")],
      "acme",
      "widget"
    );
    assert.deepEqual(refs, []);
  });

  it("returns nothing for prose without references", () => {
    const refs = extractPRReferences([comment("a", "I can reproduce this on macOS 15.")], "acme", "widget");
    assert.deepEqual(refs, []);
  });
});

describe("fetchCommentMentionedPRs", () => {
  const depsFor = (map: Record<number, PullRefDetail | null>, calls: number[] = []) => ({
    fetchPull: async (_o: string, _r: string, n: number) => {
      calls.push(n);
      if (!(n in map)) throw new Error(`unexpected fetch for #${n}`);
      return map[n];
    },
  });

  it("counts open PRs whose body mentions the issue number", async () => {
    const out = await fetchCommentMentionedPRs(
      "acme",
      "widget",
      691,
      [comment("other", "Heads-up: PR #861 covers the fallback work.")],
      [],
      depsFor({ 861: pull(861, "Improve fallback handling", "Addresses #691") })
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 861);
    assert.equal(out[0].state, "open");
    assert.equal(out[0].mentionsIssue, true);
  });

  it("skips the issue's own number and already-known PRs", async () => {
    const calls: number[] = [];
    const out = await fetchCommentMentionedPRs(
      "acme",
      "widget",
      691,
      [comment("other", "See #691 itself and #861 and #90.")],
      [90],
      depsFor({ 861: pull(861, "x", "y") }, calls)
    );
    assert.deepEqual(calls, [861]);
    assert.equal(out.length, 1);
  });

  it("skips references that 404 as PRs (they are issue numbers)", async () => {
    const out = await fetchCommentMentionedPRs(
      "acme",
      "widget",
      691,
      [comment("other", "Related to #700 and #861.")],
      [],
      depsFor({ 700: null, 861: pull(861, "x", "Fixes #691") })
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 861);
  });

  it("marks PRs whose text does not mention the issue", async () => {
    const out = await fetchCommentMentionedPRs(
      "acme",
      "widget",
      691,
      [comment("other", "Maybe #861 helps.")],
      [],
      depsFor({ 861: pull(861, "Unrelated refactor", "No issue link here") })
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].mentionsIssue, false);
  });

  it("maps merged PR state", async () => {
    const out = await fetchCommentMentionedPRs(
      "acme",
      "widget",
      691,
      [comment("other", "Landed in #861.")],
      [],
      depsFor({ 861: pull(861, "x", "Closes #691", true, "closed") })
    );
    assert.equal(out[0].state, "merged");
  });

  it("caps fetches at 5 references", async () => {
    const calls: number[] = [];
    const map: Record<number, PullRefDetail | null> = {};
    for (let n = 100; n < 110; n++) map[n] = pull(n, "x", "y");
    const comments = [comment("other", Array.from({ length: 10 }, (_, i) => `#${100 + i}`).join(" "))];
    const out = await fetchCommentMentionedPRs("acme", "widget", 691, comments, [], depsFor(map, calls));
    assert.equal(calls.length, 5);
    assert.equal(out.length, 5);
  });

  it("ends the walk on provider failure, keeping prior results", async () => {
    let n = 0;
    const deps = {
      fetchPull: async (_o: string, _r: string, num: number) => {
        n++;
        if (n === 2) throw new Error("network down");
        return pull(num, "x", `Fixes #691`);
      },
    };
    const out = await fetchCommentMentionedPRs(
      "acme",
      "widget",
      691,
      [comment("other", "#861 and #862")],
      [],
      deps
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 861);
  });
});

describe("fetchHouseRules", () => {
  it("collects only the files that exist, in order", async () => {
    const present: Record<string, string> = {
      "CONTRIBUTING.md": "Comment before starting work.",
      "AGENTS.md": "Sign off every commit (DCO).",
    };
    const rules = await fetchHouseRules("acme", "widget", {
      fetchRaw: async (file: string) => present[file],
    });
    assert.deepEqual(rules.map((r) => r.file), ["CONTRIBUTING.md", "AGENTS.md"]);
    assert.equal(rules[1].text, "Sign off every commit (DCO).");
  });

  it("returns an empty list when no policy file exists", async () => {
    const rules = await fetchHouseRules("acme", "widget", { fetchRaw: async () => undefined });
    assert.deepEqual(rules, []);
  });
});

describe("extractDuplicateTargets", () => {
  it("finds duplicate targets in comment bodies", async () => {
    const { extractDuplicateTargets } = await import("../src/github.js");
    const targets = extractDuplicateTargets([
      comment("bot", "This issue has been marked as a duplicate of #40803. Please use #40803 for tracking."),
      comment("human", "Looks like a duplicate of #555, same stack trace."),
    ]);
    assert.deepEqual(targets, [40803, 555]);
  });

  it("returns nothing when no duplicate language is present", async () => {
    const { extractDuplicateTargets } = await import("../src/github.js");
    assert.deepEqual(extractDuplicateTargets([comment("dev", "I would like to work on this.")]), []);
  });

  it("finds full-URL duplicate references (n8n #41215 comment shape)", async () => {
    const { extractDuplicateTargets } = await import("../src/github.js");
    const targets = extractDuplicateTargets([
      comment(
        "arsalanyavari",
        "duplicate of https://github.com/n8n-io/n8n/issues/40803 it seems this problem has been resolved in the latest version of code"
      ),
    ]);
    assert.deepEqual(targets, [40803]);
  });
});

describe("fetchDuplicateTargets", () => {
  it("fetches each target's live state", async () => {
    const { fetchDuplicateTargets } = await import("../src/github.js");
    const out = await fetchDuplicateTargets(
      "n8n-io",
      "n8n",
      41215,
      [comment("bot", "marked as a duplicate of #40803")],
      {
        timelineEvents: [],
        fetchIssue: async (_o: string, _r: string, n: number) => {
          assert.equal(n, 40803);
          return { state: "closed", stateReason: "completed" };
        },
      }
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 40803);
    assert.equal(out[0].state, "closed");
    assert.equal(out[0].stateReason, "completed");
    assert.equal(out[0].url, "https://github.com/n8n-io/n8n/issues/40803");
  });

  it("reads marked_as_duplicate timeline events", async () => {
    const { fetchDuplicateTargets } = await import("../src/github.js");
    const out = await fetchDuplicateTargets(
      "acme",
      "widget",
      100,
      [],
      {
        timelineEvents: [
          { event: "marked_as_duplicate", source: { issue: { number: 42 } } },
        ],
        fetchIssue: async () => ({ state: "open" }),
      }
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 42);
    assert.equal(out[0].state, "open");
  });

  it("ignores the issue's own number and dedupes", async () => {
    const { fetchDuplicateTargets } = await import("../src/github.js");
    const out = await fetchDuplicateTargets(
      "acme",
      "widget",
      100,
      [comment("bot", "duplicate of #100 and duplicate of #7, duplicate of #7")],
      {
        timelineEvents: [],
        fetchIssue: async () => ({ state: "open" }),
      }
    );
    assert.deepEqual(out.map((d) => d.number), [7]);
  });
});

describe("extractAttemptLinkedPRs", () => {
  it("extracts cross-repo PR links from fix-announcement comments (#5563)", async () => {
    const { extractAttemptLinkedPRs } = await import("../src/github.js");
    const out = extractAttemptLinkedPRs(
      [
        comment("TassioSales", "/attempt #5563"),
        comment(
          "TassioSales",
          "Submitted fix for bug #1 (routingDisabled ignored on re-render) in https://github.com/tscircuit/core/pull/4575 with regression test coverage."
        ),
        comment(
          "TassioSales",
          "I have implemented the fix for bug #4 in PR https://github.com/tscircuit/checks/pull/414 with regression tests."
        ),
      ],
      "DurandA"
    );
    assert.equal(out.length, 2);
    assert.deepEqual([out[0].owner, out[0].repo, out[0].number], ["tscircuit", "core", 4575]);
    assert.deepEqual([out[1].owner, out[1].repo, out[1].number], ["tscircuit", "checks", 414]);
    assert.equal(out[0].author, "TassioSales");
  });

  it("skips bots, the issue author, and bare links without announcement language", async () => {
    const { extractAttemptLinkedPRs } = await import("../src/github.js");
    const out = extractAttemptLinkedPRs(
      [
        comment("somebot[bot]", "Submitted fix in https://github.com/acme/widget/pull/1"),
        comment("reporter", "Submitted fix in https://github.com/acme/widget/pull/2"),
        comment("dev", "see prior art in https://github.com/acme/widget/pull/3"),
      ],
      "reporter"
    );
    assert.deepEqual(out, []);
  });

  it("catches a bot-emoji-prefixed 'Opened #NNN' announcement (actualbudget #8429)", async () => {
    // A bot posted "🤖 Opened #8474 with a focused fix" and v0.3.3 missed
    // it: the emoji prefix and the missing word "PR" both defeated the
    // old matchers.
    const { extractAttemptLinkedPRs, normalizeCommentText } = await import("../src/github.js");
    assert.equal(
      normalizeCommentText("🤖 Opened #8474 with a focused fix"),
      "Opened #8474 with a focused fix"
    );
    const out = extractAttemptLinkedPRs(
      [
        comment(
          "pnlabs-dev",
          "🤖 Opened #8474 with a focused fix\n\nhttps://github.com/actualbudget/actual/pull/8474"
        ),
      ],
      "reporter"
    );
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].owner, out[0].repo, out[0].number], ["actualbudget", "actual", 8474]);
  });

  it("still matches an emoji-prefixed /attempt command", async () => {
    const { extractAttemptLinkedPRs } = await import("../src/github.js");
    const out = extractAttemptLinkedPRs(
      [comment("dev", "🤖/attempt #5563\nhttps://github.com/tscircuit/core/pull/4575")],
      "reporter"
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 4575);
  });
});

describe("extractTimelineCrossRefPRs", () => {
  // The real GitHub shape: event.source.issue.html_url, with a
  // pull_request key marking the reference as a PR. Reading
  // event.source.html_url directly finds nothing.
  const xrefEvent = (n: number, title: string, isPR = true): Record<string, unknown> => ({
    event: "cross-referenced",
    source: {
      type: "issue",
      issue: {
        html_url: `https://github.com/acme/widget/pull/${n}`,
        title,
        ...(isPR ? { pull_request: { url: `https://api.github.com/repos/acme/widget/pulls/${n}` } } : {}),
      },
    },
  });

  it("reads the nested source.issue shape and keeps only PRs", async () => {
    const { extractTimelineCrossRefPRs } = await import("../src/github.js");
    const out = extractTimelineCrossRefPRs([
      xrefEvent(4907, "Fix Pydantic field aliases in Python tool execution"),
      { event: "cross-referenced", source: { type: "issue", html_url: "https://github.com/acme/widget/pull/9", issue: { pull_request: {} } } },
      xrefEvent(5000, "An issue reference", false),
      { event: "commented" },
    ]);
    assert.deepEqual(out.map((o) => o.number), [4907]);
    assert.equal(out[0].title, "Fix Pydantic field aliases in Python tool execution");
  });

  it("dedupes repeated cross-references", async () => {
    const { extractTimelineCrossRefPRs } = await import("../src/github.js");
    const out = extractTimelineCrossRefPRs([
      xrefEvent(4907, "Fix Pydantic field aliases"),
      xrefEvent(4907, "Fix Pydantic field aliases"),
    ]);
    assert.equal(out.length, 1);
  });
});

describe("listWorkflows and scanWorkflowGates", () => {
  it("flags a close-external-prs workflow from listing plus content", async () => {
    const { scanWorkflowGates } = await import("../src/github.js");
    const gates = await scanWorkflowGates("acme", "widget", {
      listFiles: async () => ["close-external-prs.yml", "ci.yml", "README.md"],
      fetchRaw: async (name: string) =>
        name === "close-external-prs.yml" ? "name: Close external PRs\non: pull_request_target\n" : undefined,
    });
    assert.equal(gates.length, 1);
    assert.equal(gates[0].kind, "external_prs_closed");
    assert.ok(gates[0].evidence.includes("close-external-prs.yml"));
  });

  it("returns no gates when the workflows dir is absent", async () => {
    const { scanWorkflowGates } = await import("../src/github.js");
    const gates = await scanWorkflowGates("acme", "widget", {
      listFiles: async () => undefined,
    });
    assert.deepEqual(gates, []);
  });

  it("listWorkflows only returns yaml files", async () => {
    const { listWorkflows } = await import("../src/github.js");
    const files = await listWorkflows("acme", "widget", {
      listFiles: async () => ["ci.yml", "helper.js", "deploy.yaml"],
      fetchRaw: async () => undefined,
    });
    assert.deepEqual(files.map((f) => f.name), ["ci.yml", "deploy.yaml"]);
  });
});

describe("githubApiBase", () => {
  const saved = process.env.GREENLIGHT_GITHUB_BASE_URL;
  const restore = () => {
    if (saved === undefined) delete process.env.GREENLIGHT_GITHUB_BASE_URL;
    else process.env.GREENLIGHT_GITHUB_BASE_URL = saved;
  };
  it("defaults to api.github.com with the env unset", async () => {
    delete process.env.GREENLIGHT_GITHUB_BASE_URL;
    try {
      const { githubApiBase } = await import("../src/github.js");
      assert.equal(githubApiBase(), "https://api.github.com");
    } finally {
      restore();
    }
  });
  it("honors the override and strips trailing slashes", async () => {
    process.env.GREENLIGHT_GITHUB_BASE_URL = "http://127.0.0.1:8792/";
    try {
      const { githubApiBase } = await import("../src/github.js");
      assert.equal(githubApiBase(), "http://127.0.0.1:8792");
    } finally {
      restore();
    }
  });
  it("treats a blank env as unset", async () => {
    process.env.GREENLIGHT_GITHUB_BASE_URL = "   ";
    try {
      const { githubApiBase } = await import("../src/github.js");
      assert.equal(githubApiBase(), "https://api.github.com");
    } finally {
      restore();
    }
  });
});

describe("request timeouts (v0.9.2)", () => {
  const realEnv = process.env.GREENLIGHT_REQUEST_TIMEOUT_S;
  afterEach(() => {
    setFetchImpl(null);
    if (realEnv === undefined) delete process.env.GREENLIGHT_REQUEST_TIMEOUT_S;
    else process.env.GREENLIGHT_REQUEST_TIMEOUT_S = realEnv;
  });

  it("defaults to 30s and honors GREENLIGHT_REQUEST_TIMEOUT_S", async () => {
    assert.equal(requestTimeoutMs({} as NodeJS.ProcessEnv), 30_000);
    assert.equal(requestTimeoutMs({ GREENLIGHT_REQUEST_TIMEOUT_S: "5" } as NodeJS.ProcessEnv), 5_000);
    assert.equal(requestTimeoutMs({ GREENLIGHT_REQUEST_TIMEOUT_S: "0" } as NodeJS.ProcessEnv), 30_000);
  });

  it("a hung request fails fast into RequestTimeoutError", async () => {
    process.env.GREENLIGHT_REQUEST_TIMEOUT_S = "0.2";
    // Mirrors real fetch: rejects with AbortError when the signal fires.
    const hung = (async (_url: string, init?: RequestInit) => {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    setFetchImpl(hung);
    await assert.rejects(
      apiGet("/repos/o/r"),
      (err: unknown) => err instanceof RequestTimeoutError && /timed out after 0.2s/.test(err.message)
    );
    // Babysit's classifier reads this as transient (never usage).
    assert.equal(classifyBabysitError(new RequestTimeoutError("/repos/o/r", 0.2)), "transient");
  });

  it("a 403 with a Blocked body throws WriteBlockedError, not a rate-limit error", async () => {
    const blocked = (async () =>
      new Response(JSON.stringify({ message: "Blocked", documentation_url: "https://docs.github.com/rest" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    setFetchImpl(blocked);
    await assert.rejects(apiPost("/repos/o/r/issues/1/comments", { body: "x" }), (err: unknown) => {
      assert.ok(err instanceof WriteBlockedError, `expected WriteBlockedError, got ${err}`);
      assert.ok(!(err instanceof RateLimitError), "must not masquerade as a rate limit");
      return true;
    });
  });

  it("a healthy 200 response is byte-identical with the timeout armed", async () => {
    const ok = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    setFetchImpl(ok);
    assert.deepEqual(await apiGet("/repos/o/r"), { ok: true });
  });
});

describe("v0.9.3 policy file locations", () => {
  it("finds CONTRIBUTING.md in docs/ when root and .github/ lack it (AFFiNE shape)", async () => {
    const { fetchHouseRules: fhr } = await import("../src/github.js");
    const fetched: string[] = [];
    const rules = await fhr("acme", "widget", {
      fetchRaw: async (file: string) => {
        fetched.push(file);
        return file === "docs/CONTRIBUTING.md" ? "docs policy text" : undefined;
      },
    });
    assert.deepEqual(rules.map((r) => r.file), ["docs/CONTRIBUTING.md"]);
    // root and .github/ were probed before docs/
    assert.ok(fetched.indexOf("CONTRIBUTING.md") < fetched.indexOf("docs/CONTRIBUTING.md"));
    assert.ok(fetched.indexOf(".github/CONTRIBUTING.md") < fetched.indexOf("docs/CONTRIBUTING.md"));
  });

  it("stops probing a filename after the first hit (root wins)", async () => {
    const { fetchHouseRules: fhr } = await import("../src/github.js");
    const fetched: string[] = [];
    const rules = await fhr("acme", "widget", {
      fetchRaw: async (file: string) => {
        fetched.push(file);
        return file === "CONTRIBUTING.md" ? "root policy" : undefined;
      },
    });
    assert.deepEqual(rules.map((r) => r.file), ["CONTRIBUTING.md"]);
    assert.ok(!fetched.includes(".github/CONTRIBUTING.md"), "no wasted .github probe");
    assert.ok(!fetched.includes("docs/CONTRIBUTING.md"), "no wasted docs probe");
  });

  it("probes repo-level AI_POLICY.md at root, .github/, docs/", async () => {
    const { fetchHouseRules: fhr } = await import("../src/github.js");
    const rules = await fhr("acme", "widget", {
      fetchRaw: async (file: string) =>
        file === "AI_POLICY.md" ? "autonomous agents are not allowed" : undefined,
    });
    assert.deepEqual(rules.map((r) => r.file), ["AI_POLICY.md"]);
  });

  it("fetchOrgAiPolicy returns the org .github AI_POLICY.md once (seam, no cache)", async () => {
    const { fetchOrgAiPolicy: foa } = await import("../src/github.js");
    let calls = 0;
    const text = await foa("astral-sh", {
      fetchOrgPolicy: async (owner: string) => {
        calls++;
        assert.equal(owner, "astral-sh");
        return "We do not allow autonomous agents";
      },
    });
    assert.equal(text, "We do not allow autonomous agents");
    assert.equal(calls, 1);
    const missing = await foa("nope", { fetchOrgPolicy: async () => undefined });
    assert.equal(missing, undefined);
  });

  it("fetchPolicySources appends the org policy as a labeled source", async () => {
    const { fetchPolicySources: fps } = await import("../src/github.js");
    const sources = await fps("astral-sh", "ruff", {
      fetchRaw: async (file: string) =>
        file === "CONTRIBUTING.md" ? "repo contributing" : undefined,
      fetchOrgPolicy: async () => "We do not allow autonomous agents",
    });
    assert.deepEqual(sources.map((s) => s.file), [
      "CONTRIBUTING.md",
      "AI_POLICY.md (org astral-sh)",
    ]);
  });

  it("fetchPolicySources omits the org source when the org has no policy", async () => {
    const { fetchPolicySources: fps } = await import("../src/github.js");
    const sources = await fps("acme", "widget", {
      fetchRaw: async () => undefined,
      fetchOrgPolicy: async () => undefined,
    });
    assert.deepEqual(sources, []);
  });
});
