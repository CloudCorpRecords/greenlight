# Greenlight Guard — the maintainer side

Greenlight started as the contributor's pre-flight check: is this issue
worth my time? Guard is the other side of the same engine. It looks at an
**incoming** pull request and tells you, in one comment, whether it is
worth your review time.

## What it checks

1. **Competing fix.** The PR's body and branch are read for the issue it
   claims (via "fixes #N" or an issue number in the branch name). The
   issue's timeline is then walked for *other open PRs already fixing it*,
   reported by number and author. This is the check that would have caught
   E2B #1986's same-day PR #1987 and composio #4904's two competing PRs.
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
  "first-time": true
}
```

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
