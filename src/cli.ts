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
 *   greenlight verify-comment <issue-url> [--json] [--from-file notes.md]
 *   greenlight verify [--base <ref>] [--cmd "<test command>"] [--parser node:test|pytest] [--allow-dirty] [--json]
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
import { checkIssueWithProtocol, computeIssueStatus } from "./protocol-fetch.js";
import {
  buildVerifiedComment,
  suggestsVerifiedComment,
  verifiedCommentSuggestion,
  parseNoteFile,
  type VerifiedCommentInput,
} from "./verify-comment.js";
import { verifyRepo } from "./verify.js";
import { babysit, defaultStatePath } from "./babysit.js";
import { buildEvidencePack } from "./evidence.js";
import { buildPassport } from "./passport.js";
import { renderLabelsDryRun } from "./guard.js";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

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
  // The check pipeline merges the legacy verdict with the Claim Protocol
  // state: a protocol claim verdict overrides legacy claim inference, but
  // never gates or cross-referenced PR evidence (see mergeProtocolVerdict).
  const { snapshot, merged } = await checkIssueWithProtocol(owner, repo, number, {
    externalGates: loadExternalGates(args),
  });
  const result: VerdictResult = {
    verdict: merged.verdict,
    reasons: merged.reasons,
    flags: merged.flags,
    claims: merged.claims,
    gates: merged.gates,
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
          suggestion,
        },
        null,
        2
      )
    );
    return;
  }
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
  const etaRaw = flagValue(args, "--eta-days");
  const plan: ClaimResult = await claimIssue(createRestClient(), snapshot, {
    yes: args.includes("--yes"),
    force: args.includes("--force"),
    plan: flagValue(args, "--plan"),
    etaDays: etaRaw !== undefined ? Number(etaRaw) : undefined,
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
  const reposRaw = flagValue(args, "--repos");
  const statePath = flagValue(args, "--state") ?? defaultStatePath();
  const prs = prsRaw ? prsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];
  const repos = reposRaw ? reposRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];
  if (prs.length === 0 && !mine) {
    console.error("Error: give --prs <url,...> or --mine --repos <owner/repo,...> (e.g. greenlight babysit --mine --repos acme/widgets)");
    process.exitCode = 1;
    return;
  }
  const run = await babysit({ prs, mine, repos, statePath });
  if (args.includes("--json")) {
    console.log(JSON.stringify(run.json, null, 2));
  } else {
    console.log(run.markdown);
  }
  if (args.includes("--fail-on-action") && run.needsYouNow.length > 0) process.exitCode = 3;
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

function usage(): void {
  console.log("greenlight: pre-flight checks for open-source contributions");
  console.log("");
  console.log("  greenlight check <issue-url> [--json] [--gates-file path]");
  console.log("  greenlight status <issue-url> [--json]   (Claim Protocol: who holds this issue, queue, expiry)");
  console.log("  greenlight scan <owner/repo> [--json] [--no-fallback] [--gates-file path]");
  console.log("  greenlight mcp   (run the MCP server on stdio)");
  console.log("  greenlight friction <owner/repo> [--json]");
  console.log("  greenlight ci <pr-url> [--json]   (CI failure triage: is the red check yours or pre-existing?)");
  console.log("  greenlight review <pr-url> [--json]   (review triage: which review comments need you, with reply drafts)");
  console.log("  greenlight guard <pr-url> [--json] [--quiet] [--labels-dry-run]   (maintainer-side: is this incoming PR worth your time? exit 3 when flagged; dry-run shows autopilot label decisions)");
  console.log("  greenlight digest <owner/repo> [--json] [--limit N] [--fail-on-race]   (repo-level: PR races, claimed-by-other, stale claims, assignment conflicts)");
  console.log("  greenlight babysit [--prs url1,url2] [--mine --repos o/r,...] [--state path] [--json] [--fail-on-action]   (watch your open PRs: needs-you-now first; exit 0 unless --fail-on-action)");
  console.log("  greenlight evidence <pr-url> [--out file.md] [--verify-json path] [--json]   (Verified PR evidence pack: every claim cites its source)");
  console.log("  greenlight passport <github-login> [--json]   (contributor passport: protocol claims from the Claim Ledger + merged PRs)");
  console.log("  greenlight verify-comment <issue-url> [--json] [--from-file notes.md] [--claim t] [--env t] [--repro t] [--observed t] [--expected t] [--root-cause t] [--fix t] [--ran t] [--by name]   (draft the verified-finding comment for maintainer-only repos; never posts)");
  console.log("  greenlight verify [--base <ref>] [--cmd \"<test command>\"] [--parser node:test|pytest] [--timeout-secs N] [--allow-dirty] [--json]   (honest red-green test delta: base vs working tree; exit 3 on new failures, 1 when unverifiable)");
  console.log("  greenlight claim <issue-url> [--yes] [--force] [--plan text] [--eta-days N] [--json]");
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
  const flags = new Set(["--json", "--yes", "--force", "--no-fallback", "--quiet", "--fail-on-race", "--allow-dirty", "--mine", "--labels-dry-run"]);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flags.has(a)) continue;
    if (a === "--dir" || a === "--title" || a === "--branch" || a === "--gates-file" || a === "--limit" || a === "--plan" || a === "--eta-days" || a === "--from-file" || a === "--claim" || a === "--env" || a === "--repro" || a === "--observed" || a === "--expected" || a === "--root-cause" || a === "--fix" || a === "--ran" || a === "--by" || a === "--base" || a === "--cmd" || a === "--parser" || a === "--timeout-secs" || a === "--prs" || a === "--repos" || a === "--state" || a === "--out" || a === "--verify-json") {
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
    if (command === "status" && target) return await cmdStatus(target, args.includes("--json"));
    if (command === "scan" && target) return await cmdScan(target, args.includes("--json"), args);
    if (command === "friction" && target) return await cmdFriction(target, args.includes("--json"));
    if (command === "ci" && target) return await cmdCi(target, args.includes("--json"));
    if (command === "review" && target) return await cmdReview(target, args.includes("--json"));
    if (command === "guard" && target) return await cmdGuard(target, args);
    if (command === "digest" && target) return await cmdDigest(target, args);
    if (command === "claim" && target) return await cmdClaim(target, args);
    if (command === "prep" && target) return await cmdPrep(target, args);
    if (command === "pr" && target) return await cmdPr(target, args);
    if (command === "verify-comment" && target) return await cmdVerifyComment(target, args);
    if (command === "verify") return await cmdVerify(args);
    if (command === "babysit") return await cmdBabysit(args);
    if (command === "evidence" && target) return await cmdEvidence(target, args);
    if (command === "passport" && target) return await cmdPassport(target, args);
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
