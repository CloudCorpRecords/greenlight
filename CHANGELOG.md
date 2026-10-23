# Changelog

## v0.21.3 - 2026-10-23

- **Racecheck GL-1 completion: title-phrase distinctiveness floor.** The v0.21.2 production re-verification passed every mandated item (bruno#9611 racecheck RACE → SUSPECT with an empty rare set, xray TAKEN → RISKY, check RISKY → GO; kit#17529 still RACE naming the genuine triage-bot racer #17530 via its changed file; the @font-face PR dropped RACE → SUSPECT), with one residual: svelte's "Version Packages" release-train PR still graded RACE — not via terms, but via three TITLE-derived phrases ("adapter cloudflare", "platform proxy", "proxy wrangler") matched verbatim. Title bigrams are generated mechanically from title words, so a title phrase built only of generic vocabulary is generic vocabulary in sequence. The distinctiveness floor now covers title phrases: a title-derived phrase reaches RACE only when at least one of its words is distinctive; vendor/platform names (cloudflare, wrangler, vercel, …) join the non-distinctive set for title terms and title phrases (they remain RACE-grade in file paths, rare tokens, and quoted phrases). Author-quoted phrases are exempt and keep single-hit RACE grade — a quoted string is a deliberate artifact, usually error text. 3 new tests (1193 total); tool count unchanged at 33.

## v0.21.2 - 2026-10-23

- **Racecheck false-RACE fix (production validation GL-1, BLOCKER).** The 2026-10-22 production validation of the published v0.21.1 found usebruno/bruno#9611 — a clean, unassigned feature request — graded RACE with 15 RACE matches, every one built on the single "rare" token `e.g`: the prose abbreviation harvested from the issue body by the dotted-token scan, which `scoreCandidate` treated as RAGE-grade on a single hit; xray then escalated the same evidence to a hard TAKEN. Three fixes, each pinned both ways: (1) `specialTokens` no longer harvests prose abbreviations — a denylist (e.g, i.e, etc, vs, approx, …) plus the structural rule that a dotted token whose every segment is a single letter is an abbreviation, not a file or identifier; (2) a single NON-file rare hit no longer reaches RACE alone — file-like rare hits (a named file, a $-artifact) still do, and non-file rare hits reach RACE only with corroboration (a second distinct rare hit, a phrase hit, or a shared changed file); (3) the RACE-by-terms branch gained a distinctiveness floor — at least two of the title-derived term hits must be distinctive, so generic tech vocabulary (adapter, platform, proxy, env, keeps, reloads…) cannot carry a RACE alone (the same validation run graded svelte's "Version Packages" release-train PR and an @font-face PR as RACE on such words). Preservation pins: the v0.21.1 dependency-bot exclusion is untouched and still verified, a shared-file-plus-rare-hit is still RACE, two distinct rare hits still RACE, distinctive title terms (the svelte $types.d.ts fixture) still RACE, and the svelte racer pattern (file hit + strong keywords) still names the racer.
- **Search-discovered PR "mentions" are now verified (GL-2).** `fetchLinkedPRs` admitted every GitHub search hit for `#<n>` unverified; GitHub's search tokenization matches the bare digits inside attachment UUIDs, so bruno#9611 was downgraded to RISKY in `check` (and listed as referenced in xray) by PRs whose bodies contain the number only inside a `user-attachments` UUID. New `hasGenuineIssueReference` in linkstrength.ts is the missing third outcome next to closing/mention — NO reference: after the detail fetch, a search-sourced candidate with no `#<n>` token, no issue URL, and no branch token is dropped. Timeline-sourced candidates are exempt (the cross-reference event is the reference) and a failed detail fetch still fails open as a weak mention.
- **Friction now scores agent gates (GL-4).** `GATE_WEIGHTS` had no entry for `agents_banned` or `agents_disclosure`, so astral-sh/uv — whose org AI_POLICY closes autonomous-agent PRs — scored 100/100, tying genuinely gate-free repos as "easiest to land a PR in" for exactly the audience the ban targets. `agents_banned` now weighs -50 (on par with collaborators_only / external_prs_closed) and `agents_disclosure` -5 (on par with cla/dco); the lite path inherits the same table.
- **Server-side heuristic no longer labels feature-request examples as error text (GL-5).** `extractErrorStrings` accepted any capitalized double-quoted span as candidate error text, so a feature request's hypothetical folder name ("Public Subfolder") was reported as error text possibly enforced by a backend service. Double-quoted spans are now gated on error context in or around the span; backticked spans and explicit `error:` lines are unchanged.
- **Timeline cross-reference narration is precise (GL-3).** In `check`, when a closing PR already takes an issue, other timeline cross-references were all narrated as "also cross-referenced … and in flight" — including PRs in forks/other repos and mention-strength release-train PRs. Only same-repo, closing-strength cross-references keep the "in flight" phrasing; the rest are reported as plain cross-references. Verdicts are unchanged.
- 21 new tests (1190 total); tool count unchanged at 33.

## v0.21.1 - 2026-10-22

- **Racecheck no longer false-RACEs on dependency-update bot PRs.** The residual noise item from the v0.20.1 and v0.21.0 field batteries is fixed: in sveltejs/kit, PR #17481 ("chore(deps): update all non-major dependencies" by renovate[bot], branch renovate/all-minor-patch) scored RACE against issue #17465 because its body, a dependency table plus the upstream release notes of the bumped packages, shares enough problem vocabulary with the issue (6 term hits, 2 of them title terms, verified against the live API with the pre-fix scorer) to clear the RACE-by-terms bar. A bot PR that changes only dependency manifests and lockfiles cannot be implementing a feature or bug fix, so racecheck now runs one extra pass after scoring: a text-matching candidate that is bot-shaped (author is a known dependency bot such as renovate[bot] or dependabot[bot], or a similar bot login, or the head branch sits under renovate/ or dependabot/) gets its changed files fetched, and when every changed file is a dependency manifest or lockfile (package.json, package-lock.json, pnpm-lock.yaml, pnpm-workspace.yaml, yarn.lock, bun.lockb, Cargo.toml, Cargo.lock, go.mod, go.sum, Python requirements files, and their peers across ecosystems) the candidate is excluded from the verdict. Excluded PRs stay visible: the JSON gains an ignoredMatches list carrying the full match evidence, the changed files, and the ignore reason, the reasons array names each ignored PR, and the human output prints an [ignored] line. The guardrails are pinned by tests both ways: a renovate PR that also touches a source file still counts in full, a human PR with the same title, body, and dep-only file list still counts, and a bot-shaped PR whose file list is empty or unreadable fails open and keeps its score. The file check runs only for bot-shaped candidates, so the extra API cost stays bounded in huge queues (one fetch per bot-shaped match). The pulls list copy of a candidate now also contributes its head branch when the search copy arrived first, since search results carry no branch. 9 new tests (1169 total); tool count unchanged at 33.

## v0.21.0 - 2026-10-20

- **Hardening release.** A full adversarial pass over the parsers, the API layer, and the security surface; 43 new tests (1160 total, all passing), tool count unchanged at 33. Every fix below was found by a failing test or a live reproduction during the pass, and each is pinned by a regression test.
- **Gate extraction no longer reads URLs as prose.** parseGates matched gate patterns across a whitespace-collapsed document, so an issue-template URL containing "assignees=" plus an unrelated "Before submitting a PR" later in the doc read as an assignment gate (the huggingface/transformers false positive). URLs and any token carrying an "assignees=" parameter are now stripped before matching; genuine assignment prose still fires, pinned by tests both ways.
- **Radar branch extraction: bot task IDs are not issue numbers.** A branch like "bot/task-987654-2" yielded phantom issue 987654: the sub-counter rule skipped the trailing counter, but a task/run ID under the 999999 cap still counted as a bare mid-branch number. A bare number immediately followed by another numeric token is now treated as a counter namespace and never counts; explicit markers (a #N reference, an issue-prefix token, the segment-first convention) are unaffected.
- **API base URL is validated and sanitized.** GREENLIGHT_GITHUB_BASE_URL now goes through sanitizeApiBase: only http/https is accepted, embedded credentials, query strings, and fragments are stripped, and an invalid value falls back to api.github.com instead of being used verbatim. `doctor` renders the sanitized base in its report instead of echoing the raw env value, so credentials embedded in the URL can no longer leak into output. Sentinel-token tests pin that the GitHub token appears in no error message, request URL, doctor report, or cache file.
- **Cache entries validate their shape.** A cache file that parsed as JSON but lacked a numeric savedAt was served as fresh forever (the TTL comparison against NaN is always false). Shape-invalid entries are now clean misses, alongside the existing corrupt-JSON recovery; both are pinned, as are corrupt-cache round-trips and a path-traversal test proving crafted repo names cannot escape the cache directory.
- **Generated-input (fuzz) suites for every parser.** Seeded deterministic fuzz tests now cover racecheck keyword extraction, radar branch/issue extraction, claim comment parsing, claims-policy parsing, gatefile/gates parsing, and link-strength classification over empty, huge (10k+ word), unicode/emoji, mixed-case, URL-bearing, code-block, and CRLF inputs, with invariants (never throws, deterministic, bounded, well-formed output) asserted per parser. Stubbed-fetch API tests cover 403/429/404/500 handling, truncated JSON, missing fields, and pagination that ends mid-page or repeats items forever (the walk caps at 5 pages).
- **Field regression pins completed.** The Bruno xray set gains the flip pins: issues #7227 and #6927 read GO with no linked PRs and TAKEN once our own cross-referencing PRs (#9569, #9570) exist, so the flip is attributable to the cross-reference alone. Live battery with this build before shipping: racecheck sveltejs/kit #17465 RACE naming PR #17453; racecheck pablocaeg/sloptotal #21 SUSPECT (no RACE); racecheck cubrid-lab/sqlalchemy-cubrid #859 CLEAR; xray over the eight Bruno field issues all TAKEN with #7227/#6927 taken via #9569/#9570; preflight actualbudget/actual NO-GO with the blocked-422 capability record as evidence.

## v0.20.1 - 2026-10-20

- **Racecheck precision fix.** v0.20.0's keyword race check had the recall but not the precision: on real repos it false-RACEd quiet issues (pablocaeg/sloptotal #21 and #22, cubrid-lab/sqlalchemy-cubrid #882 and #859) off template vocabulary every PR body shares ("ruff", "passes", "reports"), GitHub label words ("help wanted", "good first issue", "hacktoberfest"), and blob-URL path segments (packages/kit/src/core/index/generated). The fixes, each pinned by tests including fixtures modeled on the four failed controls: (1) document-frequency suppression drops any keyword present in more than 25% of the repo's scanned open-PR bodies (and at least 2 of them) before scoring; (2) RACE by term overlap now needs at least 3 term hits with at least 2 derived from the issue title, so body-only overlap caps at SUSPECT; (3) labels are never harvested, URLs are stripped before extraction (basename kept for rare tokens), long or slash-bearing quoted strings contribute rare tokens only, and owner/repo tokens, pure path segments, generic config filenames (pyproject.toml, package.json), framework route filenames (+page.svelte and kin), generic module stems (types.py, utils.ts, __init__.py), pure version tokens (3.10), and quoted commit SHAs are never keywords; (4) the repo's own package prefix is stripped from rare tokens, keeping only the distinctive remainder (sqlalchemy_cubrid.TIMESTAMPTZ yields timestamptz); (5) a shared changed file reaches RACE only with a rare or phrase co-hit, so sharing a central module plus one bare word reads SUSPECT (adjacency is not a race). Field acceptance with the published package: sloptotal #21 SUSPECT, sloptotal #22 SUSPECT, cubrid #882 CLEAR, cubrid #859 CLEAR, and sveltejs/kit #17465 still RACE naming PR #17453, with total RACE matches down from 65 to 14. 16 new tests (1117 total, all passing); tool count unchanged at 33.

## v0.20.0 - 2026-10-20

- **Keyword Race Check (`racecheck`).** New CLI command `greenlight racecheck <owner/repo> <issue-number> [--json]` and new MCP tool `racecheck_issue` (33 tools). Born from the sveltejs/kit field loss: our PR #17489 for issue #17465 was closed in favor of PR #17453 (opened two days earlier), which fixed the same problem but never mentioned the issue, so every link-based check (claims, timeline cross-references, Timeline X-Ray) saw a clean race. Racecheck extracts an issue's significant problem keywords (filenames like $types.d.ts, CamelCase/snake_case identifiers, distinctive title terms, quoted phrases; stopwords and generic words like fix/bug/error are filtered out), then searches the repo's open PRs by keyword and scans the open-PR list for overlap. Verdicts: RACE (>= 2 significant matches, or 1 rare term, or 1 phrase, or a shared changed file), SUSPECT (one weak match), CLEAR. Every non-CLEAR verdict quotes PR number, title, author, created date, and the exact matched keywords. `scan --deep` / the xray path consult racecheck automatically: a RACE demotes an issue from CLEAR to TAKEN with the flag `keyword-race`, a SUSPECT demotes GO to RISKY. False-positive discipline is delimiter-aware (oauth2 is one token, never oauth + 2; pure numbers are never keywords) and pinned by regression fixtures, including the Svelte case itself.

## v0.18.0 - 2026-10-19

Capability items from the iteration audit. 6 new tests (1045 total, all passing), 32 MCP tools.

- **The external merge-rate score term is wired (item 11).** fetchFrictionSummary now fetches merge velocity alongside the other signals and sets externalPRMergeRate from the real outsider share instead of hardcoding null. scoreFriction applies the documented +(rate - 0.5) * 40 term and exposes externalPRMergeRate_pct in the JSON, with the reason line showing the term's contribution. The friction-index generator wires the same computation, and the published Friction Index was regenerated with this machinery.
- **The behavioral pass reads reviews and review comments (item 5).** For each sampled closed-unmerged PR it now pulls up to three evidence pages: issue comments, reviews with non-empty bodies, and review comments. Evidence carries a source label (comment, review, or review_comment) all the way into the report. The worst case API cost is bounded at 48 calls (BEHAVIORAL_MAX_API_CALLS), and the friction help and README budget notes state the new bound.
- **Repo renames resolve before search-dependent flows (item 15).** A new resolveCanonicalRepo helper asks the repo endpoint for the canonical full_name; friction, check, and scan resolve first and report the rename (resolvedFrom in the friction JSON, renamedFrom in check/scan JSON, plus a plain-text rename line). dbt-labs/dbt-core now resolves to dbt-labs/dbt everywhere.
- **Bounty liveness is a real command (item 23).** `greenlight bounty <issue-url>` on the CLI and a bounty_check MCP tool both wrap detectBountyForIssue: canonical resolution, issue fetch, and the pure bounty signal detector, reporting the issue URL, labels, title, and the detected signal. Tool count is 32.
- **Owed gate fixtures verified (item 29).** The hyperframes, coolify, and ppt-master contributing-text fixtures are present under test/fixtures/policy/ with full-file regression tests pinning their gate classes in test/policy-detection.test.ts; nothing remained to file.

## 0.17.1 (2026-10-19)

- **Correctness and polish from the 2026-10-19 iteration audit (batch 2, release C).** 13 new tests, 1039 green. The server still carries 31 tools.
- **Wave own-PR exclusion is paginated (item 13).** `ownOpenPrRepos` fetched one search page of 100 and silently stopped excluding repos past that; the campaign sits at 96 authored PRs, so double-booking a repo was weeks away. The exclusion now pages to the reported total (exact to the 1000-result search cap) through a pure `collectSearchPages` driver pinned by fixtures.
- **Wave aborts loudly on an unreadable login (item 25).** `getLogin` returning an empty string used to degrade to an empty exclusion set and the wave built into occupied repos; `runWave` now refuses to start without a login.
- **One canonical behavioral_gate location (item 12).** The top-level `behavioral_gate` in `friction --json` is documented as canonical; `signals.behavioralGate` stays as an identical mirror for index-pipeline compatibility, and one `attachBehavioralGate` helper sets both so they can never disagree.
- **Behavioral pass recency bound (item 18).** Closures older than 12 months are excluded before their comment pages are fetched (saving calls on quiet repos), and when the newest closure itself is past the bound the report carries an explicit "stale signal" note.
- **Babysit default concurrency lowered to 3 (item 20).** 43-PR sweeps at the old default of 5 wedged the shared proxy; field runs needed 2-3 to stay healthy. The `--concurrency` flag still overrides per run.
- **Per-command API budgets in help (item 21).** friction, check, scan, wave, babysit, and autopilot help now state their core-call budgets so operators can plan runs; a test pins the lines.
- **Wave queue contract matches its sort (item 24).** The result docstring promised "repo star order within a tier"; the queue actually orders by verdict tier, then candidate order (winnability by default). The docs now say so and a regression test pins the behavior.
- **README test count is generated, not hand-written (item 27).** `npm run readme:count` regenerates the count from a real suite run and refuses to update the README when the suite is red; the release checklist documents the step and a packaging test enforces its presence.


## 0.17.0 (2026-10-19)

- **Capability items from the 2026-10-19 iteration audit.** 10 new tests, 1026 green. The server now carries 31 tools.
- **Scoped intake pause (item 3).** A repo that refuses a named category of PRs while staying open to everything else (prettier: "not accepting pull requests that add new formatting options") is now its own gate kind, `scoped_prs_paused`, named against the Agent Policy Index scanner's paused/scoped taxonomy. It costs half the blanket pause in friction (-20 vs -40) and never gates a verdict: check and scan flag it and cap at RISKY with the refused scope quoted. The blanket "not accepting pull requests" pattern carries a negative lookahead so a scoped sentence never scores as a blanket pause.
- **Autopilot branch-health board (item 14).** Autopilot now persists per-PR mergeable, mergeable_state, base SHA, and behind-count in its state between runs (state version 2, backward compatible) and renders a standing board in the run output: conflicted, behind-by-n, and clean rows for every watched PR, also exposed as branch_health and branch_board in the autopilot_report MCP tool JSON.
- **MCP tools for verify, shipcheck, and passport (item 22).** The three CLI commands are now agent-callable in the repo's established tool pattern: verify (honest base-vs-head test delta for a checkout), shipcheck (release, npm, registry, GHCR readiness), passport (ledger profile, merged PR count, honor ratio). Tool list and every count updated to 31.


## 0.16.2 (2026-10-19)

- **Live bugs and quick wins from the 2026-10-19 iteration audit.**
- **tenure_cap_days is never overridden (LB-1).** `parseClaimsPolicy` used `Math.max(tenureCapRaw, lease_days)`, silently turning an explicit `{"lease_days": 30, "tenure_cap_days": 28}` into 30. An explicit cap now always wins; the one-lease floor applies only when the value is absent or invalid. Three regression tests pin the semantics.
- **Behavioral gate now caps check/scan verdicts at GATED (LB-3).** Until now the gate was friction's number; `behavior.ts` promised verdicts would treat it like `agents_banned`, but no code did. `IssueSnapshot` carries the gate, `scoreIssue` adds Rule 7b (GATED with the behavioral evidence quoted), and `check`/`scan` run one behavioral pass per repo (opt out with `--no-behavioral`). `preflight` gains the opt-in `--behavioral` flag, which turns a detected gate into NO-GO before work starts.
- **Gate pattern round 2 (LB-4/LB-5).** The detached-subject "strictly prohibited" family (starship's "unsupervised autonomous agent operating in an automated loop, are strictly prohibited"), the postiz prose family ("we do not accept Pull Requests generated primarily by AI tools"; "reserve the right to close any PR that appears to be AI-generated"), and the documenso scoped review-mandate family (unreviewed AI code gets you blocked), with negative fixtures for review mandates without enforcement, non-agent "strictly prohibited" prose, stale-issue close rights, formbricks' agent-session-link rule, and medusa's policy-free CONTRIBUTING.
- **Wave ranks by winnability (item 19).** Candidates rank by outsider merge share, then friction score, then stars as the tiebreak, so quiet high-converting repos are reached before star-heavy raced ones. `--sort stars` restores the old order (also exposed on the `wave_queue` MCP tool).
- **OCI tag drift, fixed and pinned (LB-2).** `server.json`'s Docker identifier was pinned to 0.13.0 while the package shipped 0.16.1; the tag now equals the package version on every release, `test/packaging.test.ts` fails the build if it drifts, and the README carries the release checklist.
- 22 new tests. The server still carries 28 tools.


## 0.16.1 (2026-10-19)

- **Starter-issue search fix.** The wave smoke test caught it: the shared starter-issue queries used a parenthesized `(label:"good first issue" OR label:"help wanted")` form that silently returns zero results against the live API (badges/shields carries 42 good-first-issues; the query found none). Both `countStarterIssues` and `listStarterIssues` now use GitHub's comma label form (`label:"good first issue","help wanted"`), which returns the real counts. This also repairs `scan`'s starter-issue ranking (it was falling back to recent-unassigned issues unnecessarily) and `friction`'s starter-issue bonus (always zero before). Two regression tests pin the query shape.

## 0.16.0 (2026-10-19)

- **Behavioral gate detection (`friction --json` gains `behavioral_gate`).** Field data from the 2026-10-19 PR wave: spotDL/spotify-downloader is classed open in the Agent Policy Index (no policy file bans agents), yet its maintainer rejects AI-built contributions in practice: issue #2371 drew three PRs, all closed unmerged, with PR #2494 closed on an "AI slop" comment. Policy-file gate detection cannot see this shape, so the index misleads contributors into burning builds. `friction` now runs a bounded, deterministic pass: it walks the closed-PR list until it has the 15 most recent closed-unmerged PRs, then reads maintainer-side comments (OWNER / MEMBER / COLLABORATOR, never the PR author) for AI-rejection evidence (AI attribution plus rejection language, or explicit phrases like "AI slop" and an invoked "AI policy"), with welcoming overrides ("AI-assisted PRs are welcome" never fires). Two independent PRs mark the repo as behaviorally gated; a single weak signal is carried as a warning, while a single explicit rejection phrase detects on its own. A detected gate costs the repo -20 friction points and is reported as `behavioral_gate` (detected, strength, threshold, evidence with PR numbers, quotes, and URLs, notes), so index pipelines like the rebaseline can reclassify repos whose written policy is silent but whose practice is hostile. API cost is bounded at 18 calls (up to 3 list calls to collect 15 closed-unmerged PRs, plus one comment page per PR); skip with `--no-behavioral`.
- **Wave shortlist (`greenlight wave` / MCP `wave_queue`).** The same PR wave coordinator had hand-rolled vetting scripts (index filter plus per-issue timeline cross-checks) because no single command produced a build queue. Now there is one: the Agent Policy Index (live URL by default, file path with `--index`) is filtered to pure-open repos with outsider merge share, star band, and starter issues; starter issues are x-rayed with the existing xray engine (GO becomes CLEAR, TAKEN names its competing PRs); repos with detected behavioral gates are excluded with the reason named; repos where you already have an open PR are skipped via one search call. The run stops with marked partial results when the core budget falls under the floor (default 800), and every stage reports the API calls it used. Search-side throttling degrades to partial results the same way instead of failing the run.
- 20 new tests (fixture-modeled on the spotDL pattern: positive, welcoming, neutral, single-weak, non-maintainer, own-PR, and merged-PR cases; wave fixtures covering CLEAR ranking, TAKEN reasons, behavioral exclusion, own-PR skip, and both budget-stop shapes). The server now carries 28 tools.

## 0.15.1 (2026-10-18)

- **PR Radar precision fix.** Our own maintainer-seeding runs caught radar hallucinating issue links from branch numbers: 6 false-positive same-issue clusters across 4 repos, all one root cause. GitHub web-UI branches (`patch-1`, `inian-patch-1`) were parsed as issue #1; HTTP status codes in branches (`fix-mcp-oauth-500`, `...-500-missing-variants`) as issue #500; a version string (`shorten-changelog-prior-to-1.0`) and a bot task counter (`claude/task-22584764486-1`) as issue #1; a batch counter (`bundle-size-3-migrate`) as issue #3. A branch number now counts as an issue reference only under a defensible convention: an explicit `#N` marker, an issue-prefix token (`fix-9483-wsdl`, `issue-61`), issue-first segment start (`feat/61-resume-block`), a trailing number after a word (`...-newlines-6435`), or a bare 3+ digit token (`pay-852-...`). Never from `patch-N` names, versions, numeric sub-counters, unmarked status codes, or bare 1-2 digit counters (`-try-2`). All 9 genuine seeding clusters still cluster (including bruno #5016/#5074 on #5011 and the file-overlap pairs, which never used branch numbers). Each false positive is pinned by a regression test naming its source repo.
- **Guard example workflow pin refreshed.** `examples/guard-workflow.yml` now pins `CloudCorpRecords/greenlight@v0.15.0` (was v0.12.0).

## 0.15.0 (2026-10-18)

- **PR Radar (`greenlight radar` / MCP `pr_radar`).** Maintainer-side duplicate/competing PR detection: clusters a repo's open PRs by closing-strength links to the same issue (reusing the linkStrength machinery from the check pipeline and Timeline X-Ray) or by high changed-file overlap (Jaccard file similarity, with a title-token pre-filter so file lists are fetched only for plausible pairs). Each cluster reports PR numbers, authors, evidence, and a heuristic suggested-keep pick (earliest opened, then most files, then greenest CI; always labeled heuristic, never a verdict). The maintainer control-room wedge: which open PRs are doing the same work.
- **PR Brief (`greenlight brief` / MCP `pr_brief`).** Verified review brief for any PR: files grouped by area/risk, CI triage with the existing base-vs-head classifier, review findings classified real vs false-positive with evidence (reusing the deterministic review triage), test evidence present or explicitly marked absent, and merge-readiness blockers (conflicts, unresolved change requests, missing changeset). Ends with a one-line look-at-this-first. No generic praise, no invented findings.
- **README repositioning.** The README now states Greenlight's position directly: the pre-flight and coordination layer at the boundary between outside contributors and maintainers of public open-source repos, the one layer no VC-backed tool covers. The product is presented in its three layers (Decide, Solve, Coordinate), with every claim backed by evidence and the full technical reference preserved.

## 0.14.0 (2026-10-18)

- **CI Pre-flight (`greenlight ci-prep` / MCP `ci_prep`).** Runs a target repo's own pull_request workflows locally *before* a PR is pushed: discovers `.github/workflows` triggered on pull_request, executes the mappable run steps (tests, lint, typecheck, build) with per-step timeouts, and checks repo conventions (changeset requirement, conventional-commit subjects, DCO sign-off). Steps that cannot run locally (deploys, secrets, publishes, external services) are SKIPPED with the reason named, never reported PASS. Verdict GO/NO-GO (exit code 1 on NO-GO); `--act` runs the real workflows via act+docker when available and says so plainly when not.


## 0.13.0 (2026-10-18)

Timeline X-Ray: deep-verify candidate issues against their GitHub timelines before writing code. Field data from the usebruno/bruno focus session: of 7 hand-vetted issues, 6 were secretly taken by open PRs visible only in the issue timeline (cross-referenced events), not in list views (#8149 -> PR #8176, #9319 -> PR #9320, #8287 -> PR #8288, #8264 -> PR #9475, #9517 -> PR #9552, #9483 -> PR #9484). Vetting by hand cost about an hour; X-Ray automates it.

- **New command.** `greenlight xray <owner/repo> [--issues 1,2,3 | --from-scan] [--limit N] [--json]` x-rays candidate issues: timeline + search linked-PR walk with the existing linkStrength scoring (reused, not forked), reporter-owned-PR detection (a mention-strength PR authored by the issue reporter counts as closing-strength evidence — the classic hidden trap), and a lazy comment-claim scan (only when no open PRs were found, keeping a 10-issue x-ray near ~35 API calls). Verdicts are GO / RISKY / TAKEN with per-PR evidence (number, state, link strength, discovery path, author, URL).
- **`scan --deep`.** Runs the x-ray over the ranked candidates and demotes anything it finds worse than the check verdict before presenting results; deep-verified issues carry the `xray-deep-verified` flag.
- **MCP surface.** New `xray_issues` tool (the server now carries 24 tools); `scan_repo` gains a `deep` parameter.
- **Honest budget.** Every x-ray result reports the API calls it consumed; timeline, PR, and comment responses ride the existing file cache, so repeat runs are nearly free.
- 24 new tests: mocked timeline payloads for every verdict rule, multi-page timeline walks, commit-sourced event handling, the scan-demotion merge, and regression fixtures for the six real Bruno TAKEN cases plus the two GO cases.

## 0.12.0 (2026-10-18)

The Claim Protocol GitHub App client: `greenlight claim --via-api` posts through the hosted claim API (https://claim-api-wine.vercel.app) instead of requiring a hand-posted comment.

- **One-time sign in.** `greenlight auth login` runs GitHub's OAuth device flow against the claim-api OAuth app and stores the resulting user token; `auth login --browser` walks the browser grant and stores the pasted session token; `--token` / `GREENLIGHT_API_TOKEN` passthrough covers scripts and agents. Tokens live in the OS keychain when one is available (macOS `security`, Linux `secret-tool`); otherwise `~/.greenlight/api-token` with 0600 permissions. `auth status` / `auth logout` round it out.
- **App-aware writes.** Before any `--via-api` write the client asks the backend whether the Greenlight Claims app is installed on the repo (`GET /v1/app/repos/:owner/:repo/installation`). Installed: the claim goes through the app backend (the server posts the protocol comment as the caller and the webhook records durable state). Not installed, or the endpoint missing (backend older than v1.0.0): the client falls back to the current direct-API comment path and prints a one-line note naming that the app is not installed. The downgrade is never silent. `claim` without `--via-api` is unchanged.
- **Honest claim flow.** The hosted status read runs a TAKEN pre-flight (refuses on a holder that is not you unless `--queue-ok` joins the public queue); the posted comment is verified by re-reading the status and confirming your login appears in the chain; a 401 re-runs the device flow once, then prints the manual steps. `greenlight release <issue-url> --via-api` and `greenlight heartbeat <issue-url> --via-api` map onto the server endpoints with the same app-aware selection.
- **MCP surface.** Three new tools bring the server to 23: `api_status` (the live hosted status payload, read only), `claim_via_api` and `heartbeat_via_api` (both report-mode-safe: dry run unless `execute` is true, and executing refuses without a stored token).
- **Config.** The API base is cached in `~/.config/greenlight/config.json`; `--api-base` overrides per call. The OAuth app client id defaults to the claim-api app's id (read from the live instance); `GREENLIGHT_OAUTH_CLIENT_ID` / `--client-id` override it.

## 0.9.2 (2026-10-17)

The pacing patch: the campaign's claim-posting pace tripped GitHub's account-level anti-spam flag (403 "Blocked" on comment creation), freezing all posting for hours. The tool now paces itself, and the linked-dead claim state exists.

- **Claim pacing.** Every post attempt is ledgered at `~/.greenlight/posting-ledger.json` (timestamp, kind, target, outcome). Claim posts enforce a minimum interval (default 90s, jittered; `GREENLIGHT_CLAIM_MIN_INTERVAL_S`, `--min-interval` to override per run) and a daily soft cap (default 25 per rolling day; `GREENLIGHT_CLAIM_DAILY_CAP`, `0` disables). When a post is too soon or the cap is hit, the command refuses with the earliest allowed time; `--force` overrides and the override is ledgered. A post that fails with a 403/blocked or an uncertain network error is marked UNCONFIRMED; before any later post to the same target, the tool re-reads the target against the API and reconciles (a "failed" post that actually landed is marked confirmed and never reposted; one verified absent is superseded). `greenlight status` gains a pacing section: posts today, cap, next allowed time, unconfirmed count.
- **Linked-dead claims.** A protocol claim that is LINKED but whose linked PR closed unmerged now derives as LINKED-DEAD in the CLI (check, status, babysit claims), with a plain-language reason and a release prompt. The issue reads free (verdict GO); the stale marker still needs an explicit release. The hosted API's own derivation is out of scope; the engine itself keeps the claim "linked" so the lease never quietly resumes.
- **AI claim-layer transparency.** `check` and `scan` (human and `--json`) now state whether the AI claim layer ran: `ai claim layer: on (model)` or `off (reason: no key, non-eligible verdict, strong claim already found, round did not complete)`. This is the direct fix for the 2026-10-17 field misses, where a dead layer hid behind patterns-only output. The pattern layer also learned the four missed phrasings: bare "Working on this." (soft), "I've packaged a ... fix" / "I also prepared and tested a fix" (strong), contracted "I'd like to work on this" (strong), and a maintainer's "It's yours @user" (strong, an assignment).
- **Request timeouts.** The GitHub fetch layer has a per-request timeout (default 30s, `GREENLIGHT_REQUEST_TIMEOUT_S`): slow or dropped connections fail fast into babysit's transient bucket instead of hanging. Byte-identical when requests complete normally. A 403 whose body says "Blocked" now throws a dedicated `WriteBlockedError` instead of masquerading as a rate limit.
- **CI summary wording.** When every failing check is an external blocker (zero pre-existing, zero code failures), the verdict is `NO CODE FAILURES` and the line reads `Verdict: NO CODE FAILURES (all blockers external)` instead of the misleading "ALL PRE-EXISTING" (the bruno#9561 shape).

Babysit version marker is 0.9.2 (new linked-dead claims bucket).

## 0.9.1 (2026-10-17)

The trust patch: a day of dogfooding at portfolio scale (43 open PRs) surfaced five fidelity problems, all fixed here.

- **Babysit speed and honest failures.** Per-PR fetching now runs with bounded concurrency (default 5, `--concurrency N` to override): a 15-PR sweep drops from ~9 minutes toward ~2. Each PR's reads get 2 attempts with a short backoff (250ms); a PR that still cannot be observed lands in a new `Could not check (transient)` section with its error kind (`transient` vs `usage`), never in needs-you or waiting, and its watermark is untouched so the next run reports it as if this run never happened. New JSON fields: `transientFailures`, `repoNotes`, `prsChecked` (failures count). Guard and babysit version markers are 0.9.1.
- **Guard flag subjects.** Every guard finding now carries a `subject`: `pr` (this PR's own diff, e.g. missing artifacts), `issue` (a linked issue, e.g. a competing fix, with canonical `owner/repo#N` `issueRef`), or `repo` (repo-wide signal). Babysit raises needs-you only for subject `pr`, and for subject `issue` when the issue is the PR's own linked issue; everything else collects into a `Repo notes` section, informational only. Field case: babysit on actual #9250 once reported "Competing fix for #123" as a new guard thing when it belonged to other PRs in the repo; that shape now produces zero needs-you items from guard.
- **Claim registry import.** `greenlight claim --import --ledger-user <github-login>` fetches the public Claim Ledger and imports every active or linked claim by that user into `~/.greenlight/my-claims.json`; `greenlight claim --import --urls <issue-url,...>` backfills manually. Re-imports dedupe; retired states (completed, released, expired, superseded) are skipped.
- **The proxy, shipped.** `greenlight proxy [--port N]` starts the localhost forwarder that lifts you from the 60/hr anonymous quota to the 5000/hr authenticated budget: it reads `GITHUB_TOKEN` (or `GH_TOKEN`) once at startup, attaches it server-side, ignores incoming Authorization headers, binds 127.0.0.1 only, rejects absolute-form request targets, and refuses to start with a clear message when no token is set. `greenlight doctor` now names the proxy as the remedy when GitHub reads are unauthenticated (the authenticated pass output is byte-identical).
- **MCP parity.** Two new tools bring the server to 17: `scout_campaign` (campaign mode over MCP) and `my_claims` (the claims-bucketing half of the babysitter).

## 0.8.0 (2026-10-16)

The pattern layer learns a second pair of eyes, with the verdict math untouched.

- **Optional AI claim-intent detection (Fireworks).** Patterns cannot know every way a human says "I'm taking this": one evening the checker missed "I'm looking into contributing a fix here" on a real issue. Set `FIREWORKS_API_KEY` and `greenlight check` sends the eligible comments (bots and the issue author excluded, same pool as the patterns) to a cheap Fireworks model (default `accounts/fireworks/models/glm-5p3-flash`; `GREENLIGHT_LLM_MODEL` / `GREENLIGHT_LLM_BASE_URL` override) when the patterns found no strong claim. The governance is the feature: off by default (no key, no calls, output identical to the pattern-only engine), flags only (the `llm-claim` flag with the exact quote as evidence, downgrading an otherwise-GO verdict to RISKY), never TAKEN and never overriding GATED, quotes must be exact substrings of the comment body or the result is dropped, and timeouts/non-200s/unparseable replies return no signal instead of an error. Classifications are cached by comment id + model id. One issue check costs well under a tenth of a cent on the default model. `greenlight doctor` reports whether the layer is configured (the key is never printed); `greenlight help check` documents the env vars; the README states the governance in plain language.
- The Claim Protocol merge treats AI claim inference like any legacy claim inference: a live protocol claim supersedes the `llm-claim` flag and its reasons, while the `llm_claims` array still rides along in JSON output (also added to `check_issue`).

## 0.7.0 (2026-10-16)

Setup and help stop being the friction: one command onboards your agent, one command verifies the setup, and help finally works everywhere.

- **`greenlight init`: one-command agent setup.** `greenlight init --agent claude-code` (also cursor, copilot, windsurf, cline; repeatable and comma-separated) copies the MCP config into your project (merging into an existing config, keeping other servers) and installs the workflow instruction snippet (marker-guarded, idempotent). Run it with no `--agent` and it detects which tools the project uses from their marker files; with nothing detected it prints the supported ids and exits 2 with an example. `--dry-run` reports without writing, `--force` overwrites conflicting files. Exits nonzero on any setup error.
- **`greenlight doctor`: the setup check.** Node version (>= 20), GITHUB_TOKEN presence, GitHub API reachability plus your actual rate-limit quota, and cache-directory writability. Every check carries its fix; exit 1 when any check fails. The missing piece for the new Install section: doctor is now the documented "did I set this up right" step.
- **Unified help.** `greenlight help [command]` prints the overview or one command's flags and examples, any known command followed by `--help` does the same, `greenlight --version` (and `greenlight version`) prints the version, and unknown commands keep exit 1 but now show the overview with a "Did you mean ...?" suggestion. The hardcoded CLI usage block is gone: `help.ts` is the single source of help text for both the CLI and the test suite, and every dispatched command now has a help entry (init, doctor, verify, verify-comment, babysit, evidence, passport, help, version were added). A known command with a missing argument now shows its own help instead of the generic overview.
- **Docs and integrations refreshed to all 15 tools.** The README leads with `npx @reneturcios/greenlight init --agent claude-code` as the install path (manual `integrations/` copy as fallback), the Install section adds init plus `greenlight doctor` as setup verification, and the MCP tool list now names all 15 (claim_status, preflight, and verify_comment were missing). The claude-code, cursor, and copilot instruction snippets teach the new rules: preflight/claim_status before claiming, verify_comment instead of a PR when the repo takes no outside PRs, babysit_prs to check on open PRs, evidence_pack when the human wants proof a PR is sound.


## 0.6.0 (2026-10-16)

The three tools that turn Greenlight from a check you run into infrastructure you live in.

- **PR Babysitter.** `greenlight babysit [--prs url1,url2 | --mine --repos o/r,...]` watches your open PRs and returns one prioritized action list: *needs you now* (new likely-real review findings, CI newly failing on your code, merge conflicts, new guard flags, checks stuck over 2 hours), *waiting on them* (checks still running, CI green with no review feedback yet), and *quiet* (merged/closed PRs retire from the watch). Stored watermarks (`~/.greenlight/babysit.json`, or `--state`) make reruns report what changed since the last check — the first run says so and shows the full picture. Cron-friendly: exit 0 always unless usage is wrong; `--fail-on-action` gives exit 3 when the needs-you-now list is non-empty. The `babysit_prs` MCP tool (14th tool) does the same for agents.
- **Maintainer Autopilot for the guard Action.** Off by default; the maintainer opts in with an `autopilot` section in `.greenlight-guard.json`: `{ "autopilot": { "labels": { "protocol-claim": "claim-conflict", "competing-fix": "duplicate-effort", "changeset-missing": "needs-changeset" }, "nudge": true } }`. The guard computes label decisions from the label map over severity-flag findings (notes never earn labels) and ready-to-copy stale-claim nudge lines for 14+ day claims with no other open PR — but never applies anything itself. The Action's new label step applies the decided labels with the Actions token (creating labels that do not exist, degrading label failures to warnings, never failing the run), and the nudge lines ride inside the one guard comment for the maintainer to post on the issue. What autopilot never does, by design: close PRs, merge anything, or comment beyond the single guard comment. `greenlight guard <pr-url> --labels-dry-run` prints what it would do.
- **Verified PR evidence pack and contributor passport.** `greenlight evidence <pr-url> [--out file.md] [--verify-json path]` assembles the guard verdict, CI triage, review triage, and the Claim Protocol status of the linked issues into one markdown pack where every claim cites its source (the check run, the review anchor, the claim comment URL). The test-suite delta comes only from a provided `greenlight verify --json` report — the pack never runs suites itself, and says so when the report is missing. The `evidence_pack` MCP tool (15th tool) returns the markdown. `greenlight passport <github-login>` renders the contributor passport: protocol claims from the public Claim Ledger (active, queued, completed vs expired honor record, over-cap flag) plus merged PRs from the GitHub search API; a missing Ledger file is stated plainly instead of invented.


## 0.5.0 (2026-10-16)

The solve side gets two real tools: one for the repo that will not take your PR, one for the honest answer about your own tests.

- **Verified-comment mode.** Some repos take no outside PRs at all — modelcontextprotocol/inspector and modelcontextprotocol/servers close outside PRs on sight, and the contribution that lands is a detailed, verified issue comment. `greenlight verify-comment <issue-url>` assembles that comment from your notes (`--claim`, `--env`, `--repro`, `--observed`, `--expected`, `--root-cause`, `--fix`, `--ran`, `--by`, or `--from-file notes.md`): claim of the problem, environment, numbered reproduction, observed vs expected, root cause, fix sketch, and a verification footer. Sections you leave empty render as explicit gaps ("Repro: not yet run", "not yet isolated", "not recorded") — never plausible filler; a labeled gap is the product. The `verify_comment` MCP tool (13th tool) does the same for agents. It never posts: you copy the markdown into the thread yourself. And `check_issue` now tells you when you need it: on a maintainer-only repo (the `collaborators_only` gate) the check output gains "This repo takes verified comments instead of PRs: draft one with greenlight verify-comment <url>."
- **Honest verify.** `greenlight verify` runs your repo's test command on a base worktree and on your working tree and reports the DELTA from parsed test identities: newly failing (yours), newly passing (fixed), still failing (pre-existing, not yours) — counts from parsed output, never raw log lines. It detects the test command (package.json scripts.test, pytest, go, cargo; `--cmd` overrides), resolves the base (merge-base with upstream or origin/main; `--base` overrides), and refuses to guess: dirty tree, missing deps, no parser for the runner, or unparseable output all report "unverifiable" with the reason instead of a number. Exit 3 when new failures exist, 1 when unverifiable. CLI only, on purpose: it runs your test suites on the machine where the code lives, and suites can take minutes — the MCP server is for agents on other machines. Parsers ship for node --test (covers npm scripts running node --test, tsx --test, vitest) and pytest, and more runners slot in through the `TestRunnerParser` interface in `verify-parsers.ts`.


## 0.4.0 (2026-10-16)

The Claim Protocol lands (Phase 1, per the spec at `protocol/SPEC.md` in this repo). Claims become expiring leases with a public queue: a comment carrying the `<!-- greenlight-claim v1 -->` marker holds the issue for a 7-day renewable lease (repo policy may set 1-30 days via `.greenlight/claims.json` on the default branch); a heartbeat (any comment, or a rocket reaction on the claim comment) renews; linking a PR freezes the claim; expiry, release, or a merged PR ends it.

- **`greenlight status <issue-url> [--json]`** answers the protocol question directly: verdict, claim holder, expiry, queue, competing PRs, gates, and whether the repo honors the protocol. The `claim_status` MCP tool returns the full SPEC 5.1 payload; `preflight` pairs it with the repo friction summary (the two new tools bring the MCP surface to 12).
- **check_issue now merges the protocol verdict.** A live protocol claim (active, linked, or completed) wins over the legacy claim *inference*: the legacy claim-derived reasons and flags are dropped and replaced with the protocol reason, flagged `protocol-claim`. It never overrides gates, and never overrides cross-referenced PR evidence — when both the protocol and a cross-referenced PR say TAKEN, the reasons merge. Expired-only history appends a note without changing the verdict. Old-fashioned claims with no marker still run the legacy engine unchanged.
- **claim_issue drafts protocol claims.** The comment keeps its human-shaped text and gate behavior, then carries the marker line, optional `plan:` / `eta-days:` lines (new `--plan` / `--eta-days` CLI flags, `plan` / `eta_days` MCP params), and the SPEC 3.1 footer. Dry-run default and all gate refusals are unchanged.
- **guard understands protocol claims.** A new `protocol-claim` check (fifth check, default-on, toggleable in `.greenlight-guard.json`): for each linked issue, an active or linked protocol claim held by someone other than the PR author is a flag naming the claimant, claimed date, and expiry, pointing at the public queue ("join it instead of duplicating"); a claim held by the PR author is a pass note; completed claims are neither.
- **Over-cap is library-only in this release.** The engine's `applyOverCap` (squatting detection past 5 active claims) needs a global per-account index that Phase 1 does not build; it is exported for programmatic use and ships uncalled. It becomes live in Phase 2 with the Ledger index. `test/protocol.test.ts` covers the engine; `test/protocol-fetch.test.ts` covers the wiring (policy present/absent/invalid, reactions fetched only for marker comments, every merge-precedence branch).


## 0.3.11 (2026-10-16)

The repo digest: `greenlight digest <owner/repo>` (and the `repo_digest` MCP tool, the tenth tool) answers the maintainer's repo-level question: what needs my attention across the whole repo?

- **Four sections, all evidence-carrying.** PR races: open PRs grouped by linked issue (same-repo closing links and cross-repo `owner/repo#N` references, reusing the guard's extractors), with first-claim arbitration — earliest claim author and date on the issue, earliest PR opened, and a one-line "the other PR(s) duplicate effort" summary. Claimed-by-other conflicts: open PRs whose linked issue carries a claim by someone other than the PR author that predates the PR (guard's claim matching, reused). Stale claims: open issues with a claim 14+ days old and no open PR in the issue's timeline, with "nudge @x" under 30 days and "release the claim" after. Assignment-gate conflicts: when the repo's gates require assignment before a PR, open PRs whose author is not among the issue's assignees (including issues assigned to nobody).
- **Budget discipline.** Comment fetches are skipped for comment-less issues (a comment-count prefetch first), timeline walks happen only for candidate stale claims, and the summary header always states the list cap and the true open-PR total when capped (`--limit N`, default 50, max 100). A section that cannot be computed says so and why, never silently empty. `--json` for machines; `--fail-on-race` makes the exit code 3 when a race exists, mirroring the guard's contract.
- **Live-corrections before shipping.** The first live digest of ComposioHQ/composio surfaced two precision bugs, both fixed: dependabot-style branches (`vitest-5.0.4`) were claiming issues #5 and #4, so dotted version sequences are now stripped before branch-token collection (shared with the guard's extractor, with regression tests); and race groups keyed on numbers that resolve to PRs, not issues, are skipped with a degraded note instead of reporting phantom races. The claimed-by-other section now counts only *strong* foreign claims as conflicts; soft claims ("happy to help") render as "possible interest" notes, because the live run showed soft patterns matching polite offers that are not claims of work.
- **CI triage widening.** The base-branch comparison window grows from 5 to 12 commits, so long-running flakes (the reticle windows install-gate shape) stop misreading as yours. When a base commit has no check runs at all, the legacy combined-status endpoint (Travis/Jenkins/AppVeyor) now feeds the comparison as fallback evidence; classification semantics are unchanged.


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
