import { test, describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRegistryPath,
  loadRegistry,
  registerClaim,
  removeClaim,
  registryExists,
  type MyClaim,
} from "../src/claims-registry.js";
import { bucketClaim, type ClaimBucket } from "../src/claim-health.js";
import type { IssueStatusPayload } from "../src/protocol.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600000).toISOString();
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3600000).toISOString();

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gl-claims-test-"));
  path = join(dir, "my-claims.json");
});
afterEach(() => {
  delete process.env.GREENLIGHT_CLAIMS_FILE;
});

describe("claims registry", () => {
  it("defaults to ~/.greenlight/my-claims.json and honors the override env", () => {
    assert.ok(defaultRegistryPath().endsWith(join(".greenlight", "my-claims.json")));
    process.env.GREENLIGHT_CLAIMS_FILE = "/tmp/scratch.json";
    assert.equal(defaultRegistryPath(), "/tmp/scratch.json");
  });

  it("loads empty when missing, survives a broken file", () => {
    assert.equal(registryExists(path), false);
    assert.deepEqual(loadRegistry(path).claims, []);
    writeFileSync(path, "{broken", "utf8");
    assert.deepEqual(loadRegistry(path).claims, []);
  });

  it("registers, dedupes, and removes by issue URL", () => {
    const entry: MyClaim = {
      issueUrl: "https://github.com/o/r/issues/1",
      owner: "o",
      repo: "r",
      number: 1,
      postedAt: NOW.toISOString(),
      etaDays: 7,
      claimant: "me",
      commentUrl: "https://github.com/o/r/issues/1#issuecomment-9",
    };
    registerClaim(path, entry);
    assert.equal(registryExists(path), true);
    assert.equal(loadRegistry(path).claims.length, 1);
    // Re-registering the same issue refreshes, not duplicates.
    registerClaim(path, { ...entry, etaDays: 10 });
    const reg = loadRegistry(path);
    assert.equal(reg.claims.length, 1);
    assert.equal(reg.claims[0].etaDays, 10);
    assert.equal(removeClaim(path, "https://github.com/O/R/issues/1"), true);
    assert.deepEqual(loadRegistry(path).claims, []);
    assert.equal(removeClaim(path, "https://github.com/o/r/issues/1"), false);
  });
});

function status(over: Partial<IssueStatusPayload> = {}): IssueStatusPayload {
  return {
    issue: "https://github.com/o/r/issues/1",
    verdict: null,
    reason: null,
    claim: null,
    protocol_note: null,
    competing_prs: [],
    gates: [],
    repo_protocol: null,
    checked_at: NOW.toISOString(),
    stale_after_seconds: 21600,
    ...over,
  };
}

function claim(over: Partial<IssueStatusPayload["claim"]> = {}): IssueStatusPayload["claim"] {
  return {
    state: "active",
    claimant: "me",
    claimed_at: hoursAgo(24),
    expires_at: hoursFromNow(6 * 24),
    queue: [],
    ...over,
  };
}

function baseClaim(over: Partial<MyClaim> = {}): MyClaim {
  return {
    issueUrl: "https://github.com/o/r/issues/1",
    owner: "o",
    repo: "r",
    number: 1,
    postedAt: hoursAgo(24),
    claimant: "me",
    ...over,
  };
}

describe("claim health buckets", () => {
  const buckets: Array<[ClaimBucket, string, () => { status: IssueStatusPayload; updatedAt: string | null; claim?: MyClaim }]> = [
    [
      "linked",
      "open PR against the claim is fine",
      () => ({
        status: status({
          claim: claim({ state: "linked" }),
          competing_prs: [{ number: 10, author: "me", state: "open", url: "https://github.com/o/r/pull/10" }],
        }),
        updatedAt: hoursAgo(2),
      }),
    ],
    [
      "healthy-active",
      "young claim, fresh lease, no trouble",
      () => ({
        status: status({ claim: claim() }),
        updatedAt: hoursAgo(1),
      }),
    ],
    [
      "heartbeat-due",
      "lease past half with no activity since the claim",
      () => ({
        status: status({ claim: claim({ claimed_at: hoursAgo(120), expires_at: hoursFromNow(96) }) }),
        updatedAt: hoursAgo(120),
      }),
    ],
    [
      "expiring",
      "lease under 48h",
      () => ({
        status: status({ claim: claim({ claimed_at: hoursAgo(120), expires_at: hoursFromNow(30) }) }),
        updatedAt: hoursAgo(1),
      }),
    ],
    [
      "unlinked-stale",
      "72h claimed with no PR",
      () => ({
        status: status({ claim: claim({ claimed_at: hoursAgo(80), expires_at: hoursFromNow(4 * 24) }) }),
        updatedAt: hoursAgo(80),
        claim: baseClaim({ postedAt: hoursAgo(80) }),
      }),
    ],
    [
      "queue-lost",
      "someone ahead merged",
      () => ({
        status: status({
          claim: claim(),
          competing_prs: [{ number: 11, author: "rival", state: "merged", url: "https://github.com/o/r/pull/11" }],
        }),
        updatedAt: hoursAgo(1),
      }),
    ],
    [
      "queue-lost",
      "active claim belongs to someone else (superseded)",
      () => ({
        status: status({ claim: claim({ claimant: "rival" }) }),
        updatedAt: hoursAgo(1),
      }),
    ],
    [
      "queue-lost",
      "lease expired",
      () => ({
        status: status({ claim: claim({ state: "expired", expires_at: hoursAgo(5) }) }),
        updatedAt: hoursAgo(1),
      }),
    ],
  ];

  for (const [bucket, label, make] of buckets) {
    test(`buckets as ${bucket}: ${label}`, () => {
      const { status: s, updatedAt, claim: c } = make();
      const h = bucketClaim({ claim: c ?? baseClaim(), status: s, issueUpdatedAt: updatedAt, now: NOW });
      assert.equal(h.bucket, bucket, `${label}: ${h.detail}`);
      assert.ok(h.detail.length > 0);
    });
  }
});
