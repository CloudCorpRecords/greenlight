# Greenlight agent drop-in pack

One behavior rule, everywhere: **your agent checks Greenlight before it
opens a pull request.** The configs below register Greenlight's MCP server
and teach the agent the workflow: check the issue first, stop on TAKEN or
GATED, triage red CI before touching code, triage reviews before fixing,
and never post anything to GitHub without the human's go-ahead.

## Install per tool

The fastest path is the one-command setup, run in your project:

```bash
npx @reneturcios/greenlight init --agent claude-code
```

(use `cursor`, `copilot`, `windsurf`, or `cline` for the other tools). Init
writes the MCP config and the instruction snippet for you, then tells you
what to restart. After that, run `greenlight doctor` to verify the setup.

The manual alternative, if you would rather copy files yourself:

| Tool | Copy this file | To this destination |
|---|---|---|
| Claude Code | `claude-code/.mcp.json` | your project root as `.mcp.json` |
| Claude Code | `claude-code/CLAUDE.snippet.md` | paste into your project's `CLAUDE.md` |
| Cursor | `cursor/.cursor/mcp.json` | your project as `.cursor/mcp.json` |
| Cursor | `cursor/greenlight.mdc` | your project as `.cursor/rules/greenlight.mdc` |
| VS Code / Copilot | `copilot/.vscode/mcp.json` | your project as `.vscode/mcp.json` |
| VS Code / Copilot | `copilot/copilot-instructions.snippet.md` | paste into `.github/copilot-instructions.md` |
| Windsurf | `windsurf/mcp_config.json` | `~/.codeium/windsurf/mcp_config.json` (merge with existing) |
| Cline | `cline/cline_mcp_settings.json` | your project as `.cline/mcp_settings.json` |
| Anything else | `mcp.json` | wherever your client reads MCP configs |

Restart the tool after installing. Every config launches the server as
`npx -y @reneturcios/greenlight mcp`, so nothing is installed globally;
the package downloads on first use. Set the `GITHUB_TOKEN` environment
variable for the higher GitHub API rate limit (60 to 5000 requests/hour);
without it the tools still work but share the small anonymous budget.

## Verify it worked

Ask the agent: "list your MCP tools." You should see the `greenlight`
server with all 17 tools:

- `check_issue` — verdict on whether an issue is landable (GO / RISKY / TAKEN / GATED / STALE)
- `scan_repo` — find starter issues worth working in a repo
- `repo_friction` — how hard it is to land an outside PR (0 to 100)
- `claim_issue` — draft a claim comment shaped by the repo's gates (dry run by default)
- `prep_issue` — fork/branch checklist, CLA path, house rules (dry run by default)
- `open_pr` — compose the PR with the verdict and gates recorded (dry run by default)
- `ci_triage` — is each red check pre-existing, yours, or an external blocker
- `review_triage` — classify review findings and draft replies (never posts)
- `guard_pr` — maintainer-side: competing fix, prior claims, missing artifacts, first-time contributor (never posts)
- `repo_digest` — repo-level maintainer report: PR races with first-claim arbitration, claimed-by-other conflicts, stale claims, assignment-gate conflicts (never posts)
- `claim_status` — Claim Protocol pre-flight for one issue: who holds it, until when, who is queued, competing PRs, gates, whether the repo honors the protocol
- `preflight` — the one-call answer: claim_status plus the repo friction summary
- `verify_comment` — draft the verified-finding comment for maintainer-only repos (draft only, never posts)
- `babysit_prs` — watch your open PRs: one prioritized action list (needs you now, waiting on them, quiet), diffed against stored watermarks
- `evidence_pack` — the Verified PR evidence pack for one PR: guard verdict, CI triage, review triage, protocol status of linked issues, every claim citing its source
- `scout_campaign` — campaign mode: scan repos, rank survivors, append SCOUTED rows to a campaign file, budget-aware
- `my_claims` — bucket your my-claims registry by live protocol status (linked, healthy-active, heartbeat-due, expiring, unlinked-stale, queue-lost)

## Format notes

- Claude Code, Cursor, Windsurf, and Cline all use the `mcpServers` top
  level key in their MCP config files.
- VS Code's `.vscode/mcp.json` uses `servers` instead of `mcpServers`,
  and stdio entries carry `"type": "stdio"`.
- Windsurf's remote transports use `serverUrl` and `transport` instead of
  `url` and `type`; this pack only needs stdio, so it uses the plain
  command/args shape.

Doc sources checked while building this pack: Claude Code `.mcp.json`
shape (project root, `mcpServers`, stdio command/args) per Anthropic-adjacent
project references; VS Code `.vscode/mcp.json` `servers` key per the VS Code
MCP servers docs and multiple community configs; Cursor `.cursor/mcp.json`
`mcpServers` and `.mdc` rules with `description`/`alwaysApply` frontmatter;
Windsurf `~/.codeium/windsurf/mcp_config.json` per its command-palette
"MCP Servers" docs; Cline `.cline/mcp_settings.json` with `mcpServers`.
