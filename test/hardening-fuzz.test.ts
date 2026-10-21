/**
 * Hardening batch 2 (v0.21.0): seeded generated-input tests for the
 * parsers and tokenizers. Deterministic (mulberry32 with fixed seeds),
 * no network. Invariants: the parsers never throw on adversarial text,
 * results are well-formed and deterministic, and known phantom shapes
 * never become issue references or keywords.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractIssueRefs, branchIssueRefs, titleTokens } from "../src/radar.js";
import {
  extractKeywords,
  wordTokens,
  specialTokens,
  stripUrls,
  scoreCandidate,
  suppressByDocumentFrequency,
  type RaceIssue,
} from "../src/racecheck.js";
import { detectClaims } from "../src/claims.js";
import { parseClaimComment, parseClaimsPolicy, CLAIM_MARKER } from "../src/protocol.js";
import { parseGates, parseGatefileJson } from "../src/gates.js";
import { classifyLinkStrength } from "../src/linkstrength.js";
import type { CommentSignal } from "../src/types.js";

// --- deterministic PRNG + adversarial text generator ---

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  "fix", "oauth2", "patch-1", "patch-2", "#61", "#500", "500", "404",
  "https://github.com/acme/widgets/issues/new?assignees=&labels=bug",
  "https://example.com/some/path?q=assignees=x",
  "`code block`", "```ts\nconst x = 1;\n```",
  "Ünïcodé", "emoji 🚀🔥", "MiXeD CaSe", "CRLF",
  "claude/task-22584764486-1", "bot/task-987654-2", "fix-9483-wsdl",
  "issue-61", "bundle-size-3-migrate", "prior-to-1.0", "$types.d.ts",
  "src/routes/$types.d.ts", "camelCaseIdentifier", "snake_case_name",
  "I'll take this", "working on it", "assign me", "before submitting a PR",
  "ask to be assigned", "x".repeat(200), "  ", "\t", "%20", "a/b/c",
  "0", "00", "999999", "1000000", "-1", "3.10", "v2.73.0-rc.5",
];

function genText(rng: () => number, maxFragments = 24): string {
  const n = Math.floor(rng() * maxFragments);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(FRAGMENTS[Math.floor(rng() * FRAGMENTS.length)]);
  }
  const sep = rng() < 0.3 ? "\r\n" : rng() < 0.5 ? "\n" : " ";
  return parts.join(sep);
}

const EDGE_INPUTS: string[] = [
  "",
  " ",
  "\r\n\r\n",
  "🚀".repeat(500),
  "word ".repeat(10_000),
  "#".repeat(5000),
  "https://".repeat(1000),
  "oauth2 ".repeat(3000),
  "\u0000\u0001\u0002 control chars",
  "ＦＵＬＬＷＩＤＴＨ ｔｅｘｔ",
  "ééé combining marks",
  "「quoted 『nested』 」",
];

describe("hardening fuzz: radar extraction", () => {
  it("extractIssueRefs: well-formed, unique, deterministic on generated text", () => {
    const rng = mulberry32(0x9eed1);
    for (let i = 0; i < 300; i++) {
      const text = genText(rng);
      const a = extractIssueRefs(text);
      const b = extractIssueRefs(text);
      assert.deepEqual(a, b, "deterministic");
      assert.equal(new Set(a).size, a.length, "unique");
      for (const n of a) {
        assert.ok(Number.isInteger(n) && n >= 1 && n <= 999999, `in range: ${n}`);
      }
    }
  });

  it("extractIssueRefs: edge inputs never throw", () => {
    for (const text of EDGE_INPUTS) {
      const out = extractIssueRefs(text);
      assert.ok(Array.isArray(out));
    }
    // issue refs require the # marker: plain numbers are never refs
    assert.deepEqual(extractIssueRefs("500 404 12345"), []);
  });

  it("branchIssueRefs: phantom shapes never yield refs, generated or fixed", () => {
    const phantoms = [
      "bugfix/oauth2-credentialsId-interpolation",
      "inian-patch-1",
      "patch-2",
      "vojtab/fix-mcp-oauth-500",
      "posthog-code/fix-experiment-exposure-500-missing-variants",
      "claude/task-22584764486-1",
      "bot/task-987654-2",
      "bundle-size-3-migrate",
      "prior-to-1.0",
      "release/2.73.0-rc.5",
    ];
    for (const b of phantoms) assert.deepEqual(branchIssueRefs(b), [], b);
    const rng = mulberry32(0x9eed2);
    for (let i = 0; i < 300; i++) {
      const branch = genText(rng).replace(/\s+/g, "-");
      const out = branchIssueRefs(branch);
      assert.equal(new Set(out).size, out.length, "unique");
      for (const n of out) assert.ok(n >= 1 && n <= 999999, `in range: ${n}`);
    }
  });

  it("branchIssueRefs: genuine conventions still parse inside generated noise", () => {
    assert.deepEqual(branchIssueRefs("noise/fix-9483-wsdl"), [9483]);
    assert.deepEqual(branchIssueRefs("feat/61-resume-block"), [61]);
    assert.deepEqual(branchIssueRefs("issue-1234"), [1234]);
  });

  it("titleTokens: never throws, returns strings", () => {
    const rng = mulberry32(0x9eed3);
    for (let i = 0; i < 200; i++) {
      const out = titleTokens(genText(rng));
      assert.ok(out.every((t) => typeof t === "string"));
    }
    for (const t of EDGE_INPUTS) assert.ok(Array.isArray(titleTokens(t)));
  });
});

describe("hardening fuzz: racecheck extraction", () => {
  const issue = (title: string, body: string): RaceIssue => ({
    title,
    body,
    labels: [],
    author: "reporter",
  });

  it("extractKeywords: never throws, deterministic, bounded on generated issues", () => {
    const rng = mulberry32(0x9eed4);
    for (let i = 0; i < 200; i++) {
      const iss = issue(genText(rng, 12), genText(rng, 40));
      const a = extractKeywords(iss, { owner: "acme", repo: "widgets" });
      const b = extractKeywords(iss, { owner: "acme", repo: "widgets" });
      assert.deepEqual(a, b, "deterministic");
      for (const arr of [a.rare, a.terms, a.phrases, a.files]) {
        assert.ok(arr.every((s) => typeof s === "string" && s.length > 0));
        assert.equal(new Set(arr).size, arr.length, "unique");
      }
    }
  });

  it("extractKeywords: huge and edge inputs complete with bounded output", () => {
    for (const text of EDGE_INPUTS) {
      const kw = extractKeywords(issue(text, text), { owner: "acme", repo: "widgets" });
      assert.ok(kw.rare.length + kw.terms.length + kw.phrases.length <= 20_000);
    }
    const big = issue("word ".repeat(10_000), "token ".repeat(10_000));
    const kw = extractKeywords(big, { owner: "acme", repo: "widgets" });
    assert.ok(kw.terms.length <= 10_001);
  });

  it("wordTokens/specialTokens/stripUrls: never throw on edge inputs", () => {
    for (const t of EDGE_INPUTS) {
      assert.ok(Array.isArray(wordTokens(t)));
      assert.ok(Array.isArray(specialTokens(t)));
      assert.equal(typeof stripUrls(t), "string");
    }
    assert.ok(!stripUrls("see https://github.com/a/b/issues/1 now").includes("github.com"));
  });

  it("scoreCandidate + suppressByDocumentFrequency: fuzz invariants", () => {
    const rng = mulberry32(0x9eed5);
    for (let i = 0; i < 150; i++) {
      const kw = extractKeywords(issue(genText(rng, 8), genText(rng, 24)), {
        owner: "acme",
        repo: "widgets",
      });
      const pr = { title: genText(rng, 8), body: genText(rng, 24) };
      const s = scoreCandidate(kw, pr, ["src/index.ts", "docs/guide.md"]);
      assert.ok(s.verdict === null || s.verdict === "RACE" || s.verdict === "SUSPECT");
      const corpus = Array.from({ length: 6 }, () => ({
        title: genText(rng, 4),
        body: genText(rng, 12),
      }));
      const { keywords, suppressed } = suppressByDocumentFrequency(kw, corpus);
      assert.ok(Array.isArray(suppressed));
      assert.ok(keywords.terms.length <= kw.terms.length, "suppression only removes");
    }
  });
});

describe("hardening fuzz: claims and protocol parsing", () => {
  it("detectClaims: at most one signal per author, strengths well-formed", () => {
    const rng = mulberry32(0x9eed6);
    const now = new Date("2026-10-20T00:00:00Z");
    for (let i = 0; i < 150; i++) {
      const comments: CommentSignal[] = Array.from({ length: 8 }, (_, j) => ({
        author: `user-${j % 3}`,
        body: genText(rng, 16),
        createdAt: "2026-10-19T00:00:00Z",
      }));
      const out = detectClaims("reporter", comments, now);
      assert.equal(new Set(out.map((c) => c.author)).size, out.length, "one per author");
      for (const c of out) {
        assert.ok(c.strength === "soft" || c.strength === "strong");
        assert.ok(c.ageDays >= 0);
      }
    }
  });

  it("parseClaimComment: fuzz invariants and marker fidelity", () => {
    const rng = mulberry32(0x9eed7);
    for (let i = 0; i < 200; i++) {
      const body = genText(rng, 16);
      const out = parseClaimComment(body);
      assert.equal(typeof out.isClaim, "boolean");
      assert.ok(out.etaDays === null || (Number.isInteger(out.etaDays) && out.etaDays >= 0));
    }
    // the exact marker always parses as a claim, wherever it sits
    for (const t of EDGE_INPUTS) {
      assert.equal(parseClaimComment(`${t}\n${CLAIM_MARKER}\nplan: ship it\neta-days: 3`).isClaim, true);
    }
    const parsed = parseClaimComment(`${CLAIM_MARKER}\nplan: ship it\neta-days: 3\nqueue-ok: yes`);
    assert.equal(parsed.plan, "ship it");
    assert.equal(parsed.etaDays, 3);
    assert.equal(parsed.queueOk, true);
  });

  it("parseClaimsPolicy: malformed input falls back to defaults, never throws", () => {
    const rng = mulberry32(0x9eed8);
    for (let i = 0; i < 200; i++) {
      const p = parseClaimsPolicy(genText(rng, 10));
      assert.ok(p.lease_days >= 1 && p.lease_days <= 30, "lease clamped");
      assert.ok(p.tenure_cap_days >= 1);
    }
    for (const t of ["", "{", "null", "[]", "\"x\"", "123", "{\"protocol\":2}"]) {
      const p = parseClaimsPolicy(t);
      assert.equal(p.invalid, true, t);
    }
    const ok = parseClaimsPolicy(JSON.stringify({ protocol: 1, lease_days: 5, tenure_cap_days: 20 }));
    assert.equal(ok.lease_days, 5);
    assert.equal(ok.tenure_cap_days, 20);
  });
});

describe("hardening fuzz: gates parsing", () => {
  it("parseGates: never throws, always returns the full gate list", () => {
    const rng = mulberry32(0x9eed9);
    for (let i = 0; i < 200; i++) {
      const gates = parseGates(genText(rng, 30));
      assert.ok(gates.length >= 10, "full gate list");
      for (const g of gates) {
        assert.equal(typeof g.detected, "boolean");
        if (g.detected) assert.ok(g.evidence.length > 0, "detected gates carry evidence");
      }
    }
    for (const t of EDGE_INPUTS) assert.ok(parseGates(t).length >= 10);
    assert.ok(parseGates(undefined).length >= 10);
  });

  it("parseGatefileJson: malformed documents throw a typed error, valid ones parse", () => {
    for (const t of ["", "{nope", "{}", "{\"gates\":{}}", "null", "[]"]) {
      assert.throws(() => parseGatefileJson(t), Error, t);
    }
    const out = parseGatefileJson(
      JSON.stringify({ gates: [{ kind: "cla_required", evidence: "sign it", source: "CONTRIBUTING.md" }] })
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "cla_required");
    // unknown kinds are skipped, not fatal
    assert.deepEqual(parseGatefileJson(JSON.stringify({ gates: [{ kind: "nope" }] })), []);
  });

  it("classifyLinkStrength: fuzz always returns a known strength", () => {
    const rng = mulberry32(0x9eeda);
    const known = new Set(["closing", "mention"]);
    for (let i = 0; i < 200; i++) {
      const s = classifyLinkStrength({
        title: genText(rng, 6),
        body: genText(rng, 12),
        branch: genText(rng, 4).replace(/\s+/g, "-"),
        issueNumber: 61,
      });
      assert.ok(known.has(s), `strength: ${s}`);
    }
    // the original pdfcn shape stays a mention under fuzz-adjacent shapes
    assert.equal(
      classifyLinkStrength({ title: "x", body: "See #71 for context", branch: "", issueNumber: 61 }),
      "mention"
    );
  });
});
