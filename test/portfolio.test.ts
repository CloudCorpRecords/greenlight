/**
 * Tests for `greenlight portfolio` (v0.10.0): claim bucketing, the pending
 * queue, and the one-screen summary.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bucketClaims,
  buildPortfolio,
  formatPortfolioHuman,
  pendingQueue,
  type Portfolio,
} from "../src/portfolio.js";
import type { ClaimsRegistryFile } from "../src/claims-registry.js";
import type { PostingLedger } from "../src/posting-ledger.js";
import type { CensusPr, SyncDrift } from "../src/sync.js";

const NOW = new Date("2026-10-18T12:00:00Z").getTime();

function claims(): ClaimsRegistryFile["claims"] {
  return [
    {
      issueUrl: "https://github.com/o/a/issues/1", owner: "o", repo: "a", number: 1,
      postedAt: "2026-10-17T00:00:00Z", prUrl: "https://github.com/o/a/pull/10",
    },
    {
      issueUrl: "https://github.com/o/a/issues/2", owner: "o", repo: "a", number: 2,
      postedAt: "2026-09-01T00:00:00Z",
    },
    {
      issueUrl: "https://github.com/o/a/issues/3", owner: "o", repo: "a", number: 3,
      postedAt: "2026-10-17T12:00:00Z",
    },
  ];
}

function census(): CensusPr[] {
  return [
    { owner: "o", repo: "a", number: 10, url: "https://github.com/o/a/pull/10", title: "x", state: "open", merged: false, author: "me", createdAt: "", updatedAt: "" },
    { owner: "o", repo: "a", number: 11, url: "https://github.com/o/a/pull/11", title: "y", state: "closed", merged: true, author: "me", createdAt: "", updatedAt: "" },
  ];
}

function drift(): SyncDrift {
  return {
    unknownPrs: [{ kind: "unknown-pr", repo: "o/a", number: 11, url: "https://github.com/o/a/pull/11", detail: "closed (merged): y" }],
    stateMismatches: [],
    staleClaims: [{ kind: "stale-claim", repo: "o/a", number: 2, url: "https://github.com/o/a/issues/2", detail: "claimed 47d ago, no linked PR" }],
    counts: { census: 2, open: 1, merged: 1, closedUnmerged: 0, registryClaims: 3, knownPrs: 2, trackerRows: null },
  };
}

function ledger(): PostingLedger {
  return {
    v: 1,
    entries: [
      { ts: "2026-10-18T11:00:00Z", kind: "claim", targetUrl: "https://github.com/o/a/issues/4", outcome: "unconfirmed", agent: "worker-a" },
      { ts: "2026-10-18T10:00:00Z", kind: "claim", targetUrl: "https://github.com/o/a/issues/5", outcome: "confirmed", agent: "worker-b" },
    ],
  };
}

describe("portfolio", () => {
  it("buckets claims into linked, active, and unlinked-stale", () => {
    const b = bucketClaims(claims(), 7, NOW);
    assert.deepEqual(b, { linked: 1, unlinkedStale: 1, active: 1 });
  });

  it("the pending queue surfaces unconfirmed posts with their agent", () => {
    const q = pendingQueue({ version: 1, claims: claims() }, ledger());
    assert.equal(q.unconfirmedPosts.length, 1);
    assert.equal(q.unconfirmedPosts[0].agent, "worker-a");
    assert.equal(q.unlinkedClaims.length, 2);
  });

  it("renders the one-screen summary", () => {
    const p: Portfolio = buildPortfolio({
      author: "me",
      census: census(),
      registry: { version: 1, claims: claims(), prs: [] },
      ledger: ledger(),
      drift: drift(),
      staleDays: 7,
      nowMs: NOW,
    });
    assert.equal(p.census.total, 2);
    assert.equal(p.census.merged, 1);
    assert.equal(p.drift.total, 2);
    const text = formatPortfolioHuman(p);
    assert.match(text, /\*\*portfolio: me\*\*/);
    assert.match(text, /PRs: 2 total \(1 open, 1 merged, 0 closed unmerged\)/);
    assert.match(text, /Drift: 2 items/);
    assert.match(text, /Pending posts \(1\)/);
    assert.match(text, /agent worker-a/);
    assert.match(text, /Unlinked claims \(2\)/);
  });
});
