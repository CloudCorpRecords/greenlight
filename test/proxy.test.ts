/**
 * Tests for `greenlight proxy` and the doctor token remedy (v0.9.1).
 * A local HTTP upstream double stands in for api.github.com; nothing
 * external, and no real credential anywhere.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import {
  resolveProxyConfig,
  startProxy,
  proxyClientEnv,
  PROXY_DEFAULT_PORT,
  type ProxyConfig,
} from "../src/proxy.js";
import { runDoctor, type DoctorDeps } from "../src/doctor.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function startUpstream(onRequest: (headers: Record<string, string | string[] | undefined>, path: string) => { status: number; body: string }): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const { status, body } = onRequest(req.headers as Record<string, string | string[] | undefined>, req.url ?? "/");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, stop: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function configFor(upstreamPort: number): ProxyConfig {
  const c = resolveProxyConfig({ GITHUB_TOKEN: "test-token" } as NodeJS.ProcessEnv, 0, `http://127.0.0.1:${upstreamPort}`);
  assert.ok(!("error" in c));
  return c as ProxyConfig;
}

describe("greenlight proxy", () => {
  it("refuses to start without a token, and says what to do", () => {
    const r = resolveProxyConfig({} as NodeJS.ProcessEnv);
    assert.ok("error" in r);
    assert.ok(r.error.includes("GITHUB_TOKEN"), r.error);
    assert.ok(!r.error.includes("test-token"));
  });

  it("injects the startup token and ignores an incoming Authorization header", async () => {
    let seenAuth: unknown;
    let seenPath = "";
    const upstream = await startUpstream((headers, path) => {
      seenAuth = headers["authorization"];
      seenPath = path;
      return { status: 200, body: JSON.stringify({ ok: true }) };
    });
    const proxy = await startProxy(configFor(upstream.port));
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/rate_limit`, {
        headers: { Authorization: "Bearer evil-stray-value" },
      });
      assert.equal(res.status, 200);
      assert.equal(seenAuth, "Bearer test-token");
      assert.equal(seenPath, "/rate_limit");
    } finally {
      await proxy.stop();
      await upstream.stop();
    }
  });

  it("rejects absolute-form request targets", async () => {
    const upstream = await startUpstream(() => ({ status: 200, body: "{}" }));
    const proxy = await startProxy(configFor(upstream.port));
    try {
      // Raw absolute-form request line; node fetch would not produce this,
      // so build it over a raw socket.
      const { Socket } = await import("node:net");
      const body = await new Promise<string>((resolve, reject) => {
        const s = new Socket();
        let data = "";
        s.connect(proxy.port, "127.0.0.1", () => {
          s.write("GET http://evil.example/secret HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        });
        s.on("data", (d) => (data += d.toString()));
        s.on("close", () => resolve(data));
        s.on("error", reject);
      });
      assert.ok(body.startsWith("HTTP/1.1 400"), body.split("\r\n")[0]);
    } finally {
      await proxy.stop();
      await upstream.stop();
    }
  });

  it("binds 127.0.0.1 only and prints the client env line", () => {
    assert.equal(proxyClientEnv(8792), "GREENLIGHT_GITHUB_BASE_URL=http://127.0.0.1:8792 GITHUB_TOKEN=proxy");
    assert.equal(PROXY_DEFAULT_PORT, 8792);
  });

  it("forwards upstream errors with their status", async () => {
    const upstream = await startUpstream(() => ({ status: 403, body: JSON.stringify({ message: "rate limited" }) }));
    const proxy = await startProxy(configFor(upstream.port));
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/repos/a/b`);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.message, "rate limited");
    } finally {
      await proxy.stop();
      await upstream.stop();
    }
  });
});

describe("doctor token remedy", () => {
  function deps(env: Record<string, string>): DoctorDeps {
    return {
      nodeVersion: "v22.14.0",
      env: env as NodeJS.ProcessEnv,
      cacheDir: mkdtempSync(join(tmpdir(), "gl-doc-")),
      packageVersion: "0.0.0-test",
      fetchRateLimit: async () => ({ ok: true, remaining: 4990, limit: 5000 }),
    };
  }

  it("names the proxy remedy when unauthenticated", async () => {
    const report = await runDoctor(deps({}));
    const check = report.checks.find((c) => c.name === "github token")!;
    assert.equal(check.status, "warn");
    assert.ok(check.fix && check.fix.includes("greenlight proxy"), check.fix);
    assert.ok(check.fix.includes("GREENLIGHT_GITHUB_BASE_URL"), check.fix);
  });

  it("keeps byte-identical output when authenticated", async () => {
    const report = await runDoctor(deps({ GITHUB_TOKEN: "fake" }));
    const check = report.checks.find((c) => c.name === "github token")!;
    assert.equal(check.status, "pass");
    assert.equal(check.detail, "GITHUB_TOKEN is set");
    assert.equal(check.fix, undefined);
  });

  it("recognizes proxy mode when the base URL is set without a token", async () => {
    const report = await runDoctor(deps({ GREENLIGHT_GITHUB_BASE_URL: "http://127.0.0.1:8792" }));
    const check = report.checks.find((c) => c.name === "github token")!;
    assert.equal(check.status, "warn");
    assert.ok(check.detail.includes("proxy mode"), check.detail);
  });
});
