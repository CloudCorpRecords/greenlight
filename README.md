# Greenlight

Greenlight checks a GitHub issue before you spend hours on it, and tells you in plain words whether your pull request is likely to land.

## The problem

You find an issue that looks perfect. You code all evening. Then one of these happens:

* Someone already claimed the work in a comment. The issue still says "unassigned", but three volunteers wrote "I'll take this" weeks ago and you never saw it.
* The repo wanted you to ask first. Your pull request gets closed because the maintainers require contributors to request assignment or get a vouch (a recommendation from someone they know) before anyone may open a PR, and nobody told you.
* Your commits get rejected on a technicality. The repo requires a "Signed-off-by" line on every commit (called DCO sign-off, short for Developer Certificate of Origin) or an entry in its changelog folder, and you find out after you push.

These are all contribution rituals: unwritten rules a repo expects before an outside pull request counts. Every repo has different ones, and they hide in different places, from CONTRIBUTING files to AGENTS.md house-rules files (plain-language instruction files that tell people and coding agents how to work in that repo). We hit all of these by hand while vetting real issues, so Greenlight automates the checking.

## What Greenlight does

One engine, four plain steps:

1. **Check before you claim.** Point it at any issue URL. It reads the issue, its comments, linked and mentioned pull requests, and the repo's rules, then answers: GO (yours to take), RISKY (possible, but know this first), TAKEN (someone is on it), GATED (a repo rule blocks you), or STALE (abandoned). It also spots partially-claimed work and issues where half the fix already shipped, so you scope to what remains.
2. **Claim the right way.** It drafts the claim comment in the form the repo's rules actually want: a plain "I'll work on this" where that is enough, an assignment request where the repo requires one, or a refusal where a vouch is needed (no tool can vouch for you). It never posts without your say-so.
3. **Prep your workspace with the repo's own rules.** It sets up your fork and branch, then writes a checklist that includes what it learned from the repo itself: the house-rules files, the verify command they insist on, whether the repo wants a changelog entry, and how its commits are styled.
4. **Open the PR only when the basics pass.** It checks the branch is really ahead of the repo, and on repos that require DCO sign-off it verifies every commit carries the Signed-off-by line before it opens the pull request.

## Use it when

* You found an issue you like and are about to spend real time on it.
* You want to know if an issue is really still yours to finish, or whether someone quietly claimed part of it in a comment.
* A repo's rules are unclear and you want to see them summarized before you start.
* You claimed something a while ago and want to know if that claim still counts.
* You are picking between several repos or issues and want the most winnable one first.

## What it does, technically

One engine, four surfaces:

1. **Availability verdicts** for an issue: `GO`, `RISKY`, `TAKEN`, `GATED`, `STALE`. Signals: assignees, linked open/closed/merged PRs (timeline + search + comment references), claim-comment heuristics including scoped claims (phrases like "please assign", "working on this", "taking the remaining fallback ask"), partially-addressed detection (merged PRs that reference the issue, maintainer comments like "half addressed ... leaving this open"), issue age and last activity.
2. **Repo friction scores** (0-100, 100 = easiest): contribution gates parsed from CONTRIBUTING variants plus house-rules files (`AGENTS.md`, `CLAUDE.md`), with each gate recording which file its evidence came from (assignment-first, vouch, CLA, DCO, discussion-first, comment-first, collaborators-only), plus outcome signals where computable.
3. **Scan mode**: rank a repo's open good-first-issue / help-wanted issues by verdict so a contributor (or agent) picks a winnable one first. Falls back to recent open unassigned issues when a repo has no labeled starter issues.
4. **Contribution automation**: `claim`, `prep`, and `pr` commands (plus matching MCP tools) that run the pipeline after the verdict. All writes are dry-run by default and need a token plus an explicit go flag.

A validation corpus of ten real cases from the campaign (`test/fixtures/cases/`, run by `test/cases.test.ts`) pins every verdict rule to something that actually happened: a taken issue, a weak PR mention, claim-first gates, assignment and vouch gates, a scoped claim, a half-shipped issue, a clean GO, and a stale claim.

## Install

```bash
npx @reneturcios/greenlight check <issue-url>
```

Or from source:

```bash
npm install
npm run build
```

Set `GITHUB_TOKEN` (a classic personal access token, no scopes needed for public repos) to raise the GitHub API rate limit from 60 to 5000 requests per hour. Greenlight caches API responses under `~/.cache/greenlight`.

Run the MCP server with `npx @reneturcios/greenlight mcp` (stdio), or point your agent at the `greenlight` command with the single argument `mcp`.

## The toolkit

Greenlight is the front door of a four-tool lifecycle for open-source contribution work, all published under the same npm scope and cross-wired:

1. **gatefile** (`npx @reneturcios/gatefile extract owner/repo`) extracts a repo's contribution gates into a committed `contribution-gates.json`. Greenlight consumes that file directly: `greenlight check <issue-url> --gates-file contribution-gates.json`, or automatically when the file sits in the working directory, so gates are answered once and reused instead of re-derived from prose.
2. **greenlight** verdicts, scans, claims, prep, and PR opening (this tool).
3. **claimcheck** (`npx @reneturcios/claimcheck claims owner/repo`) watches claimed issues for stale claims and finished fixes parked on forks, the two ways claimed work silently dies.
4. **prwatch** (`npx @reneturcios/prwatch attention --user you`) triages your open PRs by what needs you right now: review threads, failing checks, conflicts, reviewer silence.

Each tool is a CLI and an MCP server (`<tool> mcp`).

## CLI

```bash
# Verdict for one issue
npx @reneturcios/greenlight check https://github.com/batrapulkit/squidbrake/issues/74

# [GO] batrapulkit/squidbrake#74
#   Taint: tell the approver when an agent edits its own setup right after reading outside content
#   - open, unassigned, no linked PRs, no claim signals, no blocking gates

# Rank a repo's starter issues, GO first (falls back to recent open
# unassigned issues when the repo does not use those labels; --no-fallback to opt out)
npx @reneturcios/greenlight scan PrefectHQ/fastmcp

# Friction score for a repo
npx @reneturcios/greenlight friction triggerdotdev/trigger.dev

# JSON output for scripting
npx @reneturcios/greenlight check <issue-url> --json
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
11. An open PR referenced in a non-author comment whose title/body mentions the issue number: downgrades an otherwise-GO verdict to **RISKY** with the `comment-mentioned-pr` flag ("may already cover part of this issue"). Neither can produce **TAKEN**; only closing PRs do that.
12. **Partially-addressed**: merged PRs that reference the issue number (comment-mentioned or linked), or maintainer comments signaling part of the work already shipped ("Half addressed by #905, leaving this open for half B", "Shipped in v3.1.0" next to the issue reference). A plain **GO** hides the scoping work this needs, so the flag `partially-addressed` is added, an otherwise-GO verdict is capped at **RISKY** with a reason like "part of this issue already shipped (PR #905, merged); scope your work to what remains". Never **TAKEN**.

Claim detection scans comments for explicit claim phrases, in-progress signals ("fix ready", "PR incoming", "opened a PR"), and soft offers ("happy to fix"). Bot authors are ignored, as are issue reporters unless they announce a ready fix. Scoped claims ("taking the remaining fallback ask", "claiming this half") are recorded as partial: a fresh partial claim downgrades an otherwise-GO verdict to RISKY with a reason naming the claimer and the scope, never TAKEN. PR references (#NNN) in non-author comments are cross-checked against the PR API: an open referenced PR that mentions the issue downgrades GO to RISKY with the `comment-mentioned-pr` flag, and a merged one feeds rule 12 above.

Friction score starts at 100 and subtracts gate weights (assignment -25, vouch -35, collaborators-only -50, discussion-first -10, claim-first -5, CLA/DCO -5 each), adjusts for external PR merge rate and review/response times when computable, and adds up to +10 for open good-first-issues. Unknown signals stay null and are skipped, never guessed. See `src/friction.ts` for the exact formula.

## MCP server

The same engine is exposed over stdio for coding agents (Claude, Cursor, Cline). The wedge: agents waste the most tokens fixing already-taken issues. Have the agent pre-flight the issue before writing code.

```json
{
  "mcpServers": {
    "greenlight": {
      "command": "npx",
      "args": ["-y", "@reneturcios/greenlight", "mcp"],
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
* `prep_issue` - fork and branch check plus a local PREP.md checklist with the repo's learned conventions (dry run unless `execute: true`)
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
* **Repo-aware prep.** `prep` also learns the repo's contribution rituals
  for the PREP.md checklist: which house-rules files exist, the verify
  command they insist on (like `pnpm verify`), whether the repo assembles
  its changelog from a `.changes/` directory, which root package.json
  scripts exist, and whether recent commits follow Conventional Commits.
  Binding rules increasingly live in `AGENTS.md` rather than CONTRIBUTING,
  and prep reads those too.

## The friction index

`data/friction-index.json` is a checked-in, growing dataset of scored repos. It starts with the MCP/AI ecosystem we hand-vetted on 2026-10-13 (FastMCP, trigger.dev, langchain, deepagents, openclaw, squidbrake, reticle, pdfcn, chatflow-agent, and the three MCP SDK repos). Regenerate it with `npm run index`.

Entries labeled `hand-verified 2026-10-13` come from reading the repos' actual policies and issue trackers by hand. Entries labeled `live` were parsed from live house-rules files (CONTRIBUTING variants, AGENTS.md, CLAUDE.md). Each gate records which file its evidence came from. Computed outcome fields (merge rates, review times) stay `null` until we can compute them honestly, never fabricated.

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
