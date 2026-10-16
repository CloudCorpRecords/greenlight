/**
 * Tests for CI failure triage: the pure classifier rules (unit-tested with
 * injected data), the corpus fixtures (four field cases from the campaign),
 * and the orchestration seams (network injected, never live).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyCheck,
  classifyCiTriage,
  checkTouchesFiles,
  normalizeCheckName,
  stripMatrix,
  triagePr,
  triageVerdict,
  type CiTriageInput,
  type BaseCheckRecord,
  type HeadCheck,
  type ClassifiedCheck,
  type CiTriageVerdict,
} from "../src/ci-triage.js";
import { parsePullUrl } from "../src/github.js";

const check = (name: string, conclusion = "failure"): HeadCheck => ({ name, conclusion });
const base = (name: string, conclusion: string, at = "2026-10-14T10:00:00Z"): BaseCheckRecord => ({
  name,
  conclusion,
  completedAt: at,
});
const classify = (
  name: string,
  baseRecords: BaseCheckRecord[],
  files: string[]
): ClassifiedCheck => classifyCheck(check(name), baseRecords, files);

describe("normalizeCheckName and stripMatrix", () => {
  it("keeps the matrix suffix but normalizes case and whitespace", () => {
    assert.equal(normalizeCheckName("  Install-Gate  (windows-latest) "), "install-gate (windows-latest)");
  });
  it("stripMatrix removes the matrix suffix", () => {
    assert.equal(stripMatrix("install-gate (windows-latest)"), "install-gate");
  });
  it("leaves plain names alone", () => {
    assert.equal(normalizeCheckName("Vercel"), "vercel");
    assert.equal(stripMatrix("vercel"), "vercel");
  });
});

describe("external-blocker classification", () => {
  it("flags the Vercel authorization check from pdfcn/firecrawl", () => {
    const c = classify("Vercel - Authorization required", [], ["a.ts"]);
    assert.equal(c.class, "external-blocker");
    assert.ok(c.evidence.includes("Vercel"), `evidence: ${c.evidence}`);
  });
  it("flags deploy preview checks", () => {
    assert.equal(classify("deploy preview", [], []).class, "external-blocker");
  });
  it("flags Netlify and Cloudflare Pages", () => {
    assert.equal(classify("netlify build", [], []).class, "external-blocker");
    assert.equal(classify("Cloudflare Pages build", [], []).class, "external-blocker");
  });
  it("does not flag ordinary test checks", () => {
    const c = classify("unit-tests", [], []);
    assert.notEqual(c.class, "external-blocker");
  });
  it("wins over a matching base failure", () => {
    const c = classify("Vercel", [base("Vercel", "failure")], []);
    assert.equal(c.class, "external-blocker");
  });
});

describe("pre-existing classification", () => {
  it("matches base failures across matrix variants as a family", () => {
    const c = classify(
      "install-gate (windows-latest)",
      [base("install-gate (ubuntu-latest)", "failure"), base("install-gate (ubuntu-latest)", "success")],
      ["packages/cli/src/x.ts"]
    );
    assert.equal(c.class, "pre-existing");
    assert.ok(c.evidence.includes('family "install-gate" failing on base: 1 of 2 family runs'), `evidence: ${c.evidence}`);
  });
  it("prefers the exact variant when both match", () => {
    const c = classify(
      "install-gate (windows-latest)",
      [
        base("install-gate (windows-latest)", "failure"),
        base("install-gate (ubuntu-latest)", "failure"),
      ],
      []
    );
    assert.ok(c.evidence.includes("same check failing on base: 1 of 1"), `evidence: ${c.evidence}`);
  });
  it("quotes the last base failure time", () => {
    const c = classify(
      "gate",
      [base("gate", "failure", "2026-10-14T10:00:00Z"), base("gate", "failure", "2026-10-13T10:00:00Z")],
      []
    );
    assert.ok(c.evidence.includes("2026-10-14T10:00:00Z"), `evidence: ${c.evidence}`);
  });
  it("a passing base record alone does not make pre-existing", () => {
    const c = classify("gate", [base("gate", "success")], []);
    assert.notEqual(c.class, "pre-existing");
  });
});

describe("checkTouchesFiles", () => {
  it("links by package token in the check name", () => {
    const linked = checkTouchesFiles("unit-tests (payments)", ["packages/payments/src/retry.ts"]);
    assert.deepEqual(linked, ["packages/payments/src/retry.ts"]);
  });
  it("links by filename stem", () => {
    const linked = checkTouchesFiles("login form e2e", ["src/components/LoginForm.tsx"]);
    assert.deepEqual(linked, ["src/components/LoginForm.tsx"]);
  });
  it("links lint checks to any source file", () => {
    const linked = checkTouchesFiles("eslint", ["src/app.py"]);
    assert.deepEqual(linked, ["src/app.py"]);
  });
  it("links test checks to test-shaped files", () => {
    const linked = checkTouchesFiles("unit-tests", ["src/__tests__/retry.test.ts"]);
    assert.deepEqual(linked, ["src/__tests__/retry.test.ts"]);
  });
  it("ignores environment tokens", () => {
    const linked = checkTouchesFiles("install-gate (windows-latest)", ["packages/cli/src/confirm.ts"]);
    assert.deepEqual(linked, []);
  });
  it("returns no more than three paths", () => {
    const files = ["a/payments.ts", "b/payments.ts", "c/payments.ts", "d/payments.ts"];
    const linked = checkTouchesFiles("payments", files);
    assert.equal(linked.length, 3);
  });
});

describe("likely-yours classification", () => {
  it("fires when base passes and the PR touches the check's area", () => {
    const c = classify(
      "unit-tests (payments)",
      [base("unit-tests (payments)", "success")],
      ["packages/payments/src/retry.ts"]
    );
    assert.equal(c.class, "likely-yours");
    assert.ok(c.evidence.includes("packages/payments/src/retry.ts"), `evidence: ${c.evidence}`);
  });
  it("fires on the semantic token link too", () => {
    const c = classify("lint", [base("lint", "success")], ["src/new-code.ts"]);
    assert.equal(c.class, "likely-yours");
  });
});

describe("indeterminate classification", () => {
  it("leans yours when the PR touches the area but there is no base history", () => {
    const c = classify("fresh-check (extra)", [], ["packages/extra/src/x.ts"]);
    assert.equal(c.class, "indeterminate");
    assert.equal(c.lean, "yours");
    assert.ok(c.evidence.includes("leans yours"), `evidence: ${c.evidence}`);
  });
  it("leans pre-existing when the PR does not touch the area (reticle #1633 rule)", () => {
    const c = classify("fixture tests (reports)", [], ["packages/dashboard/src/Widget.tsx"]);
    assert.equal(c.class, "indeterminate");
    assert.equal(c.lean, "pre-existing");
    assert.ok(c.evidence.includes("leans pre-existing"), `evidence: ${c.evidence}`);
    assert.ok(c.evidence.includes("none of the PR's files relate"), `evidence: ${c.evidence}`);
  });
  it("is not likely-yours when base passes but files are unrelated", () => {
    const c = classify("lint", [base("lint", "success")], ["docs/readme.md"]);
    assert.notEqual(c.class, "likely-yours");
  });
});

describe("triageVerdict", () => {
  const mk = (cls: ClassifiedCheck["class"]): ClassifiedCheck => ({
    name: "x",
    conclusion: "failure",
    class: cls,
    evidence: "e",
  });
  it("NO FAILURES when nothing failed", () => {
    assert.equal(triageVerdict([]), "NO FAILURES");
  });
  it("ALL PRE-EXISTING when everything is pre-existing or external", () => {
    assert.equal(triageVerdict([mk("pre-existing"), mk("external-blocker")]), "ALL PRE-EXISTING");
  });
  it("HAS LIKELY-YOURS dominates", () => {
    assert.equal(triageVerdict([mk("pre-existing"), mk("likely-yours"), mk("indeterminate")]), "HAS LIKELY-YOURS");
  });
  it("INDETERMINATE when anything is indeterminate", () => {
    assert.equal(triageVerdict([mk("pre-existing"), mk("indeterminate")]), "INDETERMINATE");
  });
});

describe("classifyCiTriage", () => {
  it("classifies every failing check and rolls up", () => {
    const input: CiTriageInput = {
      prUrl: "https://github.com/acme/w/pull/1",
      prTitle: "t",
      baseRef: "main",
      baseSha: "a",
      headSha: "b",
      headChecks: [check("lint"), check("deploy preview")],
      baseRecords: [base("lint", "success")],
      changedFiles: ["src/app.ts"],
    };
    const r = classifyCiTriage(input);
    assert.equal(r.checks.length, 2);
    assert.equal(r.checks[0].class, "likely-yours");
    assert.equal(r.checks[1].class, "external-blocker");
    assert.equal(r.verdict, "HAS LIKELY-YOURS");
  });
});

describe("parsePullUrl", () => {
  it("parses a /pull/ URL", () => {
    assert.deepEqual(parsePullUrl("https://github.com/reticlehq/reticle/pull/1620"), {
      owner: "reticlehq",
      repo: "reticle",
      number: 1620,
    });
  });
  it("rejects issue URLs and garbage", () => {
    assert.throws(() => parsePullUrl("https://github.com/reticlehq/reticle/issues/1620"));
    assert.throws(() => parsePullUrl("https://example.com/x"));
  });
});

const CI_CASES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ci-cases");

interface CiCase {
  name: string;
  input: CiTriageInput;
  expect: { verdict: CiTriageVerdict; checks: Record<string, { class: string; evidenceContains: string; lean?: string }> };
}

describe("ci field cases (frozen corpus)", () => {
  const files = readdirSync(CI_CASES).filter((f) => f.endsWith(".json")).sort();
  assert.ok(files.length === 4, `expected 4 ci cases, found ${files.length}`);
  for (const file of files) {
    it(file, () => {
      const c = JSON.parse(readFileSync(join(CI_CASES, file), "utf8")) as CiCase;
      const r = classifyCiTriage(c.input);
      assert.equal(r.verdict, c.expect.verdict, `${c.name}: verdict`);
      for (const [name, e] of Object.entries(c.expect.checks)) {
        const got = r.checks.find((x) => x.name === name);
        assert.ok(got, `${c.name}: expected check "${name}" in output`);
        assert.equal(got.class, e.class, `${c.name}: ${name} class`);
        assert.ok(got.evidence.includes(e.evidenceContains), `${c.name}: ${name} evidence "${got.evidence}" lacks "${e.evidenceContains}"`);
        if (e.lean) assert.equal(got.lean, e.lean, `${c.name}: ${name} lean`);
      }
    });
  }
});

describe("triagePr orchestration", () => {
  const deps = {
    fetchPull: async () => ({
      title: "fix",
      baseRef: "main",
      baseSha: "a",
      headSha: "b",
      changedFiles: ["src/payments.ts"],
    }),
    fetchHeadChecks: async () => [
      { name: "unit-tests (payments)", conclusion: "failure", failureLines: ["expected 1, got 2"] },
    ],
    fetchBaseRecords: async () => [base("unit-tests (payments)", "failure", "2026-10-14T10:00:00Z")],
  };
  it("wires the fetchers through the pure classifier", async () => {
    const r = await triagePr("https://github.com/acme/w/pull/1", deps);
    assert.equal(r.pr, "https://github.com/acme/w/pull/1");
    assert.equal(r.checks.length, 1);
    assert.equal(r.checks[0].class, "pre-existing");
    assert.deepEqual(r.checks[0].failureLines, ["expected 1, got 2"]);
    assert.equal(r.verdict, "ALL PRE-EXISTING");
  });
  it("degrades to indeterminate when the base window cannot be read", async () => {
    const r = await triagePr("https://github.com/acme/w/pull/1", {
      ...deps,
      fetchBaseRecords: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(r.checks[0].class, "indeterminate");
    assert.equal(r.checks[0].lean, "yours");
  });
  it("rejects non-PR URLs before any fetch", async () => {
    let fetched = false;
    await assert.rejects(
      triagePr("https://github.com/acme/w/issues/1", {
        fetchPull: async () => {
          fetched = true;
          return deps.fetchPull();
        },
      })
    );
    assert.equal(fetched, false);
  });
});
