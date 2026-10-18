/**
 * Tests for `greenlight shipcheck` (v0.10.1): independent verification
 * of every release-chain link, with a fixture reproducing the F1
 * failure exactly (tag ref present, commit object missing).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFetchImpl } from "../src/github.js";
import { runShipcheck, type HttpGet } from "../src/shipcheck.js";

const OWNER = "acme";
const REPO = "widgets";
const VERSION = "1.2.3";
const SHA = "abc123def456abc123def456abc123def456abc1";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

interface Route {
  match: (path: string, search: string) => boolean;
  status: number;
  body: unknown;
}

/** Route GitHub API paths to canned responses; unmatched paths 404. */
function mockGithub(routes: Route[]) {
  const impl = (async (url: string) => {
    const u = new URL(url);
    const path = u.pathname;
    const search = u.search;
    for (const r of routes) {
      if (r.match(path, search)) {
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  setFetchImpl(impl);
}

const TAG_REF = `/repos/${OWNER}/${REPO}/git/ref/tags/v${VERSION}`;

function healthyGithub(): void {
  mockGithub([
    { match: (p) => p === TAG_REF, status: 200, body: { object: { sha: SHA } } },
    { match: (p) => p === `/repos/${OWNER}/${REPO}/git/commits/${SHA}`, status: 200, body: { sha: SHA } },
    {
      match: (p) => p === `/repos/${OWNER}/${REPO}/contents/package.json`,
      status: 200,
      body: { content: b64({ name: "@acme/widgets", version: VERSION }), encoding: "base64" },
    },
    { match: (p) => p === `/repos/${OWNER}/${REPO}/releases/tags/v${VERSION}`, status: 200, body: { id: 9 } },
  ]);
}

function healthyHttp(): HttpGet {
  return async (url: string) => {
    if (url.includes("registry.npmjs.org")) {
      return {
        status: 200,
        json: async () => ({ versions: { [VERSION]: {} } }),
        text: async () => "",
      };
    }
    // MCP registry
    return {
      status: 200,
      json: async () => ({
        servers: [
          {
            server: { name: "io.github.acme/widgets", version: VERSION },
            _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
          },
        ],
      }),
      text: async () => "",
    };
  };
}

describe("runShipcheck", () => {
  afterEach(() => setFetchImpl(null));

  it("passes when every link of the chain is intact", async () => {
    healthyGithub();
    const r = await runShipcheck({
      owner: OWNER,
      repo: REPO,
      version: VERSION,
      npmPackage: "@acme/widgets",
      mcpName: "io.github.acme/widgets",
      httpGet: healthyHttp(),
    });
    assert.equal(r.pass, true);
    assert.deepEqual(
      r.links.map((l) => l.id),
      ["tag", "commit", "package-json", "release", "npm", "registry"]
    );
    assert.ok(r.links.every((l) => l.ok));
  });

  it("names the commit link when the tag dangles (the F1 failure)", async () => {
    mockGithub([
      { match: (p) => p === TAG_REF, status: 200, body: { object: { sha: SHA } } },
      // the commit object is gone: exactly what the v0.9.3 tag did
      { match: (p) => p === `/repos/${OWNER}/${REPO}/git/commits/${SHA}`, status: 404, body: { message: "Not Found" } },
      {
        match: (p) => p === `/repos/${OWNER}/${REPO}/contents/package.json`,
        status: 200,
        body: { content: b64({ name: "@acme/widgets", version: VERSION }), encoding: "base64" },
      },
      { match: (p) => p === `/repos/${OWNER}/${REPO}/releases/tags/v${VERSION}`, status: 200, body: { id: 9 } },
    ]);
    const r = await runShipcheck({
      owner: OWNER,
      repo: REPO,
      version: VERSION,
      npmPackage: "@acme/widgets",
      mcpName: "io.github.acme/widgets",
      httpGet: healthyHttp(),
    });
    assert.equal(r.pass, false);
    const broken = r.links.filter((l) => !l.ok);
    assert.equal(broken.length, 1);
    assert.equal(broken[0].id, "commit");
    assert.match(broken[0].detail, /dangling/);
    assert.match(broken[0].detail, /404/);
  });

  it("fails when the tag ref is missing", async () => {
    mockGithub([]);
    const r = await runShipcheck({
      owner: OWNER,
      repo: REPO,
      version: VERSION,
      npmPackage: "@acme/widgets",
      mcpName: "io.github.acme/widgets",
      httpGet: healthyHttp(),
    });
    assert.equal(r.pass, false);
    assert.equal(r.links[0].id, "tag");
    assert.equal(r.links[0].ok, false);
  });

  it("fails when package.json at the tag carries a different version", async () => {
    mockGithub([
      { match: (p) => p === TAG_REF, status: 200, body: { object: { sha: SHA } } },
      { match: (p) => p === `/repos/${OWNER}/${REPO}/git/commits/${SHA}`, status: 200, body: { sha: SHA } },
      {
        match: (p) => p === `/repos/${OWNER}/${REPO}/contents/package.json`,
        status: 200,
        body: { content: b64({ name: "@acme/widgets", version: "1.2.2" }), encoding: "base64" },
      },
      { match: (p) => p === `/repos/${OWNER}/${REPO}/releases/tags/v${VERSION}`, status: 200, body: { id: 9 } },
    ]);
    const r = await runShipcheck({
      owner: OWNER,
      repo: REPO,
      version: VERSION,
      npmPackage: "@acme/widgets",
      httpGet: healthyHttp(),
    });
    assert.equal(r.pass, false);
    const pkg = r.links.find((l) => l.id === "package-json");
    assert.equal(pkg?.ok, false);
    assert.match(pkg?.detail ?? "", /1\.2\.2/);
  });

  it("fails when npm has no such version", async () => {
    healthyGithub();
    const http: HttpGet = async (url: string) => {
      if (url.includes("registry.npmjs.org")) {
        return { status: 200, json: async () => ({ versions: { "1.2.2": {} } }), text: async () => "" };
      }
      return healthyHttp()(url);
    };
    const r = await runShipcheck({
      owner: OWNER,
      repo: REPO,
      version: VERSION,
      npmPackage: "@acme/widgets",
      httpGet: http,
    });
    assert.equal(r.pass, false);
    assert.equal(r.links.find((l) => l.id === "npm")?.ok, false);
  });

  it("fails when the registry has no active record for the version", async () => {
    healthyGithub();
    const http: HttpGet = async (url: string) => {
      if (url.includes("registry.modelcontextprotocol.io")) {
        return {
          status: 200,
          json: async () => ({
            servers: [
              {
                server: { name: "io.github.acme/widgets", version: "1.2.2" },
                _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
              },
            ],
          }),
          text: async () => "",
        };
      }
      return healthyHttp()(url);
    };
    const r = await runShipcheck({
      owner: OWNER,
      repo: REPO,
      version: VERSION,
      npmPackage: "@acme/widgets",
      mcpName: "io.github.acme/widgets",
      httpGet: http,
    });
    assert.equal(r.pass, false);
    assert.equal(r.links.find((l) => l.id === "registry")?.ok, false);
  });

  it("skips the registry check when no MCP name is known", async () => {
    healthyGithub();
    // Run from an empty directory so no local package.json/server.json
    // can resolve names: the mock API has no server.json for acme/widgets.
    const prev = process.cwd();
    const empty = mkdtempSync(join(tmpdir(), "sc-empty-"));
    process.chdir(empty);
    try {
      const r = await runShipcheck({
        owner: OWNER,
        repo: REPO,
        version: VERSION,
        npmPackage: "@acme/widgets",
        httpGet: healthyHttp(),
      });
      // mcpName cannot resolve, so the registry link is skipped-but-ok,
      // not a failure.
      const reg = r.links.find((l) => l.id === "registry");
      assert.equal(reg?.ok, true);
      assert.match(reg?.detail ?? "", /skipped/);
      assert.equal(r.pass, true);
    } finally {
      process.chdir(prev);
    }
  });
});
