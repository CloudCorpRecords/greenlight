#!/usr/bin/env node
/**
 * Greenlight CLI.
 *
 *   greenlight check <issue-url> [--json]
 *   greenlight scan <owner/repo> [--json] [--no-fallback]
 *   greenlight friction <owner/repo> [--json]
 *   greenlight claim <issue-url> [--yes] [--force] [--json]
 *   greenlight prep <issue-url> [--dir path] [--yes] [--json]
 *   greenlight pr <issue-url> --branch <name> [--title t] [--yes] [--json]
 *
 * Set GITHUB_TOKEN for the 5000 req/hr authenticated rate limit.
 * The claim/prep/pr commands default to a DRY RUN: nothing is posted or
 * created without --yes, and writes require GITHUB_TOKEN (or GH_TOKEN).
 */
import {
  parseIssueUrl,
  buildIssueSnapshot,
  scanCandidates,
  fetchContributing,
  countStarterIssues,
  detectRepoPolicy,
  RateLimitError,
} from "./github.js";
import { scoreIssue } from "./verdict.js";
import { parseGates } from "./gates.js";
import { scoreFriction } from "./friction.js";
import {
  createRestClient,
  claimIssue,
  prepIssue,
  openPr,
  AutomationRefusal,
  type ClaimResult,
  type PrepResult,
  type PrResult,
} from "./automate.js";
import type { VerdictResult } from "./types.js";

const SYMBOL: Record<string, string> = {
  GO: "[GO]",
  RISKY: "[RISKY]",
  TAKEN: "[TAKEN]",
  GATED: "[GATED]",
  STALE: "[STALE]",
};

function printVerdict(snapshot: { sourceUrl: string; title: string; owner: string; repo: string; number: number }, result: VerdictResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify({ issue: snapshot.sourceUrl, title: snapshot.title, verdict: result.verdict, reasons: result.reasons, flags: result.flags, claims: result.claims, gates: result.gates }, null, 2));
    return;
  }
  console.log(`${SYMBOL[result.verdict]} ${snapshot.owner}/${snapshot.repo}#${snapshot.number}`);
  console.log(`  ${snapshot.title}`);
  console.log(`  ${snapshot.sourceUrl}`);
  for (const reason of result.reasons) console.log(`  - ${reason}`);
  if (result.flags.length > 0) console.log(`  flags: ${result.flags.join(", ")}`);
  const strongClaims = result.claims.filter((c) => c.strength === "strong");
  if (strongClaims.length > 0) {
    console.log(`  claimants: ${strongClaims.map((c) => `${c.author} (${c.ageDays}d, ${c.phrase})`).join("; ")}`);
  }
  const detected = result.gates.filter((g) => g.detected);
  if (detected.length > 0) {
    console.log(`  gates: ${detected.map((g) => g.kind).join(", ")}`);
  }
}

function parseRepoRef(ref: string): { owner: string; repo: string } {
  const m = /^([^/]+)\/([^/]+)$/.exec(ref.trim());
  if (!m) throw new Error(`Expected owner/repo, got: ${ref}`);
  return { owner: m[1], repo: m[2] };
}

async function cmdCheck(issueUrl: string, asJson: boolean): Promise<void> {
  const { owner, repo, number } = parseIssueUrl(issueUrl);
  const snapshot = await buildIssueSnapshot(owner, repo, number);
  const result = scoreIssue(snapshot);
  printVerdict(snapshot, result, asJson);
}

async function cmdScan(repoRef: string, asJson: boolean, args: string[]): Promise<void> {
  const { owner, repo } = parseRepoRef(repoRef);
  const { issues, fallbackUsed } = await scanCandidates(owner, repo, {
    fallback: !args.includes("--no-fallback"),
    limit: 10,
  });
  if (issues.length === 0) {
    console.log(`No open unassigned good-first-issue/help-wanted issues found in ${owner}/${repo}.`);
    if (fallbackUsed) console.log(`The fallback pass (recent open unassigned issues) also found nothing.`);
    return;
  }
  const results: Array<{ url: string; title: string; verdict: string; reasons: string[]; flags: string[] }> = [];
  for (const issue of issues) {
    try {
      const snapshot = await buildIssueSnapshot(owner, repo, issue.number);
      const scored = scoreIssue(snapshot);
      results.push({ url: issue.url, title: issue.title, verdict: scored.verdict, reasons: scored.reasons, flags: scored.flags });
    } catch (err) {
      results.push({ url: issue.url, title: issue.title, verdict: "ERROR", reasons: [err instanceof Error ? err.message : String(err)], flags: [] });
    }
  }
  const rank: Record<string, number> = { GO: 0, RISKY: 1, GATED: 2, STALE: 3, TAKEN: 4, ERROR: 5 };
  results.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9));

  if (asJson) {
    console.log(JSON.stringify({ repo: `${owner}/${repo}`, fallback: fallbackUsed, results }, null, 2));
    return;
  }
  console.log(`Scan of ${owner}/${repo}: ${results.length} candidate issues, GO first`);
  if (fallbackUsed) {
    console.log(`(fallback pass: no label-tagged starter issues found, showing the most recent open unassigned issues)`);
  }
  for (const r of results) {
    console.log(`\n${SYMBOL[r.verdict] ?? "[?]"} ${r.title}`);
    console.log(`  ${r.url}`);
    console.log(`  - ${r.reasons[0] ?? "no reason"}`);
    if (r.flags.length > 0) console.log(`  flags: ${r.flags.join(", ")}`);
  }
}

async function cmdFriction(repoRef: string, asJson: boolean): Promise<void> {
  const { owner, repo } = parseRepoRef(repoRef);
  const [contributing, policy, starterCount] = await Promise.all([
    fetchContributing(owner, repo),
    detectRepoPolicy(owner, repo),
    countStarterIssues(owner, repo),
  ]);
  const gates = parseGates(contributing, { collaboratorsOnlyPolicy: policy.collaboratorsOnly });
  const report = scoreFriction({
    owner,
    repo,
    gates,
    externalPRMergeRate: null,
    medianFirstReviewHours: null,
    maintainerIssueResponseHours: null,
    openGoodFirstIssueCount: starterCount,
    note: "live",
  });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Friction for ${owner}/${repo}: ${report.score}/100 (100 = easiest)`);
  for (const reason of report.reasons) console.log(`  - ${reason}`);
  if (report.reasons.length === 0) console.log("  - no gates or penalties detected");
  if (starterCount !== null) console.log(`  open starter issues: ${starterCount}`);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function cmdClaim(issueUrl: string, args: string[]): Promise<void> {
  const { owner, repo, number } = parseIssueUrl(issueUrl);
  const snapshot = await buildIssueSnapshot(owner, repo, number);
  printVerdict(snapshot, scoreIssue(snapshot), false);
  const plan: ClaimResult = await claimIssue(createRestClient(), snapshot, {
    yes: args.includes("--yes"),
    force: args.includes("--force"),
  });
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          issue: snapshot.sourceUrl,
          verdict: plan.verdict.verdict,
          commentBody: plan.commentBody,
          commentUrl: plan.commentUrl,
          executed: plan.executed,
        },
        null,
        2
      )
    );
    return;
  }
  if (plan.executed) {
    console.log(`Claim comment posted: ${plan.commentUrl}`);
  } else {
    console.log(`\nDry run: claim comment NOT posted.`);
    console.log(`--- comment that would be posted on ${owner}/${repo}#${number} ---`);
    console.log(plan.commentBody);
    console.log(`---`);
    console.log(`Re-run with --yes (and GITHUB_TOKEN set) to post it.`);
  }
}

async function cmdPrep(issueUrl: string, args: string[]): Promise<void> {
  const { owner, repo, number } = parseIssueUrl(issueUrl);
  const snapshot = await buildIssueSnapshot(owner, repo, number);
  printVerdict(snapshot, scoreIssue(snapshot), false);
  const plan: PrepResult = await prepIssue(createRestClient(), snapshot, {
    dir: flagValue(args, "--dir"),
    yes: args.includes("--yes"),
  });
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          issue: snapshot.sourceUrl,
          verdict: plan.verdict.verdict,
          branch: plan.branch,
          branchDefault: plan.branchDefault,
          branchPatternNote: plan.branchPatternNote,
          forkReady: plan.forkReady,
          forkCreated: plan.forkCreated,
          branchReady: plan.branchReady,
          branchCreated: plan.branchCreated,
          prepFile: plan.prepFile,
          nextCommands: plan.nextCommands,
          conventions: plan.conventions ?? null,
        },
        null,
        2
      )
    );
    return;
  }
  console.log(`\nBranch: ${plan.branch}${plan.branchReady ? " (ready)" : " (not created yet)"}`);
  if (plan.branchPatternNote) console.log(`  ${plan.branchPatternNote}; default would be ${plan.branchDefault}`);
  console.log(`Fork: ${plan.forkReady ? "ready" : "missing"}${plan.forkCreated ? " (created just now)" : ""}`);
  console.log(`Prep checklist written to: ${plan.prepFile}`);
  console.log(`Next commands:`);
  for (const cmd of plan.nextCommands) console.log(`  ${cmd}`);
  if (!args.includes("--yes")) {
    console.log(`\nDry run: nothing was forked or created on GitHub. Re-run with --yes (and GITHUB_TOKEN set) to create the fork and branch.`);
  }
}

async function cmdPr(issueUrl: string, args: string[]): Promise<void> {
  const branch = flagValue(args, "--branch");
  if (!branch) {
    console.error("Error: --branch <name> is required, e.g. greenlight pr <issue-url> --branch feat/resume-61");
    process.exitCode = 1;
    return;
  }
  const { owner, repo, number } = parseIssueUrl(issueUrl);
  const snapshot = await buildIssueSnapshot(owner, repo, number);
  const plan: PrResult = await openPr(createRestClient(), snapshot, {
    branch,
    title: flagValue(args, "--title"),
    yes: args.includes("--yes"),
  });
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          issue: snapshot.sourceUrl,
          branch: plan.branch,
          head: plan.head,
          base: plan.base,
          title: plan.title,
          body: plan.body,
          checks: plan.checks,
          prUrl: plan.prUrl,
          executed: plan.executed,
        },
        null,
        2
      )
    );
    return;
  }
  console.log(`${plan.head} -> ${owner}/${repo}:${plan.base}`);
  for (const check of plan.checks) console.log(`  - ${check}`);
  if (plan.executed) {
    console.log(`PR opened: ${plan.prUrl}`);
  } else {
    console.log(`\nDry run: PR NOT opened.`);
    console.log(`--- PR that would be opened ---`);
    console.log(`Title: ${plan.title}`);
    console.log(``);
    console.log(plan.body);
    console.log(`---`);
    console.log(`Re-run with --yes (and GITHUB_TOKEN set) to open it.`);
  }
}

function usage(): void {
  console.log("greenlight: pre-flight checks for open-source contributions");
  console.log("");
  console.log("  greenlight check <issue-url> [--json]");
  console.log("  greenlight scan <owner/repo> [--json] [--no-fallback]");
  console.log("  greenlight friction <owner/repo> [--json]");
  console.log("  greenlight claim <issue-url> [--yes] [--force] [--json]");
  console.log("  greenlight prep <issue-url> [--dir path] [--yes] [--json]");
  console.log("  greenlight pr <issue-url> --branch <name> [--title t] [--yes] [--json]");
  console.log("");
  console.log("claim/prep/pr default to a DRY RUN: nothing is posted or created without");
  console.log("--yes, and writes require GITHUB_TOKEN (or GH_TOKEN) to be set.");
  console.log("");
  console.log("Set GITHUB_TOKEN to raise the GitHub API rate limit (60 -> 5000 req/hr).");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(["--json", "--yes", "--force", "--no-fallback"]);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flags.has(a)) continue;
    if (a === "--dir" || a === "--title" || a === "--branch") {
      i++; // skip the value with its flag
      continue;
    }
    positional.push(a);
  }
  const [command, target] = positional;

  try {
    if (command === "check" && target) return await cmdCheck(target, args.includes("--json"));
    if (command === "scan" && target) return await cmdScan(target, args.includes("--json"), args);
    if (command === "friction" && target) return await cmdFriction(target, args.includes("--json"));
    if (command === "claim" && target) return await cmdClaim(target, args);
    if (command === "prep" && target) return await cmdPrep(target, args);
    if (command === "pr" && target) return await cmdPr(target, args);
    usage();
    process.exitCode = command ? 1 : 0;
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.error(`Rate limited: ${err.message}`);
    } else if (err instanceof AutomationRefusal) {
      console.error(`Refused: ${err.message}`);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}

await main();
