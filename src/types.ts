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
  /** GitHub comment id, when the fetch layer captured it. Absent on older fixtures. */
  id?: number;
}

/**
 * One AI-classified claim-intent signal from a comment. The optional
 * Fireworks layer returns these; the deterministic engine never invents
 * them, and they can only ever downgrade GO to RISKY (flag "llm-claim"),
 * never produce TAKEN or override GATED.
 */
export interface LLMClaimFlag {
  /** GitHub comment id, or a stable hash when the fixture had no id. */
  commentId: string;
  author: string;
  createdAt: string; // ISO timestamp
  /** Exact substring of the comment body; results without one are dropped. */
  quote: string;
  /** Model-reported confidence, 0 to 1. */
  confidence: number;
  /** Short model-supplied reason for the classification. */
  reason: string;
  /** Model id that produced the flag (env GREENLIGHT_LLM_MODEL). */
  model: string;
}

/** A pull request that references the issue (linked, closes, or mentions). */
export interface LinkedPR {
  number: number;
  state: "open" | "closed" | "merged";
  title: string;
  url: string;
  /** How strongly the PR is tied to the issue. Only "closing" PRs take an issue. */
  linkStrength: "closing" | "mention";
  /**
   * PR author's login (v0.13.0, for Timeline X-Ray's reporter-owned-PR
   * rule). Empty/absent on cache entries written before v0.13.0.
   */
  author?: string;
  /**
   * Where the link was found: "timeline" for GitHub's own
   * cross-referenced timeline events (the strongest race signal; a PR in
   * flight against the issue even when its body never says "closes #N"),
   * "search" for issue-number search hits, "comment" for PRs cited in
   * comments. Absent on older fixtures.
   */
  via?: "timeline" | "search" | "comment";
}

/** A pull request referenced in an issue comment, fetched and checked for issue overlap. */
export interface MentionedPR {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  /** True when the PR title/body references this issue's number. */
  mentionsIssue: boolean;
  /**
   * True when the PR was linked from a fix-announcement comment: a
   * "/attempt" (or "/claim") bot command, or a "Submitted fix for ... in
   * <PR url>" narrative. Seen on tscircuit/tscircuit#5563, where a
   * contributor posted /attempt comments and then linked fix PRs for each
   * sub-bug (in other repos of the same org) that no list view surfaced.
   * These count as race signals even when the PR does not name the issue.
   */
  attemptLinked?: boolean;
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
  /** Gates supplied from a gatefile contribution-gates.json, already mapped to Greenlight kinds. */
  externalGates?: Gate[];
  /** Detected-only gates from the .github/workflows scan (external_prs_closed). */
  workflowGates?: Gate[];
  /**
   * Other issues this issue is marked a duplicate of (from "duplicate of
   * #N" comments and marked-as-duplicate timeline signals), each fetched
   * for its current state. n8n-io/n8n#41215 was a duplicate of #40803,
   * already closed as completed: a full build was nearly wasted on it.
   */
  duplicateOf?: DuplicateTarget[];
  /**
   * Server-side-only signal (best-effort): set when a quoted error string
   * from the issue body has zero hits in the repo, meaning the check may
   * be enforced by a backend service outside this repo. Absent when there
   * is no evidence.
   */
  serverSide?: { flag: string; evidence: string };
  /**
   * v0.16.2: behavioral gate from maintainer actions (not policy text),
   * attached by the caller when the behavioral pass ran for this repo.
   * When detected, scoreIssue caps the verdict at GATED, the same
   * treatment the policy-file agents_banned gate gets.
   */
  behavioralGate?: import("./behavior.js").BehavioralGate | null;
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
  | "collaborators_only"
  /**
   * The repo has paused unsolicited outside PRs. Seen on
   * activepieces/activepieces#16580/#16581: CONTRIBUTING said unsolicited
   * PRs from outside the core team were paused, and two finished PRs were
   * auto-closed within about a minute.
   */
  | "unsolicited_prs_paused"
  /**
   * v0.17.0: a scoped intake pause. The repo refuses PRs in a named
   * category while staying open to everything else (prettier: "we are not
   * accepting pull requests that add new formatting options"). Lighter
   * weight than the blanket pause above: friction scores it at half the
   * penalty and check/scan caps the verdict at RISKY (a scope to read,
   * not a block). Named against the index scanner's paused/scoped
   * taxonomy, where "paused" is the blanket kind and "scoped" is the
   * category-limited one.
   */
  | "scoped_prs_paused"
  /**
   * A repo workflow closes external PRs automatically ("Close external
   * PRs" style), the sharp end of the paused-PR policy above.
   */
  | "external_prs_closed"
  /**
   * The repo bans autonomous-agent contributions outright, usually in
   * AGENTS.md or CLAUDE.md rather than CONTRIBUTING (nuxt/nuxt's
   * AGENTS.md: "Contributions may only be submitted by a human who
   * fully understands them... autonomous agents are not allowed"). This
   * is a hard block for anyone working through an agent: only a human
   * may submit. Never satisfied by tooling; claim refuses.
   */
  | "agents_banned"
  /**
   * The repo permits agent-assisted work but requires disclosure, often
   * plus an [AI] prefix on PR titles and commits (actualbudget/actual's
   * AI Usage Policy + AGENTS.md). A flag, never a verdict change: prep
   * turns it into concrete required actions.
   */
  | "agents_disclosure";

/** Another issue this one is marked a duplicate of, with its live state. */
export interface DuplicateTarget {
  number: number;
  url: string;
  state: "open" | "closed";
  /** GitHub's state_reason: "completed" | "not_planned" | "reopened" | undefined. */
  stateReason?: string;
}

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
  /**
   * v0.9.3: the same share as a 0..100 number. Ratio fields in JSON output
   * always ship both units now (fraction + _pct) so consumers never have
   * to guess: the fraction keeps its meaning, the _pct is unambiguous.
   */
  externalPRMergeRate_pct?: number | null;
  medianFirstReviewHours?: number | null;
  maintainerIssueResponseHours?: number | null;
  openGoodFirstIssueCount?: number | null;
  /**
   * v0.16.0: behavioral gate from maintainer actions (not policy text).
   * Set when detectBehavioralGate ran; null when skipped or unavailable.
   * When detected, scoreFriction applies the documented -20 penalty.
   */
  behavioralGate?: import("./behavior.js").BehavioralGate | null;
  note?: string; // e.g. "hand-verified 2026-10-13" or "live"
}

/** The verdict for one issue, with the reasons in scoring order. */
export interface VerdictResult {
  verdict: Verdict;
  reasons: string[];
  claims: ClaimSignal[];
  gates: Gate[];
  flags: string[]; // e.g. "claimed", "stale_claim"
  /** AI claim-intent flags (optional layer, off by default). Absent when the layer is disabled. */
  llm_claims?: LLMClaimFlag[];
  /**
   * v0.9.2: whether the AI claim layer ran for this verdict, and why not.
   * check/scan render this so a silently-dead layer can never again hide
   * behind patterns-only output (the 2026-10-17 field misses).
   */
  llm_status?: LlmLayerStatus;
}

/**
 * Transparency for the optional AI claim layer (v0.9.2). `ran: true`
 * means a classification round completed (flags may still be empty);
 * `ran: false` always carries a human reason.
 */
export interface LlmLayerStatus {
  ran: boolean;
  /** Model id when the layer ran (or would have run). */
  model?: string;
  /** Human reason when the layer did not run or the round failed. */
  reason?: string;
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
  /**
   * Merge velocity, when computed: share of recent merged PRs authored
   * by non-collaborators and the median days to merge. Since v0.18.0
   * (item 11) the share also feeds the documented external merge-rate
   * score term via signals.externalPRMergeRate. Absent when it could
   * not be computed.
   */
  mergeVelocity?: import("./merge-velocity.js").MergeVelocityStats | null;
  /**
   * v0.18.0 (item 15): set when the requested repo name was an old
   * (renamed) name; carries "owner/repo" as given. owner/repo on the
   * report are always the canonical names.
   */
  resolvedFrom?: string;
  /**
   * v0.9.3: outsider merge share with an explicit unit contract, because
   * an implicit fraction was once rendered as a percent downstream.
   * `outsider_merge_share` is the 0..1 fraction (same meaning as
   * mergeVelocity.externalShare); `outsider_merge_share_pct` is the same
   * number on a 0..100 scale, rounded. Both are null when uncomputable.
   */
  outsider_merge_share?: number | null;
  outsider_merge_share_pct?: number | null;
  /**
   * v0.16.0: behavioral gate verdict (maintainer actions, not policy
   * text). Consumers like the policy-index rebaseline read this field to
   * reclassify repos whose written policy is silent but whose practice is
   * hostile. Null when the pass was skipped or failed.
   *
   * v0.17.1 (item 12): this top-level field is the CANONICAL location.
   * `signals.behavioralGate` is kept as a mirror for index-pipeline
   * compatibility; both always carry the same value.
   */
  behavioral_gate?: import("./behavior.js").BehavioralGate | null;
}
