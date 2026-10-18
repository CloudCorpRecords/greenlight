/**
 * Single source for CLI help: the overview, every command's help, the
 * version string, and unknown-command suggestions. The CLI dispatches here
 * for `greenlight help [cmd]`, `<cmd> --help`, and `--version`; the test
 * suite asserts every listed command has usage plus an example so help
 * cannot drift from the dispatcher.
 */
import { defaultPackageVersion } from "./doctor.js";

export interface CommandHelp {
  name: string;
  usage: string;
  description: string;
  flags: string[];
  examples: string[];
}

export const COMMANDS: CommandHelp[] = [
  {
    name: "check",
    usage: "greenlight check <issue-url> [--json] [--gates-file path]",
    description: "Verdict on one issue: GO, RISKY, TAKEN, GATED, or STALE, with reasons.",
    flags: [
      "--json (machine-readable output)",
      "--gates-file <path> (use a committed contribution-gates.json)",
      "FIREWORKS_API_KEY (optional: AI claim-intent detection; off by default, flags only)",
      "GREENLIGHT_LLM_MODEL (default: accounts/fireworks/models/glm-5p3-flash)",
      "GREENLIGHT_LLM_BASE_URL (default: https://api.fireworks.ai/inference/v1)",
    ],
    examples: ["greenlight check https://github.com/owner/repo/issues/123"],
  },
  {
    name: "status",
    usage: "greenlight status <issue-url> [--json]",
    description: "Claim Protocol status of one issue: holder, expiry, queue, competing PRs, gates.",
    flags: ["--json (machine-readable output)"],
    examples: ["greenlight status https://github.com/owner/repo/issues/123"],
  },
  {
    name: "scan",
    usage: "greenlight scan <owner/repo> [--json] [--no-fallback] [--gates-file path]",
    description: "Rank a repo's open starter issues by verdict, GO first.",
    flags: [
      "--json (machine-readable output)",
      "--no-fallback (skip the recent-unassigned fallback pass)",
      "--gates-file <path> (use a committed contribution-gates.json)",
    ],
    examples: ["greenlight scan facebook/react"],
  },
  {
    name: "friction",
    usage: "greenlight friction <owner/repo> [--json]",
    description: "How hard it is to land an outside PR here, 0-100 (100 = easiest).",
    flags: ["--json (machine-readable output)"],
    examples: ["greenlight friction vercel/next.js"],
  },
  {
    name: "ci",
    usage: "greenlight ci <pr-url> [--json]",
    description: "Triage a red PR: is each failing check yours, pre-existing, or an external blocker?",
    flags: ["--json (machine-readable output)"],
    examples: ["greenlight ci https://github.com/owner/repo/pull/456"],
  },
  {
    name: "review",
    usage: "greenlight review <pr-url> [--json]",
    description: "Triage review feedback: which findings need you, with reply drafts. Never posts.",
    flags: ["--json (machine-readable output)"],
    examples: ["greenlight review https://github.com/owner/repo/pull/456"],
  },
  {
    name: "guard",
    usage: "greenlight guard <pr-url> [--json] [--quiet]",
    description: "Maintainer-side: competing fix, prior and protocol claims, missing artifacts. Exit 3 when flagged.",
    flags: ["--json (machine-readable output)", "--quiet (print only when flagged)"],
    examples: ["greenlight guard https://github.com/owner/repo/pull/456"],
  },
  {
    name: "digest",
    usage: "greenlight digest <owner/repo> [--json] [--limit N] [--fail-on-race]",
    description: "Repo-level attention list: PR races, claimed-by-other, stale claims, assignment conflicts.",
    flags: [
      "--json (machine-readable output)",
      "--limit <N> (cap listed PRs, default 50, max 100)",
      "--fail-on-race (exit 3 when a PR race exists)",
    ],
    examples: ["greenlight digest facebook/react"],
  },
  {
    name: "claim",
    usage: "greenlight claim <issue-url> [--yes] [--force] [--plan text] [--eta-days N] [--json] | claim --register <issue-url> [--eta-days N] [--as login] | claim --import --ledger-user <login> | claim --import --urls <issue-url,...>",
    description: "Draft the claim comment the repo's gates want. Dry run unless --yes (needs GITHUB_TOKEN). Posted claims join the my-claims registry automatically; --import backfills it from the public Claim Ledger or a URL list. Claim posts are paced (min interval + daily cap, ledgered at ~/.greenlight/posting-ledger.json; GREENLIGHT_CLAIM_MIN_INTERVAL_S / GREENLIGHT_CLAIM_DAILY_CAP); greenlight status shows the pacing posture.",
    flags: [
      "--yes (actually post the comment)",
      "--force (post even on a bad verdict or pacing refusal; the override is ledgered)",
      "--min-interval <s> (override the minimum seconds between claim posts; default from GREENLIGHT_CLAIM_MIN_INTERVAL_S, 90)",
      "--plan <text> (record a plan: line in the protocol claim)",
      "--eta-days <N> (record an eta-days: line in the protocol claim)",
      "--register (record a claim posted by other means, without touching the API)",
      "--as <login> (with --register: who posted the claim)",
      "--import (backfill the registry from the Claim Ledger or --urls; no issue URL needed)",
      "--ledger-user <login> (with --import: import active/linked claims by this user from the public Ledger)",
      "--urls <url,...> (with --import: import a manual list of issue URLs)",
      "--via-api (claim through the hosted claim API instead of posting directly; --yes to post)",
      "--queue-ok (with --via-api: join the public queue when someone else holds the claim)",
      "--token <t> (with --via-api: API token passthrough; or set GREENLIGHT_API_TOKEN)",
      "--api-base <url> (with --via-api: override the hosted API base)",
      "--json (machine-readable output)",
    ],
    examples: [
      "greenlight claim https://github.com/owner/repo/issues/123",
      "greenlight claim --register https://github.com/owner/repo/issues/123 --eta-days 7",
      "greenlight claim --import --ledger-user CloudCorpRecords",
      "greenlight claim https://github.com/owner/repo/issues/123 --via-api --yes",
    ],
  },
  {
    name: "auth",
    usage: "greenlight auth <login [--browser] [--client-id id] | status | logout>",
    description: "Sign in to the hosted claim API. login runs the GitHub device flow (Option 1); login --browser walks the browser OAuth grant and stores the pasted session token (Option 2). Tokens live in the OS keychain when one is available, else ~/.greenlight/api-token with 0600 permissions. Option 3 needs no login: --token or GREENLIGHT_API_TOKEN passthrough.",
    flags: [
      "--browser (with login: use the browser OAuth grant instead of the device flow)",
      "--client-id <id> (with login: override the OAuth app client id; or set GREENLIGHT_OAUTH_CLIENT_ID)",
      "--api-base <url> (with login --browser: override the hosted API base)",
    ],
    examples: [
      "greenlight auth login",
      "greenlight auth login --browser",
      "greenlight auth status",
    ],
  },
  {
    name: "release",
    usage: "greenlight release <issue-url> --via-api [--token t] [--api-base url] [--json]",
    description: "Release your active claim on an issue through the hosted claim API (the queue head promotes immediately). App-aware like claim --via-api: repos without the app installed get the direct-API release marker comment with a printed note. Dry run unless --yes.",
    flags: [
      "--via-api (required for now: release through the hosted claim API)",
      "--yes (actually post the release)",
      "--token <t> (API token passthrough; or set GREENLIGHT_API_TOKEN)",
      "--api-base <url> (override the hosted API base)",
      "--json (machine-readable output)",
    ],
    examples: ["greenlight release https://github.com/owner/repo/issues/123 --via-api --yes"],
  },
  {
    name: "heartbeat",
    usage: "greenlight heartbeat <issue-url> --via-api [--reaction] [--token t] [--api-base url] [--json]",
    description: "Renew your active claim on an issue through the hosted claim API (extends the lease). App-aware like claim --via-api. Dry run unless --yes.",
    flags: [
      "--via-api (required for now: heartbeat through the hosted claim API)",
      "--reaction (renew with a reaction instead of a comment, where supported)",
      "--yes (actually post the heartbeat)",
      "--token <t> (API token passthrough; or set GREENLIGHT_API_TOKEN)",
      "--api-base <url> (override the hosted API base)",
      "--json (machine-readable output)",
    ],
    examples: ["greenlight heartbeat https://github.com/owner/repo/issues/123 --via-api --yes"],
  },
  {
    name: "prep",
    usage: "greenlight prep <issue-url> [--dir path] [--yes] [--json]",
    description: "Fork + branch + PREP.md checklist from the repo's own rules. Dry run unless --yes.",
    flags: ["--dir <path> (where to write the checklist)", "--yes (actually create fork/branch)", "--json (machine-readable output)"],
    examples: ["greenlight prep https://github.com/owner/repo/issues/123 --dir /tmp/work"],
  },
  {
    name: "pr",
    usage: "greenlight pr <issue-url> --branch <name> [--title t] [--yes] [--json]",
    description: "Open the PR after verifying branch, ahead-ness, and DCO sign-off. Dry run unless --yes.",
    flags: [
      "--branch <name> (required: your fork branch)",
      "--title <t> (PR title; derived from the issue otherwise)",
      "--yes (actually open the PR)",
      "--json (machine-readable output)",
    ],
    examples: ["greenlight pr https://github.com/owner/repo/issues/123 --branch fix/issue-123"],
  },
  {
    name: "init",
    usage: "greenlight init --agent <tool> [--agent <tool>...] [--dry-run] [--force]",
    description: "Set up Greenlight in your AI coding tool: MCP config plus the workflow instructions.",
    flags: [
      "--agent <tool> (repeatable, comma-separated; claude-code, cursor, copilot, windsurf, cline)",
      "--list (show the supported agent ids)",
      "--force (overwrite conflicting files)",
      "--dry-run (report without writing)",
    ],
    examples: ["greenlight init --agent claude-code", "greenlight init --agent cursor --dry-run"],
  },
  {
    name: "doctor",
    usage: "greenlight doctor [--json]",
    description: "Setup check: Node version, token, GitHub quota, cache. Every problem carries its fix.",
    flags: ["--json (machine-readable output)"],
    examples: ["greenlight doctor"],
  },
  {
    name: "proxy",
    usage: "greenlight proxy [--port N]",
    description: "Localhost forwarder that attaches your GitHub token server-side (127.0.0.1 only), lifting you from the 60/hr anonymous quota to the 5000/hr authenticated budget. Reads GITHUB_TOKEN (or GH_TOKEN) once at startup; never logs or stores it. Start it with a token exported, then point Greenlight at it: export GREENLIGHT_GITHUB_BASE_URL=http://127.0.0.1:8792 GITHUB_TOKEN=proxy",
    flags: ["--port <N> (listen port; default 8792)"],
    examples: [
      "greenlight proxy",
      "greenlight proxy --port 8793",
    ],
  },
  {
    name: "mcp",
    usage: "greenlight mcp",
    description: "Run the MCP server on stdio (17 tools). Your agent client launches this; see 'init'.",
    flags: [],
    examples: ["greenlight mcp"],
  },
  {
    name: "verify-comment",
    usage: "greenlight verify-comment <issue-url> [--json] [--from-file notes.md]",
    description: "Draft the verified-finding comment for a maintainer-only repo. Never posts.",
    flags: [
      "--from-file <path> (read sections from a markdown notes file)",
      "--claim/--env/--repro/--observed/--expected/--root-cause/--fix/--ran/--by (fill sections)",
      "--json (machine-readable output)",
    ],
    examples: ["greenlight verify-comment https://github.com/owner/repo/issues/123 --from-file notes.md"],
  },
  {
    name: "verify",
    usage: "greenlight verify [--base <ref>] [--cmd \"<test command>\"] [--parser node:test|pytest] [--json]",
    description: "Honest red-green test delta: base vs working tree. Exit 3 on new failures, 1 when unverifiable.",
    flags: [
      "--base <ref> (base to compare; defaults to merge-base with upstream)",
      "--cmd \"<test command>\" (override the detected test command)",
      "--parser node:test|pytest (override the detected test parser)",
      "--json (machine-readable output)",
    ],
    examples: ["greenlight verify --base origin/main"],
  },
  {
    name: "babysit",
    usage: "greenlight babysit [--prs url1,url2] [--mine --repos o/r,...] [--account] [--claims-only] [--concurrency N] [--json] [--fail-on-action]",
    description: "Watch your open PRs: one prioritized action list (needs you now, waiting on them, quiet). Also watches your my-claims registry (linked, linked-dead, healthy-active, heartbeat-due, expiring, unlinked-stale, queue-lost).",
    flags: [
      "--prs <url,...> (watch these PR URLs)",
      "--mine --repos <o/r,...> (discover your open PRs across repos)",
      "--account (discover ALL your open PRs account-wide, including ones opened by other agents)",
      "--author <login> (account for --account/--mine; default GREENLIGHT_GITHUB_USER or CloudCorpRecords)",
      "--claims-only (skip the PR scan; show only the claims section)",
      "--concurrency <N> (parallel PR fetches; default 5)",
      "--fail-on-action (exit 3 when the needs-you-now list is non-empty)",
      "--json (machine-readable output)",
    ],
    examples: [
      "greenlight babysit --mine --repos acme/widgets",
      "greenlight babysit --account",
      "greenlight babysit --claims-only",
    ],
  },
  {
    name: "autopilot",
    usage: "greenlight autopilot [--author <login>] [--prs url1,url2] [--max-prs N] [--apply] [--max-fixes N] [--json]",
    description: "PR feedback that fixes itself: collects reviews, comments, and check results per open PR, verifies bot findings against the code at head, triages CI (introduced vs pre-existing), and fixes the mechanical items. Report-only by default; --apply pushes DCO fixes, mechanical merges, and formatting-only changes to your fork branches. Never posts comments; replies are drafted and queued.",
    flags: [
      "--author <login> (default GREENLIGHT_GITHUB_USER or CloudCorpRecords)",
      "--prs <url,...> (run on these PR URLs instead of discovering)",
      "--max-prs <N> (cap discovered PRs; default 50)",
      "--apply (perform fixes; default is report-only)",
      "--max-fixes <N> (cap fixes per run; default 5)",
      "--state <path> (watermark file; default ~/.greenlight/autopilot.json)",
      "--json (machine-readable output)",
    ],
    examples: [
      "greenlight autopilot --author CloudCorpRecords",
      "greenlight autopilot --prs https://github.com/o/r/pull/1 --apply",
    ],
  },
  {
    name: "sync",
    usage: "greenlight sync [--author <login>] [--tracker <csv|json>] [--stale-days N] [--write] [--json]",
    description: "Reconcile local tracking with the API census: PRs the registry does not know (another agent opened them), state mismatches vs API truth, and stale claims with no PR. Reads only; --write upserts the registry's known-PRs section.",
    flags: [
      "--author <login> (default GREENLIGHT_GITHUB_USER or CloudCorpRecords)",
      "--tracker <path> (CSV or JSON tracker with repo/issue/pr_url/status columns to diff)",
      "--stale-days <N> (claims without a PR older than this are stale; default 7)",
      "--write (update the registry's known-PRs section from the census)",
      "--json (machine-readable output)",
    ],
    examples: [
      "greenlight sync",
      "greenlight sync --tracker tracker.csv --write",
    ],
  },
  {
    name: "portfolio",
    usage: "greenlight portfolio [--author <login>] [--stale-days N] [--json]",
    description: "One-screen campaign summary: census counts (open/merged/closed), claims by state, the pending posting queue, and the sync drift count.",
    flags: [
      "--author <login> (default GREENLIGHT_GITHUB_USER or CloudCorpRecords)",
      "--stale-days <N> (default 7)",
      "--json (machine-readable output)",
    ],
    examples: ["greenlight portfolio"],
  },
  {
    name: "shipcheck",
    usage: "greenlight shipcheck <owner/repo> --version <x.y.z> [--npm <pkg>] [--mcp-name <name>] [--json]",
    description: "Independently verify every link of a release chain: the git tag resolves, the commit object exists, package.json at the tag carries the version, the GitHub release exists, npm shows the version, and the MCP Registry shows it active. Reads only; exits non-zero naming the broken link.",
    flags: [
      "--version <x.y.z> (required; the tag is checked as v<x.y.z>)",
      "--npm <pkg> (default: ./package.json name, then the API)",
      "--mcp-name <name> (default: ./server.json name, then the API; without it the registry check is skipped)",
      "--json (machine-readable output)",
    ],
    examples: [
      "greenlight shipcheck CloudCorpRecords/greenlight --version 0.10.1",
    ],
  },
  {
    name: "preflight",
    usage: "greenlight preflight <owner/repo> [--base <sha>] [--files <a,b,...>] [--json]",
    description: "Reads-only go/no-go before building a fix or opening a PR: the fork exists with the right parent, the capability ledger has no recorded block (KNOWN-BLOCKED stops here), the repo's policy gates, and upstream drift on the files the build would touch when --base and --files are given.",
    flags: [
      "--base <sha> (the base the fix was built against)",
      "--files <a,b,...> (repo-relative paths to check for upstream drift)",
      "--json (machine-readable output)",
    ],
    examples: [
      "greenlight preflight actualbudget/actual",
      "greenlight preflight actualbudget/actual --base 8d59f30c --files packages/loot-core/src/server/accounts/app.ts",
    ],
  },
  {
    name: "scout",
    usage: "greenlight scout --repos <o/r,...> --campaign <campaign.json> [--budget N] [--write] [--json]",
    description: "Campaign mode: scan repos, rank survivors by friction, merge history, freshness, and verdict strength, and append them to a campaign file as SCOUTED.",
    flags: [
      "--repos <o/r,...> (repos to scout, or --repos-file <path> with one per line)",
      "--repos-file <path> (one owner/repo per line)",
      "--campaign <path> (campaign file: { entries: [{repo, issue, status, pr}], cursor })",
      "--budget <N> (max GitHub API calls; default 300; on budget hit a resume cursor is saved)",
      "--write (append survivors to the campaign file; without it, print only)",
      "--scan-limit <N> (issues scanned per repo; default 10)",
      "--keep <N> (survivors kept per repo; default 5)",
      "Ranking formula: score = 30*verdictWeight (GO=2, RISKY=1) + 0.25*friction (0-100) + 20*outsideMergeShare (0-1) + 15/(1+medianMergeDays/14) + 5*freshness (1/(1+daysSinceUpdated/30))",
      "--json (machine-readable output)",
    ],
    examples: [
      "greenlight scout --repos acme/widgets,acme/gadgets --campaign campaign.json --write",
      "greenlight scout --repos-file repos.txt --campaign campaign.json --budget 150",
    ],
  },
  {
    name: "evidence",
    usage: "greenlight evidence <pr-url> [--out file.md] [--verify-json path] [--json]",
    description: "Verified PR evidence pack: guard verdict, CI triage, review triage, protocol status; every claim cites its source.",
    flags: [
      "--out <file> (write the pack to a markdown file)",
      "--verify-json <path> (attach a greenlight verify --json test delta)",
      "--json (machine-readable output)",
    ],
    examples: ["greenlight evidence https://github.com/acme/widgets/pull/42 --out EVIDENCE.md"],
  },
  {
    name: "passport",
    usage: "greenlight passport <github-login> [--json]",
    description: "Contributor passport: protocol claims from the Claim Ledger plus merged PRs.",
    flags: ["--json (machine-readable output)"],
    examples: ["greenlight passport CloudCorpRecords"],
  },
  {
    name: "help",
    usage: "greenlight help [command]",
    description: "Show help: the overview, or one command's flags and examples. Also '<cmd> --help'.",
    flags: [],
    examples: ["greenlight help", "greenlight help check"],
  },
  {
    name: "version",
    usage: "greenlight version",
    description: "Print the Greenlight version. The same as 'greenlight --version'.",
    flags: [],
    examples: ["greenlight version"],
  },
];

export function findCommand(name: string): CommandHelp | undefined {
  return COMMANDS.find((c) => c.name === name.toLowerCase());
}

/**
 * What each target-taking command needs, for the missing-argument error.
 * Every key must resolve via findCommand: the CLI prints that command's
 * help alongside the error. Lives here (not cli.ts) so the suite can
 * assert the keys stay covered without importing the CLI entry point.
 */
export const NEEDS_TARGET: Record<string, string> = {
  check: "an issue URL, e.g. greenlight check https://github.com/owner/repo/issues/123",
  status: "an issue URL, e.g. greenlight status https://github.com/owner/repo/issues/123",
  scan: "a repo, e.g. greenlight scan facebook/react",
  friction: "a repo, e.g. greenlight friction vercel/next.js",
  ci: "a PR URL, e.g. greenlight ci https://github.com/owner/repo/pull/456",
  review: "a PR URL, e.g. greenlight review https://github.com/owner/repo/pull/456",
  guard: "a PR URL, e.g. greenlight guard https://github.com/owner/repo/pull/456",
  digest: "a repo, e.g. greenlight digest facebook/react",
  claim: "an issue URL, e.g. greenlight claim https://github.com/owner/repo/issues/123",
  auth: "a subcommand, e.g. greenlight auth login",
  release: "an issue URL, e.g. greenlight release https://github.com/owner/repo/issues/123 --via-api --yes",
  heartbeat: "an issue URL, e.g. greenlight heartbeat https://github.com/owner/repo/issues/123 --via-api --yes",
  prep: "an issue URL, e.g. greenlight prep https://github.com/owner/repo/issues/123",
  pr: "an issue URL plus --branch, e.g. greenlight pr https://github.com/owner/repo/issues/123 --branch fix/issue-123",
  "verify-comment": "an issue URL, e.g. greenlight verify-comment https://github.com/owner/repo/issues/123",
  evidence: "a PR URL, e.g. greenlight evidence https://github.com/owner/repo/pull/456",
  passport: "a GitHub login, e.g. greenlight passport CloudCorpRecords",
  shipcheck: "a repo plus --version, e.g. greenlight shipcheck CloudCorpRecords/greenlight --version 0.10.1",
  preflight: "a repo, e.g. greenlight preflight actualbudget/actual",
};

/** First-run overview: quickstart first, then the command list. */
export function overviewText(): string {
  const lines = [
    "greenlight: pre-flight checks for open-source contributions",
    "",
    "Quickstart:",
    "  greenlight doctor                                   check your setup",
    "  greenlight init --agent claude-code                 set up your AI tool",
    "  greenlight check https://github.com/o/r/issues/1    verdict on an issue",
    "",
    "Commands:",
  ];
  for (const c of COMMANDS) {
    lines.push(`  ${c.name.padEnd(9)} ${c.description}`);
  }
  lines.push(
    "",
    "Run 'greenlight help <command>' (or '<command> --help') for flags and examples.",
    "",
    "claim/prep/pr default to a DRY RUN: nothing is posted or created without",
    "--yes, and writes require GITHUB_TOKEN (or GH_TOKEN) to be set.",
    "",
    "Set GITHUB_TOKEN to raise the GitHub API rate limit (60 -> 5000 req/hr)."
  );
  return lines.join("\n");
}

export function commandHelpText(cmd: CommandHelp): string {
  const lines = ["greenlight " + cmd.name, "", `  ${cmd.usage}`, "", `  ${cmd.description}`];
  if (cmd.flags.length > 0) {
    lines.push("", "  Flags:");
    for (const f of cmd.flags) lines.push(`    ${f}`);
  }
  lines.push("", "  Examples:");
  for (const e of cmd.examples) lines.push(`    ${e}`);
  return lines.join("\n");
}

/** Overview when no command is given; per-command help otherwise. */
export function helpText(name?: string): string {
  if (!name) return overviewText();
  const cmd = findCommand(name);
  if (!cmd) {
    const suggestion = suggestCommand(name);
    return (
      `Unknown command "${name}".` +
      (suggestion ? ` Did you mean "${suggestion}"?` : "") +
      "\n\n" +
      overviewText()
    );
  }
  return commandHelpText(cmd);
}

/** Closest command by prefix or small edit distance; undefined when nothing is close. */
export function suggestCommand(input: string): string | undefined {
  const needle = input.toLowerCase();
  const prefix = COMMANDS.find((c) => c.name.startsWith(needle));
  if (prefix) return prefix.name;
  let best: string | undefined;
  let bestDist = 3;
  for (const c of COMMANDS) {
    const d = editDistance(needle, c.name);
    if (d < bestDist) {
      bestDist = d;
      best = c.name;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const grid: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      grid[i][j] = Math.min(
        grid[i - 1][j] + 1,
        grid[i][j - 1] + 1,
        grid[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return grid[a.length][b.length];
}

export function packageVersion(): string {
  return defaultPackageVersion();
}

export function versionText(): string {
  return `greenlight ${packageVersion()}`;
}
