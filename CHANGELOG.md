# Changelog


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
