/**
 * Link strength: how strongly a PR is tied to an issue.
 *
 * Issue #1 (2026-10-13): a plain text search for "#N" in PR bodies produced
 * false positives. shadcn-labs/pdfcn PR #91 closes issue #70 but lists sibling
 * issues #60-#65 in its body, which wrongly marked #61 and #71 as TAKEN.
 *
 * Two levels only:
 *  - "closing": the PR is this issue's PR. Closing keywords in title/body
 *    ("Closes #61"), the issue number in the PR title, or the issue number
 *    as a standalone token in the branch name ("feat/61-resume").
 *  - "mention": anything else. Bare "#61" in the body, a timeline-only
 *    cross-reference, or a search hit with no closing evidence.
 */
import type { LinkedPR } from "./types.js";

export type LinkStrength = "closing" | "mention";

export interface LinkInput {
  title: string;
  body: string;
  branch: string; // PR head ref, e.g. "feat/61-resume-block" (may be "")
  issueNumber: number;
}

export function classifyLinkStrength({ title, body, branch, issueNumber }: LinkInput): LinkStrength {
  const n = String(Math.trunc(Math.abs(issueNumber)));

  // Closing keywords aimed at this issue: "Closes #61", "fixes #61", "Resolved: #61".
  const closingRe = new RegExp(
    `(close[sd]?|closing|fix(e[sd])?|fixes|resolve[sd]?|resolves)\\s*:?\\s*#${n}\\b`,
    "i"
  );
  if (closingRe.test(title) || closingRe.test(body)) return "closing";

  // Issue number in the PR title ("#61: add resume block") is author intent.
  const titleRe = new RegExp(`#${n}\\b`, "i");
  if (titleRe.test(title)) return "closing";

  // Issue number as a standalone token in the branch name ("61-resume-block",
  // "feat/61-x", "issue-61", "fix-61"). The token test keeps "feat/610-x"
  // from matching issue 61.
  if (branch) {
    const branchRe = new RegExp(`(^|[^0-9])${n}([^0-9]|$)`);
    if (branchRe.test(branch)) return "closing";
  }

  return "mention";
}

/** A PR counts as the issue's PR only when its link strength is "closing". */
export function isClosingPR(pr: Pick<LinkedPR, "linkStrength"> & { linkStrength?: LinkStrength }): boolean {
  return (pr.linkStrength ?? "mention") === "closing";
}
