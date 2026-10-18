/**
 * Tests for `greenlight preflight` (v0.10.1): the reads-only go/no-go
 * check that surfaces structural dead ends before a build starts.
 * Fixtures reproduce the F2 (actual 422, ts-sdk 404) and F3 (drifted
 * file) failures from 2026-10-18.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFetchImpl } from "../src/github.js";
import { runPreflight } from "../src/preflight.js";

const AT = "2026-10-18T14:00:00.000Z";

let dir: string;
let ledger: string;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pre-"));
  ledger = join(dir, "capabilities.json");
  // Force the proxy code path for raw policy-file reads so the mocked
  // fetch (not the real network) serves them.
  for (const k of ["GREENLIGHT_GITHUB_BASE_URL", "GITHUB_TOKEN", "HOME"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.GREENLIGHT_GITHUB_BASE_URL = "http://127.0.0.1:9";
  delete process.env.GITHUB_TOKEN;
  process.env.HOME = dir; // isolate the file-backed caches
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setFetchImpl(null);
});

function seed(entries: Array<Record<string, unknown>>): void {
  writeFileSync(ledger, JSON.stringify({ entries }), "utf8");
}

/** Route GitHub API paths to canned responses; unmatched paths 404. */
function mockGithub(routes: Array<{ match: (p: string, s: string) => boolean; status: number; body: unknown }>) {
  const impl = (async (url: string) => {
    const u = new URL(url);
    for (const r of routes) {
      if (r.match(u.pathname, u.search)) {
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  setFetchImpl(impl);
}

/** The healthy-fork fixture: /user and a fork with the right parent. */
function forkRoutes(owner: string, repo: string) {
  return [
    { match: (p: string) => p === "/user", status: 200, body: { login: "CloudCorpRecords" } },
    {
      match: (p: string) => p === `/repos/CloudCorpRecords/${repo}`,
      status: 200,
      body: { fork: true, parent: { full_name: `${owner}/${repo}` } },
    },
  ];
}

describe("runPreflight", () => {
  it("reports KNOWN-BLOCKED for actualbudget/actual (the F2 422 case)", async () => {
    seed([
      {
        repo: "actualbudget/actual",
        action: "pr_create",
        outcome: "blocked-422",
        evidence: 'PR creation failed: GitHub API 422 for /repos/actualbudget/actual/pulls: Validation Failed: user is blocked (2026-10-18)',
        at: AT,
      },
    ]);
    mockGithub(forkRoutes("actualbudget", "actual"));
    const r = await runPreflight({ owner: "actualbudget", repo: "actual", capabilitiesPath: ledger });
    assert.equal(r.verdict, "NO-GO");
    assert.equal(r.capability.verdict, "KNOWN-BLOCKED");
    assert.match(r.capability.detail, /blocked-422/);
    assert.match(r.capability.detail, /user is blocked/);
  });

  it("reports KNOWN-BLOCKED for modelcontextprotocol/typescript-sdk (the F2 404 case)", async () => {
    seed([
      {
        repo: "modelcontextprotocol/typescript-sdk",
        action: "pr_create",
        outcome: "blocked-404",
        evidence: "PR creation failed: GitHub API 404 for /repos/modelcontextprotocol/typescript-sdk/pulls (2026-10-18, fork verified valid)",
        at: AT,
      },
    ]);
    mockGithub(forkRoutes("modelcontextprotocol", "typescript-sdk"));
    const r = await runPreflight({
      owner: "modelcontextprotocol",
      repo: "typescript-sdk",
      capabilitiesPath: ledger,
    });
    assert.equal(r.verdict, "NO-GO");
    assert.equal(r.capability.verdict, "KNOWN-BLOCKED");
    assert.match(r.capability.detail, /blocked-404/);
    assert.match(r.reasons.join(" "), /blocked-404/);
  });

  it("flags a drifted file (the F3 case)", async () => {
    seed([]);
    const owner = "actualbudget";
    const repo = "actual";
    mockGithub([
      ...forkRoutes(owner, repo),
      { match: (p: string) => p === `/repos/${owner}/${repo}`, status: 200, body: { default_branch: "main" } },
      {
        match: (p: string) => p === `/repos/${owner}/${repo}/git/ref/heads/main`,
        status: 200,
        body: { object: { sha: "headsha" } },
      },
      {
        match: (p: string, s: string) => p === `/repos/${owner}/${repo}/contents/packages/app.ts` && s.includes("ref=base1"),
        status: 200,
        body: { sha: "blob-base", type: "file" },
      },
      {
        match: (p: string, s: string) => p === `/repos/${owner}/${repo}/contents/packages/app.ts` && s.includes("ref=headsha"),
        status: 200,
        body: { sha: "blob-head", type: "file" },
      },
      {
        match: (p: string) => p === `/repos/${owner}/${repo}/contents/packages/other.ts`,
        status: 200,
        body: { sha: "blob-same", type: "file" },
      },
    ]);
    const r = await runPreflight({
      owner,
      repo,
      base: "base1",
      files: ["packages/app.ts", "packages/other.ts"],
      capabilitiesPath: ledger,
    });
    assert.ok(r.drift);
    const drifted = r.drift!.find((d) => d.path === "packages/app.ts");
    const clean = r.drift!.find((d) => d.path === "packages/other.ts");
    assert.equal(drifted?.status, "DRIFTED");
    assert.equal(clean?.status, "CLEAN");
    assert.equal(r.verdict, "NO-GO");
    assert.match(r.reasons.join(" "), /packages\/app\.ts/);
  });

  it("returns GO for a clean repo with no recorded block", async () => {
    seed([]);
    mockGithub(forkRoutes("acme", "widgets"));
    const r = await runPreflight({ owner: "acme", repo: "widgets", capabilitiesPath: ledger });
    assert.equal(r.fork.ok, true);
    assert.equal(r.capability.verdict, "NO-RECORD");
    assert.equal(r.verdict, "GO");
  });

  it("is NO-GO when the fork is missing", async () => {
    seed([]);
    mockGithub([
      { match: (p: string) => p === "/user", status: 200, body: { login: "CloudCorpRecords" } },
      // /repos/CloudCorpRecords/widgets falls through to the 404 default
    ]);
    const r = await runPreflight({ owner: "acme", repo: "widgets", capabilitiesPath: ledger });
    assert.equal(r.fork.ok, false);
    assert.equal(r.verdict, "NO-GO");
    assert.match(r.reasons.join(" "), /no fork/);
  });
});
