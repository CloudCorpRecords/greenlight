import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeMergeVelocityStats,
  describeMergeVelocity,
  fetchMergeVelocity,
  type MergedPRRow,
} from "../src/merge-velocity.js";

const row = (assoc: string, created: string, mergedAt: string | null): MergedPRRow => ({
  authorAssociation: assoc,
  createdAt: created,
  mergedAt,
});

const H = 3600000;
const D = 24 * H;

function ts(days: number): string {
  return new Date(Date.UTC(2026, 9, 1) + days * D).toISOString();
}

describe("computeMergeVelocityStats", () => {
  it("computes external share and median merge days", () => {
    const stats = computeMergeVelocityStats([
      row("NONE", ts(0), ts(2)), // external, 2d
      row("CONTRIBUTOR", ts(0), ts(4)), // external, 4d
      row("MEMBER", ts(0), ts(1)), // internal, 1d
      row("OWNER", ts(0), ts(6)), // internal, 6d
      row("FIRST_TIME_CONTRIBUTOR", ts(0), ts(3)), // external, 3d
      row("NONE", ts(0), null), // closed unmerged: excluded
    ]);
    assert.ok(stats);
    assert.equal(stats.mergedPRs, 5);
    assert.equal(stats.externalShare, 0.6);
    // median of [1,2,3,4,6] = 3
    assert.equal(stats.medianMergeDays, 3);
  });

  it("returns null when nothing merged", () => {
    assert.equal(computeMergeVelocityStats([row("NONE", ts(0), null)]), null);
    assert.equal(computeMergeVelocityStats([]), null);
  });

  it("produces the one-line signal summary", () => {
    assert.equal(
      describeMergeVelocity({ mergedPRs: 25, externalShare: 0.4, medianMergeDays: 2.1 }),
      "external merge share 40%, median merge 2.1d (25 merged PRs)"
    );
  });
});

describe("fetchMergeVelocity", () => {
  it("uses the injected rows without touching the network", async () => {
    let called = false;
    const stats = await fetchMergeVelocity("acme", "widget", {
      listClosedPulls: async () => {
        called = true;
        return [row("NONE", ts(0), ts(2)), row("MEMBER", ts(0), ts(2))];
      },
    });
    assert.equal(called, true);
    assert.ok(stats);
    assert.equal(stats.externalShare, 0.5);
    assert.equal(stats.medianMergeDays, 2);
  });
});
