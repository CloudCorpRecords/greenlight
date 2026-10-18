/**
 * Maintainer-side guard. Answers the question a maintainer asks about an
 * INCOMING pull request: "is this PR worth my time?"
 *
 * Four checks, all evidence-carrying, all degradable:
 *
 *   1. competing-fix — the PR claims an issue (via "fixes/closes #N" in
 *      the body, an issue number in the branch name, or a cross-repo
 *      "Fixes owner/repo#N" / "Fixes https://github.com/owner/repo/issues/N");
 *      the issue's timeline cross-reference walk then names OTHER open PRs
 *      already fixing it, fetching the issue from its own repo when the
 *      reference is cross-repo. Reuses fetchLinkedPRs /
 *      classifyLinkStrength, the same machinery that catches the race
 *      cases (e2b-dev/E2B#1986 with its PR #1987, ComposioHQ/composio#4904
 *      with #4907 and #4922).
 *   2. other-claim — claim detection (claims.ts) on the linked issue's
 *      comments: a strong or soft claim from someone other than the PR
 *      author that predates the PR is reported with the claimant and
 *      date. A claim by the PR author is a pass, noted not flagged.
 *   3. missing-artifact — from the PR's changed files: repos detected to
 *      use .changes/ or .changeset/ flag a PR that adds no such file
 *      (with the expected pattern); DCO repos flag commits without a
 *      Signed-off-by trailer; CLA-gated repos flag "CLA status not
 *      visible" when no cla-signed label and no signature comment from
 *      the author exist. Absence of evidence is stated as such, never
 *      as proof the author did not sign.
 *   4. first-time — the author's prior merged-PR count in the repo (one
 *      search call, capped); zero means first-time contributor. Best
 *      effort: null on failure, no finding then.
 *   5. protocol-claim — the Claim Protocol state of each linked issue: an
 *      active or linked protocol claim held by someone other than the PR
 *      author is a flag (with the claim's expiry and the public queue);
 *      a claim held by the author is a pass note; completed claims are
 *      neither. Best effort: an unreadable issue means no protocol
 *      finding for it.
 *
 * The classifier is pure over injected data; the fetch layer follows the
 * ci-triage / review-triage test-seam pattern (GuardDeps). The command
 * never posts anything: it renders markdown that a maintainer (or the
 * bundled GitHub Action) posts as one PR comment.
 *
 * Per-repo silencing: `.greenlight-guard.json` in the working directory,
 * a JSON object with boolean keys per check ("competing-fix",
 * "other-claim", "missing-artifact", "first-time", "protocol-claim");
 * unknown keys are ignored, a missing or unreadable file means every
 * check is on.
 *
 * Autopilot (check 6, maintainer-side action, off by default): the same
 * config file may carry an "autopilot" section with a label map and a
 * nudge toggle:
 *
 *   { "autopilot": { "labels": { "protocol-claim": "claim-conflict",
 *                                "competing-fix": "duplicate-effort",
 *                                "changeset-missing": "needs-changeset" },
 *                    "nudge": true } }
 *
 * When enabled, the guard COMPUTES label decisions (check id -> label
 * name, flags only) and ready-to-copy stale-claim nudge lines. It never
 * applies labels or posts comments itself: the bundled GitHub Action
 * reads the decisions from the guard JSON and applies the labels with
 * the Actions token. The CLI reports the decisions with
 * --labels-dry-run.
 */
import { readFileSync } from "node:fs";
import { apiGet, parsePullUrl, fetchLinkedPRs, fetchComments } from "./github.js";
import { detectClaims, isBotAuthor } from "./claims.js";
import { classifyLinkStrength, isClosingPR } from "./linkstrength.js";
import { detectClaPath, detectChangesetConvention } from "./prep-detail.js";
import { titleSlug } from "./automate.js";
import { parseGates } from "./gates.js";
import type { CommentSignal, LinkedPR } from "./types.js";
import { fetchProtocolState, type ProtocolFetchResult } from "./protocol-fetch.js";
import { defaultPackageVersion } from "./doctor.js";

/** The hidden marker the GitHub Action uses to find its own comment and update it. */
export const GUARD_COMMENT_MARKER = "<!-- greenlight-guard -->";

/** Check ids, also the keys of .greenlight-guard.json. */
export const GUARD_CHECKS = ["competing-fix", "other-claim", "missing-artifact", "first-time", "protocol-claim"] as const;
export type GuardCheckId = (typeof GUARD_CHECKS)[number];

export interface AutopilotConfig {
  /**
   * Machine check id (e.g. "competing-fix", "protocol-claim",
   * "changeset-missing") -> label name to apply. Only findings with
   * severity "flag" can earn a label; notes never do.
   */
  labels: Record<string, string>;
  /**
   * When true, the guard comment includes ready-to-copy stale-claim nudge
   * lines for the maintainer. The guard never posts them anywhere itself.
   */
  nudge: boolean;
}

export interface GuardConfig extends Record<GuardCheckId, boolean> {
  /** Autopilot is off when absent: the default. Maintainer opts in. */
  autopilot?: AutopilotConfig | null;
}

export function defaultGuardConfig(): GuardConfig {
  return { "competing-fix": true, "other-claim": true, "missing-artifact": true, "first-time": true, "protocol-claim": true, autopilot: null };
}

/** Parse the autopilot section of a raw config object. Anything malformed means off. */
export function parseAutopilotConfig(raw: unknown): AutopilotConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const ap = obj["autopilot"];
  if (!ap || typeof ap !== "object") return null;
  const apObj = ap as Record<string, unknown>;
  const labels: Record<string, string> = {};
  const rawLabels = apObj["labels"];
  if (rawLabels && typeof rawLabels === "object") {
    for (const [k, v] of Object.entries(rawLabels as Record<string, unknown>)) {
      if (typeof k === "string" && k.trim() && typeof v === "string" && v.trim()) {
        labels[k.trim()] = v.trim();
      }
    }
  }
  return { labels, nudge: apObj["nudge"] === true };
}

/** Read .greenlight-guard.json from a directory (default cwd). Best-effort: anything unreadable means all checks on and autopilot off. */
export function readGuardConfig(dir = process.cwd()): GuardConfig {
  const config = defaultGuardConfig();
  try {
    const raw = JSON.parse(readFileSync(`${dir}/.greenlight-guard.json`, "utf8")) as Record<string, unknown>;
    for (const id of GUARD_CHECKS) {
      if (typeof raw[id] === "boolean") config[id] = raw[id];
    }
    config.autopilot = parseAutopilotConfig(raw);
  } catch {
    // Missing or broken config: all checks stay on, autopilot stays off.
  }
  return config;
}

export interface GuardLinkedIssue {
  number: number;
  title: string;
  url: string;
  state: string;
}

export interface GuardCompetingPR {
  issueNumber: number;
  number: number;
  title: string;
  url: string;
  author: string;
  state: string;
  linkStrength: "closing" | "mention";
  via?: string;
  /** "owner/repo#N" when the issue lives in another repo; undefined for same-repo. */
  issueRef?: string;
}

export interface GuardClaim {
  issueNumber: number;
  author: string;
  createdAt: string;
  ageDays: number;
  strength: "strong" | "soft";
  phrase: string;
  claimedByAuthor: boolean;
  /** "owner/repo#N" when the issue lives in another repo; undefined for same-repo. */
  issueRef?: string;
}

export interface GuardFinding {
  /** Machine key, e.g. "competing-fix" / "protocol-claim" / "changeset-missing" / "dco-missing" / "cla-status" / "first-time". */
  check: string;
  /** "flag" counts toward the summary and the exit code; "note" is information. */
  severity: "flag" | "note";
  title: string;
  evidence: string[];
  /**
   * What the flag is about (v0.9.1). "pr" = this PR's own diff/commits/
   * reviews (missing artifacts, first-time contributor). "issue" = one of
   * the PR's linked issues (competing fix, foreign claims, protocol
   * claims); `issueRef` names it as "owner/repo#N". "repo" = repo-wide
   * signal not tied to this PR or its issues. Consumers (babysit) raise
   * needs-you only for subject "pr", and for subject "issue" when the
   * issue is the PR's own linked issue; everything else is informational.
   */
  subject: "pr" | "issue" | "repo";
  /** Canonical "owner/repo#N" for subject "issue" findings. */
  issueRef?: string;
}

export interface GuardResult {
  pr: string;
  number: number;
  repo: string;
  title: string;
  author: string;
  linkedIssues: GuardLinkedIssue[];
  competingPRs: GuardCompetingPR[];
  claims: GuardClaim[];
  findings: GuardFinding[];
  /** "Greenlight guard: N things to check" or "Greenlight guard: nothing flagged". */
  summary: string;
  /** True when at least one finding has severity "flag". */
  hasFindings: boolean;
  /**
   * Autopilot label decisions: label names to apply, computed from the
   * config's label map over severity-"flag" findings only. Empty unless
   * the maintainer enabled autopilot in .greenlight-guard.json. The guard
   * never applies these itself; the bundled Action does.
   */
  autopilotLabels: string[];
  /** The check-by-check decisions behind autopilotLabels (for dry-run display). */
  autopilotLabelDecisions: AutopilotLabelDecision[];
  /**
   * Ready-to-copy stale-claim nudge lines for the maintainer, included in
   * the guard comment when autopilot.nudge is on. The guard never posts
   * them anywhere itself.
   */
  staleClaimNudges: string[];
  /** The comment-ready markdown. */
  markdown: string;
}

export interface GuardPullDetail {
  title: string;
  body: string;
  author: string;
  headRef: string;
  createdAt: string;
  labels: string[];
  changedFiles: string[];
  commits: Array<{ sha: string; message: string }>;
  comments: CommentSignal[];
}

export interface GuardIssueDetail {
  number: number;
  title: string;
  author: string;
  state: string;
  comments: CommentSignal[];
}

export interface GuardRepoConventions {
  changesetDir?: ".changes" | ".changeset";
  changesetExample?: string;
  dcoRequired: boolean;
  claRequired: boolean;
}

/* ------------------------------------------------------------------ */
/* Pure detectors                                                      */
/* ------------------------------------------------------------------ */

/**
 * Issue numbers this PR claims to fix: closing keywords in body or title
 * ("fixes #N"), "#N" in the title, or the number as a standalone token in
 * the branch name. Reuses classifyLinkStrength so the branch-token rule
 * matches the race-detection behavior exactly.
 */
export function extractLinkedIssueNumbers(title: string, body: string, branch: string): number[] {
  const candidates = new Set<number>();
  for (const text of [title, body]) {
    for (const m of text.matchAll(/#(\d{1,6})\b/g)) {
      const n = Number(m[1]);
      if (n > 0) candidates.add(n);
    }
  }
  // The branch name may carry the issue number as its only signal
  // ("fix/61-widget"). classifyLinkStrength's token test rejects near
  // misses like "feat/610-x" for issue 61, so collecting branch numbers
  // is safe: non-closing ones are filtered below.
  // One exception: version numbers in dependabot-style branches
  // ("dependabot/npm_and_yarn/vitest-5.0.4") must not claim issue #5.
  // Dotted version sequences are stripped before token collection.
  const branchNoVersions = branch.replace(/\d+\.\d+(\.\d+)*([-+][\w.]+)?/g, "");
  for (const m of branchNoVersions.matchAll(/\d{1,6}/g)) {
    const n = Number(m[0]);
    if (n > 0) candidates.add(n);
  }
  return [...candidates].filter((n) => classifyLinkStrength({ title, body, branch, issueNumber: n }) === "closing");
}

/**
 * A cross-repo issue reference this PR claims to fix, e.g. "acme/widgets#123".
 * The PR's own repo is tracked separately (same-repo #N machinery); the
 * issue lives in another repo, so the guard must fetch THAT repo's issue
 * (comments for claims, timeline for competing PRs).
 */
export interface GuardIssueRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Cross-repo issue references this PR claims to fix:
 *   - "Fixes acme/widgets#123" (closing keyword + owner/repo#N)
 *   - "Closes https://github.com/acme/widgets/issues/123" (closing keyword + issue URL)
 *   - an issue URL in the PR title (author intent, mirroring the
 *     "#N in the title is closing" rule for same-repo links)
 *
 * Only closing intent counts: "see acme/widgets#123" or "related to
 * acme/widgets#123" never count, exactly as for same-repo mentions.
 * References pointing back at the PR's own repo are skipped; the
 * same-repo machinery already handles those.
 */
export function extractCrossRepoIssues(
  title: string,
  body: string,
  prOwner: string,
  prRepo: string
): GuardIssueRef[] {
  const found = new Map<string, GuardIssueRef>();
  const add = (owner: string, repo: string, n: number) => {
    if (n <= 0) return;
    if (owner.toLowerCase() === prOwner.toLowerCase() && repo.toLowerCase() === prRepo.toLowerCase()) return;
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${n}`;
    if (!found.has(key)) found.set(key, { owner, repo, number: n });
  };
  const closingSrc = "(?:close[sd]?|closing|fix(?:e[sd])?|fixes|resolve[sd]?|resolves)";
  // "Fixes acme/widgets#123". The optional URL prefix also catches
  // "Fixes https://github.com/acme/widgets#123" (not a real GitHub form,
  // harmless to catch). It can never match ".../issues/123" because that
  // path has no "#" after the repo name.
  const refRe = new RegExp(
    `${closingSrc}\\s*:?\\s*(?:https?:\\/\\/github\\.com\\/)?([\\w.-]+)\\/([\\w.-]+)#(\\d{1,6})\\b`,
    "gi"
  );
  // "Fixes https://github.com/acme/widgets/issues/123"
  const urlRe = new RegExp(
    `${closingSrc}\\s*:?\\s*https?:\\/\\/github\\.com\\/([\\w.-]+)\\/([\\w.-]+)\\/issues\\/(\\d{1,6})\\b`,
    "gi"
  );
  for (const text of [title, body]) {
    for (const m of text.matchAll(refRe)) add(m[1], m[2], Number(m[3]));
    for (const m of text.matchAll(urlRe)) add(m[1], m[2], Number(m[3]));
  }
  const titleUrlRe = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d{1,6})\b/g;
  for (const m of title.matchAll(titleUrlRe)) add(m[1], m[2], Number(m[3]));
  return [...found.values()];
}

/** Other OPEN PRs already fixing the same issue, excluding this PR. Only "closing"-strength links count. */
export function findCompetingPRs(
  issueNumber: number,
  linkedPRs: LinkedPR[],
  prNumber: number,
  authorsByNumber?: Map<number, string>
): GuardCompetingPR[] {
  const out: GuardCompetingPR[] = [];
  for (const pr of linkedPRs) {
    if (pr.number === prNumber) continue;
    if (pr.state !== "open") continue;
    if (!isClosingPR(pr)) continue;
    out.push({
      issueNumber,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: authorsByNumber?.get(pr.number) ?? "unknown",
      state: pr.state,
      linkStrength: pr.linkStrength,
      via: pr.via,
    });
  }
  return out;
}

/**
 * Claims on the linked issue, split by authorship. Only claims that
 * predate the PR count (a claim posted after the PR cannot have been a
 * race). Bot authors are excluded by detectClaims itself. Returns foreign
 * claims plus whether the author claimed it themselves (a pass, not a
 * flag).
 */
export function splitIssueClaims(
  issueAuthor: string,
  issueComments: CommentSignal[],
  prAuthor: string,
  prCreatedAt: string,
  issueNumber: number,
  now: Date = new Date()
): { foreign: GuardClaim[]; authorClaimed: GuardClaim | null } {
  const foreign: GuardClaim[] = [];
  let authorClaimed: GuardClaim | null = null;
  const prTime = new Date(prCreatedAt).getTime();
  for (const c of detectClaims(issueAuthor, issueComments, now)) {
    if (isBotAuthor(c.author)) continue;
    const claimTime = new Date(c.createdAt).getTime();
    if (Number.isNaN(claimTime) || claimTime >= prTime) continue;
    const claim: GuardClaim = {
      issueNumber,
      author: c.author,
      createdAt: c.createdAt,
      ageDays: c.ageDays,
      strength: c.strength,
      phrase: c.phrase,
      claimedByAuthor: c.author.toLowerCase() === prAuthor.toLowerCase(),
    };
    if (claim.claimedByAuthor) {
      authorClaimed = authorClaimed ?? claim;
    } else {
      foreign.push(claim);
    }
  }
  foreign.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { foreign, authorClaimed };
}

/** Days between two timestamps, rounded, never negative. */
function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)));
}

/** True when any line of the commit message is a DCO Signed-off-by trailer. */
export function commitHasSignoff(message: string): boolean {
  return message.split("\n").some((line) => /^Signed-off-by:\s*\S/i.test(line.trim()));
}

/**
 * The artifact findings: changeset file missing, DCO trailers missing,
 * CLA status not visible. Pure over injected repo conventions and PR data.
 * A "cla" artifact check fires only when the repo was detected to demand
 * a CLA path; wording is absence-of-evidence, never an accusation.
 */
export function checkMissingArtifacts(args: {
  conventions: GuardRepoConventions;
  changedFiles: string[];
  commits: Array<{ sha: string; message: string }>;
  prLabels: string[];
  prAuthor: string;
  prComments: CommentSignal[];
}): GuardFinding[] {
  const findings: GuardFinding[] = [];
  const { conventions, changedFiles, commits, prLabels, prAuthor, prComments } = args;

  if (conventions.changesetDir) {
    const dir = conventions.changesetDir;
    const hasFile = changedFiles.some((f) => f === `${dir}/` || f.startsWith(`${dir}/`));
    if (!hasFile) {
      findings.push({
        check: "changeset-missing",
        subject: "pr",
        severity: "flag",
        title: `Missing release-note file (repo uses ${dir}/)`,
        evidence: [
          `this PR changes ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} but adds no file under ${dir}/`,
          conventions.changesetExample
            ? `the repo assembles its changelog from ${dir}/; expected something like \`${conventions.changesetExample}\``
            : `the repo assembles its changelog from ${dir}/; add one file per change there`,
        ],
      });
    }
  }

  if (conventions.dcoRequired) {
    const unsigned = commits.filter((c) => !commitHasSignoff(c.message));
    if (unsigned.length > 0) {
      findings.push({
        check: "dco-missing",
        subject: "pr",
        severity: "flag",
        title: `DCO sign-off missing on ${unsigned.length} of ${commits.length} commit${commits.length === 1 ? "" : "s"}`,
        evidence: [
          `commits without a Signed-off-by trailer: ${unsigned
            .slice(0, 5)
            .map((c) => c.sha.slice(0, 7))
            .join(", ")}${unsigned.length > 5 ? ` (+${unsigned.length - 5} more)` : ""}`,
          `the repo requires \`git commit -s\` on every commit (Developer Certificate of Origin)`,
        ],
      });
    }
  }

  if (conventions.claRequired) {
    const labelSigned = prLabels.some((l) => l.toLowerCase() === "cla-signed");
    const commentSigned = prComments.some(
      (c) =>
        c.author.toLowerCase() === prAuthor.toLowerCase() &&
        /i have read the cla document and i hereby sign the cla/i.test(c.body)
    );
    if (!labelSigned && !commentSigned) {
      findings.push({
        check: "cla-status",
        subject: "pr",
        severity: "flag",
        title: "CLA status not visible",
        evidence: [
          `no \`cla-signed\` label and no signature comment from @${prAuthor} found on this PR`,
          `stated as absence of evidence only: the author may have signed through a flow this check cannot see`,
        ],
      });
    }
  }

  return findings;
}

/** A claim is stale when it is 14+ days old and no open PR has appeared on its issue. */
export const STALE_CLAIM_NUDGE_DAYS = 14;

export interface AutopilotLabelDecision {
  check: string;
  title: string;
  label: string;
}

/**
 * Decide autopilot labels: the config's label map over severity-"flag"
 * findings only. Pure, so fixtures can prove the mapping and the default-off.
 * Notes never earn labels.
 */
export function decideAutopilotLabels(
  findings: GuardFinding[],
  autopilot: AutopilotConfig | null | undefined
): AutopilotLabelDecision[] {
  if (!autopilot) return [];
  const seen = new Set<string>();
  const decisions: AutopilotLabelDecision[] = [];
  for (const f of findings) {
    if (f.severity !== "flag") continue;
    const label = autopilot.labels[f.check];
    if (typeof label !== "string" || label.trim().length === 0) continue;
    const key = label.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    decisions.push({ check: f.check, title: f.title, label: key });
  }
  return decisions;
}

/**
 * Build ready-to-copy nudge lines for stale foreign claims: 14+ days old
 * with no OTHER open PR on the same issue (the guarded PR is the new
 * arrival; another open PR means the claim is not stale). The maintainer
 * copies and posts them on the issue; the guard never posts on the issue
 * itself (sovereignty). Pure over the guard's own claims and competing
 * PRs.
 */
export function buildStaleClaimNudges(
  claims: GuardClaim[],
  competingPRs: GuardCompetingPR[],
  guardedPrNumber: number
): string[] {
  const nudges: string[] = [];
  for (const c of claims) {
    if (c.claimedByAuthor) continue;
    if (c.ageDays < STALE_CLAIM_NUDGE_DAYS) continue;
    const ref = c.issueRef ?? undefined;
    const hasCompeting = competingPRs.some(
      (p) => p.issueNumber === c.issueNumber && (p.issueRef ?? undefined) === ref
    );
    if (hasCompeting) continue;
    const label = c.issueRef ?? `#${c.issueNumber}`;
    nudges.push(
      `@${c.author} claimed ${label} ${c.ageDays} days ago and never opened a PR. ` +
        `This PR (#${guardedPrNumber}) now addresses it — if you're still working on it, reply to keep your claim; otherwise the claim lapses.`
    );
  }
  return nudges;
}

/** Light author-history signal. Null means the lookup failed: no finding. */
export function checkFirstTime(author: string, priorMerged: number | null): GuardFinding | null {
  if (priorMerged === null) return null;
  if (priorMerged > 0) return null;
  return {
    check: "first-time",
    subject: "pr",
    severity: "note",
    title: `First-time contributor`,
    evidence: [`@${author} has no previously merged PRs in this repo`],
  };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function renderGuardMarkdown(result: Omit<GuardResult, "markdown">): string {
  const lines: string[] = [GUARD_COMMENT_MARKER];
  lines.push(`**${result.summary}** — on [${result.repo}#${result.number}](${result.pr}) "${result.title}" by @${result.author}`);
  lines.push("");

  const flags = result.findings.filter((f) => f.severity === "flag");
  const notes = result.findings.filter((f) => f.severity === "note");

  if (flags.length === 0) {
    lines.push("_Nothing flagged._ The checks below found no competing fix, no prior claim by someone else, and no missing artifacts.");
    lines.push("");
  } else {
    let i = 0;
    for (const f of flags) {
      i += 1;
      lines.push(`**${i}. ${f.title}**`);
      for (const e of f.evidence) lines.push(`- ${e}`);
      lines.push("");
    }
  }

  if (notes.length > 0) {
    lines.push("Notes:");
    for (const f of notes) {
      for (const e of f.evidence) lines.push(`- ${e}`);
    }
    lines.push("");
  }

  if (result.staleClaimNudges.length > 0) {
    lines.push("For the maintainer (autopilot nudge lines — copy and paste onto the issue; the guard never posts these itself):");
    for (const n of result.staleClaimNudges) {
      lines.push(`> ${n}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    `_Checked with [Greenlight guard](https://github.com/CloudCorpRecords/greenlight) v${defaultPackageVersion()}; findings are signals, verify before acting._`
  );
  return lines.join("\n");
}

export function buildGuardSummary(findings: GuardFinding[]): { summary: string; hasFindings: boolean } {
  const flags = findings.filter((f) => f.severity === "flag").length;
  return {
    summary: flags === 0 ? "Greenlight guard: nothing flagged" : `Greenlight guard: ${flags} ${plural(flags, "thing", "things")} to check`,
    hasFindings: flags > 0,
  };
}

/* ------------------------------------------------------------------ */
/* Fetch layer (test-seam, mirrors ci-triage)                          */
/* ------------------------------------------------------------------ */

interface PullApiItem {
  title?: unknown;
  body?: unknown;
  user?: { login?: unknown };
  head?: { ref?: unknown };
  base?: { ref?: unknown };
  created_at?: unknown;
  labels?: Array<{ name?: unknown }>;
}

interface CommitApiItem {
  sha?: unknown;
  commit?: { message?: unknown };
}

interface IssueApiItem {
  title?: unknown;
  user?: { login?: unknown };
  state?: unknown;
}

interface SearchApiItem {
  total_count?: unknown;
}

interface RootApiItem {
  name?: unknown;
  type?: unknown;
}

export interface GuardDeps {
  fetchPull?: (owner: string, repo: string, number: number) => Promise<GuardPullDetail>;
  fetchIssue?: (owner: string, repo: string, number: number) => Promise<GuardIssueDetail>;
  fetchLinkedPRs?: (owner: string, repo: string, issueNumber: number) => Promise<LinkedPR[]>;
  fetchPRAuthor?: (owner: string, repo: string, number: number) => Promise<string>;
  fetchConventions?: (owner: string, repo: string, issueNumber: number) => Promise<GuardRepoConventions>;
  fetchPriorMerged?: (owner: string, repo: string, author: string) => Promise<number | null>;
  fetchProtocol?: (owner: string, repo: string, issueNumber: number) => Promise<ProtocolFetchResult | null>;
}

async function paginateFiles(owner: string, repo: string, number: number): Promise<string[]> {
  const files: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const data = (await apiGet(
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`
    )) as Array<{ filename?: unknown }>;
    for (const f of data ?? []) {
      if (typeof f.filename === "string") files.push(f.filename);
    }
    if ((data ?? []).length < 100) break;
  }
  return files;
}

async function defaultFetchPull(owner: string, repo: string, number: number): Promise<GuardPullDetail> {
  const p = (await apiGet(`/repos/${owner}/${repo}/pulls/${number}`)) as PullApiItem;
  const commitsData = (await apiGet(`/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`)) as CommitApiItem[];
  const comments = await fetchComments(owner, repo, number);
  return {
    title: String(p.title ?? ""),
    body: String(p.body ?? ""),
    author: String(p.user?.login ?? ""),
    headRef: String(p.head?.ref ?? ""),
    createdAt: String(p.created_at ?? ""),
    labels: (p.labels ?? []).map((l) => String(l.name ?? "")),
    changedFiles: await paginateFiles(owner, repo, number),
    commits: (commitsData ?? []).map((c) => ({
      sha: String(c.sha ?? ""),
      message: String(c.commit?.message ?? ""),
    })),
    comments,
  };
}

async function defaultFetchIssue(owner: string, repo: string, number: number): Promise<GuardIssueDetail> {
  const issue = (await apiGet(`/repos/${owner}/${repo}/issues/${number}`)) as IssueApiItem;
  const comments = await fetchComments(owner, repo, number);
  return {
    number,
    title: String(issue.title ?? ""),
    author: String(issue.user?.login ?? ""),
    state: String(issue.state ?? ""),
    comments,
  };
}

async function defaultFetchConventions(owner: string, repo: string, issueNumber: number): Promise<GuardRepoConventions> {
  const conventions: GuardRepoConventions = { dcoRequired: false, claRequired: false };
  try {
    let rootNames: string[] = [];
    try {
      const root = (await apiGet(`/repos/${owner}/${repo}/contents/`)) as RootApiItem[];
      rootNames = (root ?? []).map((r) => String(r.name ?? ""));
    } catch {
      rootNames = [];
    }
    let policyText = "";
    try {
      const contributing = (await apiGet(
        `/repos/${owner}/${repo}/contents/CONTRIBUTING.md`
      )) as { content?: unknown; encoding?: unknown };
      if (typeof contributing.content === "string" && contributing.encoding === "base64") {
        policyText = Buffer.from(contributing.content, "base64").toString("utf8");
      }
    } catch {
      policyText = "";
    }
    // The example filename should read like ".changeset/4668-fix-time-format.md",
    // never ".changeset/4668-pr-4668.md": slugify the linked issue's title
    // the same way prep does (detectChangesetConvention expects a real title
    // slug, which prep builds via titleSlug(snapshot.title)). When the title
    // is unavailable, titleSlug("") degrades to a plain "work" instead of
    // doubling the issue number.
    let slug = "work";
    try {
      const issue = (await apiGet(`/repos/${owner}/${repo}/issues/${issueNumber}`)) as IssueApiItem;
      slug = titleSlug(String(issue.title ?? ""));
    } catch {
      // keep the plain fallback
    }
    const convention = detectChangesetConvention({
      rootNames,
      policyText,
      policySource: "CONTRIBUTING.md",
      issueNumber,
      slug,
    });
    if (convention && (convention.style === "changes-dir" || convention.style === "changesets")) {
      conventions.changesetDir = convention.style === "changes-dir" ? ".changes" : ".changeset";
      conventions.changesetExample = convention.example;
    }
    const gates = parseGates(policyText, { collaboratorsOnlyPolicy: false });
    conventions.dcoRequired = gates.some((g) => g.kind === "dco_required" && g.detected);
    const cla = detectClaPath([{ file: "CONTRIBUTING.md", text: policyText }], gates);
    conventions.claRequired = cla.kind === "cla-assistant" || cla.kind === "custom-cla-bot";
  } catch {
    // Conventions are best-effort; empty means no artifact checks fire.
  }
  return conventions;
}

async function defaultFetchPriorMerged(owner: string, repo: string, author: string): Promise<number | null> {
  try {
    const q = encodeURIComponent(`repo:${owner}/${repo} author:${author} type:pr is:merged`);
    const data = (await apiGet(`/search/issues?q=${q}&per_page=1`)) as SearchApiItem;
    const total = typeof data.total_count === "number" ? data.total_count : null;
    return total;
  } catch {
    return null;
  }
}

/**
 * Full guard for a PR URL. Best-effort throughout: anything that cannot
 * be read degrades to "no evidence" and its check is skipped.
 */
export async function guardPr(prUrl: string, deps: GuardDeps = {}, config: GuardConfig = defaultGuardConfig()): Promise<GuardResult> {
  const { owner, repo, number } = parsePullUrl(prUrl);
  const fetchPull = deps.fetchPull ?? defaultFetchPull;
  const fetchIssue = deps.fetchIssue ?? defaultFetchIssue;
  const fetchConventions = deps.fetchConventions ?? defaultFetchConventions;
  const fetchPriorMerged = deps.fetchPriorMerged ?? defaultFetchPriorMerged;
  const fetchIssueLinkedPRs = deps.fetchLinkedPRs ?? fetchLinkedPRs;
  const fetchAuthor = deps.fetchPRAuthor ?? (async (owner: string, repo: string, n: number) => {
    const detail = (await apiGet(`/repos/${owner}/${repo}/pulls/${n}`)) as PullApiItem;
    return String(detail.user?.login ?? "unknown");
  });

  const pull = await fetchPull(owner, repo, number);
  const issueNumbers = extractLinkedIssueNumbers(pull.title, pull.body, pull.headRef);
  // Cross-repo issue links ("Fixes acme/widgets#123"): the issue, its
  // comments, and its timeline all live in the referenced repo, so every
  // check below runs against that repo, not the PR's own.
  const crossRepoIssues = extractCrossRepoIssues(pull.title, pull.body, owner, repo);

  interface LinkedIssueRef {
    iOwner: string;
    iRepo: string;
    number: number;
    /** "123" for same-repo, "owner/repo#123" for cross-repo. Used in all evidence text. */
    label: string;
  }
  const linkedRefs: LinkedIssueRef[] = [
    ...issueNumbers.map((n) => ({ iOwner: owner, iRepo: repo, number: n, label: `#${n}` })),
    ...crossRepoIssues.map((r) => ({ iOwner: r.owner, iRepo: r.repo, number: r.number, label: `${r.owner}/${r.repo}#${r.number}` })),
  ];

  const linkedIssues: GuardLinkedIssue[] = [];
  const competingPRs: GuardCompetingPR[] = [];
  const claims: GuardClaim[] = [];
  const findings: GuardFinding[] = [];

  const authorsByNumber = new Map<number, string>();

  if (config["competing-fix"] || config["other-claim"]) {
    for (const ref of linkedRefs) {
      const { iOwner, iRepo, number: issueNumber, label } = ref;
      const issueRef = label === `#${issueNumber}` ? undefined : label;
      let issue: GuardIssueDetail | null = null;
      try {
        issue = await fetchIssue(iOwner, iRepo, issueNumber);
      } catch {
        issue = null;
      }
      if (issue) {
        linkedIssues.push({
          number: issueNumber,
          title: issue.title,
          url: `https://github.com/${iOwner}/${iRepo}/issues/${issueNumber}`,
          state: issue.state,
        });
      }
      if (config["competing-fix"]) {
        let linked: LinkedPR[] = [];
        try {
          linked = await fetchIssueLinkedPRs(iOwner, iRepo, issueNumber);
        } catch {
          linked = [];
        }
        for (const pr of linked) {
          if (!authorsByNumber.has(pr.number)) {
            try {
              authorsByNumber.set(pr.number, await fetchAuthor(iOwner, iRepo, pr.number));
            } catch {
              authorsByNumber.set(pr.number, "unknown");
            }
          }
        }
        for (const c of findCompetingPRs(issueNumber, linked, number, authorsByNumber)) {
          competingPRs.push({ ...c, issueRef });
          findings.push({
            check: "competing-fix",
            subject: "issue",
            issueRef: `${ref.iOwner}/${ref.iRepo}#${ref.number}`,
            severity: "flag",
            title: `Competing fix for ${label}`,
            evidence: [
              `another open PR already claims this issue: #${c.number} by @${c.author} ("${c.title}")`,
              c.via === "timeline"
                ? `found in the issue's timeline (a fix announcement, even though its body may not say "fixes ${label}")`
                : `its body or branch claims ${label}`,
              `${c.url}`,
            ],
          });
        }
      }
      if (config["other-claim"] && issue) {
        const { foreign, authorClaimed } = splitIssueClaims(
          issue.author,
          issue.comments,
          pull.author,
          pull.createdAt,
          issueNumber
        );
        for (const c of foreign) {
          claims.push({ ...c, issueRef });
          const evidence: string[] = [
            `@${c.author} posted a ${c.strength} claim on ${label} on ${c.createdAt.slice(0, 10)} (${c.ageDays} day${c.ageDays === 1 ? "" : "s"} before this PR's code existed in its current form), pattern: ${c.phrase}`,
          ];
          // A claim that was already old when the PR opened still counts as
          // a flag (it is evidence of interest), but a 90+ day gap usually
          // means the claimant walked away. The flag stays; the annotation
          // helps the maintainer weigh it. (firecrawl#839: two claims were
          // 374 and 309 days old at PR creation.)
          const ageAtPr = daysBetween(new Date(c.createdAt), new Date(pull.createdAt));
          if (ageAtPr > 90) {
            evidence.push(
              `this claim is ${ageAtPr} days old at this PR's creation and may have been abandoned; weigh it accordingly`
            );
          }
          findings.push({
            check: "other-claim",
            subject: "issue",
            issueRef: `${ref.iOwner}/${ref.iRepo}#${ref.number}`,
            severity: "flag",
            title: `Issue claimed by @${c.author} before this PR`,
            evidence,
          });
        }
        if (authorClaimed) {
          claims.push({ ...authorClaimed, issueRef });
          findings.push({
            check: "author-claim",
            subject: "issue",
            issueRef: `${ref.iOwner}/${ref.iRepo}#${ref.number}`,
            severity: "note",
            title: `Claimed by the PR author`,
            evidence: [`@${pull.author} claimed ${label} in the issue comments before opening this PR — expected, no conflict`],
          });
        }
      }
    }
  }

  if (config["protocol-claim"]) {
    // The Claim Protocol is the machine-readable claim layer: an active
    // or linked protocol claim is a lease with an expiry and a public
    // queue, which is stronger evidence than a comment-phrase heuristic.
    // A claim held by someone other than the PR author is the
    // highest-confidence flag this guard can raise; a claim held by the
    // author is a pass note; completed claims are neither (the work is
    // done). Best effort: an unreadable issue means no protocol finding
    // for it.
    const fetchProtocol = deps.fetchProtocol ?? fetchProtocolState;
    for (const ref of linkedRefs) {
      let proto: ProtocolFetchResult | null = null;
      try {
        proto = await fetchProtocol(ref.iOwner, ref.iRepo, ref.number);
      } catch {
        proto = null;
      }
      const active = proto?.computation.active ?? null;
      if (!active || active.state === "completed") continue;
      const expiry = active.expiresAt.slice(0, 10);
      const claimed = active.claimedAt.slice(0, 10);
      if (active.claimant === pull.author) {
        findings.push({
          check: "protocol-claim",
          subject: "issue",
          issueRef: `${ref.iOwner}/${ref.iRepo}#${ref.number}`,
          severity: "note",
          title: "Protocol claim held by the PR author",
          evidence: [
            `@${pull.author} holds an active protocol claim on ${ref.label} (claimed ${claimed}, expires ${expiry}) — expected, no conflict`,
          ],
        });
      } else {
        const queue = (proto?.computation.queue ?? []).map((q) => `@${q.claimant}`).join(", ");
        findings.push({
          check: "protocol-claim",
          subject: "issue",
          issueRef: `${ref.iOwner}/${ref.iRepo}#${ref.number}`,
          severity: "flag",
          title: `Active protocol claim on ${ref.label} held by @${active.claimant}`,
          evidence: [
            `@${active.claimant} holds an active protocol claim (${active.state}) on ${ref.label}, claimed ${claimed}, expires ${expiry}`,
            `the queue is public${queue ? ` (${queue} waiting)` : ""} — join it instead of duplicating${active.commentUrl ? `: ${active.commentUrl}` : ""}`,
          ],
        });
      }
    }
  }

  if (config["missing-artifact"]) {
    let conventions: GuardRepoConventions;
    try {
      conventions = await fetchConventions(owner, repo, issueNumbers[0] ?? number);
    } catch {
      conventions = { dcoRequired: false, claRequired: false };
    }
    for (const f of checkMissingArtifacts({
      conventions,
      changedFiles: pull.changedFiles,
      commits: pull.commits,
      prLabels: pull.labels,
      prAuthor: pull.author,
      prComments: pull.comments,
    })) {
      findings.push(f);
    }
  }

  if (config["first-time"]) {
    let prior: number | null = null;
    try {
      prior = await fetchPriorMerged(owner, repo, pull.author);
    } catch {
      prior = null;
    }
    const f = checkFirstTime(pull.author, prior);
    if (f) findings.push(f);
  }

  const { summary, hasFindings } = buildGuardSummary(findings);
  // Autopilot: computed, never applied, here. Labels come from the
  // maintainer's label map over severity-"flag" findings; nudge lines are
  // ready-to-copy text the maintainer posts on the issue themselves.
  const autopilot = config.autopilot ?? null;
  const labelDecisions = decideAutopilotLabels(findings, autopilot);
  const staleClaimNudges = autopilot?.nudge ? buildStaleClaimNudges(claims, competingPRs, number) : [];
  const result: GuardResult = {
    pr: prUrl,
    number,
    repo: `${owner}/${repo}`,
    title: pull.title,
    author: pull.author,
    linkedIssues,
    competingPRs,
    claims,
    findings,
    summary,
    hasFindings,
    autopilotLabels: labelDecisions.map((d) => d.label),
    autopilotLabelDecisions: labelDecisions,
    staleClaimNudges,
    markdown: "",
  };
  result.markdown = renderGuardMarkdown(result);
  return result;
}

/**
 * The `--labels-dry-run` rendering: what autopilot WOULD do, in plain
 * text, without touching anything. Never posts, never labels.
 */
export function renderLabelsDryRun(result: GuardResult): string {
  const lines: string[] = [`Autopilot label dry run for ${result.repo}#${result.number}`];
  const decisions = result.autopilotLabelDecisions;
  if (decisions.length === 0) {
    lines.push("No autopilot labels: the maintainer has not enabled autopilot, or no mapped flag fired.");
  } else {
    lines.push(
      `Would apply ${decisions.length} label${decisions.length === 1 ? "" : "s"}: ${decisions.map((d) => d.label).join(", ")}`
    );
    for (const d of decisions) {
      lines.push(`  "${d.check}" (${d.title}) -> "${d.label}"`);
    }
  }
  if (result.staleClaimNudges.length > 0) {
    lines.push("Stale-claim nudge lines (for the maintainer to post on the issue):");
    for (const n of result.staleClaimNudges) lines.push(`  > ${n}`);
  }
  return lines.join("\n");
}
