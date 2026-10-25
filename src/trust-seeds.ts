/**
 * Seed data and Policy Index analysis for the repo trust memory
 * (Lane B of the dyva-patterns plan).
 *
 * Seeds are the gated repos the campaign already paid to learn
 * about: every mark carries its provenance (where the knowledge
 * came from, when it was checked, and the evidence note) because
 * a mark that cannot be traced cannot be trusted or cleared
 * honestly.
 *
 * The Policy Index half is a DRY RUN by design: analyzePolicyIndex
 * reads index entries and reports what WOULD be written (counts per
 * class, per dimension, and any place seed knowledge disagrees with
 * the index) without writing anything anywhere. Turning the index
 * into live marks is a separate, later decision.
 */
import { canonicalRepoKey, type TrustMark, type TrustStore } from "./trust.js";

/**
 * The known gated repos. Dates are when the gate was met face to
 * face in the October 2026 campaign; the Policy Index (2026-10-23
 * edition) corroborates every one of these except twentyhq/twenty,
 * which the index still reads as open. That disagreement is exactly
 * what the dry run surfaces, and the seed stands on the campaign
 * evidence: twenty was vetted collaborators-only in the same pass
 * that found the activepieces auto-close policy (AGENTS.md lesson,
 * 2026-10-15).
 */
export const SEED_MARKS: TrustMark[] = [
  {
    dimension: "prs",
    repo: "activepieces/activepieces",
    label: "paused",
    source: "campaign + policy-index",
    evidence:
      "CONTRIBUTING.md pauses unsolicited outside PRs and a Close external PRs workflow auto-closes them within about a minute; two campaign PRs died this way on 2026-10-15. Index class: paused.",
    checkedAt: "2026-10-15T00:00:00.000Z",
  },
  {
    dimension: "prs",
    repo: "dubinc/dub",
    label: "collaborators-only",
    source: "campaign + policy-index",
    evidence:
      "PR creation rejects non-collaborators; outside fork-based PRs effectively do not exist. Vetted in the 2026-10-15 campaign pass. Index class: collaborators-only.",
    checkedAt: "2026-10-15T00:00:00.000Z",
  },
  {
    dimension: "prs",
    repo: "twentyhq/twenty",
    label: "collaborators-only",
    source: "campaign",
    evidence:
      "Vetted collaborators-only in the 2026-10-15 campaign pass (structural gate, same family as dub). The 2026-10-23 Policy Index still classifies this repo open; the campaign evidence is the more direct observation.",
    checkedAt: "2026-10-15T00:00:00.000Z",
  },
  {
    dimension: "prs",
    repo: "modelcontextprotocol/inspector",
    label: "maintainer-only",
    source: "campaign + policy-index",
    evidence:
      "Maintainer-only PR policy: issues are welcome, pull requests are not accepted from outside. Index class: maintainer-only.",
    checkedAt: "2026-10-23T00:00:00.000Z",
  },
  {
    dimension: "prs",
    repo: "modelcontextprotocol/servers",
    label: "maintainer-only",
    source: "campaign + policy-index",
    evidence:
      "Maintainer-only PR policy: issues are welcome, pull requests are not accepted from outside. Index class: maintainer-only.",
    checkedAt: "2026-10-23T00:00:00.000Z",
  },
  {
    dimension: "prs",
    repo: "astral-sh/uv",
    label: "agents-banned",
    source: "policy-index",
    evidence:
      "Autonomous agent contributions are not allowed in this repo per its agent policy. Index classes: agents-banned, agents-disclosure.",
    checkedAt: "2026-10-23T00:00:00.000Z",
  },
  {
    dimension: "comments",
    repo: "astral-sh/uv",
    label: "agents-banned",
    source: "policy-index",
    evidence:
      "The same agent policy covers comments: AI-generated maintainer comments may be hidden. Index headline for astral-sh/uv.",
    checkedAt: "2026-10-23T00:00:00.000Z",
  },
];

/** Write the seed marks into a store as bad evidence. Returns the count applied. */
export function applySeedMarks(store: TrustStore): number {
  for (const mark of SEED_MARKS) store.recordBad(mark);
  return SEED_MARKS.length;
}

/** One entry of the Agent Policy Index export (docs/policy.json shape). */
export interface PolicyIndexEntry {
  repo: string;
  policy_classes: string[];
  headline?: string;
  evidence?: string;
  url?: string;
}

/**
 * How index classes would map onto trust dimensions. Blocked means
 * the dimension is structurally closed; gated means work is
 * possible but only through a procedure (claim first, get assigned,
 * sign the CLA), which a dry run counts separately from blocked.
 */
export const INDEX_PRS_BLOCKED = ["agents-banned", "paused", "collaborators-only", "maintainer-only"];
export const INDEX_PRS_GATED = [
  "vouch-gated",
  "cla-required",
  "dco-required",
  "discussion-first",
  "bot-gated-intake",
  "agents-disclosure",
  "assignment-gated",
];
export const INDEX_COMMENTS_BLOCKED = ["agents-banned"];
export const INDEX_CLAIMS_GATED = ["claim-first", "assignment-gated", "triage-hold"];

export interface PolicyIndexConflict {
  repo: string;
  seedLabels: string[];
  indexClasses: string[];
}

export interface PolicyIndexDryRun {
  total: number;
  perClass: Record<string, number>;
  /** Entries whose only class is open. */
  openOnly: number;
  /** Entries carrying at least one non-open class. */
  withGate: number;
  /** Repos that would get a blocked mark, per dimension. */
  wouldBlock: { prs: number; comments: number; claims: number };
  /** Repos that would get a gated (procedural) mark, per dimension. */
  wouldGate: { prs: number; comments: number; claims: number };
  /** Total bad marks an index import would write. */
  wouldWriteMarks: number;
  /** Seed knowledge the index disagrees with. */
  conflicts: PolicyIndexConflict[];
}

/**
 * Analyze Policy Index entries against the seed marks. Pure: reads
 * nothing, writes nothing, returns counts and disagreements only.
 */
export function analyzePolicyIndex(entries: PolicyIndexEntry[]): PolicyIndexDryRun {
  const perClass: Record<string, number> = {};
  let openOnly = 0;
  let withGate = 0;
  const block = { prs: new Set<string>(), comments: new Set<string>(), claims: new Set<string>() };
  const gate = { prs: new Set<string>(), comments: new Set<string>(), claims: new Set<string>() };

  const seedBadPrs = new Map<string, string[]>();
  for (const s of SEED_MARKS) {
    if (s.dimension !== "prs") continue;
    const key = canonicalRepoKey(s.repo);
    seedBadPrs.set(key, [...(seedBadPrs.get(key) ?? []), s.label]);
  }
  const conflicts: PolicyIndexConflict[] = [];

  for (const entry of entries) {
    const classes = entry.policy_classes ?? [];
    for (const c of classes) perClass[c] = (perClass[c] ?? 0) + 1;
    const nonOpen = classes.filter((c) => c !== "open");
    if (nonOpen.length === 0) openOnly++;
    else withGate++;

    let key: string | null = null;
    try {
      key = canonicalRepoKey(entry.repo);
    } catch {
      key = null;
    }
    if (key) {
      if (classes.some((c) => INDEX_PRS_BLOCKED.includes(c))) block.prs.add(key);
      if (classes.some((c) => INDEX_PRS_GATED.includes(c))) gate.prs.add(key);
      if (classes.some((c) => INDEX_COMMENTS_BLOCKED.includes(c))) block.comments.add(key);
      if (classes.some((c) => INDEX_CLAIMS_GATED.includes(c))) gate.claims.add(key);

      const seedLabels = seedBadPrs.get(key);
      if (seedLabels && !classes.some((c) => INDEX_PRS_BLOCKED.includes(c))) {
        conflicts.push({ repo: key, seedLabels, indexClasses: classes });
      }
    }
  }

  return {
    total: entries.length,
    perClass,
    openOnly,
    withGate,
    wouldBlock: { prs: block.prs.size, comments: block.comments.size, claims: block.claims.size },
    wouldGate: { prs: gate.prs.size, comments: gate.comments.size, claims: gate.claims.size },
    wouldWriteMarks: block.prs.size + block.comments.size + block.claims.size,
    conflicts,
  };
}
