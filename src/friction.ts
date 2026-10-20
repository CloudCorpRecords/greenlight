/**
 * Repo friction score: 0-100, where 100 = easiest place for an outsider
 * to land a PR.
 *
 * Formula (documented, deterministic):
 *   start at 100
 *   gates:
 *     assignment_required  -25
 *     vouch_required       -35
 *     collaborators_only   -50
 *     unsolicited_prs_paused -40
 *     scoped_prs_paused    -20 (v0.17.0: only a named PR category refused)
 *     external_prs_closed  -50
 *     discussion_first     -10
 *     claim_first           -5
 *     cla_required          -5
 *     dco_required          -5
 *   outcome signals (only when computed, never guessed):
 *     external PR merge rate: +(rate - 0.5) * 40
 *       (a 100% external merge rate adds 20; 0% subtracts 20)
 *     median hours to first review: -min(hours / 24, 14)
 *       (a week of waiting costs 7 points, capped at 14)
 *     maintainer hours to first issue response: -min(hours / 48, 10)
 *   behavioral gate (v0.16.0, from maintainer actions not policy text):
 *     detected behavioral gate: -20 (maintainer rejects AI-built PRs in
 *     practice, e.g. spotDL/spotify-downloader closing submissions as
 *     "AI slop"). Cost: up to 48 API calls (1-3 list calls plus up to 3 evidence pages per closed-unmerged PR); skip with
 *     --no-behavioral or the behavioral:false option.
 *   opportunity:
 *     open good-first-issue count: +min(count, 20) * 0.5 (max +10)
 *   clamp to [0, 100], rounded.
 *
 * Null signals are simply skipped: the index never fabricates numbers.
 */
import type { FrictionReport, RepoSignals } from "./types.js";
import { gateLabel, parseGatesFromSources } from "./gates.js";
import {
  fetchPolicySources,
  detectRepoPolicy,
  countStarterIssues,
  resolveCanonicalRepo,
} from "./github.js";
import { fetchMergeVelocity } from "./merge-velocity.js";
import { detectBehavioralGate } from "./behavior.js";

const GATE_WEIGHTS: Record<string, number> = {
  assignment_required: -25,
  vouch_required: -35,
  collaborators_only: -50,
  unsolicited_prs_paused: -40,
  // v0.17.0: scoped intake pause. Only a named category of PRs is
  // refused, so it costs half the blanket pause.
  scoped_prs_paused: -20,
  external_prs_closed: -50,
  discussion_first: -10,
  claim_first: -5,
  cla_required: -5,
  dco_required: -5,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function scoreFriction(signals: RepoSignals): FrictionReport {
  let score = 100;
  const reasons: string[] = [];

  for (const gate of signals.gates) {
    if (!gate.detected) continue;
    const w = GATE_WEIGHTS[gate.kind] ?? 0;
    score += w;
    reasons.push(`${gateLabel(gate.kind)} (${w})`);
  }

  if (signals.externalPRMergeRate !== undefined && signals.externalPRMergeRate !== null) {
    const delta = (signals.externalPRMergeRate - 0.5) * 40;
    score += delta;
    reasons.push(`external PR merge rate ${Math.round(signals.externalPRMergeRate * 100)}% (${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`);
  }

  if (signals.medianFirstReviewHours !== undefined && signals.medianFirstReviewHours !== null) {
    const penalty = -Math.min(signals.medianFirstReviewHours / 24, 14);
    score += penalty;
    reasons.push(`median first review ${signals.medianFirstReviewHours.toFixed(1)}h (${penalty.toFixed(1)})`);
  }

  if (signals.maintainerIssueResponseHours !== undefined && signals.maintainerIssueResponseHours !== null) {
    const penalty = -Math.min(signals.maintainerIssueResponseHours / 48, 10);
    score += penalty;
    reasons.push(`maintainer issue response ${signals.maintainerIssueResponseHours.toFixed(1)}h (${penalty.toFixed(1)})`);
  }

  if (signals.openGoodFirstIssueCount !== undefined && signals.openGoodFirstIssueCount !== null) {
    const bonus = Math.min(signals.openGoodFirstIssueCount, 20) * 0.5;
    score += bonus;
    if (bonus > 0) reasons.push(`${signals.openGoodFirstIssueCount} open good-first-issues (+${bonus.toFixed(1)})`);
  }

  // v0.16.0: a detected behavioral gate is a hard contributor blocker,
  // read from maintainer actions rather than policy files.
  if (signals.behavioralGate?.detected) {
    score += -20;
    const n = signals.behavioralGate.strength;
    reasons.push(`behavioral gate: maintainer rejects AI-built PRs in practice (${n} signal${n === 1 ? "" : "s"}) (-20)`);
  }

  // v0.9.3: ratio fields in JSON always ship both units. The fraction
  // keeps its meaning; the _pct sibling is unambiguous.
  const signalsOut: RepoSignals = {
    ...signals,
    externalPRMergeRate_pct:
      signals.externalPRMergeRate === undefined || signals.externalPRMergeRate === null
        ? null
        : Math.round(signals.externalPRMergeRate * 100),
  };
  return {
    owner: signals.owner,
    repo: signals.repo,
    score: Math.round(clamp(score, 0, 100)),
    gates: signals.gates,
    reasons,
    signals: signalsOut,
  };
}

/**
 * Canonicalize the behavioral gate location (v0.17.1, item 12): the
 * top-level `behavioral_gate` field is THE canonical location
 * consumers should read. `signals.behavioralGate` stays as a
 * documented mirror this release because the Agent Policy Index
 * scanner consumes friction output; removing it would break the
 * index pipeline. Both fields always carry the same value.
 */
export function attachBehavioralGate(
  report: FrictionReport,
  gate: RepoSignals["behavioralGate"]
): FrictionReport {
  report.behavioral_gate = gate;
  report.signals = { ...report.signals, behavioralGate: gate };
  return report;
}

/**
 * Attach the outsider merge share to a friction report with an explicit
 * unit contract (v0.9.3): the fraction and the 0..100 percent side by
 * side, so no consumer can mistake one for the other again.
 */
export function attachOutsiderShare(report: FrictionReport): FrictionReport {
  const share =
    report.signals.externalPRMergeRate ??
    report.mergeVelocity?.externalShare ??
    null;
  report.outsider_merge_share = share;
  report.outsider_merge_share_pct = share === null ? null : Math.round(share * 100);
  return report;
}

/**
 * The repo_friction pipeline as one callable: gates from the full policy
 * source set (CONTRIBUTING variants and house rules at root, .github/
 * and docs/, plus the org-level AI_POLICY.md), starter-issue count, and
 * merge velocity as a best-effort signal. Shared by the CLI, the MCP
 * repo_friction tool, and the protocol preflight (which pairs it with
 * the issue status).
 */
export async function fetchFrictionSummary(
  owner: string,
  repo: string,
  opts: { behavioral?: boolean } = {}
): Promise<FrictionReport> {
  // v0.18.0 (item 15): renamed repos (dbt-labs/dbt-core -> dbt-labs/dbt)
  // 422 search and confuse every name-based flow; resolve once, use the
  // canonical name everywhere below, and carry the old name in
  // resolvedFrom for transparency.
  const canon = await resolveCanonicalRepo(owner, repo);
  const resolvedFrom = canon.renamed ? `${owner}/${repo}` : undefined;
  owner = canon.owner;
  repo = canon.repo;
  const [sources, policy, starterCount, mergeVelocity] = await Promise.all([
    fetchPolicySources(owner, repo),
    detectRepoPolicy(owner, repo),
    countStarterIssues(owner, repo),
    // v0.18.0 (item 11): merge velocity feeds the documented external
    // merge-rate score term (see the formula in the module header).
    // Best-effort: a failed fetch leaves the term null and unscored,
    // never fabricated.
    fetchMergeVelocity(owner, repo).catch(() => null),
  ]);
  const gates = parseGatesFromSources(sources);
  if (policy.collaboratorsOnly && !gates.some((g) => g.kind === "collaborators_only" && g.detected)) {
    gates.push({
      kind: "collaborators_only",
      detected: true,
      evidence: "repo policy: PR creation restricted to collaborators",
    });
  }
  // Behavioral gate is a signal, best-effort and silent on failure: a
  // dead pass must never fabricate a hostile verdict, and a missing one
  // must never hide an actual gate.
  let behavioralGate: RepoSignals["behavioralGate"] = null;
  if (opts.behavioral !== false) {
    try {
      behavioralGate = await detectBehavioralGate(owner, repo);
    } catch {
      behavioralGate = null;
    }
  }
  const signals: RepoSignals = {
    owner,
    repo,
    gates,
    externalPRMergeRate: mergeVelocity?.externalShare ?? null,
    externalPRMergeRate_pct: null,
    medianFirstReviewHours: null,
    maintainerIssueResponseHours: null,
    openGoodFirstIssueCount: starterCount,
    behavioralGate,
    note: "live",
  };
  const report = attachBehavioralGate(scoreFriction(signals), behavioralGate);
  report.mergeVelocity = mergeVelocity;
  if (resolvedFrom) report.resolvedFrom = resolvedFrom;
  return attachOutsiderShare(report);
}
