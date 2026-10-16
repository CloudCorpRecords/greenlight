/**
 * Tests for the Verified PR evidence pack: every section renders from
 * injected engines, every claim cites a source, and the verify delta is
 * included only from a provided report (never invented, never run).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvidencePack } from "../src/evidence.js";
import type { GuardResult } from "../src/guard.js";
import type { CiTriageResult } from "../src/ci-triage.js";
import type { ReviewTriageResult } from "../src/review-triage.js";
import type { ProtocolFetchResult } from "../src/protocol-fetch.js";
import type { VerifyResult } from "../src/verify.js";

const PR = "https://github.com/acme/widgets/pull/42";

function guardRes(): GuardResult {
  return {
    pr: PR,
    number: 42,
    repo: "acme/widgets",
    title: "Add widget frobnicate",
    author: "CloudCorpRecords",
    linkedIssues: [{ number: 7, title: "frobnicate is broken", url: "https://github.com/acme/widgets/issues/7", state: "open" }],
    competingPRs: [],
    claims: [],
    findings: [
      { check: "dco-missing", severity: "flag", title: "DCO sign-off missing on 1 of 2 commits", evidence: ["commits without a Signed-off-by trailer: abc1234"] },
    ],
    summary: "Greenlight guard: 1 thing to check",
    hasFindings: true,
    autopilotLabels: [],
    autopilotLabelDecisions: [],
    staleClaimNudges: [],
    markdown: "",
  };
}

function ci(): CiTriageResult {
  return {
    pr: PR,
    title: "Add widget frobnicate",
    baseRef: "main",
    baseSha: "base000",
    headSha: "head111",
    checks: [
      { name: "lint", conclusion: "failure", class: "likely-yours", evidence: "red only on this PR, green on base", detailsUrl: "https://ci.example/runs/1" },
      { name: "deploy-preview", conclusion: "failure", class: "external-blocker", evidence: "Vercel authorization (maintainer-side)" },
    ],
    verdict: "HAS LIKELY-YOURS",
  };
}

function review(): ReviewTriageResult {
  return {
    pr: PR,
    title: "Add widget frobnicate",
    findings: [
      { author: "coderabbitai", authorKind: "bot", path: "src/w.ts", line: 12, summary: "null deref risk", class: "likely-real", reason: "concrete", draft: "thanks" },
    ],
    counts: { likelyReal: 1, likelyNoise: 0, needsDecision: 0, noise: 2, resolved: 0 },
    verdict: "HAS LIKELY-REAL",
  };
}

function protocol(): ProtocolFetchResult {
  return {
    computation: {
      claims: [],
      active: {
        claimant: "rival",
        state: "active",
        claimedAt: "2026-10-01T00:00:00Z",
        expiresAt: "2026-10-08T00:00:00Z",
        commentUrl: "https://github.com/acme/widgets/issues/7#issuecomment-1",
      } as never,
      queue: [{ claimant: "third" } as never],
      activeRecord: null,
      policy: null as never,
    },
    repoProtocol: null,
    policyInvalid: false,
    issueUrl: "https://github.com/acme/widgets/issues/7",
    linkedPrDetails: [],
  };
}

const deps = {
  guard: async () => guardRes(),
  triageCi: async () => ci(),
  triageReview: async () => review(),
  fetchPrMeta: async () => ({ createdAt: "2026-10-15T10:00:00Z", headSha: "head111222" }),
  protocolStatus: async () => protocol(),
  readVerifyJson: async () => null,
};

describe("evidence pack", () => {
  it("assembles all four engine sections with a header", async () => {
    const pack = await buildEvidencePack(PR, { deps, now: new Date("2026-10-16T12:00:00Z") });
    assert.equal(pack.pr, "acme/widgets#42");
    assert.match(pack.markdown, /# Evidence pack: acme\/widgets#42/);
    assert.match(pack.markdown, /"Add widget frobnicate" by @CloudCorpRecords/);
    assert.match(pack.markdown, /## Guard verdict/);
    assert.match(pack.markdown, /## CI triage/);
    assert.match(pack.markdown, /## Review triage/);
    assert.match(pack.markdown, /## Claim Protocol status of linked issues/);
    assert.match(pack.markdown, /## Test-suite delta/);
    assert.match(pack.markdown, /## Sources/);
    assert.match(pack.markdown, /Greenlight v\d+\.\d+\.\d+/);
  });

  it("every claim cites its source", async () => {
    const pack = await buildEvidencePack(PR, { deps });
    // CI finding cites the check run URL.
    assert.ok(pack.markdown.includes("https://ci.example/runs/1"));
    // Review finding cites the reviewer and the anchor.
    assert.ok(pack.markdown.includes("@coderabbitai"));
    assert.ok(pack.markdown.includes("src/w.ts:12"));
    // Protocol claim cites the claim comment URL.
    assert.ok(pack.markdown.includes("https://github.com/acme/widgets/issues/7#issuecomment-1"));
    // Queue is shown.
    assert.ok(pack.markdown.includes("@third"));
  });

  it("includes the verify delta only from a provided report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-"));
    const path = join(dir, "verify.json");
    const vr: VerifyResult = {
      ok: false,
      outcome: "broke",
      command: "npm test",
      parser: "node:test",
      delta: { newlyFailing: ["a > b"], newlyPassing: ["c > d"], stillFailing: ["e > f"], baseTotal: { passed: 10, failed: 2 }, headTotal: { passed: 10, failed: 3 } },
      markdown: "x",
    };
    writeFileSync(path, JSON.stringify(vr));
    const pack = await buildEvidencePack(PR, {
      verifyJsonPath: path,
      deps: { ...deps, readVerifyJson: undefined as never },
    });
    // deps override removed: use the default file reader.
    assert.ok(pack.markdown.includes("newly failing (yours): a > b"));
    assert.ok(pack.markdown.includes("newly passing (fixed by this PR): c > d"));
  });

  it("says so plainly when the verify report is unreadable", async () => {
    const pack = await buildEvidencePack(PR, { verifyJsonPath: "/nonexistent/verify.json", deps });
    assert.ok(pack.markdown.includes("unreadable"));
  });

  it("says so plainly when no verify report is passed", async () => {
    const pack = await buildEvidencePack(PR, { deps });
    assert.ok(pack.markdown.includes("Not included"));
  });

  it("degrades honestly when an engine cannot be read", async () => {
    const pack = await buildEvidencePack(PR, {
      deps: { ...deps, triageCi: async () => { throw new Error("boom"); } },
    });
    assert.ok(pack.markdown.includes("Could not be read this run: boom"));
    // The other sections still render.
    assert.ok(pack.markdown.includes("## Guard verdict"));
  });

  it("the JSON form mirrors the markdown sections", async () => {
    const pack = await buildEvidencePack(PR, { deps });
    const j = pack.json as Record<string, unknown>;
    assert.ok(j.guard && (j.guard as { summary: string }).summary.includes("1 thing to check"));
    assert.equal((j.ci as { verdict: string }).verdict, "HAS LIKELY-YOURS");
    assert.equal((j.review as { verdict: string }).verdict, "HAS LIKELY-REAL");
    assert.ok(Array.isArray(j.protocol) && (j.protocol as unknown[]).length === 1);
  });
});
