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
 *     discussion_first     -10
 *     cla_required          -5
 *     dco_required          -5
 *   outcome signals (only when computed, never guessed):
 *     external PR merge rate: +(rate - 0.5) * 40
 *       (a 100% external merge rate adds 20; 0% subtracts 20)
 *     median hours to first review: -min(hours / 24, 14)
 *       (a week of waiting costs 7 points, capped at 14)
 *     maintainer hours to first issue response: -min(hours / 48, 10)
 *   opportunity:
 *     open good-first-issue count: +min(count, 20) * 0.5 (max +10)
 *   clamp to [0, 100], rounded.
 *
 * Null signals are simply skipped: the index never fabricates numbers.
 */
import type { FrictionReport, RepoSignals } from "./types.js";
import { gateLabel } from "./gates.js";

const GATE_WEIGHTS: Record<string, number> = {
  assignment_required: -25,
  vouch_required: -35,
  collaborators_only: -50,
  discussion_first: -10,
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

  return {
    owner: signals.owner,
    repo: signals.repo,
    score: Math.round(clamp(score, 0, 100)),
    gates: signals.gates,
    reasons,
    signals,
  };
}
