/**
 * v0.25.0: full friction scans the repo's workflows; lite does not.
 * Field case (2026-10-27 closed-unmerged audit, gap 1): friction's
 * gate list came only from policy prose, so activepieces scored 42
 * on friction while check on the same repo detected its
 * external_prs_closed workflow gate. This fixture serves a repo
 * whose ONLY wall is a close-external-prs workflow (no prose gates
 * at all): full friction must surface the workflow gate and the
 * door_closed aggregate must count it; lite stays prose-only.
 * Route shape mirrors test/friction-lite.test.ts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setFetchImpl } from "../src/github.js";
import { fetchFrictionSummary, mergeWorkflowGates } from "../src/friction.js";
import type { RepoSignals } from "../src/types.js";

const OWNER = "wf-fixture-o";
const REPO = "wf-fixture-r";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MERGED = [
  {
    merged_at: "2026-10-01T00:00:00Z",
    user: { login: "teammate" },
    author_association: "COLLABORATOR",
    merged: true,
    state: "closed",
  },
  {
    merged_at: "2026-10-02T00:00:00Z",
    user: { login: "teammate2" },
    author_association: "MEMBER",
    merged: true,
    state: "closed",
  },
];

function installMock() {
  setFetchImpl(async (input: unknown) => {
    const url = String(input);
    if (url.includes("raw.githubusercontent.com")) {
      if (url.includes("close-external-prs.yml")) {
        return new Response("name: Close external PRs\non: pull_request_target\n", { status: 200 });
      }
      return new Response("name: CI\non: push\n", { status: 200 });
    }
    const u = new URL(url);
    const p = u.pathname;
    if (p === `/repos/${OWNER}/${REPO}`) {
      return jsonResponse({ full_name: `${OWNER}/${REPO}` });
    }
    if (p === `/repos/${OWNER}/${REPO}/contents/.github/workflows`) {
      return jsonResponse([
        { name: "close-external-prs.yml", type: "file" },
        { name: "ci.yml", type: "file" },
      ]);
    }
    if (p.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
      return jsonResponse({ message: "Not Found" }, 404);
    }
    if (p.startsWith(`/orgs/${OWNER}/`)) {
      return jsonResponse({ message: "Not Found" }, 404);
    }
    if (p === `/repos/${OWNER}/${REPO}/pulls`) {
      if (url.includes("page=2") || url.includes("page=3")) return jsonResponse([]);
      return jsonResponse(MERGED);
    }
    if (p === "/search/issues") {
      return jsonResponse({ total_count: 0, items: [] });
    }
    return jsonResponse({ message: "unexpected " + p }, 500);
  });
}

describe("v0.25.0 workflow gates in friction", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.GREENLIGHT_GITHUB_BASE_URL = "http://127.0.0.1:9";
    delete process.env.GREENLIGHT_GITHUB_TOKEN;
    installMock();
  });
  afterEach(() => {
    setFetchImpl(null);
    process.env = { ...savedEnv };
  });

  it("full friction surfaces the workflow gate and closes the door", async () => {
    const full = await fetchFrictionSummary(OWNER, REPO, { lite: false });
    const kinds = full.gates.filter((g) => g.detected).map((g) => g.kind);
    assert.deepEqual(kinds, ["external_prs_closed"]);
    assert.equal(full.door_closed.closed, true);
    assert.deepEqual(full.door_closed.kinds, ["external_prs_closed"]);
  });

  it("lite friction stays policy-sources-only", async () => {
    const lite = await fetchFrictionSummary(OWNER, REPO, { lite: true });
    assert.equal(
      lite.gates.some((g) => g.kind === "external_prs_closed" && g.detected),
      false
    );
    assert.equal(lite.door_closed.closed, false);
  });

  it("mergeWorkflowGates keeps policy evidence and drops undetected gates", () => {
    const policy: RepoSignals["gates"] = [
      { kind: "external_prs_closed", detected: true, evidence: "policy text wins" },
      { kind: "agents_banned", detected: false, evidence: "" },
    ];
    const workflow: RepoSignals["gates"] = [
      { kind: "external_prs_closed", detected: true, evidence: "workflow name" },
      { kind: "stale_bot", detected: true, evidence: ".github/workflows/stale.yml" },
      { kind: "manual_review", detected: false, evidence: "" },
    ];
    const merged = mergeWorkflowGates(policy, workflow);
    assert.equal(merged.length, 3);
    assert.equal(
      merged.find((g) => g.kind === "external_prs_closed")?.evidence,
      "policy text wins"
    );
    assert.equal(merged.some((g) => g.kind === "stale_bot" && g.detected), true);
    assert.equal(merged.some((g) => g.kind === "manual_review"), false);
  });
});
