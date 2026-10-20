import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Field lesson 2026-10-19: server.json pinned the OCI identifier to
// ghcr.io/cloudcorprecords/greenlight:0.13.0 while the package shipped
// 0.16.1, so registry Docker installs resolved a three-version-old image
// without behavioral gates, wave, or pr_radar. This pins the tag to the
// package version in-tree, where the release checklist can see it.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("packaging version coherence", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8")) as {
    version: string;
    packages: Array<{
      registryType: string;
      identifier: string;
      version?: string;
    }>;
  };

  it("server.json version matches package.json", () => {
    assert.equal(server.version, pkg.version);
  });

  it("the npm package version matches package.json", () => {
    const npm = server.packages.find((p) => p.registryType === "npm")!;
    assert.equal(npm.version, pkg.version);
  });

  it("the OCI identifier tag equals the package version", () => {
    const oci = server.packages.find((p) => p.registryType === "oci")!;
    assert.ok(
      oci.identifier.endsWith(`:${pkg.version}`),
      `OCI identifier ${oci.identifier} must end with :${pkg.version}`
    );
  });
});
