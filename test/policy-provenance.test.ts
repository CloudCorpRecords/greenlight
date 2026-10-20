/**
 * v0.19.0 (item 7): policy-source read provenance. fetchRawFile used to
 * return undefined both when a policy file was absent and when the fetch
 * failed, so friction could not tell "repo has no policy" from "policy
 * fetch failed". These tests pin the three states (read / absent /
 * error) through the HouseRuleDeps seams, through fetchRawFileDetailed
 * itself (raw host and contents-API modes), and through the on-disk
 * cache (pre-v0.19.0 entries must count as a miss).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  fetchPolicySources,
  fetchPolicySourcesWithProvenance,
  fetchHouseRulesDetailed,
  fetchOrgAiPolicyDetailed,
  fetchRawFileDetailed,
  cacheSet,
  setFetchImpl,
} from "../src/github.js";
import type { PolicySourceProvenance } from "../src/types.js";

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["GREENLIGHT_GITHUB_BASE_URL", "GITHUB_TOKEN", "GH_TOKEN"]) {
    savedEnv[k] = process.env[k];
  }
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setFetchImpl(null);
});

const entryFor = (prov: PolicySourceProvenance[], file: string) =>
  prov.find((p) => p.file === file);

describe("policy-source provenance via the deps seams", () => {
  const absentOrg = async () => undefined;

  it("read state: a present file surfaces as read with its path", async () => {
    const { sources, provenance } = await fetchPolicySourcesWithProvenance("acme", "widget", {
      fetchRaw: async (file: string) => (file === "CONTRIBUTING.md" ? "# rules\n" : undefined),
      fetchOrgPolicy: absentOrg,
    });
    assert.deepEqual(sources, [{ file: "CONTRIBUTING.md", text: "# rules\n" }]);
    assert.deepEqual(entryFor(provenance, "CONTRIBUTING.md"), {
      file: "CONTRIBUTING.md",
      scope: "repo",
      status: "read",
    });
    // One entry per basename probed, plus the org entry.
    const repoEntries = provenance.filter((p) => p.scope === "repo");
    assert.equal(repoEntries.length, 5);
    assert.equal(provenance.length, 6);
  });

  it("absent state: every location missed yields absent with the first candidate path", async () => {
    const { sources, provenance } = await fetchPolicySourcesWithProvenance("acme", "widget", {
      fetchRaw: async () => undefined,
      fetchOrgPolicy: absentOrg,
    });
    assert.deepEqual(sources, []);
    for (const file of ["CONTRIBUTING.md", "docs/development/contributing.mdx", "AGENTS.md", "CLAUDE.md", "AI_POLICY.md"]) {
      assert.deepEqual(entryFor(provenance, file), { file, scope: "repo", status: "absent" }, file);
    }
  });

  it("error state: a throwing fetchRaw surfaces as error with a kind, never absent", async () => {
    const { provenance } = await fetchPolicySourcesWithProvenance("acme", "widget", {
      fetchRaw: async (file: string) => {
        if (file === "AGENTS.md") throw new Error("HTTP 500");
        return undefined;
      },
      fetchOrgPolicy: absentOrg,
    });
    const e = entryFor(provenance, "AGENTS.md");
    assert.ok(e, "AGENTS.md entry present");
    assert.equal(e.status, "error");
    assert.equal(e.error, "HTTP 500");
    assert.equal(e.scope, "repo");
  });

  it("read wins when an early location errors but a later one reads", async () => {
    const { sources, provenance } = await fetchPolicySourcesWithProvenance("acme", "widget", {
      fetchRaw: async (file: string) => {
        if (file === "AGENTS.md") throw new Error("HTTP 500");
        if (file === ".github/AGENTS.md") return "agents text";
        return undefined;
      },
      fetchOrgPolicy: absentOrg,
    });
    assert.deepEqual(sources, [{ file: ".github/AGENTS.md", text: "agents text" }]);
    assert.deepEqual(entryFor(provenance, ".github/AGENTS.md"), {
      file: ".github/AGENTS.md",
      scope: "repo",
      status: "read",
    });
    assert.equal(provenance.filter((p) => p.status === "error").length, 0);
  });

  it("all locations erroring reports the first error kind", async () => {
    const { provenance } = await fetchPolicySourcesWithProvenance("acme", "widget", {
      fetchRaw: async (file: string) => {
        if (file === "AGENTS.md") throw new Error("boom-a");
        if (file === ".github/AGENTS.md") throw new Error("boom-b");
        if (file === "docs/AGENTS.md") throw new Error("boom-c");
        return undefined;
      },
      fetchOrgPolicy: absentOrg,
    });
    const e = entryFor(provenance, "AGENTS.md");
    assert.ok(e);
    assert.equal(e.status, "error");
    assert.equal(e.error, "boom-a");
  });

  it("org source read: the org AI policy is a read org entry and a source", async () => {
    const { sources, provenance } = await fetchPolicySourcesWithProvenance("acme", "widget", {
      fetchRaw: async () => undefined,
      fetchOrgPolicy: async () => "org policy text",
    });
    assert.deepEqual(sources, [{ file: "AI_POLICY.md (org acme)", text: "org policy text" }]);
    assert.deepEqual(entryFor(provenance, "AI_POLICY.md (org acme)"), {
      file: "AI_POLICY.md (org acme)",
      scope: "org",
      status: "read",
    });
  });

  it("org source absent: no org policy file is an absent org entry", async () => {
    const { sources, provenance } = await fetchPolicySourcesWithProvenance("acme", "widget", {
      fetchRaw: async () => undefined,
      fetchOrgPolicy: absentOrg,
    });
    assert.deepEqual(sources, []);
    assert.deepEqual(entryFor(provenance, "AI_POLICY.md (org acme)"), {
      file: "AI_POLICY.md (org acme)",
      scope: "org",
      status: "absent",
    });
  });

  it("org source error: a throwing org fetch is an error entry, not absent", async () => {
    const { provenance } = await fetchPolicySourcesWithProvenance("acme", "widget", {
      fetchRaw: async () => undefined,
      fetchOrgPolicy: async () => {
        throw new Error("HTTP 503");
      },
    });
    const e = entryFor(provenance, "AI_POLICY.md (org acme)");
    assert.ok(e);
    assert.equal(e.status, "error");
    assert.equal(e.error, "HTTP 503");
    assert.equal(e.scope, "org");
  });

  it("fetchPolicySources delegates and returns the same sources as before", async () => {
    const deps = {
      fetchRaw: async (file: string) => (file === "AGENTS.md" ? "agents" : undefined),
      fetchOrgPolicy: async () => "org text",
    };
    const plain = await fetchPolicySources("acme", "widget", deps);
    const { sources } = await fetchPolicySourcesWithProvenance("acme", "widget", deps);
    assert.deepEqual(plain, [
      { file: "AGENTS.md", text: "agents" },
      { file: "AI_POLICY.md (org acme)", text: "org text" },
    ]);
    assert.deepEqual(plain, sources);
  });
});

describe("fetchRawFileDetailed outcome mapping", () => {
  it("raw host mode: 200 reads, 404 is absent, 500 is an http error, a throw keeps its message", async () => {
    setFetchImpl((async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/ok.md")) return new Response("hello", { status: 200 });
      if (u.pathname.endsWith("/missing.md")) return new Response("nope", { status: 404 });
      if (u.pathname.endsWith("/broken.md")) return new Response("boom", { status: 500 });
      throw new Error("socket hangup");
    }) as typeof fetch);
    const headers = { "User-Agent": "greenlight-cli" };
    assert.deepEqual(await fetchRawFileDetailed("o", "r", "ok.md", headers), { status: "read", text: "hello" });
    assert.deepEqual(await fetchRawFileDetailed("o", "r", "missing.md", headers), { status: "absent" });
    assert.deepEqual(await fetchRawFileDetailed("o", "r", "broken.md", headers), {
      status: "error",
      error: "http 500",
    });
    const thrown = await fetchRawFileDetailed("o", "r", "weird.md", headers);
    assert.equal(thrown.status, "error");
    if (thrown.status === "error") assert.equal(thrown.error, "socket hangup");
  });

  it("contents-API mode: base64 reads, 404 is absent, a 500 is an error (not absent)", async () => {
    process.env.GREENLIGHT_GITHUB_BASE_URL = "http://127.0.0.1:9";
    setFetchImpl((async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/contents/ok.md")) {
        return new Response(
          JSON.stringify({ content: Buffer.from("hello", "utf8").toString("base64"), encoding: "base64" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (u.pathname.endsWith("/contents/missing.md")) return new Response("{}", { status: 404 });
      return new Response("server error", { status: 500 });
    }) as typeof fetch);
    const headers = { "User-Agent": "greenlight-cli" };
    assert.deepEqual(await fetchRawFileDetailed("o", "r", "ok.md", headers), { status: "read", text: "hello" });
    assert.deepEqual(await fetchRawFileDetailed("o", "r", "missing.md", headers), { status: "absent" });
    const broken = await fetchRawFileDetailed("o", "r", "broken.md", headers);
    assert.equal(broken.status, "error");
    if (broken.status === "error") assert.match(broken.error, /500/);
  });
});

describe("pre-v0.19.0 cache entries count as a miss", () => {
  const cacheFile = (kind: string, parts: string[]) =>
    join(homedir(), ".cache", "greenlight", `${kind}-${parts.join("-").replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);

  it("old-shape house-rules cache (a bare sources array) is re-fetched, not trusted", async () => {
    const owner = "prov-cache-o1";
    const repo = "prov-cache-r1";
    cacheSet("house-rules", [owner, repo], [{ file: "CONTRIBUTING.md", text: "stale cached text" }]);
    try {
      setFetchImpl((async () => new Response("nope", { status: 404 })) as typeof fetch);
      const { sources, provenance } = await fetchHouseRulesDetailed(owner, repo);
      assert.deepEqual(sources, [], "the stale cache entry must not surface as a source");
      assert.ok(provenance.every((p) => p.status === "absent"), "everything re-probed as absent");
    } finally {
      if (existsSync(cacheFile("house-rules", [owner, repo]))) unlinkSync(cacheFile("house-rules", [owner, repo]));
    }
  });

  it("old-shape org-ai-policy cache (a bare string) is re-fetched, not trusted", async () => {
    const owner = "prov-cache-o2";
    cacheSet("org-ai-policy", [owner], "stale cached org text");
    try {
      setFetchImpl((async () => new Response("nope", { status: 404 })) as typeof fetch);
      const { outcome } = await fetchOrgAiPolicyDetailed(owner);
      assert.deepEqual(outcome, { status: "absent" });
    } finally {
      if (existsSync(cacheFile("org-ai-policy", [owner]))) unlinkSync(cacheFile("org-ai-policy", [owner]));
    }
  });
});
