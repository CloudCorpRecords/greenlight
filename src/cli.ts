#!/usr/bin/env node
/**
 * Greenlight CLI.
 *
 *   greenlight check <issue-url> [--json]
 *   greenlight scan <owner/repo> [--json]
 *   greenlight friction <owner/repo> [--json]
 *
 * Set GITHUB_TOKEN for the 5000 req/hr authenticated rate limit.
 */
import {
  parseIssueUrl,
  buildIssueSnapshot,
  listStarterIssues,
  fetchContributing,
  countStarterIssues,
  detectRepoPolicy,
  RateLimitError,
} from "./github.js";
import { scoreIssue } from "./verdict.js";
import { parseGates } from "./gates.js";
import { scoreFriction } from "./friction.js";
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

async function cmdScan(repoRef: string, asJson: boolean): Promise<void> {
  const { owner, repo } = parseRepoRef(repoRef);
  const issues = await listStarterIssues(owner, repo, 10);
  if (issues.length === 0) {
    console.log(`No open unassigned good-first-issue/help-wanted issues found in ${owner}/${repo}.`);
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
    console.log(JSON.stringify({ repo: `${owner}/${repo}`, results }, null, 2));
    return;
  }
  console.log(`Scan of ${owner}/${repo}: ${results.length} candidate issues, GO first`);
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

function usage(): void {
  console.log("greenlight: pre-flight checks for open-source contributions");
  console.log("");
  console.log("  greenlight check <issue-url> [--json]");
  console.log("  greenlight scan <owner/repo> [--json]");
  console.log("  greenlight friction <owner/repo> [--json]");
  console.log("");
  console.log("Set GITHUB_TOKEN to raise the GitHub API rate limit (60 -> 5000 req/hr).");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const positional = args.filter((a) => a !== "--json");
  const [command, target] = positional;

  try {
    if (command === "check" && target) return await cmdCheck(target, asJson);
    if (command === "scan" && target) return await cmdScan(target, asJson);
    if (command === "friction" && target) return await cmdFriction(target, asJson);
    usage();
    process.exitCode = command ? 1 : 0;
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.error(`Rate limited: ${err.message}`);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}

await main();
