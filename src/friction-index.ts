/**
 * Friction index generator: `npm run index`.
 *
 * Builds data/friction-index.json for the repos we hand-vetted on
 * 2026-10-13. For each repo it tries the live CONTRIBUTING.md parse first;
 * when the API is unreachable or rate-limited it falls back to the
 * hand-verified gate list below and labels the entry accordingly.
 *
 * Rule: fields we cannot compute live stay null with a note. We never
 * fabricate numbers.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrictionReport, Gate } from "./types.js";
import { parseGates, hardGates } from "./gates.js";
import { scoreFriction } from "./friction.js";
import { fetchContributing } from "./github.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface HandEntry {
  owner: string;
  repo: string;
  gates: Gate[];
  note: string;
}

function gate(kind: Gate["kind"], evidence: string): Gate {
  return { kind, detected: true, evidence };
}

const HAND: HandEntry[] = [
  {
    owner: "PrefectHQ", repo: "fastmcp",
    gates: [gate("assignment_required", "hand-verified 2026-10-13: issue must be assigned or carry a 'prs welcome' label (PrefectHQ/fastmcp PR #4557)")],
    note: "hand-verified 2026-10-13",
  },
  {
    owner: "triggerdotdev", repo: "trigger.dev",
    gates: [gate("vouch_required", "hand-verified 2026-10-13: unvouched-author PRs auto-closed; vouch-request issue required first")],
    note: "hand-verified 2026-10-13",
  },
  {
    owner: "langchain-ai", repo: "langchain",
    gates: [],
    note: "hand-verified 2026-10-13: no codified gate found, but reporters routinely request assignment before coding",
  },
  {
    owner: "langchain-ai", repo: "deepagents",
    gates: [],
    note: "hand-verified 2026-10-13: no codified gate found; assignment-request culture in comments",
  },
  {
    owner: "openclaw", repo: "openclaw",
    gates: [],
    note: "hand-verified 2026-10-13: heavy bot triage (ClawSweeper) is advisory only; no hard pre-PR gate",
  },
  {
    owner: "batrapulkit", repo: "squidbrake",
    gates: [gate("assignment_required", "hand-verified 2026-10-13: maintainer asks contributors to comment to claim before starting")],
    note: "hand-verified 2026-10-13",
  },
  {
    owner: "reticlehq", repo: "reticle",
    gates: [],
    note: "hand-verified 2026-10-13: PR policy 'all', no pre-PR gate",
  },
  {
    owner: "shadcn-labs", repo: "pdfcn",
    gates: [],
    note: "hand-verified 2026-10-13: no formal gate, but good-first-issues are claimed within hours (claim speed is the game)",
  },
  {
    owner: "GustavoBaranda", repo: "chatflow-agent",
    gates: [],
    note: "hand-verified 2026-10-13: no pre-PR gate observed",
  },
  {
    owner: "modelcontextprotocol", repo: "typescript-sdk",
    gates: [gate("assignment_required", "hand-verified 2026-10-13: SDKs expect a linked assigned or 'help wanted' issue, or an assignment comment")],
    note: "hand-verified 2026-10-13",
  },
  {
    owner: "modelcontextprotocol", repo: "python-sdk",
    gates: [gate("assignment_required", "hand-verified 2026-10-13: same assignment culture as the other MCP SDKs")],
    note: "hand-verified 2026-10-13",
  },
  {
    owner: "modelcontextprotocol", repo: "servers",
    gates: [gate("collaborators_only", "hand-verified 2026-10-13: PR creation policy collaborators_only")],
    note: "hand-verified 2026-10-13",
  },
];

/** Merge live-parsed gates with hand-verified gates: hand data wins on kind, live can add new kinds. */
function mergeGates(hand: Gate[], live: Gate[]): Gate[] {
  const byKind = new Map<string, Gate>();
  for (const g of live) byKind.set(g.kind, g);
  for (const g of hand) byKind.set(g.kind, g); // hand-verified takes precedence
  const all: Gate[] = [];
  const seen = new Set<string>();
  for (const g of [...hand, ...live]) {
    if (seen.has(g.kind)) continue;
    seen.add(g.kind);
    all.push(byKind.get(g.kind)!);
  }
  return all;
}

async function main(): Promise<void> {
  const reports: FrictionReport[] = [];
  let liveOk = 0;
  let liveFailed = 0;

  for (const entry of HAND) {
    let contributing: string | undefined;
    let liveNote = entry.note;
    try {
      contributing = await fetchContributing(entry.owner, entry.repo);
      liveOk++;
      liveNote = "live 2026-10-13, merged with hand-verified gates";
    } catch {
      liveFailed++;
      contributing = undefined;
    }

    const liveGates = parseGates(contributing);
    const gates = mergeGates(entry.gates, liveGates);
    const report = scoreFriction({
      owner: entry.owner,
      repo: entry.repo,
      gates,
      externalPRMergeRate: null,
      medianFirstReviewHours: null,
      maintainerIssueResponseHours: null,
      openGoodFirstIssueCount: null,
      note: liveNote,
    });
    // Surface the hard gates in reasons even when score math already did.
    const hard = hardGates(gates);
    if (hard.length > 0) report.reasons.unshift(`HARD GATE: ${hard.map((g) => g.kind).join(", ")}`);
    reports.push(report);
  }

  reports.sort((a, b) => b.score - a.score);

  const outDir = join(ROOT, "data");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "friction-index.json"),
    JSON.stringify({ generated: new Date().toISOString(), repos: reports }, null, 2),
    "utf8"
  );
  console.log(`wrote data/friction-index.json with ${reports.length} repos (live fetch ok: ${liveOk}, fallback: ${liveFailed})`);
}

await main();
