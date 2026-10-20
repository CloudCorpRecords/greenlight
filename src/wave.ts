/**
 * Wave shortlist (v0.16.0): turn the Agent Policy Index into a build
 * queue in one command.
 *
 * Field data (2026-10-19, PR wave): the wave coordinator hand-rolled
 * vetting scripts (index filter plus per-issue timeline cross-checks
 * across repos) because Greenlight could not produce a build queue in one
 * command. This module is that pipeline, built from the existing parts:
 *   1. Index filter: pure-open repos (policy_classes == ["open"]) with
 *      outsider merge share, star band, and starter-issue count.
 *   2. Starter issues per repo (label search, the same source scan uses).
 *   3. The EXISTING xray timeline verification per issue (reused, never
 *      forked): verdicts map GO -> CLEAR, TAKEN -> TAKEN (with the reason
 *      naming competing PRs).
 *   4. Behavioral gate check (Feature 1) on repos that survive, only for
 *      repos that produced at least one CLEAR issue: a detected
 *      behavioral gate excludes the repo with the reason named.
 *   5. A repo is also skipped when the authenticated user already has an
 *      open PR there (one search call, not one per repo).
 *
 * Budget honesty: every stage reports the GitHub API calls it used, and
 * the run stops with partial results (marked partial) when the core
 * budget falls under the floor, so a wave never strands the rate limit.
 * Search-side throttling (GitHub's secondary rate limits) degrades to
 * partial results the same way instead of failing the whole run.
 */
import { apiGet, apiCallsUsed, listStarterIssues, RateLimitError } from "./github.js";
import { xrayIssue, type XrayResult } from "./xray.js";
import { detectBehavioralGate, type BehavioralGate } from "./behavior.js";

export const POLICY_INDEX_URL = "https://cloudcorprecords.github.io/greenlight/policy.json";

/** One entry of the Agent Policy Index (the fields wave filters on). */
export interface PolicyIndexEntry {
  repo: string;
  url?: string;
  policy_classes: string[];
  stars: number | null;
  good_first_issues: number | null;
  /** 0..100 scale in policy.json. */
  outsider_merge_share: number | null;
  /**
   * v0.16.2: normalized from greenlight_friction.score when the index
   * carries it (lower is easier). Null when the index has no friction
   * verdict for the entry.
   */
  friction_score?: number | null;
}

export interface WaveFilters {
  minShare: number;
  minStars: number;
  maxStars: number;
  maxRepos: number;
  issuesPerRepo: number;
  minBudget: number;
  /**
   * v0.16.2: candidate ranking. "winnability" (default) ranks by outsider
   * merge share, then friction score, then stars as a tiebreak, so quiet
   * high-converting repos are reached before star-heavy raced ones.
   * "stars" restores the pre-0.16.2 stars-descending order.
   */
  sort?: "winnability" | "stars";
}

export const DEFAULT_WAVE_FILTERS: WaveFilters = {
  minShare: 40,
  minStars: 1000,
  maxStars: 150000,
  maxRepos: 10,
  issuesPerRepo: 3,
  minBudget: 800,
};

export type WaveVerdict = "CLEAR" | "RISKY" | "TAKEN" | "ERROR";

export interface WaveIssue {
  repo: string;
  number: number;
  title: string;
  url: string;
  verdict: WaveVerdict;
  reasons: string[];
  flags: string[];
  competingPRs: Array<{ number: number; url: string; state: string }>;
  apiCalls: number;
}

export interface WaveRepo {
  repo: string;
  url: string;
  stars: number;
  /** Set when the repo was skipped or excluded; the reason is always named. */
  excluded?: string;
  issues: WaveIssue[];
  behavioralGate?: BehavioralGate;
}

export interface WaveResult {
  repos: WaveRepo[];
  /** Ranked queue: CLEAR first, then RISKY; repo star order within a tier. */
  queue: WaveIssue[];
  apiCalls: number;
  partial: boolean;
  partialReason?: string;
  filters: WaveFilters;
  candidatesConsidered: number;
}

/** Injected so tests can drive the pipeline with fixtures. */
export interface WaveDeps {
  /** Authenticated GitHub login. */
  getLogin(): Promise<string>;
  /** Set of repo full names (owner/repo) where the login has an open PR. */
  ownOpenPrRepos(login: string): Promise<Set<string>>;
  starterIssues(
    owner: string,
    repo: string,
    limit: number
  ): Promise<Array<{ number: number; title: string; url: string }>>;
  xray(owner: string, repo: string, number: number): Promise<XrayResult>;
  behavioral(owner: string, repo: string): Promise<BehavioralGate>;
  remainingBudget(): Promise<number>;
}

/** Pure: the index-side filter. Candidates must be pure-open, actually
 * merge outsider PRs, sit in the star band, and have starter issues.
 * Ranking is by winnability by default (outsider merge share, then
 * friction, then stars as the tiebreak); --sort stars restores the old
 * stars-descending order. */
export function filterWaveRepos(
  entries: PolicyIndexEntry[],
  filters: WaveFilters
): PolicyIndexEntry[] {
  const sort = filters.sort ?? "winnability";
  const frictionOf = (e: PolicyIndexEntry): number => {
    const s = e.friction_score ?? null;
    return s === null ? Number.POSITIVE_INFINITY : s;
  };
  return entries
    .filter((e) => {
      const classes = e.policy_classes ?? [];
      if (classes.length !== 1 || classes[0] !== "open") return false;
      if ((e.good_first_issues ?? 0) < 1) return false;
      if ((e.outsider_merge_share ?? 0) < filters.minShare) return false;
      const stars = e.stars ?? 0;
      if (stars < filters.minStars || stars > filters.maxStars) return false;
      return true;
    })
    .sort((a, b) => {
      if (sort === "stars") return (b.stars ?? 0) - (a.stars ?? 0);
      const share = (b.outsider_merge_share ?? 0) - (a.outsider_merge_share ?? 0);
      if (share !== 0) return share;
      const friction = frictionOf(a) - frictionOf(b);
      if (friction !== 0) return friction;
      return (b.stars ?? 0) - (a.stars ?? 0);
    })
    .slice(0, filters.maxRepos);
}

function mapXrayVerdict(v: XrayResult["verdict"]): WaveVerdict {
  switch (v) {
    case "GO":
      return "CLEAR";
    case "RISKY":
      return "RISKY";
    case "TAKEN":
      return "TAKEN";
    default:
      return "ERROR";
  }
}

export async function runWave(
  index: PolicyIndexEntry[],
  filters: WaveFilters,
  deps: WaveDeps
): Promise<WaveResult> {
  const callsBefore = apiCallsUsed();
  const finish = (
    repos: WaveRepo[],
    partial: boolean,
    partialReason?: string
  ): WaveResult => {
    const queue: WaveIssue[] = [];
    for (const r of repos) {
      for (const i of r.issues) {
        if (i.verdict === "CLEAR" || i.verdict === "RISKY") queue.push(i);
      }
    }
    const tier: Record<WaveVerdict, number> = { CLEAR: 0, RISKY: 1, TAKEN: 2, ERROR: 3 };
    queue.sort((a, b) => (tier[a.verdict] ?? 9) - (tier[b.verdict] ?? 9));
    return {
      repos,
      queue,
      apiCalls: apiCallsUsed() - callsBefore,
      partial,
      partialReason,
      filters,
      candidatesConsidered: repos.length,
    };
  };

  const candidates = filterWaveRepos(index, filters);
  const rateLimited = (err: unknown): WaveResult | null =>
    err instanceof RateLimitError
      ? finish([], true, `rate limited: ${err.message}`)
      : null;

  try {
    if ((await deps.remainingBudget()) < filters.minBudget) {
      return finish(
        [],
        true,
        `core budget under the ${filters.minBudget} floor before the run started`
      );
    }
  } catch (err) {
    const partial = rateLimited(err);
    if (partial) return partial;
    throw err;
  }

  let login: string;
  let ownPrs: Set<string>;
  try {
    login = await deps.getLogin();
    ownPrs = await deps.ownOpenPrRepos(login);
  } catch (err) {
    const partial = rateLimited(err);
    if (partial) return partial;
    throw err;
  }
  const repos: WaveRepo[] = [];

  for (const entry of candidates) {
    try {
      if ((await deps.remainingBudget()) < filters.minBudget) {
        return finish(
          repos,
          true,
          `core budget fell under the ${filters.minBudget} floor at ${entry.repo}`
        );
      }
      const [owner, repoName] = entry.repo.split("/");
      const base: WaveRepo = {
        repo: entry.repo,
        url: entry.url ?? `https://github.com/${entry.repo}`,
        stars: entry.stars ?? 0,
        issues: [],
      };
      if (ownPrs.has(entry.repo.toLowerCase())) {
        repos.push({ ...base, excluded: "you already have an open PR here" });
        continue;
      }
      const starters = await deps.starterIssues(owner, repoName, filters.issuesPerRepo);
      if (starters.length === 0) {
        repos.push({ ...base, excluded: "no starter issues found via the label search" });
        continue;
      }
      const issues: WaveIssue[] = [];
      for (const s of starters) {
        const xr = await deps.xray(owner, repoName, s.number);
        const competingPRs = xr.linkedPRs
          .filter((p) => p.state === "open")
          .map((p) => ({ number: p.number, url: p.url, state: p.state }));
        issues.push({
          repo: entry.repo,
          number: s.number,
          title: s.title,
          url: s.url,
          verdict: mapXrayVerdict(xr.verdict),
          reasons: xr.reasons,
          flags: xr.flags,
          competingPRs,
          apiCalls: xr.apiCalls,
        });
      }
      const repoEntry: WaveRepo = { ...base, issues };
      const hasClear = issues.some((i) => i.verdict === "CLEAR");
      if (hasClear) {
        const gate = await deps.behavioral(owner, repoName);
        repoEntry.behavioralGate = gate;
        if (gate.detected) {
          repos.push({
            ...repoEntry,
            excluded: `behavioral gate: maintainer rejects AI-built PRs in practice (${gate.strength} signal${gate.strength === 1 ? "" : "s"})`,
            issues: [],
          });
          continue;
        }
      }
      repos.push(repoEntry);
    } catch (err) {
      if (err instanceof RateLimitError) {
        return finish(
          repos,
          true,
          `rate limited at ${entry.repo}: ${err.message}`
        );
      }
      throw err;
    }
  }
  return finish(repos, false);
}

/** Load the index from a URL or a local file path. */
export async function loadPolicyIndex(source: string): Promise<PolicyIndexEntry[]> {
  let raw: string;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`policy index fetch failed: ${res.status} ${source}`);
    raw = await res.text();
  } else {
    const { readFileSync } = await import("node:fs");
    raw = readFileSync(source, "utf8");
  }
  const data = JSON.parse(raw) as { entries?: PolicyIndexEntry[] };
  if (!Array.isArray(data.entries)) throw new Error("policy index has no entries array");
  // Normalize the friction verdict the index carries into the
  // winnability-ranking field (v0.16.2).
  for (const e of data.entries) {
    const score = (e as unknown as { greenlight_friction?: { score?: unknown } }).greenlight_friction?.score;
    e.friction_score = typeof score === "number" && Number.isFinite(score) ? score : null;
  }
  return data.entries;
}

/** The real deps: one shared search for the user's open PRs, xray reuse. */
export function liveWaveDeps(): WaveDeps {
  return {
    async getLogin() {
      const me = (await apiGet("/user")) as { login?: string };
      return String(me.login ?? "");
    },
    async ownOpenPrRepos(login: string) {
      const data = (await apiGet(
        `/search/issues?q=${encodeURIComponent(`author:${login} type:pr state:open`)}&per_page=100`
      )) as { items?: Array<{ repository_url?: string }> };
      const set = new Set<string>();
      for (const item of data.items ?? []) {
        const m = /\/repos\/([^/]+\/[^/]+)$/.exec(item.repository_url ?? "");
        if (m) set.add(m[1].toLowerCase());
      }
      return set;
    },
    starterIssues(owner: string, repo: string, limit: number) {
      return listStarterIssues(owner, repo, limit);
    },
    xray(owner: string, repo: string, number: number) {
      return xrayIssue(owner, repo, number);
    },
    behavioral(owner: string, repo: string) {
      return detectBehavioralGate(owner, repo);
    },
    async remainingBudget() {
      const data = (await apiGet("/rate_limit")) as {
        resources?: { core?: { remaining?: number } };
      };
      return data.resources?.core?.remaining ?? 0;
    },
  };
}

export function formatWaveHuman(result: WaveResult): string {
  const lines: string[] = [];
  lines.push(`wave queue: ${result.queue.length} issue(s) across ${result.repos.length} repos`);
  let n = 0;
  for (const i of result.queue) {
    n++;
    lines.push(`${n}. [${i.verdict}] ${i.repo}#${i.number}: ${i.title}`);
    lines.push(`   ${i.url}`);
    if (i.reasons[0]) lines.push(`   why: ${i.reasons[0]}`);
    if (i.competingPRs.length > 0) {
      lines.push(
        `   competing: ${i.competingPRs.map((p) => `#${p.number} (${p.state})`).join(", ")}`
      );
    }
  }
  for (const r of result.repos) {
    if (r.excluded) lines.push(`skip: ${r.repo} (${r.excluded})`);
  }
  if (result.partial) lines.push(`PARTIAL: ${result.partialReason}`);
  lines.push(`API calls used: ${result.apiCalls}`);
  return lines.join("\n");
}
