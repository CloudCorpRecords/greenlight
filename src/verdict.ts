/**
 * Deterministic availability verdict.
 *
 * Scoring order (first match wins; all checks are deterministic, no LLM):
 *
 *  1. Closed issue -> TAKEN (reason: issue closed). A closed issue is never landable.
 *  2. Any assignee -> TAKEN. Someone officially owns it.
 *  3. Open linked PR that CLOSES the issue -> TAKEN. Code already exists.
 *     A PR that merely mentions the issue number (bare #N in the body,
 *     timeline cross-reference only) does not take it: it only adds the
 *     "weak-pr-mention" flag (issue #1, seen on shadcn-labs/pdfcn#61 and
 *     #71, where PR #91 closes #70 but lists sibling issues in its body).
 *  4. Two or more strong claimants -> TAKEN (claim race). Seen on
 *     langchain-ai/langchain#41185 (3 claimants while still "unassigned").
 *  5. One strong, fresh (<= 45 days) claim -> RISKY, flag "claimed".
 *     Seen on shadcn-labs/pdfcn#58, claimed the same day we vetted it.
 *  6. Strong claim older than 45 days with no closing PR -> RISKY,
 *     flag "stale_claim". The claimant probably walked away but nobody
 *     knows for sure (seen on modelcontextprotocol/python-sdk#3287,
 *     claimed 2026-08-11, never opened a PR). A closing PR, open or not,
 *     counts as "a PR was opened" here; a mere mention does not.
 *  7. Any hard gate (assignment / vouch / collaborators_only) with no
 *     assignee -> GATED. The code might be welcome, but the ritual blocks
 *     you: PrefectHQ/fastmcp#5718 (assignment), triggerdotdev/trigger.dev#5016 (vouch).
 *  8. No activity for 180+ days -> STALE. The issue is probably abandoned,
 *     the repro may not even hold on current code.
 *  9. Otherwise -> GO, unless an open PR only mentions the issue, which
 *     downgrades GO to RISKY ("verify it is not already being worked").
 */
import type { IssueSnapshot, VerdictResult } from "./types.js";
import { detectClaims, strongClaimants } from "./claims.js";
import { parseGates, hardGates, gateLabel } from "./gates.js";
import { isClosingPR } from "./linkstrength.js";

const FRESH_CLAIM_DAYS = 45;
const STALE_INACTIVITY_DAYS = 180;

function daysSince(iso: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24)));
}

export function scoreIssue(snapshot: IssueSnapshot, now: Date = new Date()): VerdictResult {
  const claims = detectClaims(snapshot.author ?? "", snapshot.comments, now);
  const gates = parseGates(snapshot.contributing);
  const reasons: string[] = [];
  const flags: string[] = [];

  const repoRef = `${snapshot.owner}/${snapshot.repo}`;

  // Rule 1: closed.
  if (snapshot.state === "closed") {
    reasons.push(`issue is closed on ${repoRef}`);
    return { verdict: "TAKEN", reasons, claims, gates, flags };
  }

  // Rule 2: assignees.
  if (snapshot.assignees.length > 0) {
    reasons.push(`assigned to ${snapshot.assignees.join(", ")}`);
    return { verdict: "TAKEN", reasons, claims, gates, flags };
  }

  // Rule 3: open linked PR that closes the issue.
  const openClosingPR = snapshot.linkedPRs.find(
    (pr) => pr.state === "open" && isClosingPR(pr)
  );
  if (openClosingPR) {
    reasons.push(`open PR #${openClosingPR.number} closes this issue`);
    return { verdict: "TAKEN", reasons, claims, gates, flags };
  }

  // An open PR that only mentions the issue is a weak signal, not a takeover.
  const openMentionPRs = snapshot.linkedPRs.filter(
    (pr) => pr.state === "open" && !isClosingPR(pr)
  );
  if (openMentionPRs.length > 0) flags.push("weak-pr-mention");

  const strong = strongClaimants(claims);

  // Rule 4: claim race.
  if (strong.length >= 2) {
    const names = strong.map((c) => c.author).join(", ");
    reasons.push(`claim race: ${strong.length} strong claimants (${names})`);
    flags.push("claimed");
    return { verdict: "TAKEN", reasons, claims, gates, flags };
  }

  // Rule 5/6: single strong claim.
  if (strong.length === 1) {
    const c = strong[0];
    if (c.ageDays <= FRESH_CLAIM_DAYS) {
      reasons.push(`claimed by ${c.author} ${c.ageDays} day(s) ago ("${c.phrase}")`);
      flags.push("claimed");
      return { verdict: "RISKY", reasons, claims, gates, flags };
    }
    // A closing PR (open or not) counts as "a PR was opened"; a mention does not.
    if (!snapshot.linkedPRs.some(isClosingPR)) {
      reasons.push(`stale claim by ${c.author} ${c.ageDays} day(s) ago ("${c.phrase}"), no PR ever opened`);
      flags.push("stale_claim");
      return { verdict: "RISKY", reasons, claims, gates, flags };
    }
  }

  // Rule 7: hard gate with nobody assigned.
  const hard = hardGates(gates);
  if (hard.length > 0) {
    reasons.push(`repo gate blocks outside PRs: ${hard.map((g) => gateLabel(g.kind)).join("; ")}`);
    if (hard[0].evidence) reasons.push(`gate evidence: "${hard[0].evidence}"`);
    return { verdict: "GATED", reasons, claims, gates, flags };
  }

  // Rule 8: stale by inactivity.
  const inactivityDays = daysSince(snapshot.updatedAt, now);
  if (inactivityDays >= STALE_INACTIVITY_DAYS) {
    reasons.push(`no activity for ${inactivityDays} days`);
    return { verdict: "STALE", reasons, claims, gates, flags };
  }

  // Rule 9: nothing blocking, unless an open PR merely mentions the issue.
  if (openMentionPRs.length > 0) {
    const n = openMentionPRs[0].number;
    reasons.push(
      `PR #${n} mentions this issue but does not close it; verify it is not already being worked`
    );
    return { verdict: "RISKY", reasons, claims, gates, flags };
  }
  reasons.push(`open, unassigned, no linked closing PRs, no claim signals, no blocking gates on ${repoRef}`);
  return { verdict: "GO", reasons, claims, gates, flags };
}

export { FRESH_CLAIM_DAYS, STALE_INACTIVITY_DAYS };
