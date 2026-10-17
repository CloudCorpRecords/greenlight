/**
 * `greenlight claim --import`: backfill the my-claims registry for claims
 * that already exist. v0.9.0's registry auto-registers only newly posted
 * claims, so anyone upgrading arrives with an empty registry while the
 * public Claim Ledger already knows about their claims (field case: Rene
 * held 11 live claims and the babysitter said "no claims registry yet").
 *
 * Two sources:
 *   --ledger-user <github-username>  fetch the public Claim Ledger's
 *     static API and import every active or linked claim by that user.
 *   --urls <issue-url,...>           import a manual list of issue URLs.
 *
 * Registration reuses registerClaim, so re-imports refresh rather than
 * duplicate. States completed/released/expired/superseded are skipped:
 * the babysitter would retire them on sight anyway.
 */
import { registerClaim, loadRegistry, type MyClaim } from "./claims-registry.js";
import { parseIssueUrl } from "./github.js";

/** The public Claim Ledger's static API base (no auth). */
export const LEDGER_BASE_URL = "https://cloudcorprecords.github.io/claim-ledger";

/** Claim states worth watching: active leases and linked claims. Retired states are skipped. */
export const IMPORTABLE_CLAIM_STATES = new Set(["active", "linked"]);

export interface LedgerIndexRepo {
  owner: string;
  repo: string;
}

export interface LedgerClaimEntry {
  issue: number;
  issue_url: string;
  claimant: string;
  state: string;
  queue: unknown[];
}

export interface ImportDeps {
  /** JSON GET, injectable for tests; the default hits the Ledger pages site. */
  fetchJson?: (url: string) => Promise<unknown>;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "greenlight-cli" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Ledger request failed: ${url} -> HTTP ${res.status}`);
  return res.json();
}

export async function fetchLedgerRepos(deps: ImportDeps = {}): Promise<LedgerIndexRepo[]> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const index = (await fetchJson(`${LEDGER_BASE_URL}/v1/index.json`)) as {
    repos?: Array<{ owner?: unknown; repo?: unknown }>;
  };
  const repos: LedgerIndexRepo[] = [];
  for (const r of index.repos ?? []) {
    if (typeof r.owner === "string" && typeof r.repo === "string") {
      repos.push({ owner: r.owner, repo: r.repo });
    }
  }
  return repos;
}

export async function fetchLedgerClaims(owner: string, repo: string, deps: ImportDeps = {}): Promise<LedgerClaimEntry[]> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const body = (await fetchJson(`${LEDGER_BASE_URL}/v1/repos/${owner}/${repo}/claims.json`)) as {
    active_claims?: Array<{ issue?: unknown; issue_url?: unknown; claimant?: unknown; state?: unknown; queue?: unknown }>;
  };
  const out: LedgerClaimEntry[] = [];
  for (const c of body.active_claims ?? []) {
    if (typeof c.issue !== "number" || typeof c.issue_url !== "string" || typeof c.claimant !== "string" || typeof c.state !== "string") {
      continue;
    }
    out.push({
      issue: c.issue,
      issue_url: c.issue_url,
      claimant: c.claimant,
      state: c.state,
      queue: Array.isArray(c.queue) ? c.queue : [],
    });
  }
  return out;
}

export interface ImportResult {
  /** Claims newly added to the registry. */
  added: number;
  /** Claims skipped: already registered, wrong claimant, or a retired state. */
  skipped: number;
  /** Repos scanned on the Ledger. */
  reposScanned: number;
  /** The registered entries, in registration order. */
  claims: MyClaim[];
}

/**
 * Import every active or linked Ledger claim held by `username` into the
 * registry. Pure of side effects except the registry file write.
 */
export async function importLedgerClaims(
  registryPath: string,
  username: string,
  deps: ImportDeps = {}
): Promise<ImportResult> {
  const user = username.toLowerCase();
  const repos = await fetchLedgerRepos(deps);
  const added: MyClaim[] = [];
  let skipped = 0;
  for (const { owner, repo } of repos) {
    let entries: LedgerClaimEntry[];
    try {
      entries = await fetchLedgerClaims(owner, repo, deps);
    } catch {
      // One repo's file failing must not abort the whole import.
      continue;
    }
    for (const e of entries) {
      if (e.claimant.toLowerCase() !== user) {
        skipped++;
        continue;
      }
      if (!IMPORTABLE_CLAIM_STATES.has(e.state)) {
        skipped++;
        continue;
      }
      let issueOwner = owner;
      let issueRepo = repo;
      let issueNumber = e.issue;
      let issueUrl = e.issue_url;
      try {
        const parsed = parseIssueUrl(e.issue_url);
        issueOwner = parsed.owner;
        issueRepo = parsed.repo;
        issueNumber = parsed.number;
      } catch {
        // The Ledger's own issue_url is canonical enough; keep the row's.
      }
      const key = issueUrl.toLowerCase();
      const already = loadRegistry(registryPath).claims.some((c) => c.issueUrl.toLowerCase() === key);
      if (already) {
        skipped++;
        continue;
      }
      const entry = {
        issueUrl,
        owner: issueOwner,
        repo: issueRepo,
        number: issueNumber,
        postedAt: new Date().toISOString(),
        claimant: e.claimant,
      };
      registerClaim(registryPath, entry);
      added.push(entry);
    }
  }
  return { added: added.length, skipped, reposScanned: repos.length, claims: added };
}

/**
 * Import a manual list of issue URLs (backfill for claims posted before
 * the registry existed, or on repos the Ledger does not index). Never
 * touches the network: pure registration with dedupe.
 */
export function importUrlList(registryPath: string, urls: string[]): ImportResult {
  const added: MyClaim[] = [];
  let skipped = 0;
  for (const raw of urls) {
    const url = raw.trim();
    if (!url) {
      skipped++;
      continue;
    }
    let owner: string;
    let repo: string;
    let number: number;
    try {
      ({ owner, repo, number } = parseIssueUrl(url));
    } catch {
      skipped++;
      continue;
    }
    const canonical = `https://github.com/${owner}/${repo}/issues/${number}`;
    const key = canonical.toLowerCase();
    const already = loadRegistry(registryPath).claims.some((c) => c.issueUrl.toLowerCase() === key);
    if (already) {
      skipped++;
      continue;
    }
    const entry = {
      issueUrl: canonical,
      owner,
      repo,
      number,
      postedAt: new Date().toISOString(),
    };
    registerClaim(registryPath, entry);
    added.push(entry);
  }
  return { added: added.length, skipped, reposScanned: 0, claims: added };
}
