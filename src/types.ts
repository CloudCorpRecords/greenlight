/**
 * Core data shapes for Greenlight. All scoring runs on these shapes,
 * whether they came from the live GitHub API or from a fixture file.
 */

export type Verdict = "GO" | "RISKY" | "TAKEN" | "GATED" | "STALE";

/** Minimal comment representation used for claim detection. */
export interface CommentSignal {
  author: string;
  body: string;
  createdAt: string; // ISO timestamp
}

/** A pull request that references the issue (linked, closes, or mentions). */
export interface LinkedPR {
  number: number;
  state: "open" | "closed" | "merged";
  title: string;
  url: string;
  /** How strongly the PR is tied to the issue. Only "closing" PRs take an issue. */
  linkStrength: "closing" | "mention";
}

/** A snapshot of one issue: everything the verdict engine needs. */
export interface IssueSnapshot {
  sourceUrl: string;
  owner: string;
  repo: string;
  number: number;
  state: "open" | "closed";
  title: string;
  body?: string; // issue body markdown; used by automation commands (prep checklist)
  author: string; // issue author login (skipped in claim detection unless they announce a fix)
  assignees: string[];
  labels: string[];
  comments: CommentSignal[];
  linkedPRs: LinkedPR[];
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  contributing?: string; // raw CONTRIBUTING.md text, when fetched
}

/** One detected claim signal from a comment. */
export interface ClaimSignal {
  author: string;
  createdAt: string; // ISO timestamp
  ageDays: number;
  strength: "strong" | "soft";
  phrase: string; // the matched pattern name
}

/** A contribution gate parsed from CONTRIBUTING / repo policy. */
export type GateKind =
  | "assignment_required"
  | "claim_first"
  | "vouch_required"
  | "cla_required"
  | "dco_required"
  | "discussion_first"
  | "collaborators_only";

export interface Gate {
  kind: GateKind;
  detected: boolean;
  evidence: string; // short snippet or source note
}

/** Signals used to score repo friction. Fields that cannot be computed stay null. */
export interface RepoSignals {
  owner: string;
  repo: string;
  gates: Gate[];
  externalPRMergeRate?: number | null; // 0..1 share of recent external PRs merged
  medianFirstReviewHours?: number | null;
  maintainerIssueResponseHours?: number | null;
  openGoodFirstIssueCount?: number | null;
  note?: string; // e.g. "hand-verified 2026-10-13" or "live"
}

/** The verdict for one issue, with the reasons in scoring order. */
export interface VerdictResult {
  verdict: Verdict;
  reasons: string[];
  claims: ClaimSignal[];
  gates: Gate[];
  flags: string[]; // e.g. "claimed", "stale_claim"
}

/** A scored repo, stored in data/friction-index.json. */
export interface FrictionReport {
  owner: string;
  repo: string;
  score: number; // 0..100, 100 = easiest
  gates: Gate[];
  reasons: string[];
  signals: RepoSignals;
}
