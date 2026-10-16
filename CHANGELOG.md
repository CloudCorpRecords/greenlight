# Changelog


## 0.4.1 (2026-10-16)

The onboarding release: two new commands plus help that teaches the tool, so a human or an agent goes from zero to a first verdict in minutes.

- **`greenlight init --agent <tool>` sets up your AI coding tool in one command.** It installs the MCP server config from the shipped `integrations/` pack (JSON-merging into an existing config so other servers are kept) plus the tool's instruction snippet, for `claude-code`, `cursor`, `copilot`, `windsurf` (home-level config merged in place), `cline`, and `generic`. `--agent` is repeatable and comma-separated, `--all` sets up everything, `--list` shows the tools, `--dry-run` previews without writing, `--no-instructions` installs the config only, and `--json` reports for scripts. Safety rules: instruction appends are marker-guarded and idempotent, nothing is overwritten without `--force`, and running bare `init` in a project names the tools it detects.
- **`greenlight doctor` checks the setup before anything else.** Node >= 20, token presence (a warning, never a failure), live GitHub quota via one `/rate_limit` call with the reset time quoted when exhausted, and cache-dir writability. Every WARN/FAIL carries its fix; exit code 1 only when something is actually broken.
- **Help everywhere.** `greenlight help [command]`, `greenlight <command> --help`, `greenlight --version`, per-command usage/flags/examples from one tested module, a quickstart-first overview, typo suggestions ("chek" -> "check"), and specific missing-argument errors instead of a bare usage dump. Parse errors now show the expected shape (`Not a GitHub issue URL: ... (expected https://github.com/<owner>/<repo>/issues/<number>)`).
- **Docs catch up.** The README's agent section leads with `init` (and now correctly counts 9 MCP tools), Install becomes a quickstart with real captured output, and a Troubleshooting section covers rate limits, URL shapes, the missing-server restart, init conflicts, and the cache. The integrations README documents `init` as the primary path with the copy table as fallback; snippet preambles read correctly whether installed by `init` or pasted by hand.
- 26 new tests (`init`, `doctor`, `help` suites, all offline); full suite and `tsc` clean. Honest limits: `init` cannot restart your editor for you, and `doctor`'s quota reading is a point sample on a shared hourly budget.


## 0.3.10 (2026-10-16)

Closes the three honest gaps from the v0.3.9 report:

- **Claim detection hears the most common phrasing.** The old patterns needed a tail like "on" or "up", so a bare "I'll take this" was invisible. A new `bare-take` pattern covers "I'll take this", "I'll take it", "I take this", "taking this", "I'll take this one", and "let me take this". It reads as a *soft* claim (intent, not a commitment of work), in the same family as "I can take this" and "take a look at this one", so it never caps a verdict alone; the guard still reports soft foreign claims. The critical guard: continuations that are not claims never match — "take this into account", "take this offline", "take this opportunity to ...", "take this with a grain of salt". This is user-visible: `check_issue` and `greenlight guard` now spot these claims on real issues.
- **The guard follows cross-repo issue links.** A PR opened in one repo that says "Fixes acme/widgets#123" (or "Fixes https://github.com/acme/widgets/issues/123") now has that issue's comments run through claim detection and its timeline walked for competing PRs, in the referenced repo. Findings name the full `owner/repo#N` in their evidence. Closing intent still required: plain mentions like "see acme/widgets#123" do not count.
- **Guard flag paths are live-proven.** The competing-fix path flagged a real race (ComposioHQ/composio#4700 vs open PR #4669 on issue #4668) and the foreign-claim path flagged two real pre-existing claims (firecrawl/firecrawl#4397 vs claims on #839 from 374 and 309 days before the PR), both through the built CLI against the live API.
- **Field-report fixes.** Claim detection now hears the pick-up family ("I can pick it up", "I can pick this up", "I'll pick this up", "let me pick it up") and availability asks with work intent ("Can I still work on this") as soft claims; physical pickups ("pick it up from the store") and "pick up the pace" are tested non-matches. The guard's expected changeset filename is built from a title slug again, so it renders `.changeset/4668-fix-time-format.md` instead of the doubled-number `.changeset/4668-pr-4668.md`. And a foreign claim older than 90 days at the PR's creation keeps its flag but gains an evidence line noting the age and that it may have been abandoned, so maintainers weigh it correctly.


## 0.3.9 (2026-10-16)

The maintainer guard: `greenlight guard <pr-url>` (and the `guard_pr` MCP tool) flips the engine around and answers a maintainer's question about an *incoming* pull request: is this worth my review time?

- **Four checks, all evidence-carrying.** Competing fix: the PR's body and branch are read for the issue it claims, then the issue's timeline is walked for *other open PRs already fixing it* (the e2b-dev/E2B#1986 and ComposioHQ/composio#4904 race shapes), reported by number and author. Claimed by someone else: the linked issue's comments are run through claim detection; a claim from someone other than the PR author that predates the PR is reported with claimant and date (a claim by the author is a pass, noted not flagged). Missing artifacts: repos detected to use `.changes/` or `.changeset/` flag a PR with no such file; DCO repos flag commits missing a `Signed-off-by` trailer; CLA-gated repos flag "CLA status not visible" (absence of evidence, stated as such, never an accusation). First-time contributor: a light note from the author's prior merged-PR count, skipped silently when the lookup fails.
- **Comment-ready markdown.** Default output is a short report starting with a one-line summary ("Greenlight guard: 2 things to check" or "Greenlight guard: nothing flagged"), carrying the hidden `<!-- greenlight-guard -->` marker. `--json` for machines, `--quiet` prints nothing unless flagged, and exit code 3 when findings exist so a workflow can decide. Greenlight itself never posts.
- **A GitHub Action wrapper.** New `action.yml` at the repo root (composite: setup-node, run the guard via npx on the published package, post or *update* a single comment through github-script by finding its own marker). New `examples/guard-workflow.yml` a maintainer copies into `.github/workflows/`, and `maintainer/README.md` docs: what each check does, the 2-minute install, and per-repo silencing via `.greenlight-guard.json` (boolean toggles for each check, honored by the CLI too).
- All detectors are pure functions over injected data with 6 corpus fixtures and a full orchestration test; the action.yml is asserted structurally in the test suite. Live-verified against a real campaign PR before shipping. Honest limits: the timeline walk cannot see private cross-repo PRs and the search fallback has indexing delay; CLA detection only sees what is on the PR; author history is one best-effort search call.


## 0.3.8 (2026-10-16)

The agent drop-in pack: one-line installs that plug Greenlight into the major AI coding tools, so your agent checks before it opens a PR.

- **`integrations/` ships in the npm package.** Ready-to-copy configs for Claude Code (`.mcp.json` + a CLAUDE.md snippet), Cursor (`.cursor/mcp.json` + a `greenlight.mdc` rule), VS Code / Copilot (`.vscode/mcp.json` using the `servers` key plus a `copilot-instructions.md` snippet), Windsurf (`mcp_config.json` for `~/.codeium/windsurf/mcp_config.json`), and Cline (`mcp_settings.json`), plus a canonical `mcp.json` for any other MCP client and an integrations README with the per-tool install table, the verification steps, and format notes with doc sources.
- **The workflow the agent learns.** Before coding for an issue: `check_issue`; stop on TAKEN or GATED and report why. `prep_issue` before claiming. `ci_triage` on a red PR before changing code. `review_triage` on review feedback: fix likely-real first, ask on needs-decision, push back on likely-noise with evidence. Never post claims or PRs without the human's go-ahead.
- All 8 tools verified over the real stdio server (`check_issue`, `scan_repo`, `repo_friction`, `claim_issue`, `prep_issue`, `open_pr`, `ci_triage`, `review_triage`); every config's command/args shape is asserted in the new `test/integrations.test.ts`. Honest limit: Cline and Windsurf config formats were verified against community docs rather than the vendors' own docs pages; everything else used official-adjacent references.


## 0.3.7 (2026-10-15)

Solve-first, part 3: `greenlight prep` now answers how to actually sign what the repo demands, what release-note artifact it owes, whether the fix is even in this repo, and what the house rules are at a glance.

- **The exact signing path.** Prep names the method with the real link or phrase: `cla-assistant` (with the CLA Assistant signature phrase), a repo-specific CLA bot (the signing-page URL extracted from the policy text, e.g. the n8n webhook/cla pattern), or `dco` (the `git commit -s` instruction) when no CLA exists. Both shown when a repo demands both.
- **The release-note artifact.** Detects `.changeset/` (changesets), `.changes/` (one file per change, e.g. `.changes/1147-slug.md`), towncrier fragments (`newsfragments/<issue>.<type>.md`, checked against the `[tool.towncrier]` config), and hand-written CHANGELOG instructions, and names the expected file in the checklist.
- **Fix-lives-here warnings.** Before the checklist, prep reuses the v0.3.4 server-side signal (quoted error text with zero code-search hits in the repo) and a satellite-repo hint that fires only on tight evidence: a companion repo URL immediately preceded by a code-location phrase like "source lives at" or "enforced by our backend" (the actualbudget label-bot case). Both warn prominently that the fix may not be buildable here.
- **House-rules summary block.** Claim style (assignment / comment-first / none) with its source file, PR title convention, draft-first norm, and the repo's test command, all with the file they came from. Live-verified on a real CLA repo (marimo-team/marimo#6250: names the repo's CLA page, no false satellite warnings) and a real DCO repo (reticlehq/reticle#1147: DCO, the exact `.changes/1147-*.md` artifact, Conventional Commits titles).
- All detectors are pure functions on injected text/data with 23 new tests; live probes degrade to "not detected" instead of guessing. CLI `prep --json` and the `prep_issue` MCP tool carry the new fields (additive; the dry-run default and CLI contract are unchanged).


## 0.3.6 (2026-10-15)

Solve-first, part 2: `greenlight review <pr-url>` (and the `review_triage` MCP tool) triages the review feedback on your own PR, so you know which comments actually need you.

- **Every review thread, one pass.** The command fetches the PR's reviews, inline review comments, and review-bot issue comments, and tells CodeRabbit, cubic, Greptile, and Copilot apart from human reviewers. Summaries, walkthroughs, praise, and findings on dismissed reviews are counted as noise or resolved, not findings.
- **Each finding gets a class with its reason.** `likely-real` when the comment's quoted anchor token is present in the anchored diff hunk (the bruno/CodeRabbit `__proto__` shape); `likely-noise` for findings on generated files, lockfiles, and snapshots, for style nits the surrounding code already contradicts, for anchor mismatches (the comment presents a token as present code but the hunk does not contain it), and for security claims whose premise the hunk contradicts (the n8n/cubic "calls fetch directly" shape, where the hunk shows `createAiProxyFetch`); `needs-decision` for bot questions and for every substantive human comment, which is never called noise. Mixed or unproven findings default to needs-decision too.
- **A reply draft for every finding.** likely-real gets a "Fixed in <next commit>" placeholder plus the one-line fix; likely-noise gets a polite evidence-carrying pushback with the file, line, and reason filled in; needs-decision gets a question back naming the tradeoff. Drafts only; Greenlight never posts anything.
- **Honest limits.** GitHub's REST API does not expose per-thread resolved state (GraphQL-only), so findings whose parent review was DISMISSED count as resolved; a thread resolved without dismissing its review still reads as open. The classifier is a pure function on injected data with 36 new tests and five frozen fixtures from real campaign rounds.


## 0.3.5 (2026-10-15)

Solve-first, part 1: `greenlight ci <pr-url>` (and the `ci_triage` MCP tool) answers the question every contributor asks on a red PR: is this failure mine or pre-existing?

- **Base-vs-head failure comparison.** The command fetches the PR's base ref and head SHA, collects the failing check runs on the head (with the first failure lines from annotations when available), and builds the same checks' history from the five most recent base-branch commits. Each failing check is classified: `pre-existing` (same check failing on base, with counts and the last failure time), `likely-yours` (failing on head, passing on base, and the PR touches files that relate to the check), `indeterminate` (no base signal to compare against), or `external-blocker` (Vercel/Netlify/deploy-preview authorization failures, which are infrastructure, not the PR).
- **Indeterminate checks state their lean.** When base history is thin, a check the PR does not touch leans pre-existing and says so ("none of the PR's files relate to it, so an unrelated flake is more likely"); one the PR does touch leans yours. The output never leaves the call ambiguous about its reasoning.
- **Summary verdict line.** One of NO FAILURES / ALL PRE-EXISTING / HAS LIKELY-YOURS / INDETERMINATE, in text and in the `--json` output (which mirrors `check --json` conventions).
- **Classifier is a pure function.** All rules run on injected data with no network, pinned to the campaign's real cases: reticle #1620's windows install-gate flake (pre-existing), a touched package's unit tests (likely-yours), reticle #1633's fixture test failing in an untouched package (pre-existing, or pre-existing-leaning indeterminate when base data is thin), and pdfcn/firecrawl's Vercel authorization check (external-blocker). The live layer degrades gracefully: unreadable base history or annotations produce indeterminate checks, never errors.
- 265 tests passing (36 new). New frozen fixtures in test/fixtures/ci-cases/.


## 0.3.4 (2026-10-15)

The "never race blind" pack: five of twelve claims in one evening were dead on arrival because the races lived in the issue timeline, not the comments, and two more efforts nearly burned on bounty and backend traps.

- **Timeline cross-reference rule (top rule).** `check` now reads the issue timeline for cross-referenced PRs. An OPEN cross-referenced PR caps the verdict at TAKEN with the `cross-referenced-pr` flag and the PR URL + title quoted, even when the PR body never says "closes #N". A merged one adds `cross-referenced-pr-merged` and caps an otherwise-GO verdict at RISKY with a "verify what shipped" note (never TAKEN; a merged PR can fix only part of an issue). Closed-unmerged cross-refs stay evidence only. This would have stopped all five superseded Wave 3 claims. (Live-verifying this caught and fixed a latent bug: the timeline reader looked at `event.source.html_url`, which the API never fills; the real shape nests it at `event.source.issue.html_url`, so the walk had been silently finding nothing.)
- **Emoji-proof fix announcements.** The attempt-linked matcher strips leading emoji and non-word characters per line before matching, and now also matches "Opened #NNNN" announcements. The "🤖 Opened #8474 with a focused fix" comment that v0.3.3 missed now registers.
- **Weak claims carry their age.** Soft claims ("I'm going to take a look at this one") are now a claim signal with the comment date; the verdict shows the claim and its age in days (flag `weak-claim`), warning only, never a verdict change.
- **Merge velocity signal.** `friction` now reports one more line when computable: the share of recent merged PRs authored by non-collaborators plus the median days to merge (e.g. "external merge share 40%, median merge 2.1d"), computed from a single API call via `author_association`. Signal only, never a verdict input.
- **Bounty liveness.** When an issue advertises a bounty, Greenlight classifies it: a dead platform (Algora: site 404s, API empty since 2025) gets a `bounty-platform-dead` warning; a bounty with no identifiable platform or payer gets `bounty-unverified`. A bounty never raises a verdict.
- **Possibly-server-side warning.** When a quoted error string from the issue body has zero hits in the repo, `check` adds the `possibly-server-side` warning. Any API failure degrades to no evidence rather than a guess (this would have flagged ComposioHQ/composio#4852's closed-backend 422 before a build burned on it).
- 227 tests passing (28 new). Field validation corpus grows to 20 cases.


## 0.3.3 (2026-10-15)

Three detection gaps closed from the same evening's field work, all verified live after the fix.

- **Paused-PR policies and auto-close workflows are GATED now.** Two finished PRs to activepieces/activepieces were auto-closed within about a minute by a workflow literally named "Close external PRs"; the policy sat in CONTRIBUTING.md ("We've temporarily paused unsolicited pull requests from outside the core team"), blamed on AI-generated PR volume. Both PRs had clean claims and builds, so nothing earlier could have caught them. Greenlight now scans CONTRIBUTING (and linked house-rules files) for paused/unsolicited-PR language as a new hard gate `unsolicited_prs_paused`, and lists `.github/workflows` to flag auto-close automation as `external_prs_closed`. Either gate verdicts GATED with the evidence quoted; friction weights are -40 and -50 respectively.
- **Duplicate-of detection.** n8n-io/n8n#41215 was a duplicate of #40803 (already closed as completed), and a full build was nearly wasted on it. Comments are now scanned for "duplicate of #N" phrasings (including GitHub's "marked as a duplicate of #N" and marked_as_duplicate timeline signals), and each target issue is fetched for its live state. A target closed as completed makes the verdict RISKY ("marked duplicate of #N, which is closed as completed"); a still-open target adds a `duplicate-of-open` warning with its URL instead of changing the verdict.
- **Comment-linked PR race detection.** tscircuit/tscircuit#5563 looked clean on list views, but a contributor had posted /attempt comments linking fix PRs for every sub-bug (in sibling repos the timeline never surfaces). Fix-announcement comments ("/attempt #N" commands, or "Submitted fix for bug #1 ... in <PR url>" narratives, from anyone but the issue author) now count as race signals: a linked open PR downgrades an otherwise-GO verdict to RISKY with the PR URL quoted (`attempt-linked-pr` flag), even when the PR never names the issue. `/attempt` (and `/claim`) comments also register as strong claims.
- 198 tests passing (28 new). Field validation corpus grows to 13 cases.


## 0.3.2 (2026-10-15)

The toolkit release: Greenlight now ships on npm as @reneturcios/greenlight, is listed in the official MCP Registry, and consumes gatefile output directly.

- **gatefile connection.** `check` and `scan` accept `--gates-file <path>` pointing at a contribution-gates.json produced by gatefile, and auto-detect `./contribution-gates.json` in the working directory when no flag is given. Machine-extracted gates merge over the prose-derived ones for any kind the prose pass missed, and their evidence strings are prefixed "gatefile:" so a verdict shows where each gate came from. Gatefile kinds map onto Greenlight's (discuss_first and issue_first become discussion_first; no_direct_prs becomes collaborators_only).
- **`greenlight mcp` subcommand.** The MCP server now starts from the single published bin (`greenlight mcp`, stdio), which is what the npm package and the MCP Registry entry invoke. The standalone server entry still works from source.
- **fastmcp-shaped contributing docs.** House-rule fetching now also reads docs/development/contributing.mdx and .md, where fastmcp keeps its binding rules behind a pointer CONTRIBUTING.md, and the assignment-gate rules match "must be assigned" / "must also be assigned" phrasings. Verified live: fastmcp #5755 verdicts GATED instead of GO.
- 170 tests passing (3 new).


## 0.3.1 (2026-10-15)

Two detection gaps closed from the same day's field work, both verified live after the fix.

- **Maintainer-only PR shops are GATED now.** modelcontextprotocol/inspector and modelcontextprotocol/servers both take issues and prompts rather than outside PRs, and say so in workflow language ("Pull requests against this repo are opened by the repo maintainers only", "We accept issues, not pull requests"). The gate parser only knew gate language, so both scanned GO with "no blocking gates" and an hour of fix work nearly went into PRs those repos close on sight. The collaborators_only rule now matches those phrasings (Markdown bold tolerated), the friction index hand-verifies both repos, and a negative test keeps ordinary maintainer language ("Only maintainers can merge pull requests") from firing it. After the fix, inspector #2723 and servers #5153 both verdict GATED with the evidence quoted.
- **Bare "I'd like to take this" claims register.** fastmcp #5743 carried a claim ("Hi, I'd like to take this. Plan: ...") that scan reported as no claim signals, because the existing pattern demanded a trailing "on"/"up". A new like-to-take pattern catches the bare form, with a guard so "I'd like to take this opportunity to thank ..." does not count. After the fix, #5743 reports its claim and verdicts RISKY.
- 167 tests passing (4 new).


## 0.3.0 (2026-10-14)

Covers the use cases hit during a full day of live contribution work, and validates against the real cases.

- **Gates from house-rules files, not just CONTRIBUTING.** reticle's binding rules (claim the issue first, DCO sign-off, add a .changes entry, run `pnpm verify` as one command) live in AGENTS.md, which CONTRIBUTING only links to. Gate extraction now fetches AGENTS.md and CLAUDE.md (root and .github/) alongside the CONTRIBUTING variants and runs the same gate rules over all of them. Each detected gate records which file its evidence came from, sources merge without duplicating kinds, and CONTRIBUTING variants win ties.
- **Partially-addressed detection.** reticle #894 sat open with half its work already shipped in v3.1.0 (merged PRs #905/#915) while the maintainer left it open for the rest; a plain GO hid that. A merged PR that references the issue number (comment-mentioned or linked), or maintainer comments like "Half addressed ... leaving this open" / "Shipped in v3.1.0", now add the `partially-addressed` flag, cap an otherwise-GO verdict at RISKY, and say exactly what shipped so the contributor scopes to what remains. Never TAKEN from this.
- **prep learns repo conventions.** During prep, Greenlight now gathers the repo's rituals for the PREP.md checklist: which house-rules files exist, the verify command they quote in backticks, whether the repo assembles its changelog from a `.changes/` directory, which root package.json scripts exist, and whether recent commits follow Conventional Commits. All best-effort probes, all shown in PREP.md under "Repo conventions" and in the JSON output.
- **Field validation corpus.** Ten real cases from the campaign, frozen as offline fixtures in `test/fixtures/cases/` and asserted by `test/cases.test.ts`: a taken issue, a weak PR mention, claim-first gates, assignment and vouch gates, a scoped claim, a half-shipped issue, a clean GO, and a stale claim. Every verdict rule is pinned to something that actually happened.
- README top rewritten in plain language: what Greenlight does in one sentence, the three failure stories that motivated it (claimed in a comment, asked-first gate, sign-off rejection), what it does in four steps, and when to use it.
- 159 tests passing (31 new).


## 0.2.2 (2026-10-14)

Claim-detection gap closed from a live near-miss: `reticlehq/reticle#691`
got a clean GO verdict while its comments held a partial claim ("Taking
the remaining fallback ask" by kushals256) and a heads-up that PR #861
covers that work. Both signals were invisible to the timeline and the
issue-number search, and work was nearly duplicated.

- **Scoped (partial) claims.** Four new claim patterns detect comments that
  take part of an issue, not the whole thing ("taking the remaining
  fallback ask", "claiming this half", "working on the remaining piece",
  "I'll take the fallback part"). Claim records now carry
  `scope: "partial"` (whole-issue claims stay `"full"`) plus the matched
  scope word. A fresh partial claim does not take the issue, but it
  downgrades an otherwise-GO verdict to RISKY with a reason naming the
  claimer and the scope ("kushals256 claimed the remaining part 5 day(s)
  ago; the rest may still be open"); stale partial claims get the same
  treatment as other stale claims. Scoped claims never form a claim race.
- **Comment-mentioned PR cross-check.** PR references (#NNN or full URLs)
  in non-author comments are fetched against the PR API (at most 5 per
  check; references that 404 are issue numbers and are skipped silently;
  cached like the rest of the issue data). An open referenced PR whose
  title or body mentions the issue number downgrades an otherwise-GO
  verdict to RISKY with flag `comment-mentioned-pr` ("PR #NNN referenced
  in comments may already cover part of this issue"). A merged one adds
  only an informational note. This can never produce TAKEN; only closing
  PRs do that.
- 128 tests passing (22 new).

## 0.2.1 (2026-10-14)

Three fixes from dogfooding the tool on real repos.

- **claim_first is now its own soft gate.** `src/gates.ts` used to file
  "comment before starting work" under `assignment_required`, which made
  every shadcn-labs/pdfcn issue read GATED even though commenting first is
  a ritual you satisfy by posting a comment (exactly what the sibling tool
  gatefile calls `claim_first`). The two comment/claim patterns moved to a
  new `claim_first` gate; `assignment_required` keeps only true assignment
  patterns ("ask to be assigned", "must be assigned", assignment before
  submitting). `claim_first` never produces a GATED verdict: like
  `dco_required` and `discussion_first` it is soft, capping an
  otherwise-GO verdict at RISKY with the note "repo asks contributors to
  comment before starting (claim first)". Friction weight -5 (less than
  assignment's -25). The `claim` command's default comment already
  satisfies the ritual, and a test pins that claim-first repos do not get
  the assignment-request variant.
- **Removed `/\bprs welcome\b/i` from the gate parser.** A "prs welcome"
  label is an alternative acceptance signal (seen on FastMCP), not a gate;
  it no longer feeds any gate kind.
- **`scan` falls back to recent open unassigned issues.** `greenlight scan`
  used to report "no starter issues found" for active repos like
  openclaw/openclaw and batrapulkit/squidbrake whose landable issues do
  not carry good-first-issue / help-wanted labels. When the label pass
  comes back empty, scan now lists the repo's recent open unassigned
  issues (pull requests and assigned issues excluded, capped at 25) and
  runs the same verdict checks on the newest 10, with a clear header note
  that these come from the fallback pass. Opt out with `--no-fallback`.
  The MCP `scan_repo` tool uses the same fallback.
- **`prep` learns the repo's branch convention.** Instead of blindly
  naming branches `feat/<slug>-<number>`, prep now reads the head branch
  names of the repo's 30 most recent closed PRs. When at least 3 share a
  dominant suffix token (like `-block` on shadcn-labs/pdfcn) or a common
  prefix style, the suggested branch follows it
  (`feat/quarterly-report-block`) while PREP.md still shows the default
  (`feat/quarterly-report-65`). No pattern, no change.
- The squidbrake friction-index hand entry was reclassified from
  `assignment_required` to `claim_first` to match the new gate kinds.

## 0.2.0 (2026-10-14)

Contribution automation. Greenlight now runs the pipeline its author ran by
hand for four real PRs (shadcn-labs/pdfcn #92-#95): verdict, claim comment,
fork branch, PR opening, with DCO awareness throughout.

- New `claim` command (MCP: `claim_issue`): runs the verdict pipeline first,
  refuses TAKEN or STALE issues unless `--force`, shapes the claim comment
  from the repo's gates (assignment-gated repos get an assignment request,
  vouch-gated repos are refused outright since a vouch cannot be automated).
- New `prep` command (MCP: `prep_issue`): checks (and with `--yes` creates)
  your fork and a branch named from the issue title (`feat/<slug>-<number>`),
  then writes a local PREP.md checklist with the verdict, gates, DCO
  reminders, and the exact next commands. Never clones.
- New `pr` command (MCP: `open_pr`): verifies the branch exists on the fork
  and is ahead of upstream, verifies every ahead commit carries a
  Signed-off-by line on DCO repos (refuses and lists the unsigned commits),
  then composes the PR title and body ("Closes #N" plus verdict and gates).
- Safety defaults: read ops stay tokenless; every write command is a DRY
  RUN until `--yes` (CLI) or `execute: true` (MCP); write commands require
  GITHUB_TOKEN (or GH_TOKEN).
- REST client gained a POST helper and an ApiNotFoundError for 404s; issue
  snapshots now carry the issue body for prep checklists.

## 0.1.1 (2026-10-13)

Fixed the linked-PR false positive reported as issue #1. `check` and `scan` no
longer mark an issue TAKEN just because an open PR mentions its number in
passing: shadcn-labs/pdfcn PR #91 closes #70 but lists sibling issues #60-#65
in its body, and that wrongly marked #61 and #71 as taken in v0.1.0.

- Every discovered PR is now fetched and scored with a new link-strength
  classifier (`src/linkstrength.ts`). A PR is "closing" only when its title or
  body uses closing keywords for the issue ("Closes #61"), the issue number
  appears in the PR title, or the issue number is a standalone token in the
  branch name ("feat/61-resume"). Everything else is a "mention".
- Timeline and text search remain discovery only; evidence comes from the PR
  itself. A PR that cannot be fetched defaults to "mention", never "closing".
- Verdict Rule 3 fires TAKEN only for an open "closing" PR. An open PR that
  merely mentions the issue adds a `weak-pr-mention` flag and downgrades an
  otherwise-GO verdict to RISKY ("verify it is not already being worked").
- Stale-claim Rule 6 now treats a "closing" PR, open or not, as "a PR was
  opened". Mentions never count as a linked PR there.

## 0.1.0 (2026-10-13)

First release. Availability verdicts (GO / RISKY / TAKEN / GATED / STALE) for
GitHub issues, repo friction scores, and scan mode ranking a repo's
good-first-issues. Ships as a CLI and an MCP server (check_issue, scan_repo,
repo_friction).
