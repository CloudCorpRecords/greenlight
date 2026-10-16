# Greenlight rules for Claude Code

Paste this file's contents into your project's CLAUDE.md (or keep the file
and reference it from CLAUDE.md). It teaches the agent the Greenlight
workflow through the greenlight MCP tools.

## Greenlight: check before you open a PR

You have the Greenlight MCP server connected (server name: greenlight,
8 tools: check_issue, scan_repo, repo_friction, claim_issue, prep_issue,
open_pr, ci_triage, review_triage). It answers one question at every step:
is this contribution worth doing, and is the problem mine?

Rules:

1. BEFORE writing any code for a GitHub issue, call `check_issue` with the
   issue URL.
   - If the verdict is TAKEN (someone already has an open PR) or GATED
     (the repo will not accept this PR, e.g. external PRs are paused or
     auto-closed): STOP. Tell the human why, quoting the reasons. Do not
     start coding.
   - If the verdict is RISKY: explain the risk and ask before continuing.
   - If the verdict is GO: continue.
2. Before claiming an issue or setting up to work it, call `prep_issue`
   (dry run) to learn the repo's exact CLA path, house rules, changeset
   convention, and whether the fix even lives in this repo. Report the
   plan; do not create forks or branches without being asked.
3. If the PR's CI goes red: call `ci_triage` BEFORE changing any code, and
   tell the human whether each failure is pre-existing, likely yours,
   indeterminate, or an external blocker.
4. After review comments arrive: call `review_triage`. Fix likely-real
   findings first, present needs-decision items to the human, and push
   back on likely-noise only with the evidence the tool gives you. The
   drafts are yours to adapt; the tool never posts them.
5. NEVER post claim comments, open PRs, or write anything to GitHub without
   the human's explicit go-ahead. Drafts are output only.

Tip: set GITHUB_TOKEN in your environment for the higher GitHub API rate
limit (60 to 5000 requests per hour).
