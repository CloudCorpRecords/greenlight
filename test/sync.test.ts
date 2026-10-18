/**
 * Tests for `greenlight sync` (v0.10.0): the API census, tracker parsing,
 * drift computation, and the registry's known-PRs section.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFetchImpl } from "../src/github.js";
import {
  fetchAuthorCensus,
  computeDrift,
  parseTracker,
  upsertKnownPrs,
  formatSyncHuman,
  type CensusPr,
} from "../src/sync.js";
import {
  defaultRegistryPath,
  loadRegistry,
  registerClaim,
  saveRegistry,
  type ClaimsRegistryFile,
} from "../src/claims-registry.js";

const NOW = new Date("2026-10-18T12:00:00Z").getTime();

function mockSearch(itemsPages: Array<Array<Record<string, unknown>>>) {
  let calls = 0;
  const impl = (async (url: string) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get("page") ?? "1");
    const items = itemsPages[page - 1] ?? [];
    calls++;
    return new Response(JSON.stringify({ total_count: items.length, items }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  setFetchImpl(impl);
  return () => calls;
}

function prItem(owner: string, repo: string, number: number, state: "open" | "closed", mergedAt: string | null = null) {
  return {
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
    title: `Fix ${number}`,
    state,
    user: { login: "CloudCorpRecords" },
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
    pull_request: { merged_at: mergedAt },
  };
}

describe("fetchAuthorCensus", () => {
  afterEach(() => setFetchImpl(null));

  it("pages the search API and maps PR fields", async () => {
    const calls = mockSearch([
      [prItem("o", "a", 1, "open"), prItem("o", "b", 2, "closed", "2026-10-17T00:00:00Z")],
    ]);
    const prs = await fetchAuthorCensus("CloudCorpRecords", 100, 3);
    assert.equal(calls(), 1);
    assert.equal(prs.length, 2);
    assert.equal(prs[0].url, "https://github.com/o/a/pull/1");
    assert.equal(prs[0].state, "open");
    assert.equal(prs[0].merged, false);
    assert.equal(prs[1].state, "closed");
    assert.equal(prs[1].merged, true);
  });

  it("stops when a page is short and skips non-PR urls", async () => {
    mockSearch([
      [prItem("o", "a", 1, "open"), { html_url: "https://github.com/o/a/issues/9", title: "x", state: "open" }],
    ]);
    const prs = await fetchAuthorCensus("CloudCorpRecords", 100, 3);
    assert.equal(prs.length, 1, "issue URLs are not PRs");
  });
});

describe("upsertKnownPrs and computeDrift", () => {
  afterEach(() => setFetchImpl(null));
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gl-sync-home-"));
    process.env.GREENLIGHT_CLAIMS_FILE = join(home, "my-claims.json");
  });
  afterEach(() => {
    delete process.env.GREENLIGHT_CLAIMS_FILE;
  });

  it("records unknown PRs and upserts them on --write", async () => {
    const census: CensusPr[] = [
      { owner: "o", repo: "a", number: 1, url: "https://github.com/o/a/pull/1", title: "Fix 1", state: "open", merged: false, author: "CloudCorpRecords", createdAt: "", updatedAt: "" },
    ];
    const reg = loadRegistry(defaultRegistryPath());
    const drift = computeDrift(census, reg, null, 7, NOW);
    assert.equal(drift.unknownPrs.length, 1);
    assert.equal(drift.unknownPrs[0].url, "https://github.com/o/a/pull/1");
    const wrote = upsertKnownPrs(defaultRegistryPath(), census, new Date(NOW).toISOString());
    assert.deepEqual(wrote, { added: 1, updated: 0 });
    const drift2 = computeDrift(census, loadRegistry(defaultRegistryPath()), null, 7, NOW);
    assert.equal(drift2.unknownPrs.length, 0, "written PRs are no longer drift");
  });

  it("flags state mismatches between the registry and API truth", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-sync-"));
    const path = join(dir, "my-claims.json");
    saveRegistry(path, {
      version: 1,
      claims: [],
      prs: [
        {
          prUrl: "https://github.com/o/a/pull/1",
          owner: "o", repo: "a", number: 1, state: "open", merged: false,
          title: "Fix 1", firstSeen: "2026-10-10T00:00:00Z", lastSeen: "2026-10-10T00:00:00Z",
          source: "census",
        },
      ],
    });
    const census: CensusPr[] = [
      { owner: "o", repo: "a", number: 1, url: "https://github.com/o/a/pull/1", title: "Fix 1", state: "closed", merged: true, author: "CloudCorpRecords", createdAt: "", updatedAt: "" },
    ];
    const drift = computeDrift(census, loadRegistry(path), null, 7, NOW);
    assert.equal(drift.stateMismatches.length, 1);
    assert.match(drift.stateMismatches[0].detail, /API says "merged"/);
    assert.equal(drift.unknownPrs.length, 0, "a known PR is not unknown");
  });

  it("flags stale claims with no linked PR", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-sync-"));
    const path = join(dir, "my-claims.json");
    registerClaim(path, {
      issueUrl: "https://github.com/o/a/issues/9",
      owner: "o", repo: "a", number: 9,
      postedAt: "2026-09-01T00:00:00Z",
    });
    registerClaim(path, {
      issueUrl: "https://github.com/o/a/issues/10",
      owner: "o", repo: "a", number: 10,
      postedAt: "2026-10-17T00:00:00Z",
      prUrl: "https://github.com/o/a/pull/10",
    });
    const drift = computeDrift([], loadRegistry(path), null, 7, NOW);
    assert.equal(drift.staleClaims.length, 1);
    assert.equal(drift.staleClaims[0].number, 9);
  });

  it("a claim whose PR is in the census is not unknown drift", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-sync-"));
    const path = join(dir, "my-claims.json");
    registerClaim(path, {
      issueUrl: "https://github.com/o/a/issues/9",
      owner: "o", repo: "a", number: 9,
      postedAt: "2026-10-17T00:00:00Z",
      prUrl: "https://github.com/o/a/pull/9",
    });
    const census: CensusPr[] = [
      { owner: "o", repo: "a", number: 9, url: "https://github.com/o/a/pull/9", title: "Fix 9", state: "open", merged: false, author: "CloudCorpRecords", createdAt: "", updatedAt: "" },
    ];
    const drift = computeDrift(census, loadRegistry(path), null, 7, NOW);
    assert.equal(drift.unknownPrs.length, 0);
  });
});

describe("parseTracker", () => {
  it("parses CSV with header aliases", () => {
    const rows = parseTracker(
      "repo,issue,pr_url,status\nacme/widgets,65,https://github.com/acme/widgets/pull/70,PR OPEN\n",
      "csv"
    );
    assert.deepEqual(rows, [
      { repo: "acme/widgets", issue: "65", prUrl: "https://github.com/acme/widgets/pull/70", status: "PR OPEN" },
    ]);
  });

  it("parses JSON arrays with tolerant keys", () => {
    const rows = parseTracker(
      JSON.stringify([{ repo: "acme/widgets", number: "65", pr: "https://github.com/acme/widgets/pull/70", state: "merged" }]),
      "json"
    );
    assert.deepEqual(rows, [
      { repo: "acme/widgets", issue: "65", prUrl: "https://github.com/acme/widgets/pull/70", status: "merged" },
    ]);
  });

  it("diffs tracker state against the census", () => {
    const census: CensusPr[] = [
      { owner: "acme", repo: "widgets", number: 70, url: "https://github.com/acme/widgets/pull/70", title: "x", state: "closed", merged: true, author: "CloudCorpRecords", createdAt: "", updatedAt: "" },
    ];
    const drift = computeDrift(
      census,
      { version: 1, claims: [] },
      [{ repo: "acme/widgets", issue: "65", prUrl: "https://github.com/acme/widgets/pull/70", status: "PR OPEN" }],
      7,
      NOW
    );
    assert.equal(drift.stateMismatches.length, 1);
    assert.match(drift.stateMismatches[0].detail, /tracker says "PR OPEN"/);
  });

  it("renders a human drift report", () => {
    const drift = computeDrift(
      [{ owner: "o", repo: "a", number: 1, url: "https://github.com/o/a/pull/1", title: "Fix 1", state: "open", merged: false, author: "CloudCorpRecords", createdAt: "", updatedAt: "" }],
      { version: 1, claims: [] },
      null,
      7,
      NOW
    );
    const text = formatSyncHuman(drift, "CloudCorpRecords");
    assert.match(text, /1 drift item/);
    assert.match(text, /PRs the registry does not know/);
    assert.match(text, /o\/a#1/);
  });
});
