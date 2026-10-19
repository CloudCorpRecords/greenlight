# Greenlight Guard — the maintainer side

Greenlight started as the contributor's pre-flight check: is this issue
worth my time? Guard is the other side of the same engine. It looks at an
**incoming** pull request and tells you, in one comment, whether it is
worth your review time.

## What it checks

1. **Competing fix.** The PR's body and branch are read for the issue it
   claims (via "fixes #N", an issue number in the branch name, or a
   cross-repo "Fixes owner/repo#N" / issue URL, which is checked in the
   referenced repo). The issue's timeline is then walked for *other open
   PRs already fixing it*, reported by number and author. This is the check
   that would have caught E2B #1986's same-day PR #1987 and composio
   #4904's two competing PRs.
2. **Claimed by someone else.** The linked issue's comments are scanned
   with Greenlight's claim detection. A claim from someone *other than the
   PR author* that predates the PR is reported with the claimant and the
   date. A claim by the PR author is a pass (noted, not flagged).
3. **Missing required artifacts.** From the repo's detected conventions:
   repos using `.changes/` or `.changeset/` flag a PR that adds no such
   file (with the expected path pattern); DCO repos flag commits without
   a `Signed-off-by` trailer; CLA-gated repos flag "CLA status not
   visible" when no `cla-signed` label and no signature comment from the
   author exist. That last one is stated as absence of evidence, never as
   proof the author did not sign.
4. **First-time contributor.** A light signal: the author's previously
   merged PRs in the repo (one search call). Zero means first-time.
   Reported as a note, not a flag.

Every finding carries its evidence. Greenlight never posts anything
itself.

## Install in 2 minutes

Copy `examples/guard-workflow.yml` to `.github/workflows/greenlight-guard.yml`
in your repo. On every opened or updated PR, the action runs the guard and
posts (or updates) **one** comment starting with a one-line summary:

- `Greenlight guard: nothing flagged`
- `Greenlight guard: 2 things to check`

The comment carries a hidden `<!-- greenlight-guard -->` marker so the
action finds its own previous comment and updates it instead of spamming.
Nothing else is posted, labeled, or changed.

## Configuration

Add `.greenlight-guard.json` to your repo root to turn checks off (all
checks are on by default; unknown keys are ignored):

```json
{
  "competing-fix": true,
  "other-claim": true,
  "missing-artifact": true,
  "first-time": true,
  "protocol-claim": true
}
```

The guard also understands Claim Protocol claims. For each issue the PR
links, it reads the protocol state: an active or linked protocol claim held
by someone *other* than the PR author is a flag that names the claimant, the
claimed date, and the expiry, and points at the public queue ("join it
instead of duplicating"); a claim held by the PR author is a pass note, and
completed claims are neither. Toggleable per repo with the
`"protocol-claim"` key above.

## Maintainer Autopilot (opt-in)

The guard reports by default. Autopilot lets it act — only when you say
so, and only in two narrow ways. Add an `autopilot` section to your
`.greenlight-guard.json`:

```json
{
  "protocol-claim": true,
  "autopilot": {
    "labels": {
      "protocol-claim": "claim-conflict",
      "competing-fix": "duplicate-effort",
      "changeset-missing": "needs-changeset"
    },
    "nudge": true
  }
}
```

**Labels.** The map is check id to label name (the machine keys: `competing-fix`,
`other-claim`, `protocol-claim`, `changeset-missing`, `dco-missing`, `cla-status`,
`first-time`). Only findings with severity "flag" can earn a label; notes
never do. The guard computes the decisions into the report JSON
(`autopilotLabels`); the Action applies them with the Actions token,
creating a label that does not exist yet. A label failure degrades to a
warning and never fails the run. For the labels step you need
`issues: write` alongside `pull-requests: write` in the workflow
permissions (see `examples/guard-workflow.yml`).

**Nudge lines.** When `nudge` is on, a linked issue carrying a stale
foreign claim (14+ days old, no other open PR on the issue) gains a
ready-to-copy nudge line inside the guard comment: "@x claimed #N N days
ago and never opened a PR. This PR (#M) now addresses it — if you're still
working on it, reply to keep your claim; otherwise the claim lapses."
You post it on the issue yourself. The guard never posts on the issue
(maintainer sovereignty).

**What autopilot never does.** It never closes PRs, never merges, and
never posts anything beyond the single guard comment it already wrote.
To see exactly what it would do before enabling it, run
`greenlight guard <pr-url> --labels-dry-run` — plain text, no changes,
no exit 3.

The CLI honors the same file when you run it locally:

```bash
npx @reneturcios/greenlight guard https://github.com/owner/repo/pull/123
npx @reneturcios/greenlight guard <pr-url> --json     # machine output
npx @reneturcios/greenlight guard <pr-url> --quiet    # prints nothing unless flagged
```

Exit codes: `0` when nothing is flagged, `3` when findings exist (so a
workflow can decide), `1` on usage errors. The MCP tool is `guard_pr`,
returning the same data including the markdown.

## Honest limits

- The timeline cross-reference is best-effort: private cross-repo PRs are
  invisible to it, and the search API it also uses has its own indexing
  delay.
- CLA detection only sees the PR itself (labels and comments). Authors
  who signed through a flow invisible on the PR will be flagged as "not
  visible", which is why the wording says exactly that.
- The author-history signal is one search call; when it fails, the check
  is skipped silently rather than guessed.
  This repo dogfoods the guard on its own pull requests (installed 2026-10-16).
