# Greenlight

**Greenlight is the pre-flight and coordination layer for open-source contribution: the software that stands between an outside contributor (increasingly an AI agent) and the maintainers of a public repo, and answers the questions no other tool answers. Can I contribute here at all? Is this issue secretly taken? What are the house rules? Who else is racing me? And for maintainers: who is flooding my queue, and what is safe to merge?**

## Why this layer exists

Follow the venture money and you will see where it is not going. Cognition (Devin) raised about $2B at a $48B valuation, and Factory raised $200M at a $5B valuation, to run autonomous coding agents *inside* enterprises' own repos. CodeRabbit raised $88M (valued near $550M), Graphite raised a $52M Series B before being acquired by Cursor, and Greptile raised a $25M Series A, all reviewing a team's *own* pull requests. OpenHands is an agent runtime. Every funded player assumes you are inside the org.

Nobody owns the boundary. No VC-backed tool answers the outside contributor's questions: can I contribute here, is this issue secretly taken, what are this repo's gates and AI policies, who else is racing me. And no VC-backed tool answers the maintainer's questions: which of these 30 open PRs are duplicates, who is claiming what, which claims have gone stale, which agent-written PRs are safe to merge. Greenlight is that layer, built from running real contribution campaigns through it every week.

## The problem

AI made code cheap. Contribution coordination is now the bottleneck, and it breaks in specific, repeatable ways:

* **Hidden competition.** Issue list views lie. In a hand-vetted focus session on usebruno/bruno, 6 of 7 promising issues were secretly taken by PRs visible only in the issues' timelines, not in the list view or search results. You can spend a weekend on work that was already done.
* **Gates and bans.** Greenlight's own Agent Policy Index now tracks 505 repos: 127 of them (25%) carry contribution gates, and 19 ban agent contributions outright. Whole repos (nuxt, uv, Gradio, Activepieces) have closed their doors to outside PRs entirely. Nobody told you; it was in AGENTS.md.
* **Duplicate AI PRs.** When several contributors (human or agent) race the same issue, maintainers get three overlapping PRs and no way to arbitrate. GitHub has no claim system, only comments.
* **House rules everywhere.** CLAs, DCO sign-off, changesets, commit formats, assignment requests. Every repo invents its own, hides them in different files, and rejects your PR on the technicality.

These are coordination problems, not coding problems. The code agents keep getting better; the boundary keeps getting messier. Greenlight works the boundary.

## What Greenlight does

Three layers, from decide to solve to coordinate:

| Layer | Question it answers | Flagship commands |
|---|---|---|
| **Decide** | Is this issue mine to take? Is this repo worth my time? | `check`, `scan`, `friction`, `xray`, `wave`, `preflight` |
| **Solve** | Will my PR pass? What broke? What do I do next? | `ci-prep`, `ci`, `review`, `brief`, `verify`, `autopilot`, `babysit`, `evidence` |
| **Coordinate** | Who is working on what, and who resolves conflicts? | `claim` (+ Claim Protocol), `guard`, `radar`, `digest`, `passport` |

* **Decide.** `check` reads an issue, its comments, linked and mentioned PRs (timeline plus search plus comment references), and the repo's rules, then answers in plain words: GO, RISKY, TAKEN, GATED, or STALE. `scan` ranks a repo's open issues so you pick a winnable one first. `friction` scores a repo 0 to 100 on how hard it really is to get a PR merged, with every gate quoting the file its evidence came from. `xray` (Timeline X-Ray) deep-verifies candidates against their issue timelines before you write a line, catching hidden in-flight PRs including reporter-owned fix PRs; `scan --deep` demotes anything taken before it shows you the list. `wave` turns the Agent Policy Index into a build queue in one command: winnable open repos, x-rayed starter issues, behavioral gates excluded.
* **Solve.** `ci-prep` runs a repo's own pull-request checks locally before you push (tests, lint, typecheck, plus conventions like changesets, commit format, DCO), so avoidable CI failures never appear in front of a maintainer. `ci` triages red PRs into pre-existing vs likely-yours vs external-blocker against base-branch history. `review` classifies every review thread as likely-real, likely-noise, or needs-decision and drafts your replies. `verify` reports the honest red-green test delta of your change. `autopilot` verifies bot findings against the code at head and fixes the mechanical items (DCO surgery, conflict re-merges, formatting) itself. `brief` assembles a verified one-screen brief for any PR: change shape by area and risk, CI triaged against base-branch history, findings classified real vs false-positive with evidence, test evidence present or explicitly marked absent, merge blockers, and a one-line look-at-this-first. `babysit` watches your open PRs and reports one prioritized action list.
* **Coordinate.** `claim` posts a protocol claim (expiring lease, public queue, heartbeats; full spec in [`protocol/SPEC.md`](protocol/SPEC.md)), with a hosted app client option via `--via-api`. `guard` analyzes an incoming PR for a maintainer: competing fix, prior claims, missing artifacts, first-time contributor. `digest` reports a repo's PR races, claimed-by-other conflicts, stale claims, and assignment-gate conflicts. `radar` scans the whole open-PR queue and clusters competing or duplicate PRs with evidence per cluster and a suggested keep, labeled a heuristic, never a verdict. `passport` renders a contributor's merged work plus claim record.

Every verdict and every report cites its evidence: the quoted policy line, the claim comment URL, the PR number, the failing check. Nothing is asserted without a source.

## Who it is for

* **Contributors (human).** Run `check` before you spend an evening on an issue. Run `scan` when you are picking what to work on. Run `ci-prep` before you push.
* **AI agents and coding tools.** One command (`init --agent claude-code`, also cursor, copilot, windsurf, cline) installs the MCP config plus the one behavior rule: check Greenlight before opening a PR. Agents waste the most tokens fixing already-taken issues; 28 MCP tools make the whole engine available mid-run.
* **Maintainers.** `guard` on each incoming PR, `radar` across the whole open queue, `digest` for the weekly triage, and the roadmap below for the control room: stale-claim sweeps, policy enforcement, AI-PR filtering.

## Proof, stated plainly

* 965 tests, all passing, including a fixture corpus pinned to real campaign cases (a taken issue, a weak PR mention, claim-first gates, scoped claims, half-shipped issues, stale claims, paused-PR workflows).
* Dogfooded on real campaigns: the toolkit has authored 80+ pull requests across dozens of public open-source repos. Every feature exists because a real contribution died without it.
* Distributed everywhere the audience already looks: npm (`@reneturcios/greenlight`), the MCP Registry, and GHCR (`ghcr.io/cloudcorprecords/greenlight`), plus Docker and direct MCP stdio.
* Two living datasets ship with it: the Contribution Friction Index (`data/friction-index.json`) and the Agent Policy Index (505 repos, 127 gated, 19 agent bans, published at `docs/policy.html`), both built from real campaign field work, not scraped guesses.

## Watch it work

![Greenlight demo](docs/assets/greenlight-demo.gif)

*The 59-second demo: real issue checks on real repos, an AI-caught hidden claim, a GATED agent ban, campaign scouting, and the claims babysitter. [Full narrated video](docs/assets/greenlight-demo.mp4).*

## Install

```bash
npx @reneturcios/greenlight check <issue-url>
```

Set up your AI coding tool and verify the setup:

```bash
npx @reneturcios/greenlight init --agent claude-code   # one-command MCP setup (cursor, copilot, windsurf, cline work too)
npx @reneturcios/greenlight doctor                     # checks Node version, token, GitHub quota, cache
```

Or from source:

```bash
npm install
npm run build
```

Set `GITHUB_TOKEN` (a classic personal access token, no scopes needed for public repos) to raise the GitHub API rate limit from 60 to 5000 requests per hour. Greenlight caches API responses under `~/.cache/greenlight`.

Run the MCP server with `npx @reneturcios/greenlight mcp` (stdio), or point your agent at the `greenlight` command with the single argument `mcp`.

### Run it with Docker

Greenlight also ships as a container image on GHCR: `ghcr.io/cloudcorprecords/greenlight`.

Use it as a stdio MCP server:

```bash
docker run -i ghcr.io/cloudcorprecords/greenlight
```

Any CLI command can be passed after the image name instead of the default `mcp` argument:

```bash
docker run ghcr.io/cloudcorprecords/greenlight check <issue-url>
docker run ghcr.io/cloudcorprecords/greenlight --version
```

## Use it inside your AI coding tool

One command sets it up:

```bash
npx @reneturcios/greenlight init --agent claude-code
```

(also `cursor`, `copilot`, `windsurf`, `cline`; repeat `--agent` for more than one). Init copies the MCP config into your project and installs the workflow instruction snippet that teaches your agent the one behavior rule: **check Greenlight before it opens a PR.** Prefer doing it by hand? The [`integrations/`](integrations/README.md) drop-in pack has ready-to-copy MCP configs plus the same snippets. Then verify with a "list your MCP tools" prompt; the greenlight server carries 28 tools (see the list below).

## CLI

```bash
# One-command setup for your AI coding tool (cursor, copilot, windsurf, cline work too)
npx @reneturcios/greenlight init --agent claude-code

# Verify the setup: Node version, token, GitHub quota, cache (exit 1 when anything fails)
npx @reneturcios/greenlight doctor

# Help: overview, one command's flags, or the version
npx @reneturcios/greenlight help check
npx @reneturcios/greenlight --version

# Verdict for one issue
npx @reneturcios/greenlight check https://github.com/batrapulkit/squidbrake/issues/74

# [GO] batrapulkit/squidbrake#74
#   Taint: tell the approver when an agent edits its own setup right after reading outside content
#   - open, unassigned, no linked PRs, no claim signals, no blocking gates

# Rank a repo's starter issues, GO first (falls back to recent open
# unassigned issues when the repo does not use those labels; --no-fallback to opt out)
npx @reneturcios/greenlight scan PrefectHQ/fastmcp

# Deep-verify candidates against their timelines first (catches hidden in-flight PRs)
npx @reneturcios/greenlight xray usebruno/bruno --issues 8149,9319
npx @reneturcios/greenlight scan usebruno/bruno --deep

# Friction score for a repo
npx @reneturcios/greenlight friction triggerdotdev/trigger.dev

# CI triage for a red PR: is each failing check yours or pre-existing?
npx @reneturcios/greenlight ci https://github.com/reticlehq/reticle/pull/1620

# [pre-existing] install-gate (windows-latest)
#   same check failing on base: 2 of 3 recent base runs, last at 2026-10-14T10:00:00Z

# [external-blocker] Vercel - Authorization required
#   check name matches the Vercel deploy/auth pattern; this failure is infrastructure, not the PR

# JSON output for scripting
npx @reneturcios/greenlight ci <pr-url> --json

# CI pre-flight: run a repo's own PR checks locally before pushing (exit 1 on NO-GO)
npx @reneturcios/greenlight ci-prep ~/work/bruno

# [PASS] tests (workflow ci, job build)
# [SKIPPED] publish (workflow release, job release) - publishes a package
# [PASS] convention: DCO sign-off
# Verdict: GO

# Review triage for a PR with review feedback: which comments need you?
npx @reneturcios/greenlight review https://github.com/n8n-io/n8n/pull/41235

# Verified review brief for any PR: change shape by area and risk, CI
# triaged against base-branch history, findings classified with evidence,
# test evidence present or explicitly marked absent, merge blockers, and
# a one-line look-at-this-first
npx @reneturcios/greenlight brief https://github.com/usebruno/bruno/pull/9569

# Brief: 4 files (+335/-11), 2 source + 2 tests
# CI: code checks green; external blockers named (fork workflows require maintainer approval)
# review: NO FINDINGS
# blockers: none
# lookFirst: No blockers or real findings. Start here: 2 source files carry the change.

# Campaign scout: rank repo targets, dedupe against the campaign file, append as SCOUTED
npx @reneturcios/greenlight scout --repos acme/widgets,acme/gadgets --campaign campaign.json --write

# Babysit your registered claims: linked, linked-dead, healthy-active, heartbeat-due, expiring, unlinked-stale, queue-lost
npx @reneturcios/greenlight babysit --claims-only
# A claim whose linked PR closed unmerged reads linked-dead, with a release
# prompt: the issue is free, but the stale marker needs an explicit release.

# Pacing: claim posts never trip GitHub's anti-spam flag
# Every post attempt is ledgered at ~/.greenlight/posting-ledger.json
# (timestamp, kind, target, outcome). Claim posts enforce a minimum
# interval (default 90s, jittered; GREENLIGHT_CLAIM_MIN_INTERVAL_S, or
# --min-interval) and a daily soft cap (default 25 per rolling day;
# GREENLIGHT_CLAIM_DAILY_CAP, 0 disables). A post that fails with a block
# or an uncertain network error is marked UNCONFIRMED; the tool re-reads
# the target against the API before ever posting to it again, so a
# "failed" post that actually landed is marked confirmed and never
# reposted. --force overrides any pacing refusal, and the override is
# ledgered. greenlight status shows your pacing posture.
npx @reneturcios/greenlight status https://github.com/owner/repo/issues/123

# Maintainer guard for an incoming PR: competing fix, prior claims, missing
# artifacts (changeset / DCO / CLA), first-time contributor. Renders markdown
# ready to post as one comment; Greenlight itself never posts.
npx @reneturcios/greenlight guard https://github.com/owner/repo/pull/123

# Greenlight guard: 1 thing to check
#   - Missing release-note file (repo uses .changes/): expected .changes/123-slug.md
npx @reneturcios/greenlight guard <pr-url> --quiet   # exit 3 when flagged, silent otherwise

# Duplicate/competing PR radar for the whole queue: clusters PRs fixing the
# same issue or touching the same files, with evidence and a suggested keep
# per cluster (always labeled a heuristic, never a verdict)
npx @reneturcios/greenlight radar usebruno/bruno --limit 100

# 100 open PRs scanned in 6 API calls: 3 competing clusters, 94 unclustered
# cluster (same issue #5011): #5016 "Fix: Param table UI breaks bug" ~ #5074 "fix: Param Table UI Breaks on resize" - suggested keep #5016 (heuristic)
# cluster (file overlap, 100% Jaccard in packages/): #3484 ~ #5747 - suggested keep #3484 (heuristic)

# Verified comment for a maintainer-only repo: the issue takes no outside
# PRs (inspector, servers), so the contribution is a detailed, verified
# comment. Assembles from your notes or a markdown file; sections you
# leave empty render as explicit gaps, never filler. Never posts.
npx @reneturcios/greenlight verify-comment https://github.com/modelcontextprotocol/inspector/issues/2723 \
  --claim "TUI tests append to the developer's real ~/.mcp-inspector/auth.log" \
  --env "modelcontextprotocol/inspector @ 3a4b5c6, 2026-10-15" \
  --repro $'point HOME at a scratch dir\nrun: vitest run __tests__/App.test.tsx' \
  --observed "155 lines appear in the scratch HOME's auth.log" \
  --expected "test runs leave the developer's home directory untouched" \
  --root-cause "clients/tui/__tests__/setup.ts does not isolate the log dir" \
  --fix "per-test-file temp dir via fs.mkdtempSync, set MCP_INSPECTOR_LOG_DIR, remove on exit" \
  --ran "vitest run __tests__/App.test.tsx: 130 passed" \
  --by "@CloudCorpRecords"
# or: greenlight verify-comment <issue-url> --from-file notes.md

# Honest red-green test delta, in your repo checkout: runs the detected
# test command on a base worktree and your working tree, and reports what
# your change actually did: newly passing (fixed), newly failing (yours),
# still failing (pre-existing, not yours). Says "unverifiable" with the
# reason instead of guessing when it cannot run or parse.
cd your-repo && npx @reneturcios/greenlight verify --base origin/main
# exit 3 when new failures exist, 1 when unverifiable

# PR babysitter: one prioritized action list across your open PRs --
# needs you now, waiting on them, quiet. Reruns report what changed.
npx @reneturcios/greenlight babysit --mine --repos acme/widgets,acme/gadgets
# or: greenlight babysit --prs <url1>,<url2> --fail-on-action   (exit 3 when action is needed)

# Verified PR evidence pack: guard + CI triage + review triage + protocol
# status of linked issues, in one markdown document where every claim
# cites its source. The test delta comes from a verify report you pass in.
npx @reneturcios/greenlight evidence https://github.com/acme/widgets/pull/42 --out EVIDENCE.md
# or: greenlight evidence <pr-url> --verify-json verify.json

# Contributor passport: protocol claims from the public Claim Ledger plus
# merged PRs from GitHub. No Ledger file yet? It says so plainly.
npx @reneturcios/greenlight passport CloudCorpRecords

# The proxy, for authenticated reads (60/hr anonymous -> 5000/hr token):
# reads GITHUB_TOKEN once at startup, attaches it server-side, binds
# 127.0.0.1 only, and refuses to start without a token.
export GITHUB_TOKEN=<your-classic-token> && greenlight proxy &
export GREENLIGHT_GITHUB_BASE_URL=http://127.0.0.1:8792 GITHUB_TOKEN=proxy

# Verify every link of a release chain (tag, commit, release, npm, registry)
npx @reneturcios/greenlight shipcheck <owner/repo> --version x.y.z
```

Real examples from our vetting:

* `batrapulkit/squidbrake#74` scores **GO**: 0 comments, labeled help wanted, no claims, no gates.
* `shadcn-labs/pdfcn#58` scores **RISKY** (claimed flag): a volunteer asked for assignment the same day we vetted it.
* `langchain-ai/langchain#41185` scores **TAKEN** (claim race): 3 strong claimants while still "unassigned".
* `PrefectHQ/fastmcp#5718` scores **GATED**: FastMCP requires assignment or a "prs welcome" label before a PR.
* `triggerdotdev/trigger.dev#5016` scores **GATED**: unvouched-author PRs are auto-closed, a vouch request goes first.

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

Tools (28):

* `check_issue` - verdict for one issue URL
* `scan_repo` - rank a repo's open issues, GO first (label-tagged starter issues, falling back to recent open unassigned issues; `deep: true` timeline-x-rays the candidates first)
* `xray_issues` - Timeline X-Ray: deep-verify candidate issues against their timelines (hidden in-flight PRs, reporter-owned fix PRs, comment claims); GO / RISKY / TAKEN per issue with PR evidence
* `repo_friction` - friction score for a repo
* `wave_queue` - build queue in one call: filters the Agent Policy Index for winnable open repos, x-rays starter issues (CLEAR / RISKY / TAKEN), excludes behavioral gates, skips repos where you already have an open PR
* `claim_issue` - verdict-gated claim comment (dry run unless `execute: true`)
* `prep_issue` - fork and branch check plus a local PREP.md checklist with the repo's learned conventions (dry run unless `execute: true`)
* `open_pr` - DCO-aware PR opening from a fork branch (dry run unless `execute: true`)
* `ci_prep` - run a repo's own PR checks locally before pushing (exit 1 on NO-GO)
* `ci_triage` - classify each failing check on a PR as pre-existing, likely-yours, indeterminate (with a stated lean), or external-blocker, by comparing against the base branch's recent check history
* `review_triage` - triage the review feedback on your PR: each finding classified likely-real / likely-noise / needs-decision with its reason and a reply draft (humans are never called noise; drafts only, nothing posted)
* `pr_brief` - verified review brief for any PR: files grouped by area/risk, CI triage against base-branch history, findings classified real vs false-positive with evidence, test evidence present or explicitly marked absent, merge blockers, and a one-line look-at-this-first (never invents findings)
* `guard_pr` - maintainer-side analysis of an incoming PR: competing fix, prior claims by someone other than the author, missing artifacts (changeset / DCO / CLA), first-time contributor. Returns comment-ready markdown (never posts).
* `repo_digest` - repo-level maintainer report: PR races with first-claim arbitration, claimed-by-other conflicts, stale claims, assignment-gate conflicts, triage-held issues (never posts).
* `pr_radar` - maintainer-side duplicate/competing PR radar: clusters a repo's open PRs into competing sets (same target issue, or high changed-file overlap) with evidence per cluster and a suggested keep (always labeled a heuristic, never a verdict; never posts).
* `claim_status` - Claim Protocol pre-flight for one issue: who holds it, until when, who is queued, competing PRs, gates, whether the repo honors the protocol
* `preflight` - the one-call answer: claim_status plus the repo friction summary
* `verify_comment` - draft the verified-finding comment for maintainer-only repos (draft only, never posts)
* `babysit_prs` - watch open PRs and get the one prioritized action list (needs you now, waiting on them, quiet), diffed against stored watermarks; also watches the my-claims registry (linked, healthy-active, heartbeat-due, expiring, unlinked-stale, queue-lost)
* `evidence_pack` - the Verified PR evidence pack for one PR: guard verdict, CI triage, review triage, protocol status of linked issues, every claim citing its source
* `scout_campaign` - campaign mode: rank repo targets, dedupe against the campaign file, resume on API-budget exhaustion
* `my_claims` - the claims registry: linked, healthy-active, heartbeat-due, expiring, unlinked-stale, queue-lost
* `sync_campaign` - reconcile local tracking with API truth (drift, state mismatches, stale claims)
* `campaign_portfolio` - one-screen campaign summary: census counts, claims by state, pending queue, drift count
* `autopilot_report` - per-PR feedback classification (read-only; verify bot findings, triage CI, mechanical fixes as plans)
* `api_status` - hosted claim API status
* `claim_via_api` - claim through the hosted claim API
* `heartbeat_via_api` - heartbeat through the hosted claim API

Run it locally: `npm run dev` (MCP entry is `src/index.ts`; CLI is `src/cli.ts`).

## How scoring works

The verdict engine is deterministic (no LLM) and checks, in order:

1. Closed issue: **TAKEN** (never landable).
2. Any assignee: **TAKEN**.
3. An open linked PR that **closes** the issue: **TAKEN**. A PR that merely mentions the issue number (like pdfcn PR #91, which closes #70 but lists sibling issues in its body) only adds a `weak-pr-mention` flag and downgrades an otherwise-GO verdict to **RISKY**. Marked a duplicate of an issue closed as completed: **RISKY** with the `duplicate-of-closed` flag (the work already shipped; a still-open duplicate target only adds a `duplicate-of-open` warning with its URL).
4. Two or more strong claimants: **TAKEN** (claim race).
5. One strong fresh whole-issue claim (under 45 days): **RISKY** with the `claimed` flag. A fresh claim scoped to part of the issue ("taking the remaining fallback ask"): **RISKY** with `claimed` + `partial-claim` flags and a reason naming the claimer and the scope, never TAKEN.
6. One strong claim older than 45 days with no closing PR: **RISKY** with the `stale_claim` flag. The claimant probably walked away, but nobody knows for sure. Stale scoped claims get the same treatment.
7. A hard gate (assignment, vouch, collaborators-only, paused unsolicited PRs, external PRs auto-closed by workflow) with nobody assigned: **GATED**. The last two come from CONTRIBUTING language ("paused unsolicited pull requests") and a scan of `.github/workflows` for close-external-PR automation.
8. No activity for 180+ days: **STALE**.
9. A soft claim-first gate (the repo asks contributors to comment before starting, like pdfcn): never **GATED**; it caps an otherwise-GO verdict at **RISKY** with a note, the same downgrade shape as a weak PR mention.
10. Otherwise: **GO**.
11. An open PR referenced in a non-author comment whose title/body mentions the issue number: downgrades an otherwise-GO verdict to **RISKY** with the `comment-mentioned-pr` flag ("may already cover part of this issue"). Neither can produce **TAKEN**; only closing PRs do that. Fix-announcement comments ("/attempt #N" commands or "Submitted fix for ... in <PR url>" narratives, often linking PRs in sibling repos) get the same downgrade under their own reason quoting the PR URL, with the `attempt-linked-pr` flag, even when the PR never names the issue. `/attempt` comments also register as strong claims.
12. **Partially-addressed**: merged PRs that reference the issue number (comment-mentioned or linked), or maintainer comments signaling part of the work already shipped ("Half addressed by #905, leaving this open for half B", "Shipped in v3.1.0" next to the issue reference). A plain **GO** hides the scoping work this needs, so the flag `partially-addressed` is added, an otherwise-GO verdict is capped at **RISKY** with a reason like "part of this issue already shipped (PR #905, merged); scope your work to what remains". Never **TAKEN**.

Friction score starts at 100 and subtracts gate weights (assignment -25, vouch -35, collaborators-only -50, paused unsolicited PRs -40, external PRs auto-closed -50, discussion-first -10, claim-first -5, CLA/DCO -5 each, detected behavioral gate -20), adjusts for external PR merge rate and review/response times when computable, and adds up to +10 for open good-first-issues. Unknown signals stay null and are skipped, never guessed. See `src/friction.ts` for the exact formula.

A behavioral gate is not a policy file: it is read from what maintainers do. `friction` walks the closed-PR list until it has the 15 most recent closed-unmerged PRs, then reads maintainer-side comments for AI-rejection evidence (AI attribution plus rejection language, explicit phrases like "AI slop" or an invoked "AI policy", with welcoming overrides like "AI-assisted PRs are welcome" suppressing the signal). Two independent PRs mark the repo as behaviorally gated; a single weak signal is carried as a warning, while a single explicit rejection phrase detects on its own. `friction --json` reports it as `behavioral_gate` (`detected`, `strength`, `threshold`, `evidence` with PR numbers, quotes, and URLs, `notes`), so index pipelines like the rebaseline can reclassify repos whose written policy is silent but whose practice is hostile. API cost is bounded at 18 calls: up to 3 list calls to collect 15 closed-unmerged PRs plus one comment page per PR; skip it with `--no-behavioral`.

`wave` turns the Agent Policy Index into a build queue in one command: pure-open repos with outsider merge share, star band, and starter issues are x-rayed with the existing xray engine (CLEAR / RISKY / TAKEN with competing PRs named), repos with detected behavioral gates are excluded, repos where you already have an open PR are skipped, and the run stops with partial results when the core API budget falls under the floor (default 800). Human and `--json` output; every stage reports the API calls it used.

### Agent-policy gates and triage holds

Policy files are read where repos actually keep them: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and `AI_POLICY.md` at the repo root, in `.github/`, and in `docs/` (first hit per filename wins), plus the org-level `.github/AI_POLICY.md`. Two gate kinds parse agent rules:

* `agents_banned` is a hard gate: a repo that bans autonomous-agent contributions scores **GATED**, with the quoted policy line as evidence, and `claim` refuses it like TAKEN unless `--force`.
* `agents_disclosure` is a flag, never a verdict change: repos that require an AI prefix or disclosure get concrete required actions from `prep` and `check`.

A bot triage notice ("wait until maintainers remove the triage or approval label before opening a pull request") or a triage label marks an issue as held: `check` names the hold and caps an otherwise-GO verdict at **RISKY** with the `triage-hold` flag (never TAKEN), and `scan` demotes held issues below clean ones. Held issues are future pipeline, not current work.

## Optional AI claim detection

The pattern layer cannot know every way a human says "I'm taking this" (one evening it missed "I'm looking into contributing a fix here" on a real issue). Set `FIREWORKS_API_KEY` and `check` gains an optional second pair of eyes: a cheap Fireworks model reads the eligible comments (bots and the issue author excluded, same pool as the patterns) and flags statements of intent the patterns missed.

The governance is plain:

- **Off by default.** No key, no calls, output byte-identical to the pattern-only engine.
- **Patterns stay primary and cheaper.** The AI only runs when they found no strong claim.
- **Flags, never verdicts.** An AI flag adds the `llm-claim` flag with the exact quote as evidence and downgrades an otherwise-GO verdict to **RISKY**. It can never produce **TAKEN** and never overrides **GATED**. Verdicts stay deterministic.
- **No invented evidence.** The quote must be an exact substring of the comment body; anything else is dropped before it can reach the verdict.
- **Failures are silent.** A timeout, a non-200 response, or an unparseable reply returns no signal, never an error into the check path. Classifications are cached by comment id and model id, so repeat checks cost nothing.

`greenlight doctor` reports whether the layer is configured (the key is never printed).

## Automation

Greenlight automates the contribution pipeline its author ran by hand
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
  its changelog from a `.changes/` directory, which root package.json scripts
  exist, and whether recent commits follow Conventional Commits.
  Binding rules increasingly live in `AGENTS.md` rather than CONTRIBUTING,
  and prep reads those too.

## The toolkit

Greenlight is the front door of a four-tool lifecycle for open-source contribution work, all published under the same npm scope and cross-wired:

1. **gatefile** (`npx @reneturcios/gatefile extract owner/repo`) extracts a repo's contribution gates into a committed `contribution-gates.json`. Greenlight consumes that file directly: `greenlight check <issue-url> --gates-file contribution-gates.json`, or automatically when the file sits in the working directory, so gates are answered once and reused instead of re-derived from prose.
2. **greenlight** verdicts, scans, claims, prep, and PR opening (this tool).
3. **claimcheck** (`npx @reneturcios/claimcheck claims owner/repo`) watches claimed issues for stale claims and finished fixes parked on forks, the two ways claimed work silently dies.
4. **prwatch** (`npx @reneturcios/prwatch attention --user you`) triages your open PRs by what needs you right now: review threads, failing checks, conflicts, reviewer silence.

Each tool is a CLI and an MCP server (`<tool> mcp`).

## The friction index

`data/friction-index.json` is a checked-in, growing dataset of scored repos. It starts with the MCP/AI ecosystem we hand-vetted on 2026-10-13 (FastMCP, trigger.dev, langchain, deepagents, openclaw, squidbrake, reticle, pdfcn, chatflow-agent, and the three MCP SDK repos). Regenerate it with `npm run index`.

Entries labeled `hand-verified 2026-10-13` come from reading the repos' actual policies and issue trackers by hand. Entries labeled `live` were parsed from live house-rules files (CONTRIBUTING variants, AGENTS.md, CLAUDE.md). Each gate records which file its evidence came from. Computed outcome fields (merge rates, review times) stay `null` until we can compute them honestly, never fabricated.

The published page ([cloudcorprecords.github.io/greenlight](https://cloudcorprecords.github.io/greenlight/)) adds the Agent Policy Index: 505 repos evaluated for contribution gates and AI policies, with quoted evidence per entry. Nobody else publishes this map.

## Development

```bash
npm test    # tsx --test, includes fixture tests that reproduce our real verdicts
npm run build
```

## Roadmap

Clearly marked: these are not shipped yet. (v0.15.0 moved two roadmap items into the product: `radar` is duplicate/competing PR clustering, and `brief` is the verified review brief for any PR.)

* **Maintainer control room.** `guard` works per PR and `radar` clusters the queue (both shipped); the control room is the hosted per-repo surface built on top: stale-claim sweeps with one-click release requests, first-time-contributor risk notes, and a weekly maintainer digest. The engine pieces exist; the product is the assembly plus hosting.
* **Policy enforcement packs.** Repos keep inventing the same rules (changeset required, release note required, DCO, AI disclosure). A policy-pack format (built from `gatefile` output) that a maintainer adopts in one file, enforced by the Action with the same quoted-evidence style.
* **AI PR volume defense.** The filter, not the ban: `guard` scoring incoming PRs for claim legitimacy, repro evidence, and test deltas, so maintainers can keep the door open to good agent work while filtering spam. The campaign data (refused claims, honest verify, evidence packs) is the proof set.
* **Claim arbitration as a service.** Two claims, one queue, public ordering, maintainer override: live arbitration of competing claims, the piece maintainers cannot build themselves.
* Browser extension that scores issues inline on github.com.
* Parked-fix detection and auto-nudges: scan forks for branches referencing open issues and nudge when the gate is satisfied.

Full release history lives in [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT. See LICENSE.
