#!/usr/bin/env node
/**
 * Greenlight CLI.
 *
 *   greenlight check <issue-url> [--json] [--gates-file path]
 *   greenlight scan <owner/repo> [--json] [--no-fallback] [--gates-file path]
 *   greenlight mcp
 *   greenlight friction <owner/repo> [--json]
 *   greenlight ci <pr-url> [--json]
 *   greenlight review <pr-url> [--json]
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
import { parseGates, parseGatefileJson } from "./gates.js";
import type { Gate } from "./types.js";
import { existsSync, readFileSync } from "node:fs";
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
import { fetchMergeVelocity, describeMergeVelocity } from "./merge-velocity.js";
import { triagePr } from "./ci-triage.js";
import { triageReview } from "./review-triage.js";
import { guardPr, readGuardConfig } from "./guard.js";
import { digestRepo, DEFAULT_DIGEST_LIMIT } from "./digest.js";

const SYMBOL: Record<string, string> = {
  GO: "[GO]",
  RISKY: "[RISKY]",
  TAKEN: "[TAKEN]",
  GATED: "[GATED]",
  STALE: "[STALE]",
};

function printVerdict(snapshot: { sourceUrl: string; title: string; owner: string; repo: string; number: number; duplicateOf?: Array<{ number: number; url: string; state: string; stateReason?: string }> }, result: VerdictResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify({ issue: snapshot.sourceUrl, title: snapshot.title, verdict: result.verdict, reasons: result.reasons, flags: result.flags, claims: result.claims, gates: result.gates, duplicateOf: snapshot.duplicateOf ?? [] }, null, 2));
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
  const softClaims = result.claims.filter((c) => c.strength === "soft");
  if (softClaims.length > 0) {
    console.log(`  soft claims: ${softClaims.map((c) => `${c.author} (${c.ageDays}d, ${c.phrase})`).join("; ")}`);
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

/**
 * Gates from a gatefile contribution-gates.json when one is in play: the
 * --gates-file value when given, else ./contribution-gates.json in the
 * working directory (the file gatefile exists to commit). This is the
 * pipeline between the two tools: extract once with gatefile, and every
 * later check/scan reads the committed answer instead of re-deriving it.
 */
function loadExternalGates(args: string[]): Gate[] | undefined {
  const idx = args.indexOf("--gates-file");
  const path = idx >= 0 ? args[idx + 1] : existsSync("contribution-gates.json") ? "contribution-gates.json" : undefined;
  if (!path) return undefined;
  try {
    return parseGatefileJson(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`could not use gates file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdCheck(issueUrl: string, asJson: boolean, args: string[]): Promise<void> {
  const { owner, repo, number } = parseIssueUrl(issueUrl);
  const snapshot = await buildIssueSnapshot(owner, repo, number);
  snapshot.externalGates = loadExternalGates(args);
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
  const externalGates = loadExternalGates(args);
  const results: Array<{ url: string; title: string; verdict: string; reasons: string[]; flags: string[] }> = [];
  for (const issue of issues) {
    try {
      const snapshot = await buildIssueSnapshot(owner, repo, issue.number);
      snapshot.externalGates = externalGates;
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

  // Merge velocity is a signal, never a score input. Best-effort: one
  // /pulls call, silent when it fails.
  try {
    report.mergeVelocity = await fetchMergeVelocity(owner, repo);
  } catch {
    report.mergeVelocity = null;
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Friction for ${owner}/${repo}: ${report.score}/100 (100 = easiest)`);
  for (const reason of report.reasons) console.log(`  - ${reason}`);
  if (report.reasons.length === 0) console.log("  - no gates or penalties detected");
  if (starterCount !== null) console.log(`  open starter issues: ${starterCount}`);
  if (report.mergeVelocity) console.log(`  merge velocity: ${describeMergeVelocity(report.mergeVelocity)}`);
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
          claPath: plan.prepDetail?.claPath ?? null,
          changeset: plan.prepDetail?.changeset ?? null,
          fixLivesHereWarnings: plan.prepDetail?.fixLivesHereWarnings ?? [],
          houseRulesSummary: plan.prepDetail?.houseRulesSummary ?? [],
        },
        null,
        2
      )
    );
    return;
  }
  if (plan.prepDetail && plan.prepDetail.fixLivesHereWarnings.length > 0) {
    for (const w of plan.prepDetail.fixLivesHereWarnings) console.log(`\n${w.line}`);
  }
  if (plan.prepDetail && plan.prepDetail.houseRulesSummary.length > 0) {
    console.log(`\nHouse rules:`);
    for (const h of plan.prepDetail.houseRulesSummary) console.log(`  - ${h}`);
  }
  if (plan.prepDetail) {
    const c = plan.prepDetail.claPath;
    console.log(`\nSigning: ${c.kind === "none" ? c.method : `${c.method}`}${c.link ? ` ${c.link}` : ""}`);
    if (c.signaturePhrase) console.log(`  phrase: "${c.signaturePhrase}"`);
  }
  if (plan.prepDetail?.changeset) {
    console.log(`Release-note artifact: ${plan.prepDetail.changeset.example}`);
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

async function cmdCi(prUrl: string, asJson: boolean): Promise<void> {
  const result = await triagePr(prUrl);
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`CI triage for ${result.pr}`);
  console.log(`  ${result.title}`);
  console.log(`  head ${result.headSha.slice(0, 7)} <- base ${result.baseRef}`);
  if (result.checks.length === 0) {
    console.log(`  No failing checks on the PR head.`);
    console.log(`Verdict: ${result.verdict}`);
    return;
  }
  for (const c of result.checks) {
    console.log(`  [${c.class}] ${c.name}`);
    console.log(`    ${c.evidence}`);
    if (c.lean) console.log(`    lean: ${c.lean}`);
    if (c.detailsUrl) console.log(`    ${c.detailsUrl}`);
    if (c.failureLines) for (const line of c.failureLines) console.log(`    > ${line}`);
  }
  console.log(`Verdict: ${result.verdict}`);
}

async function cmdReview(prUrl: string, asJson: boolean): Promise<void> {
  const result = await triageReview(prUrl);
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Review triage for ${result.pr}`);
  console.log(`  ${result.title}`);
  if (result.findings.length === 0) {
    const c = result.counts;
    console.log(`  No actionable findings (noise: ${c.noise}, resolved: ${c.resolved}).`);
    console.log(`Verdict: ${result.verdict}`);
    return;
  }
  const groups: Array<[string, string]> = [
    ["likely-real", "LIKELY REAL - fix these"],
    ["needs-decision", "NEEDS DECISION - your call"],
    ["likely-noise", "LIKELY NOISE - probably push back"],
  ];
  for (const [cls, heading] of groups) {
    const items = result.findings.filter((f) => f.class === cls);
    if (items.length === 0) continue;
    console.log(`\n${heading}`);
    for (const f of items) {
      const anchor = f.path ? ` (${f.path}${f.line ? `:${f.line}` : ""})` : "";
      console.log(`  [${f.author}] ${f.summary}${anchor}`);
      console.log(`    why: ${f.reason}`);
      console.log(`    draft reply: ${f.draft}`);
    }
  }
  const c = result.counts;
  console.log(`\nSummary: ${c.likelyReal} likely-real, ${c.needsDecision} needs-decision, ${c.likelyNoise} likely-noise (noise: ${c.noise}, resolved: ${c.resolved})`);
  console.log(`Verdict: ${result.verdict}`);
}

async function cmdGuard(prUrl: string, args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const quiet = args.includes("--quiet");
  const result = await guardPr(prUrl, {}, readGuardConfig());
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!quiet || result.hasFindings) {
    console.log(result.markdown);
  }
  // Exit code 3 means findings exist, so a GitHub Action can decide whether
  // to comment or block. Nothing flagged is exit 0, usage errors are exit 1.
  if (result.hasFindings) process.exitCode = 3;
}

async function cmdDigest(repoRef: string, args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const limitRaw = flagValue(args, "--limit");
  const limit = limitRaw ? Math.max(1, Math.min(100, Number(limitRaw) || DEFAULT_DIGEST_LIMIT)) : DEFAULT_DIGEST_LIMIT;
  const { owner, repo } = parseRepoRef(repoRef);
  const result = await digestRepo(owner, repo, limit);
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.markdown);
  }
  // Exit code 3 when races exist mirrors the guard: a CI job can run the
  // digest nightly and alert only when work is being duplicated.
  if (args.includes("--fail-on-race") && result.hasRaces) process.exitCode = 3;
}

function usage(): void {
  console.log("greenlight: pre-flight checks for open-source contributions");
  console.log("");
  console.log("  greenlight check <issue-url> [--json] [--gates-file path]");
  console.log("  greenlight scan <owner/repo> [--json] [--no-fallback] [--gates-file path]");
  console.log("  greenlight mcp   (run the MCP server on stdio)");
  console.log("  greenlight friction <owner/repo> [--json]");
  console.log("  greenlight ci <pr-url> [--json]   (CI failure triage: is the red check yours or pre-existing?)");
  console.log("  greenlight review <pr-url> [--json]   (review triage: which review comments need you, with reply drafts)");
  console.log("  greenlight guard <pr-url> [--json] [--quiet]   (maintainer-side: is this incoming PR worth your time? exit 3 when flagged)");
  console.log("  greenlight digest <owner/repo> [--json] [--limit N] [--fail-on-race]   (repo-level: PR races, claimed-by-other, stale claims, assignment conflicts)");
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
  const flags = new Set(["--json", "--yes", "--force", "--no-fallback", "--quiet", "--fail-on-race"]);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flags.has(a)) continue;
    if (a === "--dir" || a === "--title" || a === "--branch" || a === "--gates-file" || a === "--limit") {
      i++; // skip the value with its flag
      continue;
    }
    positional.push(a);
  }
  const [command, target] = positional;

  try {
    if (command === "mcp") {
      // Start the MCP server (stdio). The module connects on import; stdout
      // stays pure JSON-RPC because everything above this dispatch is silent.
      await import("./index.js");
      return;
    }
    if (command === "check" && target) return await cmdCheck(target, args.includes("--json"), args);
    if (command === "scan" && target) return await cmdScan(target, args.includes("--json"), args);
    if (command === "friction" && target) return await cmdFriction(target, args.includes("--json"));
    if (command === "ci" && target) return await cmdCi(target, args.includes("--json"));
    if (command === "review" && target) return await cmdReview(target, args.includes("--json"));
    if (command === "guard" && target) return await cmdGuard(target, args);
    if (command === "digest" && target) return await cmdDigest(target, args);
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
