/**
 * Tests for the capability ledger (v0.10.1): per-repo recorded
 * interaction outcomes that make F2-style failures impossible to
 * pay for twice.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultCapabilitiesPath,
  loadCapabilities,
  recordCapability,
  latestCapability,
  isBlockedOutcome,
  prCreateBlockReason,
  capabilityOutcomeForError,
  type CapabilitiesFile,
} from "../src/capabilities.js";

const AT1 = "2026-10-18T13:00:00.000Z";
const AT2 = "2026-10-18T14:00:00.000Z";

let dir: string;
let ledger: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cap-"));
  ledger = join(dir, "capabilities.json");
});

describe("defaultCapabilitiesPath", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.GREENLIGHT_CAPABILITIES_PATH;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GREENLIGHT_CAPABILITIES_PATH;
    else process.env.GREENLIGHT_CAPABILITIES_PATH = saved;
  });

  it("honors GREENLIGHT_CAPABILITIES_PATH", () => {
    process.env.GREENLIGHT_CAPABILITIES_PATH = "/tmp/x.json";
    assert.equal(defaultCapabilitiesPath(), "/tmp/x.json");
  });

  it("defaults to ~/.greenlight/capabilities.json", () => {
    delete process.env.GREENLIGHT_CAPABILITIES_PATH;
    assert.match(defaultCapabilitiesPath(), /\.greenlight\/capabilities\.json$/);
  });
});

describe("record and load", () => {
  it("appends entries and reads them back", () => {
    recordCapability("actualbudget/actual", "pr_create", "blocked-422", '422 "user is blocked"', ledger, AT1);
    const file = loadCapabilities(ledger);
    assert.equal(file.entries.length, 1);
    assert.equal(file.entries[0].repo, "actualbudget/actual");
    assert.equal(file.entries[0].action, "pr_create");
    assert.equal(file.entries[0].outcome, "blocked-422");
    assert.equal(file.entries[0].at, AT1);
    // and the file on disk is valid JSON
    assert.equal(JSON.parse(readFileSync(ledger, "utf8")).entries.length, 1);
  });

  it("lowercases repo names on write", () => {
    recordCapability("Acme/Widgets", "claim", "ok", "posted", ledger, AT1);
    assert.equal(loadCapabilities(ledger).entries[0].repo, "acme/widgets");
  });

  it("returns an empty ledger for a missing file", () => {
    assert.deepEqual(loadCapabilities(join(dir, "nope.json")), { entries: [] });
  });

  it("returns an empty ledger for a corrupt file instead of throwing", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    assert.deepEqual(loadCapabilities(bad), { entries: [] });
  });
});

describe("latestCapability", () => {
  it("returns the most recent entry for repo+action, case-insensitive", () => {
    const file: CapabilitiesFile = {
      entries: [
        { repo: "acme/widgets", action: "pr_create", outcome: "ok", evidence: "e1", at: AT1 },
        { repo: "acme/widgets", action: "claim", outcome: "ok", evidence: "e2", at: AT2 },
        { repo: "ACME/WIDGETS", action: "pr_create", outcome: "blocked-422", evidence: "e3", at: AT2 },
      ],
    };
    const latest = latestCapability(file, "Acme/Widgets", "pr_create");
    assert.equal(latest?.outcome, "blocked-422");
    assert.equal(latest?.evidence, "e3");
  });

  it("returns undefined when the repo was never tried", () => {
    assert.equal(latestCapability({ entries: [] }, "acme/widgets", "pr_create"), undefined);
  });
});

describe("isBlockedOutcome", () => {
  it("treats the blocked family as structural", () => {
    assert.equal(isBlockedOutcome("blocked-404"), true);
    assert.equal(isBlockedOutcome("blocked-422"), true);
    assert.equal(isBlockedOutcome("blocked-403"), true);
    assert.equal(isBlockedOutcome("ok"), false);
    assert.equal(isBlockedOutcome("failed-other"), false);
  });
});

describe("prCreateBlockReason", () => {
  it("names the block with evidence", () => {
    const file: CapabilitiesFile = {
      entries: [
        { repo: "actualbudget/actual", action: "pr_create", outcome: "blocked-422", evidence: '422 "user is blocked" (2026-10-18)', at: AT1 },
      ],
    };
    const reason = prCreateBlockReason(file, "actualbudget/actual");
    assert.match(reason ?? "", /blocked-422/);
    assert.match(reason ?? "", /user is blocked/);
  });

  it("returns undefined for ok and for unknown repos", () => {
    const file: CapabilitiesFile = {
      entries: [{ repo: "acme/widgets", action: "pr_create", outcome: "ok", evidence: "PR opened", at: AT1 }],
    };
    assert.equal(prCreateBlockReason(file, "acme/widgets"), undefined);
    assert.equal(prCreateBlockReason(file, "acme/other"), undefined);
  });
});

describe("capabilityOutcomeForError", () => {
  it("maps HTTP statuses to outcomes", () => {
    assert.equal(capabilityOutcomeForError(new Error("GitHub API 404 for /repos/a/b/pulls: Not Found")), "blocked-404");
    assert.equal(capabilityOutcomeForError(new Error("GitHub API 422 for /repos/a/b/pulls: Validation Failed")), "blocked-422");
    assert.equal(capabilityOutcomeForError(new Error("GitHub blocked this write (403 anti-spam) for /x: Blocked")), "blocked-403");
    assert.equal(capabilityOutcomeForError(new Error("something else broke")), "failed-other");
  });

  it("returns undefined for rate limits (transient, not a repo capability)", () => {
    assert.equal(capabilityOutcomeForError(new Error("GitHub rate limit hit (429).")), undefined);
  });
});
