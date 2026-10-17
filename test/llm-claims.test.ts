/**
 * Tests for the optional Fireworks claim-intent layer (src/llm-claims.ts)
 * and its merge with the protocol verdict. Every network path uses an
 * injected stub fetch; the Fireworks API is never touched. The file cache
 * is isolated to a temp HOME (see llm-test-home.ts).
 */
import "./llm-test-home.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyIssueClaims,
  applyLlmClaims,
  parseLlmClassifications,
  llmModelId,
  llmBaseUrl,
  llmEnabled,
  DEFAULT_LLM_MODEL,
} from "../src/llm-claims.js";
import { mergeProtocolVerdict } from "../src/protocol-fetch.js";
import { scoreIssue } from "../src/verdict.js";
import type { IssueSnapshot, VerdictResult, CommentSignal } from "../src/types.js";
import type { IssueStatusPayload } from "../src/protocol.js";

const NOW = new Date("2026-10-16T12:00:00Z");

function comment(author: string, body: string, createdAt = "2026-10-15T10:00:00Z", id?: number): CommentSignal {
  return id == null ? { author, body, createdAt } : { author, body, createdAt, id };
}

function baseSnapshot(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    sourceUrl: "https://github.com/o/r/issues/1",
    owner: "o",
    repo: "r",
    number: 1,
    state: "open",
    title: "A clean issue",
    author: "reporter",
    assignees: [],
    labels: [],
    comments: [],
    linkedPRs: [],
    createdAt: "2026-10-14T10:00:00Z",
    updatedAt: "2026-10-16T10:00:00Z",
    ...overrides,
  };
}

function legacyResult(overrides: Partial<VerdictResult> = {}): VerdictResult {
  return { verdict: "GO", reasons: [], flags: [], claims: [], gates: [], ...overrides };
}

/** Stub fetch returning a Fireworks-shaped chat completion. */
function stubFetch(responseText: string, ok = true) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (url: string, init?: { body?: unknown; signal?: AbortSignal }) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => ({
        choices: [{ message: { content: responseText, reasoning_content: "ignored" } }],
      }),
    };
  }) as typeof fetch;
  return { impl, calls };
}

function llmJson(items: Array<{ index: number; claim: boolean; quote?: string; confidence?: number; reason?: string }>): string {
  return JSON.stringify({
    classifications: items.map((i) => ({
      index: i.index,
      claim: i.claim,
      quote: i.quote ?? "",
      confidence: i.confidence ?? 0.9,
      reason: i.reason ?? "",
    })),
  });
}

const KEY_ENV = { FIREWORKS_API_KEY: "test-key", PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv;

describe("env contract", () => {
  it("is disabled by default", () => {
    assert.equal(llmEnabled({} as NodeJS.ProcessEnv), false);
    assert.equal(llmEnabled({ FIREWORKS_API_KEY: "" } as NodeJS.ProcessEnv), false);
    assert.equal(llmEnabled({ FIREWORKS_API_KEY: "k" } as NodeJS.ProcessEnv), true);
  });
  it("defaults to the GLM flash model, honors overrides", () => {
    assert.equal(llmModelId({} as NodeJS.ProcessEnv), DEFAULT_LLM_MODEL);
    assert.equal(DEFAULT_LLM_MODEL, "accounts/fireworks/models/glm-5p3-flash");
    assert.equal(
      llmModelId({ GREENLIGHT_LLM_MODEL: "accounts/fireworks/models/other" } as NodeJS.ProcessEnv),
      "accounts/fireworks/models/other"
    );
    assert.equal(llmBaseUrl({} as NodeJS.ProcessEnv), "https://api.fireworks.ai/inference/v1");
    assert.equal(
      llmBaseUrl({ GREENLIGHT_LLM_BASE_URL: "https://proxy.example/v1/" } as NodeJS.ProcessEnv),
      "https://proxy.example/v1"
    );
  });
});

describe("parseLlmClassifications", () => {
  it("parses strict JSON", () => {
    const out = parseLlmClassifications(llmJson([{ index: 0, claim: true, quote: "x", reason: "r" }]));
    assert.equal(out.length, 1);
    assert.equal(out[0].claim, true);
  });
  it("strips code fences", () => {
    const out = parseLlmClassifications("```json\n" + llmJson([{ index: 0, claim: false }]) + "\n```");
    assert.equal(out.length, 1);
    assert.equal(out[0].claim, false);
  });
  it("extracts JSON buried in prose", () => {
    const out = parseLlmClassifications(
      "Here is my answer: " + llmJson([{ index: 2, claim: true, quote: "q" }]) + " hope that helps"
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].index, 2);
  });
  it("returns [] on malformed input, never throws", () => {
    assert.deepEqual(parseLlmClassifications("not json at all"), []);
    assert.deepEqual(parseLlmClassifications(""), []);
    assert.deepEqual(parseLlmClassifications('{"classifications": "nope"}'), []);
  });
  it("clamps confidence and defaults it", () => {
    const out = parseLlmClassifications(llmJson([{ index: 0, claim: true, quote: "q", confidence: 9 }]));
    assert.equal(out[0].confidence, 1);
    const raw = JSON.stringify({ classifications: [{ index: 0, claim: true, quote: "q" }] });
    assert.equal(parseLlmClassifications(raw)[0].confidence, 0.5);
  });
});

describe("classifyIssueClaims", () => {
  it("classifies tonight's real soft-claim case as a claim with the exact quote", async () => {
    const body = "I'm looking into contributing a fix here. @maintainer which approach do you prefer, A or B?";
    const comments = [
      comment("reporter", "Bug: the widget breaks on Tuesdays.", "2026-10-13T10:00:00Z", 11),
      comment("sahyl", body, "2026-10-14T07:29:14Z", 12),
    ];
    const { impl } = stubFetch(llmJson([{ index: 0, claim: true, quote: "I'm looking into contributing a fix here", reason: "intent to contribute" }]));
    const flags = await classifyIssueClaims("reporter", comments, { apiKey: "k", fetchImpl: impl });
    assert.equal(flags.length, 1);
    assert.equal(flags[0].author, "sahyl");
    assert.equal(flags[0].quote, "I'm looking into contributing a fix here");
    assert.equal(flags[0].model, DEFAULT_LLM_MODEL);
  });

  it("classifies the Acrotux explicit non-claim as not-a-claim", async () => {
    const comments = [comment("Acrotux", "Long audit... I'm not opening a PR for this one either.", "2026-10-16T10:00:00Z", 21)];
    const { impl } = stubFetch(llmJson([{ index: 0, claim: false, reason: "declines to open a PR" }]));
    const flags = await classifyIssueClaims("reporter", comments, { apiKey: "k", fetchImpl: impl });
    assert.deepEqual(flags, []);
  });

  it("classifies repro-only investigation as not-a-claim", async () => {
    const comments = [comment("dev", "I can reproduce this on 2.4, looking into the logs now.", "2026-10-16T10:00:00Z", 31)];
    const { impl } = stubFetch(llmJson([{ index: 0, claim: false, reason: "diagnosis only" }]));
    const flags = await classifyIssueClaims("reporter", comments, { apiKey: "k", fetchImpl: impl });
    assert.deepEqual(flags, []);
  });

  it("drops results whose quote is not an exact substring of the body", async () => {
    const comments = [comment("sahyl", "Thanks for the detailed writeup.", "2026-10-14T10:00:00Z", 41)];
    const { impl } = stubFetch(llmJson([{ index: 0, claim: true, quote: "I'm taking this on", reason: "invented" }]));
    const flags = await classifyIssueClaims("reporter", comments, { apiKey: "k", fetchImpl: impl });
    assert.deepEqual(flags, [], "an invented quote must never become evidence");
  });

  it("excludes bots and the issue author from the request", async () => {
    const comments = [
      comment("dependabot[bot]", "I'm looking into contributing a fix here.", "2026-10-14T10:00:00Z", 51),
      comment("reporter", "I'm looking into contributing a fix here.", "2026-10-14T10:00:00Z", 52),
      comment("sahyl", "Thanks for the detailed writeup.", "2026-10-14T10:00:00Z", 53),
    ];
    const { impl, calls } = stubFetch(llmJson([{ index: 0, claim: false }]));
    await classifyIssueClaims("reporter", comments, { apiKey: "k", fetchImpl: impl });
    assert.equal(calls.length, 1);
    const prompt = String(calls[0].body && (calls[0].body as { messages: Array<{ content: string }> }).messages[1].content);
    const section = prompt.split("Now classify these comments:")[1];
    assert.ok(!section.includes("@dependabot"), "bot comments are not classified");
    assert.ok(!section.includes("@reporter"), "issue author comments are not classified");
    assert.ok(section.includes("@sahyl"), "the eligible comment is classified");
  });

  it("sends the request to the Fireworks chat completions endpoint with the key", async () => {
    const comments = [comment("sahyl", "hello", "2026-10-14T10:00:00Z", 61)];
    const { impl, calls } = stubFetch(llmJson([{ index: 0, claim: false }]));
    await classifyIssueClaims("reporter", comments, { apiKey: "secret", fetchImpl: impl });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith("https://api.fireworks.ai/inference/v1/chat/completions"));
    const body = calls[0].body as { model: string; messages: unknown[] };
    assert.equal(body.model, DEFAULT_LLM_MODEL);
    assert.equal(body.messages.length, 2);
  });

  it("returns [] on non-200 without throwing", async () => {
    const comments = [comment("sahyl", "hello", "2026-10-14T10:00:00Z", 71)];
    const { impl } = stubFetch("boom", false);
    const flags = await classifyIssueClaims("reporter", comments, { apiKey: "k", fetchImpl: impl });
    assert.deepEqual(flags, []);
  });

  it("a failed request is not cached: a later check retries", async () => {
    const comments = [comment("sahyl", "I'm looking into contributing a fix here.", "2026-10-14T10:00:00Z", 75)];
    const failing = stubFetch("boom", false);
    const first = await classifyIssueClaims("reporter", comments, { apiKey: "k", fetchImpl: failing.impl });
    assert.deepEqual(first, []);
    const working = stubFetch(llmJson([{ index: 0, claim: true, quote: "I'm looking into contributing a fix here" }]));
    const second = await classifyIssueClaims("reporter", comments, { apiKey: "k", fetchImpl: working.impl });
    assert.equal(working.calls.length, 1, "a transport failure must not be cached for the 30-day TTL");
    assert.equal(second.length, 1);
  });

  it("returns [] on timeout without throwing", async () => {
    const comments = [comment("sahyl", "hello", "2026-10-14T10:00:00Z", 81)];
    const hanging = (async (_url: string, init?: { signal?: AbortSignal }) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
      throw new Error("unreachable");
    }) as typeof fetch;
    const flags = await classifyIssueClaims("reporter", comments, { apiKey: "k", fetchImpl: hanging, timeoutMs: 50 });
    assert.deepEqual(flags, []);
  });

  it("returns [] on malformed model JSON without throwing", async () => {
    const comments = [comment("sahyl", "hello", "2026-10-14T10:00:00Z", 91)];
    const { impl } = stubFetch("definitely not json {{{");
    const flags = await classifyIssueClaims("reporter", comments, { apiKey: "k", fetchImpl: impl });
    assert.deepEqual(flags, []);
  });

  it("a cache hit avoids a second fetch", async () => {
    const comments = [comment("sahyl", "I'm looking into contributing a fix here.", "2026-10-14T10:00:00Z", 101)];
    const { impl, calls } = stubFetch(llmJson([{ index: 0, claim: true, quote: "I'm looking into contributing a fix here" }]));
    const first = await classifyIssueClaims("reporter", comments, { apiKey: "k", fetchImpl: impl });
    const second = await classifyIssueClaims("reporter", comments, { apiKey: "k", fetchImpl: impl });
    assert.equal(calls.length, 1, "second check must not re-bill");
    assert.deepEqual(second, first);
  });

  it("makes no call when there are no eligible comments", async () => {
    const { impl, calls } = stubFetch(llmJson([]));
    const flags = await classifyIssueClaims("reporter", [comment("reporter", "mine", "2026-10-14T10:00:00Z", 111)], {
      apiKey: "k",
      fetchImpl: impl,
    });
    assert.deepEqual(flags, []);
    assert.equal(calls.length, 0);
  });
});

describe("applyLlmClaims", () => {
  it("is disabled by default: output identical to the deterministic engine", async () => {
    const snapshot = baseSnapshot({
      comments: [comment("sahyl", "I'm looking into contributing a fix here.", "2026-10-14T10:00:00Z", 121)],
    });
    const legacy = scoreIssue(snapshot, NOW);
    const out = await applyLlmClaims(snapshot, legacy, { env: {} as NodeJS.ProcessEnv });
    assert.strictEqual(out, legacy, "same object, no llm_claims field added");
    assert.deepEqual(out, scoreIssue(snapshot, NOW));
  });

  it("a flag downgrades GO to RISKY with the quote as evidence, never TAKEN", async () => {
    const snapshot = baseSnapshot({
      comments: [comment("sahyl", "I'm looking into contributing a fix here.", "2026-10-14T10:00:00Z", 131)],
    });
    const legacy = scoreIssue(snapshot, NOW);
    assert.equal(legacy.verdict, "GO");
    const { impl } = stubFetch(llmJson([{ index: 0, claim: true, quote: "I'm looking into contributing a fix here", reason: "intent" }]));
    const out = await applyLlmClaims(snapshot, legacy, { env: KEY_ENV, fetchImpl: impl });
    assert.equal(out.verdict, "RISKY");
    assert.notEqual(out.verdict, "TAKEN");
    assert.ok(out.flags.includes("llm-claim"));
    assert.ok(out.reasons.some((r) => r.includes("possible claim by sahyl") && r.includes("I'm looking into contributing a fix here")));
    assert.equal(out.llm_claims?.length, 1);
    assert.equal(out.llm_claims?.[0].author, "sahyl");
  });

  it("a flag on an already-RISKY verdict keeps RISKY and adds evidence", async () => {
    const legacy = legacyResult({ verdict: "RISKY", reasons: ["weak-pr-mention"], flags: ["weak-pr-mention"] });
    const snapshot = baseSnapshot({
      comments: [comment("sahyl", "I'm looking into contributing a fix here.", "2026-10-14T10:00:00Z", 141)],
    });
    const { impl } = stubFetch(llmJson([{ index: 0, claim: true, quote: "I'm looking into contributing a fix here" }]));
    const out = await applyLlmClaims(snapshot, legacy, { env: KEY_ENV, fetchImpl: impl });
    assert.equal(out.verdict, "RISKY");
    assert.ok(out.flags.includes("llm-claim"));
    assert.ok(out.flags.includes("weak-pr-mention"));
  });

  it("never overrides GATED and makes no API call", async () => {
    const snapshot = baseSnapshot({
      comments: [comment("sahyl", "I'm looking into contributing a fix here.", "2026-10-14T10:00:00Z", 151)],
    });
    const legacy = legacyResult({ verdict: "GATED", reasons: ["repo gate blocks outside PRs"] });
    const { impl, calls } = stubFetch(llmJson([{ index: 0, claim: true, quote: "I'm looking into contributing a fix here" }]));
    const out = await applyLlmClaims(snapshot, legacy, { env: KEY_ENV, fetchImpl: impl });
    assert.strictEqual(out, legacy);
    assert.equal(calls.length, 0);
  });

  it("does not run when the deterministic layer already found a strong claim", async () => {
    const snapshot = baseSnapshot({
      comments: [comment("rival", "I'll take this on, starting tonight.", "2026-10-14T10:00:00Z", 161)],
    });
    const legacy = scoreIssue(snapshot, NOW);
    assert.ok(legacy.claims.some((c) => c.strength === "strong"), "fixture must produce a strong pattern claim");
    const { impl, calls } = stubFetch(llmJson([{ index: 0, claim: true, quote: "other" }]));
    const out = await applyLlmClaims(snapshot, legacy, { env: KEY_ENV, fetchImpl: impl });
    assert.strictEqual(out, legacy);
    assert.equal(calls.length, 0);
  });

  it("returns the legacy verdict unchanged when the model finds nothing", async () => {
    const snapshot = baseSnapshot({
      comments: [comment("sahyl", "hello", "2026-10-14T10:00:00Z", 171)],
    });
    const legacy = scoreIssue(snapshot, NOW);
    const { impl } = stubFetch(llmJson([{ index: 0, claim: false }]));
    const out = await applyLlmClaims(snapshot, legacy, { env: KEY_ENV, fetchImpl: impl });
    assert.strictEqual(out, legacy);
  });
});

function takenStatus(reason: string): IssueStatusPayload {
  return {
    issue: "https://github.com/o/r/issues/1",
    verdict: "TAKEN",
    reason,
    claim: {
      state: "active",
      claimant: "rival",
      claimed_at: "2026-10-13T10:00:00Z",
      expires_at: "2026-10-20T10:00:00Z",
      queue: [],
    },
    protocol_note: "An active protocol claim governs this issue.",
    competing_prs: [],
    gates: [],
    repo_protocol: null,
    checked_at: "2026-10-15T12:00:00Z",
    stale_after_seconds: 21600,
  };
}

describe("protocol merge with llm_claims", () => {
  it("a live protocol claim supersedes the llm-claim flag and reasons but keeps the data", () => {
    const flag = {
      commentId: "id12",
      author: "sahyl",
      createdAt: "2026-10-14T07:29:14Z",
      quote: "I'm looking into contributing a fix here",
      confidence: 0.9,
      reason: "intent",
      model: DEFAULT_LLM_MODEL,
    };
    const legacy = legacyResult({
      verdict: "RISKY",
      reasons: [`possible claim by sahyl (AI-detected, confidence 0.90): "I'm looking into contributing a fix here"`],
      flags: ["llm-claim"],
      llm_claims: [flag],
    });
    const merged = mergeProtocolVerdict(legacy, takenStatus("Protocol claim active: @rival holds this issue until 2026-10-20."));
    assert.equal(merged.verdict, "TAKEN");
    assert.ok(!merged.flags.includes("llm-claim"), merged.flags.join(","));
    assert.ok(!merged.reasons.some((r) => r.startsWith("possible claim by ")), merged.reasons.join(" | "));
    assert.deepEqual(merged.llm_claims, [flag], "the evidence rides along even when superseded");
  });

  it("with no protocol claims, llm_claims ride through the merge untouched", () => {
    const flag = {
      commentId: "id12",
      author: "sahyl",
      createdAt: "2026-10-14T07:29:14Z",
      quote: "I'm looking into contributing a fix here",
      confidence: 0.9,
      reason: "intent",
      model: DEFAULT_LLM_MODEL,
    };
    const legacy = legacyResult({ verdict: "RISKY", flags: ["llm-claim"], llm_claims: [flag] });
    const status = takenStatus("unused");
    status.verdict = null;
    status.reason = null;
    status.claim = null;
    status.protocol_note = "no protocol claims on this issue";
    const merged = mergeProtocolVerdict(legacy, status);
    assert.equal(merged.verdict, "RISKY");
    assert.ok(merged.flags.includes("llm-claim"));
    assert.deepEqual(merged.llm_claims, [flag]);
  });
});

describe("regression: the two 2026-10-17 misses (v0.9.0)", () => {
  // Field case: the scan path ran the deterministic verdict alone and
  // missed two explicit soft claims the check pipeline's LLM layer was
  // built to catch. v0.9.0 puts the LLM layer on the scan path, so both
  // fixtures must classify as claim intent through the layer's test
  // double, while the deterministic layer gains nothing.
  const misses: Array<{ repo: string; number: number; author: string; body: string; quote: string }> = [
    {
      repo: "ollama/ollama",
      number: 19078,
      author: "Gitcoder12",
      body: "Working on this.",
      quote: "Working on this.",
    },
    {
      repo: "vitejs/vite",
      number: 23757,
      author: "mikamikasuki",
      body: "I'm going to reproduce this on current main and fix the optimizer bookkeeping for duplicated entry chunks.",
      quote: "I'm going to reproduce this on current main and fix the optimizer bookkeeping for duplicated entry chunks.",
    },
  ];

  for (const m of misses) {
    it(`${m.repo}#${m.number} (${m.author}): deterministic gains nothing, LLM caps at RISKY`, async () => {
      const snapshot = baseSnapshot({
        sourceUrl: `https://github.com/${m.repo}/issues/${m.number}`,
        number: m.number,
        comments: [comment(m.author, m.body, "2026-10-17T08:00:00Z", m.number * 1000)],
      });
      const legacy = scoreIssue(snapshot);
      assert.equal(legacy.verdict, "GO", `deterministic layer must gain nothing on ${m.repo}#${m.number}`);
      assert.equal(legacy.claims.length, 0);

      // The layer's test double: the model replies that the comment is a claim.
      const { impl } = stubFetch(llmJson([{ index: 0, claim: true, quote: m.quote, confidence: 0.9, reason: "States intent to do the work." }]));
      const out = await applyLlmClaims(snapshot, legacy, { env: KEY_ENV, fetchImpl: impl });
      assert.equal(out.verdict, "RISKY");
      assert.ok(out.flags.includes("llm-claim"), out.flags.join(","));
      assert.equal(out.llm_claims?.length, 1);
      assert.equal(out.llm_claims?.[0].author, m.author);
      assert.ok(snapshot.comments[0].body.includes(out.llm_claims?.[0].quote ?? "x"), "quote must be an exact substring");
      assert.ok(!out.reasons.some((r) => r.includes("TAKEN")), "never TAKEN from an LLM flag");
    });
  }
});
