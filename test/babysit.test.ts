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
  classifyBabysitError,
  reviewFindingId,
  guardFlagId,
  watermarkKey,
  watermarkFromReport,
  defaultStatePath,
  defaultAccountAuthor,
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

describe("--account discovery (v0.10.0)", () => {
  it("account mode discovers PRs account-wide and marks the run", async () => {
    const urls = [
      "https://github.com/acme/widgets/pull/201",
      "https://github.com/other/gadgets/pull/202",
    ];
    const run = await babysit({
      account: true,
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
    assert.equal(run.prsChecked, 2);
    assert.equal(run.accountMode, true);
    assert.match(run.markdown, /account-wide/);
  });

  it("defaultAccountAuthor honors GREENLIGHT_GITHUB_USER", () => {
    assert.equal(defaultAccountAuthor({ GREENLIGHT_GITHUB_USER: "someone" } as NodeJS.ProcessEnv), "someone");
    assert.equal(defaultAccountAuthor({} as NodeJS.ProcessEnv), "CloudCorpRecords");
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

describe("babysit claims section (v0.9.0)", () => {
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600000).toISOString();
  const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3600000).toISOString();

  function statusFor(over: Record<string, unknown> = {}) {
    return {
      issue: "https://github.com/acme/widgets/issues/1",
      verdict: null,
      reason: null,
      claim: null,
      protocol_note: null,
      competing_prs: [],
      gates: [],
      repo_protocol: null,
      checked_at: NOW.toISOString(),
      stale_after_seconds: 21600,
      ...over,
    };
  }

  it("buckets registered claims and skips the PR scan with --claims-only", async () => {
    const claimsPath = join(stateDir, "my-claims.json");
    const { registerClaim } = await import("../src/claims-registry.js");
    registerClaim(claimsPath, {
      issueUrl: "https://github.com/acme/widgets/issues/1",
      owner: "acme",
      repo: "widgets",
      number: 1,
      postedAt: hoursAgo(24),
      etaDays: 7,
      claimant: "me",
    });
    registerClaim(claimsPath, {
      issueUrl: "https://github.com/acme/widgets/issues/2",
      owner: "acme",
      repo: "widgets",
      number: 2,
      postedAt: hoursAgo(120),
      etaDays: 7,
      claimant: "me",
    });

    const computeStatus = async (owner: string, repo: string, number: number) => {
      if (number === 1) {
        return {
          status: statusFor({
            claim: { state: "linked", claimant: "me", claimed_at: hoursAgo(24), expires_at: hoursFromNow(144), queue: [] },
            competing_prs: [{ number: 42, author: "me", state: "open", url: "https://github.com/acme/widgets/pull/42" }],
          }),
          issueUpdatedAt: hoursAgo(2),
        };
      }
      return {
        status: statusFor({
          claim: { state: "active", claimant: "me", claimed_at: hoursAgo(120), expires_at: hoursFromNow(30), queue: [] },
        }),
        issueUpdatedAt: hoursAgo(1),
      };
    };

    const run = await babysit({
      claimsOnly: true,
      statePath,
      claimsRegistryPath: claimsPath,
      now: NOW,
      deps: { computeStatus: computeStatus as never },
    });
    assert.equal(run.claimsOnly, true);
    assert.equal(run.claims.length, 2);
    assert.deepEqual(run.claims.map((c) => c.bucket).sort(), ["expiring", "linked"]);
    assert.ok(run.markdown.includes("## My claims (2 active)"));
    assert.ok(run.markdown.includes("### linked"));
    assert.ok(run.markdown.includes("### expiring"));
    const jsonClaims = (run.json.claims as Array<{ bucket: string }>).map((c) => c.bucket).sort();
    assert.deepEqual(jsonClaims, ["expiring", "linked"]);
  });

  it("retires completed claims and notes them", async () => {
    const claimsPath = join(stateDir, "my-claims.json");
    const { registerClaim, loadRegistry } = await import("../src/claims-registry.js");
    registerClaim(claimsPath, {
      issueUrl: "https://github.com/acme/widgets/issues/3",
      owner: "acme",
      repo: "widgets",
      number: 3,
      postedAt: hoursAgo(24),
      claimant: "me",
    });
    const run = await babysit({
      claimsOnly: true,
      statePath,
      claimsRegistryPath: claimsPath,
      now: NOW,
      deps: {
        computeStatus: (async () => ({
          status: statusFor({
            claim: { state: "completed", claimant: "me", claimed_at: hoursAgo(24), expires_at: hoursFromNow(144), queue: [] },
          }),
          issueUpdatedAt: hoursAgo(1),
        })) as never,
      },
    });
    assert.equal(run.claims.length, 0);
    assert.equal(run.retiredClaims.length, 1);
    assert.deepEqual(loadRegistry(claimsPath).claims, []);
  });

  it("says so when the registry does not exist", async () => {
    const run = await babysit({
      claimsOnly: true,
      statePath,
      claimsRegistryPath: join(stateDir, "nope.json"),
      now: NOW,
      deps: {},
    });
    assert.equal(run.claimsRegistryMissing, true);
    assert.ok(run.markdown.includes("No claims registry yet"));
  });
});

describe("v0.9.1 babysit: concurrency, retries, transient bucket, guard subjects", () => {
  let stateDir: string;
  let statePath: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "gl-babysit091-"));
    statePath = join(stateDir, "babysit.json");
  });

  function prUrl(n: number): string {
    return `https://github.com/acme/widgets/pull/${n}`;
  }

  function prFor(n: number): BabysitPull {
    return pull({ number: n, url: prUrl(n), headSha: `sha${n}` });
  }

  function quietDeps(over: Partial<BabysitDeps> = {}): BabysitDeps {
    return {
      fetchPr: async (o, r, n) => prFor(n),
      fetchCheckRuns: async () => [],
      triageCi: async () => ci(),
      triageReview: async () => review(),
      guard: async () => guardRes(),
      ...over,
    };
  }

  it("retries a PR whose fetch fails once, then lands it in the right bucket", async () => {
    let calls = 0;
    const run = await babysit({
      claimsRegistryPath: join(stateDir, "my-claims.json"),
      prs: [prUrl(42)],
      statePath,
      now: NOW,
      deps: quietDeps({
        fetchPr: async (o, r, n) => {
          calls++;
          if (calls === 1) throw new Error("fetch failed");
          return prFor(n);
        },
      }),
    });
    assert.equal(calls, 2);
    assert.equal(run.transientFailures.length, 0);
    assert.equal(run.reports.length, 1);
    // Calm first run: green CI, no reviews yet -> the waiting bucket, never needs-you.
    assert.ok(run.waitingOnThem.some((a) => a.pr === "acme/widgets#42"));
    assert.equal(run.needsYouNow.length, 0);
    // Watermark written: the PR was observed.
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.ok(state.watermarks["acme/widgets#42"]);
  });

  it("parks a persistently failing PR in the transient section with no watermark and no findings", async () => {
    const run = await babysit({
      claimsRegistryPath: join(stateDir, "my-claims.json"),
      prs: [prUrl(42), prUrl(43)],
      statePath,
      now: NOW,
      deps: quietDeps({
        fetchPr: async (o, r, n) => {
          if (n === 42) throw new Error("fetch failed");
          return prFor(n);
        },
      }),
    });
    assert.equal(run.transientFailures.length, 1);
    assert.equal(run.transientFailures[0].pr, "acme/widgets#42");
    assert.equal(run.transientFailures[0].errorKind, "transient");
    assert.equal(run.reports.length, 1);
    assert.equal(run.needsYouNow.length, 0);
    assert.ok(run.markdown.includes("## Could not check (transient)"));
    assert.ok(!run.markdown.includes("Could not check this PR:"));
    // Watermark untouched: a rerun must observe it as if this run never happened.
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.ok(!state.watermarks["acme/widgets#42"]);
    assert.ok(state.watermarks["acme/widgets#43"]);
  });

  it("marks a malformed PR URL as usage, not transient", async () => {
    const run = await babysit({
      claimsRegistryPath: join(stateDir, "my-claims.json"),
      prs: ["not-a-pr-url"],
      statePath,
      now: NOW,
      deps: quietDeps(),
    });
    assert.equal(run.transientFailures.length, 1);
    assert.equal(run.transientFailures[0].errorKind, "usage");
    assert.equal(run.needsYouNow.length, 0);
  });

  it("fetches PRs concurrently (bounded)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 60));
      inFlight--;
      return [];
    };
    const urls = [42, 43, 44, 45, 46].map(prUrl);
    const started = Date.now();
    const run = await babysit({
      claimsRegistryPath: join(stateDir, "my-claims.json"),
      prs: urls,
      statePath,
      now: NOW,
      concurrency: 5,
      deps: quietDeps({ fetchCheckRuns: slow, triageCi: async () => { await slow(); return ci(); } }),
    });
    const elapsed = Date.now() - started;
    assert.equal(run.reports.length, 5);
    assert.ok(maxInFlight > 1, `expected overlap, saw max in-flight ${maxInFlight}`);
    // Serial would take 5 * 120ms = 600ms minimum; concurrent must be far under it.
    assert.ok(elapsed < 450, `took ${elapsed}ms, looks serial`);
  });

  it("routes guard flags by subject: the actual #9250 regression shape", async () => {
    // A PR whose guard run surfaces a competing-fix flag about a DIFFERENT
    // issue (#123) must produce zero needs-you items from guard; the flag
    // lands in repoNotes instead. A subject-"pr" flag still counts.
    const g = guardRes({
      linkedIssues: [{ number: 9246, title: "Add API", url: "https://github.com/actualbudget/actual/issues/9246", state: "open" }],
      findings: [
        { check: "competing-fix", subject: "issue", issueRef: "actualbudget/actual#123", severity: "flag", title: "Competing fix for #123", evidence: ["another open PR already claims this issue: #122 by @other"] },
        { check: "changeset-missing", subject: "pr", severity: "flag", title: "Missing release-note file (repo uses upcoming-release-notes/)", evidence: ["no file under upcoming-release-notes/"] },
      ],
      summary: "Greenlight guard: 2 things to check",
      hasFindings: true,
    });
    const run = await babysit({
      claimsRegistryPath: join(stateDir, "my-claims.json"),
      prs: ["https://github.com/actualbudget/actual/pull/9250"],
      statePath,
      now: NOW,
      deps: {
        fetchPr: async () => pull({ owner: "actualbudget", repo: "actual", number: 9250, title: "Add API", url: "https://github.com/actualbudget/actual/pull/9250", headSha: "bbb222" }),
        fetchCheckRuns: async () => [],
        triageCi: async () => ci(),
        triageReview: async () => review(),
        guard: async () => g,
      },
    });
    const report = run.reports[0];
    assert.deepEqual(report.newGuardFlags, ["Missing release-note file (repo uses upcoming-release-notes/)"]);
    assert.ok(report.repoNotes.some((n) => n.includes("Competing fix for #123")));
    const guardActions = run.needsYouNow.filter((a) => a.text.includes("Guard flagged"));
    assert.equal(guardActions.length, 1);
    assert.ok(guardActions[0].text.includes("1 new thing"));
    assert.ok(run.markdown.includes("## Repo notes (informational)"));
    assert.ok(run.markdown.includes("Competing fix for #123"));
  });

  it("classifies 404/401 as usage (no retry) and network/5xx as transient", () => {
    assert.equal(classifyBabysitError(new Error("GitHub API 404 for /repos/a/b/pulls/1")), "usage");
    assert.equal(classifyBabysitError(new Error("GitHub API 401: Bad credentials")), "usage");
    assert.equal(classifyBabysitError(new Error("not a GitHub pull request URL: xyz")), "usage");
    assert.equal(classifyBabysitError(new Error("GitHub API 403 for /rate_limit: Blocked")), "transient");
    assert.equal(classifyBabysitError(new Error("GitHub API 500 for /repos/a/b")), "transient");
    assert.equal(classifyBabysitError(new Error("fetch failed")), "transient");
  });

  it("treats an issue-subject flag on the PR's own linked issue as needs-you", async () => {
    const g = guardRes({
      linkedIssues: [{ number: 123, title: "Bug", url: "https://github.com/acme/widgets/issues/123", state: "open" }],
      findings: [
        { check: "competing-fix", subject: "issue", issueRef: "acme/widgets#123", severity: "flag", title: "Competing fix for #123", evidence: [] },
      ],
      summary: "Greenlight guard: 1 thing to check",
      hasFindings: true,
    });
    const run = await babysit({
      claimsRegistryPath: join(stateDir, "my-claims.json"),
      prs: [prUrl(42)],
      statePath,
      now: NOW,
      deps: quietDeps({ guard: async () => g }),
    });
    assert.deepEqual(run.reports[0].newGuardFlags, ["Competing fix for #123"]);
    assert.equal(run.reports[0].repoNotes.length, 0);
    assert.ok(run.needsYouNow.some((a) => a.text.includes("Competing fix for #123")));
  });
});
