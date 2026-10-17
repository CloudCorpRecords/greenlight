/**
 * GitHub API client. Native fetch only, no extra dependencies.
 * Optional GITHUB_TOKEN env var raises the rate limit from 60 to 5000 req/hr.
 * GREENLIGHT_GITHUB_BASE_URL overrides the API base (for a local proxy that
 * attaches a stored token); trailing slashes are normalized away, and unset
 * behaves exactly like the historical hardcoded api.github.com.
 * Responses are cached under ~/.cache/greenlight (6h TTL for issues/repos,
 * 1h for search) so repeated checks do not burn quota.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import type { IssueSnapshot, LinkedPR, CommentSignal, GateKind, Gate, MentionedPR, DuplicateTarget } from "./types.js";
import { classifyLinkStrength, type LinkStrength } from "./linkstrength.js";
import { detectWorkflowGates, type WorkflowFile } from "./gates.js";
import { isBotAuthor } from "./claims.js";
import { detectServerSideOnly } from "./server-side.js";

const DEFAULT_API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/**
 * The GitHub API base in use. Reads GREENLIGHT_GITHUB_BASE_URL so a
 * vault-backed localhost proxy (gh-proxy.py) can attach a stored token to
 * requests from tools that only know how to read env. Trailing slashes are
 * stripped; with the env unset the return is the historical hardcoded value.
 */
export function githubApiBase(): string {
  const env = process.env.GREENLIGHT_GITHUB_BASE_URL;
  if (env && env.trim().length > 0) return env.trim().replace(/\/+$/, "");
  return DEFAULT_API;
}
const CACHE_DIR = join(homedir(), ".cache", "greenlight");

function ensureCache(): void {
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
}

const TTL_MS: Record<string, number> = {
  issue: 6 * 60 * 60 * 1000,
  search: 60 * 60 * 1000,
  contributing: 24 * 60 * 60 * 1000,
  // LLM claim classifications: comment bodies are immutable, so a long TTL
  // means repeat checks cost nothing after the first classification.
  llm: 30 * 24 * 60 * 60 * 1000,
};

function cacheKey(kind: string, parts: string[]): string {
  return `${kind}-${parts.join("-").replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`;
}

/** File-backed best-effort cache shared by the fetch layer and the optional LLM layer. */
export function cacheGet(kind: string, parts: string[]): unknown | undefined {
  ensureCache();
  const file = join(CACHE_DIR, cacheKey(kind, parts));
  if (!existsSync(file)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(file, "utf8"));
    if (Date.now() - entry.savedAt > TTL_MS[kind]) return undefined;
    return entry.data;
  } catch {
    return undefined;
  }
}

export function cacheSet(kind: string, parts: string[], data: unknown): void {
  ensureCache();
  const file = join(CACHE_DIR, cacheKey(kind, parts));
  try {
    writeFileSync(file, JSON.stringify({ savedAt: Date.now(), data }), "utf8");
  } catch { /* cache is best-effort */ }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Thrown by apiGet/apiPost for HTTP 404, so callers can treat "missing" as data. */
export class ApiNotFoundError extends Error {
  constructor(path: string) {
    super(`GitHub API 404 for ${path}`);
    this.name = "ApiNotFoundError";
  }
}

export function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}

export async function apiGet(path: string): Promise<unknown> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "greenlight-cli",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = githubToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${githubApiBase()}${path}`, { headers });
  if (res.status === 403 || res.status === 429) {
    const body = await res.text().catch(() => "");
    const reset = res.headers.get("x-ratelimit-reset");
    const wait = reset ? ` Rate limit resets at ${new Date(Number(reset) * 1000).toISOString()}.` : "";
    const hint = token
      ? "Authenticated limit also exhausted."
      : "Set GITHUB_TOKEN (a classic PAT, no scopes needed for public repos) to raise the limit from 60 to 5000 req/hr.";
    throw new RateLimitError(`GitHub rate limit hit (${res.status}).${wait} ${hint} ${body.slice(0, 120)}`);
  }
  if (res.status === 404) {
    throw new ApiNotFoundError(path);
  }
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/** POST helper for write operations (automation commands). Read paths use apiGet. */
export async function apiPost(path: string, body: unknown): Promise<unknown> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "greenlight-cli",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = githubToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${githubApiBase()}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    const wait = reset ? ` Rate limit resets at ${new Date(Number(reset) * 1000).toISOString()}.` : "";
    throw new RateLimitError(`GitHub rate limit hit (${res.status}).${wait}`);
  }
  if (res.status === 404) {
    throw new ApiNotFoundError(path);
  }
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

async function paginate<T>(path: string, perPage = 100, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = (await apiGet(`${path}${sep}per_page=${perPage}&page=${page}`)) as T[];
    out.push(...data);
    if (data.length < perPage) break;
  }
  return out;
}

export interface IssueURL {
  owner: string;
  repo: string;
  number: number;
}

export function parseIssueUrl(url: string): IssueURL {
  const m = /github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/.exec(url);
  if (!m) throw new Error(`Not a GitHub issue URL: ${url} (expected https://github.com/<owner>/<repo>/issues/<number>)`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** Strict parser for PR URLs (ci triage only accepts /pull/ URLs). */
export function parsePullUrl(url: string): IssueURL {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) throw new Error(`Not a GitHub pull request URL: ${url} (expected https://github.com/<owner>/<repo>/pull/<number>)`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** Fetch issue comments for claim detection. */
export async function fetchComments(owner: string, repo: string, number: number): Promise<CommentSignal[]> {
  const cached = cacheGet("issue", [owner, repo, String(number), "comments"]) as CommentSignal[] | undefined;
  if (cached) return cached;
  const data = await paginate<Record<string, unknown>>(`/repos/${owner}/${repo}/issues/${number}/comments`);
  const comments: CommentSignal[] = data.map((c) => ({
    author: (c.user as Record<string, string>).login,
    body: String(c.body ?? ""),
    createdAt: String(c.created_at),
    id: typeof c.id === "number" ? c.id : undefined,
  }));
  cacheSet("issue", [owner, repo, String(number), "comments"], comments);
  return comments;
}

/**
 * Fetch raw issue timeline events (cached). Shared by the linked-PR walk
 * and duplicate-of detection so the timeline is fetched once per issue.
 */
async function fetchTimelineEvents(
  owner: string,
  repo: string,
  number: number
): Promise<Record<string, unknown>[]> {
  const cached = cacheGet("issue", [owner, repo, String(number), "timeline"]) as
    | Record<string, unknown>[]
    | undefined;
  if (cached) return cached;
  let events: Record<string, unknown>[] = [];
  try {
    events = await paginate<Record<string, unknown>>(`/repos/${owner}/${repo}/issues/${number}/timeline`);
  } catch { /* timeline is best-effort */ }
  cacheSet("issue", [owner, repo, String(number), "timeline"], events);
  return events;
}

/**
 * Find PRs that reference an issue. Timeline cross-references and a text
 * search for the issue number are discovery only: every candidate PR is
 * then fetched individually and scored with classifyLinkStrength, so a PR
 * that merely lists a sibling issue (e.g. pdfcn #91 closing #70 while
 * mentioning #61) is stored as a "mention", not a "closing" PR. See issue #1.
 */
export async function fetchLinkedPRs(owner: string, repo: string, number: number): Promise<LinkedPR[]> {
  const cached = cacheGet("issue", [owner, repo, String(number), "prs"]) as LinkedPR[] | undefined;
  if (cached) return cached;

  const found = new Map<number, { number: number; state: LinkedPR["state"]; title: string; url: string; via: LinkedPR["via"] }>();

  {
    const timeline = await fetchTimelineEvents(owner, repo, number);
    for (const ref of extractTimelineCrossRefPRs(timeline)) {
      found.set(ref.number, {
        number: ref.number,
        state: "open", // refined below via search state or the individual PR fetch
        title: ref.title,
        url: ref.url,
        via: "timeline",
      });
    }
  }

  // Search PRs in the repo that mention the issue number, to get states.
  try {
    const q = encodeURIComponent(`repo:${owner}/${repo} type:pr #${number}`);
    const data = (await apiGet(`/search/issues?q=${q}&per_page=20`)) as {
      items: Array<{ number: number; state: string; title: string; html_url: string; pull_request?: { merged_at: string | null } }>;
    };
    for (const item of data.items ?? []) {
      const state: LinkedPR["state"] =
        item.pull_request?.merged_at ? "merged" : item.state === "open" ? "open" : "closed";
      const existing = found.get(item.number);
      found.set(item.number, {
        number: item.number,
        state,
        title: item.title,
        url: item.html_url,
        via: existing?.via ?? "search",
      });
    }
  } catch { /* search is best-effort */ }

  // Score each candidate with its real body and branch: discovery is not evidence.
  const prs: LinkedPR[] = [];
  for (const cand of found.values()) {
    let linkStrength: LinkStrength = "mention";
    let title = cand.title;
    let state = cand.state;
    try {
      const detail = (await apiGet(`/repos/${owner}/${repo}/pulls/${cand.number}`)) as {
        title?: unknown;
        body?: unknown;
        state?: unknown;
        merged_at?: unknown;
        head?: { ref?: unknown };
      };
      title = String(detail.title ?? cand.title);
      // The individual PR fetch is authoritative on state (covers
      // timeline-only PRs the search pass never saw).
      state = detail.merged_at != null ? "merged" : detail.state === "closed" ? "closed" : "open";
      const branch = String(detail.head?.ref ?? "");
      linkStrength = classifyLinkStrength({
        title,
        body: String(detail.body ?? ""),
        branch,
        issueNumber: number,
      });
    } catch {
      linkStrength = "mention"; // could not read the PR; treat as a weak reference
    }
    prs.push({ number: cand.number, state, title, url: cand.url, linkStrength, via: cand.via });
  }

  cacheSet("issue", [owner, repo, String(number), "prs"], prs);
  return prs;
}

/** Minimal PR detail needed for the comment-mention cross-check. */
export interface PullRefDetail {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  title: string;
  body: string;
  url: string;
}

export interface MentionedPRDeps {
  fetchPull?: (owner: string, repo: string, number: number) => Promise<PullRefDetail | null>;
}

/**
 * Policy files fetched for gate extraction. Binding contribution rules
 * increasingly live in house-rules files that CONTRIBUTING only links to
 * (reticle keeps its claim-first, DCO, .changes and `pnpm verify` rules in
 * AGENTS.md), so CONTRIBUTING variants are fetched together with AGENTS.md
 * and CLAUDE.md at the root and under .github/. fastmcp moved its rules
 * again in 2026, into docs/development/contributing.mdx behind a pointer
 * CONTRIBUTING.md, which is why the development-guide paths are here too.
 */
export const HOUSE_RULE_FILES = [
  "CONTRIBUTING.md",
  "contributing.md",
  ".github/CONTRIBUTING.md",
  "docs/development/contributing.mdx",
  "docs/development/contributing.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".github/AGENTS.md",
  ".github/CLAUDE.md",
] as const;

export interface HouseRuleDeps {
  /** Test seam: fetch a repo-root file's raw text, or undefined when absent. */
  fetchRaw?: (file: string) => Promise<string | undefined>;
}

/** Fetch all existing house-rules files for a repo (best-effort, cached). */
export async function fetchHouseRules(
  owner: string,
  repo: string,
  deps: HouseRuleDeps = {}
): Promise<{ file: string; text: string }[]> {
  if (!deps.fetchRaw) {
    const cached = cacheGet("house-rules", [owner, repo]) as
      | { file: string; text: string }[]
      | undefined;
    if (cached) return cached;
  }

  const headers: Record<string, string> = { "User-Agent": "greenlight-cli" };
  const token = githubToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const fetchRaw =
    deps.fetchRaw ??
    (async (file: string): Promise<string | undefined> => {
      try {
        const res = await fetch(`${RAW}/${owner}/${repo}/HEAD/${file}`, { headers });
        if (res.ok) return await res.text();
      } catch { /* try next */ }
      return undefined;
    });

  const out: { file: string; text: string }[] = [];
  for (const file of HOUSE_RULE_FILES) {
    const text = await fetchRaw(file);
    if (text) out.push({ file, text });
  }
  if (!deps.fetchRaw) cacheSet("house-rules", [owner, repo], out);
  return out;
}

/** Fetch CONTRIBUTING.md raw text; returns undefined when the repo has none. */
export async function fetchContributing(owner: string, repo: string): Promise<string | undefined> {
  const rules = await fetchHouseRules(owner, repo);
  return rules.find((r) => r.file.toLowerCase().includes("contributing"))?.text;
}

/**
 * Extract PR references from comment bodies: bare #NNN mentions and full
 * github.com/<owner>/<repo>/pull/NNN URLs. Returns deduplicated numbers in
 * order of first appearance.
 */
export function extractPRReferences(
  comments: CommentSignal[],
  owner: string,
  repo: string
): number[] {
  const esc = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "");
  const urlRe = new RegExp(`github\\.com/${esc(owner)}/${esc(repo)}/pull/(\\d+)`, "gi");
  const bareRe = /#(\d{1,6})\b/g;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const comment of comments) {
    for (const re of [urlRe, bareRe]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(comment.body)) !== null) {
        const n = Number(m[1]);
        if (n > 0 && !seen.has(n)) {
          seen.add(n);
          out.push(n);
        }
      }
    }
  }
  return out;
}

/**
 * PR references per citing comment author: number -> first comment author
 * that cited it. Used to tag MentionedPRs with fromAuthor.
 */
export function extractPRReferenceAuthors(
  comments: CommentSignal[],
  owner: string,
  repo: string
): Map<number, string> {
  const esc = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "");
  const urlRe = new RegExp(`github\\.com/${esc(owner)}/${esc(repo)}/pull/(\\d+)`, "gi");
  const bareRe = /#(\d{1,6})\b/g;
  const out = new Map<number, string>();
  for (const comment of comments) {
    for (const re of [urlRe, bareRe]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(comment.body)) !== null) {
        const n = Number(m[1]);
        if (n > 0 && !out.has(n)) out.set(n, comment.author);
      }
    }
  }
  return out;
}

/** True when text references issue number n via #n or a full issue/PR URL. */
function mentionsIssueNumber(text: string, n: number): boolean {
  const bare = text.match(/#(\d{1,6})\b/g) ?? [];
  if (bare.some((r) => Number(r.slice(1)) === n)) return true;
  return text.includes(`/issues/${n}`) || text.includes(`/pull/${n}`);
}

async function defaultFetchPull(
  owner: string,
  repo: string,
  n: number
): Promise<PullRefDetail | null> {
  try {
    const d = (await apiGet(`/repos/${owner}/${repo}/pulls/${n}`)) as {
      number?: unknown;
      state?: unknown;
      merged_at?: unknown;
      title?: unknown;
      body?: unknown;
      html_url?: unknown;
    };
    return {
      number: Number(d.number ?? n),
      state: d.state === "closed" ? "closed" : "open",
      merged: d.merged_at != null,
      title: String(d.title ?? ""),
      body: String(d.body ?? ""),
      url: String(d.html_url ?? ""),
    };
  } catch (e) {
    // A 404 here means the reference was an issue number, not a PR: skip it.
    if (e instanceof ApiNotFoundError) return null;
    throw e;
  }
}

/**
 * Cross-check PR references found in comments against the PR API.
 *
 * Motivation: reticlehq/reticle#691 got a clean GO verdict while its comments
 * contained a partial claim ("Taking the remaining fallback ask") and a
 * heads-up that PR #861 covers that work. Neither signal existed in the
 * timeline or the issue-number search, so both were missed.
 *
 * All comments are scanned (PR references are cheap to extract), but each
 * result records whether the citing comment came from the issue author.
 * The open-PR downgrade (rule 11) only trusts non-author heads-ups; the
 * partially-addressed rule (rule 12) also reads the author's, because the
 * maintainer narrating what already shipped is usually the issue author.
 * References already found via the timeline/search, and the issue's own
 * number, are skipped. Bounded at 5 PR fetches per call; the walk is
 * best-effort and cached like the rest of the issue data.
 */
export async function fetchCommentMentionedPRs(
  owner: string,
  repo: string,
  issueNumber: number,
  comments: CommentSignal[],
  knownPRNumbers: number[],
  deps: MentionedPRDeps & { issueAuthor?: string } = {}
): Promise<MentionedPR[]> {
  // Injected fetch deps (tests) bypass the cache; live calls use it.
  const useCache = !deps.fetchPull;
  if (useCache) {
    const cached = cacheGet("issue", [owner, repo, String(issueNumber), "mentioned-prs"]) as
      | MentionedPR[]
      | undefined;
    if (cached) return cached;
  }

  const refs = extractPRReferences(comments, owner, repo)
    .filter((n) => n !== issueNumber && !knownPRNumbers.includes(n))
    .slice(0, 5);
  const fetchPull = deps.fetchPull ?? defaultFetchPull;

  const refAuthors = extractPRReferenceAuthors(comments, owner, repo);

  const out: MentionedPR[] = [];
  for (const n of refs) {
    let detail: PullRefDetail | null;
    try {
      detail = await fetchPull(owner, repo, n);
    } catch {
      break; // best-effort: a failing provider ends the walk, keeps prior results
    }
    if (!detail) continue; // it was an issue number, not a PR
    out.push({
      number: detail.number,
      url: detail.url,
      state: detail.merged ? "merged" : detail.state,
      mentionsIssue: mentionsIssueNumber(`${detail.title}\n${detail.body}`, issueNumber),
      ...(deps.issueAuthor && refAuthors.get(detail.number) === deps.issueAuthor
        ? { fromAuthor: true }
        : {}),
    });
  }

  if (useCache) cacheSet("issue", [owner, repo, String(issueNumber), "mentioned-prs"], out);
  return out;
}

export interface WorkflowDeps {
  /** Test seam: list .github/workflows file names, or undefined when the directory is absent. */
  listFiles?: () => Promise<string[] | undefined>;
  /** Test seam: fetch one workflow file's raw text, or undefined when absent. */
  fetchRaw?: (name: string) => Promise<string | undefined>;
}

const WORKFLOW_CAP = 12;

/**
 * List the repo's .github/workflows files and fetch their contents
 * (best-effort, cached). Contents fetch uses raw.githubusercontent, so it
 * does not consume the api.github.com rate limit. Capped at 12 files: a
 * repo with more workflows still shows the signal on the suspiciously
 * named ones first (they are not reordered; name matching catches them).
 */
export async function listWorkflows(
  owner: string,
  repo: string,
  deps: WorkflowDeps = {}
): Promise<WorkflowFile[]> {
  const useCache = !deps.listFiles;
  if (useCache) {
    const cached = cacheGet("workflows", [owner, repo]) as WorkflowFile[] | undefined;
    if (cached) return cached;
  }
  let names: string[] = [];
  if (deps.listFiles) {
    names = (await deps.listFiles()) ?? [];
  } else {
    try {
      const items = (await apiGet(`/repos/${owner}/${repo}/contents/.github/workflows`)) as Array<{
        name?: unknown;
        type?: unknown;
      }>;
      names = items
        .filter((i) => i.type === "file")
        .map((i) => String(i.name ?? ""));
    } catch { /* no workflows dir or empty */ }
  }
  const yaml = names.filter((n) => /\.(ya?ml)$/i.test(n)).slice(0, WORKFLOW_CAP);
  const headers: Record<string, string> = { "User-Agent": "greenlight-cli" };
  const token = githubToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const out: WorkflowFile[] = [];
  for (const name of yaml) {
    let content: string | undefined;
    if (deps.fetchRaw) {
      content = await deps.fetchRaw(name);
    } else {
      try {
        const res = await fetch(`${RAW}/${owner}/${repo}/HEAD/.github/workflows/${name}`, { headers });
        if (res.ok) content = await res.text();
      } catch { /* one bad file must not sink the scan */ }
    }
    out.push({ name, content });
  }
  if (useCache) cacheSet("workflows", [owner, repo], out);
  return out;
}

/** Scan a repo's workflows for auto-close automation; returns detected-only gates. */
export async function scanWorkflowGates(
  owner: string,
  repo: string,
  deps: WorkflowDeps = {}
): Promise<Gate[]> {
  try {
    return detectWorkflowGates(await listWorkflows(owner, repo, deps));
  } catch {
    return [];
  }
}

const DUP_URL = "https?:\\/\\/github\\.com\\/[\\w.-]+\\/[\\w.-]+\\/issues\\/(\\d+)";
const DUPLICATE_COMMENT_RES: RegExp[] = [
  /marked as (a )?duplicate of #(\d+)/gi,
  /duplicate of #(\d+)/gi,
  /closed as (a )?duplicate of #(\d+)/gi,
  // "duplicate of https://github.com/<o>/<r>/issues/<n>" — the n8n #41215
  // comment wrote the full URL instead of #40803.
  new RegExp(`marked as (a )?duplicate of ${DUP_URL}`, "gi"),
  new RegExp(`duplicate of ${DUP_URL}`, "gi"),
  new RegExp(`closed as (a )?duplicate of ${DUP_URL}`, "gi"),
];

/**
 * Extract duplicate target issue numbers from comment bodies ("duplicate
 * of #N", GitHub's "This issue has been marked as a duplicate of #N").
 * Pure; tests drive it directly. The last capture group always holds the
 * number.
 */
export function extractDuplicateTargets(comments: CommentSignal[]): number[] {
  const out: number[] = [];
  for (const c of comments) {
    for (const re of DUPLICATE_COMMENT_RES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(c.body)) !== null) {
        const n = Number(m[m.length - 1]);
        if (n > 0 && !out.includes(n)) out.push(n);
      }
    }
  }
  return out;
}

export interface DuplicateTargetDeps {
  /** Test seam: issue timeline events, used instead of the live call. */
  timelineEvents?: Array<Record<string, unknown>>;
  /** Test seam: fetch a referenced issue's live state. */
  fetchIssue?: (owner: string, repo: string, number: number) => Promise<{ state: string; stateReason?: string } | null>;
}

/**
 * Find other issues this one is marked a duplicate of. Signals: "duplicate
 * of #N" comments (n8n's bot posts "marked as a duplicate of #N"), and
 * marked_as_duplicate timeline events when the API surfaces them. Each
 * unique target is fetched for its current state (bounded at 3), because
 * only a target closed as completed means the work already shipped and a
 * build here is wasted.
 */
export async function fetchDuplicateTargets(
  owner: string,
  repo: string,
  number: number,
  comments: CommentSignal[],
  deps: DuplicateTargetDeps = {}
): Promise<DuplicateTarget[]> {
  // The issue's own number ("/attempt #5563" style commands name it) is
  // not a duplicate target.
  const targets = new Set<number>(
    extractDuplicateTargets(comments).filter((n) => n !== number)
  );
  let events = deps.timelineEvents;
  if (!events) {
    try {
      events = await fetchTimelineEvents(owner, repo, number);
    } catch {
      events = [];
    }
  }
  for (const e of events) {
    if (String(e.event) !== "marked_as_duplicate") continue;
    const src = e.source as Record<string, unknown> | undefined;
    const srcIssue = src?.issue as Record<string, unknown> | undefined;
    const n = Number(srcIssue?.number ?? 0);
    if (n > 0 && n !== number) targets.add(n);
  }
  const out: DuplicateTarget[] = [];
  const fetchIssue =
    deps.fetchIssue ??
    (async (o: string, r: string, n: number) => {
      try {
        const d = (await apiGet(`/repos/${o}/${r}/issues/${n}`)) as {
          state?: unknown;
          state_reason?: unknown;
        };
        return {
          state: String(d.state ?? ""),
          stateReason: d.state_reason == null ? undefined : String(d.state_reason),
        };
      } catch {
        return null;
      }
    });
  for (const n of [...targets].slice(0, 3)) {
    let detail: { state: string; stateReason?: string } | null = null;
    try {
      detail = await fetchIssue(owner, repo, n);
    } catch {
      continue;
    }
    if (!detail) continue;
    out.push({
      number: n,
      url: `https://github.com/${owner}/${repo}/issues/${n}`,
      state: detail.state === "closed" ? "closed" : "open",
      ...(detail.stateReason ? { stateReason: detail.stateReason } : {}),
    });
  }
  return out;
}

/** A PR URL found in a fix-announcement comment, possibly in another repo of the same org. */
export interface AttemptPRLink {
  author: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
}

/**
 * Normalize a comment body line-by-line for fix-announcement matching:
 * strip leading emoji and non-word characters from each line. Seen on
 * actualbudget/actual#8429, where a bot posted "🤖 Opened #8474 with a
 * focused fix" and the announcement regex missed it entirely.
 */
export function normalizeCommentText(body: string): string {
  return body
    .split("\n")
    .map((line) => line.replace(/^[^\p{L}\p{N}#/@]+/u, ""))
    .join("\n");
}

// Comments that announce work is happening, whose PR URLs are race signals:
// "/attempt #5563" style commands, and narratives like "Submitted fix for
// bug #1 ... in https://github.com/<o>/<r>/pull/<n>". A bare PR link
// posted as prior art (no announcement language) does not qualify.
const FIX_ANNOUNCE_RES: RegExp[] = [
  /^\s*\/(attempt|claim)\b/i,
  /submitted (a |the )?fix/i,
  /opened (a |the )?pr/i,
  // "Opened #8474 with a focused fix" — the announcement names the issue
  // number directly instead of the word "PR" (actualbudget/actual#8429).
  /opened\s+#\d+/i,
  /implemented (a |the )?fix/i,
];
const CROSS_REPO_PR_URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/gi;

/**
 * Extract PR links from fix-announcement comments. Comments from bots and
 * from the issue author are skipped. The URLs routinely point at sibling
 * repos in the same org (tscircuit/tscircuit#5563's fixes live in
 * tscircuit/core and tscircuit/checks), so they are not limited to the
 * issue's own repo. Bodies are normalized (emoji-stripped) before
 * matching. Pure; tests drive it directly. Bounded at 5 links.
 */
export function extractAttemptLinkedPRs(comments: CommentSignal[], issueAuthor: string): AttemptPRLink[] {
  const seen = new Set<string>();
  const out: AttemptPRLink[] = [];
  for (const c of comments) {
    if (c.author === issueAuthor || isBotAuthor(c.author)) continue;
    const body = normalizeCommentText(c.body);
    if (!FIX_ANNOUNCE_RES.some((re) => re.test(body))) continue;
    CROSS_REPO_PR_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CROSS_REPO_PR_URL_RE.exec(body)) !== null) {
      const url = m[0];
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ author: c.author, owner: m[1], repo: m[2], number: Number(m[3]), url });
    }
  }
  return out.slice(0, 5);
}

/**
 * Extract PR references from timeline cross-referenced events. GitHub nests
 * the referenced issue one level down: event.source.issue.html_url, with
 * source.pull_request present when the reference is a PR. The older reader
 * looked at source.html_url directly, which the API never fills, so the
 * timeline walk silently found nothing. Pure; tests drive it directly.
 */
export function extractTimelineCrossRefPRs(
  events: Record<string, unknown>[]
): Array<{ number: number; title: string; url: string }> {
  const out: Array<{ number: number; title: string; url: string }> = [];
  for (const event of events) {
    if (event.event !== "cross-referenced") continue;
    const src = event.source as Record<string, unknown> | undefined;
    if (!src || src.type !== "issue") continue;
    // Real shape: { type: "issue", issue: { html_url, title, pull_request } }.
    const inner = (src.issue as Record<string, unknown> | undefined) ?? src;
    const pull = inner.pull_request as Record<string, unknown> | undefined;
    if (!pull) continue;
    const prUrl = String(inner.html_url ?? "");
    const nm = /\/pull\/(\d+)/.exec(prUrl);
    if (!nm) continue;
    const n = Number(nm[1]);
    if (!out.some((o) => o.number === n)) {
      out.push({ number: n, title: String(inner.title ?? ""), url: prUrl });
    }
  }
  return out;
}

/** Count open issues labelled good-first-issue or help-wanted. */
export async function countStarterIssues(owner: string, repo: string): Promise<number | null> {
  try {
    const q = encodeURIComponent(`repo:${owner}/${repo} type:issue state:open (label:"good first issue" OR label:"help wanted")`);
    const data = (await apiGet(`/search/issues?q=${q}&per_page=1`)) as { total_count: number };
    return data.total_count ?? null;
  } catch {
    return null;
  }
}

/** Detect a collaborators-only PR creation policy via the community metrics endpoint. */
export async function detectRepoPolicy(owner: string, repo: string): Promise<{ collaboratorsOnly: boolean }> {
  // Best-effort: no public API exposes pull_request_creation_policy directly,
  // so we treat it as unknown (false) unless evidence appears elsewhere.
  return { collaboratorsOnly: false };
}

/** Build a full IssueSnapshot from the live API. */
export async function buildIssueSnapshot(owner: string, repo: string, number: number): Promise<IssueSnapshot> {
  const cached = cacheGet("issue", [owner, repo, String(number), "snapshot"]) as IssueSnapshot | undefined;
  if (cached) return cached;

  const issue = (await apiGet(`/repos/${owner}/${repo}/issues/${number}`)) as Record<string, unknown>;
  if ((issue as { pull_request?: unknown }).pull_request) {
    throw new Error(`#${number} is a pull request, not an issue`);
  }
  const issueAuthor = String((issue.user as Record<string, string> | undefined)?.login ?? "");
  const [comments, linkedPRs, houseRules, workflowGates] = await Promise.all([
    fetchComments(owner, repo, number),
    fetchLinkedPRs(owner, repo, number),
    fetchHouseRules(owner, repo),
    scanWorkflowGates(owner, repo),
  ]);

  // Comment-mentioned PRs: references like "#861" in comments, cross-checked
  // against the PR API. The open-PR downgrade trusts only non-author
  // heads-ups (see rule 11), but the partially-addressed rule also reads
  // the author's, since the maintainer narrating shipped work is usually
  // the issue author. Best-effort; never blocks the snapshot.
  let commentMentionedPRs: MentionedPR[] = [];
  try {
    commentMentionedPRs = await fetchCommentMentionedPRs(
      owner,
      repo,
      number,
      comments,
      linkedPRs.map((p) => p.number),
      { issueAuthor }
    );
  } catch { /* best-effort */ }

  // Attempt-linked PRs: fix-announcement comments ("Submitted fix for bug
  // #1 ... in <PR url>", "/attempt #N" commands) whose PRs often live in
  // sibling repos the timeline and the issue-number search never see.
  // Fetched best-effort (bounded at 5, the extractor's own cap) and merged
  // into commentMentionedPRs with attemptLinked so the verdict engine
  // quotes them as race evidence.
  try {
    const known = new Set([
      ...linkedPRs.map((p) => p.url),
      ...commentMentionedPRs.map((p) => p.url),
    ]);
    for (const link of extractAttemptLinkedPRs(comments, issueAuthor).slice(0, 5)) {
      if (known.has(link.url)) continue;
      known.add(link.url);
      let detail: PullRefDetail | null;
      try {
        detail = await defaultFetchPull(link.owner, link.repo, link.number);
      } catch {
        break; // best-effort: one failing provider ends the walk
      }
      if (!detail) continue;
      commentMentionedPRs.push({
        number: detail.number,
        url: link.url,
        state: detail.merged ? "merged" : detail.state,
        mentionsIssue: mentionsIssueNumber(`${detail.title}\n${detail.body}`, number),
        attemptLinked: true,
      });
    }
  } catch { /* best-effort */ }

  // Duplicate-of targets: "duplicate of #N" comments and marked-as-duplicate
  // timeline signals, each fetched for its live state. Best-effort.
  let duplicateOf: DuplicateTarget[] = [];
  try {
    duplicateOf = await fetchDuplicateTargets(owner, repo, number, comments);
  } catch { /* best-effort */ }

  // Server-side-only signal: when a quoted error string from the issue
  // body has zero hits in the repo, the check may live outside it
  // (ComposioHQ/composio#4852: a closed backend enforced the 422). The
  // detector degrades to "no evidence" on any API failure.
  let serverSide: IssueSnapshot["serverSide"];
  try {
    const signal = await detectServerSideOnly(owner, repo, String(issue.body ?? ""));
    if (signal) serverSide = signal;
  } catch { /* best-effort */ }

  const snapshot: IssueSnapshot = {
    sourceUrl: `https://github.com/${owner}/${repo}/issues/${number}`,
    owner,
    repo,
    number,
    state: String(issue.state) as "open" | "closed",
    title: String(issue.title ?? ""),
    body: String(issue.body ?? ""),
    author: ((issue.user as Record<string, string> | undefined)?.login ?? ""),
    assignees: ((issue.assignees as Array<Record<string, string>> | undefined) ?? []).map((a) => a.login),
    labels: ((issue.labels as Array<Record<string, string>> | undefined) ?? []).map((l) => l.name),
    comments,
    linkedPRs,
    commentMentionedPRs,
    createdAt: String(issue.created_at),
    updatedAt: String(issue.updated_at),
    // Joined text kept for compatibility; the verdict engine prefers the
    // per-file houseRules when present so gates record their source file.
    contributing: houseRules.map((r) => r.text).join("\n\n"),
    houseRules,
    workflowGates,
    duplicateOf,
    ...(serverSide ? { serverSide } : {}),
  };
  cacheSet("issue", [owner, repo, String(number), "snapshot"], snapshot);
  return snapshot;
}

export interface ScanCandidate {
  number: number;
  title: string;
  url: string;
  labels: string[];
  updatedAt: string;
}

/** List open good-first-issue / help-wanted issues for scan mode. */
export async function listStarterIssues(
  owner: string,
  repo: string,
  limit = 25
): Promise<ScanCandidate[]> {
  const q = encodeURIComponent(
    `repo:${owner}/${repo} type:issue state:open no:assignee (label:"good first issue" OR label:"help wanted")`
  );
  const data = (await apiGet(`/search/issues?q=${q}&per_page=${limit}&sort=updated&order=desc`)) as {
    items: Array<{
      number: number;
      title: string;
      html_url: string;
      labels: Array<{ name: string }>;
      updated_at: string;
    }>;
  };
  return (data.items ?? []).map((i) => ({
    number: i.number,
    title: i.title,
    url: i.html_url,
    labels: i.labels.map((l) => l.name),
    updatedAt: i.updated_at,
  }));
}

/** Raw issue-list item shape from GET /repos/:o/:r/issues. */
interface IssueListItem {
  number: number;
  title: string;
  html_url: string;
  labels: Array<{ name: string }>;
  updated_at: string;
  pull_request?: unknown;
  assignees?: Array<{ login: string }>;
}

/**
 * Filter raw issue-list items down to scan candidates: real issues (not
 * pull requests) with no assignees, newest first. Pure so tests can drive
 * it with fixtures.
 */
export function toScanCandidates(items: IssueListItem[]): ScanCandidate[] {
  return items
    .filter((i) => !i.pull_request && (i.assignees ?? []).length === 0)
    .map((i) => ({
      number: i.number,
      title: i.title,
      url: i.html_url,
      labels: i.labels.map((l) => l.name),
      updatedAt: i.updated_at,
    }));
}

/**
 * Fallback candidate list for scan mode: the most recent open unassigned
 * issues in the repo, for repos whose landable issues do not carry
 * good-first-issue / help-wanted labels. Lists broadly (up to `cap`) so
 * the caller can take the newest slice.
 */
export async function listRecentUnassignedIssues(
  owner: string,
  repo: string,
  cap = 25
): Promise<ScanCandidate[]> {
  const items = await paginate<IssueListItem>(
    `/repos/${owner}/${repo}/issues?state=open&sort=created&direction=desc`,
    100,
    3
  );
  return toScanCandidates(items).slice(0, cap);
}

export interface ScanCandidateList {
  issues: ScanCandidate[];
  /** True when the label pass came back empty and the fallback list was used. */
  fallbackUsed: boolean;
}

export interface ScanDeps {
  starter?: (owner: string, repo: string, limit: number) => Promise<ScanCandidate[]>;
  recent?: (owner: string, repo: string, cap: number) => Promise<ScanCandidate[]>;
}

/**
 * Scan candidates for a repo: the label-tagged starter list first; when it
 * is empty, fall back to recent open unassigned issues (opt out with
 * fallback: false). Injectable deps keep tests offline.
 */
export async function scanCandidates(
  owner: string,
  repo: string,
  opts: { fallback?: boolean; limit?: number } = {},
  deps: ScanDeps = {}
): Promise<ScanCandidateList> {
  const limit = opts.limit ?? 10;
  const starter = deps.starter ?? listStarterIssues;
  const labeled = await starter(owner, repo, limit);
  if (labeled.length > 0) return { issues: labeled, fallbackUsed: false };
  if (opts.fallback === false) return { issues: [], fallbackUsed: false };
  const recent = deps.recent ?? listRecentUnassignedIssues;
  const issues = (await recent(owner, repo, 25)).slice(0, limit);
  return { issues, fallbackUsed: true };
}

export type { GateKind };
