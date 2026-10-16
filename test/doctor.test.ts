import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDoctor, nodeMajor, type DoctorDeps } from "../src/doctor.js";

const healthyRate = async () => ({ ok: true, remaining: 4990, limit: 5000 });

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  const cacheDir = mkdtempSync(join(tmpdir(), "gl-doctor-"));
  created.push(cacheDir);
  return {
    nodeVersion: "v22.14.0",
    env: { GITHUB_TOKEN: "fake" } as NodeJS.ProcessEnv,
    cacheDir,
    packageVersion: "0.0.0-test",
    fetchRateLimit: healthyRate,
    ...over,
  };
}

function statusOf(report: { checks: Array<{ name: string; status: string }> }, name: string): string {
  return report.checks.find((c) => c.name === name)!.status;
}

describe("greenlight doctor", () => {
  it("passes everything on a healthy setup", async () => {
    const report = await runDoctor(deps());
    assert.equal(report.version, "0.0.0-test");
    assert.ok(report.checks.every((c) => c.status === "pass"), JSON.stringify(report.checks));
  });

  it("an old Node fails with a fix", async () => {
    const report = await runDoctor(deps({ nodeVersion: "v18.0.0" }));
    assert.equal(statusOf(report, "node"), "fail");
    const check = report.checks.find((c) => c.name === "node")!;
    assert.ok(check.fix, "a failing check carries its fix");
  });

  it("a missing token warns (never fails) and names the fix", async () => {
    const report = await runDoctor(deps({ env: {} as NodeJS.ProcessEnv }));
    assert.equal(statusOf(report, "github token"), "warn");
    assert.ok(report.checks.find((c) => c.name === "github token")!.fix);
  });

  it("accepts GH_TOKEN as well as GITHUB_TOKEN", async () => {
    const report = await runDoctor(deps({ env: { GH_TOKEN: "fake" } as NodeJS.ProcessEnv }));
    assert.equal(statusOf(report, "github token"), "pass");
  });

  it("an unreachable API fails with a network fix", async () => {
    const report = await runDoctor(
      deps({ fetchRateLimit: async () => ({ ok: false, error: "fetch failed" }) })
    );
    assert.equal(statusOf(report, "github api"), "fail");
    assert.match(report.checks.find((c) => c.name === "github api")!.fix ?? "", /network/i);
  });

  it("an exhausted quota warns and quotes the reset time", async () => {
    const report = await runDoctor(
      deps({ fetchRateLimit: async () => ({ ok: true, remaining: 0, limit: 60, resetAt: "2030-01-01T00:00:00.000Z" }) })
    );
    assert.equal(statusOf(report, "github api"), "warn");
    assert.ok(report.checks.find((c) => c.name === "github api")!.detail.includes("2030-01-01"));
  });

  it("an unwritable cache dir fails", async () => {
    const file = join(tmpdir(), `gl-doctor-file-${Date.now()}`);
    writeFileSync(file, "x", "utf8");
    try {
      const report = await runDoctor(deps({ cacheDir: join(file, "sub") }));
      assert.equal(statusOf(report, "cache"), "fail");
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("nodeMajor parses the shapes Node reports", () => {
    assert.equal(nodeMajor("v22.14.0"), 22);
    assert.equal(nodeMajor("20.1.0"), 20);
    assert.equal(nodeMajor("garbage"), 0);
  });
});
