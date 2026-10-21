/**
 * Hardening batch 3 (v0.21.0): security pins.
 * - The GitHub token never appears in errors, request URLs, doctor
 *   output, or cache files (sentinel-token tests).
 * - GREENLIGHT_GITHUB_BASE_URL accepts only http/https; credentials
 *   embedded in it are stripped before use and never echoed.
 * - Cache paths cannot escape their directory (also in hardening-api).
 * Spawn discipline (argument arrays everywhere; the only sh -c sites run
 * the target repo's own declared test/CI commands) is audited in the
 * v0.21.0 manifest rather than by a runtime test.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  apiGet,
  fetchComments,
  githubApiBase,
  sanitizeApiBase,
  setFetchImpl,
} from "../src/github.js";
import { runDoctor } from "../src/doctor.js";

const SENTINEL = "SENTINEL-TOKEN-9f3e2a-never-print-me";
const savedEnv = {
  token: process.env.GITHUB_TOKEN,
  ghToken: process.env.GH_TOKEN,
  base: process.env.GREENLIGHT_GITHUB_BASE_URL,
};

afterEach(() => {
  setFetchImpl(null);
  if (savedEnv.token === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedEnv.token;
  if (savedEnv.ghToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = savedEnv.ghToken;
  if (savedEnv.base === undefined) delete process.env.GREENLIGHT_GITHUB_BASE_URL;
  else process.env.GREENLIGHT_GITHUB_BASE_URL = savedEnv.base;
});

describe("hardening security: base URL validation", () => {
  it("sanitizeApiBase keeps http/https and strips credentials, query and hash", () => {
    assert.equal(sanitizeApiBase("http://127.0.0.1:8792/"), "http://127.0.0.1:8792");
    assert.equal(
      sanitizeApiBase(`https://user:${SENTINEL}@ghe.example.com/api/v3?token=${SENTINEL}#frag`),
      "https://ghe.example.com/api/v3"
    );
    assert.equal(sanitizeApiBase("  https://api.github.com  "), "https://api.github.com");
  });

  it("sanitizeApiBase rejects non-http(s) and unparseable values", () => {
    assert.equal(sanitizeApiBase("ftp://example.com"), null);
    assert.equal(sanitizeApiBase("file:///etc/passwd"), null);
    assert.equal(sanitizeApiBase("javascript:alert(1)"), null);
    assert.equal(sanitizeApiBase("not a url"), null);
    assert.equal(sanitizeApiBase(""), null);
  });

  it("githubApiBase falls back to api.github.com for a hostile env value", () => {
    process.env.GREENLIGHT_GITHUB_BASE_URL = "file:///etc/passwd";
    assert.equal(githubApiBase(), "https://api.github.com");
    process.env.GREENLIGHT_GITHUB_BASE_URL = `https://user:${SENTINEL}@127.0.0.1:8792/`;
    const base = githubApiBase();
    assert.equal(base, "https://127.0.0.1:8792");
    assert.ok(!base.includes(SENTINEL));
  });
});

describe("hardening security: the token never leaks", () => {
  it("a failing request's URL and error carry neither the token nor URL credentials", async () => {
    process.env.GITHUB_TOKEN = SENTINEL;
    process.env.GREENLIGHT_GITHUB_BASE_URL = `https://user:${SENTINEL}@127.0.0.1:8792/`;
    const seenUrls: string[] = [];
    setFetchImpl((async (url: string) => {
      seenUrls.push(String(url));
      return new Response("boom", { status: 500 });
    }) as typeof fetch);
    await assert.rejects(apiGet("/repos/o/r"), (err: unknown) => {
      assert.ok(!(err as Error).message.includes(SENTINEL), "error must not contain the sentinel");
      return true;
    });
    assert.ok(seenUrls.length >= 1);
    for (const u of seenUrls) assert.ok(!u.includes(SENTINEL), `request URL leaked: ${u}`);
  });

  it("a rate-limit error does not contain the token", async () => {
    process.env.GITHUB_TOKEN = SENTINEL;
    delete process.env.GREENLIGHT_GITHUB_BASE_URL;
    setFetchImpl((async () =>
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "Content-Type": "application/json", "x-ratelimit-reset": "1792500000" },
      })) as typeof fetch);
    await assert.rejects(apiGet("/repos/o/r"), (err: unknown) => {
      assert.ok(!(err as Error).message.includes(SENTINEL));
      return true;
    });
  });

  it("cached API data on disk contains no token", async () => {
    process.env.GITHUB_TOKEN = SENTINEL;
    const repo = `hsec-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    setFetchImpl((async () =>
      new Response(
        JSON.stringify([
          { id: 1, user: { login: "someone" }, body: "hello", created_at: "2026-10-19T00:00:00Z" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch);
    await fetchComments("acme", repo, 3);
    const file = join(
      homedir(),
      ".cache",
      "greenlight",
      `issue-acme-${repo}-3-comments.json`
    );
    assert.ok(existsSync(file), "cache file was written");
    assert.ok(!readFileSync(file, "utf8").includes(SENTINEL), "cache file must not contain the token");
  });

  it("doctor output never echoes credentials embedded in the base URL", async () => {
    const report = await runDoctor({
      nodeVersion: process.version,
      env: {
        GREENLIGHT_GITHUB_BASE_URL: `http://user:${SENTINEL}@127.0.0.1:8792`,
      } as NodeJS.ProcessEnv,
      cacheDir: join(homedir(), ".cache"),
      packageVersion: "0.20.1",
      fetchRateLimit: async () => ({ ok: true, remaining: 4990, limit: 5000 }),
    });
    const rendered = JSON.stringify(report);
    assert.ok(!rendered.includes(SENTINEL), "doctor report leaked the embedded credential");
    const tokenCheck = report.checks.find((c) => c.name === "github token");
    assert.ok(tokenCheck, "token check exists");
    assert.match(tokenCheck.detail, /127\.0\.0\.1:8792/);
  });
});
