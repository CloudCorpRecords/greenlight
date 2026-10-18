/**
 * Posting ledger tests (v0.9.2, the pacing patch).
 *
 * Field lesson 2026-10-17: the campaign's claim-posting pace tripped
 * GitHub's account-level anti-spam flag. The ledger records every post
 * attempt, enforces cadence + a daily soft cap, and reconciles
 * unconfirmed writes against the API before any repost.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentId,
  appendLedgerEntry,
  checkPacing,
  emptyLedger,
  finishPost,
  outcomeForError,
  pacingConfigFromEnv,
  pacingSummary,
  pendingEntryFor,
  readLedger,
  reconcileEntry,
  reservePost,
  type PostingLedger,
  type PostingLedgerEntry,
} from "../src/posting-ledger.js";

const T0 = Date.parse("2026-10-18T00:00:00Z");

function entryAt(secondsAgo: number, kind: PostingLedgerEntry["kind"] = "claim"): PostingLedgerEntry {
  return {
    ts: new Date(T0 - secondsAgo * 1000).toISOString(),
    kind,
    targetUrl: "https://github.com/acme/widget/issues/1",
    outcome: "confirmed",
  };
}

describe("posting ledger", () => {
  it("writes and reads back entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-ledger-"));
    const path = join(dir, "posting-ledger.json");
    assert.deepEqual(readLedger(path), emptyLedger());
    const written = appendLedgerEntry({ kind: "claim", targetUrl: "https://github.com/a/b/issues/1", outcome: "confirmed" }, path);
    assert.ok(written.ts.length > 0);
    const back = readLedger(path);
    assert.equal(back.entries.length, 1);
    assert.equal(back.entries[0].targetUrl, "https://github.com/a/b/issues/1");
    // corrupt file degrades to empty, never throws
    writeFileSync(path, "{nope");
    assert.deepEqual(readLedger(path), emptyLedger());
  });

  it("refuses a claim post inside the cadence window (injected clock)", () => {
    const ledger: PostingLedger = { v: 1, entries: [entryAt(42)] };
    const d = checkPacing(ledger, T0, { minIntervalS: 90, jitterS: 0, dailyCap: 25 });
    assert.equal(d.allowed, false);
    assert.ok(d.nextAllowedAt !== null, "names the earliest allowed time");
    assert.equal(d.nextAllowedAt, new Date(T0 + 48 * 1000).toISOString());
    assert.ok(/pacing/.test(d.reason ?? ""), `reason names pacing: ${d.reason}`);
  });

  it("allows a claim post after the cadence window, and the first post ever", () => {
    const ledger: PostingLedger = { v: 1, entries: [entryAt(95)] };
    const d = checkPacing(ledger, T0, { minIntervalS: 90, jitterS: 0, dailyCap: 25 });
    assert.equal(d.allowed, true);
    assert.equal(d.nextAllowedAt, null);
    const fresh = checkPacing(emptyLedger(), T0, { minIntervalS: 90, jitterS: 0, dailyCap: 25 });
    assert.equal(fresh.allowed, true);
  });

  it("refuses at the daily soft cap, and 0 disables the cap", () => {
    const entries = Array.from({ length: 25 }, (_, i) => entryAt(i * 3600));
    const ledger: PostingLedger = { v: 1, entries };
    const d = checkPacing(ledger, T0, { minIntervalS: 0, jitterS: 0, dailyCap: 25 });
    assert.equal(d.allowed, false);
    assert.equal(d.postsToday, 25);
    assert.ok(/cap/.test(d.reason ?? ""));
    const off = checkPacing(ledger, T0, { minIntervalS: 0, jitterS: 0, dailyCap: 0 });
    assert.equal(off.allowed, true);
  });

  it("reads pacing config from env", () => {
    const cfg = pacingConfigFromEnv({ GREENLIGHT_CLAIM_MIN_INTERVAL_S: "30", GREENLIGHT_CLAIM_DAILY_CAP: "5" } as NodeJS.ProcessEnv);
    assert.equal(cfg.minIntervalS, 30);
    assert.equal(cfg.dailyCap, 5);
    const def = pacingConfigFromEnv({});
    assert.equal(def.minIntervalS, 90);
    assert.equal(def.dailyCap, 25);
  });

  it("reconciles an unconfirmed entry that actually landed: confirmed, no repost needed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-ledger-"));
    const path = join(dir, "posting-ledger.json");
    const written = appendLedgerEntry(
      { kind: "claim", targetUrl: "https://github.com/a/b/issues/7", outcome: "unconfirmed", note: "network dropped" },
      path
    );
    assert.ok(pendingEntryFor(readLedger(path), "https://github.com/a/b/issues/7") !== null);
    // The re-read finds the claim comment: the "failed" post landed.
    const out = await reconcileEntry(path, written, async () => true);
    assert.equal(out, "confirmed");
    const back = readLedger(path);
    assert.equal(back.entries[0].outcome, "confirmed");
    assert.equal(pendingEntryFor(back, "https://github.com/a/b/issues/7"), null);
  });

  it("reconciles a post verified absent: superseded, a fresh attempt is allowed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-ledger-"));
    const path = join(dir, "posting-ledger.json");
    const written = appendLedgerEntry(
      { kind: "claim", targetUrl: "https://github.com/a/b/issues/8", outcome: "unconfirmed" },
      path
    );
    const out = await reconcileEntry(path, written, async () => false);
    assert.equal(out, "not-landed");
    const back = readLedger(path);
    assert.equal(back.entries[0].outcome, "superseded");
    assert.equal(pendingEntryFor(back, "https://github.com/a/b/issues/8"), null);
  });

  it("keeps the entry unconfirmed when the re-read itself fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-ledger-"));
    const path = join(dir, "posting-ledger.json");
    const written = appendLedgerEntry(
      { kind: "claim", targetUrl: "https://github.com/a/b/issues/9", outcome: "unconfirmed" },
      path
    );
    const out = await reconcileEntry(path, written, async () => {
      throw new Error("network down");
    });
    assert.equal(out, "unknown");
    assert.equal(readLedger(path).entries[0].outcome, "unconfirmed");
    assert.ok(pendingEntryFor(readLedger(path), "https://github.com/a/b/issues/9") !== null);
  });

  it("classifies post failures: blocks vs uncertain", () => {
    assert.equal(outcomeForError(new Error('GitHub blocked this write (403 anti-spam): {"message":"Blocked"}')), "blocked");
    assert.equal(outcomeForError(new Error("GitHub rate limit hit (403).")), "blocked");
    assert.equal(outcomeForError(new Error("fetch failed")), "unconfirmed");
    assert.equal(outcomeForError(new Error("socket hang up")), "unconfirmed");
  });

  it("renders a pacing summary with real numbers", () => {
    const ledger: PostingLedger = {
      v: 1,
      entries: [entryAt(42), { ...entryAt(9000), outcome: "unconfirmed" }],
    };
    const d = checkPacing(ledger, T0, { minIntervalS: 90, jitterS: 0, dailyCap: 25 });
    const lines = pacingSummary(d);
    assert.ok(lines.some((l) => l.includes("2 claim posts")), JSON.stringify(lines));
    assert.ok(lines.some((l) => l.includes("next claim post allowed at")), JSON.stringify(lines));
    assert.ok(lines.some((l) => l.includes("1 unconfirmed")), JSON.stringify(lines));
  });

  it("only counts comment-class kinds for cadence", () => {
    // A recent PR creation must not gate claim posting.
    const ledger: PostingLedger = { v: 1, entries: [entryAt(10, "pr")] };
    const d = checkPacing(ledger, T0, { minIntervalS: 90, jitterS: 0, dailyCap: 25 });
    assert.equal(d.allowed, true);
  });
});

describe("multi-agent ledger (v0.10.0)", () => {
  it("stamps entries with the agent id", () => {
    assert.equal(agentId({ GREENLIGHT_AGENT_ID: "worker-a" } as NodeJS.ProcessEnv), "worker-a");
    assert.equal(agentId({ GREENLIGHT_AGENT_ID: "  " } as NodeJS.ProcessEnv).includes(":"), true, "blank falls back to hostname:pid");
    const fallback = agentId({} as NodeJS.ProcessEnv);
    assert.match(fallback, /^\S+:\d+$/, `expected hostname:pid, got ${fallback}`);
  });

  it("appendLedgerEntry records the agent from the environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-ledger-agent-"));
    const path = join(dir, "posting-ledger.json");
    process.env.GREENLIGHT_AGENT_ID = "worker-7";
    try {
      appendLedgerEntry({ kind: "claim", targetUrl: "https://github.com/a/b/issues/1", outcome: "confirmed" }, path);
    } finally {
      delete process.env.GREENLIGHT_AGENT_ID;
    }
    assert.equal(readLedger(path).entries[0].agent, "worker-7");
  });

  it("reservePost is atomic: check and write happen under one lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-ledger-reserve-"));
    const path = join(dir, "posting-ledger.json");
    const cfg = { minIntervalS: 90, jitterS: 0, dailyCap: 25 };
    const r1 = reservePost(path, { kind: "claim", targetUrl: "https://github.com/a/b/issues/1" }, cfg, T0);
    assert.equal(r1.allowed, true);
    assert.ok(r1.entry, "reservation entry returned");
    assert.equal(r1.entry!.outcome, "unconfirmed", "reservation lands as unconfirmed");
    // The reservation itself counts toward cadence: a second immediate
    // claim refuses, exactly as if two agents had raced.
    const r2 = reservePost(path, { kind: "claim", targetUrl: "https://github.com/a/b/issues/2" }, cfg, T0 + 1000);
    assert.equal(r2.allowed, false);
    assert.match(r2.reason ?? "", /pacing/);
    assert.equal(r2.entry, null);
    // finishPost reconciles the reservation to confirmed.
    finishPost(path, r1.entry!, "confirmed", "comment #123");
    const stored = readLedger(path).entries[0];
    assert.equal(stored.outcome, "confirmed");
    assert.equal(stored.note, "comment #123");
  });

  it("reservePost enforces the daily cap against the combined ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-ledger-cap-"));
    const path = join(dir, "posting-ledger.json");
    const cfg = { minIntervalS: 0, jitterS: 0, dailyCap: 2 };
    const r1 = reservePost(path, { kind: "claim", targetUrl: "https://github.com/a/b/issues/1" }, cfg, T0);
    const r2 = reservePost(path, { kind: "claim", targetUrl: "https://github.com/a/b/issues/2" }, cfg, T0 + 1000);
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, true);
    const r3 = reservePost(path, { kind: "claim", targetUrl: "https://github.com/a/b/issues/3" }, cfg, T0 + 2000);
    assert.equal(r3.allowed, false);
    assert.match(r3.reason ?? "", /daily claim cap reached/);
  });

  it("finishPost hits the right entry when two posts share a millisecond", () => {
    // Regression: finishPost used to match on ts + targetUrl, so two
    // posts in the same millisecond (same target, e.g. a forced repost)
    // made the second finish update the first entry. CI caught it.
    const dir = mkdtempSync(join(tmpdir(), "gl-ledger-collide-"));
    const path = join(dir, "posting-ledger.json");
    const cfg = { minIntervalS: 0, jitterS: 0, dailyCap: 25 };
    const target = "https://github.com/a/b/issues/1";
    const r1 = reservePost(path, { kind: "claim", targetUrl: target }, cfg, T0);
    const r2 = reservePost(path, { kind: "claim", targetUrl: target }, cfg, T0, { force: true });
    assert.equal(r1.entry!.ts, r2.entry!.ts, "same millisecond, same ts");
    assert.notEqual(r1.entry!.id, r2.entry!.id, "but distinct reservation ids");
    finishPost(path, r1.entry!, "confirmed", "comment #1");
    finishPost(path, r2.entry!, "confirmed", "comment #2 (pacing override: --force)");
    const entries = readLedger(path).entries;
    assert.equal(entries.length, 2);
    assert.equal(entries[0].note, "comment #1");
    assert.equal(entries[1].note, "comment #2 (pacing override: --force)");
    assert.equal(entries[0].outcome, "confirmed");
    assert.equal(entries[1].outcome, "confirmed");
  });

  it("--force overrides pacing and the reservation is still ledgered", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-ledger-force-"));
    const path = join(dir, "posting-ledger.json");
    const cfg = { minIntervalS: 90, jitterS: 0, dailyCap: 25 };
    reservePost(path, { kind: "claim", targetUrl: "https://github.com/a/b/issues/1" }, cfg, T0);
    const r = reservePost(path, { kind: "claim", targetUrl: "https://github.com/a/b/issues/2" }, cfg, T0 + 1000, { force: true });
    assert.equal(r.allowed, true);
    assert.ok(r.entry, "forced reservation is ledgered");
    assert.equal(readLedger(path).entries.length, 2);
  });
});
