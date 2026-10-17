/**
 * Contribution automation for Greenlight v0.2.0.
 *
 * This automates the pipeline the author ran by hand for four real PRs
 * (shadcn-labs/pdfcn #92 through #95): verdict first, then a claim
 * comment, a fork branch, and finally opening the PR, with DCO awareness
 * throughout. Safety is a feature: every write command defaults to a
 * dry run that prints exactly what would happen. Nothing is posted or
 * created without --yes (CLI) or execute: true (MCP), and write commands
 * refuse to run at all without a token.
 *
 * Pure logic (branch slugs, comment text, PREP.md rendering) is separated
 * from IO through the injectable GitHubClient interface, so tests run
 * fully offline with a fake client. The live client is createRestClient.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scoreIssue } from "./verdict.js";
import { parseGates, gateLabel } from "./gates.js";
import { githubToken, apiGet, apiPost, ApiNotFoundError } from "./github.js";
import {
  gatherPrepDetail,
  type PrepDetail,
} from "./prep-detail.js";
import type { IssueSnapshot, VerdictResult, Gate, RepoConventions } from "./types.js";

/** Thrown when an automation command refuses to proceed. CLI exits 1 on this. */
export class AutomationRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationRefusal";
  }
}

/**
 * The write-capable GitHub surface automation needs. Implementations log
 * nothing on their own; callers record what they did from the results.
 */
export interface GitHubClient {
  getRepo(owner: string, repo: string): Promise<{ defaultBranch: string }>;
  getViewer(): Promise<string>;
  forkExists(viewer: string, repo: string): Promise<boolean>;
  createFork(owner: string, repo: string): Promise<void>;
  getBranchSha(viewer: string, repo: string, branch: string): Promise<string | undefined>;
  createBranch(viewer: string, repo: string, branch: string, sha: string): Promise<void>;
  compareCommits(
    owner: string,
    repo: string,
    base: string,
    headOwner: string,
    headBranch: string
  ): Promise<{ aheadBy: number; commits: Array<{ sha: string; message: string }> }>;
  /** Head branch names of recent closed PRs, used to learn the repo's branch convention. */
  listClosedPullHeadRefs(owner: string, repo: string): Promise<string[]>;
  /** Names of files and directories at the repo root (best-effort conventions detection). */
  repoRootNames(owner: string, repo: string): Promise<string[]>;
  /** Raw text of a repo-root file, or undefined when absent. */
  fetchRootFile(owner: string, repo: string, path: string): Promise<string | undefined>;
  /** First lines of the most recent commit messages on a branch. */
  listRecentCommitMessages(owner: string, repo: string, branch: string, count: number): Promise<string[]>;
  postIssueComment(owner: string, repo: string, number: number, body: string): Promise<string>;
  createPullRequest(
    owner: string,
    repo: string,
    opts: { title: string; body: string; head: string; base: string }
  ): Promise<string>;
}

/** Live REST implementation of GitHubClient. */
export function createRestClient(): GitHubClient {
  return {
    async getRepo(owner: string, repo: string) {
      const r = (await apiGet(`/repos/${owner}/${repo}`)) as { default_branch?: unknown };
      return { defaultBranch: String(r.default_branch ?? "main") };
    },
    async getViewer() {
      const r = (await apiGet("/user")) as { login?: unknown };
      const login = String(r.login ?? "");
      if (!login) throw new Error("could not determine the GitHub user from /user");
      return login;
    },
    async forkExists(viewer: string, repo: string) {
      try {
        const r = (await apiGet(`/repos/${viewer}/${repo}`)) as { fork?: unknown };
        return r.fork === true;
      } catch (err) {
        if (err instanceof ApiNotFoundError) return false;
        throw err;
      }
    },
    async createFork(owner: string, repo: string) {
      await apiPost(`/repos/${owner}/${repo}/forks`, {});
    },
    async getBranchSha(viewer: string, repo: string, branch: string) {
      try {
        const r = (await apiGet(`/repos/${viewer}/${repo}/git/ref/heads/${branch}`)) as {
          object?: { sha?: unknown };
        };
        return String(r.object?.sha ?? "");
      } catch (err) {
        if (err instanceof ApiNotFoundError) return undefined;
        throw err;
      }
    },
    async createBranch(viewer: string, repo: string, branch: string, sha: string) {
      await apiPost(`/repos/${viewer}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    },
    async compareCommits(owner: string, repo: string, base: string, headOwner: string, headBranch: string) {
      const head = headOwner === owner ? headBranch : `${headOwner}:${headBranch}`;
      const r = (await apiGet(`/repos/${owner}/${repo}/compare/${base}...${head}`)) as {
        ahead_by?: unknown;
        commits?: Array<{ sha?: unknown; commit?: { message?: unknown } }>;
      };
      return {
        aheadBy: Number(r.ahead_by ?? 0),
        commits: (r.commits ?? []).map((c) => ({
          sha: String(c.sha ?? ""),
          message: String(c.commit?.message ?? ""),
        })),
      };
    },
    async listClosedPullHeadRefs(owner: string, repo: string) {
      const r = (await apiGet(`/repos/${owner}/${repo}/pulls?state=closed&per_page=30`)) as Array<{
        head?: { ref?: unknown };
      }>;
      return (r ?? []).map((p) => String(p.head?.ref ?? "")).filter((ref) => ref.length > 0);
    },
    async repoRootNames(owner: string, repo: string) {
      const r = (await apiGet(`/repos/${owner}/${repo}/contents/`)) as Array<{
        name?: unknown;
      }>;
      return (r ?? []).map((e) => String(e.name ?? "")).filter((n) => n.length > 0);
    },
    async fetchRootFile(owner: string, repo: string, path: string) {
      try {
        const r = (await apiGet(`/repos/${owner}/${repo}/contents/${path}`)) as {
          content?: unknown;
          encoding?: unknown;
        };
        if (typeof r.content !== "string") return undefined;
        return Buffer.from(r.content, r.encoding === "base64" ? "base64" : "utf8").toString("utf8");
      } catch (err) {
        if (err instanceof ApiNotFoundError) return undefined;
        throw err;
      }
    },
    async listRecentCommitMessages(owner: string, repo: string, branch: string, count: number) {
      const r = (await apiGet(
        `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${count}`
      )) as Array<{ commit?: { message?: unknown } }>;
      return (r ?? []).map((c) => String(c.commit?.message ?? "").split("\n")[0] ?? "");
    },
    async postIssueComment(owner: string, repo: string, number: number, body: string) {
      const r = (await apiPost(`/repos/${owner}/${repo}/issues/${number}/comments`, { body })) as {
        html_url?: unknown;
      };
      return String(r.html_url ?? "");
    },
    async createPullRequest(
      owner: string,
      repo: string,
      opts: { title: string; body: string; head: string; base: string }
    ) {
      const r = (await apiPost(`/repos/${owner}/${repo}/pulls`, opts)) as { html_url?: unknown };
      return String(r.html_url ?? "");
    },
  };
}

/** Write commands need a token. Dry runs do not. */
export function requireWriteToken(): void {
  if (!githubToken()) {
    throw new Error(
      "Write operations require a token: set GITHUB_TOKEN (or GH_TOKEN) to a GitHub personal access token, then re-run with --yes."
    );
  }
}

function gateDetected(gates: Gate[], kind: Gate["kind"]): boolean {
  return gates.some((g) => g.kind === kind && g.detected);
}

/** Slugify an issue title: strip leading labels, lowercase, dashes, 40-char cap. */
export function titleSlug(title: string): string {
  return (
    title
      .replace(/^(?:block|feature|feat|fix|component|docs?|chore|refactor|test|bug):\s*/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "work"
  );
}

/**
 * Branch name from an issue title: strip leading labels like "block:" or
 * "feat:", slugify, cap at 40 chars, append the issue number.
 *   "block: Resume" -> "feat/resume-61"
 */
export function branchSlugFor(title: string, number: number): string {
  return `feat/${titleSlug(title)}-${number}`;
}

/** A branch-name convention learned from a repo's recent closed PRs. */
export interface BranchPattern {
  /** Dominant prefix before the "/", e.g. "feat". */
  prefix: string;
  /** Dominant trailing token of the branch rest, e.g. "block", or null. */
  suffix: string | null;
}

const PATTERN_THRESHOLD = 3;

/**
 * Learn a dominant branch naming pattern from recent closed PR head refs.
 * Returns undefined when no prefix or suffix reaches the 3-branch
 * threshold, so naming falls back to the default.
 */
export function detectBranchPattern(refs: string[]): BranchPattern | undefined {
  if (refs.length === 0) return undefined;
  const split = refs.map((r) => {
    const i = r.indexOf("/");
    return i < 0 ? { prefix: "", rest: r } : { prefix: r.slice(0, i), rest: r.slice(i + 1) };
  });
  const prefixCounts = new Map<string, number>();
  for (const s of split) {
    if (s.prefix.length > 0) prefixCounts.set(s.prefix, (prefixCounts.get(s.prefix) ?? 0) + 1);
  }
  const dominantPrefix = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const suffixCounts = new Map<string, number>();
  for (const s of split) {
    const tokens = s.rest.split("-");
    const last = tokens.length >= 2 ? tokens[tokens.length - 1] : "";
    if (/^[a-z]{2,}$/.test(last)) suffixCounts.set(last, (suffixCounts.get(last) ?? 0) + 1);
  }
  const dominantSuffix = [...suffixCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const prefix = dominantPrefix && dominantPrefix[1] >= PATTERN_THRESHOLD ? dominantPrefix[0] : undefined;
  const suffix = dominantSuffix && dominantSuffix[1] >= PATTERN_THRESHOLD ? dominantSuffix[0] : undefined;
  if (!prefix && !suffix) return undefined;
  return { prefix: prefix ?? "feat", suffix: suffix ?? null };
}

export interface BranchSuggestion {
  /** The branch name to use. */
  branch: string;
  /** The default name, for comparison when a pattern was found. */
  defaultName: string;
  /** Human-readable note about the learned pattern, empty when none. */
  note: string;
}

/**
 * Suggest a branch name, learning the repo's convention from recent closed
 * PR head refs. A dominant suffix token (e.g. "-block" from
 * feat/business-letter-block) replaces the issue number; a dominant
 * prefix style replaces "feat/". Falls back to feat/<slug>-<number>.
 */
export function suggestBranchName(title: string, number: number, refs: string[]): BranchSuggestion {
  const defaultName = branchSlugFor(title, number);
  const pattern = detectBranchPattern(refs);
  if (!pattern) return { branch: defaultName, defaultName, note: "" };
  const slug = titleSlug(title);
  let rest: string;
  if (pattern.suffix) {
    const tokens = slug.split("-");
    rest = tokens[tokens.length - 1] === pattern.suffix ? slug : `${slug}-${pattern.suffix}`;
  } else {
    rest = `${slug}-${number}`;
  }
  const branch = `${pattern.prefix}/${rest}`;
  if (branch === defaultName) return { branch: defaultName, defaultName, note: "" };
  const note = `repo convention from recent PRs: ${pattern.prefix}/<slug>${pattern.suffix ? `-${pattern.suffix}` : ""}`;
  return { branch, defaultName, note };
}

/**
 * Claim comment text shaped by the repo's gates. Assignment-gated repos get
 * an assignment request and a promise not to start work early; every comment
 * notes the comment-first convention; DCO repos get a sign-off commitment.
 *
 * Every comment also carries the Claim Protocol marker (protocol/SPEC.md
 * section 3.1): the marker line, optional structured plan and eta lines,
 * then the protocol footer. The marker turns the comment into a
 * machine-readable lease that the Ledger can index and the guard can
 * arbitrate; the human text above it is unchanged.
 */
export function buildClaimComment(
  snapshot: IssueSnapshot,
  gates: Gate[],
  viewer?: string,
  extras?: { plan?: string; etaDays?: number }
): string {
  const who = viewer ? `Hi, I'm ${viewer}. ` : "Hi. ";
  const assignment = gateDetected(gates, "assignment_required");
  const dco = gateDetected(gates, "dco_required");
  const human = assignment
    ? `${who}I'd like to work on this: ${snapshot.title}.\n\n` +
      `I see this repo asks contributors to be assigned before submitting a PR. ` +
      `Could you assign this issue to me? I won't start work until it's assigned.\n\n` +
      `I'm commenting first per the repo's contribution guidelines, and I'll follow ` +
      `the rest of the process before opening a PR.`
    : (() => {
        const dcoLine = dco
          ? " I'll sign off every commit with `git commit -s` (DCO) and open a PR against the issue."
          : " I'll open a PR against the issue once the work is ready.";
        return (
          `${who}I'd like to take this on: ${snapshot.title}.\n\n` +
          `I'm commenting first per the repo's contribution guidelines, and I'll follow ` +
          `the contribution process.${dcoLine}`
        );
      })();
  const lines = [human, "", "<!-- greenlight-claim v1 -->"];
  if (extras?.plan) lines.push(`plan: ${extras.plan}`);
  if (extras?.etaDays != null) lines.push(`eta-days: ${extras.etaDays}`);
  lines.push(
    "Claimed under the Greenlight Claim Protocol: this claim renews or expires"
  );
  lines.push("automatically, and releases the moment a PR is linked or I say so.");
  return lines.join("\n");
}

/** Required actions checklist rendered from detected gates. */
export function gateActions(gates: Gate[]): string[] {
  const actions: string[] = [];
  for (const g of gates) {
    if (!g.detected) continue;
    switch (g.kind) {
      case "dco_required":
        actions.push("Sign every commit with `git commit -s` (DCO sign-off required).");
        break;
      case "assignment_required":
        actions.push("Get assigned on the issue before opening a PR; `greenlight claim` asks for assignment.");
        break;
      case "claim_first":
        actions.push("Post a claim comment on the issue before starting work; `greenlight claim` posts one that satisfies the comment-first ritual.");
        break;
      case "vouch_required":
        actions.push("A maintainer must vouch for you first; this cannot be automated.");
        break;
      case "cla_required":
        actions.push("Sign the Contributor License Agreement before opening a PR.");
        break;
      case "discussion_first":
        actions.push("Start a discussion on the issue before writing code.");
        break;
      case "collaborators_only":
        actions.push("Only collaborators can open PRs in this repo.");
        break;
      case "agents_banned":
        actions.push("This repo bans agent contributions (see the quoted policy): only a human who fully understands the change may submit it. An agent must not open the PR, draft its text, or post it.");
        break;
      case "agents_disclosure":
        actions.push("Disclose AI assistance in the PR description and prefix the PR title and commits with [AI] as the repo's policy requires.");
        break;
    }
  }
  return actions;
}

export interface ClaimOptions {
  yes: boolean;
  force: boolean;
  /** Optional plan recorded in the protocol claim comment (plan: line). */
  plan?: string;
  /** Optional ETA in days recorded in the protocol claim comment (eta-days: line). */
  etaDays?: number;
}

export interface ClaimResult {
  verdict: VerdictResult;
  commentBody: string;
  commentUrl: string | null;
  executed: boolean;
  viewer: string | undefined;
}

/**
 * claim: verdict first, then post a claim comment shaped by the repo gates.
 * Refuses on TAKEN or STALE verdicts unless forced, and refuses outright
 * on vouch-gated repos (a vouch cannot be automated). Dry run by default.
 */
export async function claimIssue(
  client: GitHubClient,
  snapshot: IssueSnapshot,
  opts: ClaimOptions
): Promise<ClaimResult> {
  const result = scoreIssue(snapshot);
  const ref = `${snapshot.owner}/${snapshot.repo}#${snapshot.number}`;
  if ((result.verdict === "TAKEN" || result.verdict === "STALE") && !opts.force) {
    throw new AutomationRefusal(
      `refusing to claim ${ref}: verdict is ${result.verdict} (${result.reasons[0] ?? "no reason"}). Pass --force to claim anyway.`
    );
  }
  // Agent-ban (nuxt/nuxt AGENTS.md case): the repo only accepts human
  // submissions. Refuse like TAKEN unless forced; a --force claim here
  // still needs a human to open and write the PR.
  const banned = result.gates.find((g) => g.kind === "agents_banned" && g.detected);
  if (banned && !opts.force) {
    throw new AutomationRefusal(
      `refusing to claim ${ref}: this repo bans agent contributions (${banned.source ?? "AGENTS.md"}: "${banned.evidence}"). Only a human may submit. Pass --force to claim anyway.`
    );
  }
  const gates = parseGates(snapshot.contributing);
  if (gateDetected(gates, "vouch_required")) {
    throw new AutomationRefusal(
      `refusing to claim ${ref}: this repo requires a maintainer vouch before outside PRs, and a vouch cannot be automated. Request a vouch manually first.`
    );
  }
  let viewer: string | undefined;
  try {
    viewer = await client.getViewer();
  } catch {
    /* tokenless dry run: no name available */
  }
  const commentBody = buildClaimComment(snapshot, gates, viewer, {
    plan: opts.plan,
    etaDays: opts.etaDays,
  });
  if (!opts.yes) {
    return { verdict: result, commentBody, commentUrl: null, executed: false, viewer };
  }
  requireWriteToken();
  const commentUrl = await client.postIssueComment(snapshot.owner, snapshot.repo, snapshot.number, commentBody);
  return { verdict: result, commentBody, commentUrl, executed: true, viewer };
}

function verdictLine(result: VerdictResult): string {
  return `[${result.verdict}] ${result.reasons[0] ?? "no reason"}`;
}

/** Pure renderer for the PREP.md checklist file. */
export function renderPrepDoc(args: {
  snapshot: IssueSnapshot;
  verdict: VerdictResult;
  gates: Gate[];
  branch: string;
  branchDefault?: string;
  branchNote?: string;
  viewer: string;
  issueUrl: string;
  conventions?: RepoConventions;
  prepDetail?: PrepDetail;
}): string {
  const { snapshot, verdict, gates, branch, branchDefault, branchNote, viewer, issueUrl, conventions, prepDetail } = args;
  const actions = gateActions(gates);
  const lines: string[] = [
    `# Greenlight prep: ${snapshot.owner}/${snapshot.repo}#${snapshot.number}`,
    ``,
    `## Verdict`,
    ``,
    verdictLine(verdict),
    ...verdict.reasons.slice(1).map((r) => `- ${r}`),
    ``,
  ];

  // Prominent, before everything else: the fix may not be buildable here.
  if (prepDetail && prepDetail.fixLivesHereWarnings.length > 0) {
    lines.push(`## Fix-lives-here warnings`, ``);
    for (const w of prepDetail.fixLivesHereWarnings) lines.push(`- ${w.line}`);
    lines.push(``);
  }

  if (prepDetail && prepDetail.houseRulesSummary.length > 0) {
    lines.push(`## House rules`, ``);
    for (const h of prepDetail.houseRulesSummary) lines.push(`- ${h}`);
    lines.push(``);
  }

  if (prepDetail) {
    const c = prepDetail.claPath;
    lines.push(`## Signing`, ``);
    const label = c.kind === "cla-assistant" ? "CLA (CLA Assistant)"
      : c.kind === "custom-cla-bot" ? "CLA (repo-specific bot)"
      : c.kind === "dco" ? "DCO sign-off" : "No signing requirement";
    lines.push(`- ${label}: ${c.method}`);
    if (c.link) lines.push(`- Signing page: ${c.link}`);
    if (c.signaturePhrase) lines.push(`- Signature phrase: "${c.signaturePhrase}"`);
    for (const n of c.notes) lines.push(`- Note: ${n}`);
    if (c.sources.length > 0) lines.push(`- Source: ${c.sources.join(", ")}`);
    lines.push(``);
  }

  lines.push(`## Gates`, ``);
  if (actions.length === 0) {
    lines.push("No blocking gates detected.");
  } else {
    lines.push(...actions.map((a) => `- ${a}`));
  }
  lines.push(``, `## Repo conventions`, ``);
  if (conventions) {
    if (conventions.houseRuleFiles.length > 0) {
      lines.push(`- House rules: ${conventions.houseRuleFiles.join(", ")}`);
    }
    if (conventions.verifyCommands.length > 0) {
      lines.push(
        `- Verify command from house rules: ${conventions.verifyCommands.map((c) => `\`${c}\``).join(", ")}`
      );
    }
    if (conventions.changesDir) {
      lines.push(
        `- Add a ${conventions.changesDirName ?? ".changes"} entry (this repo assembles its changelog from ${conventions.changesDirName ?? ".changes"}/)`
      );
    }
    if (conventions.packageScripts.length > 0) {
      lines.push(
        `- Run before pushing: ${conventions.packageScripts.map((s) => `\`pnpm ${s}\``).join(", ")}`
      );
    }
    if (conventions.conventionalCommits) {
      lines.push(
        `- Commits follow Conventional Commits${conventions.exampleCommit ? `, e.g. "${conventions.exampleCommit}"` : ""}`
      );
    }
  } else {
    lines.push("No repo conventions detected (no house-rules files, package.json, or commit history found).");
  }
  if (prepDetail?.changeset) {
    const c = prepDetail.changeset;
    lines.push(
      ``,
      `- Release-note artifact: add \`${c.example}\` (${c.pattern}); ${c.note} (source: ${c.source})`
    );
  }
  lines.push(``, `## Issue`, ``, snapshot.title, ``);
  if (snapshot.body) lines.push(snapshot.body.trim().slice(0, 2000), ``);
  if (branchNote) {
    lines.push(
      `## Branch`,
      ``,
      `${branch} (${branchNote}; the default name would be ${branchDefault})`,
      ``
    );
  }
  lines.push(
    `## Next commands`,
    ``,
    `1. Claim the issue (posts the comment above):`,
    `   greenlight claim ${issueUrl} --yes`,
    `2. Clone your fork and check out the branch:`,
    `   git clone git@github.com:${viewer}/${snapshot.repo}.git && cd ${snapshot.repo} && git checkout ${branch}`,
    `3. Do the work, commit with DCO sign-off where required, then open the PR:`,
    `   greenlight pr ${issueUrl} --branch ${branch} --yes`,
    ``
  );
  return lines.join("\n");
}

export interface PrepOptions {
  dir?: string;
  yes: boolean;
}

export interface PrepResult {
  verdict: VerdictResult;
  branch: string;
  branchDefault: string;
  branchPatternNote: string;
  forkReady: boolean;
  forkCreated: boolean;
  branchReady: boolean;
  branchCreated: boolean;
  prepFile: string;
  nextCommands: string[];
  /** Repo rituals learned during prep (best-effort; undefined when nothing was detectable). */
  conventions?: RepoConventions;
  /** v0.3.7 prep hardening: CLA path, changeset ritual, fix-lives-here warnings, house rules. */
  prepDetail?: PrepDetail;
}

/** Script names worth surfacing when found in the root package.json. */
const INTERESTING_SCRIPTS = ["test", "verify", "lint", "typecheck", "build"];

/** Conventional Commits subject prefix: feat(scope): ..., fix: ..., etc. */
const CONVENTIONAL_COMMIT_RES = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?!?: /;

/**
 * Extract backticked run commands quoted in house-rules text, e.g. the
 * `pnpm verify` reticle's AGENTS.md insists on. Returns them deduplicated,
 * in order of appearance, capped at five.
 */
export function extractVerifyCommands(text: string): string[] {
  const out: string[] = [];
  const re = /`((?:pnpm|npm|yarn|bun|make)\s+[a-zA-Z0-9:._-]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < 5) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Learn the repo's contribution rituals for the PREP.md checklist:
 * which house-rules files exist, the verify/test command they quote,
 * whether the repo assembles its changelog from a .changes directory,
 * which root package.json scripts exist, and whether recent commits
 * follow Conventional Commits. Every probe is best-effort: a failing
 * probe is skipped, never fatal.
 */
export async function gatherRepoConventions(
  client: GitHubClient,
  snapshot: IssueSnapshot
): Promise<RepoConventions | undefined> {
  const { owner, repo } = snapshot;
  const houseRuleFiles = (snapshot.houseRules ?? []).map((h) => h.file);
  const verifyCommands = extractVerifyCommands(
    (snapshot.houseRules ?? []).map((h) => h.text).join("\n")
  );

  let changesDir = false;
  let changesDirName: string | undefined;
  try {
    const names = await client.repoRootNames(owner, repo);
    const found = names.find((n) => n === ".changes" || n === ".changeset");
    if (found) {
      changesDir = true;
      changesDirName = found;
    }
  } catch { /* root listing failed; skip */ }

  let packageScripts: string[] = [];
  try {
    const pkg = await client.fetchRootFile(owner, repo, "package.json");
    if (pkg) {
      const scripts = Object.keys((JSON.parse(pkg) as { scripts?: unknown }).scripts ?? {});
      packageScripts = INTERESTING_SCRIPTS.filter((s) => scripts.includes(s));
    }
  } catch { /* no package.json or unparsable; skip */ }

  let conventionalCommits = false;
  let exampleCommit: string | undefined;
  try {
    const { defaultBranch } = await client.getRepo(owner, repo);
    const messages = await client.listRecentCommitMessages(owner, repo, defaultBranch, 20);
    const subjects = messages.map((m) => m.trim()).filter((m) => m.length > 0);
    const matching = subjects.filter((m) => CONVENTIONAL_COMMIT_RES.test(m));
    if (subjects.length > 0 && matching.length / subjects.length >= 0.6) {
      conventionalCommits = true;
      exampleCommit = matching[0].length > 60 ? matching[0].slice(0, 60) + "..." : matching[0];
    }
  } catch { /* commit history unavailable; skip */ }

  if (
    houseRuleFiles.length === 0 &&
    verifyCommands.length === 0 &&
    !changesDir &&
    packageScripts.length === 0 &&
    !conventionalCommits
  ) {
    return undefined;
  }
  return {
    houseRuleFiles,
    verifyCommands,
    changesDir,
    ...(changesDirName ? { changesDirName } : {}),
    packageScripts,
    conventionalCommits,
    ...(exampleCommit ? { exampleCommit } : {}),
  };
}

/**
 * prep: verdict, fork check (create with --yes), branch naming and creation,
 * and a local PREP.md checklist. Never clones; reports the clone command.
 * Writes the PREP.md file in both dry-run and execute modes.
 */
export async function prepIssue(
  client: GitHubClient,
  snapshot: IssueSnapshot,
  opts: PrepOptions
): Promise<PrepResult> {
  const result = scoreIssue(snapshot);
  const gates = parseGates(snapshot.contributing);
  const { owner, repo, number } = snapshot;

  // Learn the repo's branch convention from recent closed PRs (best effort).
  const defaultBranchName = branchSlugFor(snapshot.title, number);
  let suggestion: BranchSuggestion = {
    branch: defaultBranchName,
    defaultName: defaultBranchName,
    note: "",
  };
  try {
    const refs = await client.listClosedPullHeadRefs(owner, repo);
    suggestion = suggestBranchName(snapshot.title, number, refs);
  } catch {
    /* branch naming falls back to the default when the PR list cannot be read */
  }
  const branch = suggestion.branch;

  const prepDir = opts.dir ?? join("greenlight-prep", `${repo}-${number}`);
  const prepFile = join(prepDir, "PREP.md");

  let viewer: string | undefined;
  try {
    viewer = await client.getViewer();
  } catch {
    /* tokenless dry run: fork/branch checks need a viewer, so we report instead */
  }

  let forkReady = false;
  let forkCreated = false;
  let branchReady = false;
  let branchCreated = false;

  if (viewer) {
    forkReady = await client.forkExists(viewer, repo);
    if (!forkReady && opts.yes) {
      requireWriteToken();
      await client.createFork(owner, repo);
      forkCreated = true;
      forkReady = true;
    }
    if (forkReady) {
      const sha = await client.getBranchSha(viewer, repo, branch);
      branchReady = sha !== undefined;
      if (!branchReady && opts.yes) {
        requireWriteToken();
        const { defaultBranch } = await client.getRepo(owner, repo);
        const baseSha = await client.getBranchSha(viewer, repo, defaultBranch);
        if (!baseSha) {
          throw new AutomationRefusal(
            `fork ${viewer}/${repo} has no ${defaultBranch} branch ref; clone the fork and push the default branch first.`
          );
        }
        await client.createBranch(viewer, repo, branch, baseSha);
        branchCreated = true;
        branchReady = true;
      }
    }
  }

  const nextCommands = [
    `greenlight claim ${snapshot.sourceUrl} --yes`,
    viewer
      ? `git clone git@github.com:${viewer}/${repo}.git && cd ${repo} && git checkout ${branch}`
      : `# set GITHUB_TOKEN, then: greenlight prep ${snapshot.sourceUrl} --yes`,
    `greenlight pr ${snapshot.sourceUrl} --branch ${branch} --yes`,
  ];

  // Learn the repo's contribution rituals (best-effort; never fatal).
  let conventions: RepoConventions | undefined;
  try {
    conventions = await gatherRepoConventions(client, snapshot);
  } catch { /* conventions are advisory; skip */ }

  // v0.3.7 prep hardening: CLA path, changeset ritual, fix-lives-here
  // warnings, house-rules summary (best-effort; never fatal).
  let prepDetail: PrepDetail | undefined;
  try {
    const policyTexts = (snapshot.houseRules ?? []).map((h) => ({ file: h.file, text: h.text }));
    prepDetail = await gatherPrepDetail({
      owner,
      repo,
      issueNumber: number,
      slug: titleSlug(snapshot.title),
      policyTexts,
      contributing: snapshot.contributing,
      issueBody: snapshot.body,
      conventions,
      deps: {
        rootNames: () => client.repoRootNames(owner, repo),
        pyprojectText: () => client.fetchRootFile(owner, repo, "pyproject.toml"),
      },
    });
  } catch { /* prep detail is advisory; skip */ }

  mkdirSync(prepDir, { recursive: true });
  writeFileSync(
    prepFile,
    renderPrepDoc({
      snapshot,
      verdict: result,
      gates,
      branch,
      branchDefault: suggestion.defaultName,
      branchNote: suggestion.note || undefined,
      viewer: viewer ?? "<you>",
      issueUrl: snapshot.sourceUrl,
      conventions,
      prepDetail,
    }),
    "utf8"
  );

  return {
    verdict: result,
    branch,
    branchDefault: suggestion.defaultName,
    branchPatternNote: suggestion.note,
    forkReady,
    forkCreated,
    branchReady,
    branchCreated,
    prepFile,
    nextCommands,
    conventions,
    prepDetail,
  };
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? "";
}

export interface PrOptions {
  branch: string;
  title?: string;
  yes: boolean;
}

export interface PrResult {
  verdict: VerdictResult;
  branch: string;
  head: string;
  base: string;
  title: string;
  body: string;
  checks: string[];
  prUrl: string | null;
  executed: boolean;
}

/**
 * pr: preconditions, DCO verification, then open the PR. Preconditions:
 * the branch must exist on the fork and be at least one commit ahead of
 * upstream's default branch. When the repo requires DCO, every ahead
 * commit must carry a Signed-off-by line; the first unsigned commit is a
 * hard refusal (this exact failure mode burned real review time). Dry run
 * prints the composed PR without posting it.
 */
export async function openPr(
  client: GitHubClient,
  snapshot: IssueSnapshot,
  opts: PrOptions
): Promise<PrResult> {
  const result = scoreIssue(snapshot);
  const gates = parseGates(snapshot.contributing);
  const { owner, repo, number } = snapshot;
  const checks: string[] = [];

  let viewer: string | undefined;
  try {
    viewer = await client.getViewer();
  } catch {
    /* tokenless dry run */
  }
  const headOwner = viewer ?? "<you>";
  const head = `${headOwner}:${opts.branch}`;

  if (!viewer) {
    return {
      verdict: result,
      branch: opts.branch,
      head,
      base: "<upstream default>",
      title: opts.title ?? snapshot.title,
      body: composePrBody(snapshot, result, gates),
      checks: ["branch not verified (no token); set GITHUB_TOKEN to verify"],
      prUrl: null,
      executed: false,
    };
  }

  const branchSha = await client.getBranchSha(viewer, repo, opts.branch);
  if (!branchSha) {
    throw new AutomationRefusal(
      `branch ${opts.branch} does not exist on ${viewer}/${repo}; run greenlight prep first.`
    );
  }
  checks.push(`branch exists on ${viewer}/${repo}: ${branchSha.slice(0, 7)}`);

  const { defaultBranch } = await client.getRepo(owner, repo);
  const cmp = await client.compareCommits(owner, repo, defaultBranch, viewer, opts.branch);
  if (cmp.aheadBy < 1) {
    throw new AutomationRefusal(
      `branch ${opts.branch} is not ahead of ${owner}/${repo}@${defaultBranch}; nothing to open a PR for.`
    );
  }
  checks.push(`branch is ${cmp.aheadBy} commit(s) ahead of ${defaultBranch}`);

  if (gateDetected(gates, "dco_required")) {
    const unsigned = cmp.commits.filter((c) => !/Signed-off-by:/i.test(c.message));
    if (unsigned.length > 0) {
      throw new AutomationRefusal(
        `DCO sign-off required, but ${unsigned.length} commit(s) lack a Signed-off-by line:\n` +
          unsigned.map((c) => `  - ${c.sha.slice(0, 7)} ${firstLine(c.message)}`).join("\n") +
          `\nAmend with git commit --amend -s or rebase with --signoff before opening the PR.`
      );
    }
    checks.push(`DCO: all ${cmp.commits.length} commit(s) carry a Signed-off-by line`);
  }

  const latestSubject = cmp.commits.length > 0 ? firstLine(cmp.commits[cmp.commits.length - 1].message) : "";
  const title = opts.title ?? (latestSubject || snapshot.title);
  const body = composePrBody(snapshot, result, gates);

  if (!opts.yes) {
    return {
      verdict: result,
      branch: opts.branch,
      head,
      base: defaultBranch,
      title,
      body,
      checks,
      prUrl: null,
      executed: false,
    };
  }
  requireWriteToken();
  const prUrl = await client.createPullRequest(owner, repo, {
    title,
    body,
    head,
    base: defaultBranch,
  });
  return {
    verdict: result,
    branch: opts.branch,
    head,
    base: defaultBranch,
    title,
    body,
    checks,
    prUrl,
    executed: true,
  };
}

/** PR body template: closes keyword, summary, and the checks at open time. */
export function composePrBody(snapshot: IssueSnapshot, result: VerdictResult, gates: Gate[]): string {
  const detected = gates.filter((g) => g.detected);
  const lines = [
    `Closes #${snapshot.number}.`,
    ``,
    `## Summary`,
    ``,
    snapshot.title,
    ``,
    `## Checks`,
    ``,
    `- Verdict at open: ${verdictLine(result)}`,
  ];
  for (const g of detected) lines.push(`- Gate: ${gateLabel(g.kind)}`);
  if (detected.length === 0) lines.push("- Gates: none detected");
  lines.push(``);
  return lines.join("\n");
}
