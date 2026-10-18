/**
 * `greenlight sync`: reconcile the campaign's local memory with the GitHub
 * API census (v0.10.0).
 *
 * Multi-agent field lesson 2026-10-18: several agents now open PRs in
 * parallel threads, and the local claims registry only knows about PRs
 * this process created. `sync` pulls the authoritative census
 * (author:<login> type:pr via the search API) and reports drift:
 *
 *   - PRs the registry has never seen (another agent opened them),
 *   - state mismatches (the registry says open, the API says merged),
 *   - stale claims (a claim older than --stale-days with no linked PR).
 *
 * With --write the census upserts the registry's known-PRs section; with
 * --tracker <csv|json> it also diffs a tracker file. READS ONLY: sync
 * never posts, claims, or closes anything on GitHub.
 */
import { readFileSync } from "node:fs";
import { apiGet } from "./github.js";
import {
  defaultRegistryPath,
  loadRegistry,
  saveRegistry,
  type ClaimsRegistryFile,
  type KnownPr,
} from "./claims-registry.js";

export interface CensusPr {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  author: string;
  createdAt: string;
  updatedAt: string;
}

interface SearchPrItem {
  html_url?: string;
  title?: string;
  state?: string;
  user?: { login?: string };
  created_at?: string;
  updated_at?: string;
  pull_request?: { merged_at?: string | null };
}

/**
 * The authoritative PR census for one author. Paginated; the search API
 * caps at 1000 results, so maxPages bounds the walk (default 10).
 */
export async function fetchAuthorCensus(
  author: string,
  perPage = 100,
  maxPages = 10
): Promise<CensusPr[]> {
  const prs: CensusPr[] = [];
  const q = encodeURIComponent(`author:${author} type:pr`);
  for (let page = 1; page <= maxPages; page++) {
    const data = (await apiGet(
      `/search/issues?q=${q}&per_page=${perPage}&page=${page}&sort=updated&order=desc`
    )) as { items?: SearchPrItem[] };
    const items = data?.items ?? [];
    for (const i of items) {
      const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(i.html_url ?? "");
      if (!m) continue;
      prs.push({
        owner: m[1],
        repo: m[2],
        number: Number(m[3]),
        url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`,
        title: i.title ?? "",
        state: i.state === "open" ? "open" : "closed",
        merged: !!(i.pull_request && i.pull_request.merged_at),
        author: i.user?.login ?? author,
        createdAt: i.created_at ?? "",
        updatedAt: i.updated_at ?? "",
      });
    }
    if (items.length < perPage) break;
  }
  return prs;
}

/**
 * Upsert the census into the registry's known-PRs section. New PRs are
 * added; known ones get fresh state/title/lastSeen. Returns add/update
 * counts so callers can report what moved.
 */
export function upsertKnownPrs(
  path: string,
  prs: CensusPr[],
  nowIso: string
): { added: number; updated: number } {
  const registry = loadRegistry(path);
  const known = new Map((registry.prs ?? []).map((p) => [p.prUrl.toLowerCase(), p]));
  let added = 0;
  let updated = 0;
  for (const c of prs) {
    const key = c.url.toLowerCase();
    const existing = known.get(key);
    if (existing) {
      existing.state = c.state;
      existing.merged = c.merged;
      existing.title = c.title;
      existing.lastSeen = nowIso;
      updated++;
    } else {
      known.set(key, {
        prUrl: c.url,
        owner: c.owner,
        repo: c.repo,
        number: c.number,
        state: c.state,
        merged: c.merged,
        title: c.title,
        firstSeen: nowIso,
        lastSeen: nowIso,
        source: "census",
      });
      added++;
    }
  }
  registry.prs = [...known.values()].sort((a, b) =>
    a.repo === b.repo ? a.number - b.number : a.repo.localeCompare(b.repo)
  );
  saveRegistry(path, registry);
  return { added, updated };
}

/** One row of an optional tracker file (repo, issue, pr_url, status columns). */
export interface TrackerRow {
  repo: string;
  issue: string;
  prUrl: string;
  status: string;
}

const TRACKER_KEYS: Record<keyof TrackerRow, string[]> = {
  repo: ["repo", "repository"],
  issue: ["issue", "issue_number", "number"],
  prUrl: ["pr_url", "prurl", "pr", "pull_request"],
  status: ["status", "state"],
};

function pick(row: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    for (const actual of Object.keys(row)) {
      if (actual.toLowerCase() === k) {
        const v = row[actual];
        if (v !== undefined && v !== null) return String(v);
      }
    }
  }
  return "";
}

/**
 * Parse a tracker file by extension: CSV with a header row, or a JSON
 * array of objects. Columns/keys: repo, issue, pr_url, status (tolerant
 * aliases accepted). Throws on an unreadable or unparseable file.
 */
export function parseTracker(text: string, format: "csv" | "json"): TrackerRow[] {
  if (format === "json") {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) throw new Error("tracker JSON must be an array of objects");
    return (parsed as Record<string, unknown>[]).map((r) => ({
      repo: pick(r, TRACKER_KEYS.repo),
      issue: pick(r, TRACKER_KEYS.issue),
      prUrl: pick(r, TRACKER_KEYS.prUrl),
      status: pick(r, TRACKER_KEYS.status),
    }));
  }
  // Minimal CSV: header row, comma-separated, double-quote escaping.
  const rows: string[][] = [];
  let cur = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((c) => c.trim().length > 0)) rows.push(row);
      row = [];
    } else {
      cur += ch;
    }
  }
  row.push(cur);
  if (row.some((c) => c.trim().length > 0)) rows.push(row);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (keys: string[]): number => {
    for (const k of keys) {
      const i = header.indexOf(k);
      if (i >= 0) return i;
    }
    return -1;
  };
  const ri = idx(TRACKER_KEYS.repo);
  const ii = idx(TRACKER_KEYS.issue);
  const pi = idx(TRACKER_KEYS.prUrl);
  const si = idx(TRACKER_KEYS.status);
  return rows.slice(1).map((r) => ({
    repo: ri >= 0 ? (r[ri] ?? "").trim() : "",
    issue: ii >= 0 ? (r[ii] ?? "").trim() : "",
    prUrl: pi >= 0 ? (r[pi] ?? "").trim() : "",
    status: si >= 0 ? (r[si] ?? "").trim() : "",
  }));
}

export function loadTrackerFile(path: string): TrackerRow[] {
  const text = readFileSync(path, "utf8");
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return parseTracker(text, "json");
  if (lower.endsWith(".csv")) return parseTracker(text, "csv");
  throw new Error(`tracker file must end in .csv or .json: ${path}`);
}

export interface DriftItem {
  kind: "unknown-pr" | "state-mismatch" | "stale-claim";
  repo: string;
  number: number;
  url: string;
  detail: string;
}

export interface SyncDrift {
  unknownPrs: DriftItem[];
  stateMismatches: DriftItem[];
  staleClaims: DriftItem[];
  counts: {
    census: number;
    open: number;
    merged: number;
    closedUnmerged: number;
    registryClaims: number;
    knownPrs: number;
    trackerRows: number | null;
  };
}

/**
 * Pure drift computation: census (API truth) vs the local registry and
 * an optional tracker. A claim counts as linked when its prUrl appears in
 * the census; a registry PR counts as known when the census confirms it.
 */
export function computeDrift(
  census: CensusPr[],
  registry: ClaimsRegistryFile,
  tracker: TrackerRow[] | null,
  staleDays: number,
  nowMs: number
): SyncDrift {
  const censusByUrl = new Map(census.map((c) => [c.url.toLowerCase(), c]));
  const knownUrls = new Set((registry.prs ?? []).map((p) => p.prUrl.toLowerCase()));
  const claimPrUrls = new Set(
    registry.claims.map((c) => (c.prUrl ?? "").toLowerCase()).filter((u) => u.length > 0)
  );

  const unknownPrs: DriftItem[] = [];
  for (const c of census) {
    const key = c.url.toLowerCase();
    if (!knownUrls.has(key) && !claimPrUrls.has(key)) {
      unknownPrs.push({
        kind: "unknown-pr",
        repo: `${c.owner}/${c.repo}`,
        number: c.number,
        url: c.url,
        detail: `${c.state}${c.merged ? " (merged)" : ""}: ${c.title}`.trim(),
      });
    }
  }

  const stateMismatches: DriftItem[] = [];
  const checkState = (url: string, localState: string, source: string) => {
    const c = censusByUrl.get(url.toLowerCase());
    if (!c) return;
    const apiState = c.merged ? "merged" : c.state;
    if (localState.toLowerCase() !== apiState) {
      stateMismatches.push({
        kind: "state-mismatch",
        repo: `${c.owner}/${c.repo}`,
        number: c.number,
        url: c.url,
        detail: `${source} says "${localState}", API says "${apiState}"`,
      });
    }
  };
  for (const p of registry.prs ?? []) {
    checkState(p.prUrl, p.merged ? "merged" : p.state, "registry");
  }
  if (tracker) {
    for (const t of tracker) {
      if (t.prUrl) checkState(t.prUrl, t.status, "tracker");
    }
  }

  const staleClaims: DriftItem[] = [];
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  for (const cl of registry.claims) {
    if (cl.prUrl) continue;
    const age = nowMs - Date.parse(cl.postedAt);
    if (Number.isFinite(age) && age >= staleMs) {
      staleClaims.push({
        kind: "stale-claim",
        repo: `${cl.owner}/${cl.repo}`,
        number: cl.number,
        url: cl.issueUrl,
        detail: `claimed ${Math.round(age / (24 * 60 * 60 * 1000))}d ago, no linked PR`,
      });
    }
  }

  return {
    unknownPrs,
    stateMismatches,
    staleClaims,
    counts: {
      census: census.length,
      open: census.filter((c) => c.state === "open").length,
      merged: census.filter((c) => c.merged).length,
      closedUnmerged: census.filter((c) => c.state === "closed" && !c.merged).length,
      registryClaims: registry.claims.length,
      knownPrs: registry.prs?.length ?? 0,
      trackerRows: tracker ? tracker.length : null,
    },
  };
}

/** Human drift report: deltas first, counts after. */
export function formatSyncHuman(drift: SyncDrift, author: string): string {
  const lines: string[] = [];
  const total = drift.unknownPrs.length + drift.stateMismatches.length + drift.staleClaims.length;
  lines.push(`**sync: ${total} drift item${total === 1 ? "" : "s"}** (census author:${author})`);
  const section = (title: string, items: DriftItem[]) => {
    lines.push("");
    lines.push(`## ${title} (${items.length})`);
    if (items.length === 0) lines.push("_None._");
    else for (const i of items) lines.push(`- ${i.repo}#${i.number} — ${i.detail} (${i.url})`);
  };
  section("PRs the registry does not know", drift.unknownPrs);
  section("State mismatches (local vs API truth)", drift.stateMismatches);
  section("Stale claims (no PR after the window)", drift.staleClaims);
  lines.push("");
  const c = drift.counts;
  lines.push(
    `_census: ${c.census} PRs (${c.open} open, ${c.merged} merged, ${c.closedUnmerged} closed unmerged); registry: ${c.registryClaims} claims, ${c.knownPrs} known PRs${c.trackerRows === null ? "" : `; tracker: ${c.trackerRows} rows`}._`
  );
  return lines.join("\n");
}

export function syncJson(drift: SyncDrift, author: string): Record<string, unknown> {
  return { author, drift };
}

export interface SyncRunOptions {
  author: string;
  trackerPath?: string;
  staleDays?: number;
  write?: boolean;
  registryPath?: string;
  nowMs?: number;
}

/** Full sync run: census, drift, optional tracker diff, optional registry write. */
export async function runSync(opts: SyncRunOptions): Promise<{ drift: SyncDrift; wrote: { added: number; updated: number } | null; author: string }> {
  const registryPath = opts.registryPath ?? defaultRegistryPath();
  const nowMs = opts.nowMs ?? Date.now();
  const census = await fetchAuthorCensus(opts.author);
  let tracker: TrackerRow[] | null = null;
  if (opts.trackerPath) tracker = loadTrackerFile(opts.trackerPath);
  const registry = loadRegistry(registryPath);
  const drift = computeDrift(census, registry, tracker, opts.staleDays ?? 7, nowMs);
  let wrote: { added: number; updated: number } | null = null;
  if (opts.write) {
    wrote = upsertKnownPrs(registryPath, census, new Date(nowMs).toISOString());
  }
  return { drift, wrote, author: opts.author };
}
