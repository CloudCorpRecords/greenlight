<!-- greenlight:init:begin -->
# Greenlight rules for Claude Code

Drop-in rules for the Greenlight workflow through the greenlight MCP tools.
Installed by `greenlight init --agent claude-code`, or paste manually into
your project's CLAUDE.md (or keep the file and reference it from CLAUDE.md).

## Greenlight: check before you open a PR

You have the Greenlight MCP server connected (server name: greenlight,
15 tools: check_issue, scan_repo, repo_friction, claim_issue, prep_issue,
open_pr, ci_triage, review_triage, guard_pr, repo_digest, claim_status,
preflight, verify_comment, babysit_prs, evidence_pack). It answers one
question at every step: is this contribution worth doing, and is the
problem mine?

Rules:

1. BEFORE writing any code for a GitHub issue, call `check_issue` with the
   issue URL.
   - If the verdict is TAKEN (someone already has an open PR) or GATED
     (the repo will not accept this PR, e.g. external PRs are paused or
     auto-closed): STOP. Tell the human why, quoting the reasons. Do not
     start coding.
   - If the verdict is RISKY: explain the risk and ask before continuing.
   - If the verdict is GO: continue.
2. Before claiming an issue, run the claim through `preflight` (or
   `claim_status`): who holds the issue, until when, who is queued. Join
   the queue rather than duplicating work that is already held. Then call
   `prep_issue` (dry run) to learn the repo's exact CLA path, house rules,
   changeset convention, and whether the fix even lives in this repo.
   Report the plan; do not create forks or branches without being asked.
3. If the repo takes no outside PRs (the check says the contribution is a
   verified comment): draft with `verify_comment` from your notes, filling
   every section you can. Do not open a PR there.
4. If the PR's CI goes red: call `ci_triage` BEFORE changing any code, and
   tell the human whether each failure is pre-existing, likely yours,
   indeterminate, or an external blocker.
5. After review comments arrive: call `review_triage`. Fix likely-real
   findings first, present needs-decision items to the human, and push
   back on likely-noise only with the evidence the tool gives you. The
   drafts are yours to adapt; the tool never posts them.
6. When the human asks for proof a PR is sound: assemble `evidence_pack`
   and present it. Every claim in the pack cites its source.
7. To check on the human's open PRs without being asked about each one:
   call `babysit_prs`. Report the needs-you-now items first; summarize
   the waiting-on-them ones in one line each.
8. NEVER post claim comments, open PRs, or write anything to GitHub without
   the human's explicit go-ahead. Drafts are output only.

Tip: set GITHUB_TOKEN in your environment for the higher GitHub API rate
limit (60 to 5000 requests per hour).
<!-- greenlight:init:end -->
