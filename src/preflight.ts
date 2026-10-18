/**
 * `greenlight preflight`: a reads-only go/no-go check before building a
 * fix or opening a PR, so structural dead ends surface before the work
 * starts instead of after it finishes.
 *
 * Field lessons 2026-10-18:
 * - F2: actualbudget/actual blocked PR creation (422) and
 *   modelcontextprotocol/typescript-sdk 404'd it despite a valid fork.
 *   Both were learned after full builds. The capability ledger now
 *   remembers; preflight reports KNOWN-BLOCKED with the evidence.
 * - F3: actual #7333's upstream moved on the exact file the built fix
 *   touched, discovered at open time. With --base and --files,
 *   preflight compares each file's blob at the build base against the
 *   current upstream head and flags DRIFTED files by name.
 *
 * It also checks the fork exists with the right parent and summarizes
 * the repo's policy gates via the existing gate detection. Reads only.
 */
import { apiGet, ApiNotFoundError, fetchPolicySources, detectRepoPolicy } from "./github.js";
import { parseGatesFromSources } from "./gates.js";
import { loadCapabilities, latestCapability, isBlockedOutcome, defaultCapabilitiesPath } from "./capabilities.js";

export interface PreflightOptions {
  owner: string;
  repo: string;
  /** Base SHA the fix was built against; with --files, enables drift detection. */
  base?: string;
  /** Repo-relative file paths to check for upstream drift. */
  files?: string[];
  capabilitiesPath?: string;
}

export interface ForkCheck {
  ok: boolean;
  detail: string;
}

export interface CapabilityCheck {
  verdict: "KNOWN-BLOCKED" | "CLEAR" | "NO-RECORD";
  detail: string;
}

export interface GateCheck {
  collaboratorsOnly: boolean;
  detected: string[];
  detail: string;
}

export interface DriftFile {
  path: string;
  status: "CLEAN" | "DRIFTED" | "MISSING";
  detail: string;
}

export interface PreflightResult {
  owner: string;
  repo: string;
  fork: ForkCheck;
  capability: CapabilityCheck;
  gates: GateCheck;
  drift?: DriftFile[];
  verdict: "GO" | "NO-GO";
  reasons: string[];
}

async function checkFork(owner: string, repo: string): Promise<ForkCheck> {
  let viewer: string;
  try {
    const me = (await apiGet("/user")) as { login?: unknown };
    viewer = String(me.login ?? "");
    if (!viewer) return { ok: false, detail: "could not determine the GitHub user (no token?)" };
  } catch (err) {
    return { ok: false, detail: `could not determine the GitHub user: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const fork = (await apiGet(`/repos/${viewer}/${repo}`)) as {
      fork?: unknown;
      parent?: { full_name?: unknown };
    };
    if (fork.fork !== true) {
      return { ok: false, detail: `${viewer}/${repo} exists but is not a fork` };
    }
    const parent = String(fork.parent?.full_name ?? "").toLowerCase();
    if (parent !== `${owner}/${repo}`.toLowerCase()) {
      return { ok: false, detail: `${viewer}/${repo} is a fork of ${parent || "(unknown)"}, not ${owner}/${repo}` };
    }
    return { ok: true, detail: `${viewer}/${repo} is a fork of ${owner}/${repo}` };
  } catch (err) {
    if (err instanceof ApiNotFoundError) {
      return { ok: false, detail: `no fork ${viewer}/${repo} exists` };
    }
    return { ok: false, detail: `could not check the fork: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function checkCapability(owner: string, repo: string, capabilitiesPath?: string): CapabilityCheck {
  const file = loadCapabilities(capabilitiesPath ?? defaultCapabilitiesPath());
  const latest = latestCapability(file, `${owner}/${repo}`, "pr_create");
  if (!latest) {
    return { verdict: "NO-RECORD", detail: "no recorded pr_create outcome for this repo" };
  }
  if (isBlockedOutcome(latest.outcome)) {
    return {
      verdict: "KNOWN-BLOCKED",
      detail: `pr_create ${latest.outcome} at ${latest.at}: ${latest.evidence}`,
    };
  }
  return { verdict: "CLEAR", detail: `latest pr_create outcome is ${latest.outcome} (${latest.at})` };
}

async function checkGates(owner: string, repo: string): Promise<GateCheck> {
  const detected: string[] = [];
  let collaboratorsOnly = false;
  try {
    const policy = await detectRepoPolicy(owner, repo);
    collaboratorsOnly = policy.collaboratorsOnly;
    if (collaboratorsOnly) detected.push("collaborators-only");
  } catch {
    // policy detection is best-effort here
  }
  try {
    const sources = await fetchPolicySources(owner, repo);
    const gates = parseGatesFromSources(sources);
    for (const g of gates) {
      if (g.detected && !detected.includes(g.kind)) detected.push(g.kind);
    }
  } catch {
    // best effort
  }
  const detail =
    detected.length > 0 ? `detected: ${detected.join(", ")}` : "no contribution gates detected";
  return { collaboratorsOnly, detected, detail };
}

async function blobShaAt(owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
  try {
    const data = (await apiGet(
      `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`
    )) as { sha?: unknown; type?: unknown };
    if (data.type && data.type !== "file") return undefined;
    return typeof data.sha === "string" ? data.sha : undefined;
  } catch (err) {
    if (err instanceof ApiNotFoundError) return undefined;
    throw err;
  }
}

async function checkDrift(owner: string, repo: string, base: string, files: string[]): Promise<DriftFile[]> {
  const repoInfo = (await apiGet(`/repos/${owner}/${repo}`)) as { default_branch?: unknown };
  const branch = String(repoInfo.default_branch ?? "main");
  const headRef = (await apiGet(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)) as {
    object?: { sha?: unknown };
  };
  const head = String(headRef.object?.sha ?? "");
  if (!head) throw new Error(`could not resolve upstream head for ${owner}/${repo}`);
  const out: DriftFile[] = [];
  for (const f of files) {
    const atBase = await blobShaAt(owner, repo, f, base);
    const atHead = await blobShaAt(owner, repo, f, head);
    if (atBase === undefined || atHead === undefined) {
      out.push({ path: f, status: "MISSING", detail: `not present at ${atBase === undefined ? "base" : "head"}` });
    } else if (atBase !== atHead) {
      out.push({ path: f, status: "DRIFTED", detail: `changed upstream since ${base.slice(0, 8)}` });
    } else {
      out.push({ path: f, status: "CLEAN", detail: "unchanged since base" });
    }
  }
  return out;
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const { owner, repo } = opts;
  const reasons: string[] = [];

  const fork = await checkFork(owner, repo);
  if (!fork.ok) reasons.push(`fork: ${fork.detail}`);

  const capability = checkCapability(owner, repo, opts.capabilitiesPath);
  if (capability.verdict === "KNOWN-BLOCKED") reasons.push(`capability: ${capability.detail}`);

  const gates = await checkGates(owner, repo);
  if (gates.collaboratorsOnly) reasons.push("gates: repo is collaborators-only");

  let drift: DriftFile[] | undefined;
  if (opts.base && opts.files && opts.files.length > 0) {
    try {
      drift = await checkDrift(owner, repo, opts.base, opts.files);
      for (const d of drift) {
        if (d.status !== "CLEAN") reasons.push(`drift: ${d.path} is ${d.status} (${d.detail})`);
      }
    } catch (err) {
      reasons.push(`drift: could not compare: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const verdict = reasons.length === 0 ? "GO" : "NO-GO";
  return { owner, repo, fork, capability, gates, drift, verdict, reasons };
}

export function formatPreflightHuman(r: PreflightResult): string {
  const lines = [`[${r.verdict}] preflight ${r.owner}/${r.repo}`];
  lines.push(`  fork: ${r.fork.ok ? "ok" : "PROBLEM"} (${r.fork.detail})`);
  lines.push(`  capability: ${r.capability.verdict} (${r.capability.detail})`);
  lines.push(`  gates: ${r.gates.detail}`);
  if (r.drift) {
    for (const d of r.drift) {
      lines.push(`  drift ${d.status === "CLEAN" ? "ok  " : "FLAG"} ${d.path}: ${d.detail}`);
    }
  }
  for (const reason of r.reasons) lines.push(`  reason: ${reason}`);
  return lines.join("\n");
}
