# Greenlight instructions for GitHub Copilot / VS Code

Drop-in instructions for the Greenlight workflow through the greenlight MCP
tools. Installed by `greenlight init --agent copilot`, or paste manually
into your project's `.github/copilot-instructions.md` (create the folder if
it does not exist).

## Greenlight: check before you open a PR

You have the Greenlight MCP server connected (server `greenlight`, tools:
check_issue, scan_repo, repo_friction, claim_issue, prep_issue, open_pr,
ci_triage, review_triage, guard_pr, repo_digest, claim_status, preflight).
Apply these instructions whenever working on a
pull request to an open source project:

1. Before writing any code for a GitHub issue, call `check_issue` with the
   issue URL. If the verdict is TAKEN or GATED, stop and tell the user why,
   quoting the reasons. Never start work on a TAKEN or GATED issue without
   being told to.
2. Before claiming or setting up work, call `prep_issue` (dry run) to learn
   the repo's exact CLA path, house rules, and changeset convention. Report
   the plan; do not create forks or branches unasked.
3. If the PR's CI goes red, call `ci_triage` before changing code, and tell
   the user whether each failure is pre-existing, likely theirs,
   indeterminate, or an external blocker.
4. After review comments arrive, call `review_triage`. Fix likely-real
   findings first; bring needs-decision items to the user; push back on
   likely-noise only with the tool's evidence. Drafts are output only.
5. Never post claim comments, open PRs, or write anything to GitHub without
   the user's explicit go-ahead.
