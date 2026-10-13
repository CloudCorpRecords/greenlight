/**
 * Greenlight MCP server (stdio). Same engine as the CLI, exposed as tools
 * so coding agents (Claude, Cursor, Cline) can pre-flight an issue before
 * spending tokens on code for a taken or gated issue.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  parseIssueUrl,
  buildIssueSnapshot,
  listStarterIssues,
  fetchContributing,
  countStarterIssues,
  detectRepoPolicy,
} from "./github.js";
import { scoreIssue } from "./verdict.js";
import { parseGates } from "./gates.js";
import { scoreFriction } from "./friction.js";

const server = new McpServer({ name: "greenlight", version: "0.1.0" });

const text = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
});

server.tool(
  "check_issue",
  "Verdict on whether a GitHub issue is actually landable for an outside contributor. Returns GO, RISKY, TAKEN, GATED, or STALE with reasons, claim signals, and detected repo gates. Call this before writing code for an issue.",
  {
    issue_url: z.string().describe("Full GitHub issue URL, e.g. https://github.com/owner/repo/issues/123"),
  },
  async ({ issue_url }) => {
    try {
      const { owner, repo, number } = parseIssueUrl(issue_url);
      const snapshot = await buildIssueSnapshot(owner, repo, number);
      const result = scoreIssue(snapshot);
      return text({ issue: snapshot.sourceUrl, title: snapshot.title, verdict: result.verdict, reasons: result.reasons, flags: result.flags, claims: result.claims, gates: result.gates });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "scan_repo",
  "Rank a repo's open good-first-issue / help-wanted issues by verdict, GO first. Use this to pick a winnable issue instead of a taken one.",
  {
    repo: z.string().describe("owner/repo, e.g. PrefectHQ/fastmcp"),
  },
  async ({ repo }) => {
    try {
      const m = /^([^/]+)\/([^/]+)$/.exec(repo.trim());
      if (!m) return text({ error: `Expected owner/repo, got: ${repo}` });
      const issues = await listStarterIssues(m[1], m[2], 10);
      const results = [];
      for (const issue of issues) {
        try {
          const snapshot = await buildIssueSnapshot(m[1], m[2], issue.number);
          const scored = scoreIssue(snapshot);
          results.push({ url: issue.url, title: issue.title, verdict: scored.verdict, reasons: scored.reasons, flags: scored.flags });
        } catch (err) {
          results.push({ url: issue.url, title: issue.title, verdict: "ERROR", reasons: [err instanceof Error ? err.message : String(err)], flags: [] });
        }
      }
      const rank: Record<string, number> = { GO: 0, RISKY: 1, GATED: 2, STALE: 3, TAKEN: 4, ERROR: 5 };
      results.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9));
      return text({ repo, results });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "repo_friction",
  "Friction score 0-100 for a repo (100 = easiest to land an outside PR). Based on detected contribution gates and computed outcome signals.",
  {
    repo: z.string().describe("owner/repo, e.g. PrefectHQ/fastmcp"),
  },
  async ({ repo }) => {
    try {
      const m = /^([^/]+)\/([^/]+)$/.exec(repo.trim());
      if (!m) return text({ error: `Expected owner/repo, got: ${repo}` });
      const [contributing, policy, starterCount] = await Promise.all([
        fetchContributing(m[1], m[2]),
        detectRepoPolicy(m[1], m[2]),
        countStarterIssues(m[1], m[2]),
      ]);
      const gates = parseGates(contributing, { collaboratorsOnlyPolicy: policy.collaboratorsOnly });
      const report = scoreFriction({
        owner: m[1],
        repo: m[2],
        gates,
        externalPRMergeRate: null,
        medianFirstReviewHours: null,
        maintainerIssueResponseHours: null,
        openGoodFirstIssueCount: starterCount,
        note: "live",
      });
      return text(report);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("greenlight MCP server running on stdio");
