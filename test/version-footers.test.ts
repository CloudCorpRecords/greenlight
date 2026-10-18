/**
 * Version footer regression test (v0.10.0).
 *
 * QA caught it on 0.9.3: digest printed "Greenlight digest v0.9.0", guard
 * printed "v0.9.1", babysit printed "v0.9.2", and scout printed an inline
 * "Scout v0.9.0" — hardcoded version strings that went stale the moment
 * the package version moved on. Every footer now derives from the single
 * package.json version. This test reads package.json directly (not through
 * the source under test) and asserts each command's footer carries it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { renderDigestMarkdown } from "../src/digest.js";
import { renderGuardMarkdown } from "../src/guard.js";
import { babysit } from "../src/babysit.js";
import { scoutFooter } from "../src/scout.js";

const PKG_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };
  return pkg.version;
})();

describe("version footers track package.json", () => {
  it("package.json is the version under test", () => {
    assert.match(PKG_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it("digest footer carries the package version", () => {
    const md = renderDigestMarkdown({
      repo: "o/r",
      races: [],
      claimConflicts: [],
      staleClaims: [],
      assignmentConflicts: [],
      triageHolds: [],
      degraded: [],
      summary: "Digest for o/r",
      prCap: 50,
    });
    const footer = md.split("\n").find((l) => l.includes("Greenlight digest"));
    assert.ok(footer, "digest footer present");
    assert.ok(footer.includes(`v${PKG_VERSION}`), `expected v${PKG_VERSION}, got: ${footer}`);
  });

  it("guard footer carries the package version", () => {
    const md = renderGuardMarkdown({
      pr: "https://github.com/o/r/pull/1",
      number: 1,
      repo: "o/r",
      title: "t",
      author: "me",
      linkedIssues: [],
      competingPRs: [],
      claims: [],
      findings: [],
      summary: "Greenlight guard: nothing flagged",
      hasFindings: false,
      autopilotLabels: [],
      autopilotLabelDecisions: [],
      staleClaimNudges: [],
    });
    const footer = md.split("\n").find((l) => l.includes("Greenlight guard") && l.startsWith("_Checked"));
    assert.ok(footer, "guard footer present");
    assert.ok(footer.includes(`v${PKG_VERSION}`), `expected v${PKG_VERSION}, got: ${footer}`);
  });

  it("babysit footer carries the package version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-version-"));
    const run = await babysit({
      prs: [],
      statePath: join(dir, "babysit.json"),
      claimsRegistryPath: join(dir, "my-claims.json"),
    });
    const footer = run.markdown.split("\n").find((l) => l.includes("Greenlight babysit"));
    assert.ok(footer, "babysit footer present");
    assert.ok(footer.includes(`v${PKG_VERSION}`), `expected v${PKG_VERSION}, got: ${footer}`);
  });

  it("scout footer carries the package version", () => {
    const footer = scoutFooter(12, 300);
    assert.ok(footer.includes(`v${PKG_VERSION}`), `expected v${PKG_VERSION}, got: ${footer}`);
    assert.ok(footer.includes("12 calls used of 300"), "budget figures still render");
  });
});
