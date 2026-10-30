/**
 * v0.24.0: INDEX DRIFT signal.
 *
 * The published Agent Policy Index (policy.json on GitHub Pages) is a
 * dated snapshot: entries carry the date their policy evidence was read,
 * and repos change their policies after that date. The 2026-10-29 drift
 * audit found gleam-lang/gleam indexed as open eleven days after its
 * CONTRIBUTING.md gained "We do not accept contributions from AI
 * agents." When check or xray runs on a repo that exists in the index,
 * this module compares the classes implied by the live gate read against
 * the index entry and, on disagreement, produces a warning naming both
 * class sets and the index entry's evidence date. The live read always
 * wins; the warning exists so nobody plans work off a stale snapshot.
 *
 * The index is fetched once per process and cached on disk for six
 * hours (~/.greenlight/policy-index-cache.json). Every failure mode
 * (offline, index down, repo absent) returns null: drift is a signal,
 * never a blocker.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Gate } from "./types.js";

export const POLICY_INDEX_URL =
  "https://cloudcorprecords.github.io/greenlight/policy.json";
const CACHE_TTL_MS = 6 * 3600 * 1000;

export interface IndexEntry {
  repo: string;
  policy_classes: string[];
  verified_on?: string | null;
  scanned_on?: string | null;
}

export interface IndexDrift {
  repo: string;
  indexClasses: string[];
  liveClasses: string[];
  indexVerifiedOn: string | null;
  warning: string;
}

/** Greenlight gate kinds in Agent Policy Index class vocabulary. */
export const GATE_TO_INDEX_CLASS: Record<string, string> = {
  agents_banned: "agents-banned",
  agents_disclosure: "agents-disclosure",
  collaborators_only: "collaborators-only",
  unsolicited_prs_paused: "paused",
  external_prs_closed: "paused",
  scoped_prs_paused: "paused",
  assignment_required: "assignment-gated",
  claim_first: "claim-first",
  cla_required: "cla-required",
  dco_required: "dco-required",
  discussion_first: "discussion-first",
  vouch_required: "vouch-required",
  stale_bot: "bot-gated",
};

const DOOR_CLASSES = new Set([
  "agents-banned",
  "paused",
  "collaborators-only",
  "maintainer-only",
]);

/** The index classes a live gate set implies (open when nothing bites). */
export function liveIndexClasses(gates: Gate[]): string[] {
  const set = new Set<string>();
  for (const g of gates) {
    if (g.detected && GATE_TO_INDEX_CLASS[g.kind]) {
      set.add(GATE_TO_INDEX_CLASS[g.kind]);
    }
  }
  return set.size ? [...set].sort() : ["open"];
}

/**
 * Pure comparison. Drift when a live class is missing from the index,
 * when the door-closed state disagrees, or when the open state
 * disagrees. Extra non-door classes recorded in the index (from human
 * verification the tool cannot see) do not count as drift on their own.
 */
export function compareIndexDrift(
  entry: IndexEntry,
  gates: Gate[]
): IndexDrift | null {
  const live = liveIndexClasses(gates);
  const idx = [...(entry.policy_classes ?? [])].sort();
  const liveSet = new Set(live);
  const idxSet = new Set(idx);
  const missing = live.filter((c) => !idxSet.has(c));
  const doorMismatch = [...DOOR_CLASSES].some(
    (c) => idxSet.has(c) !== liveSet.has(c)
  );
  const openMismatch = idxSet.has("open") !== liveSet.has("open");
  if (missing.length === 0 && !doorMismatch && !openMismatch) return null;
  const date = entry.verified_on ?? entry.scanned_on ?? null;
  return {
    repo: entry.repo,
    indexClasses: idx,
    liveClasses: live,
    indexVerifiedOn: date,
    warning:
      `INDEX DRIFT: live read classes [${live.join(", ")}] differ from ` +
      `the published index [${idx.join(", ")}] (index evidence dated ` +
      `${date ?? "unknown"}); the index entry is stale, trust the live read`,
  };
}

interface IndexDoc {
  entries?: IndexEntry[];
}

let memCache: { at: number; doc: IndexDoc } | null = null;

function cacheFile(): string {
  return path.join(os.homedir(), ".greenlight", "policy-index-cache.json");
}

export async function fetchPolicyIndex(): Promise<IndexDoc | null> {
  if (memCache && Date.now() - memCache.at < CACHE_TTL_MS) return memCache.doc;
  try {
    const raw = JSON.parse(await fs.readFile(cacheFile(), "utf8")) as {
      fetched_at: number;
      doc: IndexDoc;
    };
    if (Date.now() - raw.fetched_at < CACHE_TTL_MS && raw.doc) {
      memCache = { at: raw.fetched_at, doc: raw.doc };
      return raw.doc;
    }
  } catch {
    /* no usable disk cache */
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(POLICY_INDEX_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const doc = (await res.json()) as IndexDoc;
    memCache = { at: Date.now(), doc };
    try {
      await fs.mkdir(path.dirname(cacheFile()), { recursive: true });
      await fs.writeFile(
        cacheFile(),
        JSON.stringify({ fetched_at: Date.now(), doc })
      );
    } catch {
      /* cache write is best-effort */
    }
    return doc;
  } catch {
    return null;
  }
}

export async function findIndexEntry(
  owner: string,
  repo: string
): Promise<IndexEntry | null> {
  const doc = await fetchPolicyIndex();
  const want = `${owner}/${repo}`.toLowerCase();
  return doc?.entries?.find((e) => e.repo.toLowerCase() === want) ?? null;
}

/** Drift for one repo, or null when unindexed, in agreement, or unreadable. */
export async function indexDriftFor(
  owner: string,
  repo: string,
  gates: Gate[]
): Promise<IndexDrift | null> {
  try {
    const entry = await findIndexEntry(owner, repo);
    if (!entry) return null;
    return compareIndexDrift(entry, gates);
  } catch {
    return null;
  }
}
