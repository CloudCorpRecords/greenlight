/**
 * Wave shortlist (v0.16.0): fixture-driven tests for the index filter
 * and the runWave pipeline (CLEAR ranked, TAKEN with reason, behavioral
 * gate exclusion, own-PR skip, budget-stop partial output).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runWave,
  filterWaveRepos,
  DEFAULT_WAVE_FILTERS,
  type PolicyIndexEntry,
  type WaveDeps,
  type WaveFilters,
} from "../src/wave.js";
import type { XrayResult } from "../src/xray.js";
import type { BehavioralGate } from "../src/behavior.js";

const filters: WaveFilters = { ...DEFAULT_WAVE_FILTERS };

const entry = (
  repo: string,
  overrides: Partial<PolicyIndexEntry> = {}
): PolicyIndexEntry => ({
  repo,
  url: `https://github.com/${repo}`,
  policy_classes: ["open"],
  stars: 5000,
  good_first_issues: 3,
  outsider_merge_share: 80,
  ...overrides,
});

const noGate: BehavioralGate = {
  detected: false,
  strength: 0,
  threshold: 2,
  evidence: [],
  notes: [],
  note: "no maintainer AI-rejection evidence found on recent closed-unmerged PRs",
};

const detectedGate: BehavioralGate = {
  detected: true,
  strength: 2,
  threshold: 2,
  evidence: [
    { pr: 7, author: "maintainer", quote: "AI slop. Closing.", url: "https://github.com/o/gated/pull/7", strong: true },
  ],
  notes: [],
  note: "maintainer rejects AI-built PRs in practice",
};

function xray(verdict: XrayResult["verdict"], extra: Partial<XrayResult> = {}): XrayResult {
  return {
    owner: "o",
    repo: "r",
    number: 1,
    url: "https://github.com/o/r/issues/1",
    title: "issue",
    verdict,
    reasons: [`verdict ${verdict}`],
    flags: [],
    linkedPRs: [],
    claimFlags: [],
    deepVerified: true,
    apiCalls: 4,
    ...extra,
  };
}

/** Fixture deps: behavior is driven by maps so every path is explicit. */
function fixtureDeps(opts: {
  starters?: Record<string, Array<{ number: number; title: string; url: string }>>;
  xrays?: Record<string, XrayResult>;
  gates?: Record<string, BehavioralGate>;
  ownPrs?: string[];
  budget?: number;
} = {}): WaveDeps {
  let budget = opts.budget ?? 5000;
  return {
    async getLogin() {
      return "me";
    },
    async ownOpenPrRepos() {
      return new Set((opts.ownPrs ?? []).map((r) => r.toLowerCase()));
    },
    async starterIssues(owner: string, repo: string, limit: number) {
      const key = `${owner}/${repo}`;
      return (opts.starters?.[key] ?? []).slice(0, limit);
    },
    async xray(owner: string, repo: string, number: number) {
      const xr = opts.xrays?.[`${owner}/${repo}#${number}`];
      if (!xr) throw new Error(`no fixture xray for ${owner}/${repo}#${number}`);
      return xr;
    },
    async behavioral(owner: string, repo: string) {
      return opts.gates?.[`${owner}/${repo}`] ?? noGate;
    },
    async remainingBudget() {
      return budget;
    },
  };
}

describe("filterWaveRepos", () => {
  it("keeps pure-open repos in the band and drops the rest", () => {
    const index = [
      entry("o/clear", { stars: 9000 }),
      entry("o/mega", { stars: 200000 }),
      entry("o/tiny", { stars: 50 }),
      entry("o/lowshare", { outsider_merge_share: 10 }),
      entry("o/nostarter", { good_first_issues: 0 }),
      entry("o/discussion", { policy_classes: ["open", "discussion_first"] }),
      entry("o/nostars", { stars: null }),
    ];
    const kept = filterWaveRepos(index, filters).map((e) => e.repo);
    assert.deepEqual(kept, ["o/clear"]);
  });

  it("orders by stars descending and caps at maxRepos", () => {
    const index = [entry("o/a", { stars: 2000 }), entry("o/b", { stars: 9000 }), entry("o/c", { stars: 4000 })];
    const kept = filterWaveRepos(index, { ...filters, maxRepos: 2 }).map((e) => e.repo);
    assert.deepEqual(kept, ["o/b", "o/c"]);
  });
});

describe("runWave", () => {
  it("ranks a CLEAR issue, names TAKEN reasons, excludes behavioral gates and own-PR repos", async () => {
    const index = [
      entry("o/clear-repo", { stars: 9000 }),
      entry("o/taken-repo", { stars: 8000 }),
      entry("o/gated-repo", { stars: 7000 }),
      entry("o/mine-repo", { stars: 6000 }),
    ];
    const starters = (repo: string, n: number) => ({
      [repo]: [{ number: n, title: `fix ${repo}`, url: `https://github.com/${repo}/issues/${n}` }],
    });
    const result = await runWave(
      index,
      filters,
      fixtureDeps({
        starters: {
          ...starters("o/clear-repo", 101),
          ...starters("o/taken-repo", 201),
          ...starters("o/gated-repo", 301),
        },
        xrays: {
          "o/clear-repo#101": xray("GO", { number: 101 }),
          "o/taken-repo#201": xray("TAKEN", {
            number: 201,
            reasons: ["open PR #55 closes this issue"],
            linkedPRs: [
              {
                number: 55,
                state: "open",
                title: "fix",
                url: "https://github.com/o/taken-repo/pull/55",
                linkStrength: "closing",
                author: "other",
                reporterOwned: false,
              },
            ],
          }),
          "o/gated-repo#301": xray("GO", { number: 301 }),
        },
        gates: { "o/gated-repo": detectedGate },
        ownPrs: ["o/mine-repo"],
      })
    );

    assert.equal(result.partial, false);
    // CLEAR first in the queue.
    assert.equal(result.queue.length, 1);
    assert.equal(result.queue[0].repo, "o/clear-repo");
    assert.equal(result.queue[0].number, 101);
    assert.equal(result.queue[0].verdict, "CLEAR");
    // TAKEN stays on its repo entry with the competing PR named.
    const taken = result.repos.find((r) => r.repo === "o/taken-repo");
    assert.ok(taken && !taken.excluded);
    const takenIssue = taken.issues[0];
    assert.equal(takenIssue.verdict, "TAKEN");
    assert.equal(takenIssue.competingPRs.length, 1);
    assert.equal(takenIssue.competingPRs[0].number, 55);
    // Behavioral gate exclusion names the reason.
    const gated = result.repos.find((r) => r.repo === "o/gated-repo");
    assert.ok(gated?.excluded?.includes("behavioral gate"));
    assert.equal(gated.issues.length, 0);
    // Own-PR repo skipped.
    const mine = result.repos.find((r) => r.repo === "o/mine-repo");
    assert.ok(mine?.excluded?.includes("already have an open PR"));
  });

  it("marks repos with no starter issues as skipped", async () => {
    const result = await runWave(
      [entry("o/empty", { stars: 9000 })],
      filters,
      fixtureDeps({})
    );
    assert.equal(result.partial, false);
    assert.equal(result.queue.length, 0);
    assert.ok(result.repos[0].excluded?.includes("no starter issues"));
  });

  it("stops with partial output when the budget is under the floor at start", async () => {
    const result = await runWave(
      [entry("o/clear", { stars: 9000 })],
      filters,
      fixtureDeps({ budget: 0 })
    );
    assert.equal(result.partial, true);
    assert.ok(result.partialReason?.includes("floor"));
    assert.equal(result.queue.length, 0);
  });

  it("stops with partial output when the budget drops mid-run", async () => {
    const index = [entry("o/one", { stars: 9000 }), entry("o/two", { stars: 8000 })];
    const deps = fixtureDeps({
      starters: { "o/one": [{ number: 1, title: "t", url: "u" }] },
      xrays: { "o/one#1": xray("GO", { number: 1 }) },
    });
    // First two budget reads are healthy (start + first repo); then drained.
    let calls = 0;
    deps.remainingBudget = async () => {
      calls++;
      return calls <= 2 ? 5000 : 0;
    };
    const result = await runWave(index, filters, deps);
    assert.equal(result.partial, true);
    assert.ok(result.partialReason?.includes("floor"));
    // The first repo completed before the drain.
    assert.equal(result.queue.length, 1);
    assert.equal(result.queue[0].repo, "o/one");
  });

  it("degrades to partial when a search call is rate limited", async () => {
    const { RateLimitError } = await import("../src/github.js");
    const deps = fixtureDeps({
      starters: { "o/one": [{ number: 1, title: "t", url: "u" }] },
      xrays: { "o/one#1": xray("GO", { number: 1 }) },
    });
    deps.starterIssues = async () => {
      throw new RateLimitError("GitHub rate limit hit (403). Secondary limit.");
    };
    const result = await runWave([entry("o/one", { stars: 9000 })], filters, deps);
    assert.equal(result.partial, true);
    assert.ok(result.partialReason?.includes("rate limited"));
    assert.equal(result.queue.length, 0);
  });
});
