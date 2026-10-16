/**
 * Tests for the contributor passport: Ledger payload normalization
 * (including drift), the honest 404 case, the honor record, and merged
 * PR counts. No live calls; everything is injected.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPassport, normalizeAccount, ledgerBaseUrl, type LedgerAccount } from "../src/passport.js";

function account(): LedgerAccount {
  return {
    login: "somebody",
    activeClaims: [
      { repo: "acme/widgets", issue: 7, url: "https://github.com/acme/widgets/issues/7", claimedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-08T00:00:00Z", state: "active", commentUrl: "https://github.com/acme/widgets/issues/7#issuecomment-1" },
      { repo: "acme/gadgets", issue: 3, url: "https://github.com/acme/gadgets/issues/3", claimedAt: "2026-09-01T00:00:00Z", expiresAt: "2026-09-08T00:00:00Z", state: "completed", commentUrl: null },
    ],
    queuedClaims: [
      { repo: "acme/widgets", issue: 9, url: "https://github.com/acme/widgets/issues/9", claimedAt: "2026-10-10T00:00:00Z", expiresAt: "2026-10-17T00:00:00Z", state: "active", commentUrl: null },
    ],
    completedCount: 4,
    expiredCount: 1,
    overCap: false,
  };
}

describe("buildPassport", () => {
  it("renders claims, queue, honor record, and merged PRs", async () => {
    const p = await buildPassport("somebody", {
      fetchAccount: async () => account(),
      fetchMergedCount: async () => 12,
    }, new Date("2026-10-16T12:00:00Z"));
    assert.equal(p.found, true);
    assert.equal(p.mergedPrs, 12);
    assert.equal(p.honorRatio, "4 completed vs 1 expired (80% completed)");
    assert.ok(p.markdown.includes("# Contributor passport: @somebody"));
    assert.ok(p.markdown.includes("acme/widgets#7"));
    assert.ok(p.markdown.includes("acme/widgets#9"));
    assert.ok(p.markdown.includes("https://github.com/acme/widgets/issues/7#issuecomment-1"));
    assert.ok(p.markdown.includes("Merged PRs: 12"));
    assert.ok(p.markdown.includes("Over the active-claim cap: no"));
  });

  it("the 404 case says so plainly and points at the first protocol claim", async () => {
    const p = await buildPassport("nobody-yet", {
      fetchAccount: async () => null,
      fetchMergedCount: async () => 0,
    });
    assert.equal(p.found, false);
    assert.ok(p.markdown.includes("No passport file for this account in the Claim Ledger yet"));
    assert.ok(p.markdown.includes("first protocol claim"));
  });

  it("a failed merged-count lookup is unknown, never zero", async () => {
    const p = await buildPassport("somebody", {
      fetchAccount: async () => account(),
      fetchMergedCount: async () => null,
    });
    assert.equal(p.mergedPrs, null);
    assert.ok(p.markdown.includes("unknown (lookup failed)"));
  });

  it("no history in the ledger is stated, not invented", async () => {
    const p = await buildPassport("fresh", {
      fetchAccount: async () => ({ ...account(), completedCount: null, expiredCount: null, activeClaims: [], queuedClaims: [] }),
      fetchMergedCount: async () => 0,
    });
    assert.ok(p.markdown.includes("no completed/expired history in the ledger yet"));
  });

  it("over-cap true is a squatting flag", async () => {
    const p = await buildPassport("greedy", {
      fetchAccount: async () => ({ ...account(), overCap: true }),
      fetchMergedCount: async () => 0,
    });
    assert.ok(p.markdown.includes("squatting flag"));
  });

  it("enriches minimal ledger claims with dates from the per-issue status file", async () => {
    const minimal = {
      login: "somebody",
      activeClaims: [{ repo: "acme/widgets", issue: 7, url: "https://github.com/acme/widgets/issues/7", claimedAt: "", expiresAt: "", state: "active", commentUrl: null }],
      queuedClaims: [],
      completedCount: null,
      expiredCount: null,
      overCap: false,
    };
    const p = await buildPassport("somebody", {
      fetchAccount: async () => minimal,
      fetchMergedCount: async () => 0,
      fetchClaimDetail: async () => ({ claimedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-08T00:00:00Z", commentUrl: null }),
    });
    assert.ok(p.markdown.includes("2026-10-01 -> 2026-10-08"));
  });

  it("a missing status file leaves the minimal claim line intact", async () => {
    const minimal = {
      login: "somebody",
      activeClaims: [{ repo: "acme/widgets", issue: 7, url: "https://github.com/acme/widgets/issues/7", claimedAt: "", expiresAt: "", state: "active", commentUrl: null }],
      queuedClaims: [],
      completedCount: null,
      expiredCount: null,
      overCap: false,
    };
    const p = await buildPassport("somebody", {
      fetchAccount: async () => minimal,
      fetchMergedCount: async () => 0,
      fetchClaimDetail: async () => null,
    });
    assert.ok(p.markdown.includes("acme/widgets#7 (active)"));
  });
});

describe("normalizeAccount", () => {
  it("tolerates camelCase ledger fields", () => {
    const a = normalizeAccount("x", {
      activeClaims: [{ repo: "o/r", issue: 1, claimedAt: "2026-01-01", expiresAt: "2026-01-08", state: "active", commentUrl: "u" }],
      completed_count: 2,
      over_cap: true,
    });
    assert.equal(a.activeClaims.length, 1);
    assert.equal(a.completedCount, 2);
    assert.equal(a.overCap, true);
  });

  it("garbage degrades to empties", () => {
    const a = normalizeAccount("x", null);
    assert.deepEqual(a.activeClaims, []);
    assert.equal(a.completedCount, null);
    const b = normalizeAccount("x", { active_claims: "not-an-array" });
    assert.deepEqual(b.activeClaims, []);
  });
});

describe("ledgerBaseUrl", () => {
  it("defaults to the public ledger and strips trailing slashes", () => {
    const prev = process.env["GREENLIGHT_LEDGER_URL"];
    delete process.env["GREENLIGHT_LEDGER_URL"];
    assert.equal(ledgerBaseUrl(), "https://cloudcorprecords.github.io/claim-ledger");
    process.env["GREENLIGHT_LEDGER_URL"] = "https://example.test/ledger/";
    assert.equal(ledgerBaseUrl(), "https://example.test/ledger");
    if (prev === undefined) delete process.env["GREENLIGHT_LEDGER_URL"];
    else process.env["GREENLIGHT_LEDGER_URL"] = prev;
  });
});
