/**
 * Tests for `greenlight claim --import`: the my-claims registry backfill
 * from the public Claim Ledger (fixture payload) and from manual URL
 * lists. Network is injected; nothing live.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importLedgerClaims,
  importUrlList,
  fetchLedgerRepos,
  fetchLedgerClaims,
  type ImportDeps,
} from "../src/claim-import.js";
import { loadRegistry } from "../src/claims-registry.js";

let registryPath: string;
beforeEach(() => {
  registryPath = join(mkdtempSync(join(tmpdir(), "gl-import-")), "my-claims.json");
});

function deps(): ImportDeps {
  const fetchJson = async (url: string): Promise<unknown> => {
    if (url.endsWith("/v1/index.json")) {
      return {
        repos: [
          { owner: "actualbudget", repo: "actual" },
          { owner: "mealie-recipes", repo: "mealie" },
        ],
      };
    }
    if (url.includes("/v1/repos/actualbudget/actual/claims.json")) {
      return {
        repo: "actualbudget/actual",
        active_claims: [
          { issue: 9230, issue_url: "https://github.com/actualbudget/actual/issues/9230", claimant: "CloudCorpRecords", state: "linked", queue: [] },
          { issue: 9246, issue_url: "https://github.com/actualbudget/actual/issues/9246", claimant: "CloudCorpRecords", state: "active", queue: [] },
          { issue: 9000, issue_url: "https://github.com/actualbudget/actual/issues/9000", claimant: "someone-else", state: "active", queue: [] },
          { issue: 8000, issue_url: "https://github.com/actualbudget/actual/issues/8000", claimant: "CloudCorpRecords", state: "completed", queue: [] },
          { issue: 7000, issue_url: "https://github.com/actualbudget/actual/issues/7000", claimant: "CloudCorpRecords", state: "expired", queue: [] },
        ],
      };
    }
    if (url.includes("/v1/repos/mealie-recipes/mealie/claims.json")) {
      return { repo: "mealie-recipes/mealie", active_claims: [] };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchJson };
}

describe("claim --import", () => {
  it("imports active and linked claims by the user, skips retired states and other claimants", async () => {
    const result = await importLedgerClaims(registryPath, "CloudCorpRecords", deps());
    assert.equal(result.added, 2);
    assert.equal(result.reposScanned, 2);
    const urls = loadRegistry(registryPath).claims.map((c) => c.issueUrl).sort();
    assert.deepEqual(urls, [
      "https://github.com/actualbudget/actual/issues/9230",
      "https://github.com/actualbudget/actual/issues/9246",
    ]);
    // Case-insensitive claimant match.
    const again = await importLedgerClaims(registryPath, "cloudcorprecords", deps());
    assert.equal(again.added, 0);
    assert.ok(again.skipped > 0);
  });

  it("survives one repo's file failing", async () => {
    const d = deps();
    const fetchJson = d.fetchJson!;
    const result = await importLedgerClaims(registryPath, "CloudCorpRecords", {
      fetchJson: async (url: string) => {
        if (url.includes("mealie")) throw new Error("boom");
        return fetchJson(url);
      },
    });
    assert.equal(result.added, 2);
    assert.equal(result.reposScanned, 2);
  });

  it("reads the index and per-repo shapes", async () => {
    const repos = await fetchLedgerRepos(deps());
    assert.deepEqual(repos, [
      { owner: "actualbudget", repo: "actual" },
      { owner: "mealie-recipes", repo: "mealie" },
    ]);
    const claims = await fetchLedgerClaims("actualbudget", "actual", deps());
    assert.equal(claims.length, 5);
    assert.equal(claims[0].state, "linked");
  });

  it("imports a manual URL list with dedupe and skips garbage", () => {
    const urls = [
      "https://github.com/acme/widgets/issues/42",
      "https://github.com/acme/widgets/issues/43",
      "not-a-url",
      "https://github.com/acme/widgets/issues/42",
      "",
    ];
    const first = importUrlList(registryPath, urls);
    assert.equal(first.added, 2);
    assert.equal(first.skipped, 3);
    const second = importUrlList(registryPath, urls);
    assert.equal(second.added, 0);
    assert.equal(second.skipped, 5);
    const stored = loadRegistry(registryPath).claims;
    assert.equal(stored.length, 2);
    assert.equal(stored[0].owner, "acme");
    assert.equal(stored[0].repo, "widgets");
  });
});
