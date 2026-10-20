#!/usr/bin/env node
/**
 * Greenlight CLI.
 *
 *   greenlight check <issue-url> [--json] [--gates-file path]
 *   greenlight scan <owner/repo> [--json] [--no-fallback] [--gates-file path]
 *   greenlight wave [--index url|path] [--repos N] [--min-share N] [--stars lo,hi] [--issues-per-repo N] [--min-budget N] [--json]
 *   greenlight mcp
 *   greenlight friction <owner/repo> [--json]
 *   greenlight ci <pr-url> [--json]
 *   greenlight review <pr-url> [--json]
 *   greenlight claim <issue-url> [--yes] [--force] [--json]
 *   greenlight prep <issue-url> [--dir path] [--yes] [--json]
 *   greenlight pr <issue-url> --branch <name> [--title t] [--yes] [--json]
 *   greenlight verify-comment <issue-url> [--json] [--from-file notes.md]
 *   greenlight verify [--base <ref>] [--cmd "<test command>"] [--parser node:test|pytest] [--allow-dirty] [--json]
 *   greenlight ci-prep <path> [--base <ref>] [--json] [--act]
 *   greenlight babysit [--prs urls] [--mine --repos o/r] [--account] [--claims-only] [--json]
 *   greenlight autopilot [--author login] [--prs urls] [--max-prs N] [--apply] [--max-fixes N] [--json]
 *   greenlight bounty <issue-url> [--json]
 *   greenlight sync [--author login] [--tracker csv|json] [--stale-days N] [--write] [--json]
 *   greenlight portfolio [--author login] [--json]
 *   greenlight init [--agent <tool>...] [--dry-run] [--force]
 *   greenlight doctor [--json]
 *   greenlight help [command]   (or <command> --help)
 *   greenlight version   (or --version)
 *
 * Set GITHUB_TOKEN for the 5000 req/hr authenticated rate limit.
 * The claim/prep/pr commands default to a DRY RUN: nothing is posted or
 * created without --yes, and writes require GITHUB_TOKEN (or GH_TOKEN).
 */
import {
  parseIssueUrl,
  buildIssueSnapshot,
  scanCandidates,
  RateLimitError,
  fetchComments,
  apiCallsUsed,
  resolveCanonicalRepo,
} from "./github.js";
import { xrayIssue, xrayIssues, sortXrayResults, applyXrayDemotion } from "./xray.js";
import { CLAIM_MARKER } from "./protocol.js";
import { llmEnabled, llmModelId } from "./llm-claims.js";
import type { LlmLayerStatus } from "./types.js";
import {
  checkPacing,
  pacingConfigFromEnv,
  pacingSummary,
  readLedger,
} from "./posting-ledger.js";
import { scoreIssue } from "./verdict.js";
import { parseGatefileJson } from "./gates.js";
import type { Gate } from "./types.js";
import { existsSync, readFileSync } from "node:fs";
import { fetchFrictionSummary } from "./friction.js";
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
import { describeMergeVelocity } from "./merge-velocity.js";
import { triagePr } from "./ci-triage.js";
import { triageReview } from "./review-triage.js";
import { guardPr, readGuardConfig } from "./guard.js";
import { digestRepo, DEFAULT_DIGEST_LIMIT } from "./digest.js";
import { checkIssueWithProtocol, computeIssueStatus } from "./protocol-fetch.js";
import { defaultRegistryPath, registerClaim } from "./claims-registry.js";
import { importLedgerClaims, importUrlList } from "./claim-import.js";
import { resolveProxyConfig, startProxy, proxyClientEnv, PROXY_DEFAULT_PORT, PROXY_UPSTREAM } from "./proxy.js";
import { scoutCampaign, SCOUT_DEFAULT_BUDGET } from "./scout.js";
import {
  buildVerifiedComment,
  suggestsVerifiedComment,
  verifiedCommentSuggestion,
  parseNoteFile,
  type VerifiedCommentInput,
} from "./verify-comment.js";
import { verifyRepo } from "./verify.js";
import { runCiPrep, formatCiPrepHuman } from "./ci-prep.js";
import { radarPRs } from "./radar.js";
import { briefPR } from "./brief.js";
import { babysit, defaultStatePath, defaultAccountAuthor } from "./babysit.js";
import { runAutopilot, defaultAutopilotStatePath } from "./autopilot.js";
import { runSync, formatSyncHuman, syncJson } from "./sync.js";
import {
  runWave,
  liveWaveDeps,
  loadPolicyIndex,
  formatWaveHuman,
  POLICY_INDEX_URL,
  DEFAULT_WAVE_FILTERS,
  type WaveFilters,
} from "./wave.js";
import { runPortfolio, formatPortfolioHuman, portfolioJson } from "./portfolio.js";
import { runShipcheck, formatShipcheckHuman } from "./shipcheck.js";
import { runPreflight, formatPreflightHuman } from "./preflight.js";
import { detectBehavioralGate, type BehavioralGate } from "./behavior.js";
import {
  viaApiClaim,
  viaApiRelease,
  viaApiHeartbeat,
  deviceFlowLogin,
  browserLoginFlow,
  defaultTokenStore,
  resolveApiBase,
  type ViaApiClaimResult,
  type ViaApiWriteResult,
} from "./claim-api.js";
import { buildEvidencePack } from "./evidence.js";
import { buildPassport } from "./passport.js";
import { detectBountyForIssue } from "./bounty.js";
import { renderLabelsDryRun } from "./guard.js";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initTools, parseAgentList, detectTools, formatInitHuman, INIT_TOOLS } from "./init.js";
import { runDoctor, formatDoctorHuman } from "./doctor.js";
import {
  overviewText,
  helpText,
  versionText,
  findCommand,
  commandHelpText,
  NEEDS_TARGET,
} from "./help.js";

// The one real fact the verified-comment footer is allowed to state about
// the tool itself. Read from package.json so the version can never drift
// from the shipped package.
const GREENLIGHT_VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
})();

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
  const llmClaims = result.llm_claims ?? [];
  if (llmClaims.length > 0) {
    console.log(
      `  ai claim signals: ${llmClaims.map((f) => `@${f.author} (${f.confidence.toFixed(2)}): "${f.quote}"`).join("; ")}`
    );
  }
  // v0.9.2: the AI claim layer always says whether it ran, so a dead
  // layer can never hide behind patterns-only output again.
  const llmStatus = result.llm_status;
  if (llmStatus) {
    console.log(
      llmStatus.ran
        ? `  ai claim layer: on (${llmStatus.model ?? "unknown model"})`
        : `  ai claim layer: off (${llmStatus.reason ?? "unknown reason"})`
    );
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
  const parsed = parseIssueUrl(issueUrl);
  // v0.18.0 (item 15): resolve renames before any name-based fetch.
  const canon = await resolveCanonicalRepo(parsed.owner, parsed.repo);
  const { owner, repo } = canon;
  const number = parsed.number;
  const renameNote = canon.renamed
    ? `repo renamed: ${parsed.owner}/${parsed.repo} -> ${canon.fullName}`
    : null;
  // The check pipeline merges the legacy verdict with the Claim Protocol
  // state: a protocol claim verdict overrides legacy claim inference, but
  // never gates or cross-referenced PR evidence (see mergeProtocolVerdict).
  // v0.16.2: the behavioral pass runs once per check (opt out with
  // --no-behavioral); a detected gate caps the verdict at GATED.
  let behavioralGate: BehavioralGate | null = null;
  if (!args.includes("--no-behavioral")) {
    behavioralGate = await detectBehavioralGate(owner, repo);
  }
  const { snapshot, merged } = await checkIssueWithProtocol(owner, repo, number, {
    externalGates: loadExternalGates(args),
    behavioralGate,
  });
  const result: VerdictResult = {
    verdict: merged.verdict,
    reasons: merged.reasons,
    flags: merged.flags,
    claims: merged.claims,
    gates: merged.gates,
    llm_claims: merged.llm_claims,
    llm_status: merged.llm_status,
  };
  // Maintainer-only repos (inspector, servers) close outside PRs on sight;
  // the contribution that lands is a verified issue comment. Say so right
  // in the check, so nobody wastes a build on a PR that cannot land.
  const suggestion = suggestsVerifiedComment(merged.gates)
    ? verifiedCommentSuggestion(snapshot.sourceUrl)
    : null;
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          issue: snapshot.sourceUrl,
          title: snapshot.title,
          verdict: merged.verdict,
          reasons: merged.reasons,
          flags: merged.flags,
          claims: merged.claims,
          gates: merged.gates,
          duplicateOf: snapshot.duplicateOf ?? [],
          protocol: merged.protocol,
          llm_claims: merged.llm_claims ?? [],
          llm_status: merged.llm_status ?? null,
          suggestion,
          renamedFrom: renameNote ? `${parsed.owner}/${parsed.repo}` : null,
        },
        null,
        2
      )
    );
    return;
  }
  if (renameNote) console.log(renameNote);
  printVerdict(snapshot, result, false);
  for (const line of merged.protocolLines) console.log(`  ${line}`);
  if (suggestion) console.log(`  ${suggestion}`);
}

/**
 * `greenlight status`: the Claim Protocol pre-flight answer for one issue:
 * who holds it, until when, who is queued, which PRs compete, which gates
 * bite, and whether the repo honors the protocol at all.
 */
async function cmdStatus(issueUrl: string, asJson: boolean): Promise<void> {
  const { owner, repo, number } = parseIssueUrl(issueUrl);
  const { status } = await computeIssueStatus(owner, repo, number);
  if (asJson) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  const sym = status.verdict ? SYMBOL[status.verdict] : "[?]";
  console.log(`${sym} ${owner}/${repo}#${number} (Claim Protocol status)`);
  if (status.verdict && status.reason) {
    console.log(`  ${status.reason}`);
  }
  if (status.claim) {
    const c = status.claim;
    console.log(
      `  claim: @${c.claimant}, ${c.state}, claimed ${c.claimed_at.slice(0, 10)}, expires ${c.expires_at.slice(0, 10)}`
    );
    if (c.queue.length > 0) {
      console.log(`  queue: ${c.queue.map((q) => `@${q.claimant} (#${q.position})`).join(", ")}`);
    }
    if (c.over_cap) console.log(`  note: claimant is over the active-claim cap (squatting flag)`);
  } else {
    console.log(`  no protocol claims on this issue`);
  }
  if (status.competing_prs.length > 0) {
    console.log(
      `  competing PRs: ${status.competing_prs.map((p) => `#${p.number} (${p.state}) by @${p.author}`).join("; ")}`
    );
  }
  const detected = status.gates.filter((g) => g.detected);
  console.log(`  gates: ${detected.length > 0 ? detected.map((g) => g.kind).join(", ") : "none detected"}`);
  console.log(
    `  protocol ${status.repo_protocol ? `honored by repo (lease ${status.repo_protocol.lease_days}d)` : "not adopted by this repo; claims read as signals only"}`
  );
  console.log(
    `  checked at ${status.checked_at} (fresh for ${Math.round(status.stale_after_seconds / 3600)}h)`
  );
  // Pacing (v0.9.2): the local posting ledger keeps claim cadence visible
  // so the tool never trips GitHub's anti-spam flag the way the 2026-10-17
  // campaign pace did.
  for (const line of pacingSummary(checkPacing(readLedger(), Date.now(), pacingConfigFromEnv()))) {
    console.log(`  ${line}`);
  }
}

async function cmdScan(repoRef: string, asJson: boolean, args: string[]): Promise<void> {
  const parsed = parseRepoRef(repoRef);
  // v0.18.0 (item 15): the old name 422s the candidate search; resolve
  // first and say so in the output.
  const canon = await resolveCanonicalRepo(parsed.owner, parsed.repo);
  const { owner, repo } = canon;
  const scanRenameNote = canon.renamed ? `repo renamed: ${parsed.owner}/${parsed.repo} -> ${canon.fullName}` : null;
  if (scanRenameNote && !asJson) console.log(scanRenameNote);
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
  // v0.16.2: one behavioral pass per scan, shared across the issue loop
  // (opt out with --no-behavioral); a detected gate caps each verdict at
  // GATED.
  let behavioralGate: BehavioralGate | null = null;
  if (!args.includes("--no-behavioral")) {
    behavioralGate = await detectBehavioralGate(owner, repo);
  }
  const results: Array<{
    number: number;
    url: string;
    title: string;
    verdict: string;
    reasons: string[];
    flags: string[];
    llm_status: LlmLayerStatus | null;
  }> = [];
  // Scan runs the same per-issue pipeline as check (v0.9.0): legacy
  // verdict, optional AI claim layer, merged with the Claim Protocol.
  // Field lesson 2026-10-17: a scan that ran the deterministic verdict
  // alone missed two explicit soft claims ("Working on this.", "I'm
  // going to reproduce this on current main and fix...") that the
  // check pipeline's LLM layer was built to catch. The protocol state
  // costs extra API calls per issue; the scan's 10-issue cap and the
  // budget notes in help keep that visible.
  for (const issue of issues) {
    try {
      const { merged } = await checkIssueWithProtocol(owner, repo, issue.number, { externalGates, behavioralGate });
      results.push({
        number: issue.number,
        url: issue.url,
        title: issue.title,
        verdict: merged.verdict,
        reasons: merged.reasons,
        flags: merged.flags,
        llm_status: merged.llm_status ?? null,
      });
    } catch (err) {
      results.push({
        number: issue.number,
        url: issue.url,
        title: issue.title,
        verdict: "ERROR",
        reasons: [err instanceof Error ? err.message : String(err)],
        flags: [],
        llm_status: null,
      });
    }
  }
  const rank: Record<string, number> = { GO: 0, RISKY: 1, GATED: 2, STALE: 3, TAKEN: 4, ERROR: 5 };
  results.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9));

  // v0.13.0 --deep: Timeline X-Ray over the ranked candidates. The check
  // pipeline already reads timelines, but X-Ray adds the reporter-owned-PR
  // strengthening (a mention-strength PR by the issue reporter is the
  // classic hidden trap) and per-PR evidence. Anything the x-ray finds
  // worse than the check verdict demotes the issue before presentation.
  let deepVerified = 0;
  if (args.includes("--deep") && results.length > 0) {
    for (const r of results) {
      try {
        const xr = await xrayIssue(owner, repo, r.number);
        deepVerified++;
        applyXrayDemotion(r, xr);
      } catch {
        // X-Ray is best-effort; the check verdict stands.
      }
    }
    results.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9));
  }

  if (asJson) {
    console.log(JSON.stringify({ repo: `${owner}/${repo}`, renamedFrom: canon.renamed ? `${parsed.owner}/${parsed.repo}` : null, fallback: fallbackUsed, results }, null, 2));
    return;
  }
  console.log(`Scan of ${owner}/${repo}: ${results.length} candidate issues, GO first`);
  if (args.includes("--deep")) {
    console.log(`  timeline x-ray: deep-verified ${deepVerified}/${results.length} (reporter-owned PRs + per-PR evidence)`);
  }
  // v0.9.2: say whether the AI claim layer ran on this scan. Per-issue
  // statuses ride in the JSON; the human line states the environment.
  console.log(
    llmEnabled()
      ? `  ai claim layer: on (${llmModelId()}); per-issue layer status in --json`
      : `  ai claim layer: off (FIREWORKS_API_KEY not set); verdicts are patterns-only`
  );
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

async function cmdXray(repoRef: string, args: string[]): Promise<void> {
  const { owner, repo } = parseRepoRef(repoRef);
  const asJson = args.includes("--json");
  const issuesFlag = flagValue(args, "--issues");
  const limitRaw = flagValue(args, "--limit");
  const limit = limitRaw !== undefined ? Math.max(1, Math.trunc(Number(limitRaw)) || 10) : 10;
  let numbers: number[] = [];
  if (issuesFlag) {
    numbers = issuesFlag
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (numbers.length === 0) {
      console.error("Error: --issues needs comma-separated issue numbers, e.g. --issues 8149,9319");
      process.exitCode = 1;
      return;
    }
  } else {
    // --from-scan or default: x-ray the scan's top candidates.
    const { issues } = await scanCandidates(owner, repo, {
      fallback: !args.includes("--no-fallback"),
      limit,
    });
    numbers = issues.map((i) => i.number);
    if (numbers.length === 0) {
      console.log(`No candidate issues found in ${owner}/${repo}.`);
      return;
    }
  }
  numbers = numbers.slice(0, limit);
  const callsBefore = apiCallsUsed();
  const results = sortXrayResults(await xrayIssues(owner, repo, numbers));
  const totalCalls = apiCallsUsed() - callsBefore;

  if (asJson) {
    console.log(
      JSON.stringify({ repo: `${owner}/${repo}`, deep_verified: true, api_calls: totalCalls, results }, null, 2)
    );
    return;
  }
  console.log(
    `Timeline X-Ray of ${owner}/${repo}: ${results.length} issues deep-verified (${totalCalls} API calls)`
  );
  for (const r of results) {
    console.log(`\n${SYMBOL[r.verdict] ?? "[?]"} #${r.number} ${r.title}`);
    console.log(`  ${r.url}`);
    for (const reason of r.reasons) console.log(`  - ${reason}`);
    if (r.linkedPRs.length > 0) {
      console.log(`  linked PRs:`);
      for (const pr of r.linkedPRs) {
        console.log(
          `    #${pr.number} [${pr.state}/${pr.linkStrength}${pr.via ? `/${pr.via}` : ""}]${pr.reporterOwned ? " reporter's own" : ""} ${pr.url}`
        );
      }
    }
    if (r.flags.length > 0) console.log(`  flags: ${r.flags.join(", ")}`);
  }
}

async function cmdFriction(repoRef: string, asJson: boolean, args: string[] = []): Promise<void> {
  const { owner, repo } = parseRepoRef(repoRef);
  // v0.9.3: one shared pipeline (fetchFrictionSummary) for the CLI, the
  // MCP repo_friction tool, and preflight, so gates come from the full
  // policy source set everywhere instead of a single CONTRIBUTING read.
  // v0.16.0: the behavioral gate pass (maintainer actions, not policy
  // text) is part of the report; --no-behavioral skips its API cost.
  const report = await fetchFrictionSummary(owner, repo, {
    behavioral: !args.includes("--no-behavioral"),
  });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Friction for ${report.owner}/${report.repo}: ${report.score}/100 (100 = easiest)`);
  if (report.resolvedFrom) console.log(`  repo renamed: ${report.resolvedFrom} -> ${report.owner}/${report.repo}`);
  for (const reason of report.reasons) console.log(`  - ${reason}`);
  if (report.reasons.length === 0) console.log("  - no gates or penalties detected");
  if (report.behavioral_gate?.detected) {
    const n = report.behavioral_gate.strength;
    console.log(`  BEHAVIORAL GATE: maintainer rejects AI-built PRs in practice (${n} signal${n === 1 ? "" : "s"})`);
    for (const ev of report.behavioral_gate.evidence) {
      console.log(`    - PR #${ev.pr} by @${ev.author}: "${ev.quote}" (${ev.url})`);
    }
  } else if (report.behavioral_gate && report.behavioral_gate.evidence.length > 0) {
    console.log(`  behavioral note: ${report.behavioral_gate.note}`);
  }
  const starterCount = report.signals.openGoodFirstIssueCount ?? null;
  if (starterCount !== null) console.log(`  open starter issues: ${starterCount}`);
  if (report.mergeVelocity) console.log(`  merge velocity: ${describeMergeVelocity(report.mergeVelocity)}`);
}

/**
 * v0.16.0: turn the Agent Policy Index into a build queue in one command.
 * Filters pure-open repos, x-rays starter issues with the existing xray
 * engine, excludes behavioral gates, and skips repos where you already
 * have an open PR. Stops with partial results under the budget floor.
 */
async function cmdWave(args: string[]): Promise<void> {
  const numFlag = (name: string): number | undefined => {
    const v = flagValue(args, name);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const starsRaw = flagValue(args, "--stars");
  let minStars = DEFAULT_WAVE_FILTERS.minStars;
  let maxStars = DEFAULT_WAVE_FILTERS.maxStars;
  if (starsRaw) {
    const [lo, hi] = starsRaw.split(",").map(Number);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi) {
      minStars = lo;
      maxStars = hi;
    }
  }
  const filters: WaveFilters = {
    minShare: numFlag("--min-share") ?? DEFAULT_WAVE_FILTERS.minShare,
    minStars,
    maxStars,
    maxRepos: numFlag("--repos") ?? DEFAULT_WAVE_FILTERS.maxRepos,
    issuesPerRepo: numFlag("--issues-per-repo") ?? DEFAULT_WAVE_FILTERS.issuesPerRepo,
    minBudget: numFlag("--min-budget") ?? DEFAULT_WAVE_FILTERS.minBudget,
    sort: flagValue(args, "--sort") === "stars" ? "stars" : undefined,
  };
  const indexSource = flagValue(args, "--index") ?? POLICY_INDEX_URL;
  const asJson = args.includes("--json");
  let index;
  try {
    index = await loadPolicyIndex(indexSource);
  } catch (err) {
    console.error(`Error: could not load the policy index from ${indexSource}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  const result = await runWave(index, filters, liveWaveDeps());
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(formatWaveHuman(result));
  if (result.partial) process.exitCode = 2;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function cmdClaim(issueUrl: string, args: string[]): Promise<void> {
  // --import backfills the my-claims registry (Ledger or manual URL list);
  // it takes no issue URL, so it runs before the issue parsing below.
  if (args.includes("--import") || issueUrl === "--import") {
    const ledgerUser = flagValue(args, "--ledger-user");
    const urlsRaw = flagValue(args, "--urls");
    if (!ledgerUser && !urlsRaw) {
      console.error("Error: greenlight claim --import needs --ledger-user <github-login> or --urls <issue-url,...>.");
      process.exitCode = 1;
      return;
    }
    const registryPath = defaultRegistryPath();
    const result = ledgerUser
      ? await importLedgerClaims(registryPath, ledgerUser)
      : importUrlList(registryPath, urlsRaw!.split(","));
    if (ledgerUser) {
      console.log(`Scanned ${result.reposScanned} repos on the Claim Ledger for @${ledgerUser}.`);
    }
    console.log(`Imported ${result.added} claim${result.added === 1 ? "" : "s"} into the my-claims registry (${registryPath}).`);
    if (result.skipped > 0) console.log(`Skipped ${result.skipped} (already registered, another claimant, or a retired state).`);
    for (const c of result.claims) console.log(`  + ${c.issueUrl}`);
    console.log(`The babysitter watches them from now on.`);
    return;
  }

  const { owner, repo, number } = parseIssueUrl(issueUrl);
  // v0.9.0: claim runs the same pipeline as check (protocol + optional
  // LLM claim layer), so the 30-day classification cache is shared
  // across check, scan and claim instead of being per-command.
  const etaRaw = flagValue(args, "--eta-days");
  const etaDays = etaRaw !== undefined ? Number(etaRaw) : undefined;

  // --register records a claim posted by other means (a comment you wrote
  // by hand, a maintainer's assignment) without touching the API.
  if (args.includes("--register")) {
    registerClaim(defaultRegistryPath(), {
      issueUrl: `https://github.com/${owner}/${repo}/issues/${number}`,
      owner, repo, number,
      postedAt: new Date().toISOString(),
      etaDays,
      claimant: flagValue(args, "--as") ?? null,
    });
    console.log(`Registered claim on ${owner}/${repo}#${number} in the my-claims registry (${defaultRegistryPath()}).`);
    console.log(`The babysitter watches it from now on.`);
    return;
  }

  // --via-api: claim through the hosted claim API (app-aware path
  // selection, TAKEN pre-flight, single re-auth on 401). Dry run unless
  // --yes.
  if (args.includes("--via-api")) {
    return await cmdClaimViaApi(issueUrl, args);
  }

  const { snapshot, merged } = await checkIssueWithProtocol(owner, repo, number, {});
  printVerdict(snapshot, merged, false);
  const minIntervalRaw = flagValue(args, "--min-interval");
  // Pacing (v0.9.2) reconciliation: an unconfirmed earlier claim attempt is
  // re-checked against the issue's comments before any repost. The live
  // client lists comments; a claim comment carrying the protocol marker
  // from the current viewer (or any author) means the post landed.
  const restClient = createRestClient();
  const plan: ClaimResult = await claimIssue(restClient, snapshot, {
    yes: args.includes("--yes"),
    force: args.includes("--force"),
    plan: flagValue(args, "--plan"),
    etaDays,
    minIntervalS: minIntervalRaw !== undefined ? Number(minIntervalRaw) : undefined,
    confirmPost: async () => {
      try {
        const comments = await fetchComments(owner, repo, number);
        let viewer: string | undefined;
        try {
          viewer = await restClient.getViewer();
        } catch {
          viewer = undefined;
        }
        return comments.some(
          (c) => c.body.includes(CLAIM_MARKER) && (!viewer || c.author === viewer)
        );
      } catch {
        return false;
      }
    },
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
    // The campaign's memory: a posted claim joins the my-claims registry
    // so the babysitter watches its health.
    registerClaim(defaultRegistryPath(), {
      issueUrl: snapshot.sourceUrl,
      owner, repo, number,
      postedAt: new Date().toISOString(),
      etaDays,
      commentUrl: plan.commentUrl ?? undefined,
    });
    console.log(`Registered in the my-claims registry.`);
  } else {
    console.log(`\nDry run: claim comment NOT posted.`);
    console.log(`--- comment that would be posted on ${owner}/${repo}#${number} ---`);
    console.log(plan.commentBody);
    console.log(`---`);
    console.log(`Re-run with --yes (and GITHUB_TOKEN set) to post it.`);
    // Pacing posture (v0.9.2): informational in dry runs; enforced on post.
    const dryPacing = checkPacing(readLedger(), Date.now(), pacingConfigFromEnv());
    for (const line of pacingSummary(dryPacing)) console.log(`  ${line}`);
  }
}

/**
 * `greenlight auth`: sign in to the hosted claim API.
 *   login           GitHub device flow (Option 1); prints the user code.
 *   login --browser browser OAuth grant, paste the session token (Option 2).
 *   status          show what is stored and where.
 *   logout          forget the stored token.
 * Option 3 needs no login: --token or GREENLIGHT_API_TOKEN passthrough.
 */
async function cmdAuth(sub: string | undefined, args: string[]): Promise<void> {
  const store = await defaultTokenStore();
  if (sub === "login") {
    if (args.includes("--browser")) {
      await browserLoginFlow({
        apiBase: flagValue(args, "--api-base"),
        store,
      });
      console.log(`Signed in (browser session token stored in ${store.describe()}).`);
    } else {
      const result = await deviceFlowLogin({
        clientId: flagValue(args, "--client-id"),
        store,
      });
      console.log(
        `Signed in as @${result.login ?? "unknown"} (GitHub token stored in ${store.describe()}).`
      );
    }
    return;
  }
  if (sub === "status") {
    const stored = await store.get();
    if (!stored) {
      console.log(`Not signed in. Run greenlight auth login, or pass --token / set GREENLIGHT_API_TOKEN.`);
      console.log(`Token store: ${store.describe()}.`);
      return;
    }
    console.log(`Signed in${stored.login ? ` as @${stored.login}` : ""} (${stored.kind} token, stored ${stored.storedAt.slice(0, 10)}).`);
    console.log(`Token store: ${store.describe()}.`);
    return;
  }
  if (sub === "logout") {
    await store.clear();
    console.log(`Signed out (stored token cleared).`);
    return;
  }
  console.error("Usage: greenlight auth <login [--browser] | status | logout>");
  process.exitCode = 1;
}

function viaApiExitCode(outcome: string): number {
  return outcome === "claimed" || outcome === "queued" || outcome === "already-claimed" || outcome === "done" || outcome === "dry-run" ? 0 : 1;
}

/**
 * `greenlight claim <issue-url> --via-api`: claim through the hosted
 * claim API. The client checks the app installation first: installed ->
 * the claim goes through the app backend (the server posts the protocol
 * comment as the caller); not installed -> the current direct-API
 * comment path with a printed one-line note. Dry run unless --yes.
 */
async function cmdClaimViaApi(issueUrl: string, args: string[]): Promise<void> {
  const { owner, repo, number } = parseIssueUrl(issueUrl);
  const asJson = args.includes("--json");
  const printed: string[] = [];
  const etaRaw = flagValue(args, "--eta-days");
  const result: ViaApiClaimResult = await viaApiClaim(
    { owner, repo, number, url: issueUrl },
    {
      plan: flagValue(args, "--plan"),
      etaDays: etaRaw !== undefined ? Number(etaRaw) : undefined,
      queueOk: args.includes("--queue-ok"),
      tokenFlag: flagValue(args, "--token"),
      apiBaseFlag: flagValue(args, "--api-base"),
      yes: args.includes("--yes"),
    },
    { print: (line) => (asJson ? printed.push(line) : console.log(line)) }
  );
  if (asJson) {
    console.log(JSON.stringify({ ...result, printed }, null, 2));
  } else {
    console.log(result.message);
  }
  process.exitCode = viaApiExitCode(result.outcome);
}

async function cmdViaApiMarker(
  kind: "release" | "heartbeat",
  issueUrl: string,
  args: string[]
): Promise<void> {
  const { owner, repo, number } = parseIssueUrl(issueUrl);
  const asJson = args.includes("--json");
  const printed: string[] = [];
  const opts = {
    tokenFlag: flagValue(args, "--token"),
    apiBaseFlag: flagValue(args, "--api-base"),
    yes: args.includes("--yes"),
  };
  const run = kind === "release" ? viaApiRelease : viaApiHeartbeat;
  const runOpts =
    kind === "release"
      ? opts
      : { ...opts, mode: (args.includes("--reaction") ? "reaction" : "comment") as "comment" | "reaction" };
  const result: ViaApiWriteResult = await run(
    { owner, repo, number, url: issueUrl },
    runOpts,
    { print: (line) => (asJson ? printed.push(line) : console.log(line)) }
  );
  if (asJson) {
    console.log(JSON.stringify({ ...result, printed }, null, 2));
  } else {
    console.log(result.message);
  }
  process.exitCode = viaApiExitCode(result.outcome);
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

/** v0.9.2: name the actual outcome when every failing check is an external blocker. */
function ciVerdictLine(verdict: string): string {
  return verdict === "NO CODE FAILURES"
    ? "Verdict: NO CODE FAILURES (all blockers external)"
    : `Verdict: ${verdict}`;
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
    console.log(ciVerdictLine(result.verdict));
    return;
  }
  for (const c of result.checks) {
    console.log(`  [${c.class}] ${c.name}`);
    console.log(`    ${c.evidence}`);
    if (c.lean) console.log(`    lean: ${c.lean}`);
    if (c.detailsUrl) console.log(`    ${c.detailsUrl}`);
    if (c.failureLines) for (const line of c.failureLines) console.log(`    > ${line}`);
  }
  console.log(ciVerdictLine(result.verdict));
}

async function cmdCiPrep(target: string, args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const base = flagValue(args, "--base");
  const timeoutSecs = flagValue(args, "--timeout-secs");
  const result = await runCiPrep(target, {
    base: base ?? undefined,
    timeoutSecs: timeoutSecs ? parseInt(timeoutSecs, 10) : undefined,
    useAct: args.includes("--act"),
  });
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatCiPrepHuman(result));
  }
  if (result.verdict === "NO-GO") process.exitCode = 1;
}

async function cmdRadar(repoRef: string, args: string[]): Promise<void> {
  const { owner, repo } = parseRepoRef(repoRef);
  const asJson = args.includes("--json");
  const limitRaw = flagValue(args, "--limit");
  const limit = limitRaw !== undefined ? Math.max(1, Math.min(Math.trunc(Number(limitRaw)) || 25, 100)) : 25;
  const result = await radarPRs(owner, repo, { limit });
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `PR Radar for ${result.repo}: ${result.prsScanned} open PRs scanned, ${result.clusters.length} competing cluster(s), ${result.unclustered.length} unclustered (${result.apiCalls} API calls)`
  );
  if (result.clusters.length === 0) {
    console.log("No competing-PR clusters found. The open queue has no obvious duplicates.");
    return;
  }
  for (const c of result.clusters) {
    const kindLabel = c.kind === "same-issue" ? "same issue" : "file overlap";
    const what = c.issue ? `competing on issue #${c.issue.number} (${c.issue.url})` : "no shared linked issue";
    console.log(`\n[${kindLabel}] ${what}`);
    for (const ev of c.evidence) console.log(`  - ${ev}`);
    console.log(`  suggested keep (heuristic): #${c.suggestedKeep} — ${c.suggestedKeepReason}`);
  }
}

async function cmdBrief(target: string, args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const result = await briefPR(target);
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`PR Brief: ${result.pr}`);
  console.log(`  "${result.title}" by @${result.author} — ${result.state}${result.draft ? " (draft)" : ""}, ${result.ageDays}d old`);
  console.log(
    `  size: ${result.size.filesChanged} files, +${result.size.additions}/-${result.size.deletions}`
  );
  for (const g of result.areas) {
    console.log(`  ${g.area}: ${g.files.length} file${g.files.length === 1 ? "" : "s"}`);
  }
  console.log(`  CI: ${result.ci.verdict}`);
  for (const check of (result.ci.checks ?? []).filter((c) => c.class !== "pre-existing")) {
    console.log(`    [${check.class}] ${check.name}: ${check.evidence}`);
  }
  const rc = result.review.counts;
  console.log(
    `  review: ${result.review.verdict} (real: ${rc.likelyReal}, needs decision: ${rc.needsDecision}, noise: ${rc.likelyNoise})`
  );
  for (const f of (result.review.findings ?? []).filter((x) => x.class === "likely-real").slice(0, 5)) {
    console.log(`    [${f.author}] ${f.summary}${f.path ? ` (${f.path})` : ""}`);
    console.log(`      why: ${f.reason}`);
  }
  console.log(`  tests: ${result.testEvidence.note}`);
  if (result.blockers.length > 0) {
    console.log("  BLOCKERS:");
    for (const b of result.blockers) console.log(`    - ${b}`);
  }
  if (result.unverified.length > 0) {
    console.log("  not verified:");
    for (const u of result.unverified) console.log(`    - ${u}`);
  }
  console.log(`\n  ${result.lookFirst}`);
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
  if (args.includes("--labels-dry-run")) {
    // Autopilot transparency: what the guard WOULD label and nudge, in
    // plain text. Never posts, never labels, never exits 3.
    console.log(renderLabelsDryRun(result));
    return;
  }
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!quiet || result.hasFindings) {
    console.log(result.markdown);
  }
  // Exit code 3 means findings exist, so a GitHub Action can decide whether
  // to comment or block. Nothing flagged is exit 0, usage errors are exit 1.
  if (result.hasFindings) process.exitCode = 3;
}

/**
 * `greenlight babysit`: the PR babysitter. Watches your open PRs and
 * reports the one prioritized action list: needs you now, waiting on
 * them, quiet. Cron-friendly: exit 0 unless usage is wrong; --fail-on-action
 * gives exit 3 when "needs you now" is non-empty.
 */
async function cmdBabysit(args: string[]): Promise<void> {
  const prsRaw = flagValue(args, "--prs");
  const mine = args.includes("--mine");
  const account = args.includes("--account");
  const claimsOnly = args.includes("--claims-only");
  const author = flagValue(args, "--author");
  const reposRaw = flagValue(args, "--repos");
  const statePath = flagValue(args, "--state") ?? defaultStatePath();
  const prs = prsRaw ? prsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];
  const repos = reposRaw ? reposRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];
  const concRaw = flagValue(args, "--concurrency");
  let concurrency: number | undefined;
  if (concRaw !== undefined) {
    concurrency = Number(concRaw);
    if (!Number.isFinite(concurrency) || concurrency < 1) {
      console.error("Error: --concurrency must be a positive number.");
      process.exitCode = 1;
      return;
    }
  }
  if (prs.length === 0 && !mine && !account && !claimsOnly) {
    console.error("Error: give --prs <url,...>, --mine --repos <owner/repo,...>, --account, or --claims-only (e.g. greenlight babysit --account)");
    process.exitCode = 1;
    return;
  }
  const run = await babysit({ prs, mine, account, author, repos, statePath, claimsOnly, concurrency });
  if (args.includes("--json")) {
    console.log(JSON.stringify(run.json, null, 2));
  } else {
    console.log(run.markdown);
  }
  if (args.includes("--fail-on-action") && run.needsYouNow.length > 0) process.exitCode = 3;
}

/**
 * `greenlight autopilot`: PR feedback that fixes itself. Report-only by
 * default; --apply performs mechanical fixes (DCO surgery, mechanical
 * merges, formatting) with a cap. Never posts comments: replies are
 * drafted and queued behind the account's comment block.
 */
async function cmdAutopilot(args: string[]): Promise<void> {
  const prsRaw = flagValue(args, "--prs");
  const author = flagValue(args, "--author");
  const maxPrsRaw = flagValue(args, "--max-prs");
  const maxFixesRaw = flagValue(args, "--max-fixes");
  const statePath = flagValue(args, "--state") ?? defaultAutopilotStatePath();
  const prs = prsRaw ? prsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];
  let maxPrs: number | undefined;
  let maxFixes: number | undefined;
  if (maxPrsRaw !== undefined) {
    maxPrs = Number(maxPrsRaw);
    if (!Number.isFinite(maxPrs) || maxPrs < 1) {
      console.error("Error: --max-prs must be a positive number.");
      process.exitCode = 1;
      return;
    }
  }
  if (maxFixesRaw !== undefined) {
    maxFixes = Number(maxFixesRaw);
    if (!Number.isFinite(maxFixes) || maxFixes < 0) {
      console.error("Error: --max-fixes must be a non-negative number.");
      process.exitCode = 1;
      return;
    }
  }
  const apply = args.includes("--apply");
  const run = await runAutopilot({ author, prs, maxPrs, apply, maxFixes, statePath });
  if (args.includes("--json")) {
    console.log(JSON.stringify(run.json, null, 2));
  } else {
    console.log(run.markdown);
  }
}

/**
 * Multi-agent sync (v0.10.0): reconcile the local claims registry with
 * the authoritative API census. Reads only; --write updates the
 * registry's known-PRs section, never GitHub.
 */
async function cmdSync(args: string[]): Promise<void> {
  const author = flagValue(args, "--author") ?? defaultAccountAuthor();
  const trackerPath = flagValue(args, "--tracker");
  const staleRaw = flagValue(args, "--stale-days");
  const staleDays = staleRaw !== undefined ? Number(staleRaw) : 7;
  if (!Number.isFinite(staleDays) || staleDays < 0) {
    console.error("Error: --stale-days must be a non-negative number.");
    process.exitCode = 1;
    return;
  }
  const { drift, wrote } = await runSync({ author, trackerPath, staleDays, write: args.includes("--write") });
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...syncJson(drift, author), wrote }, null, 2));
  } else {
    console.log(formatSyncHuman(drift, author));
    if (wrote) console.log(`\nregistry updated: ${wrote.added} new PRs recorded, ${wrote.updated} refreshed.`);
  }
}

/**
 * Multi-agent portfolio view (v0.10.0): one-screen campaign summary
 * from the API census, the claims registry, and the posting ledger.
 */
async function cmdPortfolio(args: string[]): Promise<void> {
  const author = flagValue(args, "--author") ?? defaultAccountAuthor();
  const staleRaw = flagValue(args, "--stale-days");
  const staleDays = staleRaw !== undefined ? Number(staleRaw) : 7;
  if (!Number.isFinite(staleDays) || staleDays < 0) {
    console.error("Error: --stale-days must be a non-negative number.");
    process.exitCode = 1;
    return;
  }
  const p = await runPortfolio({ author, staleDays });
  if (args.includes("--json")) {
    console.log(JSON.stringify(portfolioJson(p), null, 2));
  } else {
    console.log(formatPortfolioHuman(p));
  }
}

/**
 * `greenlight shipcheck owner/repo --version x.y.z`: independently verify
 * every link of a release chain (tag, commit object, package.json at the
 * tag, GitHub release, npm, MCP Registry). Reads only. Exits non-zero
 * naming the broken link on any failure, so a CI gate can run it after
 * every publish and a broken ship can never be reported as shipped.
 */
async function cmdShipcheck(target: string, args: string[]): Promise<void> {
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseRepoRef(target));
  } catch {
    console.error(`Error: expected owner/repo, got: ${target}`);
    process.exitCode = 1;
    return;
  }
  const version = flagValue(args, "--version");
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error("Error: --version <x.y.z> is required.");
    process.exitCode = 1;
    return;
  }
  const result = await runShipcheck({
    owner,
    repo,
    version,
    npmPackage: flagValue(args, "--npm"),
    mcpName: flagValue(args, "--mcp-name"),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatShipcheckHuman(result));
  }
  if (!result.pass) process.exitCode = 1;
}

/**
 * `greenlight preflight owner/repo [--base sha] [--files a,b]`: reads-only
 * go/no-go before building a fix or opening a PR. Checks the fork, the
 * capability ledger (KNOWN-BLOCKED repos stop here), the repo's policy
 * gates, and optional upstream drift on the files the build would touch.
 */
async function cmdPreflight(target: string, args: string[]): Promise<void> {
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseRepoRef(target));
  } catch {
    console.error(`Error: expected owner/repo, got: ${target}`);
    process.exitCode = 1;
    return;
  }
  const filesRaw = flagValue(args, "--files");
  const result = await runPreflight({
    owner,
    repo,
    base: flagValue(args, "--base"),
    files: filesRaw ? filesRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : undefined,
    behavioral: args.includes("--behavioral"),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatPreflightHuman(result));
  }
  if (result.verdict === "NO-GO") process.exitCode = 1;
}

/**
 * Campaign scout mode (v0.9.0). Reads repos from --repos or --repos-file,
 * scans each with the check pipeline, dedupes against the campaign file,
 * ranks the survivors, and with --write appends them as SCOUTED.
 */
async function cmdScout(args: string[]): Promise<void> {
  const reposRaw = flagValue(args, "--repos");
  const reposFile = flagValue(args, "--repos-file");
  const campaignPath = flagValue(args, "--campaign");
  if (!campaignPath) {
    console.error("Error: --campaign <campaign.json> is required.");
    process.exitCode = 1;
    return;
  }
  let repos = reposRaw ? reposRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];
  if (reposFile) {
    try {
      const { readFileSync } = await import("node:fs");
      const lines = readFileSync(reposFile, "utf8").split("\n");
      for (const line of lines) {
        const t = line.trim();
        if (t.length > 0 && !t.startsWith("#")) repos.push(t);
      }
    } catch (err) {
      console.error(`Error: cannot read repos file ${reposFile}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
  }
  if (repos.length === 0) {
    console.error("Error: give --repos <o/r,...> or --repos-file <path> (e.g. greenlight scout --repos acme/widgets --campaign campaign.json).");
    process.exitCode = 1;
    return;
  }
  const budgetRaw = flagValue(args, "--budget");
  const budget = budgetRaw !== undefined ? Number(budgetRaw) : SCOUT_DEFAULT_BUDGET;
  if (!Number.isFinite(budget) || budget <= 0) {
    console.error("Error: --budget must be a positive number.");
    process.exitCode = 1;
    return;
  }
  const scanLimitRaw = flagValue(args, "--scan-limit");
  const keepRaw = flagValue(args, "--keep");
  const result = await scoutCampaign({
    repos,
    campaignPath,
    budget,
    write: args.includes("--write"),
    scanLimit: scanLimitRaw !== undefined ? Number(scanLimitRaw) : undefined,
    keepPerRepo: keepRaw !== undefined ? Number(keepRaw) : undefined,
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result.json, null, 2));
  } else {
    console.log(result.markdown);
  }
  if (result.budgetHit) {
    console.log(`\nStopped on budget after ${result.reposProcessed.length} repos. The campaign file holds the resume cursor; rerun the same command to continue.`);
  }
}

/**
 * `greenlight evidence`: the Verified PR evidence pack. Assembles the
 * guard verdict, CI triage, review triage, and protocol status of linked
 * issues into one markdown pack where every claim cites its source.
 */
async function cmdEvidence(prUrl: string, args: string[]): Promise<void> {
  const pack = await buildEvidencePack(prUrl, { verifyJsonPath: flagValue(args, "--verify-json") });
  const out = flagValue(args, "--out");
  if (args.includes("--json")) {
    console.log(JSON.stringify(pack.json, null, 2));
  } else {
    console.log(pack.markdown);
  }
  if (out) {
    writeFileSync(out, pack.markdown + "\n", "utf8");
    if (!args.includes("--json")) console.log(`\nPack written to ${out}`);
  }
}

/**
 * `greenlight passport`: the contributor passport. Protocol claims from
 * the Claim Ledger plus merged PRs from the GitHub search API.
 */
async function cmdPassport(login: string, args: string[]): Promise<void> {
  const clean = login.replace(/^@/, "");
  if (!/^[A-Za-z0-9-]+$/.test(clean)) {
    console.error(`Error: expected a GitHub login, got: ${login}`);
    process.exitCode = 1;
    return;
  }
  const passport = await buildPassport(clean);
  if (args.includes("--json")) {
    console.log(JSON.stringify(passport.json, null, 2));
  } else {
    console.log(passport.markdown);
  }
}

/**
 * `greenlight bounty <issue-url>` (v0.18.0, item 23): is the bounty this
 * issue advertises actually alive? The classifier never raises a
 * verdict: bounties are context, not landability. What it kills is
 * chasing a dead platform (algora has been dead since 2025; thousands
 * of issues still wear its labels).
 */
async function cmdBounty(issueUrl: string, args: string[]): Promise<void> {
  const { owner, repo, number } = parseIssueUrl(issueUrl);
  const result = await detectBountyForIssue(owner, repo, number);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.signal) {
    console.log(`No bounty advertised on ${result.repo}#${number} ("${result.title}").`);
    return;
  }
  const s = result.signal;
  const head = s.amount ? `Bounty: ${s.amount}` : "Bounty advertised";
  const via = s.platform ? ` via ${s.platform}` : " (no platform named)";
  console.log(`${head}${via} on ${result.repo}#${number}`);
  if (s.flag === "bounty-platform-dead") {
    console.log(`  DEAD PLATFORM: ${s.evidence}`);
  } else if (s.flag === "bounty-unverified") {
    console.log(`  UNVERIFIED: ${s.evidence}`);
  } else {
    console.log(`  platform is named and not known-dead; verify terms on the platform before counting on payment`);
  }
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

/**
 * `greenlight verify-comment`: assemble the verified-finding comment for a
 * maintainer-only repo. Takes the issue URL plus contributor notes (flags
 * or --from-file), prints the comment markdown. Never posts anything.
 */
async function cmdVerifyComment(issueUrl: string, args: string[]): Promise<void> {
  const { owner, repo, number } = parseIssueUrl(issueUrl); // validates the URL shape
  const fields: VerifiedCommentInput = {};
  const fileIdx = args.indexOf("--from-file");
  if (fileIdx >= 0 && fileIdx + 1 < args.length) {
    const parsed = parseNoteFile(readFileSync(args[fileIdx + 1], "utf8"));
    Object.assign(fields, parsed.fields);
    // Unmapped sections are never dropped; they ride along so the
    // contributor's content survives. The fixSketch carries them because
    // that is the free-form section closest to "here is more".
    if (parsed.additionalNotes.trim().length > 0) {
      fields.fixSketch = [fields.fixSketch, "", "Additional notes:", parsed.additionalNotes]
        .filter((s) => s !== undefined)
        .join("\n")
        .trim();
    }
  }
  // CLI flags override the file, section by section.
  const str = (name: string): string | undefined => flagValue(args, name);
  if (str("--claim")) fields.claim = str("--claim")!;
  if (str("--env")) fields.environment = str("--env")!;
  if (str("--repro"))
    fields.reproduction = str("--repro")!
      .split("\n")
      .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*])\s+/, "").trim())
      .filter((s) => s.length > 0);
  if (str("--observed")) fields.observed = str("--observed")!;
  if (str("--expected")) fields.expected = str("--expected")!;
  if (str("--root-cause")) fields.rootCause = str("--root-cause")!;
  if (str("--fix")) fields.fixSketch = str("--fix")!;
  if (str("--ran")) fields.ran = str("--ran")!;
  if (str("--by")) fields.verifiedBy = str("--by")!;

  const built = buildVerifiedComment(`https://github.com/${owner}/${repo}/issues/${number}`, fields, GREENLIGHT_VERSION);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ issue: issueUrl, markdown: built.markdown, gaps: built.gaps, posted: false }, null, 2));
    return;
  }
  console.log(built.markdown);
  if (built.gaps.length > 0) {
    console.log(`\n(gaps left explicit: ${built.gaps.join(", ")})`);
  }
  console.log(`\nDraft only: copy this into the issue thread yourself. Greenlight never posts.`);
}

/**
 * `greenlight verify`: the honest red-green runner. Compares the repo's
 * test results at --base against the working tree and reports the delta:
 * fixed (was red, now green), newly failing (yours), still failing
 * (pre-existing). Exit 3 when new failures exist, 1 when the comparison
 * could not be made, 0 otherwise.
 */
async function cmdVerify(args: string[]): Promise<void> {
  const timeoutRaw = flagValue(args, "--timeout-secs");
  const result = verifyRepo(process.cwd(), {
    base: flagValue(args, "--base"),
    cmd: flagValue(args, "--cmd"),
    parser: flagValue(args, "--parser"),
    timeoutSecs: timeoutRaw ? Number(timeoutRaw) : undefined,
    allowDirty: args.includes("--allow-dirty"),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.markdown);
  }
  if (result.outcome === "unverifiable") {
    console.error(`Unverifiable: ${result.reason}`);
    process.exitCode = 1;
  } else if (result.delta && result.delta.newlyFailing.length > 0) {
    process.exitCode = 3;
  }
}

/**
 * `greenlight init`: one-command agent setup. Collects repeated --agent
 * values, falls back to detecting which tools the project uses when none
 * is given, and hands the rest to initTools (dry run reports, --force
 * overwrites). Exit 2 when nothing was given or detected; exit 1 on any
 * setup error; 0 on success.
 */
async function cmdInit(args: string[]): Promise<void> {
  if (args.includes("--list")) {
    console.log("Supported agent ids:");
    for (const t of INIT_TOOLS) console.log(`  ${t.id}  (${t.label})`);
    return;
  }
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const agentValues: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent" && i + 1 < args.length) {
      agentValues.push(args[i + 1]);
      i++;
    }
  }
  const projectDir = process.cwd();
  let ids = parseAgentList(agentValues);
  if (ids.length === 0) {
    const detected = detectTools(projectDir);
    if (detected.length > 0) {
      console.log(`No --agent given; detected in this directory: ${detected.join(", ")}`);
      ids = detected;
    } else {
      console.error("No --agent given, and no supported tool detected in this directory.");
      console.error(`Supported: ${INIT_TOOLS.map((t) => t.id).join(", ")}`);
      console.error("Example: greenlight init --agent claude-code");
      process.exitCode = 2;
      return;
    }
  }
  try {
    const results = initTools(ids, { projectDir, dryRun, force });
    console.log(formatInitHuman(results, dryRun));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`Supported: ${INIT_TOOLS.map((t) => t.id).join(", ")}`);
    process.exitCode = 1;
  }
}

/**
 * `greenlight doctor`: the setup check. Exit 1 when any check fails.
 */
async function cmdProxy(args: string[]): Promise<void> {
  const portRaw = flagValue(args, "--port");
  const port = portRaw !== undefined ? Number(portRaw) : PROXY_DEFAULT_PORT;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error("Error: --port must be a valid port number.");
    process.exitCode = 1;
    return;
  }
  const config = resolveProxyConfig(process.env, port);
  if ("error" in config) {
    console.error(`Error: ${config.error}`);
    process.exitCode = 1;
    return;
  }
  let started;
  try {
    started = await startProxy(config);
  } catch (err) {
    console.error(`Error: could not bind 127.0.0.1:${port}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`greenlight proxy listening on 127.0.0.1:${started.port} (upstream ${PROXY_UPSTREAM})`);
  console.log(`Client env: ${proxyClientEnv(started.port)}`);
  const shutdown = async () => {
    await started.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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

function usage(): void {
  // One source of help text lives in help.ts; the CLI keeps the same
  // console output style (a single console.log).
  console.log(overviewText());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(["--json", "--yes", "--force", "--no-fallback", "--quiet", "--fail-on-race", "--allow-dirty", "--act", "--mine", "--labels-dry-run", "--dry-run", "--list", "--write", "--register", "--claims-only", "--import", "--via-api", "--queue-ok", "--browser", "--reaction", "--deep", "--from-scan"]);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flags.has(a)) continue;
    if (a === "--dir" || a === "--title" || a === "--branch" || a === "--gates-file" || a === "--limit" || a === "--plan" || a === "--eta-days" || a === "--from-file" || a === "--claim" || a === "--env" || a === "--repro" || a === "--observed" || a === "--expected" || a === "--root-cause" || a === "--fix" || a === "--ran" || a === "--by" || a === "--base" || a === "--cmd" || a === "--parser" || a === "--timeout-secs" || a === "--prs" || a === "--repos" || a === "--repos-file" || a === "--state" || a === "--out" || a === "--verify-json" || a === "--agent" || a === "--campaign" || a === "--budget" || a === "--scan-limit" || a === "--keep" || a === "--as" || a === "--ledger-user" || a === "--urls" || a === "--port" || a === "--concurrency" || a === "--token" || a === "--api-base" || a === "--client-id" || a === "--issues") {
      i++; // skip the value with its flag
      continue;
    }
    positional.push(a);
  }
  const [command, target] = positional;

  try {
    if (args.includes("--help")) {
      // <command> --help, and bare --help as the overview.
      const names = positional.filter((p) => p !== "--help");
      const known = names.find((n) => findCommand(n) !== undefined);
      console.log(known ? helpText(known) : overviewText());
      return;
    }
    if (command === "--version" || command === "version") {
      console.log(versionText());
      return;
    }
    if (command === "help") {
      console.log(helpText(target));
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
    if (command === "proxy") return await cmdProxy(args);
    if (command === "check" && target) return await cmdCheck(target, args.includes("--json"), args);
    if (command === "status" && target) return await cmdStatus(target, args.includes("--json"));
    if (command === "scan" && target) return await cmdScan(target, args.includes("--json"), args);
    if (command === "xray" && target) return await cmdXray(target, args);
    if (command === "friction" && target) return await cmdFriction(target, args.includes("--json"), args);
    if (command === "wave") return await cmdWave(args);
    if (command === "ci" && target) return await cmdCi(target, args.includes("--json"));
    if (command === "ci-prep" && target) return await cmdCiPrep(target, args);
    if (command === "review" && target) return await cmdReview(target, args.includes("--json"));
    if (command === "radar" && target) return await cmdRadar(target, args);
    if (command === "brief" && target) return await cmdBrief(target, args);
    if (command === "guard" && target) return await cmdGuard(target, args);
    if (command === "digest" && target) return await cmdDigest(target, args);
    if (command === "claim" && (target || args.includes("--import"))) return await cmdClaim(target ?? "--import", args);
    if (command === "release" && target) return await cmdViaApiMarker("release", target, args);
    if (command === "heartbeat" && target) return await cmdViaApiMarker("heartbeat", target, args);
    if (command === "auth") return await cmdAuth(target, args);
    if (command === "prep" && target) return await cmdPrep(target, args);
    if (command === "pr" && target) return await cmdPr(target, args);
    if (command === "verify-comment" && target) return await cmdVerifyComment(target, args);
    if (command === "verify") return await cmdVerify(args);
    if (command === "babysit") return await cmdBabysit(args);
    if (command === "autopilot") return await cmdAutopilot(args);
    if (command === "scout") return await cmdScout(args);
    if (command === "sync") return await cmdSync(args);
    if (command === "portfolio") return await cmdPortfolio(args);
    if (command === "shipcheck" && target) return await cmdShipcheck(target, args);
    if (command === "preflight" && target) return await cmdPreflight(target, args);
    if (command === "evidence" && target) return await cmdEvidence(target, args);
    if (command === "passport" && target) return await cmdPassport(target, args);
    if (command === "bounty" && target) return await cmdBounty(target, args);
    if (command && NEEDS_TARGET[command]) {
      // Known command with a missing argument: name the need and show its
      // help, instead of the generic overview.
      const cmd = findCommand(command);
      console.error(`Error: greenlight ${command} needs ${NEEDS_TARGET[command]}`);
      if (cmd) console.log(commandHelpText(cmd));
      process.exitCode = 1;
      return;
    }
    if (!command) {
      // Bare `greenlight`: the overview, not an error.
      console.log(overviewText());
      return;
    }
    // Unknown command: the overview plus the did-you-mean suggestion when
    // one exists. Exit 1 (usage error), not 0.
    console.log(helpText(command));
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
