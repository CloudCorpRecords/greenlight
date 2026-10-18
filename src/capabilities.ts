/**
 * Capability ledger (Greenlight v0.10.1): per-repo recorded interaction
 * outcomes, so the tool remembers what the account can actually do in a
 * repo instead of re-learning it the expensive way.
 *
 * Field lesson 2026-10-18: actualbudget/actual blocked PR creation
 * (422 "user is blocked") and modelcontextprotocol/typescript-sdk 404'd
 * it despite a valid fork. Both were discovered only after full builds
 * were done. Had the first failure been recorded, scout would have
 * skipped the repo and preflight would have said no before any build
 * started. This file is that memory: ~/.greenlight/capabilities.json.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

/** Write operations the ledger tracks. pr_create is the POST /pulls outcome; claim is the claim-comment outcome. */
export type CapabilityAction = "pr_create" | "claim";

/**
 * Recorded outcome of one interaction. The blocked-* family is
 * structural (the repo or account will say no again); failed-other is
 * transient or unknown and does not drive exclusion.
 */
export type CapabilityOutcome =
  | "ok"
  | "blocked-404"
  | "blocked-422"
  | "blocked-403"
  | "failed-other";

export interface CapabilityEntry {
  /** "owner/repo", lowercased on write. */
  repo: string;
  action: CapabilityAction;
  outcome: CapabilityOutcome;
  /** Short evidence string: what happened, with the signal that proved it. */
  evidence: string;
  /** ISO timestamp of the observation. */
  at: string;
}

export interface CapabilitiesFile {
  entries: CapabilityEntry[];
}

/**
 * Ledger path. GREENLIGHT_CAPABILITIES_PATH overrides it (tests and
 * agents that keep their own ledger); otherwise
 * ~/.greenlight/capabilities.json.
 */
export function defaultCapabilitiesPath(): string {
  const env = process.env.GREENLIGHT_CAPABILITIES_PATH;
  if (env && env.trim().length > 0) return env.trim();
  return join(homedir(), ".greenlight", "capabilities.json");
}

/** Load the ledger; a missing or corrupt file reads as empty, never throws. */
export function loadCapabilities(path: string = defaultCapabilitiesPath()): CapabilitiesFile {
  try {
    if (!existsSync(path)) return { entries: [] };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CapabilitiesFile>;
    if (parsed && Array.isArray(parsed.entries)) {
      const entries = (parsed.entries as Partial<CapabilityEntry>[])
        .filter((e) => e && typeof e.repo === "string" && typeof e.action === "string")
        .map((e) => ({
          repo: String(e.repo).toLowerCase(),
          action: e.action as CapabilityAction,
          outcome: (e.outcome ?? "failed-other") as CapabilityOutcome,
          evidence: String(e.evidence ?? ""),
          at: String(e.at ?? ""),
        }));
      return { entries };
    }
  } catch {
    // Corrupt ledger: start empty rather than crash the command.
  }
  return { entries: [] };
}

function saveCapabilities(path: string, file: CapabilitiesFile): void {
  try {
    mkdirSync(dirnameOf(path), { recursive: true });
  } catch {
    // best effort
  }
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", "utf8");
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : ".";
}

/**
 * Append one observation. Returns the recorded entry. Never throws on
 * filesystem trouble: a ledger that cannot be written is a missed
 * memory, not a failed command.
 */
export function recordCapability(
  repo: string,
  action: CapabilityAction,
  outcome: CapabilityOutcome,
  evidence: string,
  path: string = defaultCapabilitiesPath(),
  at: string = new Date().toISOString()
): CapabilityEntry {
  const entry: CapabilityEntry = {
    repo: repo.toLowerCase(),
    action,
    outcome,
    evidence: evidence.slice(0, 280),
    at,
  };
  try {
    const file = loadCapabilities(path);
    file.entries.push(entry);
    saveCapabilities(path, file);
  } catch {
    // best effort
  }
  return entry;
}

/** The most recent observation for a repo+action, or undefined when the tool has never tried. */
export function latestCapability(
  file: CapabilitiesFile,
  repo: string,
  action: CapabilityAction
): CapabilityEntry | undefined {
  const key = repo.toLowerCase();
  let best: CapabilityEntry | undefined;
  for (const e of file.entries) {
    // Case-insensitive even for hand-edited files that bypass the
    // write-path normalization.
    if (String(e.repo).toLowerCase() !== key || e.action !== action) continue;
    if (!best || e.at >= best.at) best = e;
  }
  return best;
}

/** Structural blocks are the outcomes that drive exclusion and NO-GO verdicts. */
export function isBlockedOutcome(outcome: CapabilityOutcome): boolean {
  return outcome === "blocked-404" || outcome === "blocked-422" || outcome === "blocked-403";
}

/**
 * The recorded reason a repo cannot take PRs from this account, or
 * undefined when the ledger holds no structural block. Scout and
 * preflight read this; it is why the F2 repos never get built for
 * again.
 */
export function prCreateBlockReason(file: CapabilitiesFile, repo: string): string | undefined {
  const latest = latestCapability(file, repo, "pr_create");
  if (latest && isBlockedOutcome(latest.outcome)) {
    return `pr_create ${latest.outcome} (${latest.at}): ${latest.evidence}`;
  }
  return undefined;
}

/**
 * Map a write-path error to a ledger outcome. Returns undefined for
 * transient account state (rate limits) that says nothing about the
 * repo; callers skip recording those.
 */
export function capabilityOutcomeForError(err: unknown): CapabilityOutcome | undefined {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/rate limit|rate_limit|429/.test(msg)) return undefined;
  if (/403|blocked/.test(msg)) return "blocked-403";
  if (/404|not found/.test(msg)) return "blocked-404";
  if (/422|validation failed/.test(msg)) return "blocked-422";
  return "failed-other";
}
