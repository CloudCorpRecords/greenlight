/**
 * v0.19.0 (item 6): friction --lite, the canonical lightweight
 * computation. Lite runs the policy-source fetch plus
 * parseGatesFromSources (and the free collaboratorsOnly push) and
 * scores 100 + gate weights with every outcome signal null; it skips
 * the behavioral pass, merge velocity, and the starter-issue count.
 * These tests run lite and full friction over the same mocked sources
 * and compare the gates arrays, and pin that lite leaves the skipped
 * signals null with note "lite".
 *
 * The mock serves the immich gate fixture as the repo's CONTRIBUTING.md
 * (agents_banned, which carries no friction weight), so lite scores 100
 * while full scores 100 - 20 (0% external merge share) + 3.5 (7 starter
 * issues) = 84.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setFetchImpl, resetApiCalls, apiCallsUsed } from "../src/github.js";
import { fetchFrictionSummary } from "../src/friction.js";

const FIXTURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "policy", "immich-contributing.md"), "utf8");

const OWNER = "lite-fixture-o";
const REPO = "lite-fixture-r";

const savedEnv: Record<string, string | undefined> = {};
let requested: string[] = [];

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** Route GitHub paths to canned responses; records every requested URL. */
function mockGithub() {
  const impl = (async (url: string) => {
    requested.push(String(url));
    const u = new URL(String(url));
    const p = u.pathname;
    if (p === `/repos/${OWNER}/${REPO}`) {
      return new Response(JSON.stringify({ full_name: `${OWNER}/${REPO}` }), { status: 200 });
    }
    if (p.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
      if (p.endsWith("/contents/CONTRIBUTING.md")) {
        return new Response(JSON.stringify({ content: b64(FIXTURE), encoding: "base64" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }
    if (p === `/repos/${OWNER}/.github/contents/AI_POLICY.md`) {
      return new Response("{}", { status: 404 });
    }
    if (p === `/repos/${OWNER}/${REPO}/pulls`) {
      // The behavioral pass requests &page=N; velocity asks for one page with no page param.
      if (u.searchParams.has("page")) return new Response("[]", { status: 200 }); // behavioral pass: no PRs
      return new Response(
        JSON.stringify([
          { author_association: "COLLABORATOR", created_at: "2026-10-01T00:00:00Z", merged_at: "2026-10-03T00:00:00Z" },
          { author_association: "COLLABORATOR", created_at: "2026-10-02T00:00:00Z", merged_at: "2026-10-04T00:00:00Z" },
        ]),
        { status: 200 }
      );
    }
    if (p === "/search/issues") {
      return new Response(JSON.stringify({ total_count: 7, items: [] }), { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  setFetchImpl(impl);
}

beforeEach(() => {
  for (const k of ["GREENLIGHT_GITHUB_BASE_URL", "GITHUB_TOKEN", "GH_TOKEN"]) {
    savedEnv[k] = process.env[k];
  }
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  // Force the contents-API path for policy-file reads.
  process.env.GREENLIGHT_GITHUB_BASE_URL = "http://127.0.0.1:9";
  requested = [];
  resetApiCalls();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setFetchImpl(null);
});

describe("friction --lite", () => {
  it("lite and full friction agree on gate detections over the same sources", async () => {
    mockGithub();
    const lite = await fetchFrictionSummary(OWNER, REPO, { lite: true });
    const full = await fetchFrictionSummary(OWNER, REPO);
    assert.deepEqual(lite.gates, full.gates);
    const banned = lite.gates.find((g) => g.kind === "agents_banned");
    assert.ok(banned && banned.detected, "the immich fixture gate is detected in both modes");
  });

  it("lite scores 100 + gate weights only; full applies the outcome signals", async () => {
    mockGithub();
    const lite = await fetchFrictionSummary(OWNER, REPO, { lite: true });
    const full = await fetchFrictionSummary(OWNER, REPO);
    // agents_banned carries no friction weight, so lite scores a clean 100.
    assert.equal(lite.score, 100);
    // full: 100 + (0.0 - 0.5) * 40 (0% external merge share) + 3.5 (7 starter issues) = 84.
    assert.equal(full.score, 84);
    assert.ok(full.score < lite.score);
  });

  it("lite skips the behavioral pass, merge velocity, and starter-issue count", async () => {
    mockGithub();
    const before = apiCallsUsed();
    const lite = await fetchFrictionSummary(OWNER, REPO, { lite: true });
    const liteCalls = apiCallsUsed() - before;
    assert.equal(lite.lite, true);
    assert.equal(lite.signals.note, "lite");
    assert.equal(lite.signals.externalPRMergeRate, null);
    assert.equal(lite.signals.openGoodFirstIssueCount, null);
    assert.equal(lite.signals.behavioralGate, null);
    assert.equal(lite.behavioral_gate, null);
    assert.equal(lite.mergeVelocity, null);
    assert.equal(lite.outsider_merge_share, null);
    // No starter-issue search and no PR list calls were made.
    assert.ok(!requested.some((u) => u.includes("/search/issues")), "lite must not search starter issues");
    assert.ok(!requested.some((u) => u.includes("/pulls")), "lite must not list PRs");
    const full = await fetchFrictionSummary(OWNER, REPO);
    assert.equal(full.lite, undefined);
    assert.equal(full.signals.note, "live");
    assert.ok(apiCallsUsed() - before > liteCalls, "full mode pays for the skipped signals");
  });

  it("full friction over the same mock computes the skipped signals", async () => {
    mockGithub();
    const full = await fetchFrictionSummary(OWNER, REPO);
    assert.equal(full.signals.openGoodFirstIssueCount, 7);
    assert.equal(full.signals.externalPRMergeRate, 0);
    assert.equal(full.signals.externalPRMergeRate_pct, 0);
    assert.equal(full.outsider_merge_share, 0);
  });

  it("the friction JSON shape carries policy_provenance in lite and full modes", async () => {
    mockGithub();
    const lite = JSON.parse(JSON.stringify(await fetchFrictionSummary(OWNER, REPO, { lite: true })));
    const full = JSON.parse(JSON.stringify(await fetchFrictionSummary(OWNER, REPO)));
    assert.equal(lite.lite, true);
    assert.equal(full.lite, undefined);
    for (const report of [lite, full]) {
      const prov = report.policy_provenance;
      assert.ok(Array.isArray(prov), "policy_provenance is present in JSON");
      const contrib = prov.find((p: { file: string }) => p.file === "CONTRIBUTING.md");
      assert.deepEqual(contrib, { file: "CONTRIBUTING.md", scope: "repo", status: "read" });
      const org = prov.find((p: { scope: string }) => p.scope === "org");
      assert.deepEqual(org, { file: `AI_POLICY.md (org ${OWNER})`, scope: "org", status: "absent" });
    }
  });
});
