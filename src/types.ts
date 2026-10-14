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

/** A pull request referenced in an issue comment, fetched and checked for issue overlap. */
export interface MentionedPR {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  /** True when the PR title/body references this issue's number. */
  mentionsIssue: boolean;
  /**
   * True when the citing comment came from the issue author. The open-PR
   * downgrade (rule 11) only trusts non-author heads-ups, but a
   * maintainer narrating what already shipped (rule 12) is usually the
   * issue author, so partially-addressed detection reads both.
   */
  fromAuthor?: boolean;
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
  /** Per-file policy texts (CONTRIBUTING variants, AGENTS.md, CLAUDE.md). */
  houseRules?: { file: string; text: string }[];
  author: string; // issue author login (skipped in claim detection unless they announce a fix)
  assignees: string[];
  labels: string[];
  comments: CommentSignal[];
  linkedPRs: LinkedPR[];
  /** PRs cited in non-author comments, scored for overlap with this issue. Absent on older fixtures. */
  commentMentionedPRs?: MentionedPR[];
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
  /** "full" claims the whole issue; "partial" scopes itself to part of the work. */
  scope: "full" | "partial";
  /** The scope word matched for partial claims (e.g. "fallback", "remaining"). */
  scopeWord?: string;
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
  /** File the gate evidence came from, e.g. "CONTRIBUTING.md" or "AGENTS.md". */
  source?: string;
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

/**
 * Repo conventions learned during prep: the local rituals a contributor
 * must follow. All fields are best-effort; a repo may provide none.
 */
export interface RepoConventions {
  /** Policy files present at the repo, e.g. ["CONTRIBUTING.md", "AGENTS.md"]. */
  houseRuleFiles: string[];
  /** Backticked run commands quoted in the house rules, e.g. ["pnpm verify"]. */
  verifyCommands: string[];
  /** True when a .changes/ or .changeset directory exists at the repo root. */
  changesDir: boolean;
  /** Which one was found, e.g. ".changes" or ".changeset". */
  changesDirName?: string;
  /** Root package.json script names worth running before pushing (subset of test/verify/lint/typecheck/build). */
  packageScripts: string[];
  /** True when 60%+ of the last 20 default-branch commits match Conventional Commits. */
  conventionalCommits: boolean;
  /** One short example commit subject when conventionalCommits is true. */
  exampleCommit?: string;
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
