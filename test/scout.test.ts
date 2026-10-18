import { test, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scoutCampaign,
  loadCampaignFile,
  saveCampaignFile,
  campaignHas,
  rankCandidates,
  type ScannedIssue,
  type CampaignFile,
} from "../src/scout.js";

const NOW = new Date("2026-10-17T12:00:00Z");

let dir: string;
let campaignPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gl-scout-test-"));
  campaignPath = join(dir, "campaign.json");
});

function issue(over: Partial<ScannedIssue> = {}): ScannedIssue {
  return {
    number: 1,
    title: "Fix the widget",
    url: "https://github.com/o/r/issues/1",
    verdict: "GO",
    reasons: ["no claims, no gates"],
    flags: [],
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

function fixtureCampaign(): CampaignFile {
  return {
    entries: [
      { repo: "o/r", issue: 1, status: "CLAIMED", pr: null },
      { repo: "o/r", issue: 2, status: "SCOUTED", pr: null },
      { repo: "o/other", issue: 9, status: "MERGED", pr: "https://github.com/o/other/pull/3" },
    ],
    cursor: null,
  };
}

describe("campaign file", () => {
  it("loads, saves, and matches entries in ANY status", () => {
    saveCampaignFile(campaignPath, fixtureCampaign());
    const c = loadCampaignFile(campaignPath);
    assert.equal(c.entries.length, 3);
    assert.equal(c.cursor, null);
    assert.ok(campaignHas(c, "o/r", 1));
    assert.ok(campaignHas(c, "o/r", 2));
    assert.ok(campaignHas(c, "O/R", 1), "repo matching is case-insensitive");
    assert.ok(!campaignHas(c, "o/r", 3));
  });

  it("starts empty when missing", () => {
    const c = loadCampaignFile(join(dir, "nope.json"));
    assert.deepEqual(c.entries, []);
    assert.equal(c.cursor, null);
  });
});

describe("ranking", () => {
  it("orders GO above RISKY and easier repos above harder ones", () => {
    const ranked = rankCandidates(
      [
        { repo: "o/hard", number: 1, title: "a", url: "u1", verdict: "RISKY", reasons: [], flags: [], updatedAt: NOW.toISOString() },
        { repo: "o/easy", number: 2, title: "b", url: "u2", verdict: "GO", reasons: [], flags: [], updatedAt: NOW.toISOString() },
      ],
      { friction: 80, outsideMergeShare: 0.5, medianMergeDays: 3 },
      NOW
    );
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].verdict, "GO");
    assert.ok(ranked[0].score > ranked[1].score);
  });

  it("prefers fresher issues at equal verdicts", () => {
    const old = new Date(NOW.getTime() - 90 * 86400000).toISOString();
    const ranked = rankCandidates(
      [
        { repo: "o/r", number: 1, title: "a", url: "u1", verdict: "GO", reasons: [], flags: [], updatedAt: old },
        { repo: "o/r", number: 2, title: "b", url: "u2", verdict: "GO", reasons: [], flags: [], updatedAt: NOW.toISOString() },
      ],
      { friction: 80, outsideMergeShare: 0.5, medianMergeDays: 3 },
      NOW
    );
    assert.equal(ranked[0].number, 2);
  });
});

describe("scoutCampaign", () => {
  it("dedupes against the campaign file in ANY status and appends SCOUTED", async () => {
    saveCampaignFile(campaignPath, fixtureCampaign());
    let used = 0;
    const result = await scoutCampaign({
      repos: ["o/r"],
      campaignPath,
      budget: 100,
      write: true,
      now: NOW,
      deps: {
        budgetUsed: () => used,
        listIssues: async () => [
          issue({ number: 1 }),
          issue({ number: 2 }),
          issue({ number: 3 }),
          issue({ number: 4, verdict: "TAKEN" }),
        ],
        scanIssue: async (_o, _r, n) => {
          used++;
          return issue({ number: n, verdict: n === 4 ? "TAKEN" : "GO" });
        },
        friction: async () => ({ score: 80 } as never),
        velocity: async () => ({ externalShare: 0.5, medianMergeDays: 3 } as never),
      },
    });
    // #1 (CLAIMED) and #2 (SCOUTED) deduped, #4 TAKEN dropped, only #3 survives.
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].number, 3);
    assert.equal(result.budgetHit, false);
    assert.equal(result.cursor, null);
    assert.equal(result.appended.length, 1);
    assert.equal(result.appended[0].status, "SCOUTED");
    assert.equal(result.appended[0].verdict, "GO");
    assert.ok(result.appended[0].evidence !== undefined);
    const saved = loadCampaignFile(campaignPath);
    assert.equal(saved.entries.length, 4);
    assert.ok(campaignHas(saved, "o/r", 3));
    assert.equal(saved.cursor, null, "completed runs clear the cursor");
  });

  it("keeps a fixed number per repo and ranks globally", async () => {
    const result = await scoutCampaign({
      repos: ["o/a", "o/b"],
      campaignPath,
      budget: 100,
      write: false,
      keepPerRepo: 1,
      now: NOW,
      deps: {
        budgetUsed: () => 0,
        listIssues: async (o, r) => [
          issue({ number: 1, verdict: "RISKY", url: `https://github.com/${o}/${r}/issues/1` }),
          issue({ number: 2, verdict: "GO", url: `https://github.com/${o}/${r}/issues/2` }),
        ],
        scanIssue: async (o, r, n) => issue({ number: n, verdict: n === 2 ? "GO" : "RISKY", url: `https://github.com/${o}/${r}/issues/${n}` }),
        friction: async () => ({ score: 80 } as never),
        velocity: async () => ({ externalShare: 0.5, medianMergeDays: 3 } as never),
      },
    });
    assert.equal(result.candidates.length, 2, "one per repo");
    assert.ok(result.candidates.every((c) => c.number === 2), "the GO issue wins per repo");
    assert.deepEqual(result.reposProcessed, ["o/a", "o/b"]);
  });

  it("stops on the budget, saves a resume cursor, and resumes", async () => {
    const depsFor = (exhaust: boolean, usedRef: { n: number }) => ({
      budgetUsed: () => usedRef.n,
      listIssues: async () => [issue({ number: 1 })],
      scanIssue: async (_o: string, _r: string, n: number) => {
        // The first scan call burns the whole budget when exhausting.
        usedRef.n = exhaust ? 5 : usedRef.n + 1;
        return issue({ number: n, verdict: "GO" as const });
      },
      friction: async () => ({ score: 80 } as never),
      velocity: async () => ({ externalShare: 0.5, medianMergeDays: 3 } as never),
    });

    // First run: the budget burns during repo 0's scan. Repo 0's survivor
    // is still reported and written; the run stops before repo 1 and the
    // cursor records where.
    const usedRef = { n: 0 };
    const first = await scoutCampaign({
      repos: ["o/one", "o/two", "o/three"],
      campaignPath,
      budget: 5,
      write: true,
      now: NOW,
      deps: depsFor(true, usedRef),
    });
    assert.equal(first.budgetHit, true);
    assert.deepEqual(first.reposProcessed, ["o/one"]);
    assert.deepEqual(first.cursor, { repoIndex: 1 });
    assert.equal(first.candidates.length, 1, "the survivor found before the stop is still reported");
    const saved = loadCampaignFile(campaignPath);
    assert.deepEqual(saved.cursor, { repoIndex: 1 });
    assert.ok(campaignHas(saved, "o/one", 1), "survivors found before the stop are still written");

    // Rerun with budget: resumes at repo 1, finishes, clears the cursor.
    // o/one#1 is already in the file, so it is deduped even if rescanned.
    const usedRef2 = { n: 0 };
    const second = await scoutCampaign({
      repos: ["o/one", "o/two", "o/three"],
      campaignPath,
      budget: 100,
      write: true,
      now: NOW,
      deps: depsFor(false, usedRef2),
    });
    assert.equal(second.budgetHit, false);
    assert.equal(second.cursor, null);
    assert.deepEqual(second.reposSkipped, ["o/one"]);
    assert.deepEqual(second.reposProcessed, ["o/two", "o/three"]);
    const final = loadCampaignFile(campaignPath);
    assert.equal(final.cursor, null);
    assert.ok(campaignHas(final, "o/two", 1));
    assert.ok(campaignHas(final, "o/three", 1));
  });
});

describe("capability exclusion", () => {
  it("excludes repos whose latest pr_create outcome is a structural block, naming the reason", async () => {
    const capPath = join(dir, "capabilities.json");
    writeFileSync(
      capPath,
      JSON.stringify({
        entries: [
          {
            repo: "o/blocked",
            action: "pr_create",
            outcome: "blocked-422",
            evidence: 'PR creation failed: GitHub API 422: user is blocked (2026-10-18)',
            at: "2026-10-18T14:00:00.000Z",
          },
        ],
      }),
      "utf8"
    );
    const listed: string[] = [];
    const result = await scoutCampaign({
      repos: ["o/blocked", "o/fine"],
      campaignPath,
      budget: 100,
      write: false,
      now: NOW,
      capabilitiesPath: capPath,
      deps: {
        budgetUsed: () => 0,
        listIssues: async (o: string, r: string) => {
          listed.push(`${o}/${r}`);
          return [issue({ number: 1 })];
        },
        scanIssue: async (_o, _r, n) => issue({ number: n }),
        friction: async () => ({ score: 80 } as never),
        velocity: async () => ({ externalShare: 0.5, medianMergeDays: 3 } as never),
      },
    });
    // The blocked repo is never listed or scanned; the fine one is.
    assert.deepEqual(listed, ["o/fine"]);
    assert.equal(result.reposBlocked.length, 1);
    assert.equal(result.reposBlocked[0].repo, "o/blocked");
    assert.match(result.reposBlocked[0].reason, /blocked-422/);
    assert.match(result.reposBlocked[0].reason, /user is blocked/);
    assert.deepEqual(result.reposProcessed, ["o/fine"]);
    assert.ok(Array.isArray(result.json.reposBlocked), "json carries the exclusion");
    assert.equal((result.json.reposBlocked as Array<{ repo: string }>).length, 1);
    assert.match(result.markdown, /o\/blocked/);
  });

  it("does not exclude repos whose latest outcome is ok", async () => {
    const capPath = join(dir, "capabilities.json");
    writeFileSync(
      capPath,
      JSON.stringify({
        entries: [
          { repo: "o/fine", action: "pr_create", outcome: "ok", evidence: "PR opened", at: "2026-10-18T14:00:00.000Z" },
        ],
      }),
      "utf8"
    );
    const result = await scoutCampaign({
      repos: ["o/fine"],
      campaignPath,
      budget: 100,
      write: false,
      now: NOW,
      capabilitiesPath: capPath,
      deps: {
        budgetUsed: () => 0,
        listIssues: async () => [issue({ number: 1 })],
        scanIssue: async (_o, _r, n) => issue({ number: n }),
        friction: async () => ({ score: 80 } as never),
        velocity: async () => ({ externalShare: 0.5, medianMergeDays: 3 } as never),
      },
    });
    assert.equal(result.reposBlocked.length, 0);
    assert.deepEqual(result.reposProcessed, ["o/fine"]);
  });
});
