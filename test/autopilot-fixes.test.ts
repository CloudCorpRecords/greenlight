/**
 * Autopilot mechanical fix resolver tests (v0.11.0).
 *
 * Only provably-mechanical resolutions are allowed: lockfiles by manager,
 * changelogs by line union, version or counter bumps where one side kept
 * the base value and the other is a strict increase. Everything else
 * aborts to NEEDS_HUMAN.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  conflictFileStrategy,
  parseConflictHunks,
  resolveVersionBumpHunk,
  resolveChangelogMerge,
  lockfileManager,
  detectFormatter,
  diffIsFormattingOnly,
} from "../src/autopilot-fixes.js";

describe("conflictFileStrategy", () => {
  it("routes lockfiles, changelogs, and everything else", () => {
    assert.equal(conflictFileStrategy("package-lock.json"), "lockfile");
    assert.equal(conflictFileStrategy("sub/pnpm-lock.yaml"), "lockfile");
    assert.equal(conflictFileStrategy("CHANGELOG.md"), "changelog");
    assert.equal(conflictFileStrategy("src/cli.ts"), "manual");
    assert.equal(conflictFileStrategy("README.md"), "manual");
  });
});

describe("parseConflictHunks", () => {
  it("parses markers", () => {
    const text = "a\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> base\nb\n";
    const hunks = parseConflictHunks(text);
    assert.ok(hunks);
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].ours, ["ours line"]);
    assert.deepEqual(hunks[0].theirs, ["theirs line"]);
  });

  it("rejects malformed markers", () => {
    assert.equal(parseConflictHunks("no markers here"), null);
    assert.equal(parseConflictHunks("<<<<<<< HEAD\nnever closed"), null);
  });
});

describe("resolveVersionBumpHunk", () => {
  it("takes a strict semver increase over a kept base (reticle guard case)", () => {
    const hunk = { base: [], ours: ["export const GUARD = 14;"], theirs: ["export const GUARD = 13;"] };
    const res = resolveVersionBumpHunk(hunk, ["export const GUARD = 13;"]);
    assert.ok(res);
    assert.equal(res.taken, "ours");
    assert.deepEqual(res.resolved, ["export const GUARD = 14;"]);
  });

  it("takes the other side's increase", () => {
    const hunk = { base: [], ours: ["version: 1.2.3"], theirs: ["version: 1.2.4"] };
    const res = resolveVersionBumpHunk(hunk, ["version: 1.2.3"]);
    assert.ok(res);
    assert.equal(res.taken, "theirs");
  });

  it("refuses when neither side kept the base", () => {
    const hunk = { base: [], ours: ["v = 14;"], theirs: ["v = 15;"] };
    assert.equal(resolveVersionBumpHunk(hunk, ["v = 13;"]), null);
  });

  it("refuses decreases and equal values", () => {
    const hunk = { base: [], ours: ["v = 12;"], theirs: ["v = 13;"] };
    assert.equal(resolveVersionBumpHunk(hunk, ["v = 13;"]), null);
  });

  it("refuses multi-line or multi-token changes", () => {
    const hunk = { base: [], ours: ["a = 1;", "b = 2;"], theirs: ["a = 1;"] };
    assert.equal(resolveVersionBumpHunk(hunk, ["a = 1;"]), null);
  });
});

describe("resolveChangelogMerge", () => {
  it("unions added lines without duplicating base", () => {
    const out = resolveChangelogMerge("a\nb", "a\nb\nc", "a\nb\nd");
    assert.equal(out, "a\nb\nc\nd");
  });
});

describe("lockfileManager", () => {
  it("maps lockfiles to managers", () => {
    assert.equal(lockfileManager("package-lock.json"), "npm");
    assert.equal(lockfileManager("pnpm-lock.yaml"), "pnpm");
    assert.equal(lockfileManager("yarn.lock"), "yarn");
    assert.equal(lockfileManager("src/index.ts"), null);
  });
});

describe("detectFormatter", () => {
  it("prefers npm scripts", () => {
    const f = detectFormatter(["x.ts"], { format: "prettier --write ." });
    assert.ok(f);
    assert.equal(f.name, "npm run format");
  });

  it("falls back to prettier config", () => {
    const f = detectFormatter([".prettierrc", "x.ts"], {});
    assert.ok(f);
    assert.equal(f.name, "prettier");
  });

  it("returns null with no formatter", () => {
    assert.equal(detectFormatter(["x.ts"], {}), null);
  });
});

describe("diffIsFormattingOnly", () => {
  it("true when git diff -w is empty", async () => {
    const git = { run: async () => ({ stdout: "", stderr: "" }) };
    assert.ok(await diffIsFormattingOnly(git, "/tmp"));
  });

  it("false when non-whitespace changes exist", async () => {
    const git = { run: async () => ({ stdout: "1\t2\tsrc/x.ts\n", stderr: "" }) };
    assert.ok(!(await diffIsFormattingOnly(git, "/tmp")));
  });
});
