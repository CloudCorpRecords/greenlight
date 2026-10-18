/**
 * `greenlight portfolio`: one-screen campaign summary (v0.10.0).
 *
 * Multi-agent field lesson 2026-10-18: with several agents opening PRs
 * in parallel, nobody holds the whole board in their head. `portfolio`
 * combines the API census (open/merged/closed), claims by state, the
 * pending posting queue, and the sync drift count into one screen, as
 * human text or --json. READS ONLY: it never posts or claims.
 */
import {
  defaultRegistryPath,
  loadRegistry,
  type ClaimsRegistryFile,
} from "./claims-registry.js";
import {
  defaultLedgerPath,
  readLedger,
  type PostingLedger,
} from "./posting-ledger.js";
import {
  computeDrift,
  fetchAuthorCensus,
  type CensusPr,
  type SyncDrift,
} from "./sync.js";

export interface ClaimBuckets {
  /** Claims with a linked PR URL. */
  linked: number;
  /** No PR, older than the stale window. */
  unlinkedStale: number;
  /** The rest: recent, unlinked, still in play. */
  active: number;
}

export interface PendingQueue {
  /** Ledger entries that never got a confirmed outcome. */
  unconfirmedPosts: Array<{ ts: string; kind: string; targetUrl: string; agent?: string }>;
  /** Claims with no linked PR (built work that may not be posted). */
  unlinkedClaims: Array<{ issueUrl: string; postedAt: string }>;
}

export interface Portfolio {
  author: string;
  census: { total: number; open: number; merged: number; closedUnmerged: number };
  claims: ClaimBuckets & { total: number };
  knownPrs: number;
  pending: PendingQueue;
  drift: { total: number; unknownPrs: number; stateMismatches: number; staleClaims: number };
}

export function bucketClaims(claims: ClaimsRegistryFile["claims"], staleDays: number, nowMs: number): ClaimBuckets {
  const out: ClaimBuckets = { linked: 0, unlinkedStale: 0, active: 0 };
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  for (const c of claims) {
    if (c.prUrl) {
      out.linked++;
      continue;
    }
    const age = nowMs - Date.parse(c.postedAt);
    if (Number.isFinite(age) && age >= staleMs) out.unlinkedStale++;
    else out.active++;
  }
  return out;
}

export function pendingQueue(registry: ClaimsRegistryFile, ledger: PostingLedger): PendingQueue {
  return {
    unconfirmedPosts: ledger.entries
      .filter((e) => e.outcome === "unconfirmed")
      .map((e) => ({ ts: e.ts, kind: e.kind, targetUrl: e.targetUrl, agent: e.agent })),
    unlinkedClaims: registry.claims
      .filter((c) => !c.prUrl)
      .map((c) => ({ issueUrl: c.issueUrl, postedAt: c.postedAt })),
  };
}

export function buildPortfolio(args: {
  author: string;
  census: CensusPr[];
  registry: ClaimsRegistryFile;
  ledger: PostingLedger;
  drift: SyncDrift;
  staleDays: number;
  nowMs: number;
}): Portfolio {
  const { census, registry, drift, staleDays, nowMs, author } = args;
  const claims = bucketClaims(registry.claims, staleDays, nowMs);
  return {
    author,
    census: {
      total: census.length,
      open: census.filter((c) => c.state === "open").length,
      merged: census.filter((c) => c.merged).length,
      closedUnmerged: census.filter((c) => c.state === "closed" && !c.merged).length,
    },
    claims: { ...claims, total: registry.claims.length },
    knownPrs: registry.prs?.length ?? 0,
    pending: pendingQueue(registry, args.ledger),
    drift: {
      total:
        drift.unknownPrs.length + drift.stateMismatches.length + drift.staleClaims.length,
      unknownPrs: drift.unknownPrs.length,
      stateMismatches: drift.stateMismatches.length,
      staleClaims: drift.staleClaims.length,
    },
  };
}

/** Human one-screen summary: counts first, then the items that need action. */
export function formatPortfolioHuman(p: Portfolio): string {
  const lines: string[] = [];
  lines.push(`**portfolio: ${p.author}**`);
  lines.push(
    `PRs: ${p.census.total} total (${p.census.open} open, ${p.census.merged} merged, ${p.census.closedUnmerged} closed unmerged)`
  );
  lines.push(
    `Claims: ${p.claims.total} total (${p.claims.linked} linked, ${p.claims.active} active, ${p.claims.unlinkedStale} unlinked-stale)`
  );
  lines.push(`Known PRs in registry: ${p.knownPrs}`);
  lines.push(`Drift: ${p.drift.total} item${p.drift.total === 1 ? "" : "s"} (${p.drift.unknownPrs} unknown PRs, ${p.drift.stateMismatches} state mismatches, ${p.drift.staleClaims} stale claims)`);
  lines.push("");
  const unconfirmed = p.pending.unconfirmedPosts;
  lines.push(`## Pending posts (${unconfirmed.length})`);
  if (unconfirmed.length === 0) lines.push("_None._");
  else
    for (const u of unconfirmed.slice(0, 10)) {
      lines.push(`- ${u.kind} ${u.targetUrl} (${u.ts}${u.agent ? `, agent ${u.agent}` : ""})`);
    }
  if (unconfirmed.length > 10) lines.push(`_... and ${unconfirmed.length - 10} more._`);
  lines.push("");
  const unlinked = p.pending.unlinkedClaims;
  lines.push(`## Unlinked claims (${unlinked.length})`);
  if (unlinked.length === 0) lines.push("_None._");
  else
    for (const u of unlinked.slice(0, 10)) {
      lines.push(`- ${u.issueUrl} (claimed ${u.postedAt})`);
    }
  if (unlinked.length > 10) lines.push(`_... and ${unlinked.length - 10} more._`);
  return lines.join("\n");
}

export function portfolioJson(p: Portfolio): Record<string, unknown> {
  return { portfolio: p };
}

export interface PortfolioRunOptions {
  author: string;
  staleDays?: number;
  registryPath?: string;
  ledgerPath?: string;
  nowMs?: number;
}

/** Full portfolio run: census, registry, ledger, drift, one Portfolio. */
export async function runPortfolio(opts: PortfolioRunOptions): Promise<Portfolio> {
  const registryPath = opts.registryPath ?? defaultRegistryPath();
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath();
  const nowMs = opts.nowMs ?? Date.now();
  const staleDays = opts.staleDays ?? 7;
  const census = await fetchAuthorCensus(opts.author);
  const registry = loadRegistry(registryPath);
  const ledger = readLedger(ledgerPath);
  const drift = computeDrift(census, registry, null, staleDays, nowMs);
  return buildPortfolio({ author: opts.author, census, registry, ledger, drift, staleDays, nowMs });
}
