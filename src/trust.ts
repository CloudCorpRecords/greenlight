/**
 * Repo trust memory (Lane B of the dyva-patterns plan).
 *
 * Greenlight's Policy Index and racecheck already classify repos;
 * what they lacked is persistence semantics that survive between
 * scans and are safe to accumulate. This store borrows dyva's
 * hoststore shape (graflex/hoststore.py) and its score invariants
 * (brainstorm/honeypot-score.md):
 *
 *   - Composite key (dimension, repo). Dimensions are prs, comments,
 *     and claims, because the same repo can welcome issues and be
 *     hostile to external PRs; a repo-only key would merge those.
 *   - Negative evidence writes ONLY to a separate bad table, so a
 *     bad observation can never overwrite a good record. The good
 *     and bad tables are both kept; which one speaks is a read-time
 *     decision.
 *   - Conflicts resolve by checked recency: the newest checked mark
 *     wins, and an older checked write never displaces a newer
 *     record of the same polarity.
 *   - Discovery inserts with INSERT OR IGNORE semantics: a scan
 *     discovering a repo never downgrades one already checked.
 *   - Signals are appended to a log and the status is DERIVED on
 *     read, never a mutating counter. Every signal carries
 *     provenance: source, evidence note, and the checked-at time
 *     supplied by whoever ran the probe.
 *   - Flags are reversible: clearing a mark writes a sentinel log
 *     entry (repo plus a mandatory reason) and deletes nothing, so
 *     a newer bad observation after the clear re-blocks the repo.
 *
 * Persistence follows the claims-registry house style: one plain
 * JSON document at ~/.greenlight/trust.json (override with
 * GREENLIGHT_TRUST_FILE), easy to read and hand-edit.
 *
 * Canonical keys: every read and write passes through
 * canonicalRepoKey, because dyva shipped the scar this guards
 * against: a trailing-star key written in one form and read in
 * another, so marks never matched. The regression test lives in
 * test/trust.test.ts under the name "dyva trailing-star regression".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TRUST_DIMENSIONS = ["prs", "comments", "claims"] as const;
export type TrustDimension = (typeof TRUST_DIMENSIONS)[number];

export function isTrustDimension(value: string): value is TrustDimension {
  return (TRUST_DIMENSIONS as readonly string[]).includes(value);
}

/**
 * Canonical repo key: lowercase owner/repo, no decoration.
 *
 * Accepts the spellings a mark might plausibly be written under:
 * bare owner/repo in any case, with surrounding whitespace, a
 * trailing slash, a .git suffix, a trailing star (the pattern form
 * dyva's bug split on), a github.com path, a full https URL, or the
 * ssh form git@github.com:owner/repo. All collapse to one key so a
 * mark written under any of them is found under every other.
 */
export function canonicalRepoKey(input: string): string {
  if (typeof input !== "string") throw new Error("repo key must be a string");
  let s = input.trim().toLowerCase();
  if (s.startsWith("git@github.com:")) s = s.slice("git@github.com:".length);
  s = s.replace(/^https?:\/\//, "");
  if (s.startsWith("github.com/")) s = s.slice("github.com/".length);
  s = s.replace(/\*+$/, "");
  s = s.replace(/\/+$/, "");
  if (s.endsWith(".git")) s = s.slice(0, -".git".length);
  s = s.replace(/\/+$/, "");
  s = s.replace(/\*+$/, "");
  const parts = s.split("/");
  if (
    parts.length !== 2 ||
    parts[0].length === 0 ||
    parts[1].length === 0 ||
    /\s/.test(parts[0]) ||
    /\s/.test(parts[1])
  ) {
    throw new Error(`not an owner/repo key: ${JSON.stringify(input)}`);
  }
  return `${parts[0]}/${parts[1]}`;
}

/** One checked observation (or discovery note) about a repo dimension. */
export interface TrustMark {
  dimension: TrustDimension;
  /** The repo as written by the caller; canonicalized on write. */
  repo: string;
  /** Short state label, e.g. paused, collaborators-only, welcoming. */
  label: string;
  /** Who or what produced this mark, e.g. seed, racecheck, index. */
  source: string;
  /** The evidence note: what was actually observed. */
  evidence: string;
  /** ISO timestamp of when the check happened (not when it was filed). */
  checkedAt: string;
}

export type TrustSignalType = "good" | "bad" | "discovered" | "clear";

/** One append-only log entry. Log entries are never edited or removed. */
export interface TrustSignal extends TrustMark {
  type: TrustSignalType;
  /** Present on clear entries: why the mark was cleared. */
  reason?: string;
  /** Present on clear entries: who cleared it. */
  clearedBy?: string;
}

export interface TrustStoreFile {
  version: 1;
  /** Latest checked positive mark per composite key. */
  good: Record<string, TrustMark>;
  /** Latest checked negative mark per composite key. Kept apart from good on purpose. */
  bad: Record<string, TrustMark>;
  /** Discovery notes per composite key, only for keys never checked. */
  discovered: Record<string, TrustMark>;
  /** Every signal ever recorded, in order. Append-only. */
  log: TrustSignal[];
}

export type TrustState = "trusted" | "blocked" | "cleared" | "discovered";

/** The read-time derivation for one (dimension, repo) pair. */
export interface DerivedTrust {
  dimension: TrustDimension;
  repo: string;
  state: TrustState;
  /** The label of the mark that currently speaks. */
  label: string;
  source: string;
  evidence: string;
  checkedAt: string;
  /** The latest good mark, when one exists (kept even while blocked). */
  good?: TrustMark;
  /** The latest bad mark, when one exists (kept even after a clear). */
  bad?: TrustMark;
  /** The clear that currently suppresses the bad mark, when cleared. */
  cleared?: { reason: string; clearedBy: string; checkedAt: string };
}

function compositeKey(dimension: TrustDimension, repoKey: string): string {
  return `${dimension}:${repoKey}`;
}

function emptyFile(): TrustStoreFile {
  return { version: 1, good: {}, bad: {}, discovered: {}, log: [] };
}

export class TrustStore {
  readonly filePath: string;
  private data: TrustStoreFile;

  constructor(filePath: string) {
    this.filePath = filePath;
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as TrustStoreFile;
      this.data = {
        version: 1,
        good: parsed.good ?? {},
        bad: parsed.bad ?? {},
        discovered: parsed.discovered ?? {},
        log: parsed.log ?? [],
      };
    } else {
      this.data = emptyFile();
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + "\n", "utf8");
  }

  private canonicalMark(mark: TrustMark): TrustMark {
    return { ...mark, repo: canonicalRepoKey(mark.repo) };
  }

  /**
   * Record a checked positive observation. Writes only to the good
   * table; a newer bad mark stays untouched in its own table and
   * keeps speaking until this check is the newer one.
   */
  recordGood(mark: TrustMark): void {
    const m = this.canonicalMark(mark);
    const key = compositeKey(m.dimension, m.repo);
    const existing = this.data.good[key];
    if (!existing || m.checkedAt >= existing.checkedAt) this.data.good[key] = m;
    delete this.data.discovered[key];
    this.data.log.push({ ...m, type: "good" });
    this.save();
  }

  /**
   * Record a checked negative observation. Writes ONLY to the bad
   * table: the good record for the same key, if any, is never
   * overwritten or removed by bad evidence.
   */
  recordBad(mark: TrustMark): void {
    const m = this.canonicalMark(mark);
    const key = compositeKey(m.dimension, m.repo);
    const existing = this.data.bad[key];
    if (!existing || m.checkedAt >= existing.checkedAt) this.data.bad[key] = m;
    delete this.data.discovered[key];
    this.data.log.push({ ...m, type: "bad" });
    this.save();
  }

  /**
   * Record that a scan discovered this repo. INSERT OR IGNORE
   * semantics: when the key already carries any checked record (or
   * an earlier discovery), the discovery changes nothing and is not
   * even logged, so discovery can never downgrade a checked repo.
   */
  recordDiscovered(mark: TrustMark): void {
    const m = this.canonicalMark(mark);
    const key = compositeKey(m.dimension, m.repo);
    if (this.data.good[key] || this.data.bad[key] || this.data.discovered[key]) return;
    this.data.discovered[key] = m;
    this.data.log.push({ ...m, type: "discovered" });
    this.save();
  }

  /**
   * Clear the speaking bad mark for one (dimension, repo). Requires
   * naming the repo and a reason; both are validated before anything
   * is written. The clear is itself a logged signal and deletes
   * nothing: the bad mark stays in its table, suppressed until a bad
   * observation newer than the clear arrives.
   */
  clear(dimension: TrustDimension, repo: string, reason: string, clearedBy: string, at?: string): void {
    const repoKey = canonicalRepoKey(repo);
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new Error("clearing a trust mark requires a reason");
    }
    const signal: TrustSignal = {
      dimension,
      repo: repoKey,
      label: "cleared",
      source: clearedBy,
      evidence: "operator clear",
      checkedAt: at ?? new Date().toISOString(),
      type: "clear",
      reason: reason.trim(),
      clearedBy,
    };
    this.data.log.push(signal);
    this.save();
  }

  private latestClear(dimension: TrustDimension, repoKey: string): TrustSignal | undefined {
    let found: TrustSignal | undefined;
    for (const s of this.data.log) {
      if (s.type === "clear" && s.dimension === dimension && s.repo === repoKey) {
        if (!found || s.checkedAt >= found.checkedAt) found = s;
      }
    }
    return found;
  }

  /**
   * Derive the current state for one (dimension, repo) pair. Pure
   * read: the newest checked mark (good or bad) speaks; a clear
   * newer than the speaking bad mark suppresses it to "cleared".
   */
  derive(dimension: TrustDimension, repoInput: string): DerivedTrust | null {
    const repoKey = canonicalRepoKey(repoInput);
    const key = compositeKey(dimension, repoKey);
    const good = this.data.good[key];
    const bad = this.data.bad[key];
    const discovered = this.data.discovered[key];
    const clear = this.latestClear(dimension, repoKey);

    if (!good && !bad) {
      if (!discovered) return null;
      return {
        dimension, repo: repoKey, state: "discovered",
        label: discovered.label, source: discovered.source,
        evidence: discovered.evidence, checkedAt: discovered.checkedAt,
      };
    }
    const badSpeaks = bad !== undefined && (good === undefined || bad.checkedAt >= good.checkedAt);
    if (badSpeaks && bad) {
      if (clear && clear.checkedAt > bad.checkedAt) {
        return {
          dimension, repo: repoKey, state: "cleared",
          label: bad.label, source: clear.source,
          evidence: `cleared: ${clear.reason ?? ""} (bad mark: ${bad.evidence})`,
          checkedAt: clear.checkedAt,
          good, bad,
          cleared: { reason: clear.reason ?? "", clearedBy: clear.clearedBy ?? clear.source, checkedAt: clear.checkedAt },
        };
      }
      return {
        dimension, repo: repoKey, state: "blocked",
        label: bad.label, source: bad.source,
        evidence: bad.evidence, checkedAt: bad.checkedAt,
        good, bad,
      };
    }
    const g = good as TrustMark;
    return {
      dimension, repo: repoKey, state: "trusted",
      label: g.label, source: g.source,
      evidence: g.evidence, checkedAt: g.checkedAt,
      good, bad,
    };
  }

  /** Every derived entry, sorted by repo then dimension. */
  list(): DerivedTrust[] {
    const keys = new Set<string>([
      ...Object.keys(this.data.good),
      ...Object.keys(this.data.bad),
      ...Object.keys(this.data.discovered),
    ]);
    const out: DerivedTrust[] = [];
    for (const key of keys) {
      const [dimension, repo] = key.split(":", 2) as [TrustDimension, string];
      const d = this.derive(dimension, repo);
      if (d) out.push(d);
    }
    return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.dimension.localeCompare(b.dimension));
  }

  /** The raw append-only signal log (read-only view). */
  signals(): readonly TrustSignal[] {
    return this.data.log;
  }
}

/** Default store path, following the claims-registry convention. */
export function defaultTrustFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GREENLIGHT_TRUST_FILE) return env.GREENLIGHT_TRUST_FILE;
  return join(homedir(), ".greenlight", "trust.json");
}

export type TrustMode = "off" | "dry-run" | "on";

/**
 * The racecheck feature flag. GREENLIGHT_TRUST_MEMORY accepts "on"
 * (trust memory may skip a blocked repo before vetting) and
 * "dry-run" (consult and report, change nothing). Anything else,
 * including unset, is off: shipped behavior is unchanged.
 */
export function trustModeFromEnv(env: NodeJS.ProcessEnv = process.env): TrustMode {
  const v = (env.GREENLIGHT_TRUST_MEMORY ?? "").trim().toLowerCase();
  if (v === "on") return "on";
  if (v === "dry-run") return "dry-run";
  return "off";
}
