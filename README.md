# Greenlight

Pre-flight checks for open-source contributions. Before you (or your AI coding agent) spend hours on an issue, Greenlight tells you if it is actually landable: is it really still open for you, who else is already on it, what hidden gate the repo enforces, and whether outside PRs like yours get merged there.

## The problem this solves

We hand-vetted open issues across MCP and AI repos on 2026-10-13 and kept hitting the same wall:

* Claim races: `langchain-ai/langchain#41185` had 3 claimants while still showing "unassigned". MCP typescript-sdk flagship issues had up to 5 open fix PRs on a single issue.
* Parked fixes: at least 9 issues where a contributor had a finished, tested fix on a fork, stalled behind an assignment or vouch gate (`langchain#41141`, `langchain#41066`, `langchain#40996`, `deepagents#6827`, `deepagents#6863`, `trigger.dev#4982`).
* Hidden gates, all different: FastMCP requires assignment or a "prs welcome" label (`PrefectHQ/fastmcp#4557`). trigger.dev auto-closes PRs from unvouched authors. `modelcontextprotocol/servers` and `openai/openai-agents-python` are collaborators-only for PR creation. The MCP inspector is issues-only.
* AI-filing flood: maintainers at FastMCP, openclaw, and deepagents are drowning in template, bot, and AI-filed issues, so real well-scoped issues get buried and first response is slow.

Every human and every coding agent doing OSS work hits this pre-flight problem and currently solves it by hand, exactly like we did: read comments, timeline, linked PRs, CONTRIBUTING, recent PR outcomes. Greenlight automates that.

## What it does

One engine, three surfaces:

1. **Availability verdicts** for an issue: `GO`, `RISKY`, `TAKEN`, `GATED`, `STALE`. Signals: assignees, linked open/closed PRs (timeline + search), claim-comment heuristics (phrases like "please assign", "working on this", "fix ready", "PR incoming"), issue age and last activity.
2. **Repo friction scores** (0-100, 100 = easiest): contribution gates parsed from CONTRIBUTING.md (assignment-first, vouch, CLA, DCO, discussion-first, comment-first, collaborators-only), plus outcome signals where computable.
3. **Scan mode**: rank a repo's open good-first-issue / help-wanted issues by verdict so a contributor (or agent) picks a winnable one first.

## Install

```bash
npm install
npm run build
```

Set `GITHUB_TOKEN` (a classic personal access token, no scopes needed for public repos) to raise the GitHub API rate limit from 60 to 5000 requests per hour. Greenlight caches API responses under `~/.cache/greenlight`.

## CLI

```bash
# Verdict for one issue
npx greenlight check https://github.com/batrapulkit/squidbrake/issues/74

# [GO] batrapulkit/squidbrake#74
#   Taint: tell the approver when an agent edits its own setup right after reading outside content
#   - open, unassigned, no linked PRs, no claim signals, no blocking gates

# Rank a repo's starter issues, GO first (falls back to recent open
# unassigned issues when the repo does not use those labels; --no-fallback to opt out)
npx greenlight scan PrefectHQ/fastmcp

# Friction score for a repo
npx greenlight friction triggerdotdev/trigger.dev

# JSON output for scripting
npx greenlight check <issue-url> --json
```

Real examples from our vetting:

* `batrapulkit/squidbrake#74` scores **GO**: 0 comments, labeled help wanted, no claims, no gates.
* `shadcn-labs/pdfcn#58` scores **RISKY** (claimed flag): a volunteer asked for assignment the same day we vetted it.
* `langchain-ai/langchain#41185` scores **TAKEN** (claim race): 3 strong claimants while still "unassigned".
* `PrefectHQ/fastmcp#5718` scores **GATED**: FastMCP requires assignment or a "prs welcome" label before a PR.
* `triggerdotdev/trigger.dev#5016` scores **GATED**: unvouched-author PRs are auto-closed, a vouch request goes first.

## How scoring works

The verdict engine is deterministic (no LLM) and checks, in order:

1. Closed issue: **TAKEN** (never landable).
2. Any assignee: **TAKEN**.
3. An open linked PR that **closes** the issue: **TAKEN**. A PR that merely mentions the issue number (like pdfcn PR #91, which closes #70 but lists sibling issues in its body) only adds a `weak-pr-mention` flag and downgrades an otherwise-GO verdict to **RISKY**.
4. Two or more strong claimants: **TAKEN** (claim race).
5. One strong fresh whole-issue claim (under 45 days): **RISKY** with the `claimed` flag. A fresh claim scoped to part of the issue ("taking the remaining fallback ask"): **RISKY** with `claimed` + `partial-claim` flags and a reason naming the claimer and the scope, never TAKEN.
6. One strong claim older than 45 days with no closing PR: **RISKY** with the `stale_claim` flag. The claimant probably walked away, but nobody knows for sure. Stale scoped claims get the same treatment.
7. A hard gate (assignment, vouch, collaborators-only) with nobody assigned: **GATED**.
8. No activity for 180+ days: **STALE**.
9. A soft claim-first gate (the repo asks contributors to comment before starting, like pdfcn): never **GATED**; it caps an otherwise-GO verdict at **RISKY** with a note, the same downgrade shape as a weak PR mention.
10. Otherwise: **GO**.
11. An open PR referenced in a non-author comment whose title/body mentions the issue number: downgrades an otherwise-GO verdict to **RISKY** with the `comment-mentioned-pr` flag ("may already cover part of this issue"). A merged one is an informational note only. Neither can produce **TAKEN**; only closing PRs do that.

Claim detection scans comments for explicit claim phrases, in-progress signals ("fix ready", "PR incoming", "opened a PR"), and soft offers ("happy to fix"). Bot authors are ignored, as are issue reporters unless they announce a ready fix. Scoped claims ("taking the remaining fallback ask", "claiming this half") are recorded as partial: a fresh partial claim downgrades an otherwise-GO verdict to RISKY with a reason naming the claimer and the scope, never TAKEN. PR references (#NNN) in non-author comments are cross-checked against the PR API: an open referenced PR that mentions the issue downgrades GO to RISKY with the `comment-mentioned-pr` flag, a merged one is an informational note, and neither can produce TAKEN.

Friction score starts at 100 and subtracts gate weights (assignment -25, vouch -35, collaborators-only -50, discussion-first -10, claim-first -5, CLA/DCO -5 each), adjusts for external PR merge rate and review/response times when computable, and adds up to +10 for open good-first-issues. Unknown signals stay null and are skipped, never guessed. See `src/friction.ts` for the exact formula.

## MCP server

The same engine is exposed over stdio for coding agents (Claude, Cursor, Cline). The wedge: agents waste the most tokens fixing already-taken issues. Have the agent pre-flight the issue before writing code.

```json
{
  "mcpServers": {
    "greenlight": {
      "command": "node",
      "args": ["/path/to/greenlight/dist/index.js"],
      "env": { "GITHUB_TOKEN": "your-token" }
    }
  }
}
```

Tools:

* `check_issue` - verdict for one issue URL
* `scan_repo` - rank a repo's open issues, GO first (label-tagged starter issues, falling back to recent open unassigned issues)
* `repo_friction` - friction score for a repo
* `claim_issue` - verdict-gated claim comment (dry run unless `execute: true`)
* `prep_issue` - fork and branch check plus a local PREP.md checklist (dry run unless `execute: true`)
* `open_pr` - DCO-aware PR opening from a fork branch (dry run unless `execute: true`)

Run it locally: `npm run dev` (MCP entry is `src/index.ts`; CLI is `src/cli.ts`).

## Automation

Greenlight 0.2.0 automates the contribution pipeline its author ran by hand
for four real PRs (shadcn-labs/pdfcn #92-#95): verdict, claim comment, fork
branch, and opening the PR, with DCO awareness throughout.

```bash
# 1. Claim the issue: verdict first, comment shaped by the repo's gates
greenlight claim https://github.com/shadcn-labs/pdfcn/issues/65

# 2. Prepare: fork/branch check (learning the repo's branch convention) plus a PREP.md checklist
greenlight prep https://github.com/shadcn-labs/pdfcn/issues/65 --dir /tmp/prep65

# 3. Open the PR from your fork branch (verifies DCO sign-off on DCO repos)
greenlight pr https://github.com/shadcn-labs/pdfcn/issues/65 --branch feat/quarterly-report-block
```

Safety defaults, and this is a feature:

* **Dry run by default.** All three commands print exactly what they would
  post or create and exit. Nothing is posted or created without `--yes`
  (CLI) or `execute: true` (MCP).
* **Writes need a token.** Read ops work with no token at all. Write ops
  require `GITHUB_TOKEN` (or `GH_TOKEN`); without one they print a clear
  error naming the env var and exit non-zero.
* **Verdict-gated.** `claim` refuses TAKEN or STALE verdicts unless
  `--force`, and refuses vouch-gated repos outright (a vouch cannot be
  automated). Assignment-gated repos get an assignment request instead of
  an intent comment; claim-first repos (comment before starting) get the
  standard intent comment, which satisfies the ritual.
* **Repo-aware branch names.** `prep` reads the head branches of recent
  closed PRs and follows a dominant convention (pdfcn's `feat/<slug>-block`)
  while still showing the `feat/<slug>-<number>` default.
* **DCO-aware.** On DCO repos, `pr` verifies every commit on the branch
  carries a `Signed-off-by:` line and refuses, listing the unsigned
  commits, when one is missing.

## The friction index

`data/friction-index.json` is a checked-in, growing dataset of scored repos. It starts with the MCP/AI ecosystem we hand-vetted on 2026-10-13 (FastMCP, trigger.dev, langchain, deepagents, openclaw, squidbrake, reticle, pdfcn, chatflow-agent, and the three MCP SDK repos). Regenerate it with `npm run index`.

Entries labeled `hand-verified 2026-10-13` come from reading the repos' actual policies and issue trackers by hand. Entries labeled `live` were parsed from a live CONTRIBUTING.md fetch. Computed outcome fields (merge rates, review times) stay `null` until we can compute them honestly, never fabricated.

## Development

```bash
npm test    # tsx --test, includes fixture tests that reproduce our real verdicts
npm run build
```

## Roadmap (Later)

* Browser extension that scores issues inline on github.com
* Hosted dashboard of the friction index, refreshed on a schedule
* Maintainer GitHub Action that auto-labels claim comments
* Parked-fix detection and auto-nudges: scan forks for branches referencing open issues and nudge when the gate is satisfied

## License

MIT. See LICENSE.
