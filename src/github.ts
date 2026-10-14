/**
 * GitHub API client. Native fetch only, no extra dependencies.
 * Optional GITHUB_TOKEN env var raises the rate limit from 60 to 5000 req/hr.
 * Responses are cached under ~/.cache/greenlight (6h TTL for issues/repos,
 * 1h for search) so repeated checks do not burn quota.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import type { IssueSnapshot, LinkedPR, CommentSignal, GateKind } from "./types.js";
import { classifyLinkStrength, type LinkStrength } from "./linkstrength.js";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const CACHE_DIR = join(homedir(), ".cache", "greenlight");

function ensureCache(): void {
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
}

const TTL_MS: Record<string, number> = {
  issue: 6 * 60 * 60 * 1000,
  search: 60 * 60 * 1000,
  contributing: 24 * 60 * 60 * 1000,
};

function cacheKey(kind: string, parts: string[]): string {
  return `${kind}-${parts.join("-").replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`;
}

function cacheGet(kind: string, parts: string[]): unknown | undefined {
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

function cacheSet(kind: string, parts: string[], data: unknown): void {
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

  const res = await fetch(`${API}${path}`, { headers });
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

  const res = await fetch(`${API}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
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
  if (!m) throw new Error(`Not a GitHub issue URL: ${url}`);
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
  }));
  cacheSet("issue", [owner, repo, String(number), "comments"], comments);
  return comments;
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

  const found = new Map<number, { number: number; state: LinkedPR["state"]; title: string; url: string }>();

  try {
    const timeline = await paginate<Record<string, unknown>>(`/repos/${owner}/${repo}/issues/${number}/timeline`);
    for (const event of timeline) {
      if (event.event !== "cross-referenced") continue;
      const src = event.source as Record<string, unknown> | undefined;
      if (!src || src.type !== "issue") continue;
      const pull = (src as Record<string, unknown>).pull_request as Record<string, unknown> | undefined;
      if (!pull) continue;
      const prUrl = String((src as Record<string, unknown>).html_url ?? "");
      const nm = /\/pull\/(\d+)/.exec(prUrl);
      if (!nm) continue;
      found.set(Number(nm[1]), {
        number: Number(nm[1]),
        state: "open", // refined below via search state
        title: String((src as Record<string, unknown>).title ?? ""),
        url: prUrl,
      });
    }
  } catch { /* timeline is best-effort */ }

  // Search PRs in the repo that mention the issue number, to get states.
  try {
    const q = encodeURIComponent(`repo:${owner}/${repo} type:pr #${number}`);
    const data = (await apiGet(`/search/issues?q=${q}&per_page=20`)) as {
      items: Array<{ number: number; state: string; title: string; html_url: string; pull_request?: { merged_at: string | null } }>;
    };
    for (const item of data.items ?? []) {
      const state: LinkedPR["state"] =
        item.pull_request?.merged_at ? "merged" : item.state === "open" ? "open" : "closed";
      found.set(item.number, {
        number: item.number,
        state,
        title: item.title,
        url: item.html_url,
      });
    }
  } catch { /* search is best-effort */ }

  // Score each candidate with its real body and branch: discovery is not evidence.
  const prs: LinkedPR[] = [];
  for (const cand of found.values()) {
    let linkStrength: LinkStrength = "mention";
    let title = cand.title;
    try {
      const detail = (await apiGet(`/repos/${owner}/${repo}/pulls/${cand.number}`)) as {
        title?: unknown;
        body?: unknown;
        head?: { ref?: unknown };
      };
      title = String(detail.title ?? cand.title);
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
    prs.push({ number: cand.number, state: cand.state, title, url: cand.url, linkStrength });
  }

  cacheSet("issue", [owner, repo, String(number), "prs"], prs);
  return prs;
}

/** Fetch CONTRIBUTING.md raw text; returns undefined when the repo has none. */
export async function fetchContributing(owner: string, repo: string): Promise<string | undefined> {
  const cached = cacheGet("contributing", [owner, repo]) as string | null | undefined;
  if (cached !== undefined) return cached ?? undefined;

  const headers: Record<string, string> = { "User-Agent": "greenlight-cli" };
  const token = githubToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  for (const name of ["CONTRIBUTING.md", "contributing.md", ".github/CONTRIBUTING.md"]) {
    try {
      const res = await fetch(`${RAW}/${owner}/${repo}/HEAD/${name}`, { headers });
      if (res.ok) {
        const text = await res.text();
        cacheSet("contributing", [owner, repo], text);
        return text;
      }
    } catch { /* try next */ }
  }
  cacheSet("contributing", [owner, repo], null);
  return undefined;
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
  const [comments, linkedPRs, contributing] = await Promise.all([
    fetchComments(owner, repo, number),
    fetchLinkedPRs(owner, repo, number),
    fetchContributing(owner, repo),
  ]);

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
    createdAt: String(issue.created_at),
    updatedAt: String(issue.updated_at),
    contributing,
  };
  cacheSet("issue", [owner, repo, String(number), "snapshot"], snapshot);
  return snapshot;
}

/** List open good-first-issue / help-wanted issues for scan mode. */
export async function listStarterIssues(
  owner: string,
  repo: string,
  limit = 25
): Promise<Array<{ number: number; title: string; url: string; labels: string[]; updatedAt: string }>> {
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

export type { GateKind };
