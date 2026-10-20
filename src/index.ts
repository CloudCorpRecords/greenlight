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
import { xrayIssue, xrayIssues, sortXrayResults, applyXrayDemotion } from "./xray.js";
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
import { runCiPrep } from "./ci-prep.js";
import { radarPRs } from "./radar.js";
import { briefPR } from "./brief.js";
import { triageReview } from "./review-triage.js";
import { guardPr, readGuardConfig } from "./guard.js";
import { babysit, defaultStatePath, defaultAccountAuthor } from "./babysit.js";
import { scoutCampaign, SCOUT_DEFAULT_BUDGET } from "./scout.js";
import { runSync, syncJson } from "./sync.js";
import { runPortfolio, portfolioJson } from "./portfolio.js";
import { runAutopilot } from "./autopilot.js";
import { verifyRepo } from "./verify.js";
import { runShipcheck } from "./shipcheck.js";
import { buildPassport } from "./passport.js";
import { detectBountyForIssue } from "./bounty.js";
import { defaultRegistryPath } from "./claims-registry.js";
import {
  runWave,
  liveWaveDeps,
  loadPolicyIndex,
  POLICY_INDEX_URL,
  DEFAULT_WAVE_FILTERS,
  type WaveFilters,
} from "./wave.js";
import { buildEvidencePack } from "./evidence.js";
import { digestRepo } from "./digest.js";
import {
  buildVerifiedComment,
  suggestsVerifiedComment,
} from "./verify-comment.js";
import {
  mcpApiStatus,
  mcpClaimViaApi,
  mcpHeartbeatViaApi,
} from "./claim-api.js";
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

const server = new McpServer({ name: "greenlight", version: GREENLIGHT_VERSION });

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
      return text({ issue: snapshot.sourceUrl, title: snapshot.title, verdict: merged.verdict, reasons: merged.reasons, flags: merged.flags, claims: merged.claims, gates: merged.gates, duplicateOf: snapshot.duplicateOf ?? [], protocol: merged.protocol, llm_claims: merged.llm_claims ?? [], llm_status: merged.llm_status ?? null, suggests_verified_comment: suggestsVerifiedComment(merged.gates) });
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
    deep: z.boolean().default(false).describe("Timeline X-Ray the ranked candidates: demotes issues with hidden in-flight PRs (reporter-owned fix PRs, timeline cross-references) before returning."),
  },
  async ({ repo, deep }) => {
    try {
      const m = /^([^/]+)\/([^/]+)$/.exec(repo.trim());
      if (!m) return text({ error: `Expected owner/repo, got: ${repo}` });
      const { issues, fallbackUsed } = await scanCandidates(m[1], m[2], { limit: 10 });
      const results: Array<{
        number: number;
        url: string;
        title: string;
        verdict: string;
        reasons: string[];
        flags: string[];
      }> = [];
      for (const issue of issues) {
        try {
          const snapshot = await buildIssueSnapshot(m[1], m[2], issue.number);
          const scored = scoreIssue(snapshot);
          results.push({ number: issue.number, url: issue.url, title: issue.title, verdict: scored.verdict, reasons: scored.reasons, flags: scored.flags });
        } catch (err) {
          results.push({ number: issue.number, url: issue.url, title: issue.title, verdict: "ERROR", reasons: [err instanceof Error ? err.message : String(err)], flags: [] });
        }
      }
      const rank: Record<string, number> = { GO: 0, RISKY: 1, GATED: 2, STALE: 3, TAKEN: 4, ERROR: 5 };
      results.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9));
      let deepVerified = 0;
      if (deep) {
        for (const r of results) {
          try {
            const xr = await xrayIssue(m[1], m[2], r.number);
            deepVerified++;
            applyXrayDemotion(r, xr);
          } catch {
            // X-Ray is best-effort; the scan verdict stands.
          }
        }
        results.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9));
      }
      return text({ repo, fallback: fallbackUsed, deep_verified: deep ? `${deepVerified}/${results.length}` : undefined, results });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "xray_issues",
  "Timeline X-Ray: deep-verify candidate issues against their GitHub timelines before writing code. Fetches each issue's timeline, classifies every cross-referenced PR with link-strength scoring, and flags reporter-owned fix PRs and comment claims. Returns GO / RISKY / TAKEN per issue with PR evidence (number, state, link strength, URL). List views hide in-flight PRs; run this on scan results first.",
  {
    repo: z.string().describe("owner/repo, e.g. usebruno/bruno"),
    issues: z.string().optional().describe('Comma-separated issue numbers, e.g. "8149,9319". Omit with from_scan.'),
    from_scan: z.boolean().default(false).describe("X-ray the scan's top candidates instead of listing issue numbers."),
    limit: z.number().optional().describe("Max issues to x-ray (default 10)."),
  },
  async ({ repo, issues, from_scan, limit }) => {
    try {
      const m = /^([^/]+)\/([^/]+)$/.exec(repo.trim());
      if (!m) return text({ error: `Expected owner/repo, got: ${repo}` });
      const lim = Math.max(1, Math.trunc(limit ?? 10));
      let numbers: number[];
      if (issues) {
        numbers = issues.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
        if (numbers.length === 0) return text({ error: "issues needs comma-separated issue numbers" });
      } else {
        const { issues: cands } = await scanCandidates(m[1], m[2], { limit: lim });
        numbers = cands.map((c) => c.number);
        if (numbers.length === 0) return text({ repo, results: [], note: "no candidate issues found" });
      }
      const results = sortXrayResults(await xrayIssues(m[1], m[2], numbers.slice(0, lim)));
      return text({ repo, deep_verified: true, results });
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
  "wave_queue",
  "Build queue in one call: filters the Agent Policy Index for winnable open repos, timeline x-rays starter issues with the existing xray engine (CLEAR / RISKY / TAKEN with competing PRs named), excludes repos with behavioral gates (maintainers who reject AI-built PRs in practice), and skips repos where you already have an open PR. Stops with partial results under the API budget floor. Use this to pick what to build today instead of hand-vetting repos.",
  {
    index_url: z.string().optional().describe("Policy index URL or local file path. Defaults to the live index."),
    max_repos: z.number().default(10).describe("Candidate repos to process (default 10)."),
    min_share: z.number().default(40).describe("Minimum outsider merge share 0-100 (default 40)."),
    min_stars: z.number().default(1000).describe("Star band floor (default 1000)."),
    max_stars: z.number().default(150000).describe("Star band ceiling (default 150000)."),
    issues_per_repo: z.number().default(3).describe("Starter issues x-rayed per repo (default 3)."),
    min_budget: z.number().default(800).describe("Core API floor; the run stops with partial results under it (default 800)."),
    sort: z.enum(["winnability", "stars"]).default("winnability").describe("Candidate ranking: winnability (outsider merge share, then friction, then stars) or stars (default winnability)."),
  },
  async ({ index_url, max_repos, min_share, min_stars, max_stars, issues_per_repo, min_budget, sort }) => {
    try {
      const filters: WaveFilters = {
        minShare: min_share,
        minStars: min_stars,
        maxStars: max_stars,
        maxRepos: max_repos,
        issuesPerRepo: issues_per_repo,
        minBudget: min_budget,
        sort: sort === "stars" ? "stars" : undefined,
      };
      const index = await loadPolicyIndex(index_url ?? POLICY_INDEX_URL);
      const result = await runWave(index, filters, liveWaveDeps());
      return text(result);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "verify",
  "Honest base-vs-head verification for a checked-out repo: runs the detected test suite at the base ref and at HEAD and reports the red-first delta (newly failing, newly passing), never raw counts. Refuses a dirty working tree unless asked. Agent-callable surface of `greenlight verify`; run it before and after a fix to prove the fix did the work.",
  {
    dir: z.string().optional().describe("Repo checkout to verify. Defaults to the server's working directory."),
    base: z.string().optional().describe("Base ref for the comparison (default: merge-base with upstream, or origin/main)."),
    cmd: z.string().optional().describe("Override the detected test command."),
    parser: z.string().optional().describe("Override the result parser (e.g. node:test, pytest)."),
    timeout_secs: z.number().optional().describe("Per-run timeout in seconds."),
    allow_dirty: z.boolean().optional().describe("Run even when the working tree has uncommitted changes."),
  },
  async ({ dir, base, cmd, parser, timeout_secs, allow_dirty }) => {
    try {
      const result = verifyRepo(dir ?? process.cwd(), {
        base,
        cmd,
        parser,
        timeoutSecs: timeout_secs,
        allowDirty: allow_dirty,
      });
      return text(result);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "shipcheck",
  "Release-readiness check for a shipped release: confirms the GitHub release exists, the npm package version is live, the MCP Registry record is active, and the GHCR image tag is published, returning a GO / NO-GO verdict per surface. Agent-callable surface of `greenlight shipcheck`.",
  {
    repo: z.string().describe("owner/repo of the release."),
    version: z.string().describe("Release version without the v prefix, e.g. 0.18.0."),
    npm_package: z.string().optional().describe("npm package name; defaults from package.json, then the API."),
    mcp_name: z.string().optional().describe("MCP registry server name; defaults from server.json, then the API."),
  },
  async ({ repo, version, npm_package, mcp_name }) => {
    try {
      const m = /^([^/]+)\/([^/]+)$/.exec(repo);
      if (!m) return text({ error: `Expected owner/repo, got: ${repo}` });
      const result = await runShipcheck({
        owner: m[1],
        repo: m[2],
        version,
        npmPackage: npm_package,
        mcpName: mcp_name,
      });
      return text(result);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "passport",
  "Contributor passport for a GitHub login: the claim-ledger account profile, merged PR count, honor ratio, and open claims, returned as markdown plus structured JSON. Agent-callable surface of `greenlight passport`.",
  {
    login: z.string().describe("GitHub login (a leading @ is fine)."),
  },
  async ({ login }) => {
    try {
      const clean = login.replace(/^@/, "");
      if (!/^[A-Za-z0-9-]+$/.test(clean)) return text({ error: `Expected a GitHub login, got: ${login}` });
      const passport = await buildPassport(clean);
      return text({ markdown: passport.markdown, ...passport.json });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "bounty_check",
  "Bounty-liveness check for one issue: is the advertised bounty backed by a live platform, an unverifiable claim with no named payer, or a dead platform (algora has been dead since 2025 while thousands of issues still wear its labels)? Returns the classification with its evidence. Context for the contributor, never a verdict. Agent-callable surface of `greenlight bounty`.",
  {
    issue_url: z.string().describe("Full GitHub issue URL, e.g. https://github.com/owner/repo/issues/123"),
  },
  async ({ issue_url }) => {
    try {
      const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i.exec(issue_url);
      if (!m) return text({ error: `Expected a GitHub issue URL, got: ${issue_url}` });
      const result = await detectBountyForIssue(m[1], m[2], Number(m[3]));
      return text(result);
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

server.tool(
  "scout_campaign",
  "Campaign mode: scan repos for winnable issues, rank survivors by friction, merge history, freshness, and verdict strength, and append them to a campaign file as SCOUTED. The campaign file dedupes against everything already claimed or PR'd. Budget-aware: stops with a resume cursor when the API budget is hit.",
  {
    repos: z.array(z.string()).describe("owner/repo list, e.g. [\"acme/widgets\"]"),
    campaign_path: z.string().describe("Path to the campaign JSON file ({ entries: [{repo, issue, status, pr}], cursor })"),
    budget: z.number().default(SCOUT_DEFAULT_BUDGET).describe("Max GitHub API calls; a resume cursor is saved on budget hit"),
    write: z.boolean().default(false).describe("Append survivors to the campaign file; false prints only"),
    scan_limit: z.number().optional().describe("Issues scanned per repo (default 10)"),
    keep: z.number().optional().describe("Survivors kept per repo (default 5)"),
  },
  async ({ repos, campaign_path, budget, write, scan_limit, keep }) => {
    try {
      if (repos.length === 0) return text({ error: "Give at least one repo." });
      const result = await scoutCampaign({
        repos,
        campaignPath: campaign_path,
        budget: budget ?? SCOUT_DEFAULT_BUDGET,
        write,
        scanLimit: scan_limit,
        keepPerRepo: keep,
      });
      return text(result.json);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "my_claims",
  "The claims babysitter's claim half: bucket every claim in your my-claims registry (~/.greenlight/my-claims.json) by its live Claim Protocol status — linked, linked-dead, healthy-active, heartbeat-due, expiring, unlinked-stale, queue-lost — and retire claims that completed or released. Pair with babysit_prs for the full portfolio picture.",
  {
    claims_registry_path: z.string().optional().describe("Override path for the my-claims registry. Defaults to ~/.greenlight/my-claims.json."),
  },
  async ({ claims_registry_path }) => {
    try {
      const run = await babysit({ claimsOnly: true, claimsRegistryPath: claims_registry_path ?? defaultRegistryPath() });
      return text(run.json);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "sync_campaign",
  "Reconcile local tracking with the API census: PRs the registry does not know (another agent opened them), state mismatches vs API truth, and stale claims with no PR. Reads only. For multi-agent campaigns where several agents open PRs in parallel.",
  {
    author: z.string().optional().describe("GitHub login; default GREENLIGHT_GITHUB_USER or CloudCorpRecords"),
    write: z.boolean().default(false).describe("Upsert the registry's known-PRs section from the census"),
    stale_days: z.number().default(7).describe("Claims without a PR older than this are stale"),
  },
  async ({ author, write, stale_days }) => {
    try {
      const { drift, wrote } = await runSync({
        author: author ?? defaultAccountAuthor(),
        staleDays: stale_days ?? 7,
        write,
      });
      return text({ ...syncJson(drift, author ?? defaultAccountAuthor()), wrote });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "campaign_portfolio",
  "One-screen campaign summary: census counts (open/merged/closed), claims by state, the pending posting queue, and the sync drift count. Reads only. For multi-agent campaigns.",
  {
    author: z.string().optional().describe("GitHub login; default GREENLIGHT_GITHUB_USER or CloudCorpRecords"),
    stale_days: z.number().default(7).describe("Claims without a PR older than this are stale"),
  },
  async ({ author, stale_days }) => {
    try {
      const p = await runPortfolio({
        author: author ?? defaultAccountAuthor(),
        staleDays: stale_days ?? 7,
      });
      return text(portfolioJson(p));
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "autopilot_report",
  "Autopilot in report mode: collects reviews, comments, and check results across your open PRs, verifies bot findings against the code at head, triages CI (introduced vs pre-existing), and returns per-PR items, fix plans, and queued reply drafts. Reads only; never applies fixes or posts comments.",
  {
    author: z.string().optional().describe("GitHub login; default GREENLIGHT_GITHUB_USER or CloudCorpRecords"),
    max_prs: z.number().default(50).describe("Cap discovered PRs"),
  },
  async ({ author, max_prs }) => {
    try {
      const run = await runAutopilot({
        author: author ?? defaultAccountAuthor(),
        maxPrs: max_prs ?? 50,
        apply: false,
      });
      return text(run.json);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "api_status",
  "The hosted Claim Protocol status payload for one issue, read live from the claim API: who holds it, until when, who is queued, and whether the repo honors the protocol. For agents that want the 60-second-fresh answer instead of the 15-minute static one. Read only; no token needed.",
  {
    issue_url: z.string().describe("Full GitHub issue URL, e.g. https://github.com/owner/repo/issues/123"),
    api_base: z.string().optional().describe("Override the hosted claim API base URL."),
  },
  async ({ issue_url, api_base }) => {
    return text(await mcpApiStatus({ issue_url, api_base }));
  }
);

server.tool(
  "claim_via_api",
  "Claim one issue through the hosted claim API. App-aware: when the Greenlight Claims app is installed on the repo the claim goes through the app backend; otherwise it posts as a plain protocol comment and says so. REPORT-MODE SAFE: dry run unless execute is true; executing needs a stored token (greenlight auth login) or the token argument.",
  {
    issue_url: z.string().describe("Full GitHub issue URL, e.g. https://github.com/owner/repo/issues/123"),
    execute: z.boolean().default(false).describe("Post the claim for real. Defaults to false: dry run returns the plan only."),
    plan: z.string().optional().describe("Plan recorded in the protocol claim comment (plan: line)."),
    eta_days: z.number().optional().describe("ETA in days recorded in the protocol claim comment (eta-days: line)."),
    queue_ok: z.boolean().default(false).describe("Join the public queue when someone else holds the active claim."),
    api_base: z.string().optional().describe("Override the hosted claim API base URL."),
    token: z.string().optional().describe("API token passthrough; prefer the stored token from greenlight auth login."),
  },
  async ({ issue_url, execute, plan, eta_days, queue_ok, api_base, token }) => {
    return text(await mcpClaimViaApi({ issue_url, execute, plan, eta_days, queue_ok, api_base, token }));
  }
);

server.tool(
  "heartbeat_via_api",
  "Renew one active claim through the hosted claim API (extends the lease). App-aware like claim_via_api. REPORT-MODE SAFE: dry run unless execute is true; executing needs a stored token or the token argument.",
  {
    issue_url: z.string().describe("Full GitHub issue URL, e.g. https://github.com/owner/repo/issues/123"),
    execute: z.boolean().default(false).describe("Post the heartbeat for real. Defaults to false: dry run returns the plan only."),
    mode: z.enum(["comment", "reaction"]).default("comment").describe("Renew with a comment or a reaction, where supported."),
    api_base: z.string().optional().describe("Override the hosted claim API base URL."),
    token: z.string().optional().describe("API token passthrough; prefer the stored token from greenlight auth login."),
  },
  async ({ issue_url, execute, mode, api_base, token }) => {
    return text(await mcpHeartbeatViaApi({ issue_url, execute, mode, api_base, token }));
  }
);


server.tool(
  "ci_prep",
  "Run a target repo's own pull_request workflows locally BEFORE opening a PR: discovers .github/workflows triggered on pull_request, executes the mappable run steps (tests, lint, typecheck, build) with per-step timeouts, checks repo conventions (changesets, conventional-commit subjects, DCO sign-off), and reports PASS/FAIL/SKIPPED per check with a GO/NO-GO verdict. Steps that cannot run locally (deploys, secrets, publishes) are SKIPPED with the reason named, never passed. Use after building a fix, before pushing. Local execution only; never touches GitHub.",
  {
    path: z.string().describe("Local path to the target repo checkout, e.g. /home/user/work/bruno"),
    base: z.string().optional().describe("Base git ref for convention checks (default: auto-detect)."),
    use_act: z.boolean().default(false).describe("Run workflows via act+docker when available; falls back to native mode when not."),
    timeout_secs: z.number().default(300).describe("Per-step execution timeout in seconds."),
  },
  async ({ path, base, use_act, timeout_secs }) => {
    try {
      const result = await runCiPrep(path, { base, useAct: use_act, timeoutSecs: timeout_secs });
      return text(result);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "pr_radar",
  "Maintainer-side duplicate/competing PR radar for a repo: clusters open PRs working the same issue (closing-strength links) or touching the same files (Jaccard file overlap with title-prefiltered budget). Each cluster reports PR numbers, authors, evidence, and a heuristic suggested-keep pick; unclustered PRs are counted so the picture stays honest. API budget is measured and reported.",
  {
    repo: z.string().describe("owner/repo, e.g. usebruno/bruno"),
    limit: z.number().optional().describe("Cap open PRs scanned (default 25, max 100)."),
  },
  async ({ repo, limit }) => {
    try {
      const m = /^([^/]+)\/([^/]+)$/.exec(repo.trim());
      if (!m) return text({ error: `Expected owner/repo, got: ${repo}` });
      const result = await radarPRs(m[1], m[2], { limit: limit ?? 25 });
      return text(result);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "pr_brief",
  "Verified review brief for ANY pull request (not just your own): what changed grouped by area/risk, CI triage with the base-vs-head classifier, review findings classified real vs false-positive with evidence, test evidence present or explicitly absent, merge-readiness blockers (conflicts, unresolved change requests, missing changesets), ending with a one-line look-at-this-first. Deterministic classifiers only; unverified items are marked as such.",
  {
    target: z.string().describe("PR URL or owner/repo#N, e.g. https://github.com/usebruno/bruno/pull/9569 or usebruno/bruno#9569"),
  },
  async ({ target }) => {
    try {
      const result = await briefPR(target);
      return text(result);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("greenlight MCP server running on stdio");
