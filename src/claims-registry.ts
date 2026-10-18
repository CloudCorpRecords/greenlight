/**
 * My-claims registry (Greenlight v0.9.0): the campaign's memory of which
 * issues the operator personally claimed. Written by `greenlight claim`
 * when a claim comment actually posts (and by `greenlight claim
 * --register <issue-url>` for claims posted any other way), read by the
 * babysitter's claims section.
 *
 * The registry lives at ~/.greenlight/my-claims.json (override with
 * GREENLIGHT_CLAIMS_FILE) and is a plain JSON array: easy to read,
 * hand-edit, and carry between machines. A claim leaves the registry
 * when it resolves (merged PR, closed issue, released claim) or when
 * the operator removes it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One claim the operator posted or registered. */
export interface MyClaim {
  /** Canonical issue URL, e.g. https://github.com/o/r/issues/65. */
  issueUrl: string;
  owner: string;
  repo: string;
  number: number;
  /** ISO timestamp the claim comment was posted (or the claim registered). */
  postedAt: string;
  /** Days the operator promised to deliver, from --eta-days. */
  etaDays?: number;
  /** GitHub user who posted the claim comment; null when unknown. */
  claimant?: string | null;
  /** URL of the claim comment posted by the claim command. */
  commentUrl?: string;
  /** Known PR URL, set when the claim links to one. */
  prUrl?: string;
}

/** One PR the account is known to have authored, keyed by PR URL (v0.10.0). */
export interface KnownPr {
  prUrl: string;
  owner: string;
  repo: string;
  number: number;
  state: "open" | "closed";
  merged: boolean;
  title: string;
  /** ISO: first census that saw it. */
  firstSeen: string;
  /** ISO: most recent census that saw it. */
  lastSeen: string;
  source: "census";
}

export interface ClaimsRegistryFile {
  version: 1;
  claims: MyClaim[];
  /**
   * PRs the account is known to have authored. Populated by
   * `greenlight sync --write` from the API census. Lets other agents'
   * PRs show up in local tracking without anyone hand editing the file.
   */
  prs?: KnownPr[];
}

/** Override path for tests and scratch registries. */
export function defaultRegistryPath(): string {
  return process.env.GREENLIGHT_CLAIMS_FILE ?? join(homedir(), ".greenlight", "my-claims.json");
}

export function loadRegistry(path: string): ClaimsRegistryFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ClaimsRegistryFile>;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.claims)) {
      const prs = Array.isArray(parsed.prs) ? (parsed.prs as KnownPr[]) : undefined;
      return {
        version: 1,
        claims: parsed.claims as MyClaim[],
        ...(prs ? { prs } : {}),
      };
    }
  } catch {
    // Missing or broken registry: start empty rather than crash the
    // babysitter.
  }
  return { version: 1, claims: [] };
}

export function saveRegistry(path: string, registry: ClaimsRegistryFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

/**
 * Add a claim to the registry (deduped by issue URL; a re-register of
 * the same issue refreshes the entry). Returns the new registry.
 */
export function registerClaim(path: string, entry: MyClaim): ClaimsRegistryFile {
  const registry = loadRegistry(path);
  const key = entry.issueUrl.toLowerCase();
  const idx = registry.claims.findIndex((c) => c.issueUrl.toLowerCase() === key);
  if (idx >= 0) {
    registry.claims[idx] = { ...registry.claims[idx], ...entry };
  } else {
    registry.claims.push(entry);
  }
  saveRegistry(path, registry);
  return registry;
}

/** Remove a claim by issue URL; returns true when one was removed. */
export function removeClaim(path: string, issueUrl: string): boolean {
  const registry = loadRegistry(path);
  const before = registry.claims.length;
  const key = issueUrl.toLowerCase();
  registry.claims = registry.claims.filter((c) => c.issueUrl.toLowerCase() !== key);
  if (registry.claims.length !== before) {
    saveRegistry(path, registry);
    return true;
  }
  return false;
}

/** True when the file exists at all (used for "no registry yet" messaging). */
export function registryExists(path: string): boolean {
  return existsSync(path);
}
