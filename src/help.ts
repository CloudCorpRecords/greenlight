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
    flags: ["--json (machine-readable output)", "--gates-file <path> (use a committed contribution-gates.json)"],
    examples: ["greenlight check https://github.com/owner/repo/issues/123"],
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
    description: "Maintainer-side: competing fix, prior claims, missing artifacts. Exit 3 when flagged.",
    flags: ["--json (machine-readable output)", "--quiet (print only when flagged)"],
    examples: ["greenlight guard https://github.com/owner/repo/pull/456"],
  },
  {
    name: "claim",
    usage: "greenlight claim <issue-url> [--yes] [--force] [--json]",
    description: "Draft the claim comment the repo's gates want. Dry run unless --yes (needs GITHUB_TOKEN).",
    flags: ["--yes (actually post the comment)", "--force (post even on a bad verdict)", "--json (machine-readable output)"],
    examples: ["greenlight claim https://github.com/owner/repo/issues/123"],
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
    usage: "greenlight init --agent <tool> [--agent <tool>...] [--all] [--list] [--force] [--no-instructions] [--dry-run] [--json]",
    description: "Set up Greenlight in your AI coding tool: MCP config plus the workflow instructions.",
    flags: [
      "--agent <tool> (repeatable, comma-separated; see --list)",
      "--all (set up every supported tool)",
      "--list (show the supported tools)",
      "--force (overwrite conflicting files)",
      "--no-instructions (config only, skip the snippet)",
      "--dry-run (report without writing)",
      "--json (machine-readable output)",
    ],
    examples: ["greenlight init --agent claude-code", "greenlight init --all --dry-run"],
  },
  {
    name: "doctor",
    usage: "greenlight doctor [--json]",
    description: "Setup check: Node version, token, GitHub quota, cache. Every problem carries its fix.",
    flags: ["--json (machine-readable output)"],
    examples: ["greenlight doctor"],
  },
  {
    name: "mcp",
    usage: "greenlight mcp",
    description: "Run the MCP server on stdio (9 tools). Your agent client launches this; see 'init'.",
    flags: [],
    examples: ["greenlight mcp"],
  },
];

export function findCommand(name: string): CommandHelp | undefined {
  return COMMANDS.find((c) => c.name === name.toLowerCase());
}

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
