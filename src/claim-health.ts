/**
 * Claims babysitting (Greenlight v0.9.0): for every claim in the my-claims
 * registry, run the issue's protocol status and bucket what it says into
 * one of six buckets.
 *
 * Buckets (in priority order):
 *   linked          — a PR is open against the claim: the work is with the
 *                     maintainer; fine, no action.
 *   queue-lost      — someone ahead completed, the claim expired, or the
 *                     issue's active claim belongs to someone else: the
 *                     claim no longer owns the work.
 *   expiring        — the lease has under 48h left: renew or land the PR.
 *   unlinked-stale  — 72h since the claim with no PR ever linked: the
 *                     claim is talk, not work.
 *   heartbeat-due   — the lease is past half with no activity on the
 *                     issue: post a progress note before the lease dies.
 *   healthy-active  — none of the above: the claim is alive and on pace.
 *
 * Pure: every network-shaped input comes in on the argument, so fixtures
 * plus mocked status responses prove the bucketing.
 */
import type { IssueStatusPayload } from "./protocol.js";
import type { MyClaim } from "./claims-registry.js";

export type ClaimBucket =
  | "linked"
  | "linked-dead"
  | "healthy-active"
  | "heartbeat-due"
  | "expiring"
  | "unlinked-stale"
  | "queue-lost";

/** "No activity" window for the unlinked-stale bucket. */
export const UNLINKED_STALE_HOURS = 72;
/** Lease-remaining threshold for the expiring bucket. */
export const EXPIRING_HOURS = 48;

export interface ClaimHealthInput {
  claim: MyClaim;
  /** Protocol status for the claimed issue. */
  status: IssueStatusPayload;
  /** The issue's updated_at (null when unreadable): heartbeat evidence. */
  issueUpdatedAt: string | null;
  now?: Date;
}

export interface ClaimHealth {
  bucket: ClaimBucket;
  /** One short line explaining the bucket, for the babysit report. */
  detail: string;
  /** The PR URL behind a linked bucket, when known. */
  prUrl?: string;
}

function hoursBetween(a: string, b: Date): number | null {
  const t = new Date(a).getTime();
  if (Number.isNaN(t)) return null;
  return (b.getTime() - t) / 3600000;
}

export function bucketClaim(input: ClaimHealthInput): ClaimHealth {
  const { claim, status } = input;
  const now = input.now ?? new Date();
  const tag = `${claim.owner}/${claim.repo}#${claim.number}`;
  const claimState = status.claim;

  // Linked-dead (v0.9.2): the claim froze on a PR that closed unmerged.
  // Nobody is working the issue, but the stale marker needs an explicit
  // release before the issue reads clean.
  if (claimState?.state === "linked-dead") {
    const closedPr = status.competing_prs.find((p) => p.state === "closed");
    return {
      bucket: "linked-dead",
      detail:
        `${tag}: linked PR ${closedPr ? `#${closedPr.number} by @${closedPr.author} ` : ""}closed unmerged — ` +
        `release the stale claim (post a comment containing <!-- greenlight-claim release -->)`,
      prUrl: closedPr?.url ?? claim.prUrl,
    };
  }

  // Linked: an open PR against the issue means the work is with the
  // maintainer. Prefer the operator's own PR; a known PR URL from the
  // registry counts too.
  const openPrs = status.competing_prs.filter((p) => p.state === "open");
  const mine = claim.claimant
    ? openPrs.find((p) => p.author.toLowerCase() === claim.claimant!.toLowerCase())
    : undefined;
  const anyOpen = mine ?? openPrs.find((p) => p.url === claim.prUrl) ?? openPrs[0];
  if (claimState?.state === "linked" && openPrs.length > 0) {
    return {
      bucket: "linked",
      detail: `${tag}: PR open (${anyOpen ? `#${anyOpen.number} by @${anyOpen.author}` : "claim linked"}) — work is with the maintainer`,
      prUrl: anyOpen?.url ?? claim.prUrl,
    };
  }

  // Queue-lost: the lease died, or the issue's active claim belongs to
  // someone else (superseded), or someone ahead completed.
  const someoneElseClaiming =
    claimState !== null && claim.claimant && claimState.claimant.toLowerCase() !== claim.claimant.toLowerCase();
  if (claimState?.state === "expired") {
    return { bucket: "queue-lost", detail: `${tag}: claim lease expired ${claimState.expires_at.slice(0, 10)} — re-claim or move on` };
  }
  if (someoneElseClaiming) {
    return {
      bucket: "queue-lost",
      detail: `${tag}: active protocol claim belongs to @${claimState!.claimant}, not you — your claim was superseded`,
    };
  }
  const completedAhead = status.competing_prs.some((p) => p.state === "merged" && p.author !== claim.claimant);
  if (completedAhead) {
    return { bucket: "queue-lost", detail: `${tag}: someone else's PR already merged — the work is done without you` };
  }

  // Expiring: the lease has under 48h left (or the ETA is blown).
  const remaining = claimState ? (new Date(claimState.expires_at).getTime() - now.getTime()) / 3600000 : null;
  if (remaining !== null && remaining < EXPIRING_HOURS) {
    return {
      bucket: "expiring",
      detail: `${tag}: lease ${remaining <= 0 ? "expired" : `expires in ${Math.round(remaining)}h`} (${claimState!.expires_at.slice(0, 10)}) — renew the claim or land the PR`,
    };
  }
  const ageHours = hoursBetween(claim.postedAt, now);
  if (ageHours !== null && claim.etaDays !== undefined && ageHours > claim.etaDays * 24) {
    return {
      bucket: "expiring",
      detail: `${tag}: ETA blown by ${Math.round(ageHours - claim.etaDays * 24)}h (promised ${claim.etaDays}d) — update the issue or land the PR`,
    };
  }

  // Unlinked-stale: 72h of claim with no PR ever linked.
  if (claimState?.state === "active" && ageHours !== null && ageHours > UNLINKED_STALE_HOURS) {
    return {
      bucket: "unlinked-stale",
      detail: `${tag}: claimed ${Math.round(ageHours / 24)}d ago with no PR linked — the claim is talk, not work`,
    };
  }

  // Heartbeat-due: lease past half with no activity on the issue since
  // the claim was posted.
  const leaseTotal = claimState ? hoursBetween(claimState.claimed_at, new Date(claimState.expires_at)) : null;
  const leaseElapsed = claimState ? hoursBetween(claimState.claimed_at, now) : null;
  const pastHalf = leaseTotal !== null && leaseTotal > 0 && leaseElapsed !== null && leaseElapsed > leaseTotal / 2;
  const updatedSince = input.issueUpdatedAt ? hoursBetween(input.issueUpdatedAt, now) : null;
  const noActivity =
    (input.issueUpdatedAt === null && updatedSince === null) ||
    (updatedSince !== null && ageHours !== null && updatedSince >= ageHours);
  if (pastHalf && noActivity) {
    return {
      bucket: "heartbeat-due",
      detail: `${tag}: lease past half (${Math.round(leaseElapsed! / 24)}d of ${Math.round(leaseTotal! / 24)}d) with no issue activity since the claim — post a progress note`,
    };
  }

  return {
    bucket: "healthy-active",
    detail: `${tag}: claim ${claimState ? `state ${claimState.state}, ` : ""}lease ${remaining !== null ? `${Math.round(remaining)}h left` : "unknown"} — on pace`,
  };
}
