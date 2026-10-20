import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scanCandidates,
  toScanCandidates,
  scanBudgetExceeded,
  DEFAULT_SCAN_MAX_TIME_SEC,
  type ScanCandidate,
} from "../src/github.js";

function cand(n: number): ScanCandidate {
  return {
    number: n,
    title: `issue ${n}`,
    url: `https://github.com/o/r/issues/${n}`,
    labels: [],
    updatedAt: "2026-10-14T00:00:00Z",
  };
}

describe("toScanCandidates", () => {
  it("drops pull requests and assigned issues", () => {
    const out = toScanCandidates([
      { number: 1, title: "real", html_url: "u1", labels: [], updated_at: "t", assignees: [] },
      { number: 2, title: "a pr", html_url: "u2", labels: [], updated_at: "t", pull_request: {} },
      { number: 3, title: "assigned", html_url: "u3", labels: [], updated_at: "t", assignees: [{ login: "x" }] },
    ]);
    assert.deepEqual(out.map((c) => c.number), [1]);
  });

  it("maps labels through", () => {
    const out = toScanCandidates([
      { number: 4, title: "labeled", html_url: "u4", labels: [{ name: "bug" }], updated_at: "t" },
    ]);
    assert.deepEqual(out[0].labels, ["bug"]);
  });
});

describe("scanCandidates", () => {
  it("uses the label pass when it finds issues (fallback never runs)", async () => {
    let recentCalled = 0;
    const res = await scanCandidates(
      "o",
      "r",
      {},
      {
        starter: async () => [cand(10), cand(11)],
        recent: async () => {
          recentCalled++;
          return [cand(99)];
        },
      }
    );
    assert.equal(res.fallbackUsed, false);
    assert.deepEqual(res.issues.map((c) => c.number), [10, 11]);
    assert.equal(recentCalled, 0);
  });

  it("engages the fallback when the label pass is empty", async () => {
    const res = await scanCandidates(
      "o",
      "r",
      {},
      {
        starter: async () => [],
        recent: async () => [cand(20), cand(21)],
      }
    );
    assert.equal(res.fallbackUsed, true);
    assert.deepEqual(res.issues.map((c) => c.number), [20, 21]);
  });

  it("--no-fallback (fallback: false) returns empty without calling the fallback", async () => {
    let recentCalled = 0;
    const res = await scanCandidates(
      "o",
      "r",
      { fallback: false },
      {
        starter: async () => [],
        recent: async () => {
          recentCalled++;
          return [cand(20)];
        },
      }
    );
    assert.equal(res.fallbackUsed, false);
    assert.deepEqual(res.issues, []);
    assert.equal(recentCalled, 0);
  });

  it("respects the limit on the fallback list", async () => {
    const many = Array.from({ length: 25 }, (_, i) => cand(100 + i));
    const res = await scanCandidates(
      "o",
      "r",
      { limit: 10 },
      { starter: async () => [], recent: async () => many }
    );
    assert.equal(res.issues.length, 10);
    assert.equal(res.issues[0].number, 100);
  });
});

describe("scan wall-time budget (v0.19.0, item 17)", () => {
  it("defaults the scan budget to 600 seconds", () => {
    assert.equal(DEFAULT_SCAN_MAX_TIME_SEC, 600);
  });

  it("scanBudgetExceeded is false before the budget and true at and past it", () => {
    const start = 1_000_000;
    assert.equal(scanBudgetExceeded(start, 600, start + 599_999), false);
    assert.equal(scanBudgetExceeded(start, 600, start + 600_000), true);
    assert.equal(scanBudgetExceeded(start, 600, start + 900_000), true);
  });

  it("scanBudgetExceeded measures from the recorded start, not from the epoch", () => {
    assert.equal(scanBudgetExceeded(5000, 10, 14_999), false);
    assert.equal(scanBudgetExceeded(5000, 10, 15_000), true);
  });
});
