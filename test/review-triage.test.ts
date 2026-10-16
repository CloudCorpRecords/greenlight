/**
 * Tests for review-response triage: the pure classifier rules (unit-tested
 * with injected data), the corpus fixtures (five field cases from the
 * campaign), and the orchestration seams (network injected, never live).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorKindOf,
  classifyFinding,
  classifyReviewTriage,
  isNoiseBody,
  oneLineSummary,
  quotedTokens,
  reviewVerdict,
  triageReview,
  type RawFinding,
  type ReviewTriageInput,
  type ReviewTriageVerdict,
  type ClassifiedFinding,
} from "../src/review-triage.js";

const finding = (over: Partial<RawFinding> = {}): RawFinding => ({
  author: "coderabbitai[bot]",
  body: "Some finding.",
  ...over,
});

const classify = (over: Partial<RawFinding>): ClassifiedFinding => classifyFinding(finding(over));

describe("authorKindOf", () => {
  it("recognizes the known review bots, with or without the [bot] suffix", () => {
    assert.equal(authorKindOf("coderabbitai[bot]"), "bot");
    assert.equal(authorKindOf("cubic-dev-ai"), "bot");
    assert.equal(authorKindOf("greptile-apps[bot]"), "bot");
    assert.equal(authorKindOf("copilot-pull-request-reviewer[bot]"), "bot");
    assert.equal(authorKindOf("GitHub-Copilot[bot]"), "bot");
  });
  it("treats everyone else as human", () => {
    assert.equal(authorKindOf("hay-kot"), "human");
    assert.equal(authorKindOf("CloudCorpRecords"), "human");
    assert.equal(authorKindOf("renovate[bot]"), "human");
  });
});

describe("isNoiseBody", () => {
  it("catches CodeRabbit walkthroughs and summaries", () => {
    assert.ok(isNoiseBody("## Walkthrough\n\nSome review."));
    assert.ok(isNoiseBody("## Summary\n\nSome review."));
    assert.ok(isNoiseBody("Random body with Prompt for AI agents inside"));
  });
  it("catches short praise with no code reference", () => {
    assert.ok(isNoiseBody("Looks good, nice work!"));
    assert.ok(isNoiseBody("LGTM"));
  });
  it("does not call praise with a code reference noise", () => {
    assert.ok(!isNoiseBody("Looks good, but `interpolateVars` drops `__proto__`"));
  });
  it("does not call real findings noise", () => {
    assert.ok(!isNoiseBody("In `x.ts`, the lookup uses `Object.assign` and drops `__proto__`."));
  });
});

describe("quotedTokens and oneLineSummary", () => {
  it("extracts backticked and double-quoted tokens in order, deduped", () => {
    assert.deepEqual(quotedTokens('In `x.ts`, `interpolateVars` uses `Object.assign` with "params" and `Object.assign`'), [
      "x.ts",
      "interpolateVars",
      "Object.assign",
      "params",
    ]);
  });
  it("keeps backtick pairing aligned past a 1-char token", () => {
    // A skipped 1-char span must not re-pair the surrounding backticks
    // into a phantom token like " uses ".
    assert.deepEqual(quotedTokens("`a` uses `Object.assign({}, p)` and drops `__proto__`."), [
      "Object.assign({}, p)",
      "__proto__",
    ]);
  });
  it("takes the first sentence as the summary", () => {
    assert.equal(oneLineSummary("First line. Second line is ignored."), "First line.");
    assert.equal(oneLineSummary("  Multi\n   space  body  "), "Multi space body");
  });
});

describe("rule 1: humans are never noise", () => {
  it("a human finding becomes needs-decision", () => {
    const f = classify({ author: "hay-kot", body: "This should also apply to the electron package." });
    assert.equal(f.class, "needs-decision");
    assert.ok(f.reason.includes("human reviewer"), `reason: ${f.reason}`);
    assert.equal(f.authorKind, "human");
  });
  it("a human question becomes needs-decision", () => {
    const f = classify({ author: "maintainer", body: "Should this also apply to X?" });
    assert.equal(f.class, "needs-decision");
  });
});

describe("rule 2: generated files and lockfiles", () => {
  it("flags bot findings on lockfiles", () => {
    const f = classify({ body: "This dependency has a CVE, update it.", path: "package-lock.json" });
    assert.equal(f.class, "likely-noise");
    assert.ok(f.reason.includes("lockfile"), `reason: ${f.reason}`);
  });
  it("flags bot findings in dist/ and on snapshots", () => {
    assert.equal(classify({ body: "Minified code issue.", path: "dist/bundle.min.js" }).class, "likely-noise");
    assert.equal(classify({ body: "Snapshot outdated.", path: "tests/__snapshots__/x.test.ts.snap" }).class, "likely-noise");
  });
  it("does not flag real source files", () => {
    const f = classify({
      body: "The hunk uses `Object.assign` and drops `__proto__`.",
      path: "packages/cli/src/runner/interpolate-vars.js",
      diffHunk: "- const l = Object.assign({}, params);",
    });
    assert.notEqual(f.class, "likely-noise");
  });
});

describe("rule 3: bot questions", () => {
  it("routes bot questions to needs-decision", () => {
    const f = classify({
      body: "Why does this use `Object.create(null)` instead of a Map here?",
      path: "x.ts",
      diffHunk: "+ const m = Object.create(null);",
    });
    assert.equal(f.class, "needs-decision");
    assert.ok(f.reason.includes("question"), `reason: ${f.reason}`);
  });
});

describe("rule 4: security premise contradicted by the hunk", () => {
  it("flags a direct-fetch SSRF claim when the hunk shows a proxy helper", () => {
    const f = classify({
      body: "**P1 Security**: `discover` calls `fetch(url)` directly with no proxy, enabling SSRF.",
      path: "src/discover.ts",
      diffHunk: "+ const res = await createAiProxyFetch({ url: endpoint });",
    });
    assert.equal(f.class, "likely-noise");
    assert.ok(f.reason.includes("premise contradicted by surrounding code"), `reason: ${f.reason}`);
    assert.ok(f.reason.includes("createAiProxyFetch"), `reason: ${f.reason}`);
    assert.ok(f.draft.includes("createAiProxyFetch"), `draft: ${f.draft}`);
  });
  it("does not fire when the hunk really is a bare fetch", () => {
    const f = classify({
      body: "**P1 Security**: `discover` calls `fetch(url)` directly, enabling SSRF.",
      path: "src/discover.ts",
      diffHunk: "+ const res = await fetch(url);",
    });
    assert.notEqual(f.class, "likely-noise");
  });
});

describe("rule 5: style nits contradicted by surrounding code", () => {
  it("flags a formatting nit the context lines already contradict", () => {
    const f = classify({
      body: "Prettier: use `  ` (two spaces) indentation instead of tabs.",
      path: "x.ts",
      diffHunk: "  const ok = true;\n+\tconst x = 1;",
    });
    assert.equal(f.class, "likely-noise");
    assert.ok(f.reason.includes("contradicted by the surrounding code"), `reason: ${f.reason}`);
  });
});

describe("rule 6: anchor matches", () => {
  it("marks likely-real when the quoted token is in the hunk", () => {
    const f = classify({
      body: "`interpolateVars` builds the lookup with `Object.assign({}, params)`, so `__proto__` vanishes.",
      path: "packages/cli/src/runner/interpolate-vars.js",
      line: 42,
      diffHunk: "- const lookup = Object.assign({}, params);",
    });
    assert.equal(f.class, "likely-real");
    assert.ok(f.reason.includes("anchor matches"), `reason: ${f.reason}`);
    assert.ok(f.draft.includes("Fixed in <next commit>"), `draft: ${f.draft}`);
    assert.equal(f.line, 42);
  });
});

describe("rule 7: anchor mismatch", () => {
  it("flags a present-code claim the hunk does not contain", () => {
    const f = classify({
      body: "The code on line 9 uses `dangerouslySetInnerHTML`, which is risky.",
      path: "x.tsx",
      diffHunk: "- const t = sanitize(name);\n+ const t = escape(name);",
    });
    assert.equal(f.class, "likely-noise");
    assert.ok(f.reason.includes("anchor mismatch"), `reason: ${f.reason}`);
    assert.ok(f.reason.includes("dangerouslySetInnerHTML"), `reason: ${f.reason}`);
  });
  it("does not fire when the suggestion is presented as new code", () => {
    const f = classify({
      body: "Consider adding `escape()` here: `const t = escape(name);`",
      path: "x.ts",
      diffHunk: "- const t = name;",
    });
    assert.notEqual(f.class, "likely-noise");
  });
});

describe("rule 8: unproven defaults to needs-decision", () => {
  it("a bot finding with no signal lands on needs-decision", () => {
    const f = classify({ body: "This function is getting long.", path: "x.ts" });
    assert.equal(f.class, "needs-decision");
    assert.ok(f.reason.includes("judgment"), `reason: ${f.reason}`);
  });
});

describe("reviewVerdict", () => {
  const mk = (cls: ClassifiedFinding["class"]): ClassifiedFinding => ({
    author: "x",
    authorKind: "bot",
    summary: "s",
    class: cls,
    reason: "r",
    draft: "d",
  });
  it("NO FINDINGS when there is nothing actionable", () => {
    assert.equal(reviewVerdict([]), "NO FINDINGS");
  });
  it("HAS LIKELY-REAL dominates", () => {
    assert.equal(reviewVerdict([mk("needs-decision"), mk("likely-real"), mk("likely-noise")]), "HAS LIKELY-REAL");
  });
  it("NEEDS DECISIONS beats ALL NOISE", () => {
    assert.equal(reviewVerdict([mk("likely-noise"), mk("needs-decision")]), "NEEDS DECISIONS");
  });
  it("ALL NOISE when everything classified is noise", () => {
    assert.equal(reviewVerdict([mk("likely-noise")]), "ALL NOISE");
  });
});

describe("classifyReviewTriage pipeline", () => {
  it("splits noise and resolved comments off and rolls up the rest", () => {
    const r = classifyReviewTriage({
      prUrl: "https://github.com/acme/w/pull/1",
      prTitle: "t",
      prAuthor: "acme-author",
      candidates: [
        finding({ body: "## Walkthrough\n\nreview." }),
        finding({ body: "Stale comment.", reviewState: "DISMISSED" }),
        finding({
          body: "`a` uses `Object.assign({}, p)` and drops `__proto__`.",
          path: "x.ts",
          diffHunk: "- const l = Object.assign({}, p);",
        }),
      ],
    });
    assert.deepEqual(r.counts, { likelyReal: 1, likelyNoise: 0, needsDecision: 0, noise: 1, resolved: 1 });
    assert.equal(r.verdict, "HAS LIKELY-REAL");
    assert.equal(r.findings.length, 1);
  });
  it("skips the author's own comments as noise (they are replies, not findings)", () => {
    const r = classifyReviewTriage({
      prUrl: "https://github.com/acme/w/pull/1",
      prTitle: "t",
      prAuthor: "CloudCorpRecords",
      candidates: [
        finding({ author: "CloudCorpRecords", body: "Good catch, thank you." }),
        finding({
          author: "maintainer",
          body: "Should this also apply to X?",
        }),
      ],
    });
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].author, "maintainer");
    assert.equal(r.counts.noise, 1);
    assert.equal(r.verdict, "NEEDS DECISIONS");
  });
  it("NO FINDINGS when every candidate is noise", () => {
    const r = classifyReviewTriage({
      prUrl: "https://github.com/acme/w/pull/1",
      prTitle: "t",
      prAuthor: "",
      candidates: [finding({ body: "## Summary\n\nreview." })],
    });
    assert.equal(r.verdict, "NO FINDINGS");
    assert.equal(r.counts.noise, 1);
  });
});

const REVIEW_CASES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "review-cases");

interface ReviewCase {
  name: string;
  input: ReviewTriageInput;
  expect: {
    verdict: ReviewTriageVerdict;
    counts?: Partial<ReviewTriageResult["counts"]>;
    findings: Record<string, { class: string; reasonContains: string; draftContains?: string }>;
  };
}

describe("review field cases (frozen corpus)", () => {
  const files = readdirSync(REVIEW_CASES).filter((f) => f.endsWith(".json")).sort();
  assert.ok(files.length === 5, `expected 5 review cases, found ${files.length}`);
  for (const file of files) {
    it(file, () => {
      const c = JSON.parse(readFileSync(join(REVIEW_CASES, file), "utf8")) as ReviewCase;
      const r = classifyReviewTriage(c.input);
      assert.equal(r.verdict, c.expect.verdict, `${c.name}: verdict`);
      if (c.expect.counts) {
        for (const [k, v] of Object.entries(c.expect.counts)) {
          assert.equal(r.counts[k as keyof ReviewTriageResult["counts"]], v, `${c.name}: count ${k}`);
        }
      }
      for (const [key, e] of Object.entries(c.expect.findings)) {
        const got = r.findings.find((f) => `${f.author}|${f.path ?? "general"}` === key);
        assert.ok(got, `${c.name}: expected finding "${key}" in output`);
        assert.equal(got.class, e.class, `${c.name}: ${key} class`);
        assert.ok(got.reason.includes(e.reasonContains), `${c.name}: ${key} reason "${got.reason}" lacks "${e.reasonContains}"`);
        if (e.draftContains) {
          assert.ok(got.draft.includes(e.draftContains), `${c.name}: ${key} draft lacks "${e.draftContains}"`);
        }
      }
    });
  }
});

describe("triageReview orchestration", () => {
  const reviewApi = [
    { id: 1, user: { login: "coderabbitai[bot]" }, state: "COMMENTED", body: "" },
    { id: 2, user: { login: "greptile-apps[bot]" }, state: "DISMISSED", body: "" },
  ];
  const commentApi = [
    {
      id: 11,
      user: { login: "coderabbitai[bot]" },
      body: "`a` uses `Object.assign({}, p)` and drops `__proto__`.",
      path: "x.ts",
      line: 9,
      diff_hunk: "- const l = Object.assign({}, p);",
      pull_request_review_id: 1,
    },
    {
      id: 12,
      user: { login: "greptile-apps[bot]" },
      body: "Stale, ignore.",
      path: "x.ts",
      line: 3,
      pull_request_review_id: 2,
    },
  ];
  const issueApi = [{ id: 21, user: { login: "coderabbitai[bot]" }, body: "## Walkthrough\n\nreview." }];
  const deps = {
    fetchPull: async () => ({ title: "fix", author: "acme-author" }),
    fetchReviews: async () => reviewApi,
    fetchReviewComments: async () => commentApi,
    fetchIssueComments: async () => issueApi,
  };
  it("wires reviews, inline comments, and bot issue comments through the classifier", async () => {
    const r = await triageReview("https://github.com/acme/w/pull/1", deps);
    assert.equal(r.title, "fix");
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].class, "likely-real");
    assert.equal(r.findings[0].path, "x.ts");
    assert.equal(r.findings[0].line, 9);
    assert.deepEqual(r.counts, { likelyReal: 1, likelyNoise: 0, needsDecision: 0, noise: 1, resolved: 1 });
    assert.equal(r.verdict, "HAS LIKELY-REAL");
  });
  it("degrades to no candidates when every source fails", async () => {
    const r = await triageReview("https://github.com/acme/w/pull/1", {
      fetchPull: async () => {
        throw new Error("boom");
      },
      fetchReviews: async () => {
        throw new Error("boom");
      },
      fetchReviewComments: async () => {
        throw new Error("boom");
      },
      fetchIssueComments: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(r.verdict, "NO FINDINGS");
    assert.equal(r.findings.length, 0);
  });
});
