/**
 * Tests for the v0.12.0 Claim Protocol hosted-API client (src/claim-api.ts):
 * device-flow polling (mocked), the installed/not-installed/404 fallback
 * matrix, the TAKEN-by-other refusal and queue_ok path, 401 re-auth,
 * comment body format, token storage, and the MCP tool implementations.
 * All network is mocked; nothing touches the live API or a real keychain.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaimApiClient,
  ApiError,
  FileTokenStore,
  chooseViaApiPath,
  deviceFlowLogin,
  browserLoginFlow,
  mcpApiStatus,
  mcpClaimViaApi,
  mcpHeartbeatViaApi,
  resolveApiBase,
  resolveApiToken,
  readApiConfig,
  statusConfirmsLogin,
  viaApiClaim,
  viaApiRelease,
  viaApiHeartbeat,
  DEFAULT_API_BASE,
  type ResolvedToken,
  type StoredToken,
  type TokenStore,
} from "../src/claim-api.js";
import { CLAIM_MARKER } from "../src/protocol.js";
import { buildClaimComment } from "../src/automate.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function mockFetch(
  handler: (url: string, init: { method?: string; body?: string }) => { status: number; body: unknown }
): typeof fetch {
  return (async (url: unknown, init: unknown) => {
    const r = handler(String(url), { method: (init as { method?: string })?.method, body: (init as { body?: string })?.body });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  }) as typeof fetch;
}

function memStore(initial: StoredToken | null = null): TokenStore & { saved: StoredToken[] } {
  let current = initial;
  const saved: StoredToken[] = [];
  return {
    saved,
    async get() {
      return current;
    },
    async set(t) {
      current = t;
      saved.push(t);
    },
    async clear() {
      current = null;
    },
    describe() {
      return "memory (test)";
    },
  };
}

const TEST_HOME = () => mkdtempSync(join(tmpdir(), "gl-claim-home-"));
const ISSUE = { owner: "o", repo: "r", number: 1, url: "https://github.com/o/r/issues/1" };

const FREE_STATUS = { verdict: "GO", title: "Fix the thing", active: null, queue: [] };
const TAKEN_STATUS = {
  verdict: "TAKEN",
  title: "Fix the thing",
  active: { claimant: "alice", expires_at: "2026-10-25T00:00:00.000Z", state: "active" },
  queue: [],
};
const CONFIRMED_STATUS = {
  verdict: "TAKEN",
  title: "Fix the thing",
  active: { claimant: "tester", expires_at: "2026-10-25T00:00:00.000Z", state: "active" },
  queue: [],
};

const githubToken = (login: string | null = "tester"): StoredToken => ({
  token: "ghp_test",
  kind: "github",
  login,
  storedAt: "2026-10-18T00:00:00.000Z",
});

/** Deps for via-api flows: injected store, empty env (no ambient tokens), captured print lines. */
function deps(overrides: Record<string, unknown> = {}) {
  const printed: string[] = [];
  return {
    deps: {
      store: memStore(githubToken()),
      env: {},
      home: TEST_HOME(),
      print: (line: string) => printed.push(line),
      ...overrides,
    } as Parameters<typeof viaApiClaim>[2],
    printed,
  };
}

// ---------------------------------------------------------------------------
// API base config
// ---------------------------------------------------------------------------

describe("API base config", () => {
  it("defaults to the hosted instance", () => {
    assert.equal(resolveApiBase({ home: TEST_HOME(), env: {} }), DEFAULT_API_BASE);
  });

  it("--api-base wins, is cached, and the cache is reused", () => {
    const home = TEST_HOME();
    const first = resolveApiBase({ flag: "https://api.example.test", home, env: {} });
    assert.equal(first, "https://api.example.test");
    assert.equal(readApiConfig(home)?.apiBase, "https://api.example.test");
    assert.equal(resolveApiBase({ home, env: {} }), "https://api.example.test");
  });

  it("env beats the cached file", () => {
    const home = TEST_HOME();
    resolveApiBase({ flag: "https://cached.example", home, env: {} });
    assert.equal(resolveApiBase({ home, env: { GREENLIGHT_API_BASE: "https://env.example" } }), "https://env.example");
  });
});

// ---------------------------------------------------------------------------
// File token store
// ---------------------------------------------------------------------------

describe("FileTokenStore", () => {
  it("round-trips a token and keeps the file 0600", async () => {
    const home = TEST_HOME();
    const store = new FileTokenStore(home);
    await store.set(githubToken());
    const mode = statSync(join(home, ".greenlight", "api-token")).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    const got = await store.get();
    assert.equal(got?.token, "ghp_test");
    assert.equal(got?.kind, "github");
    assert.equal(got?.login, "tester");
    await store.clear();
    assert.equal(await store.get(), null);
  });

  it("resolves --token flag over env over the store", async () => {
    const store = memStore(githubToken("stored-login"));
    const fromFlag = await resolveApiToken({ flag: "ghp_flag", env: {}, store });
    assert.equal(fromFlag?.token, "ghp_flag");
    assert.equal(fromFlag?.source, "flag");
    const fromEnv = await resolveApiToken({ env: { GREENLIGHT_API_TOKEN: "ghp_env" }, store });
    assert.equal(fromEnv?.token, "ghp_env");
    assert.equal(fromEnv?.source, "env");
    const fromStore = await resolveApiToken({ env: {}, store });
    assert.equal(fromStore?.token, "ghp_test");
    assert.equal(fromStore?.source, "store");
    assert.equal(await resolveApiToken({ env: {}, store: memStore(null) }), null);
  });
});

// ---------------------------------------------------------------------------
// Device flow (mocked)
// ---------------------------------------------------------------------------

function deviceFetch(pollResponses: Array<{ status: number; body: unknown }>) {
  const calls: string[] = [];
  let polls = 0;
  const fetchImpl = mockFetch((url) => {
    calls.push(url);
    if (url.includes("/login/device/code")) {
      return {
        status: 200,
        body: {
          device_code: "dc1",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        },
      };
    }
    if (url.includes("/login/oauth/access_token")) {
      return pollResponses[Math.min(polls++, pollResponses.length - 1)];
    }
    if (url.includes("api.github.com/user")) {
      return { status: 200, body: { login: "tester" } };
    }
    return { status: 500, body: {} };
  });
  return { fetchImpl, calls };
}

describe("device flow login (mocked)", () => {
  it("polls through authorization_pending, stores the GitHub token", async () => {
    const { fetchImpl, calls } = deviceFetch([
      { status: 200, body: { error: "authorization_pending" } },
      { status: 200, body: { error: "slow_down" } },
      { status: 200, body: { access_token: "gho_device_token" } },
    ]);
    const store = memStore(null);
    const codes: Array<[string, string]> = [];
    const result = await deviceFlowLogin({
      fetchImpl,
      store,
      pollIntervalMs: 10,
      onCode: (code, uri) => codes.push([code, uri]),
    });
    assert.equal(result.token, "gho_device_token");
    assert.equal(result.kind, "github");
    assert.equal(result.login, "tester");
    assert.deepEqual(codes, [["ABCD-1234", "https://github.com/login/device"]]);
    assert.ok(calls.some((c) => c.includes("/login/device/code")));
    assert.equal(store.saved.length, 1);
    assert.equal(store.saved[0].kind, "github");
  });

  it("throws a clear error on expired_token", async () => {
    const { fetchImpl } = deviceFetch([{ status: 200, body: { error: "expired_token" } }]);
    await assert.rejects(
      () => deviceFlowLogin({ fetchImpl, store: memStore(null), pollIntervalMs: 10 }),
      /expired/i
    );
  });

  it("throws on access_denied and on timeout", async () => {
    const denied = deviceFetch([{ status: 200, body: { error: "access_denied" } }]);
    await assert.rejects(
      () => deviceFlowLogin({ fetchImpl: denied.fetchImpl, store: memStore(null), pollIntervalMs: 10 }),
      /denied/i
    );
    const hanging = deviceFetch([{ status: 200, body: { error: "authorization_pending" } }]);
    await assert.rejects(
      () => deviceFlowLogin({ fetchImpl: hanging.fetchImpl, store: memStore(null), pollIntervalMs: 20, timeoutMs: 120 }),
      /timed out/i
    );
  });

  it("browser flow stores the pasted session token", async () => {
    const store = memStore(null);
    const opened: string[] = [];
    const result = await browserLoginFlow({
      apiBase: "https://api.example.test",
      store,
      openUrl: async (url) => {
        opened.push(url);
      },
      promptToken: async () => "sess_pasted",
    });
    assert.equal(result.token, "sess_pasted");
    assert.equal(result.kind, "session");
    assert.ok(opened[0].includes("/auth/github/login"));
    assert.equal(store.saved[0].kind, "session");
  });
});

// ---------------------------------------------------------------------------
// App-aware path selection matrix
// ---------------------------------------------------------------------------

describe("chooseViaApiPath matrix", () => {
  const base = "https://api.example.test";
  const clientFor = (handler: (url: string) => { status: number; body: unknown }) =>
    new ClaimApiClient({ base, token: "t", fetchImpl: mockFetch(handler) });

  it("installed -> app backend, no note", async () => {
    const client = clientFor(() => ({ status: 200, body: { installed: true, app_slug: "greenlight-claims" } }));
    const choice = await chooseViaApiPath(client, "o", "r");
    assert.equal(choice.path, "app");
    assert.equal(choice.note, null);
  });

  it("installed:false -> direct path with the one-line note", async () => {
    const client = clientFor(() => ({ status: 200, body: { installed: false } }));
    const choice = await chooseViaApiPath(client, "o", "r");
    assert.equal(choice.path, "direct");
    assert.ok(choice.note?.includes("not installed on o/r"), `note: ${choice.note}`);
  });

  it("404 (backend older than v1.0.0) -> direct path with the note", async () => {
    const client = clientFor(() => ({ status: 404, body: { error: "not-found" } }));
    const choice = await chooseViaApiPath(client, "o", "r");
    assert.equal(choice.path, "direct");
    assert.ok(choice.note?.includes("not installed on o/r"));
  });

  it("connection failure -> direct path with the note, never silent", async () => {
    const client = new ClaimApiClient({
      base,
      token: "t",
      fetchImpl: (async () => {
        throw new Error("socket hangup");
      }) as typeof fetch,
    });
    const choice = await chooseViaApiPath(client, "o", "r");
    assert.equal(choice.path, "direct");
    assert.ok(choice.note?.includes("not installed on o/r"));
  });
});

// ---------------------------------------------------------------------------
// viaApiClaim
// ---------------------------------------------------------------------------

function apiFetch(scen: {
  status?: unknown;
  installation?: { status: number; body: unknown } | "throw";
  claims?: Array<{ status: number; body: unknown }>;
  statusReread?: unknown;
}) {
  const calls: Array<{ method?: string; url: string; body?: string }> = [];
  let claimCalls = 0;
  const fetchImpl = mockFetch((url, init) => {
    calls.push({ method: init.method, url, body: init.body });
    if (url.includes("/v1/issues/") && url.includes("/status")) {
      if (calls.filter((c) => c.url.includes("/status")).length > 1 && scen.statusReread !== undefined) {
        return { status: 200, body: scen.statusReread };
      }
      if (scen.status === "throw") throw new Error("socket hangup");
      return { status: 200, body: scen.status ?? FREE_STATUS };
    }
    if (url.includes("/v1/app/repos/")) {
      if (scen.installation === "throw") throw new Error("socket hangup");
      const r = scen.installation ?? { status: 200, body: { installed: true } };
      return r;
    }
    if (url.includes("/v1/claims") && init.method === "POST") {
      const r = (scen.claims ?? [{ status: 201, body: { action: "claimed", posted: true } }])[Math.min(claimCalls++, (scen.claims ?? []).length - 1)];
      return r;
    }
    return { status: 500, body: {} };
  });
  return { fetchImpl, calls };
}

describe("viaApiClaim", () => {
  it("refuses TAKEN-by-other without --queue-ok, naming holder and expiry", async () => {
    const { deps: d, printed } = deps({ fetchImpl: apiFetch({ status: TAKEN_STATUS }).fetchImpl });
    const result = await viaApiClaim(ISSUE, { yes: true }, d);
    assert.equal(result.outcome, "refused-taken");
    assert.ok(result.message.includes("@alice"), result.message);
    assert.ok(result.message.includes("2026-10-25"), result.message);
    assert.ok(result.message.includes("--queue-ok"), result.message);
    assert.equal(printed.length, 0, "no note printed before refusal");
  });

  it("with --queue-ok the TAKEN issue goes through the app path and queues", async () => {
    const { fetchImpl, calls } = apiFetch({
      status: TAKEN_STATUS,
      installation: { status: 200, body: { installed: true } },
      claims: [
        {
          status: 201,
          body: { action: "claimed", posted: true, comment_url: "https://github.com/o/r/issues/1#c2", queue_position: 2 },
        },
      ],
      statusReread: { verdict: "TAKEN", active: { claimant: "alice", expires_at: "2026-10-25T00:00:00.000Z" }, queue: [{ claimant: "tester", position: 2 }] },
    });
    const { deps: d } = deps({ fetchImpl });
    const result = await viaApiClaim(ISSUE, { yes: true, queueOk: true }, d);
    assert.equal(result.outcome, "queued");
    assert.equal(result.queuePosition, 2);
    assert.equal(result.path, "app");
    assert.equal(result.note, null);
    const post = calls.find((c) => c.url.includes("/v1/claims") && c.method === "POST");
    assert.ok(post, "POST /v1/claims was made");
    assert.equal((JSON.parse(post!.body ?? "{}") as { queue_ok?: boolean }).queue_ok, true);
  });

  it("app-path success is verified by re-reading the status", async () => {
    const { fetchImpl } = apiFetch({
      claims: [
        { status: 201, body: { action: "claimed", posted: true, comment_url: "https://github.com/o/r/issues/1#c1", queue_position: 1 } },
      ],
      statusReread: CONFIRMED_STATUS,
    });
    const { deps: d } = deps({ fetchImpl });
    const result = await viaApiClaim(ISSUE, { yes: true, plan: "fix it", etaDays: 3 }, d);
    assert.equal(result.outcome, "claimed");
    assert.equal(result.commentUrl, "https://github.com/o/r/issues/1#c1");
    assert.ok(!result.message.includes("did not confirm"), result.message);
  });

  it("when the re-read cannot confirm, it says to check the comment URL", async () => {
    const { fetchImpl } = apiFetch({
      claims: [
        { status: 201, body: { action: "claimed", posted: true, comment_url: "https://github.com/o/r/issues/1#c1", queue_position: 1 } },
      ],
      statusReread: FREE_STATUS,
    });
    const { deps: d } = deps({ fetchImpl });
    const result = await viaApiClaim(ISSUE, { yes: true }, d);
    assert.equal(result.outcome, "claimed");
    assert.ok(result.message.includes("check https://github.com/o/r/issues/1#c1"), result.message);
  });

  it("server 409 claim-held renders the same refusal (session-token path)", async () => {
    const { fetchImpl } = apiFetch({
      status: { verdict: "GO", active: null, queue: [] },
      claims: [
        {
          status: 409,
          body: { error: "claim-held", message: "held", holder: { claimant: "bob", expires_at: "2026-10-26T00:00:00.000Z" } },
        },
      ],
    });
    const session = memStore({ token: "sess", kind: "session", login: null, storedAt: "x" });
    const { deps: d } = deps({ fetchImpl, store: session });
    const result = await viaApiClaim(ISSUE, { yes: true }, d);
    assert.equal(result.outcome, "refused-taken");
    assert.ok(result.message.includes("@bob"), result.message);
    assert.ok(result.message.includes("--queue-ok"), result.message);
  });

  it("already-claimed is reported, not reposted", async () => {
    const { fetchImpl } = apiFetch({
      claims: [{ status: 200, body: { action: "already-claimed", posted: false } }],
    });
    const { deps: d } = deps({ fetchImpl });
    const result = await viaApiClaim(ISSUE, { yes: true }, d);
    assert.equal(result.outcome, "already-claimed");
  });

  it("401 re-runs the device flow once, then retries", async () => {
    const { fetchImpl } = apiFetch({
      claims: [
        { status: 401, body: { error: "invalid-token", message: "bad token" } },
        { status: 201, body: { action: "claimed", posted: true, comment_url: "https://github.com/o/r/issues/1#c1", queue_position: 1 } },
      ],
      statusReread: CONFIRMED_STATUS,
    });
    let relogins = 0;
    const relogin = async (): Promise<ResolvedToken> => {
      relogins++;
      return { token: "gho_fresh", kind: "github", login: "tester", source: "store" };
    };
    const { deps: d, printed } = deps({ fetchImpl, relogin });
    const result = await viaApiClaim(ISSUE, { yes: true }, d);
    assert.equal(relogins, 1, "device flow re-ran exactly once");
    assert.equal(result.outcome, "claimed");
    assert.ok(printed.some((l) => l.includes("401")), printed.join("\n"));
  });

  it("a second 401 stops with the manual steps", async () => {
    const { fetchImpl } = apiFetch({
      claims: [
        { status: 401, body: { error: "invalid-token", message: "bad" } },
        { status: 401, body: { error: "invalid-token", message: "bad" } },
      ],
    });
    const relogin = async (): Promise<ResolvedToken> => ({ token: "gho_fresh", kind: "github", login: "tester", source: "store" });
    const { deps: d } = deps({ fetchImpl, relogin });
    const result = await viaApiClaim(ISSUE, { yes: true }, d);
    assert.equal(result.outcome, "auth-failed");
    assert.ok(result.message.includes("Manual steps"), result.message);
    assert.ok(result.message.includes("GREENLIGHT_API_TOKEN"), result.message);
  });

  it("not-installed falls back to the direct path and prints the note", async () => {
    const { fetchImpl } = apiFetch({
      installation: { status: 404, body: { error: "not-found" } },
    });
    const directCalls: unknown[] = [];
    const { deps: d, printed } = deps({
      fetchImpl,
      directClaim: async (a) => {
        directCalls.push(a);
        return { posted: true, commentUrl: "https://github.com/o/r/issues/1#c9", commentBody: "plain protocol comment" };
      },
    });
    const result = await viaApiClaim(ISSUE, { yes: true, plan: "fix it" }, d);
    assert.equal(result.path, "direct");
    assert.ok(result.note?.includes("not installed on o/r"), `note: ${result.note}`);
    assert.ok(printed.some((l) => l.includes("not installed on o/r")), "the note was printed, never silent");
    assert.equal(directCalls.length, 1, "direct fallback ran");
    assert.equal(result.outcome, "claimed");
    assert.equal(result.commentUrl, "https://github.com/o/r/issues/1#c9");
  });

  it("direct fallback without a GitHub token explains GITHUB_TOKEN", async () => {
    const { fetchImpl } = apiFetch({ installation: { status: 404, body: { error: "not-found" } } });
    const session = memStore({ token: "sess", kind: "session", login: null, storedAt: "x" });
    const { deps: d } = deps({ fetchImpl, store: session });
    const result = await viaApiClaim(ISSUE, { yes: true }, d);
    assert.equal(result.path, "direct");
    assert.equal(result.outcome, "direct-fallback");
    assert.ok(result.message.includes("GITHUB_TOKEN"), result.message);
  });

  it("no stored token refuses with the auth login instructions", async () => {
    const { deps: d } = deps({ store: memStore(null) });
    const result = await viaApiClaim(ISSUE, { yes: true }, d);
    assert.equal(result.outcome, "no-token");
    assert.ok(result.message.includes("greenlight auth login"), result.message);
  });

  it("unreachable API offers the hand-post path", async () => {
    const { fetchImpl } = apiFetch({ status: "throw" });
    const { deps: d } = deps({ fetchImpl });
    const result = await viaApiClaim(ISSUE, { yes: true }, d);
    assert.equal(result.outcome, "api-unreachable");
    assert.ok(result.message.includes("unreachable"), result.message);
    assert.ok(result.message.includes("greenlight claim https://github.com/o/r/issues/1"), result.message);
  });

  it("dry run posts nothing and shows the plan", async () => {
    const { fetchImpl, calls } = apiFetch({});
    const { deps: d } = deps({ fetchImpl });
    const result = await viaApiClaim(ISSUE, { plan: "fix it", etaDays: 3 }, d);
    assert.equal(result.outcome, "dry-run");
    assert.ok(!calls.some((c) => c.method === "POST"), "no POST in a dry run");
    assert.ok(result.commentBody?.includes(CLAIM_MARKER), "marker present");
    assert.ok(result.commentBody?.includes("plan: fix it"), "plan line present");
    assert.ok(result.commentBody?.includes("eta-days: 3"), "eta-days line present");
  });
});

// ---------------------------------------------------------------------------
// Release and heartbeat
// ---------------------------------------------------------------------------

describe("viaApiRelease / viaApiHeartbeat", () => {
  const releaseFetch = (handler: (url: string, init: { method?: string; body?: string }) => { status: number; body: unknown }) =>
    mockFetch(handler);

  it("release through the app backend posts and confirms", async () => {
    const fetchImpl = releaseFetch((url, init) => {
      if (url.includes("/v1/app/repos/")) return { status: 200, body: { installed: true } };
      if (url.includes("/v1/claims/release")) {
        return { status: 201, body: { action: "released", posted: true, comment_url: "https://github.com/o/r/issues/1#c3" } };
      }
      if (url.includes("/status")) return { status: 200, body: FREE_STATUS };
      return { status: 500, body: {} };
    });
    const { deps: d } = deps({ fetchImpl });
    const result = await viaApiRelease(ISSUE, { yes: true }, d);
    assert.equal(result.outcome, "done");
    assert.equal(result.path, "app");
    assert.ok(result.message.includes("Release posted"), result.message);
  });

  it("release 409 no-active-claim is refused with the server message", async () => {
    const fetchImpl = releaseFetch((url, init) => {
      if (url.includes("/v1/app/repos/")) return { status: 200, body: { installed: true } };
      if (url.includes("/v1/claims/release")) {
        return { status: 409, body: { error: "no-active-claim", message: "There is no active protocol claim on this issue to release." } };
      }
      return { status: 500, body: {} };
    });
    const { deps: d } = deps({ fetchImpl });
    const result = await viaApiRelease(ISSUE, { yes: true }, d);
    assert.equal(result.outcome, "refused");
    assert.ok(result.message.includes("no active protocol claim"), result.message);
  });

  it("release falls back to the direct marker path with the note", async () => {
    const fetchImpl = releaseFetch((url) => {
      if (url.includes("/v1/app/repos/")) return { status: 404, body: { error: "not-found" } };
      return { status: 500, body: {} };
    });
    const markers: unknown[] = [];
    const { deps: d, printed } = deps({
      fetchImpl,
      directMarker: async (a) => {
        markers.push(a);
        return { posted: true, commentUrl: "https://github.com/o/r/issues/1#c4" };
      },
    });
    const result = await viaApiRelease(ISSUE, { yes: true }, d);
    assert.equal(result.path, "direct");
    assert.ok(printed.some((l) => l.includes("not installed on o/r")));
    assert.equal(markers.length, 1);
    assert.ok((markers[0] as { body: string }).body.includes("<!-- greenlight-claim release -->"));
    assert.equal(result.outcome, "done");
  });

  it("heartbeat dry run shows the marker without posting", async () => {
    const fetchImpl = releaseFetch((url) => {
      if (url.includes("/v1/app/repos/")) return { status: 200, body: { installed: true } };
      return { status: 500, body: {} };
    });
    const { deps: d } = deps({ fetchImpl });
    const result = await viaApiHeartbeat(ISSUE, { mode: "reaction" }, d);
    assert.equal(result.outcome, "done");
    assert.ok(result.message.includes("Dry run"), result.message);
    assert.ok(result.message.includes("<!-- greenlight-claim v1 -->"), result.message);
  });
});

// ---------------------------------------------------------------------------
// Comment body format (byte-compatible with the protocol marker)
// ---------------------------------------------------------------------------

describe("claim comment body format", () => {
  it("carries the v1 marker plus plan and eta-days lines", () => {
    const body = buildClaimComment(
      { title: "Fix the thing" } as never,
      [],
      "tester",
      { plan: "repro, fix, test", etaDays: 5 }
    );
    assert.ok(body.includes(CLAIM_MARKER), "protocol marker present");
    assert.ok(body.includes("plan: repro, fix, test"), "plan line present");
    assert.ok(body.includes("eta-days: 5"), "eta-days line present");
  });

  it("the comment body is byte-compatible with the protocol marker format", () => {
    const body = buildClaimComment(
      { title: "Fix the thing" } as never,
      [],
      "tester",
      { plan: "x", etaDays: 1 }
    );
    assert.ok(body.includes("<!-- greenlight-claim v1 -->"), "same marker the server-side builder uses");
  });
});

// ---------------------------------------------------------------------------
// statusConfirmsLogin
// ---------------------------------------------------------------------------

describe("statusConfirmsLogin", () => {
  it("matches the active claimant and queue members, case-insensitively", () => {
    assert.equal(statusConfirmsLogin(CONFIRMED_STATUS, "tester"), true);
    assert.equal(statusConfirmsLogin(CONFIRMED_STATUS, "TESTER"), true);
    assert.equal(statusConfirmsLogin(FREE_STATUS, "tester"), false);
    assert.equal(statusConfirmsLogin(CONFIRMED_STATUS, null), false);
    assert.equal(
      statusConfirmsLogin({ active: { claimant: "alice" }, queue: [{ claimant: "tester", position: 2 }] }, "tester"),
      true
    );
  });
});

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

describe("MCP tools", () => {
  it("api_status returns the hosted status payload", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.includes("/status")) return { status: 200, body: FREE_STATUS };
      return { status: 404, body: {} };
    });
    const out = (await mcpApiStatus(
      { issue_url: "https://github.com/o/r/issues/1" },
      { fetchImpl, env: {}, home: TEST_HOME() }
    )) as { verdict: string };
    assert.equal(out.verdict, "GO");
  });

  it("api_status reports an error object on a bad URL", async () => {
    const out = (await mcpApiStatus({ issue_url: "not-a-url" }, { env: {}, home: TEST_HOME() })) as { error: string };
    assert.ok(out.error.includes("issue URL"), out.error);
  });

  it("claim_via_api dry run needs no token and never posts", async () => {
    const { fetchImpl, calls } = apiFetch({ status: FREE_STATUS });
    const out = (await mcpClaimViaApi(
      { issue_url: "https://github.com/o/r/issues/1", plan: "x", eta_days: 2 },
      { fetchImpl, store: memStore(null), env: {}, home: TEST_HOME() }
    )) as { outcome: string; commentBody?: string; path?: string };
    assert.equal(out.outcome, "dry-run");
    assert.ok(out.commentBody?.includes(CLAIM_MARKER));
    assert.ok(!calls.some((c) => c.method === "POST"), "report mode never posts");
  });

  it("claim_via_api with execute and no token refuses with the login instructions", async () => {
    const { fetchImpl } = apiFetch({ status: FREE_STATUS });
    const out = (await mcpClaimViaApi(
      { issue_url: "https://github.com/o/r/issues/1", execute: true },
      { fetchImpl, store: memStore(null), env: {}, home: TEST_HOME() }
    )) as { outcome: string; message: string };
    assert.equal(out.outcome, "no-token");
    assert.ok(out.message.includes("greenlight auth login"), out.message);
  });

  it("claim_via_api execute through the app path posts and confirms", async () => {
    const { fetchImpl } = apiFetch({
      status: FREE_STATUS,
      claims: [
        { status: 201, body: { action: "claimed", posted: true, comment_url: "https://github.com/o/r/issues/1#c1", queue_position: 1 } },
      ],
      statusReread: CONFIRMED_STATUS,
    });
    const out = (await mcpClaimViaApi(
      { issue_url: "https://github.com/o/r/issues/1", execute: true },
      { fetchImpl, store: memStore(githubToken()), env: {}, home: TEST_HOME() }
    )) as { outcome: string; commentUrl?: string };
    assert.equal(out.outcome, "claimed");
    assert.equal(out.commentUrl, "https://github.com/o/r/issues/1#c1");
  });

  it("heartbeat_via_api dry run needs no token and never posts", async () => {
    const { fetchImpl, calls } = apiFetch({ status: FREE_STATUS });
    const out = (await mcpHeartbeatViaApi(
      { issue_url: "https://github.com/o/r/issues/1" },
      { fetchImpl, store: memStore(null), env: {}, home: TEST_HOME() }
    )) as { outcome: string; message: string };
    assert.equal(out.outcome, "done");
    assert.ok(out.message.includes("Dry run"), out.message);
    assert.ok(!calls.some((c) => c.method === "POST"), "report mode never posts");
  });
});

// ---------------------------------------------------------------------------
// ApiError shape
// ---------------------------------------------------------------------------

describe("ApiError", () => {
  it("carries status, code, and payload", async () => {
    const client = new ClaimApiClient({
      base: "https://api.example.test",
      token: "t",
      fetchImpl: mockFetch(() => ({ status: 409, body: { error: "claim-held", message: "held", holder: { claimant: "x" } } })),
    });
    await assert.rejects(() => client.issueStatus("o", "r", 1), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "claim-held");
      return true;
    });
  });
});
