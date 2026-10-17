/**
 * Campaign scout mode (Greenlight v0.9.0): turn a list of repos into
 * ranked campaign targets. For each repo it runs the same per-issue
 * pipeline as check (legacy verdict + optional LLM layer + Claim
 * Protocol), drops every issue already in the campaign file in ANY
 * status, ranks the survivors, and (with --write) appends them as
 * SCOUTED with their verdict and evidence summary.
 *
 * A --budget caps total GitHub API calls; when it hits, the campaign
 * file keeps a resume cursor and the scout exits cleanly saying where
 * it stopped. A rerun resumes from the cursor.
 *
 * Ranking formula (also documented in `greenlight scout --help`):
 *
 *   score = 30 * verdictWeight
 *         + 0.25 * friction              (0..100, higher = easier)
 *         + 20 * outsideMergeShare       (0..1)
 *         + 15 / (1 + medianMergeDays / 14)
 *         + 5 * freshness                (1 / (1 + daysSinceUpdated / 30))
 *
 *   verdictWeight: GO = 2, RISKY = 1 (other verdicts never reach ranking).
 *
 * Everything network-shaped comes in on ScoutDeps, so fixtures prove
 * dedupe, ranking order, and budget stop + resume without touching the
 * API.
 */
import { apiGet, apiCallsUsed } from "./github.js";
import { checkIssueWithProtocol } from "./protocol-fetch.js";
import { fetchFrictionSummary } from "./friction.js";
import { fetchMergeVelocity, type MergeVelocityStats } from "./merge-velocity.js";
import type { FrictionReport } from "./types.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/* ------------------------------------------------------------------ */
/* Campaign file                                                       */
/* ------------------------------------------------------------------ */

/** One row of the campaign file. */
export interface CampaignEntry {
  repo: string; // "owner/repo"
  issue: number;
  status: string; // SCOUTED, CLAIMED, PR_OPEN, MERGED, DROPPED, ...
  pr?: string | null;
  /** Verdict at scout time. */
  verdict?: string;
  /** One-line evidence summary at scout time. */
  evidence?: string;
  scannedAt?: string;
}

export interface ScoutCursor {
  /** Index into the repo list where the next run should resume. */
  repoIndex: number;
}

export interface CampaignFile {
  entries: CampaignEntry[];
  cursor: ScoutCursor | null;
}

export function loadCampaignFile(path: string): CampaignFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CampaignFile>;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
      return {
        entries: parsed.entries as CampaignEntry[],
        cursor: parsed.cursor ?? null,
      };
    }
  } catch {
    // Missing or broken: start empty.
  }
  return { entries: [], cursor: null };
}

export function saveCampaignFile(path: string, campaign: CampaignFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(campaign, null, 2) + "\n", "utf8");
}

export function campaignExists(path: string): boolean {
  return existsSync(path);
}

/** True when the issue is already tracked in ANY status. */
export function campaignHas(campaign: CampaignFile, repo: string, issue: number): boolean {
  return campaign.entries.some(
    (e) => e.repo.toLowerCase() === repo.toLowerCase() && e.issue === issue
  );
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

const VERDICT_WEIGHT: Record<string, number> = { GO: 2, RISKY: 1 };

export interface ScoutCandidate {
  repo: string;
  number: number;
  title: string;
  url: string;
  verdict: "GO" | "RISKY";
  reasons: string[];
  flags: string[];
  updatedAt: string;
  friction: number;
  outsideMergeShare: number;
  medianMergeDays: number;
  /** Rank score: higher ranks first. */
  score: number;
}

/**
 * Pure ranking: the documented formula. Friction and velocity inputs are
 * per-repo (fetched once per repo); verdict strength and freshness are
 * per-issue.
 */
export function rankCandidates(
  candidates: Array<{
    repo: string;
    number: number;
    title: string;
    url: string;
    verdict: "GO" | "RISKY";
    reasons: string[];
    flags: string[];
    updatedAt: string;
  }>,
  repoSignals: { friction: number; outsideMergeShare: number; medianMergeDays: number },
  now: Date
): ScoutCandidate[] {
  const out: ScoutCandidate[] = [];
  for (const c of candidates) {
    const daysSinceUpdated = Math.max(
      0,
      (now.getTime() - new Date(c.updatedAt).getTime()) / 86400000
    );
    const freshness = 1 / (1 + daysSinceUpdated / 30);
    const score =
      30 * (VERDICT_WEIGHT[c.verdict] ?? 0) +
      0.25 * repoSignals.friction +
      20 * repoSignals.outsideMergeShare +
      15 / (1 + repoSignals.medianMergeDays / 14) +
      5 * freshness;
    out.push({
      ...c,
      friction: repoSignals.friction,
      outsideMergeShare: repoSignals.outsideMergeShare,
      medianMergeDays: repoSignals.medianMergeDays,
      score,
    });
  }
  out.sort((a, b) => b.score - a.score || a.number - b.number);
  return out;
}

/* ------------------------------------------------------------------ */
/* Scout run                                                           */
/* ------------------------------------------------------------------ */

export interface ScannedIssue {
  number: number;
  title: string;
  url: string;
  verdict: string;
  reasons: string[];
  flags: string[];
  updatedAt: string;
}

export interface ScoutDeps {
  /** List open issues for a repo (newest first). */
  listIssues?: (owner: string, repo: string, limit: number) => Promise<ScannedIssue[]>;
  /** The per-issue pipeline (defaults to the check pipeline). */
  scanIssue?: (owner: string, repo: string, number: number) => Promise<ScannedIssue>;
  friction?: (owner: string, repo: string) => Promise<FrictionReport>;
  velocity?: (owner: string, repo: string) => Promise<MergeVelocityStats | null>;
  /** How many API calls have been used so far. */
  budgetUsed?: () => number;
  now?: () => Date;
}

export interface ScoutOptions {
  repos: string[];
  campaignPath: string;
  budget: number;
  write: boolean;
  /** Issues scanned per repo. */
  scanLimit?: number;
  /** Survivors kept per repo. */
  keepPerRepo?: number;
  deps?: ScoutDeps;
  now?: Date;
}

export interface ScoutResult {
  /** Ranked survivors across all processed repos. */
  candidates: ScoutCandidate[];
  /** Entries appended to the campaign file this run. */
  appended: CampaignEntry[];
  /** True when the run stopped on the budget. */
  budgetHit: boolean;
  /** Where the run stopped (or null when every repo completed). */
  cursor: ScoutCursor | null;
  /** Repos fully processed this run. */
  reposProcessed: string[];
  /** Repos skipped because the cursor had passed them or the budget hit. */
  reposSkipped: string[];
  apiCallsUsed: number;
  markdown: string;
  json: Record<string, unknown>;
}

interface SearchIssueItem {
  number?: unknown;
  title?: unknown;
  html_url?: unknown;
  updated_at?: unknown;
}

async function defaultListIssues(owner: string, repo: string, limit: number): Promise<ScannedIssue[]> {
  const q = encodeURIComponent(`repo:${owner}/${repo} type:issue state:open sort:updated-desc`);
  const data = (await apiGet(`/search/issues?q=${q}&per_page=${limit}`)) as { items?: SearchIssueItem[] };
  return (data.items ?? []).map((i) => ({
    number: Number(i.number),
    title: String(i.title ?? ""),
    url: String(i.html_url ?? `https://github.com/${owner}/${repo}/issues/${i.number}`),
    verdict: "",
    reasons: [],
    flags: [],
    updatedAt: String(i.updated_at ?? new Date(0).toISOString()),
  }));
}

async function defaultScanIssue(owner: string, repo: string, number: number): Promise<ScannedIssue> {
  const { snapshot, merged } = await checkIssueWithProtocol(owner, repo, number, {});
  return {
    number,
    title: snapshot.title,
    url: snapshot.sourceUrl,
    verdict: merged.verdict,
    reasons: merged.reasons,
    flags: merged.flags,
    updatedAt: snapshot.updatedAt,
  };
}

function parseRepoRef(ref: string): { owner: string; repo: string } | null {
  const m = /^([^/]+)\/([^/]+)$/.exec(ref.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

export const SCOUT_DEFAULT_BUDGET = 300;
export const SCOUT_DEFAULT_SCAN_LIMIT = 10;
export const SCOUT_DEFAULT_KEEP_PER_REPO = 5;

export async function scoutCampaign(opts: ScoutOptions): Promise<ScoutResult> {
  const deps = opts.deps ?? {};
  const now = opts.now ?? new Date();
  const scanLimit = opts.scanLimit ?? SCOUT_DEFAULT_SCAN_LIMIT;
  const keepPerRepo = opts.keepPerRepo ?? SCOUT_DEFAULT_KEEP_PER_REPO;
  const budgetUsed = deps.budgetUsed ?? apiCallsUsed;
  const listIssues = deps.listIssues ?? defaultListIssues;
  const scanIssue = deps.scanIssue ?? defaultScanIssue;
  const friction = deps.friction ?? fetchFrictionSummary;
  const velocity = deps.velocity ?? fetchMergeVelocity;

  const campaign = loadCampaignFile(opts.campaignPath);
  const resumeAt = campaign.cursor?.repoIndex ?? 0;

  const candidates: ScoutCandidate[] = [];
  const appended: CampaignEntry[] = [];
  const reposProcessed: string[] = [];
  const reposSkipped: string[] = [];
  let budgetHit = false;
  let stoppedAt: number | null = null;

  for (let i = 0; i < opts.repos.length; i++) {
    if (i < resumeAt) {
      reposSkipped.push(opts.repos[i]);
      continue;
    }
    if (budgetUsed() >= opts.budget) {
      budgetHit = true;
      stoppedAt = i;
      reposSkipped.push(...opts.repos.slice(i));
      break;
    }
    const ref = parseRepoRef(opts.repos[i]);
    if (!ref) {
      reposSkipped.push(opts.repos[i]);
      continue;
    }
    const repoTag = `${ref.owner}/${ref.repo}`;
    const raw = await listIssues(ref.owner, ref.repo, scanLimit);
    const ranked: ScoutCandidate[] = [];
    // Fetch repo-level ranking inputs once per repo, in parallel with the
    // first issue's verdict only when needed: keep the budget check cheap
    // by doing friction/velocity up front (2 calls) then the issues.
    const [frictionReport, mergeVelocity] = await Promise.all([
      friction(ref.owner, ref.repo).catch(() => null),
      velocity(ref.owner, ref.repo).catch(() => null),
    ]);
    const repoSignals = {
      friction: frictionReport?.score ?? 50,
      outsideMergeShare: mergeVelocity?.externalShare ?? 0,
      medianMergeDays: mergeVelocity?.medianMergeDays ?? 14,
    };

    const issues: ScannedIssue[] = [];
    for (const item of raw) {
      if (budgetUsed() >= opts.budget) {
        budgetHit = true;
        break;
      }
      try {
        issues.push(await scanIssue(ref.owner, ref.repo, item.number));
      } catch {
        // One bad issue never kills the repo scan.
      }
    }
    if (budgetHit) {
      stoppedAt = i;
      reposSkipped.push(...opts.repos.slice(i + 1));
      // The survivors already found for this repo are kept in memory and
      // reported; the cursor restarts at this repo so the rerun rescans
      // it (the campaign dedupe keeps appended entries idempotent).
    }

    const survivors = issues.filter(
      (s) =>
        (s.verdict === "GO" || s.verdict === "RISKY") &&
        !campaignHas(campaign, repoTag, s.number) &&
        !appended.some((a) => a.repo.toLowerCase() === repoTag.toLowerCase() && a.issue === s.number)
    );
    const withRepo = survivors.map((s) => ({ ...s, repo: repoTag, verdict: s.verdict as "GO" | "RISKY" }));
    for (const c of rankCandidates(withRepo, repoSignals, now).slice(0, keepPerRepo)) {
      ranked.push(c);
    }
    candidates.push(...ranked);
    reposProcessed.push(repoTag);
  }

  candidates.sort((a, b) => b.score - a.score || a.number - b.number);

  const cursor: ScoutCursor | null = budgetHit && stoppedAt !== null ? { repoIndex: stoppedAt } : null;
  if (opts.write) {
    for (const c of candidates) {
      const evidence = c.reasons[0] ?? "";
      const entry: CampaignEntry = {
        repo: c.repo,
        issue: c.number,
        status: "SCOUTED",
        pr: null,
        verdict: c.verdict,
        evidence: evidence.length > 160 ? evidence.slice(0, 160) + "..." : evidence,
        scannedAt: now.toISOString(),
      };
      appended.push(entry);
      if (!campaignHas(campaign, c.repo, c.number)) campaign.entries.push(entry);
    }
    campaign.cursor = cursor;
    saveCampaignFile(opts.campaignPath, campaign);
  }

  const lines: string[] = [];
  lines.push(`**Campaign scout: ${candidates.length} survivors from ${reposProcessed.length} repos**${budgetHit ? ` — budget hit (${opts.budget} calls), stopped at repo ${stoppedAt !== null ? opts.repos[stoppedAt] : "?"}` : ""}`);
  if (budgetHit) lines.push(`_Resume cursor saved in the campaign file: rerun the same command to continue._`);
  lines.push("");
  for (const c of candidates) {
    lines.push(`- **${c.repo}#${c.number}** "${c.title.slice(0, 70)}" — ${c.verdict} (score ${c.score.toFixed(1)})`);
    lines.push(`  ${c.url}`);
  }
  if (candidates.length === 0) lines.push("_None._");
  lines.push("");
  lines.push(`_Scout v0.9.0; budget ${budgetUsed()} calls used of ${opts.budget}._`);

  return {
    candidates,
    appended,
    budgetHit,
    cursor,
    reposProcessed,
    reposSkipped,
    apiCallsUsed: budgetUsed(),
    markdown: lines.join("\n"),
    json: {
      candidates: candidates.map((c) => ({
        repo: c.repo,
        issue: c.number,
        title: c.title,
        url: c.url,
        verdict: c.verdict,
        score: c.score,
        friction: c.friction,
        outsideMergeShare: c.outsideMergeShare,
        medianMergeDays: c.medianMergeDays,
        reasons: c.reasons,
        flags: c.flags,
      })),
      appended: appended.length,
      budgetHit,
      cursor,
      reposProcessed,
      reposSkipped,
      apiCallsUsed: budgetUsed(),
    },
  };
}
