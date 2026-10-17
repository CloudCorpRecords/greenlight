/**
 * `greenlight doctor`: first-run setup check.
 *
 * Answers the three questions behind most "it doesn't work" reports: is my
 * Node new enough, is my GitHub quota usable, and can Greenlight write its
 * cache. Every check carries its fix, so the output is actionable without
 * opening the docs. All inputs are injectable so the suite stays offline.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { llmModelId } from "./llm-claims.js";
import { githubApiBase } from "./github.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export interface RateState {
  ok: boolean;
  remaining?: number;
  limit?: number;
  resetAt?: string;
  error?: string;
}

export interface DoctorDeps {
  nodeVersion?: string;
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
  packageVersion?: string;
  fetchRateLimit?: (token: string | undefined) => Promise<RateState>;
}

export interface DoctorReport {
  version: string;
  checks: DoctorCheck[];
}

export const MIN_NODE_MAJOR = 20;

export function nodeMajor(version: string): number {
  const m = /^v?(\d+)/.exec(version.trim());
  return m ? Number(m[1]) : 0;
}

export function defaultCacheDir(): string {
  return join(homedir(), ".cache", "greenlight");
}

export function defaultPackageVersion(): string {
  try {
    // src/doctor.ts in dev, dist/doctor.js built: package.json is one up either way.
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** One unauthenticated-capable call: GET /rate_limit shows quota either way. */
export async function defaultFetchRateLimit(token: string | undefined): Promise<RateState> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "greenlight-cli",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${githubApiBase()}/rate_limit`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return { ok: false, error: `GitHub API ${res.status}` };
    }
    const body = (await res.json()) as {
      resources?: { core?: { remaining?: number; limit?: number; reset?: number } };
    };
    const core = body.resources?.core ?? {};
    return {
      ok: true,
      remaining: core.remaining,
      limit: core.limit,
      resetAt:
        typeof core.reset === "number"
          ? new Date(core.reset * 1000).toISOString()
          : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function checkCacheWritable(cacheDir: string): boolean {
  try {
    mkdirSync(cacheDir, { recursive: true });
    const probe = join(cacheDir, ".doctor-write-test");
    writeFileSync(probe, "ok", "utf8");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const nodeVersion = deps.nodeVersion ?? process.version;
  const env = deps.env ?? process.env;
  const cacheDir = deps.cacheDir ?? defaultCacheDir();
  const version = deps.packageVersion ?? defaultPackageVersion();
  const fetchRateLimit = deps.fetchRateLimit ?? defaultFetchRateLimit;

  const checks: DoctorCheck[] = [];

  const major = nodeMajor(nodeVersion);
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { name: "node", status: "pass", detail: `${nodeVersion} (>= v${MIN_NODE_MAJOR} required)` }
      : {
          name: "node",
          status: "fail",
          detail: `${nodeVersion} is older than the required v${MIN_NODE_MAJOR}`,
          fix: "Install Node 20+ from https://nodejs.org and re-run doctor.",
        }
  );

  const tokenVar = env.GITHUB_TOKEN ? "GITHUB_TOKEN" : env.GH_TOKEN ? "GH_TOKEN" : undefined;
  const token = tokenVar ? env[tokenVar] : undefined;
  checks.push(
    tokenVar
      ? { name: "github token", status: "pass", detail: `${tokenVar} is set` }
      : {
          name: "github token",
          status: "warn",
          detail: "no token set; sharing the 60 req/hr anonymous quota",
          fix: "Create a classic personal access token (no scopes needed for public repos) and export GITHUB_TOKEN=<token>.",
        }
  );

  const llmModel = llmModelId(env);
  checks.push(
    env.FIREWORKS_API_KEY
      ? {
          name: "claim ai",
          status: "pass",
          detail: `FIREWORKS_API_KEY is set; AI claim-intent detection is on (model ${llmModel}, key not shown)`,
        }
      : {
          name: "claim ai",
          status: "warn",
          detail: "claim AI is off; claim detection is pattern-based only",
          fix: "Set FIREWORKS_API_KEY to enable AI-assisted claim-intent detection (optional; about a tenth of a cent per issue).",
        }
  );

  const rate = await fetchRateLimit(token);
  if (!rate.ok) {
    checks.push({
      name: "github api",
      status: "fail",
      detail: `unreachable: ${rate.error ?? "unknown error"}`,
      fix: "Check your network connection or proxy, then re-run doctor.",
    });
  } else if (rate.remaining === 0) {
    checks.push({
      name: "github api",
      status: "warn",
      detail: `quota exhausted${rate.resetAt ? `; resets at ${rate.resetAt}` : ""}`,
      fix: tokenVar
        ? "Wait for the reset time; the cache under ~/.cache/greenlight keeps repeat checks cheap."
        : "Set GITHUB_TOKEN for the 5000 req/hr limit, or wait for the reset time.",
    });
  } else {
    checks.push({
      name: "github api",
      status: "pass",
      detail:
        rate.remaining !== undefined && rate.limit !== undefined
          ? `reachable, ${rate.remaining}/${rate.limit} requests remaining`
          : "reachable",
    });
  }

  checks.push(
    checkCacheWritable(cacheDir)
      ? { name: "cache", status: "pass", detail: `${cacheDir} is writable` }
      : {
          name: "cache",
          status: "fail",
          detail: `${cacheDir} is not writable`,
          fix: `Make ${cacheDir} writable (it caches GitHub responses so repeat checks stay cheap).`,
        }
  );

  return { version, checks };
}

/** Human-readable report; one line per check plus the fix for anything off. */
export function formatDoctorHuman(report: DoctorReport): string {
  const lines = [`greenlight ${report.version}: setup check`];
  for (const c of report.checks) {
    const tag = c.status === "pass" ? "[PASS]" : c.status === "warn" ? "[WARN]" : "[FAIL]";
    lines.push(`  ${tag} ${c.name}: ${c.detail}`);
    if (c.fix) lines.push(`        fix: ${c.fix}`);
  }
  if (report.checks.some((c) => c.status === "fail")) {
    lines.push("Result: NOT READY — fix the FAIL lines above, then re-run doctor.");
  } else if (report.checks.some((c) => c.status === "warn")) {
    lines.push("Result: READY with warnings — greenlight works, but see the WARN lines.");
  } else {
    lines.push("Result: READY — everything looks good.");
  }
  return lines.join("\n");
}
