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
 *  4. Two or more strong whole-issue claimants -> TAKEN (claim race). Seen on
 *     langchain-ai/langchain#41185 (3 claimants while still "unassigned").
 *     Scoped (partial) claims do not count toward a race: part of the work
 *     stays open by definition.
 *  5. One strong, fresh (<= 45 days) whole-issue claim -> RISKY, flag "claimed".
 *     Seen on shadcn-labs/pdfcn#58, claimed the same day we vetted it.
 *  5b. A fresh strong claim scoped to part of the issue -> RISKY, flags
 *     "claimed" + "partial-claim", with a reason naming the claimer and the
 *     scope ("claimed the fallback part ...; the rest may still be open").
 *     Seen on reticlehq/reticle#691 ("Taking the remaining fallback ask").
 *  6. Strong whole-issue claim older than 45 days with no closing PR -> RISKY,
 *     flag "stale_claim". The claimant probably walked away but nobody
 *     knows for sure (seen on modelcontextprotocol/python-sdk#3287,
 *     claimed 2026-08-11, never opened a PR). A closing PR, open or not,
 *     counts as "a PR was opened" here; a mere mention does not. Stale
 *     partial claims get the same treatment, scoped.
 *  7. Any hard gate (assignment / vouch / collaborators_only) with no
 *     assignee -> GATED. The code might be welcome, but the ritual blocks
 *     you: PrefectHQ/fastmcp#5718 (assignment), triggerdotdev/trigger.dev#5016 (vouch).
 *  8. No activity for 180+ days -> STALE. The issue is probably abandoned,
 *     the repro may not even hold on current code.
 *  9. Soft claim-first gate (comment before starting, shadcn-labs/pdfcn
 *     style): never GATED. It caps an otherwise-GO verdict at RISKY with a
 *     note, following the same downgrade shape as the weak-PR-mention rule.
 *  10. Otherwise -> GO, unless an open PR only mentions the issue, which
 *     downgrades GO to RISKY ("verify it is not already being worked").
 *  11. An open PR referenced in a non-author comment that mentions this
 *     issue number downgrades an otherwise-GO verdict to RISKY, flag
 *     "comment-mentioned-pr" ("PR #NNN referenced in comments may already
 *     cover part of this issue"). A merged one is only an informational
 *     note; neither can produce TAKEN. Seen on reticlehq/reticle#691.
 */
import type { IssueSnapshot, VerdictResult, Verdict } from "./types.js";
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
  // Whole-issue claims compete for the whole issue; scoped claims leave part
  // of the work open, so only whole-issue claims can form a claim race.
  const fullStrong = strong.filter((c) => c.scope !== "partial");
  const partialStrong = strong.filter((c) => c.scope === "partial");

  // Rule 4: claim race.
  if (fullStrong.length >= 2) {
    const names = fullStrong.map((c) => c.author).join(", ");
    reasons.push(`claim race: ${fullStrong.length} strong claimants (${names})`);
    flags.push("claimed");
    return { verdict: "TAKEN", reasons, claims, gates, flags };
  }

  // Rule 5/6: single whole-issue strong claim.
  if (fullStrong.length === 1) {
    const c = fullStrong[0];
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

  // Rule 5b/6b: scoped (partial) claim. A fresh partial claim does not take
  // the issue (part of the work remains), but it downgrades an otherwise-GO
  // verdict to RISKY with a reason naming the claimer and the scope. A stale
  // partial claim gets the same treatment as other stale claims.
  if (partialStrong.length > 0) {
    const c = partialStrong[0];
    const part = c.scopeWord ? `the ${c.scopeWord} part` : "part of the issue";
    flags.push("claimed");
    flags.push("partial-claim");
    if (c.ageDays <= FRESH_CLAIM_DAYS) {
      reasons.push(`${c.author} claimed ${part} ${c.ageDays} day(s) ago; the rest may still be open`);
      return { verdict: "RISKY", reasons, claims, gates, flags };
    }
    if (!snapshot.linkedPRs.some(isClosingPR)) {
      reasons.push(`stale partial claim by ${c.author} ${c.ageDays} day(s) ago ("${c.phrase}")`);
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

  // Rule 9: soft claim-first gate. Comment-first is a ritual you satisfy by
  // posting a comment, not a hard block, so it never yields GATED. It caps
  // an otherwise-GO verdict at RISKY with a note, the same downgrade shape
  // as the weak-PR-mention rule below.
  const claimFirst = gates.some((g) => g.kind === "claim_first" && g.detected);
  const claimFirstNote = "repo asks contributors to comment before starting (claim first)";

  // Rule 10: nothing blocking, unless an open PR merely mentions the issue.
  let verdict: Verdict = "GO";
  if (openMentionPRs.length > 0) {
    const n = openMentionPRs[0].number;
    reasons.push(
      `PR #${n} mentions this issue but does not close it; verify it is not already being worked`
    );
    verdict = "RISKY";
  } else {
    reasons.push(`open, unassigned, no linked closing PRs, no claim signals, no blocking gates on ${repoRef}`);
  }
  if (claimFirst) {
    reasons.push(claimFirstNote);
    flags.push("claim_first");
    verdict = "RISKY";
  }

  // Rule 11: comment-mentioned PR cross-check. A PR cited in a non-author
  // comment whose title/body mentions this issue number may already cover
  // part of the work: downgrade an otherwise-GO verdict to RISKY. A merged
  // one is only an informational note. Neither can produce TAKEN.
  const mentioned = snapshot.commentMentionedPRs ?? [];
  const openMentioned = mentioned.filter((p) => p.state === "open" && p.mentionsIssue);
  const mergedMentioned = mentioned.filter((p) => p.state === "merged" && p.mentionsIssue);
  if (openMentioned.length > 0) {
    flags.push("comment-mentioned-pr");
    if (verdict === "GO") {
      reasons.push(
        `PR #${openMentioned[0].number} referenced in comments may already cover part of this issue`
      );
      verdict = "RISKY";
    }
  }
  for (const p of mergedMentioned) {
    reasons.push(`PR #${p.number} (merged) referenced in comments; issue may be partially addressed`);
  }

  return { verdict, reasons, claims, gates, flags };
}

export { FRESH_CLAIM_DAYS, STALE_INACTIVITY_DAYS };
