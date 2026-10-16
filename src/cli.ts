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
 *   greenlight init --agent <tool> [--all] [--list] [--force] [--dry-run] [--json]
 *   greenlight doctor [--json]
 *   greenlight help [command] | greenlight <command> --help | greenlight --version
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
import { initTools, detectTools, parseAgentList, formatInitHuman, INIT_TOOLS } from "./init.js";
import { runDoctor, formatDoctorHuman } from "./doctor.js";
import { overviewText, commandHelpText, findCommand, suggestCommand, versionText } from "./help.js";

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
  if (!m) throw new Error(`Expected owner/repo like "facebook/react", got: ${ref}`);
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

function usage(): void {
  console.log(overviewText());
}

/** What each target-taking command needs, for the missing-argument error. */
const NEEDS_TARGET: Record<string, string> = {
  check: 'an issue URL, e.g. greenlight check https://github.com/owner/repo/issues/123',
  scan: "a repo, e.g. greenlight scan facebook/react",
  friction: "a repo, e.g. greenlight friction vercel/next.js",
  ci: "a PR URL, e.g. greenlight ci https://github.com/owner/repo/pull/456",
  review: "a PR URL, e.g. greenlight review https://github.com/owner/repo/pull/456",
  guard: "a PR URL, e.g. greenlight guard https://github.com/owner/repo/pull/456",
  claim: 'an issue URL, e.g. greenlight claim https://github.com/owner/repo/issues/123',
  prep: 'an issue URL, e.g. greenlight prep https://github.com/owner/repo/issues/123',
  pr: 'an issue URL plus --branch, e.g. greenlight pr https://github.com/owner/repo/issues/123 --branch fix/issue-123',
};

function collectFlagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

async function cmdInit(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  if (args.includes("--list")) {
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            tools: INIT_TOOLS.map((t) => ({
              id: t.id,
              label: t.label,
              config: t.homeDest ? `~/${t.configDest}` : t.configDest,
              instructions: t.instructionsDest ?? null,
            })),
          },
          null,
          2
        )
      );
    } else {
      console.log("Supported agents for 'greenlight init --agent <tool>':");
      for (const t of INIT_TOOLS) {
        console.log(`  ${t.id.padEnd(12)} ${t.label}`);
        console.log(`               config: ${t.homeDest ? `~/${t.configDest}` : t.configDest}`);
        if (t.instructionsDest) console.log(`               instructions: ${t.instructionsDest}`);
      }
      console.log("Example: greenlight init --agent claude-code");
    }
    return;
  }
  const ids = args.includes("--all")
    ? INIT_TOOLS.map((t) => t.id)
    : parseAgentList(collectFlagValues(args, "--agent"));
  if (ids.length === 0) {
    const detected = detectTools(process.cwd());
    throw new Error(
      "No agent selected. " +
        (detected.length > 0
          ? `Detected in this project: ${detected.join(", ")}; re-run with e.g. --agent ${detected[0]} (or --all). `
          : "") +
        "Run 'greenlight init --list' to see the supported tools."
    );
  }
  const dryRun = args.includes("--dry-run");
  const results = initTools(ids, {
    force: args.includes("--force"),
    includeInstructions: !args.includes("--no-instructions"),
    dryRun,
  });
  if (asJson) {
    console.log(JSON.stringify({ dryRun, tools: results }, null, 2));
    return;
  }
  console.log(formatInitHuman(results, dryRun));
}

async function cmdDoctor(args: string[]): Promise<void> {
  const report = await runDoctor();
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDoctorHuman(report));
  }
  if (report.checks.some((c) => c.status === "fail")) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set([
    "--json", "--yes", "--force", "--no-fallback", "--quiet",
    "--all", "--list", "--no-instructions", "--dry-run", "--help", "-h",
  ]);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flags.has(a)) continue;
    if (a === "--dir" || a === "--title" || a === "--branch" || a === "--gates-file" || a === "--agent") {
      i++; // skip the value with its flag
      continue;
    }
    positional.push(a);
  }
  const [command, target] = positional;

  try {
    if (args.includes("--version") || args.includes("-V") || command === "version") {
      console.log(versionText());
      return;
    }
    if (args.includes("--help") || args.includes("-h")) {
      const helpTarget = command && command !== "help" ? command : undefined;
      const cmd = helpTarget ? findCommand(helpTarget) : undefined;
      if (helpTarget && !cmd) {
        const suggestion = suggestCommand(helpTarget);
        console.log(
          `Unknown command "${helpTarget}".` +
            (suggestion ? ` Did you mean "${suggestion}"?` : "") +
            "\n"
        );
        process.exitCode = 1;
      }
      console.log(helpTarget && cmd ? commandHelpText(cmd) : overviewText());
      return;
    }
    if (command === "help") {
      if (target && !findCommand(target)) {
        const suggestion = suggestCommand(target);
        console.log(
          `Unknown command "${target}".` +
            (suggestion ? ` Did you mean "${suggestion}"?` : "") +
            "\n"
        );
        usage();
        process.exitCode = 1;
        return;
      }
      const cmd = target ? findCommand(target) : undefined;
      console.log(cmd ? commandHelpText(cmd) : overviewText());
      return;
    }
    if (command === "mcp") {
      // Start the MCP server (stdio). The module connects on import; stdout
      // stays pure JSON-RPC because everything above this dispatch is silent.
      await import("./index.js");
      return;
    }
    if (command === "init") return await cmdInit(args);
    if (command === "doctor") return await cmdDoctor(args);
    if (command && NEEDS_TARGET[command] && !target) {
      console.error(`Error: greenlight ${command} needs ${NEEDS_TARGET[command]}.`);
      console.log(commandHelpText(findCommand(command)!));
      process.exitCode = 1;
      return;
    }
    if (command === "check" && target) return await cmdCheck(target, args.includes("--json"), args);
    if (command === "scan" && target) return await cmdScan(target, args.includes("--json"), args);
    if (command === "friction" && target) return await cmdFriction(target, args.includes("--json"));
    if (command === "ci" && target) return await cmdCi(target, args.includes("--json"));
    if (command === "review" && target) return await cmdReview(target, args.includes("--json"));
    if (command === "guard" && target) return await cmdGuard(target, args);
    if (command === "claim" && target) return await cmdClaim(target, args);
    if (command === "prep" && target) return await cmdPrep(target, args);
    if (command === "pr" && target) return await cmdPr(target, args);
    if (!command) {
      usage();
      return;
    }
    const suggestion = suggestCommand(command);
    console.error(
      `Error: unknown command "${command}".` +
        (suggestion ? ` Did you mean "${suggestion}"?` : "") +
        " Run 'greenlight help' to see all commands."
    );
    process.exitCode = 1;
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
