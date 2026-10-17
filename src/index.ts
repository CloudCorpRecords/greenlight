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
  scanCandidates,
} from "./github.js";
import { scoreIssue } from "./verdict.js";
import { fetchFrictionSummary } from "./friction.js";
import { computeIssueStatus, checkIssueWithProtocol } from "./protocol-fetch.js";
import {
  createRestClient,
  claimIssue,
  prepIssue,
  openPr,
  AutomationRefusal,
} from "./automate.js";
import { triagePr } from "./ci-triage.js";
import { triageReview } from "./review-triage.js";
import { guardPr, readGuardConfig } from "./guard.js";
import { babysit, defaultStatePath } from "./babysit.js";
import { buildEvidencePack } from "./evidence.js";
import { digestRepo } from "./digest.js";
import {
  buildVerifiedComment,
  suggestsVerifiedComment,
} from "./verify-comment.js";
import { createRequire } from "node:module";

// Same version fact the CLI footer prints: read from package.json so the
// two can never drift apart.
const GREENLIGHT_VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
})();

const server = new McpServer({ name: "greenlight", version: "0.8.2" });

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
      // Merged verdict: the protocol claim state overrides legacy claim
      // inference, but never gates or cross-referenced PR evidence.
      const { snapshot, merged } = await checkIssueWithProtocol(owner, repo, number);
      return text({ issue: snapshot.sourceUrl, title: snapshot.title, verdict: merged.verdict, reasons: merged.reasons, flags: merged.flags, claims: merged.claims, gates: merged.gates, duplicateOf: snapshot.duplicateOf ?? [], protocol: merged.protocol, llm_claims: merged.llm_claims ?? [], suggests_verified_comment: suggestsVerifiedComment(merged.gates) });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "scan_repo",
  "Rank a repo's open issues by verdict, GO first. Starts with label-tagged good-first-issue / help-wanted issues; when the repo does not use those labels, falls back to the most recent open unassigned issues (flagged as fallback). Use this to pick a winnable issue instead of a taken one.",
  {
    repo: z.string().describe("owner/repo, e.g. PrefectHQ/fastmcp"),
  },
  async ({ repo }) => {
    try {
      const m = /^([^/]+)\/([^/]+)$/.exec(repo.trim());
      if (!m) return text({ error: `Expected owner/repo, got: ${repo}` });
      const { issues, fallbackUsed } = await scanCandidates(m[1], m[2], { limit: 10 });
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
      return text({ repo, fallback: fallbackUsed, results });
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
      const report = await fetchFrictionSummary(m[1], m[2]);
      return text(report);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "claim_issue",
  "Post a claim comment on a GitHub issue, shaped by the repo's contribution gates. Runs the verdict pipeline first and refuses on TAKEN/STALE verdicts or vouch-gated repos. DRY RUN BY DEFAULT: returns the comment plan without posting unless execute is true, and posting requires GITHUB_TOKEN.",
  {
    issue_url: z.string().describe("Full GitHub issue URL, e.g. https://github.com/owner/repo/issues/123"),
    execute: z.boolean().default(false).describe("Post the comment for real. Defaults to false: dry run returns the plan only."),
    force: z.boolean().default(false).describe("Claim even on a TAKEN or STALE verdict."),
    plan: z.string().optional().describe("Plan recorded in the protocol claim comment (plan: line)."),
    eta_days: z.number().optional().describe("ETA in days recorded in the protocol claim comment (eta-days: line)."),
  },
  async ({ issue_url, execute, force, plan: claimPlan, eta_days }) => {
    try {
      const { owner, repo, number } = parseIssueUrl(issue_url);
      const snapshot = await buildIssueSnapshot(owner, repo, number);
      const plan = await claimIssue(createRestClient(), snapshot, { yes: execute, force, plan: claimPlan, etaDays: eta_days });
      return text({
        issue: snapshot.sourceUrl,
        verdict: plan.verdict.verdict,
        reasons: plan.verdict.reasons,
        commentBody: plan.commentBody,
        commentUrl: plan.commentUrl,
        executed: plan.executed,
      });
    } catch (err) {
      if (err instanceof AutomationRefusal) return text({ refused: true, reason: err.message });
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "prep_issue",
  "Prepare to work an issue: check/create your fork and a branch named from the issue title (learning the repo's branch convention from recent PRs when detectable), and write a local PREP.md checklist (verdict, gates, DCO reminders, next commands). Never clones. DRY RUN BY DEFAULT: no fork or branch is created unless execute is true; creating them requires GITHUB_TOKEN.",
  {
    issue_url: z.string().describe("Full GitHub issue URL, e.g. https://github.com/owner/repo/issues/123"),
    execute: z.boolean().default(false).describe("Actually create the fork/branch. Defaults to false: dry run returns the plan only."),
    dir: z.string().optional().describe("Directory for PREP.md. Defaults to ./greenlight-prep/<repo>-<number>/"),
  },
  async ({ issue_url, execute, dir }) => {
    try {
      const { owner, repo, number } = parseIssueUrl(issue_url);
      const snapshot = await buildIssueSnapshot(owner, repo, number);
      const plan = await prepIssue(createRestClient(), snapshot, { yes: execute, dir });
      return text({
        issue: snapshot.sourceUrl,
        verdict: plan.verdict.verdict,
        reasons: plan.verdict.reasons,
        branch: plan.branch,
        branchDefault: plan.branchDefault,
        branchPatternNote: plan.branchPatternNote,
        forkReady: plan.forkReady,
        forkCreated: plan.forkCreated,
        branchReady: plan.branchReady,
        branchCreated: plan.branchCreated,
        prepFile: plan.prepFile,
        nextCommands: plan.nextCommands,
        conventions: plan.conventions ?? null,
        claPath: plan.prepDetail?.claPath ?? null,
        changeset: plan.prepDetail?.changeset ?? null,
        fixLivesHereWarnings: plan.prepDetail?.fixLivesHereWarnings ?? [],
        houseRulesSummary: plan.prepDetail?.houseRulesSummary ?? [],
      });
    } catch (err) {
      if (err instanceof AutomationRefusal) return text({ refused: true, reason: err.message });
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "open_pr",
  "Open a pull request for an issue from your fork branch. Verifies the branch exists, is ahead of upstream, and (on DCO repos) that every commit carries a Signed-off-by line. Composes the PR title and body (Closes #N plus verdict and gates at open time). DRY RUN BY DEFAULT: returns the composed PR without opening it unless execute is true; opening requires GITHUB_TOKEN.",
  {
    issue_url: z.string().describe("Full GitHub issue URL, e.g. https://github.com/owner/repo/issues/123"),
    branch: z.string().describe("Fork branch to open the PR from, e.g. feat/resume-61"),
    execute: z.boolean().default(false).describe("Open the PR for real. Defaults to false: dry run returns the plan only."),
    title: z.string().optional().describe("PR title override. Defaults to the branch's latest commit subject or the issue title."),
  },
  async ({ issue_url, branch, execute, title }) => {
    try {
      const { owner, repo, number } = parseIssueUrl(issue_url);
      const snapshot = await buildIssueSnapshot(owner, repo, number);
      const plan = await openPr(createRestClient(), snapshot, { branch, title, yes: execute });
      return text({
        issue: snapshot.sourceUrl,
        branch: plan.branch,
        head: plan.head,
        base: plan.base,
        title: plan.title,
        body: plan.body,
        checks: plan.checks,
        prUrl: plan.prUrl,
        executed: plan.executed,
      });
    } catch (err) {
      if (err instanceof AutomationRefusal) return text({ refused: true, reason: err.message });
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "ci_triage",
  "Answer the red-PR question: is this failure mine or pre-existing? Fetches the failing check runs on the PR head, compares them against the base branch's recent check history, and classifies each failing check as pre-existing, likely-yours, indeterminate (with a stated lean), or external-blocker (deploy/auth failures like Vercel). Call this on any PR with failing CI before spending time debugging.",
  {
    pr_url: z.string().describe("Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/123"),
  },
  async ({ pr_url }) => {
    try {
      const result = await triagePr(pr_url);
      return text(result);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "review_triage",
  "Triage the review feedback on your PR: which comments actually need you? Gathers bot (CodeRabbit, cubic, Greptile, Copilot) and human review comments, classifies each finding as likely-real, likely-noise, or needs-decision with the reason stated, and drafts a reply for each. Human reviewer comments are never called noise. Drafts only; nothing is posted. Call this after pushing and getting review feedback.",
  {
    pr_url: z.string().describe("Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/123"),
  },
  async ({ pr_url }) => {
    try {
      const result = await triageReview(pr_url);
      return text(result);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "guard_pr",
  "Maintainer-side analysis of an incoming pull request: competing fix (other open PRs already fixing the same issue), prior claims by someone other than the PR author, missing required artifacts (changeset file, DCO sign-off, CLA status), and whether the author is a first-time contributor. Returns markdown ready to post as one PR comment plus structured findings. Reads a .greenlight-guard.json in the working directory for per-repo check toggles. Never posts anything. Call this from a GitHub Action or before reviewing an incoming PR.",
  {
    pr_url: z.string().describe("Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/123"),
  },
  async ({ pr_url }) => {
    try {
      const result = await guardPr(pr_url, {}, readGuardConfig());
      return text(result);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "repo_digest",
  "Repo-level maintainer report: what needs attention across the whole repo? Reports PR races (two or more open PRs fixing the same issue, with first-claim arbitration), claimed-by-other conflicts (an open PR whose linked issue was claimed by someone else first), stale claims (issues claimed 14+ days ago with no open PR), and assignment-gate conflicts (repos that require assignment before a PR). Pass a --limit to bound the API budget on large repos; sections that cannot be computed say so instead of showing empty. Call this when triaging a repo, not just one PR.",
  {
    repo: z.string().describe("owner/repo, e.g. ComposioHQ/composio"),
    limit: z.number().default(50).describe("Max open PRs and open issues to inspect. The summary always states the cap and the true totals."),
  },
  async ({ repo, limit }) => {
    try {
      const m = /^([^/]+)\/([^/]+)$/.exec(repo.trim());
      if (!m) return text({ error: `Expected owner/repo, got: ${repo}` });
      const result = await digestRepo(m[1], m[2], Math.max(1, Math.min(100, limit)));
      return text(result);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "claim_status",
  "The Claim Protocol pre-flight answer for one issue: who holds it, until when, who is queued, which PRs compete, which gates bite, and whether the repo honors the protocol at all. Returns the SPEC 5.1 status payload with competing PRs and gates merged from the check machinery. The verdict vocabulary matches check_issue (GO / RISKY / TAKEN / GATED / STALE); a null verdict means no protocol claims and the check_issue verdict stands.",
  {
    issue_url: z.string().describe("Full GitHub issue URL, e.g. https://github.com/owner/repo/issues/123"),
  },
  async ({ issue_url }) => {
    try {
      const { owner, repo, number } = parseIssueUrl(issue_url);
      const { status } = await computeIssueStatus(owner, repo, number);
      return text(status);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "preflight",
  "The one-call answer to 'can I work on this issue right now': the Claim Protocol issue status (claim holder, expiry, queue, competing PRs, gates) plus the repo friction summary (how hard this repo is to land a PR in, 0-100). Call this before committing to any issue; it combines claim_status and repo_friction.",
  {
    issue_url: z.string().describe("Full GitHub issue URL, e.g. https://github.com/owner/repo/issues/123"),
  },
  async ({ issue_url }) => {
    try {
      const { owner, repo, number } = parseIssueUrl(issue_url);
      const [{ status }, friction] = await Promise.all([
        computeIssueStatus(owner, repo, number),
        fetchFrictionSummary(owner, repo),
      ]);
      return text({ status, friction });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "verify_comment",
  "Draft the verified-finding comment for a maintainer-only repo (modelcontextprotocol/inspector, modelcontextprotocol/servers): outside PRs are closed on sight there, so the contribution that lands is a detailed, verified issue comment. Assembles the comment from your notes: claim, environment, reproduction steps, observed vs expected, root cause, fix sketch, and a verification footer. Sections you leave empty render as explicit gaps, never plausible filler. DRAFT ONLY: nothing is posted, ever. Copy the markdown into the issue thread yourself.",
  {
    issue_url: z.string().describe("Full GitHub issue URL, e.g. https://github.com/modelcontextprotocol/inspector/issues/2723"),
    claim: z.string().optional().describe("One-line claim of the problem."),
    environment: z.string().optional().describe("Environment: repo, ref/commit, date, platform."),
    reproduction: z.string().optional().describe("Reproduction steps, one per line, exact commands."),
    observed: z.string().optional().describe("What was observed when the repro ran."),
    expected: z.string().optional().describe("What should have happened instead."),
    root_cause: z.string().optional().describe("Root cause with file paths and line refs when known; empty renders 'not yet isolated'."),
    fix: z.string().optional().describe("Proposed fix sketch, not a code dump."),
    ran: z.string().optional().describe("What was actually run (commands, counts)."),
    verified_by: z.string().optional().describe("Who ran the verification."),
  },
  async ({ issue_url, claim, environment, reproduction, observed, expected, root_cause, fix, ran, verified_by }) => {
    try {
      const { owner, repo, number } = parseIssueUrl(issue_url);
      const built = buildVerifiedComment(
        `https://github.com/${owner}/${repo}/issues/${number}`,
        {
          claim,
          environment,
          reproduction: reproduction
            ? reproduction.split("\n").map((s) => s.replace(/^\s*(?:\d+[.)]|[-*])\s+/, "").trim()).filter((s) => s.length > 0)
            : undefined,
          observed,
          expected,
          rootCause: root_cause,
          fixSketch: fix,
          ran,
          verifiedBy: verified_by,
        },
        GREENLIGHT_VERSION
      );
      return text({ issue: issue_url, markdown: built.markdown, gaps: built.gaps, posted: false });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "babysit_prs",
  "Watch your open PRs and get the one prioritized action list: needs you now (new review findings, CI failing on your code, merge conflicts, new guard flags, stuck checks), waiting on them (checks running, green with no feedback yet), quiet. Compares against stored watermarks so reruns report only what changed since the last check. Cron-friendly: always succeeds unless the input is wrong.",
  {
    pr_urls: z.array(z.string()).default([]).describe("Full GitHub PR URLs to watch, e.g. [\"https://github.com/owner/repo/pull/123\"]. Empty when using mine."),
    mine: z.boolean().default(false).describe("Discover the author's open PRs across the repos list via the GitHub search API."),
    repos: z.array(z.string()).default([]).describe("owner/repo list for mine discovery, e.g. [\"acme/widgets\"]."),
    author: z.string().default("CloudCorpRecords").describe("Author whose open PRs to discover with mine."),
    state_path: z.string().optional().describe("Watermark file. Defaults to ~/.greenlight/babysit.json."),
  },
  async ({ pr_urls, mine, repos, author, state_path }) => {
    try {
      if (pr_urls.length === 0 && !mine) {
        return text({ error: "Give pr_urls or set mine with repos." });
      }
      const run = await babysit({ prs: pr_urls, mine, repos, author, statePath: state_path ?? defaultStatePath() });
      return text(run.json);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "evidence_pack",
  "The Verified PR evidence pack for one pull request: the guard verdict, CI triage, review triage, and Claim Protocol status of the linked issues, in one markdown document where every claim cites its source (check run, review anchor, claim comment URL). Call this when a maintainer, a recruiter, or your future self needs proof, not a summary.",
  {
    pr_url: z.string().describe("Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/123"),
    verify_json: z.string().optional().describe("Path to a prior `greenlight verify --json` report to include the honest red-green test delta. The pack never runs suites itself."),
  },
  async ({ pr_url, verify_json }) => {
    try {
      const pack = await buildEvidencePack(pr_url, { verifyJsonPath: verify_json });
      return { content: [{ type: "text" as const, text: pack.markdown }] };
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("greenlight MCP server running on stdio");
