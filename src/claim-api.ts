/**
 * Greenlight Claim Protocol hosted-API client (v0.12.0).
 *
 * This module implements `greenlight auth login`, `greenlight claim
 * --via-api`, `greenlight release --via-api`, `greenlight heartbeat
 * --via-api`, and the MCP tools api_status / claim_via_api /
 * heartbeat_via_api. It speaks to the claim-api service (default
 * https://claim-api-wine.vercel.app, the existing hosted instance) and
 * adds the app-aware path selection: before any --via-api write, the
 * client asks the backend whether the Greenlight Claims app is installed
 * on the target repo. Installed -> the claim goes through the app backend
 * (POST /v1/claims; the server posts the protocol comment as the caller
 * and the webhook records durable state). Not installed, or the
 * installation endpoint missing (backend older than v1.0.0), or the API
 * unreachable on that route -> the client falls back to the current
 * direct-API comment path and prints a one-line note naming that the app
 * is not installed. The downgrade is never silent.
 *
 * Auth: `greenlight auth login` runs GitHub's OAuth device flow against
 * the claim-api OAuth app's client id and stores the resulting GitHub
 * user token (public_repo scope). `auth login --browser` walks the
 * browser OAuth grant and stores the pasted session token. Option 3 is
 * passthrough: --token or GREENLIGHT_API_TOKEN.
 *
 * Token storage: OS keychain first (macOS `security`, Linux
 * `secret-tool`); when neither is available, ~/.greenlight/api-token
 * with 0600 permissions. The store records the token kind (a raw GitHub
 * token from the device flow or passthrough, or a claim-api session
 * token from the browser flow) so the direct-comment fallback knows
 * whether it can post as the caller without another env var.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

export const DEFAULT_API_BASE = "https://claim-api-wine.vercel.app";
/**
 * The claim-api OAuth app client id. Read from the live instance's
 * /auth/github/login redirect (2026-10-18); override with
 * GREENLIGHT_OAUTH_CLIENT_ID or --client-id when the app rotates.
 */
export const DEFAULT_OAUTH_CLIENT_ID = "Ov23liv9yM4RTci0UysE";
export const GITHUB_DEVICE_BASE = "https://github.com";
export const GITHUB_API_BASE = "https://api.github.com";
/** Claim Protocol marker; the fallback comment is byte-compatible with it. */
export const CLAIM_MARKER_V1 = "<!-- greenlight-claim v1 -->";

type FetchImpl = typeof fetch;

// ---------------------------------------------------------------------------
// API base config (~/.config/greenlight/config.json)
// ---------------------------------------------------------------------------

export interface ApiConfig {
  apiBase: string;
}

export function configFilePath(home: string = homedir()): string {
  return join(home, ".config", "greenlight", "config.json");
}

export function readApiConfig(home: string = homedir()): ApiConfig | null {
  try {
    const raw = readFileSync(configFilePath(home), "utf8");
    const parsed = JSON.parse(raw) as { apiBase?: unknown };
    if (typeof parsed.apiBase === "string" && parsed.apiBase.trim().length > 0) {
      return { apiBase: parsed.apiBase.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeApiConfig(apiBase: string, home: string = homedir()): void {
  const path = configFilePath(home);
  mkdirSync(join(home, ".config", "greenlight"), { recursive: true });
  writeFileSync(path, JSON.stringify({ apiBase }, null, 2) + "\n", "utf8");
}

/**
 * Resolution order: --api-base flag, GREENLIGHT_API_BASE env, the cached
 * config file, then the hosted default. A successful --api-base or env
 * value is cached so later calls need no flag.
 */
export function resolveApiBase(opts: {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const flag = opts.flag?.trim();
  if (flag) {
    writeApiConfig(flag, home);
    return flag;
  }
  const fromEnv = (env.GREENLIGHT_API_BASE ?? "").trim();
  if (fromEnv) {
    writeApiConfig(fromEnv, home);
    return fromEnv;
  }
  return readApiConfig(home)?.apiBase ?? DEFAULT_API_BASE;
}

// ---------------------------------------------------------------------------
// Token storage: OS keychain first, 0600 file fallback
// ---------------------------------------------------------------------------

export type StoredTokenKind = "github" | "session";

export interface StoredToken {
  token: string;
  kind: StoredTokenKind;
  login: string | null;
  storedAt: string;
}

export interface TokenStore {
  get(): Promise<StoredToken | null>;
  set(token: StoredToken): Promise<void>;
  clear(): Promise<void>;
  /** Human line for `auth status`: names the backend in use. */
  describe(): string;
}

const KEYCHAIN_SERVICE = "greenlight";
const KEYCHAIN_ACCOUNT = "claim-api-token";

const execFileAsync = promisify(execFile);

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

/** macOS `security` CLI keychain store. */
class MacKeychainStore implements TokenStore {
  async get(): Promise<StoredToken | null> {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      return parseStoredToken(stdout.trim());
    } catch {
      return null;
    }
  }
  async set(t: StoredToken): Promise<void> {
    await this.clear().catch(() => undefined);
    await execFileAsync("security", [
      "add-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
      serializeStoredToken(t),
    ]);
  }
  async clear(): Promise<void> {
    await execFileAsync("security", [
      "delete-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
    ]);
  }
  describe(): string {
    return "macOS keychain (security)";
  }
}

/** Linux libsecret `secret-tool` store. */
class SecretToolStore implements TokenStore {
  async get(): Promise<StoredToken | null> {
    try {
      const { stdout } = await execFileAsync("secret-tool", [
        "lookup",
        "service",
        KEYCHAIN_SERVICE,
        "account",
        KEYCHAIN_ACCOUNT,
      ]);
      return parseStoredToken(stdout.trim());
    } catch {
      return null;
    }
  }
  async set(t: StoredToken): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("secret-tool", [
        "store",
        "--label=greenlight claim-api token",
        "service",
        KEYCHAIN_SERVICE,
        "account",
        KEYCHAIN_ACCOUNT,
      ]);
      child.on("error", reject);
      child.stdin.write(serializeStoredToken(t));
      child.stdin.end();
      child.on("close", (code: number) => (code === 0 ? resolve() : reject(new Error(`secret-tool exited ${code}`))));
    });
  }
  async clear(): Promise<void> {
    await execFileAsync("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT]);
  }
  describe(): string {
    return "libsecret keychain (secret-tool)";
  }
}

/** File fallback: ~/.greenlight/api-token, always 0600. */
export class FileTokenStore implements TokenStore {
  private readonly home: string;
  constructor(home: string = homedir()) {
    this.home = home;
  }
  private path(): string {
    return join(this.home, ".greenlight", "api-token");
  }
  async get(): Promise<StoredToken | null> {
    try {
      return parseStoredToken(readFileSync(this.path(), "utf8").trim());
    } catch {
      return null;
    }
  }
  async set(t: StoredToken): Promise<void> {
    mkdirSync(join(this.home, ".greenlight"), { recursive: true });
    writeFileSync(this.path(), serializeStoredToken(t), { mode: 0o600 });
    chmodSync(this.path(), 0o600);
  }
  async clear(): Promise<void> {
    try {
      unlinkSync(this.path());
    } catch {
      /* already gone */
    }
  }
  describe(): string {
    return `file fallback ${this.path()} (0600; no OS keychain found)`;
  }
}

function serializeStoredToken(t: StoredToken): string {
  return JSON.stringify({ v: 1, token: t.token, kind: t.kind, login: t.login, storedAt: t.storedAt });
}

function parseStoredToken(raw: string): StoredToken | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { v?: number; token?: unknown; kind?: unknown; login?: unknown; storedAt?: unknown };
    if (typeof p.token !== "string" || p.token.length === 0) return null;
    const kind: StoredTokenKind = p.kind === "session" ? "session" : "github";
    return {
      token: p.token,
      kind,
      login: typeof p.login === "string" ? p.login : null,
      storedAt: typeof p.storedAt === "string" ? p.storedAt : new Date().toISOString(),
    };
  } catch {
    // Legacy: a raw token string with no envelope; treat as a GitHub token.
    return { token: raw, kind: "github", login: null, storedAt: new Date().toISOString() };
  }
}

/**
 * The default store: OS keychain when a keychain tool is available,
 * otherwise the 0600 file fallback. Callers (and tests) may inject their
 * own TokenStore instead.
 */
export async function defaultTokenStore(home: string = homedir()): Promise<TokenStore> {
  if (process.platform === "darwin" && (await commandExists("security"))) {
    return new MacKeychainStore();
  }
  if (process.platform === "linux" && (await commandExists("secret-tool"))) {
    return new SecretToolStore();
  }
  return new FileTokenStore(home);
}

// ---------------------------------------------------------------------------
// Token resolution for --via-api commands
// ---------------------------------------------------------------------------

export interface ResolvedToken {
  token: string;
  kind: StoredTokenKind;
  login: string | null;
  /** Where it came from: --token, env, or the store. */
  source: "flag" | "env" | "store";
}

export async function resolveApiToken(opts: {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  store?: TokenStore;
  home?: string;
}): Promise<ResolvedToken | null> {
  const env = opts.env ?? process.env;
  const flag = (opts.flag ?? "").trim();
  if (flag) return { token: flag, kind: "github", login: null, source: "flag" };
  const fromEnv = (env.GREENLIGHT_API_TOKEN ?? "").trim();
  if (fromEnv) return { token: fromEnv, kind: "github", login: null, source: "env" };
  const store = opts.store ?? (await defaultTokenStore(opts.home ?? homedir()));
  const stored = await store.get();
  if (!stored) return null;
  return { token: stored.token, kind: stored.kind, login: stored.login, source: "store" };
}

export function noTokenMessage(): string {
  return [
    "No claim-api token found.",
    "Run `greenlight auth login` to sign in with the GitHub device flow,",
    "or pass --token <github-token>, or set GREENLIGHT_API_TOKEN.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// GitHub device flow (Option 1)
// ---------------------------------------------------------------------------

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DeviceLoginOpts {
  clientId?: string;
  fetchImpl?: FetchImpl;
  store?: TokenStore;
  deviceBase?: string;
  apiBase?: string;
  /** Override the server's poll interval (tests). */
  pollIntervalMs?: number;
  /** Overall budget; default 10 minutes. */
  timeoutMs?: number;
  onCode?: (userCode: string, verificationUri: string) => void;
}

async function postJson(fetchImpl: FetchImpl, url: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "greenlight" },
    body: JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, data };
}

/**
 * Run the GitHub OAuth device flow, store the resulting user token, and
 * return it. Polling honors the server's interval; mocked-fetch tests
 * inject a tiny interval.
 */
export async function deviceFlowLogin(opts: DeviceLoginOpts = {}): Promise<ResolvedToken> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const clientId = opts.clientId ?? process.env.GREENLIGHT_OAUTH_CLIENT_ID ?? DEFAULT_OAUTH_CLIENT_ID;
  const deviceBase = opts.deviceBase ?? GITHUB_DEVICE_BASE;
  const apiBase = opts.apiBase ?? GITHUB_API_BASE;
  const onCode =
    opts.onCode ??
    ((userCode, verificationUri) => {
      console.log(`Enter code ${userCode} at ${verificationUri}`);
      console.log("Waiting for authorization...");
    });

  const start = await postJson(fetchImpl, `${deviceBase}/login/device/code`, {
    client_id: clientId,
    scope: "public_repo",
  });
  if (start.status !== 200 || !start.data?.device_code) {
    throw new Error(
      `Device flow failed to start (HTTP ${start.status}): ${start.data?.error_description ?? start.data?.error ?? "no device code"}.`
    );
  }
  const dc = start.data as DeviceCodeResponse;
  onCode(dc.user_code, dc.verification_uri);

  // GitHub requires at least a 5-second poll interval in production;
  // tests inject a smaller one explicitly.
  const intervalMs = opts.pollIntervalMs ?? Math.max(dc.interval * 1000, 5000);
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60 * 1000);
  let token: string | undefined;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error("Device flow timed out waiting for authorization (10 minutes). Re-run greenlight auth login.");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    const poll = await postJson(fetchImpl, `${deviceBase}/login/oauth/access_token`, {
      client_id: clientId,
      device_code: dc.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const err = poll.data?.error as string | undefined;
    if (typeof poll.data?.access_token === "string") {
      token = poll.data.access_token;
      break;
    }
    if (err === "authorization_pending" || err === "slow_down") continue;
    if (err === "expired_token") {
      throw new Error("The device code expired before you authorized it. Re-run greenlight auth login.");
    }
    if (err === "access_denied") {
      throw new Error("Authorization was denied in the browser. Re-run greenlight auth login to try again.");
    }
    throw new Error(`Device flow polling failed: ${err ?? poll.data?.error_description ?? `HTTP ${poll.status}`}.`);
  }
  return finalizeDeviceToken(fetchImpl, apiBase, token ?? "", opts);
}

/** Verify the device-flow token against /user, store it, and return it. */
async function finalizeDeviceToken(
  fetchImpl: FetchImpl,
  apiBase: string,
  token: string,
  opts: DeviceLoginOpts
): Promise<ResolvedToken> {
  if (!token) throw new Error("Device flow returned no access token.");
  let login: string | null = null;
  try {
    const res = await fetchImpl(`${apiBase}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "greenlight" },
    });
    if (res.ok) {
      const u = (await res.json()) as { login?: string };
      login = typeof u.login === "string" ? u.login : null;
    }
  } catch {
    /* keep login null; the token still works on write endpoints */
  }
  const stored: StoredToken = { token, kind: "github", login, storedAt: new Date().toISOString() };
  const store = opts.store ?? (await defaultTokenStore());
  await store.set(stored);
  return { token, kind: "github", login, source: "store" };
}

// ---------------------------------------------------------------------------
// Browser OAuth flow (Option 2)
// ---------------------------------------------------------------------------

export interface BrowserLoginOpts {
  apiBase?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  store?: TokenStore;
  fetchImpl?: FetchImpl;
  /** Opens the URL in the user's browser; default tries the platform opener. */
  openUrl?: (url: string) => Promise<void>;
  /** Reads one line from stdin; injected in tests. */
  promptToken?: () => Promise<string | null>;
}

async function defaultOpenUrl(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    await execFileAsync(cmd, [url]);
  } catch {
    /* the printed URL is the fallback */
  }
}

async function defaultPromptToken(): Promise<string | null> {
  const iface = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string | null>((resolve) => {
      iface.question("Paste the session token from the callback page: ", (answer) => {
        resolve(answer.trim() || null);
      });
    });
  } finally {
    iface.close();
  }
}

/**
 * Browser OAuth grant: open the claim-api login page, the user completes
 * the grant in the browser, and pastes the session token from the
 * ?format=json callback page. Stored as kind "session".
 */
export async function browserLoginFlow(opts: BrowserLoginOpts = {}): Promise<ResolvedToken> {
  const apiBase = opts.apiBase ?? resolveApiBase({ env: opts.env, home: opts.home });
  const loginUrl = `${apiBase}/auth/github/login`;
  console.log(`Opening ${loginUrl} ...`);
  await (opts.openUrl ?? defaultOpenUrl)(loginUrl);
  console.log("Complete the grant in your browser, then paste the session token shown on the callback page.");
  console.log("Tip: add ?format=json to the callback URL to get the token as JSON.");
  const token = (await (opts.promptToken ?? defaultPromptToken)())?.trim() ?? null;
  if (!token) throw new Error("No token pasted; login aborted.");
  const stored: StoredToken = { token, kind: "session", login: null, storedAt: new Date().toISOString() };
  const store = opts.store ?? (await defaultTokenStore(opts.home ?? homedir()));
  await store.set(stored);
  return { token, kind: "session", login: null, source: "store" };
}

// ---------------------------------------------------------------------------
// claim-api HTTP client
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;
  public readonly payload?: unknown;
  constructor(status: number, code: string | undefined, message: string, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export interface ClaimApiClientOpts {
  base: string;
  token?: string;
  fetchImpl?: FetchImpl;
}

export class ClaimApiClient {
  private readonly base: string;
  private readonly token?: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: ClaimApiClientOpts) {
    this.base = opts.base.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "greenlight",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let bodyText: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyText = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: bodyText });
    } catch (err) {
      throw new ApiError(0, "connection-failed", `Could not reach the claim API at ${this.base}: ${err instanceof Error ? err.message : String(err)}.`);
    }
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const code = typeof data?.error === "string" ? data.error : undefined;
      const message = typeof data?.message === "string" ? data.message : `HTTP ${res.status}`;
      throw new ApiError(res.status, code, message, data);
    }
    return { status: res.status, data };
  }

  /** Public status payload (SPEC 5.1 shape plus competing PRs/gates). */
  async issueStatus(owner: string, repo: string, number: number): Promise<any> {
    const { data } = await this.request("GET", `/v1/issues/${owner}/${repo}/${number}/status`);
    return data;
  }

  /**
   * App-aware check: is the Greenlight Claims app installed on this repo?
   * Returns null when the endpoint does not exist (backend older than
   * v1.0.0 returns 404) or the route cannot be reached; the caller treats
   * null as "not installed" and falls back to the direct comment path.
   */
  async appInstallation(owner: string, repo: string): Promise<{ installed: boolean; app_slug?: string } | null> {
    try {
      const { data } = await this.request("GET", `/v1/app/repos/${owner}/${repo}/installation`);
      return { installed: data?.installed === true, app_slug: typeof data?.app_slug === "string" ? data.app_slug : undefined };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 0)) return null;
      throw err;
    }
  }

  async postClaim(owner: string, repo: string, number: number, opts: { plan?: string; eta_days?: number; queue_ok?: boolean }): Promise<any> {
    const { data } = await this.request("POST", "/v1/claims", {
      owner,
      repo,
      issue: number,
      ...(opts.plan !== undefined ? { plan: opts.plan } : {}),
      ...(opts.eta_days !== undefined ? { eta_days: opts.eta_days } : {}),
      ...(opts.queue_ok !== undefined ? { queue_ok: opts.queue_ok } : {}),
    });
    return data;
  }

  async postRelease(owner: string, repo: string, number: number): Promise<any> {
    const { data } = await this.request("POST", "/v1/claims/release", { owner, repo, issue: number });
    return data;
  }

  async postHeartbeat(owner: string, repo: string, number: number, mode?: "comment" | "reaction"): Promise<any> {
    const { data } = await this.request("POST", "/v1/claims/heartbeat", {
      owner,
      repo,
      issue: number,
      ...(mode ? { mode } : {}),
    });
    return data;
  }
}

// ---------------------------------------------------------------------------
// App-aware path selection
// ---------------------------------------------------------------------------

export type ViaApiPath = "app" | "direct";

export interface PathChoice {
  path: ViaApiPath;
  /** The one-line note, printed when falling back to the direct path. */
  note: string | null;
}

/**
 * Before any --via-api write: ask the backend whether the Greenlight
 * Claims app is installed on the repo. Installed -> proceed through the
 * app backend. Not installed, or the endpoint missing/unreachable ->
 * fall back to the current direct-API comment path with the printed
 * note. Never silently downgrade.
 */
export async function chooseViaApiPath(client: ClaimApiClient, owner: string, repo: string): Promise<PathChoice> {
  const installation = await client.appInstallation(owner, repo);
  if (installation?.installed) {
    return { path: "app", note: null };
  }
  return {
    path: "direct",
    note: `Note: the Greenlight Claims app is not installed on ${owner}/${repo}, so this claim posts as a plain protocol comment.`,
  };
}

// ---------------------------------------------------------------------------
// Status-chain confirmation
// ---------------------------------------------------------------------------

/**
 * After a via-api write, re-read the status payload and check the
 * caller's login appears in the active claim or the queue. Returns false
 * when it cannot be confirmed (the CLI then prints the comment URL and
 * tells the user to check, rather than claiming success).
 */
export function statusConfirmsLogin(status: any, login: string | null): boolean {
  if (!login) return false;
  const active = status?.active ?? status?.claim;
  if (active && typeof active.claimant === "string" && active.claimant.toLowerCase() === login.toLowerCase()) {
    return true;
  }
  const queue: unknown = status?.queue ?? active?.queue ?? [];
  if (Array.isArray(queue)) {
    return queue.some(
      (q) => typeof q === "object" && q !== null && String((q as { claimant?: unknown }).claimant ?? "").toLowerCase() === login.toLowerCase()
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// via-api claim / release / heartbeat orchestration
// ---------------------------------------------------------------------------

export interface ViaApiCommonDeps {
  fetchImpl?: FetchImpl;
  env?: NodeJS.ProcessEnv;
  home?: string;
  store?: TokenStore;
  print?: (line: string) => void;
  /** Re-runs the device flow (interactive); injected in tests. */
  relogin?: () => Promise<ResolvedToken>;
  /**
   * The direct-comment fallback executor: posts the protocol comment
   * through the GitHub API exactly as `greenlight claim --yes` does.
   * Injected in tests; defaults to the real claim machinery.
   */
  directClaim?: (args: {
    owner: string;
    repo: string;
    number: number;
    plan?: string;
    etaDays?: number;
    queueOk?: boolean;
    githubToken: string;
  }) => Promise<{ posted: boolean; commentUrl?: string; commentBody: string }>;
  /**
   * The direct-comment fallback for release/heartbeat markers. Injected
   * in tests; defaults to posting the marker comment via the GitHub API.
   */
  directMarker?: (args: { owner: string; repo: string; number: number; body: string; githubToken: string }) => Promise<{ posted: boolean; commentUrl?: string }>;
}

export interface ViaApiClaimOptions {
  plan?: string;
  etaDays?: number;
  queueOk?: boolean;
  tokenFlag?: string;
  apiBaseFlag?: string;
  /** false = dry run: no write, return the plan. */
  yes?: boolean;
}

export interface ViaApiClaimResult {
  outcome: "claimed" | "queued" | "already-claimed" | "refused-taken" | "dry-run" | "no-token" | "api-unreachable" | "auth-failed" | "direct-fallback";
  path: ViaApiPath | null;
  note: string | null;
  commentUrl?: string;
  commentBody?: string;
  queuePosition?: number;
  holder?: { claimant: string; expiresAt: string | null };
  login?: string | null;
  message: string;
}

const TAKEN_HOLDER_LINE = (holder: { claimant: string; expiresAt: string | null }) =>
  `Held by @${holder.claimant}${holder.expiresAt ? ` until ${holder.expiresAt.slice(0, 10)}` : ""}.`;

function holderFromStatus(status: any): { claimant: string; expiresAt: string | null } | null {
  const active = status?.active ?? status?.claim;
  if (active && typeof active.claimant === "string") {
    return {
      claimant: active.claimant,
      expiresAt: typeof active.expires_at === "string" ? active.expires_at : null,
    };
  }
  return null;
}

function holderFrom409(payload: unknown): { claimant: string; expiresAt: string | null } | null {
  const p = payload as { holder?: { claimant?: unknown; expires_at?: unknown } } | null;
  if (p?.holder && typeof p.holder.claimant === "string") {
    return {
      claimant: p.holder.claimant,
      expiresAt: typeof p.holder.expires_at === "string" ? p.holder.expires_at : null,
    };
  }
  return null;
}

async function githubLoginFor(fetchImpl: FetchImpl, token: string): Promise<string | null> {
  try {
    const res = await fetchImpl(`${GITHUB_API_BASE}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "greenlight" },
    });
    if (!res.ok) return null;
    const u = (await res.json()) as { login?: string };
    return typeof u.login === "string" ? u.login : null;
  } catch {
    return null;
  }
}

interface ResolvedCall {
  base: string;
  client: ClaimApiClient;
  token: ResolvedToken;
  login: string | null;
}

/** Resolve the base + bearer and learn the caller's login when possible. */
async function resolveCall(opts: { tokenFlag?: string; apiBaseFlag?: string }, deps: ViaApiCommonDeps): Promise<ResolvedCall | { outcome: "no-token"; message: string }> {
  const base = resolveApiBase({ flag: opts.apiBaseFlag, env: deps.env, home: deps.home });
  const token = await resolveApiToken({ flag: opts.tokenFlag, env: deps.env, store: deps.store, home: deps.home });
  if (!token) return { outcome: "no-token", message: noTokenMessage() };
  let login = token.login;
  if (!login && token.kind === "github") {
    login = await githubLoginFor(deps.fetchImpl ?? fetch, token.token);
  }
  const client = new ClaimApiClient({ base, token: token.token, fetchImpl: deps.fetchImpl });
  return { base, client, token, login };
}

/** Run one API write with a single re-auth retry on 401 (device flow once). */
async function withReauth<T>(
  call: ResolvedCall,
  deps: ViaApiCommonDeps,
  write: (client: ClaimApiClient) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await write(call.client) };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
  }
  (deps.print ?? console.log)("Token rejected (401). Re-running the device login once...");
  let relogged: ResolvedToken;
  try {
    relogged = deps.relogin
      ? await deps.relogin()
      : await deviceFlowLogin({ fetchImpl: deps.fetchImpl, store: deps.store });
  } catch (reloginErr) {
    return {
      ok: false,
      message: `Re-login failed: ${reloginErr instanceof Error ? reloginErr.message : String(reloginErr)}.`,
    };
  }
  const retryClient = new ClaimApiClient({ base: call.base, token: relogged.token, fetchImpl: deps.fetchImpl });
  try {
    return { ok: true, value: await write(retryClient) };
  } catch (err2) {
    if (err2 instanceof ApiError && err2.status === 401) {
      return {
        ok: false,
        message: [
          "The new token was also rejected (401).",
          "Manual steps: run `greenlight auth login` again, check the token has not been revoked,",
          "or pass --token with a fresh GitHub token (or set GREENLIGHT_API_TOKEN).",
        ].join("\n"),
      };
    }
    throw err2;
  }
}

/** The GitHub token usable for the direct-comment fallback, if any. */
async function githubTokenForDirect(call: ResolvedCall, deps: ViaApiCommonDeps): Promise<string | null> {
  if (call.token.kind === "github") return call.token.token;
  const env = deps.env ?? process.env;
  const fromEnv = (env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "").trim();
  return fromEnv || null;
}

export async function viaApiClaim(
  issue: { owner: string; repo: string; number: number; url: string },
  opts: ViaApiClaimOptions,
  deps: ViaApiCommonDeps = {}
): Promise<ViaApiClaimResult> {
  const print = deps.print ?? console.log;
  const base = resolveApiBase({ flag: opts.apiBaseFlag, env: deps.env, home: deps.home });

  // Dry run needs no token: the plan comes from public reads (status +
  // installation check) and the local comment builder.
  if (!opts.yes) {
    const client = new ClaimApiClient({ base, fetchImpl: deps.fetchImpl });
    let status: any;
    try {
      status = await client.issueStatus(issue.owner, issue.repo, issue.number);
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        return {
          outcome: "api-unreachable",
          path: null,
          note: null,
          message: `The claim API is unreachable at ${base}. You can still claim by hand: greenlight claim ${issue.url}`,
        };
      }
      throw err;
    }
    const { path, note } = await chooseViaApiPath(client, issue.owner, issue.repo);
    if (note) print(note);
    const { buildClaimComment } = await import("./automate.js");
    const commentBody = buildClaimComment(
      { title: status?.title ?? status?.issueTitle ?? "" } as never,
      [],
      undefined,
      { plan: opts.plan, etaDays: opts.etaDays }
    ) as string;
    return {
      outcome: "dry-run",
      path,
      note,
      commentBody,
      message: `Dry run: claim comment NOT posted (path: ${path}). Re-run with --yes to post it.`,
    };
  }

  const resolved = await resolveCall(opts, deps);
  if ("outcome" in resolved) return { outcome: "no-token", path: null, note: null, message: resolved.message };
  const { client, login } = resolved;

  // Pre-flight: the hosted status read (public; no token needed).
  let status: any;
  try {
    status = await client.issueStatus(issue.owner, issue.repo, issue.number);
  } catch (err) {
    if (err instanceof ApiError && err.status === 0) {
      return {
        outcome: "api-unreachable",
        path: null,
        note: null,
        message: `The claim API is unreachable at ${base}. You can still claim by hand: greenlight claim ${issue.url}`,
      };
    }
    throw err;
  }

  // TAKEN pre-flight (only when the caller's login is known): refuse
  // exactly like the local refusal, unless --queue-ok joins the queue.
  const holder = holderFromStatus(status);
  if (holder && login && holder.claimant.toLowerCase() !== login.toLowerCase() && !opts.queueOk) {
    return {
      outcome: "refused-taken",
      path: null,
      note: null,
      holder,
      login,
      message: `Refusing: ${issue.owner}/${issue.repo}#${issue.number} is actively claimed. ${TAKEN_HOLDER_LINE(holder)} Re-run with --queue-ok to join the public queue.`,
    };
  }

  const { path, note } = await chooseViaApiPath(client, issue.owner, issue.repo);
  if (note) print(note);

  if (path === "app") {
    let write: { ok: true; value: unknown } | { ok: false; message: string };
    try {
      write = await withReauth(resolved, deps, (c) =>
        c.postClaim(issue.owner, issue.repo, issue.number, {
          plan: opts.plan,
          eta_days: opts.etaDays,
          queue_ok: opts.queueOk,
        })
      );
    } catch (err) {
      // The server enforces one active claim per issue: a 409 claim-held
      // renders the same refusal as the local pre-flight (this is the
      // path session-token callers take, since their login is unknown).
      if (err instanceof ApiError && err.status === 409 && err.code === "claim-held") {
        const h = holderFrom409(err.payload) ?? { claimant: "another contributor", expiresAt: null };
        return {
          outcome: "refused-taken",
          path,
          note,
          holder: h,
          login,
          message: `Refusing: ${issue.owner}/${issue.repo}#${issue.number} is actively claimed. ${TAKEN_HOLDER_LINE(h)} Re-run with --queue-ok to join the public queue.`,
        };
      }
      throw err;
    }
    if (!write.ok) return { outcome: "auth-failed", path, note, login, message: write.message };
    const data = write.value as { action?: string; posted?: boolean; comment_url?: string; queue_position?: number };
    if (data.action === "already-claimed") {
      return { outcome: "already-claimed", path, note, login, message: "You already hold the active claim on this issue." };
    }
    // Verify the posted comment by re-reading the status and confirming
    // the caller's login appears in the chain; never claim success blind.
    let confirmed = false;
    try {
      const reread = await client.issueStatus(issue.owner, issue.repo, issue.number);
      confirmed = statusConfirmsLogin(reread, login);
    } catch {
      /* confirmation is best-effort */
    }
    const queued = (data.queue_position ?? 1) > 1;
    const tail = confirmed
      ? ""
      : ` (posted, but the follow-up status read did not confirm it; check ${data.comment_url ?? "the issue thread"})`;
    return {
      outcome: queued ? "queued" : "claimed",
      path,
      note,
      commentUrl: data.comment_url,
      queuePosition: data.queue_position,
      login,
      message: queued
        ? `Claim queued at position ${data.queue_position}: ${data.comment_url}${tail}`
        : `Claim posted: ${data.comment_url}${tail}`,
    };
  }

  // Direct path: post the protocol comment via the GitHub API, exactly as
  // `greenlight claim --yes` does, with the app's plan/eta fields.
  const githubToken = await githubTokenForDirect(resolved, deps);
  if (!githubToken) {
    return {
      outcome: "direct-fallback",
      path,
      note,
      login,
      message:
        "The app is not installed, so the claim would post as a plain protocol comment, but no GitHub token is available for the direct path. Set GITHUB_TOKEN, or run greenlight auth login (device flow) for a GitHub token.",
    };
  }
  const executor =
    deps.directClaim ??
    (async (a) => {
      const [{ createRestClient }, { buildIssueSnapshot }, { claimIssue }] = await Promise.all([
        import("./automate.js"),
        import("./github.js"),
        import("./automate.js"),
      ]);
      const prev = process.env.GITHUB_TOKEN;
      if (!prev) process.env.GITHUB_TOKEN = a.githubToken;
      try {
        const snapshot = await buildIssueSnapshot(a.owner, a.repo, a.number);
        const plan = await claimIssue(createRestClient(), snapshot, {
          yes: true,
          force: false,
          plan: a.plan,
          etaDays: a.etaDays,
        });
        return { posted: plan.executed, commentUrl: plan.commentUrl ?? undefined, commentBody: plan.commentBody };
      } finally {
        if (!prev) delete process.env.GITHUB_TOKEN;
      }
    });
  const direct = await executor({
    owner: issue.owner,
    repo: issue.repo,
    number: issue.number,
    plan: opts.plan,
    etaDays: opts.etaDays,
    queueOk: opts.queueOk,
    githubToken,
  });
  return {
    outcome: direct.posted ? "claimed" : "direct-fallback",
    path,
    note,
    commentUrl: direct.commentUrl,
    commentBody: direct.commentBody,
    login,
    message: direct.posted ? `Claim posted: ${direct.commentUrl}` : "Direct path did not post.",
  };
}

export interface ViaApiWriteResult {
  outcome: "done" | "refused" | "no-token" | "api-unreachable" | "auth-failed";
  path: ViaApiPath | null;
  note: string | null;
  commentUrl?: string;
  login?: string | null;
  message: string;
}

async function viaApiMarkerWrite(
  kind: "release" | "heartbeat",
  issue: { owner: string; repo: string; number: number; url: string },
  opts: { tokenFlag?: string; apiBaseFlag?: string; mode?: "comment" | "reaction"; yes?: boolean },
  deps: ViaApiCommonDeps
): Promise<ViaApiWriteResult> {
  const print = deps.print ?? console.log;
  const base = resolveApiBase({ flag: opts.apiBaseFlag, env: deps.env, home: deps.home });
  const unauthenticated = new ClaimApiClient({ base, fetchImpl: deps.fetchImpl });

  const { path, note } = await chooseViaApiPath(unauthenticated, issue.owner, issue.repo);
  if (note) print(note);

  const dryBody =
    kind === "release"
      ? "<!-- greenlight-claim release -->\n\nReleased under the Greenlight Claim Protocol: the next claim in the queue may now promote."
      : `<!-- greenlight-claim v1 -->\n\nHeartbeat under the Greenlight Claim Protocol (${opts.mode === "reaction" ? "reaction" : "comment"} mode).`;

  if (!opts.yes) {
    return {
      outcome: "done",
      path,
      note,
      message: `Dry run: ${kind} NOT posted (path: ${path}). Re-run with --yes to post it.\n---\n${dryBody}\n---`,
    };
  }

  const resolved = await resolveCall(opts, deps);
  if ("outcome" in resolved) return { outcome: "no-token", path: null, note: null, message: resolved.message };
  const { client, login } = resolved;

  if (path === "app") {
    let write: { ok: true; value: unknown } | { ok: false; message: string };
    try {
      write = await withReauth(resolved, deps, (c) =>
        kind === "release"
          ? c.postRelease(issue.owner, issue.repo, issue.number)
          : c.postHeartbeat(issue.owner, issue.repo, issue.number, opts.mode)
      );
    } catch (err) {
      // 409 no-active-claim: there is nothing to release or renew. Render
      // the server's message instead of a raw HTTP error.
      if (err instanceof ApiError && err.status === 409) {
        return { outcome: "refused", path, note, login, message: err.message };
      }
      throw err;
    }
    if (!write.ok) return { outcome: "auth-failed", path, note, login, message: write.message };
    const data = write.value as { comment_url?: string; note?: string };
    let confirmed = false;
    try {
      const reread = await client.issueStatus(issue.owner, issue.repo, issue.number);
      confirmed = kind === "release" ? !holderFromStatus(reread) : statusConfirmsLogin(reread, login);
    } catch {
      /* best-effort */
    }
    const tail = confirmed ? "" : ` (posted, but the follow-up status read did not confirm it; check the issue thread)`;
    return {
      outcome: "done",
      path,
      note,
      commentUrl: data.comment_url,
      login,
      message: `${kind === "release" ? "Release" : "Heartbeat"} posted: ${data.comment_url}${tail}`,
    };
  }

  const githubToken = await githubTokenForDirect(resolved, deps);
  if (!githubToken) {
    return {
      outcome: "refused",
      path,
      note,
      login,
      message:
        "The app is not installed, so this would post as a plain protocol comment, but no GitHub token is available for the direct path. Set GITHUB_TOKEN, or run greenlight auth login (device flow).",
    };
  }
  const marker =
    deps.directMarker ??
    (async (a) => {
      const { createRestClient } = await import("./automate.js");
      const prev = process.env.GITHUB_TOKEN;
      if (!prev) process.env.GITHUB_TOKEN = a.githubToken;
      try {
        const url = await createRestClient().postIssueComment(a.owner, a.repo, a.number, a.body);
        return { posted: true, commentUrl: url };
      } finally {
        if (!prev) delete process.env.GITHUB_TOKEN;
      }
    });
  const direct = await marker({ owner: issue.owner, repo: issue.repo, number: issue.number, body: dryBody, githubToken });
  return {
    outcome: direct.posted ? "done" : "refused",
    path,
    note,
    commentUrl: direct.commentUrl,
    login,
    message: direct.posted ? `${kind === "release" ? "Release" : "Heartbeat"} posted: ${direct.commentUrl}` : "Direct path did not post.",
  };
}

export function viaApiRelease(
  issue: { owner: string; repo: string; number: number; url: string },
  opts: { tokenFlag?: string; apiBaseFlag?: string; yes?: boolean },
  deps: ViaApiCommonDeps = {}
): Promise<ViaApiWriteResult> {
  return viaApiMarkerWrite("release", issue, opts, deps);
}

export function viaApiHeartbeat(
  issue: { owner: string; repo: string; number: number; url: string },
  opts: { tokenFlag?: string; apiBaseFlag?: string; mode?: "comment" | "reaction"; yes?: boolean },
  deps: ViaApiCommonDeps = {}
): Promise<ViaApiWriteResult> {
  return viaApiMarkerWrite("heartbeat", issue, opts, deps);
}

// ---------------------------------------------------------------------------
// MCP tool implementations (thin wrappers register these in index.ts)
// ---------------------------------------------------------------------------

export interface McpToolDeps extends ViaApiCommonDeps {
  parseIssueUrl?: (url: string) => { owner: string; repo: string; number: number };
}

function defaultParseIssueUrl(url: string): { owner: string; repo: string; number: number } {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(url.trim());
  if (!m) throw new Error(`Expected a GitHub issue URL, got: ${url}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/**
 * api_status: the hosted status payload for one issue, for agents that
 * want the 60-second-fresh answer instead of the 15-minute static one.
 * Read only; no token needed.
 */
export async function mcpApiStatus(
  args: { issue_url: string; api_base?: string },
  deps: McpToolDeps = {}
): Promise<unknown> {
  try {
    const parse = deps.parseIssueUrl ?? defaultParseIssueUrl;
    const { owner, repo, number } = parse(args.issue_url);
    const base = resolveApiBase({ flag: args.api_base, env: deps.env, home: deps.home });
    const client = new ClaimApiClient({ base, fetchImpl: deps.fetchImpl });
    return await client.issueStatus(owner, repo, number);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * claim_via_api: claim one issue through the hosted claim API.
 * Report-mode-safe: execute defaults to false (dry run returns the plan);
 * executes only with execute true and a stored token (else it refuses
 * with the auth login instructions).
 */
export async function mcpClaimViaApi(
  args: { issue_url: string; plan?: string; eta_days?: number; queue_ok?: boolean; execute?: boolean; api_base?: string; token?: string },
  deps: McpToolDeps = {}
): Promise<unknown> {
  try {
    const parse = deps.parseIssueUrl ?? defaultParseIssueUrl;
    const { owner, repo, number } = parse(args.issue_url);
    const printed: string[] = [];
    const result = await viaApiClaim(
      { owner, repo, number, url: args.issue_url },
      {
        plan: args.plan,
        etaDays: args.eta_days,
        queueOk: args.queue_ok,
        tokenFlag: args.token,
        apiBaseFlag: args.api_base,
        yes: args.execute === true,
      },
      { ...deps, print: (line) => printed.push(line) }
    );
    return { ...result, printed };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** heartbeat_via_api: renew one claim through the hosted claim API. Same report-mode safety. */
export async function mcpHeartbeatViaApi(
  args: { issue_url: string; mode?: "comment" | "reaction"; execute?: boolean; api_base?: string; token?: string },
  deps: McpToolDeps = {}
): Promise<unknown> {
  try {
    const parse = deps.parseIssueUrl ?? defaultParseIssueUrl;
    const { owner, repo, number } = parse(args.issue_url);
    const printed: string[] = [];
    const result = await viaApiHeartbeat(
      { owner, repo, number, url: args.issue_url },
      { tokenFlag: args.token, apiBaseFlag: args.api_base, mode: args.mode, yes: args.execute === true },
      { ...deps, print: (line) => printed.push(line) }
    );
    return { ...result, printed };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
