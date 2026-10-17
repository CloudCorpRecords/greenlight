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
 *  3b. Marked duplicate of an issue closed as completed -> RISKY, flag
 *     "duplicate-of-closed". The work already shipped: n8n-io/n8n#41215
 *     was a duplicate of #40803 (closed as completed) and a full build
 *     was nearly wasted on it.
 *  3c. Marked duplicate of a still-open (or not-planned) issue -> warning
 *     only, never a verdict change. The target's URL and live state are
 *     quoted with the "duplicate-of-open" flag.
 *  3d. An OPEN PR GitHub cross-referenced in the issue's timeline ->
 *     TAKEN, flag "cross-referenced-pr", with the PR URL and title
 *     quoted. The timeline records PRs already in flight that comments
 *     never link (e2b-dev/E2B#1986/#1984/#1981, ComposioHQ/composio#4904,
 *     convex/convex-js#197, ghostfolio/ghostfolio#4605's #4958).
 *  3e. A MERGED timeline cross-reference not consumed by any other rule
 *     caps an otherwise-GO verdict at RISKY, flag
 *     "cross-referenced-pr-merged", with a "verify what shipped" note.
 *     Merged usually means fixed, but not always (#7522 fixed only the
 *     unrestricted variant of #4605), so never TAKEN.
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
 *  7. Any hard gate (assignment / vouch / collaborators_only /
 *     unsolicited_prs_paused / external_prs_closed / agents_banned) with
 *     no assignee -> GATED. The code might be welcome, but the ritual
 *     blocks you: PrefectHQ/fastmcp#5718 (assignment),
 *     triggerdotdev/trigger.dev#5016 (vouch),
 *     activepieces/activepieces (paused unsolicited PRs plus a "Close
 *     external PRs" workflow that auto-closed two finished PRs within
 *     about a minute), nuxt/nuxt (AGENTS.md bans autonomous agent
 *     contributions outright).
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
 *     Fix-announcement comments ("/attempt #N" commands or "Submitted fix
 *     for ... in <PR url>" narratives, often in sibling repos) add
 *     "attempt-linked-pr" evidence with the PR URL quoted before rule 4,
 *     so claim verdicts carry it, and cap an otherwise-GO verdict at RISKY
 *     at the end, even when the PR never names the issue. Seen on
 *     tscircuit/tscircuit#5563.
 *  W. Warning-only signals, never a verdict change: weak claims (soft
 *     claims quoted with their age in days, e.g. a 2-month-old "taking a
 *     look"), bounty liveness ("bounty-platform-dead" when the named
 *     platform is dead like Algora, "bounty-unverified" when no platform
 *     or payer is identifiable), and "possibly-server-side" when a quoted
 *     error string from the body has zero hits in the repo.
 *  12. Partially-addressed: merged PRs that reference the issue number
 *     (comment-mentioned or linked), or maintainer comments signaling part
 *     of the work already shipped ("Half addressed", "leaving this open
 *     for ...", "still open", "part of this is shipped in v..."), mean
 *     part of the issue is done while the rest stays open. A plain GO
 *     hides that. Add flag "partially-addressed", cap an otherwise-GO
 *     verdict at RISKY with a scoping reason; never TAKEN. Seen on
 *     reticlehq/reticle#894 (half A shipped in v3.1.0 via #905/#915,
 *     half B still open).
 *  13. Triage hold: a bot triage notice ("wait until maintainers remove
 *     the triage or approval label before opening a pull request") or a
 *     triage label ("needs triage", "pending triage") means the repo says
 *     do not build until triage clears (mastra-ai/mastra#27360). Never
 *     TAKEN; caps an otherwise-GO verdict at RISKY with flag
 *     "triage-hold". Held issues are future pipeline, not current
 *     targets.
 */
import type { IssueSnapshot, VerdictResult, Verdict } from "./types.js";
import { detectClaims, strongClaimants } from "./claims.js";
import { parseGates, parseGatesFromSources, hardGates, gateLabel } from "./gates.js";
import { isClosingPR } from "./linkstrength.js";
import { detectBounty } from "./bounty.js";
import { detectTriageHold } from "./triage.js";
import { extractPRReferences } from "./github.js";

const FRESH_CLAIM_DAYS = 45;
const STALE_INACTIVITY_DAYS = 180;

function daysSince(iso: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24)));
}

export function scoreIssue(snapshot: IssueSnapshot, now: Date = new Date()): VerdictResult {
  const claims = detectClaims(snapshot.author ?? "", snapshot.comments, now);
  // House-rules files (CONTRIBUTING variants, AGENTS.md, CLAUDE.md) are
  // parsed per-file so each gate records which file its evidence came from.
  const gates =
    snapshot.houseRules && snapshot.houseRules.length > 0
      ? parseGatesFromSources(snapshot.houseRules)
      : parseGates(snapshot.contributing);
  // A committed gatefile gates document outranks prose re-derivation for
  // any kind the prose pass did not already detect: the repo extracted and
  // committed those gates itself.
  if (snapshot.externalGates) {
    for (const eg of snapshot.externalGates) {
      const m = gates.find((x) => x.kind === eg.kind);
      if (m && !m.detected) {
        m.detected = true;
        m.evidence = eg.evidence;
        m.source = eg.source;
      }
    }
  }
  // Workflow gates (auto-close automation) merge the same way: a detected
  // .github/workflows signal fills a kind the prose pass did not catch.
  if (snapshot.workflowGates) {
    for (const wg of snapshot.workflowGates) {
      const m = gates.find((x) => x.kind === wg.kind);
      if (m && !m.detected) {
        m.detected = true;
        m.evidence = wg.evidence;
        m.source = wg.source;
      }
    }
  }
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

  // Timeline cross-references (computed before rule 3 so a closing PR
  // verdict can still quote the rest of the in-flight field).
  const timelineXrefs = snapshot.linkedPRs.filter((pr) => pr.via === "timeline");
  const openTimelineXrefs = timelineXrefs.filter((pr) => pr.state === "open");
  const mergedTimelineXrefs = timelineXrefs.filter((pr) => pr.state === "merged");
  const xrefLabel = (pr: { number: number; title: string; url: string }): string =>
    `#${pr.number} "${pr.title}" (${pr.url})`;

  // Rule 3: open linked PR that closes the issue.
  const openClosingPR = snapshot.linkedPRs.find(
    (pr) => pr.state === "open" && isClosingPR(pr)
  );
  if (openClosingPR) {
    reasons.push(`open PR #${openClosingPR.number} closes this issue`);
    const others = openTimelineXrefs.filter((pr) => pr.number !== openClosingPR.number);
    if (others.length > 0) {
      flags.push("cross-referenced-pr");
      reasons.push(
        `also cross-referenced in the issue timeline and in flight: ${others.map(xrefLabel).join("; ")}`
      );
    }
    return { verdict: "TAKEN", reasons, claims, gates, flags };
  }

  // Rule 3d: timeline cross-reference race. GitHub records a
  // cross-referenced timeline event when a PR's body or a commit message
  // references the issue: the PR is in flight against it even when its
  // body never says "closes #N" and no comment ever links it. Comment-only
  // race checks missed five of twelve claims in one evening this way
  // (e2b-dev/E2B#1986/#1984/#1981, ComposioHQ/composio#4904,
  // convex/convex-js#197, ghostfolio/ghostfolio#4605's #4958). Any OPEN
  // timeline cross-reference takes the issue; closed-unmerged ones are
  // (timelineXrefs computed above, before rule 3; open ones are quoted
  // here even when a closing PR already took the issue, and merged ones
  // get flag 3e below.)
  if (mergedTimelineXrefs.length > 0) {
    flags.push("cross-referenced-pr-merged");
  }
  if (openTimelineXrefs.length > 0) {
    flags.push("cross-referenced-pr");
    reasons.push(
      `open PR(s) cross-referenced in the issue timeline: ${openTimelineXrefs.map(xrefLabel).join("; ")}`
    );
    if (mergedTimelineXrefs.length > 0) {
      reasons.push(
        `also merged in the timeline: ${mergedTimelineXrefs.map(xrefLabel).join("; ")}`
      );
    }
    return { verdict: "TAKEN", reasons, claims, gates, flags };
  }

  // Rule 3b: duplicate-of a completed issue. If this issue is marked a
  // duplicate of another issue that is closed as completed, the work
  // already shipped and building here is wasted. n8n-io/n8n#41215 was a
  // duplicate of #40803 (closed as completed): a full build was nearly
  // wasted on it because the comment sat unread below the bot ticket.
  const dupClosedCompleted = (snapshot.duplicateOf ?? []).find(
    (d) => d.state === "closed" && d.stateReason === "completed"
  );
  if (dupClosedCompleted) {
    reasons.push(`marked duplicate of #${dupClosedCompleted.number}, which is closed as completed`);
    flags.push("duplicate-of-closed");
    return { verdict: "RISKY", reasons, claims, gates, flags };
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

  // Attempt-linked PRs (fix-announcement comments: "/attempt #N" commands
  // or "Submitted fix for ... in <PR url>" narratives, often in sibling
  // repos) are race signals with the URL quoted, even when the PR never
  // names the issue. The evidence is added here so every later return
  // (claim race, fresh/stale claim) carries it; the GO downgrade happens
  // at the end, after rules 11-12, so it only fires when nothing else did.
  // Seen on tscircuit/tscircuit#5563.
  const attemptLinkedOpen = (snapshot.commentMentionedPRs ?? []).filter(
    (p) => p.state === "open" && p.attemptLinked
  );
  if (attemptLinkedOpen.length > 0) {
    flags.push("attempt-linked-pr");
    const urls = attemptLinkedOpen.slice(0, 3).map((p) => p.url);
    const more = attemptLinkedOpen.length > 3 ? ` and ${attemptLinkedOpen.length - 3} more` : "";
    reasons.push(`fix PRs linked from fix-announcement comments may already cover this work: ${urls.join(", ")}${more}`);
  }

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

  // Warning-only signals: flags with reasons that never change the
  // verdict. They ride along on whatever verdict the rules above and
  // below produce.

  // Soft claims carry their comment date so a months-old soft claim weighs
  // differently from yesterday's: actualbudget/actual#6643's "I'm going
  // to take a look at this one" sat two months with nothing landing.
  const softClaims = claims.filter((c) => c.strength === "soft");
  if (softClaims.length > 0) {
    const c = softClaims[0];
    flags.push("weak-claim");
    reasons.push(`soft claim by ${c.author} ${c.ageDays} day(s) ago ("${c.phrase}"); no verdict change`);
  }

  // Bounty liveness: a bounty is context, never landability evidence. A
  // dead platform (algora.io 404s, API empty since 2025) behind a "$250
  // bounty" label means there is no money to chase (onyx#2281 style).
  const bounty = detectBounty({ labels: snapshot.labels, title: snapshot.title, body: snapshot.body ?? "" });
  if (bounty && bounty.flag) {
    flags.push(bounty.flag);
    reasons.push(
      bounty.flag === "bounty-platform-dead"
        ? `bounty names a dead platform: ${bounty.evidence}`
        : `bounty offered but unverified: ${bounty.evidence}`
    );
  }

  // Server-side-only: a quoted error string from the body with zero hits
  // in the repo means the check may live outside it entirely.
  if (snapshot.serverSide) {
    flags.push(snapshot.serverSide.flag);
    reasons.push(snapshot.serverSide.evidence);
  }

  // Triage hold (mastra-ai/mastra#27360 family, nuxt/nuxt#36626): the repo
  // says do not build until triage clears. A hold is not a claim, so it
  // never produces TAKEN; it flags and caps an otherwise-GO verdict at
  // RISKY so held issues read as future pipeline, not current targets.
  const triageHold = detectTriageHold({ labels: snapshot.labels, comments: snapshot.comments });
  if (triageHold.held) {
    flags.push("triage-hold");
    reasons.push(triageHold.evidence);
  }

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
  // one is handled by rule 12 below; neither can produce TAKEN.
  const mentioned = snapshot.commentMentionedPRs ?? [];
  const openMentioned = mentioned.filter(
    (p) => p.state === "open" && p.mentionsIssue && !p.fromAuthor
  );
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

  // Rule 12: partially-addressed. A merged PR is evidence that part of
  // the issue already shipped when (a) its title/body references this
  // issue number, or (b) a maintainer comment signaling shipped work
  // cites it. Case (b) matters because maintainers often narrate shipped
  // work ("Half addressed by #905, merged to main in #915") without the
  // PR itself naming the issue. A plain GO hides the scoping work a
  // contributor must do, so flag it and cap GO at RISKY. Never TAKEN:
  // only an open closing PR does that (rule 3).
  const shipperCitedNumbers = new Set<number>();
  for (const c of snapshot.comments) {
    if (
      PARTIALLY_SHIPPED_COMMENT_RES.some((re) => re.test(c.body)) ||
      hasShippedInVersionSignal([c], snapshot.number)
    ) {
      for (const n of extractPRReferences([c], snapshot.owner, snapshot.repo)) {
        shipperCitedNumbers.add(n);
      }
    }
  }
  const shippedPRs = new Map<number, string>();
  const addShipped = (n: number) => {
    if (!shippedPRs.has(n)) shippedPRs.set(n, `PR #${n}, merged`);
  };
  for (const p of mentioned) {
    if (p.state === "merged" && (p.mentionsIssue || shipperCitedNumbers.has(p.number))) {
      addShipped(p.number);
    }
  }
  for (const pr of snapshot.linkedPRs) {
    if (pr.state === "merged" && (isClosingPR(pr) || shipperCitedNumbers.has(pr.number))) {
      addShipped(pr.number);
    }
  }
  const shippedParts = [...shippedPRs.values()];
  const partiallyShippedComment =
    snapshot.comments.some((c) => PARTIALLY_SHIPPED_COMMENT_RES.some((re) => re.test(c.body))) ||
    hasShippedInVersionSignal(snapshot.comments, snapshot.number);
  const consumedByRule12 = new Set<number>(shippedPRs.keys());
  if (shippedParts.length > 0 || partiallyShippedComment) {
    flags.push("partially-addressed");
    const detail =
      shippedParts.length > 0 ? shippedParts.join("; ") : "a maintainer comment";
    reasons.push(`part of this issue already shipped (${detail}); scope your work to what remains`);
    if (verdict === "GO") verdict = "RISKY";
  }
  // Rule 11's informational merged note, for merged references that did
  // not already produce the rule-12 reason.
  for (const p of mergedMentioned) {
    if (consumedByRule12.has(p.number)) continue;
    reasons.push(`PR #${p.number} (merged) referenced in comments; issue may be partially addressed`);
  }

  // Rule 3e: merged timeline cross-references that no other rule consumed.
  // A merged PR GitHub recorded against this issue usually means the work
  // already shipped, but not always: ghostfolio/ghostfolio#4605's merged
  // #7522 fixed only the unrestricted impersonation case while the
  // restricted-view case stayed open. So this caps an otherwise-GO verdict
  // at RISKY; it never produces TAKEN.
  if (mergedTimelineXrefs.length > 0 && verdict === "GO") {
    const unconsumed = mergedTimelineXrefs.filter((p) => !consumedByRule12.has(p.number));
    if (unconsumed.length > 0) {
      reasons.push(
        `timeline cross-referenced PR(s) already merged: ${unconsumed.map(xrefLabel).join("; ")}; the issue may already be fixed, verify what shipped before building`
      );
      verdict = "RISKY";
    }
  }

  // Rule 3c: duplicate-of warning. A still-open duplicate target (or one
  // closed as not_planned) is a heads-up to check there before building,
  // never a verdict change: the target's issue number and live state are
  // quoted so the contributor can go look.
  const dupOther = (snapshot.duplicateOf ?? []).find(
    (d) => !(d.state === "closed" && d.stateReason === "completed")
  );
  if (dupOther) {
    const status =
      dupOther.state === "closed" ? `closed as ${dupOther.stateReason ?? "unknown"}` : "still open";
    flags.push("duplicate-of-open");
    reasons.push(`marked duplicate of #${dupOther.number} (${dupOther.url}), which is ${status}; check there before building`);
  }

  // Attempt-linked downgrade: the evidence was added before rule 4 so claim
  // returns carry it; cap an otherwise-GO verdict at RISKY here, after
  // every other rule has had its say.
  if (attemptLinkedOpen.length > 0 && verdict === "GO") verdict = "RISKY";

  // Triage-hold cap: an otherwise-GO verdict on a held issue reads RISKY
  // (the hold is named in the reasons above). Never TAKEN.
  if (triageHold.held && verdict === "GO") verdict = "RISKY";

  return { verdict, reasons, claims, gates, flags };
}

/**
 * Comment shapes that signal part of an issue already shipped while the
 * rest stays open. Seen on reticlehq/reticle#894: "Half addressed by #905,
 * merged to main in #915", "leaving this open for half B", "Shipped in
 * v3.1.0".
 */
const PARTIALLY_SHIPPED_COMMENT_RES: RegExp[] = [
  /half (addressed|done|fixed)/i,
  /leaving (this|it) open for/i,
  /\bstill (open|remaining)\b/i,
  /part of this (is|was) (fixed|shipped)/i,
];

/** "/shipped in v/i near an issue reference" is the last pattern; the
 * four above run on every comment, and this one runs below with its
 * issue-reference guard. */
export function hasShippedInVersionSignal(comments: { body: string }[], issueNumber: number): boolean {
  return comments.some(
    (c) =>
      /shipped in v/i.test(c.body) &&
      (c.body.includes(`#${issueNumber}`) || /this issue/i.test(c.body))
  );
}

export { FRESH_CLAIM_DAYS, STALE_INACTIVITY_DAYS };
