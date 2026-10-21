/**
 * Hardening batch 2 (v0.21.0): the GitHub API layer under a stubbed fetch,
 * plus cache failure modes. No network: every response comes from
 * setFetchImpl doubles. Unique fake repos per test dodge the file cache.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  apiGet,
  cacheGet,
  cacheSet,
  fetchComments,
  resolveCanonicalRepo,
  setFetchImpl,
  RateLimitError,
  ApiNotFoundError,
  WriteBlockedError,
} from "../src/github.js";

afterEach(() => setFetchImpl(null));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    })) as typeof fetch;

function freshRepo(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
}

const CACHE_DIR = join(homedir(), ".cache", "greenlight");
const cacheFileFor = (kind: string, parts: string[]) =>
  join(CACHE_DIR, `${kind}-${parts.join("-").replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);

describe("hardening api: status handling", () => {
  it("403 with a rate-limit body and reset header throws RateLimitError naming the reset", async () => {
    setFetchImpl(
      json({ message: "API rate limit exceeded" }, 403, {
        "x-ratelimit-reset": "1792500000",
      })
    );
    await assert.rejects(apiGet("/repos/o/r"), (err: unknown) => {
      assert.ok(err instanceof RateLimitError, `got ${err}`);
      assert.match((err as Error).message, /rate limit/i);
      assert.match((err as Error).message, /resets at/);
      return true;
    });
  });

  it("429 without a reset header still throws RateLimitError", async () => {
    setFetchImpl(json({ message: "too many requests" }, 429));
    await assert.rejects(apiGet("/repos/o/r"), RateLimitError);
  });

  it("403 with a Blocked body throws WriteBlockedError on reads too", async () => {
    setFetchImpl(json({ message: "Blocked" }, 403));
    await assert.rejects(apiGet("/repos/o/r"), WriteBlockedError);
  });

  it("404 throws ApiNotFoundError carrying the path", async () => {
    setFetchImpl(json({ message: "Not Found" }, 404));
    await assert.rejects(apiGet("/repos/o/missing"), (err: unknown) => {
      assert.ok(err instanceof ApiNotFoundError, `got ${err}`);
      assert.match((err as Error).message, /\/repos\/o\/missing/);
      return true;
    });
  });

  it("500 surfaces status and path, not a crash", async () => {
    setFetchImpl((async () => new Response("internal boom", { status: 500 })) as typeof fetch);
    await assert.rejects(apiGet("/repos/o/r"), /GitHub API 500 for \/repos\/o\/r/);
  });

  it("a 200 with truncated JSON rejects with an Error (no hang, no fake data)", async () => {
    setFetchImpl(
      (async () =>
        new Response('{"number": 1, "title": "cut off', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch
    );
    await assert.rejects(apiGet("/repos/o/r"), Error);
  });

  it("a 200 with a scalar body resolves to that scalar; consumers tolerate missing fields", async () => {
    setFetchImpl(json({}));
    // repo payload with every field missing: canonical resolution keeps input
    const out = await resolveCanonicalRepo("acme", "widgets");
    assert.deepEqual(out, { owner: "acme", repo: "widgets", fullName: "acme/widgets", renamed: false });
  });
});

describe("hardening api: pagination abuse", () => {
  const comment = (id: number) => ({
    id,
    user: { login: "someone" },
    body: `comment ${id}`,
    created_at: "2026-10-19T00:00:00Z",
  });

  it("a short second page ends the walk (mid-page end)", async () => {
    const repo = freshRepo("pgmid");
    const page1 = Array.from({ length: 100 }, (_, i) => comment(i + 1));
    const page2 = Array.from({ length: 37 }, (_, i) => comment(101 + i));
    setFetchImpl((async (url: string) => {
      const m = /[?&]page=(\d+)/.exec(String(url));
      const page = m ? Number(m[1]) : 1;
      const body = page === 1 ? page1 : page === 2 ? page2 : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch);
    const out = await fetchComments("acme", repo, 7);
    assert.equal(out.length, 137);
  });

  it("a server that repeats the same page forever cannot loop the walk", async () => {
    const repo = freshRepo("pgrepeat");
    let calls = 0;
    const page = Array.from({ length: 100 }, (_, i) => comment(i + 1));
    setFetchImpl((async () => {
      calls++;
      return new Response(JSON.stringify(page), { status: 200 });
    }) as typeof fetch);
    const out = await fetchComments("acme", repo, 8);
    // paginate caps at 5 pages: the walk terminates and returns what it got
    assert.ok(calls <= 5, `calls: ${calls}`);
    assert.equal(out.length, 100 * calls);
  });
});

describe("hardening cache: failure modes", () => {
  it("corrupt JSON in a cache file is a clean miss, then round-trips", () => {
    const kind = `hcache-${Date.now().toString(36)}`;
    const parts = ["acme", "widgets", "1"];
    const file = cacheFileFor(kind, parts);
    cacheSet(kind, parts, { ok: true });
    assert.ok(existsSync(file));
    writeFileSync(file, "{corrupt json,,,", "utf8");
    assert.equal(cacheGet(kind, parts), undefined, "corrupt entry is a miss");
    cacheSet(kind, parts, { ok: "again" });
    assert.deepEqual(cacheGet(kind, parts), { ok: "again" });
  });

  it("a shape-invalid cache entry (no numeric savedAt) is a miss, not eternal stale data", () => {
    const kind = `hcache-${Date.now().toString(36)}b`;
    const parts = ["acme", "widgets", "2"];
    const file = cacheFileFor(kind, parts);
    cacheSet(kind, parts, { ok: true });
    writeFileSync(file, JSON.stringify({ savedAt: "yesterday", data: { stale: true } }), "utf8");
    assert.equal(cacheGet(kind, parts), undefined);
    writeFileSync(file, JSON.stringify([1, 2, 3]), "utf8");
    assert.equal(cacheGet(kind, parts), undefined, "non-object entries are misses");
    writeFileSync(file, JSON.stringify("just a string"), "utf8");
    assert.equal(cacheGet(kind, parts), undefined);
  });

  it("an unserializable payload makes cacheSet a no-op, never a throw", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.doesNotThrow(() => cacheSet("hcache-circular", ["x"], circular));
  });

  it("crafted repo names cannot escape the cache directory", () => {
    const kind = `hcache-${Date.now().toString(36)}c`;
    const before = new Set(readdirSync(CACHE_DIR));
    cacheSet(kind, ["../../etc/passwd", "..", "a/b", "....//secret"], { pwn: false });
    const created = readdirSync(CACHE_DIR).filter((f) => !before.has(f));
    assert.ok(created.length >= 1, "the write landed somewhere");
    for (const f of created) {
      assert.ok(!f.includes("/"), `filename has no separators: ${f}`);
      assert.ok(existsSync(join(CACHE_DIR, f)), "created file is inside the cache dir");
    }
    assert.ok(!existsSync(join(CACHE_DIR, "..", "etc", "passwd.json")), "no escape artifact");
    // and the entry is still readable through the same crafted key
    assert.deepEqual(cacheGet(kind, ["../../etc/passwd", "..", "a/b", "....//secret"]), { pwn: false });
  });
});
