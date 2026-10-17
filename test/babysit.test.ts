/**
 * Tests for the PR babysitter: change detection across two snapshots
 * (watermarks), prioritization order, the quiet case, and --mine
 * discovery caps. All network is injected; nothing live.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  babysit,
  buildPrReport,
  reviewFindingId,
  guardFlagId,
  watermarkKey,
  watermarkFromReport,
  defaultStatePath,
  MINE_DISCOVERY_CAP,
  STUCK_CHECK_MINUTES,
  type BabysitPull,
  type BabysitCheckRun,
  type BabysitDeps,
  type BabysitWatermark,
} from "../src/babysit.js";
import type { CiTriageResult } from "../src/ci-triage.js";
import type { ReviewTriageResult, ClassifiedFinding } from "../src/review-triage.js";
import type { GuardResult } from "../src/guard.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const PR = "https://github.com/acme/widgets/pull/42";

function pull(over: Partial<BabysitPull> = {}): BabysitPull {
  return {
    owner: "acme",
    repo: "widgets",
    number: 42,
    title: "Add widget frobnicate",
    author: "CloudCorpRecords",
    state: "open",
    headSha: "aaa111",
    baseRef: "main",
    mergeable: true,
    mergeableState: "clean",
    url: PR,
    ...over,
  };
}

function ci(over: Partial<CiTriageResult> = {}): CiTriageResult {
  return {
    pr: PR,
    title: "Add widget frobnicate",
    baseRef: "main",
    baseSha: "base000",
    headSha: "aaa111",
    checks: [],
    verdict: "NO FAILURES",
    ...over,
  };
}

function finding(over: Partial<ClassifiedFinding> = {}): ClassifiedFinding {
  return {
    author: "coderabbitai",
    authorKind: "bot",
    path: "src/w.ts",
    line: 12,
    summary: "null deref risk",
    class: "likely-real",
    reason: "deterministic signal",
    draft: "thanks",
    ...over,
  };
}

function review(over: Partial<ReviewTriageResult> = {}): ReviewTriageResult {
  return {
    pr: PR,
    title: "Add widget frobnicate",
    findings: [],
    counts: { likelyReal: 0, likelyNoise: 0, needsDecision: 0, noise: 0, resolved: 0 },
    verdict: "NO FINDINGS",
    ...over,
  };
}

function guardRes(over: Partial<GuardResult> = {}): GuardResult {
  return {
    pr: PR,
    number: 42,
    repo: "acme/widgets",
    title: "Add widget frobnicate",
    author: "CloudCorpRecords",
    linkedIssues: [],
    competingPRs: [],
    claims: [],
    findings: [],
    summary: "Greenlight guard: nothing flagged",
    hasFindings: false,
    markdown: "",
    ...over,
  };
}

function deps(over: Partial<BabysitDeps> = {}): BabysitDeps {
  return {
    fetchPr: async () => pull(),
    fetchCheckRuns: async () => [],
    triageCi: async () => ci(),
    triageReview: async () => review(),
    guard: async () => guardRes(),
    ...over,
  };
}

let stateDir: string;
let statePath: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "babysit-"));
  statePath = join(stateDir, "babysit.json");
});

describe("buildPrReport: the clean first-run picture", () => {
  it("a green PR with no findings is calm and waiting on the maintainer", () => {
    const r = buildPrReport({
      prUrl: PR,
      pr: pull(),
      checkRuns: [],
      ci: ci(),
      review: review(),
      guard: guardRes(),
      watermark: null,
      now: NOW,
    });
    assert.equal(r.headChanged, false);
    assert.deepEqual(r.yoursFailing, []);
    assert.equal(r.actions.length, 1);
    assert.equal(r.actions[0].urgency, "waiting");
    assert.match(r.actions[0].text, /no review feedback/i);
  });

  it("an action_required check run is waiting on maintainer approval, not fine", () => {
    const run: BabysitCheckRun = {
      name: "CI Gate",
      status: "completed",
      conclusion: "action_required",
      startedAt: new Date(NOW.getTime() - 30 * 60000).toISOString(),
    };
    const r = buildPrReport({ prUrl: PR, pr: pull(), checkRuns: [run], ci: ci(), review: review(), guard: guardRes(), watermark: null, now: NOW });
    // Completed runs never read as pending...
    assert.deepEqual(r.pendingChecks, []);
    const a = r.actions.find((x) => x.text.includes("waiting on maintainer workflow approval"));
    assert.ok(a, `actions: ${JSON.stringify(r.actions.map((x) => x.text))}`);
    assert.equal(a.urgency, "waiting");
    // ...and no one calls this fine
    assert.ok(!r.actions.some((x) => /no review feedback/i.test(x.text)), "calm action must not fire");
  });

  it("the ci-triage path also surfaces the waiting action without check runs", () => {
    const triage = ci({
      verdict: "ALL PRE-EXISTING",
      checks: [
        {
          name: "CI Gate",
          conclusion: "action_required",
          class: "external-blocker",
          evidence: "check run conclusion is action_required: the workflow run is waiting on maintainer approval",
        },
      ],
    });
    const r = buildPrReport({ prUrl: PR, pr: pull(), checkRuns: [], ci: triage, review: review(), guard: guardRes(), watermark: null, now: NOW });
    const a = r.actions.find((x) => x.text.includes("waiting on maintainer workflow approval"));
    assert.ok(a, `actions: ${JSON.stringify(r.actions.map((x) => x.text))}`);
    assert.equal(a.urgency, "waiting");
    // the generic deploy/auth message must not double-report this one
    assert.ok(!r.actions.some((x) => x.text.includes("repo's own infrastructure")), "no duplicate blocker message");
  });

  it("merging: mealie #8753 shape (2 check runs + 3 approval-gated workflows)", async () => {
    const { mergeActionRequiredRuns } = await import("../src/babysit.js");
    const existing: BabysitCheckRun[] = [
      { name: "draft_release", status: "completed", conclusion: "skipped", startedAt: null },
      { name: "auto_label", status: "completed", conclusion: "success", startedAt: null },
      { name: "PR CI", status: "completed", conclusion: "action_required", startedAt: null },
    ];
    const merged = mergeActionRequiredRuns(existing, ["PR CI", "Auto-merge dependency PRs", "Auto-merge l10n PRs"]);
    assert.equal(merged.length, 5);
    assert.deepEqual(merged.map((r) => r.name), ["draft_release", "auto_label", "PR CI", "Auto-merge dependency PRs", "Auto-merge l10n PRs"]);
    const r = buildPrReport({ prUrl: PR, pr: pull(), checkRuns: merged, ci: ci(), review: review(), guard: guardRes(), watermark: null, now: NOW });
    const a = r.actions.find((x) => x.text.includes("waiting on maintainer workflow approval"));
    assert.ok(a && a.urgency === "waiting");
    assert.equal(r.actions.filter((x) => x.urgency === "now").length, 0);
  });

  it("a pending check run under the stuck threshold is waiting, not now", () => {
    const run: BabysitCheckRun = {
      name: "unit",
      status: "in_progress",
      conclusion: null,
      startedAt: new Date(NOW.getTime() - 30 * 60000).toISOString(),
    };
    const r = buildPrReport({ prUrl: PR, pr: pull(), checkRuns: [run], ci: ci(), review: review(), guard: guardRes(), watermark: null, now: NOW });
    assert.deepEqual(r.pendingChecks, ["unit"]);
    assert.deepEqual(r.stuckChecks, []);
    const a = r.actions.find((x) => x.text.includes("still running"));
    assert.ok(a && a.urgency === "waiting");
  });

  it("a pending check run over 2h is a stuck now-item", () => {
    const run: BabysitCheckRun = {
      name: "unit",
      status: "in_progress",
      conclusion: null,
      startedAt: new Date(NOW.getTime() - (STUCK_CHECK_MINUTES + 30) * 60000).toISOString(),
    };
    const r = buildPrReport({ prUrl: PR, pr: pull(), checkRuns: [run], ci: ci(), review: review(), guard: guardRes(), watermark: null, now: NOW });
    assert.ok(r.stuckChecks.some((s) => s.startsWith("unit")));
    const a = r.actions.find((x) => x.text.includes("stuck"));
    assert.ok(a && a.urgency === "now");
  });

  it("conflicts are a now-item", () => {
    const r = buildPrReport({
      prUrl: PR,
      pr: pull({ mergeable: false, mergeableState: "dirty" }),
      checkRuns: [], ci: ci(), review: review(), guard: guardRes(), watermark: null, now: NOW,
    });
    assert.ok(r.conflicts);
    const a = r.actions.find((x) => x.text.includes("Merge conflicts"));
    assert.ok(a && a.urgency === "now");
  });
});

describe("two snapshots: watermarks catch exactly what changed", () => {
  const findingA = finding({ summary: "null deref risk" });
  const findingB = finding({ summary: "leaked timer", line: 88 });

  async function runSnapshotA() {
    return babysit({
      prs: [PR],
      statePath,
      now: NOW,
      deps: deps({
        triageReview: async () => review({ findings: [findingA], verdict: "HAS LIKELY-REAL" }),
      }),
    });
  }

  it("run A is a first run and reports the full picture", async () => {
    const run = await runSnapshotA();
    assert.equal(run.firstRun, true);
    assert.equal(run.prsChecked, 1);
    assert.equal(run.needsYouNow.length, 1); // the likely-real finding is new
    assert.match(run.needsYouNow[0].text, /new review finding/);
    assert.ok(existsSync(statePath), "watermarks are written");
    const stored = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(stored.watermarks[watermarkKey("acme", "widgets", 42)].headSha, "aaa111");
    assert.deepEqual(stored.watermarks[watermarkKey("acme", "widgets", 42)].seenReviewIds, [reviewFindingId(findingA)]);
  });

  it("run B reports only what changed: new head, new CI yours-failing, new finding, new conflict", async () => {
    await runSnapshotA();
    const run = await babysit({
      prs: [PR],
      statePath,
      now: NOW,
      deps: deps({
        fetchPr: async () => pull({ headSha: "bbb222", mergeable: false, mergeableState: "dirty" }),
        triageCi: async () =>
          ci({
            headSha: "bbb222",
            verdict: "HAS LIKELY-YOURS",
            checks: [{ name: "lint", conclusion: "failure", class: "likely-yours", evidence: "red only on this PR" }],
          }),
        triageReview: async () => review({ findings: [findingA, findingB], verdict: "HAS LIKELY-REAL" }),
      }),
    });
    assert.equal(run.firstRun, false);
    const report = run.reports[0];
    assert.equal(report.headChanged, true);
    assert.deepEqual(report.yoursFailing, ["lint"]);
    // findingA was already seen in run A; only findingB is new.
    assert.equal(report.newLikelyReal.length, 1);
    assert.equal(report.newLikelyReal[0].summary, "leaked timer");
    const texts = run.needsYouNow.map((a) => a.text);
    assert.ok(texts.some((t) => t.includes("Merge conflicts")), "conflict surfaced");
    assert.ok(texts.some((t) => t.includes("lint")), "yours-failing surfaced");
    assert.ok(texts.some((t) => t.includes("leaked timer")), "new finding surfaced");
    // The old finding is not reported again.
    assert.ok(!texts.some((t) => t.includes("null deref risk")));
  });

  it("a guard flag seen in run A is not repeated in run B", async () => {
    await babysit({
      prs: [PR],
      statePath,
      now: NOW,
      deps: deps({
        guard: async () => guardRes({
          findings: [{ check: "competing-fix", severity: "flag", title: "Competing fix for #9", evidence: [] }],
          summary: "Greenlight guard: 1 thing to check",
          hasFindings: true,
        }),
      }),
    });
    const run = await babysit({ prs: [PR], statePath, now: NOW, deps: deps({
      guard: async () => guardRes({
        findings: [{ check: "competing-fix", severity: "flag", title: "Competing fix for #9", evidence: [] }],
        summary: "Greenlight guard: 1 thing to check",
        hasFindings: true,
      }),
    }) });
    assert.deepEqual(run.reports[0].newGuardFlags, []);
    assert.ok(!run.needsYouNow.some((a) => a.text.includes("Guard flagged")));
  });
});

describe("prioritization order", () => {
  it("now-items come conflicts, CI-yours, findings, guard flags, stuck checks", () => {
    const r = buildPrReport({
      prUrl: PR,
      pr: pull({ mergeable: false, mergeableState: "dirty" }),
      checkRuns: [{ name: "e2e", status: "in_progress", conclusion: null, startedAt: new Date(NOW.getTime() - 200 * 60000).toISOString() }],
      ci: ci({
        verdict: "HAS LIKELY-YOURS",
        checks: [{ name: "lint", conclusion: "failure", class: "likely-yours", evidence: "x" }],
      }),
      review: review({ findings: [finding()], verdict: "HAS LIKELY-REAL" }),
      guard: guardRes({
        findings: [{ check: "competing-fix", severity: "flag", title: "Competing fix for #9", evidence: [] }],
        hasFindings: true,
      }),
      watermark: null,
      now: NOW,
    });
    const texts = r.actions.filter((a) => a.urgency === "now").map((a) => a.text);
    const idx = (re: RegExp) => texts.findIndex((t) => re.test(t));
    assert.ok(idx(/conflicts/) < idx(/lint/) && idx(/lint/) < idx(/review finding/) && idx(/review finding/) < idx(/Guard flagged/) && idx(/Guard flagged/) < idx(/stuck/));
  });
});

describe("the quiet case", () => {
  it("a PR merged since the last check lands on the quiet list and its watermark retires", async () => {
    const first = await babysit({ prs: [PR], statePath, now: NOW, deps: deps() });
    assert.equal(first.quiet.length, 0);
    const second = await babysit({
      prs: [PR],
      statePath,
      now: NOW,
      deps: deps({ fetchPr: async () => pull({ state: "merged" }) }),
    });
    assert.equal(second.quiet.length, 1);
    assert.match(second.quiet[0], /merged since the last check/);
    assert.equal(second.needsYouNow.length, 0);
    const stored = JSON.parse(readFileSync(statePath, "utf8"));
    assert.ok(!(watermarkKey("acme", "widgets", 42) in stored.watermarks), "watermark retired");
  });
});

describe("--mine discovery", () => {
  it("discoverPrs results become the PR list and the cap is stated", async () => {
    const urls = Array.from({ length: MINE_DISCOVERY_CAP + 5 }, (_, i) => `https://github.com/acme/widgets/pull/${100 + i}`);
    const seen: string[] = [];
    const run = await babysit({
      mine: true,
      repos: ["acme/widgets"],
      statePath,
      now: NOW,
      deps: deps({
        discoverPrs: async () => urls,
        fetchPr: async (o, r, n) => pull({ owner: o, repo: r, number: n, url: `https://github.com/${o}/${r}/pull/${n}` }),
        triageCi: async (u) => ci({ pr: u }),
        triageReview: async (u) => review({ pr: u }),
        guard: async (u) => guardRes({ pr: u }),
      }),
    });
    assert.equal(run.prsChecked, MINE_DISCOVERY_CAP);
  });
});

describe("helpers", () => {
  it("defaultStatePath lives under ~/.greenlight", () => {
    assert.ok(defaultStatePath().includes(".greenlight"));
    assert.ok(defaultStatePath().endsWith("babysit.json"));
  });
  it("finding and flag ids are deterministic", () => {
    const f = finding();
    assert.equal(reviewFindingId(f), reviewFindingId({ ...f }));
    assert.equal(guardFlagId("a", "b"), guardFlagId("a", "b"));
  });
  it("watermarkFromReport seeds seen ids so nothing repeats", () => {
    const r = buildPrReport({ prUrl: PR, pr: pull(), checkRuns: [], ci: ci(), review: review({ findings: [finding()] }), guard: guardRes(), watermark: null, now: NOW });
    const wm: BabysitWatermark = watermarkFromReport(r, review({ findings: [finding()] }), guardRes(), NOW);
    assert.deepEqual(wm.seenReviewIds, [reviewFindingId(finding())]);
  });
});
