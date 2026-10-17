/**
 * The contributor passport. Reads the Claim Ledger's public API for the
 * account's protocol claims (held, completed, expired, queued, over-cap)
 * and the GitHub search API for merged PRs, and renders one honest page.
 *
 * If the Ledger has no file for the account, it says so plainly: a
 * passport starts with your first protocol claim.
 */
import { createRequire } from "node:module";
import { githubApiBase } from "./github.js";

const GREENLIGHT_VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
})();

export function ledgerBaseUrl(): string {
  const env = process.env["GREENLIGHT_LEDGER_URL"];
  return (env && env.trim().length > 0 ? env : "https://cloudcorprecords.github.io/claim-ledger").replace(/\/+$/, "");
}

export interface LedgerClaim {
  repo: string;
  issue: number;
  url: string;
  claimedAt: string;
  expiresAt: string;
  state: string;
  commentUrl: string | null;
}

export interface LedgerAccount {
  login: string;
  activeClaims: LedgerClaim[];
  queuedClaims: LedgerClaim[];
  completedCount: number | null;
  expiredCount: number | null;
  overCap: boolean | null;
}

export interface PassportDeps {
  /** Null means the Ledger has no file for this account (honest 404). */
  fetchAccount?: (login: string) => Promise<LedgerAccount | null>;
  /** Null means the lookup failed: reported as unknown, never zero. */
  fetchMergedCount?: (login: string) => Promise<number | null>;
  /**
   * Enrich one claim with the Ledger's per-issue status file
   * (v1/issues/<repo>/<n>/status.json), which carries the claim dates the
   * per-account file omits. Null means no enrichment: the claim renders
   * from the account file alone.
   */
  fetchClaimDetail?: (repo: string, issue: number) => Promise<{ claimedAt: string; expiresAt: string; commentUrl: string | null } | null>;
}

/**
 * Normalize a Ledger account payload defensively: the Ledger is our own
 * API and its fields can drift, so unknown shapes degrade to empties
 * rather than crashing. Whatever is normalized is stated as coming from
 * the Ledger; whatever is absent is stated as absent.
 */
export function normalizeAccount(login: string, raw: unknown): LedgerAccount {
  const empty: LedgerAccount = { login, activeClaims: [], queuedClaims: [], completedCount: null, expiredCount: null, overCap: null };
  if (!raw || typeof raw !== "object") return empty;
  const r = raw as Record<string, unknown>;
  const normClaim = (c: unknown): LedgerClaim | null => {
    if (!c || typeof c !== "object") return null;
    const o = c as Record<string, unknown>;
    const repo =
      typeof o["repo"] === "string"
        ? o["repo"]
        : typeof o["owner"] === "string" && typeof o["repo_name"] === "string"
          ? `${o["owner"]}/${o["repo_name"]}`
          : "unknown/unknown";
    const issue = typeof o["issue"] === "number" ? o["issue"] : typeof o["number"] === "number" ? o["number"] : 0;
    return {
      repo,
      issue,
      url:
        typeof o["url"] === "string" && o["url"]
          ? o["url"]
          : issue > 0 && repo !== "unknown/unknown"
            ? `https://github.com/${repo}/issues/${issue}`
            : "",
      claimedAt: typeof o["claimed_at"] === "string" ? o["claimed_at"] : typeof o["claimedAt"] === "string" ? o["claimedAt"] : "",
      expiresAt: typeof o["expires_at"] === "string" ? o["expires_at"] : typeof o["expiresAt"] === "string" ? o["expiresAt"] : "",
      state: typeof o["state"] === "string" ? o["state"] : "active",
      commentUrl: typeof o["comment_url"] === "string" ? o["comment_url"] : typeof o["commentUrl"] === "string" ? o["commentUrl"] : null,
    };
  };
  const arr = (v: unknown): LedgerClaim[] => (Array.isArray(v) ? v.map(normClaim).filter((c): c is LedgerClaim => c !== null) : []);
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  return {
    login,
    activeClaims: arr(r["active_claims"] ?? r["activeClaims"] ?? r["claims"]),
    queuedClaims: arr(r["queued_claims"] ?? r["queuedClaims"] ?? r["queue"]),
    completedCount: num(r["completed_count"] ?? r["completedClaims"]),
    expiredCount: num(r["expired_count"] ?? r["expiredClaims"]),
    overCap: bool(r["over_cap"] ?? r["overCap"]),
  };
}

async function defaultFetchAccount(login: string): Promise<LedgerAccount | null> {
  const url = `${ledgerBaseUrl()}/v1/accounts/${encodeURIComponent(login)}.json`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try {
    return normalizeAccount(login, await res.json());
  } catch {
    return null;
  }
}

async function defaultFetchClaimDetail(repo: string, issue: number): Promise<{ claimedAt: string; expiresAt: string; commentUrl: string | null } | null> {
  const url = `${ledgerBaseUrl()}/v1/issues/${repo}/${issue}/status.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { claim?: { claimed_at?: unknown; expires_at?: unknown; comment_url?: unknown } };
    const claim = data.claim;
    if (!claim || typeof claim !== "object") return null;
    return {
      claimedAt: typeof claim.claimed_at === "string" ? claim.claimed_at : "",
      expiresAt: typeof claim.expires_at === "string" ? claim.expires_at : "",
      commentUrl: typeof claim.comment_url === "string" ? claim.comment_url : null,
    };
  } catch {
    return null;
  }
}

async function defaultFetchMergedCount(login: string): Promise<number | null> {
  const q = encodeURIComponent(`author:${login} type:pr is:merged`);
  try {
    const res = await fetch(`${githubApiBase()}/search/issues?q=${q}&per_page=1`, {
      headers: { "User-Agent": "greenlight", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { total_count?: unknown };
    return typeof data.total_count === "number" ? data.total_count : null;
  } catch {
    return null;
  }
}

export interface Passport {
  login: string;
  found: boolean;
  account: LedgerAccount | null;
  mergedPrs: number | null;
  honorRatio: string;
  markdown: string;
  json: Record<string, unknown>;
}

function claimLine(c: LedgerClaim): string {
  const dates = [c.claimedAt.slice(0, 10), c.expiresAt.slice(0, 10)].filter((d) => d.length > 0).join(" -> ");
  return `${c.repo}#${c.issue} (${c.state}${dates ? `, ${dates}` : ""}) ${c.commentUrl ? c.commentUrl : c.url}`;
}

export async function buildPassport(login: string, deps: PassportDeps = {}, now: Date = new Date()): Promise<Passport> {
  const fetchAccount = deps.fetchAccount ?? defaultFetchAccount;
  const fetchMergedCount = deps.fetchMergedCount ?? defaultFetchMergedCount;
  const fetchClaimDetail = deps.fetchClaimDetail ?? defaultFetchClaimDetail;
  const account = await fetchAccount(login).catch(() => null);
  const mergedPrs = await fetchMergedCount(login).catch(() => null);

  if (!account) {
    const markdown = [
      `# Contributor passport: @${login}`,
      "",
      "No passport file for this account in the Claim Ledger yet.",
      "",
      "Your passport starts with your first protocol claim: claim an issue with the Greenlight protocol marker " +
        "(`greenlight claim` drafts it for you) and the Ledger indexes it within 15 minutes.",
      "",
      `Ledger: ${ledgerBaseUrl()}. Merged PRs on GitHub: ${mergedPrs === null ? "unknown (lookup failed)" : mergedPrs}.`,
      "",
      `_Passport generated by Greenlight v${GREENLIGHT_VERSION}._`,
    ].join("\n");
    return {
      login,
      found: false,
      account: null,
      mergedPrs,
      honorRatio: "no ledger history",
      markdown,
      json: { login, found: false, mergedPrs, ledger: ledgerBaseUrl() },
    };
  }

  // Enrich claims with dates from the per-issue status files. Each
  // enrichment is independent and best-effort: a missing file leaves the
  // claim exactly as the account file described it.
  const enrich = async (claims: LedgerClaim[]): Promise<LedgerClaim[]> =>
    Promise.all(
      claims.map(async (c) => {
        if (c.issue <= 0) return c;
        const detail = await fetchClaimDetail(c.repo, c.issue).catch(() => null);
        if (!detail) return c;
        return {
          ...c,
          claimedAt: c.claimedAt || detail.claimedAt,
          expiresAt: c.expiresAt || detail.expiresAt,
          commentUrl: c.commentUrl ?? detail.commentUrl,
        };
      })
    );
  account.activeClaims = await enrich(account.activeClaims);
  account.queuedClaims = await enrich(account.queuedClaims);

  const completed = account.completedCount ?? account.activeClaims.filter((c) => c.state === "completed").length;
  const expired = account.expiredCount ?? account.activeClaims.filter((c) => c.state === "expired").length;
  const historyKnown = account.completedCount !== null || account.expiredCount !== null || account.activeClaims.some((c) => c.state === "completed" || c.state === "expired");
  const honorRatio =
    !historyKnown || completed + expired === 0
      ? "no completed/expired history in the ledger yet"
      : `${completed} completed vs ${expired} expired (${Math.round((completed / (completed + expired)) * 100)}% completed)`;

  const lines: string[] = [];
  lines.push(`# Contributor passport: @${login}`);
  lines.push("");
  lines.push("## Claim Protocol record");
  lines.push(`Active protocol claims: ${account.activeClaims.length}`);
  for (const c of account.activeClaims) lines.push(`- ${claimLine(c)}`);
  lines.push(`Queued behind others: ${account.queuedClaims.length}`);
  for (const c of account.queuedClaims) lines.push(`- ${claimLine(c)}`);
  lines.push(`Claim honor record: ${honorRatio}`);
  lines.push(
    `Over the active-claim cap: ${account.overCap === null ? "not reported by the ledger" : account.overCap ? "yes (squatting flag)" : "no"}`
  );
  lines.push("");
  lines.push("## GitHub record");
  lines.push(`Merged PRs: ${mergedPrs === null ? "unknown (lookup failed)" : mergedPrs}`);
  lines.push("");
  lines.push(`Ledger: ${ledgerBaseUrl()}. Checked ${now.toISOString().slice(0, 10)}.`);
  lines.push(`_Passport generated by Greenlight v${GREENLIGHT_VERSION}._`);

  return {
    login,
    found: true,
    account,
    mergedPrs,
    honorRatio,
    markdown: lines.join("\n"),
    json: {
      login,
      found: true,
      ledger: ledgerBaseUrl(),
      activeClaims: account.activeClaims,
      queuedClaims: account.queuedClaims,
      honorRatio,
      overCap: account.overCap,
      mergedPrs,
    },
  };
}
