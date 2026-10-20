/**
 * Merge velocity: how fast outside PRs land in a repo. Its externalShare
 * feeds friction's documented external merge-rate score term (v0.18.0,
 * item 11); it is still never a verdict input on its own. The contrast
 * it draws is resend merging outsiders same-day while crewAI's buildable
 * issues were all claimed by a cohort: only the share of
 * non-collaborator merges tells those stories apart.
 *
 * Economical by design: a single /pulls call (author_association comes
 * back in the list response, so no per-author collaborator checks).
 */
import { apiGet } from "./github.js";

export interface MergedPRRow {
  authorAssociation: string;
  createdAt: string; // ISO timestamp
  mergedAt: string | null; // ISO timestamp, null when the PR was closed unmerged
}

export interface MergeVelocityStats {
  /** Number of merged PRs in the sample. */
  mergedPRs: number;
  /** Share (0..1) of the sample authored by non-collaborators. */
  externalShare: number;
  /** Median days from PR creation to merge. */
  medianMergeDays: number;
}

const INTERNAL = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const SAMPLE = 30;

export function computeMergeVelocityStats(rows: MergedPRRow[]): MergeVelocityStats | null {
  const merged = rows.filter((r) => r.mergedAt);
  if (merged.length === 0) return null;
  const external = merged.filter((r) => !INTERNAL.has(r.authorAssociation)).length;
  const days = merged
    .map((r) => (new Date(r.mergedAt as string).getTime() - new Date(r.createdAt).getTime()) / 86400000)
    .sort((a, b) => a - b);
  const mid = Math.floor(days.length / 2);
  const median = days.length % 2 === 1 ? days[mid] : (days[mid - 1] + days[mid]) / 2;
  return {
    mergedPRs: merged.length,
    externalShare: Math.round((external / merged.length) * 100) / 100,
    medianMergeDays: Math.round(median * 10) / 10,
  };
}

/** One-line human summary, e.g. "external merge share 40%, median merge 2.1d (28 merged PRs)". */
export function describeMergeVelocity(s: MergeVelocityStats): string {
  return `external merge share ${Math.round(s.externalShare * 100)}%, median merge ${s.medianMergeDays}d (${s.mergedPRs} merged PRs)`;
}

export interface MergeVelocityDeps {
  /** Test seam: closed PR rows, newest first. */
  listClosedPulls?: (owner: string, repo: string) => Promise<MergedPRRow[]>;
}

interface PullListItem {
  author_association?: unknown;
  created_at?: unknown;
  merged_at?: unknown;
}

/** The newest closed PRs (bounded), from which the merged sample is drawn. */
export async function fetchMergeVelocity(
  owner: string,
  repo: string,
  deps: MergeVelocityDeps = {}
): Promise<MergeVelocityStats | null> {
  let rows: MergedPRRow[];
  if (deps.listClosedPulls) {
    rows = await deps.listClosedPulls(owner, repo);
  } else {
    const data = (await apiGet(
      `/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${SAMPLE}`
    )) as PullListItem[];
    rows = (data ?? []).map((p) => ({
      authorAssociation: String(p.author_association ?? ""),
      createdAt: String(p.created_at ?? ""),
      mergedAt: p.merged_at == null ? null : String(p.merged_at),
    }));
  }
  return computeMergeVelocityStats(rows);
}
