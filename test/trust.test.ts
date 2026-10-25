/**
 * Repo trust memory tests (Lane B of the dyva-patterns plan).
 *
 * The store borrows dyva's hoststore shape: a composite (dimension,
 * repo) key, negative evidence in a separate table so it can never
 * overwrite a good record, conflicts resolved by checked recency,
 * discovery inserts that never downgrade a checked record, signals
 * appended to a log with the status derived on read, and clears that
 * are themselves logged and require a named repo plus a reason.
 *
 * Canonicalization tests are written against the dyva scar: dyva
 * shipped a trailing-star key written in one form and read in
 * another, so marks never matched. The named regression test below
 * pins that bug class shut for repo keys.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalRepoKey,
  TrustStore,
  trustModeFromEnv,
  type TrustMark,
} from "../src/trust.js";
import {
  SEED_MARKS,
  applySeedMarks,
  analyzePolicyIndex,
  type PolicyIndexEntry,
} from "../src/trust-seeds.js";
import { racecheckIssue, type RaceIssue, type RacePRCandidate } from "../src/racecheck.js";

function tempStore(): { store: TrustStore; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gl-trust-"));
  const file = join(dir, "trust.json");
  return { store: new TrustStore(file), file, dir };
}

function mark(partial: Partial<TrustMark> & { repo: string }): TrustMark {
  return {
    dimension: "prs",
    label: "open",
    source: "test",
    evidence: "test evidence",
    checkedAt: "2026-10-24T00:00:00.000Z",
    ...partial,
    repo: partial.repo,
  };
}

describe("canonicalRepoKey", () => {
  it("lowercases and trims whitespace", () => {
    assert.equal(canonicalRepoKey("  Owner/Repo  "), "owner/repo");
    assert.equal(canonicalRepoKey("OWNER/REPO"), "owner/repo");
  });

  it("strips a trailing slash and a .git suffix", () => {
    assert.equal(canonicalRepoKey("owner/repo/"), "owner/repo");
    assert.equal(canonicalRepoKey("owner/repo.git"), "owner/repo");
    assert.equal(canonicalRepoKey("owner/repo.git/"), "owner/repo");
  });

  it("accepts URL and ssh forms", () => {
    assert.equal(canonicalRepoKey("https://github.com/Owner/Repo"), "owner/repo");
    assert.equal(canonicalRepoKey("https://github.com/Owner/Repo.git"), "owner/repo");
    assert.equal(canonicalRepoKey("http://github.com/owner/repo/"), "owner/repo");
    assert.equal(canonicalRepoKey("github.com/Owner/Repo"), "owner/repo");
    assert.equal(canonicalRepoKey("git@github.com:Owner/Repo.git"), "owner/repo");
  });

  it("strips a trailing star (pattern form)", () => {
    assert.equal(canonicalRepoKey("owner/repo*"), "owner/repo");
    assert.equal(canonicalRepoKey("Owner/Repo*"), "owner/repo");
  });

  it("rejects shapes that are not owner/repo", () => {
    assert.throws(() => canonicalRepoKey("justname"));
    assert.throws(() => canonicalRepoKey(""));
    assert.throws(() => canonicalRepoKey("   "));
    assert.throws(() => canonicalRepoKey("a/b/c"));
    assert.throws(() => canonicalRepoKey("/repo"));
    assert.throws(() => canonicalRepoKey("owner/"));
  });
});

describe("TrustStore", () => {
  it("dyva trailing-star regression: a mark written under the starred spelling is found under the canonical spelling", () => {
    const { store, dir } = tempStore();
    store.recordBad(mark({ repo: "Activepieces/Activepieces*", label: "paused" }));
    const derived = store.derive("prs", "activepieces/activepieces");
    assert.ok(derived);
    assert.equal(derived.state, "blocked");
    assert.equal(derived.label, "paused");
    const viaUrl = store.derive("prs", "https://github.com/ACTIVEPIECES/activepieces.git");
    assert.ok(viaUrl);
    assert.equal(viaUrl.state, "blocked");
    rmSync(dir, { recursive: true, force: true });
  });

  it("records a good mark and derives trusted with provenance", () => {
    const { store, dir } = tempStore();
    store.recordGood(mark({ repo: "a/b", label: "welcoming", source: "scan", evidence: "PR merged" }));
    const d = store.derive("prs", "a/b");
    assert.ok(d);
    assert.equal(d.state, "trusted");
    assert.equal(d.label, "welcoming");
    assert.equal(d.source, "scan");
    assert.equal(d.evidence, "PR merged");
    assert.equal(d.checkedAt, "2026-10-24T00:00:00.000Z");
    rmSync(dir, { recursive: true, force: true });
  });

  it("bad evidence lives in a separate table and never overwrites the good record", () => {
    const { store, file, dir } = tempStore();
    store.recordGood(mark({ repo: "a/b", label: "welcoming", checkedAt: "2026-10-20T00:00:00.000Z" }));
    store.recordBad(mark({ repo: "a/b", label: "paused", checkedAt: "2026-10-22T00:00:00.000Z" }));
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(raw.good["prs:a/b"].label, "welcoming");
    assert.equal(raw.bad["prs:a/b"].label, "paused");
    const d = store.derive("prs", "a/b");
    assert.ok(d);
    assert.equal(d.state, "blocked");
    assert.ok(d.good);
    assert.equal(d.good.label, "welcoming");
    rmSync(dir, { recursive: true, force: true });
  });

  it("conflicts resolve by checked recency in both directions", () => {
    const { store, dir } = tempStore();
    store.recordBad(mark({ repo: "a/b", label: "paused", checkedAt: "2026-10-20T00:00:00.000Z" }));
    assert.equal(store.derive("prs", "a/b")?.state, "blocked");
    store.recordGood(mark({ repo: "a/b", label: "welcoming", checkedAt: "2026-10-23T00:00:00.000Z" }));
    assert.equal(store.derive("prs", "a/b")?.state, "trusted");
    store.recordBad(mark({ repo: "a/b", label: "paused-again", checkedAt: "2026-10-24T00:00:00.000Z" }));
    assert.equal(store.derive("prs", "a/b")?.state, "blocked");
    rmSync(dir, { recursive: true, force: true });
  });

  it("an older checked write never displaces a newer record of the same polarity", () => {
    const { store, dir } = tempStore();
    store.recordBad(mark({ repo: "a/b", label: "newer", checkedAt: "2026-10-24T00:00:00.000Z" }));
    store.recordBad(mark({ repo: "a/b", label: "older", checkedAt: "2026-10-20T00:00:00.000Z" }));
    assert.equal(store.derive("prs", "a/b")?.label, "newer");
    rmSync(dir, { recursive: true, force: true });
  });

  it("discovery never downgrades a checked record", () => {
    const { store, file, dir } = tempStore();
    store.recordGood(mark({ repo: "a/b", label: "welcoming" }));
    store.recordDiscovered({ repo: "a/b", dimension: "prs", source: "index", evidence: "seen in index", checkedAt: "2026-10-24T01:00:00.000Z" });
    assert.equal(store.derive("prs", "a/b")?.state, "trusted");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(raw.discovered["prs:a/b"], undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("discovery of an unknown repo derives discovered, and a later check replaces it", () => {
    const { store, dir } = tempStore();
    store.recordDiscovered({ repo: "x/y", dimension: "claims", source: "index", evidence: "listed", checkedAt: "2026-10-24T00:00:00.000Z" });
    assert.equal(store.derive("claims", "x/y")?.state, "discovered");
    store.recordGood(mark({ repo: "x/y", dimension: "claims", label: "claim-first", checkedAt: "2026-10-24T02:00:00.000Z" }));
    assert.equal(store.derive("claims", "x/y")?.state, "trusted");
    rmSync(dir, { recursive: true, force: true });
  });

  it("dimensions are independent for the same repo", () => {
    const { store, dir } = tempStore();
    store.recordBad(mark({ repo: "a/b", dimension: "prs", label: "maintainer-only" }));
    store.recordGood(mark({ repo: "a/b", dimension: "claims", label: "issues-welcome" }));
    assert.equal(store.derive("prs", "a/b")?.state, "blocked");
    assert.equal(store.derive("claims", "a/b")?.state, "trusted");
    assert.equal(store.derive("comments", "a/b"), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("clearing requires a repo and a reason, is logged, and deletes nothing", () => {
    const { store, file, dir } = tempStore();
    store.recordBad(mark({ repo: "a/b", label: "paused", checkedAt: "2026-10-20T00:00:00.000Z" }));
    assert.throws(() => store.clear("prs", "a/b", "", "operator"));
    assert.throws(() => store.clear("prs", "a/b", "   ", "operator"));
    assert.throws(() => store.clear("prs", "", "some reason", "operator"));
    store.clear("prs", "a/b", "maintainer reopened outside PRs", "operator", "2026-10-24T03:00:00.000Z");
    const d = store.derive("prs", "a/b");
    assert.ok(d);
    assert.equal(d.state, "cleared");
    assert.ok(d.cleared);
    assert.equal(d.cleared.reason, "maintainer reopened outside PRs");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(raw.bad["prs:a/b"].label, "paused");
    const clearSignals = raw.log.filter((s: { type: string }) => s.type === "clear");
    assert.equal(clearSignals.length, 1);
    assert.equal(clearSignals[0].reason, "maintainer reopened outside PRs");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a bad observation newer than the clear re-blocks the repo", () => {
    const { store, dir } = tempStore();
    store.recordBad(mark({ repo: "a/b", label: "paused", checkedAt: "2026-10-20T00:00:00.000Z" }));
    store.clear("prs", "a/b", "looked fixed", "operator", "2026-10-21T00:00:00.000Z");
    assert.equal(store.derive("prs", "a/b")?.state, "cleared");
    store.recordBad(mark({ repo: "a/b", label: "paused", checkedAt: "2026-10-24T00:00:00.000Z" }));
    assert.equal(store.derive("prs", "a/b")?.state, "blocked");
    rmSync(dir, { recursive: true, force: true });
  });

  it("the signal log is append-only: earlier entries never change", () => {
    const { store, file, dir } = tempStore();
    store.recordGood(mark({ repo: "a/b" }));
    const afterFirst = JSON.parse(readFileSync(file, "utf8")).log;
    store.recordBad(mark({ repo: "a/b", label: "paused", checkedAt: "2026-10-24T01:00:00.000Z" }));
    store.clear("prs", "a/b", "reason here", "operator", "2026-10-24T02:00:00.000Z");
    const afterAll = JSON.parse(readFileSync(file, "utf8")).log;
    assert.ok(afterAll.length > afterFirst.length);
    assert.deepEqual(afterAll.slice(0, afterFirst.length), afterFirst);
    for (const s of afterAll) {
      assert.ok(s.source && s.evidence !== undefined && s.checkedAt && s.repo && s.dimension);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("state persists across store instances on the same file", () => {
    const { store, file, dir } = tempStore();
    store.recordBad(mark({ repo: "a/b", label: "paused" }));
    const reopened = new TrustStore(file);
    assert.equal(reopened.derive("prs", "a/b")?.state, "blocked");
    rmSync(dir, { recursive: true, force: true });
  });

  it("an unknown repo derives null and list returns every derived entry", () => {
    const { store, dir } = tempStore();
    assert.equal(store.derive("prs", "no/pe"), null);
    store.recordGood(mark({ repo: "a/b" }));
    store.recordBad(mark({ repo: "c/d", label: "paused" }));
    const entries = store.list();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.state).sort(), ["blocked", "trusted"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("seed marks", () => {
  it("seeds the known gated repos as blocked on the prs dimension", () => {
    const { store, dir } = tempStore();
    const written = applySeedMarks(store);
    assert.equal(written, SEED_MARKS.length);
    for (const repo of [
      "activepieces/activepieces",
      "dubinc/dub",
      "twentyhq/twenty",
      "modelcontextprotocol/inspector",
      "modelcontextprotocol/servers",
      "astral-sh/uv",
    ]) {
      assert.equal(store.derive("prs", repo)?.state, "blocked", repo);
    }
    // Maintainer-only repos welcome issues: claims stay unblocked.
    assert.notEqual(store.derive("claims", "modelcontextprotocol/inspector")?.state, "blocked");
    assert.notEqual(store.derive("claims", "modelcontextprotocol/servers")?.state, "blocked");
    // The uv agent ban also covers comments (seeded from its headline).
    assert.equal(store.derive("comments", "astral-sh/uv")?.state, "blocked");
    rmSync(dir, { recursive: true, force: true });
  });

  it("every seed carries provenance", () => {
    for (const s of SEED_MARKS) {
      assert.ok(s.source.length > 0);
      assert.ok(s.evidence.length > 0);
      assert.ok(s.checkedAt.length > 0);
      assert.ok(s.label.length > 0);
    }
  });
});

describe("analyzePolicyIndex (dry run)", () => {
  const entries: PolicyIndexEntry[] = [
    { repo: "o/open", policy_classes: ["open"], headline: "No agent policy found", evidence: "scan" },
    { repo: "o/paused", policy_classes: ["paused"], headline: "paused", evidence: "scan" },
    { repo: "o/collab", policy_classes: ["collaborators-only"], headline: "collab", evidence: "scan" },
    { repo: "o/cla", policy_classes: ["cla-required", "dco-required"], headline: "cla", evidence: "scan" },
    { repo: "twentyhq/twenty", policy_classes: ["open"], headline: "No agent policy found", evidence: "scan" },
  ];

  it("counts classes and would-be marks per dimension without writing anything", () => {
    const report = analyzePolicyIndex(entries);
    assert.equal(report.total, 5);
    assert.equal(report.perClass["paused"], 1);
    assert.equal(report.perClass["open"], 2);
    assert.equal(report.wouldBlock.prs, 2);
    assert.ok(report.wouldGate.prs >= 1);
    assert.equal(report.openOnly, 2);
  });

  it("flags disagreements between seed knowledge and the index", () => {
    const report = analyzePolicyIndex(entries);
    const conflict = report.conflicts.find((c) => c.repo === "twentyhq/twenty");
    assert.ok(conflict);
    assert.deepEqual(conflict.indexClasses, ["open"]);
    assert.ok(conflict.seedLabels.length > 0);
  });
});

describe("trustModeFromEnv", () => {
  it("defaults to off and only accepts on or dry-run", () => {
    assert.equal(trustModeFromEnv({}), "off");
    assert.equal(trustModeFromEnv({ GREENLIGHT_TRUST_MEMORY: "on" }), "on");
    assert.equal(trustModeFromEnv({ GREENLIGHT_TRUST_MEMORY: "dry-run" }), "dry-run");
    assert.equal(trustModeFromEnv({ GREENLIGHT_TRUST_MEMORY: "yes" }), "off");
  });
});

describe("racecheck trust wiring", () => {
  const ISSUE: RaceIssue = {
    title: "Root route types are deleted on every sync run",
    body: "The types file is deleted and regenerated on every run.",
    labels: [],
    author: "reporter",
  };
  const NO_PRS = async (): Promise<RacePRCandidate[]> => [];

  function blockedStore(): TrustStore {
    const { store } = tempStore();
    store.recordBad(mark({ repo: "a/b", dimension: "claims", label: "paused", source: "seed", evidence: "auto-close" }));
    return store;
  }

  it("mode off (no store passed) leaves behavior and output shape unchanged", async () => {
    let fetched = false;
    const result = await racecheckIssue("a", "b", 7, {
      fetchIssue: async () => { fetched = true; return ISSUE; },
      searchOpenPRs: NO_PRS,
      listOpenPRs: NO_PRS,
    });
    assert.equal(fetched, true);
    assert.equal(result.verdict, "CLEAR");
    assert.equal(result.trust, undefined);
  });

  it("dry-run reports the block but still vets and keeps the verdict", async () => {
    let fetched = false;
    const result = await racecheckIssue("a", "b", 7, {
      fetchIssue: async () => { fetched = true; return ISSUE; },
      searchOpenPRs: NO_PRS,
      listOpenPRs: NO_PRS,
    }, { trustMode: "dry-run", trustStore: blockedStore() });
    assert.equal(fetched, true);
    assert.equal(result.verdict, "CLEAR");
    assert.ok(result.trust);
    assert.equal(result.trust.blocked, true);
    assert.equal(result.trust.mode, "dry-run");
    assert.ok(result.reasons.some((r) => r.includes("dry-run")));
  });

  it("mode on skips a blocked repo before any issue fetch", async () => {
    let fetched = false;
    const result = await racecheckIssue("a", "b", 7, {
      fetchIssue: async () => { fetched = true; return ISSUE; },
      searchOpenPRs: NO_PRS,
      listOpenPRs: NO_PRS,
    }, { trustMode: "on", trustStore: blockedStore() });
    assert.equal(fetched, false);
    assert.equal(result.verdict, "SKIP");
    assert.equal(result.apiCalls, 0);
    assert.ok(result.trust);
    assert.equal(result.trust.blocked, true);
  });

  it("mode on with a trusted repo vets normally", async () => {
    const { store } = tempStore();
    store.recordGood(mark({ repo: "a/b", dimension: "prs", label: "welcoming" }));
    let fetched = false;
    const result = await racecheckIssue("a", "b", 7, {
      fetchIssue: async () => { fetched = true; return ISSUE; },
      searchOpenPRs: NO_PRS,
      listOpenPRs: NO_PRS,
    }, { trustMode: "on", trustStore: store });
    assert.equal(fetched, true);
    assert.equal(result.verdict, "CLEAR");
    assert.ok(result.trust);
    assert.equal(result.trust.blocked, false);
  });
});
