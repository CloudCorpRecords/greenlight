/**
 * Timeline X-Ray: deep timeline verification for candidate issues.
 *
 * Field data (2026-10-18, usebruno/bruno focus session): `scan` ranks
 * candidates from list/search data, but in dense repos most well-specified
 * issues are already TAKEN by open PRs that are visible only in the issue
 * TIMELINE (cross-referenced events), not in list views. Of 7 hand-vetted
 * Bruno issues, 6 were secretly taken: #8149 -> PR #8176, #9319 -> PR #9320
 * (the reporter's own prepared fix), #8287 -> PR #8288, #8264 -> PR #9475,
 * #9517 -> PR #9552, #9483 -> PR #9484. The `check` pipeline catches these
 * one issue at a time; X-Ray batches the deep verification.
 *
 * What X-Ray does per issue (lean pipeline, ~4 API calls):
 *   1. fetchLinkedPRs() — the EXISTING timeline + search walk with per-PR
 *      linkStrength scoring (classifyLinkStrength is reused, not forked).
 *   2. Issue author lookup (cached; reused from the check snapshot cache
 *      when scan --deep already ran the check pipeline).
 *   3. Comment claim scan (LAZY: only when no open linked PRs were found,
 *      because claim flags cannot change a PR-driven verdict; this keeps a
 *      10-issue xray near ~35 API calls). Reuses detectClaims /
 *      strongClaimants from claims.ts.
 *
 * X-Ray verdict rules (documented; stricter than the check pipeline in
 * exactly one place):
 *   - open PR with linkStrength "closing"            -> TAKEN
 *   - open PR cross-referenced in the issue timeline -> TAKEN
 *     (any strength; matches verdict Rule 3d)
 *   - open mention-strength PR authored by the issue REPORTER -> TAKEN
 *     (X-Ray strengthening: a reporter's own fix PR is the classic hidden
 *     trap — e.g. bruno#9319 -> PR #9320. The check pipeline would call
 *     this RISKY/GO via weak-pr-mention.)
 *   - open mention-strength PR by anyone else        -> RISKY (weak-pr-mention)
 *   - 2+ fresh full-strength comment claimants       -> TAKEN (claim race)
 *   - 1 fresh full-strength comment claimant         -> RISKY (claimed)
 *   - only closed/merged linked PRs, or nothing      -> GO (with a note)
 *
 * Closed/merged PRs are evidence, never blockers. Every linked PR is
 * reported with number, state, link strength, discovery path (via),
 * author, and URL, so a human can audit the verdict in seconds.
 */
import {
  apiCallsUsed,
  apiGet,
  cacheGet,
  cacheSet,
  fetchComments,
  fetchLinkedPRs,
} from "./github.js";
import { isClosingPR } from "./linkstrength.js";
import { detectClaims, strongClaimants } from "./claims.js";

export type XrayVerdict = "GO" | "RISKY" | "TAKEN" | "ERROR";

export interface XrayLinkedPR {
  number: number;
  state: "open" | "closed" | "merged";
  title: string;
  url: string;
  linkStrength: "closing" | "mention";
  via?: "timeline" | "search" | "comment";
  /** PR author's login; "" when unknown (older cache entries). */
  author: string;
  /** True when the PR author is the issue reporter (the hidden-trap signal). */
  reporterOwned: boolean;
}

export interface XrayClaimFlag {
  author: string;
  createdAt: string;
  ageDays: number;
  phrase: string;
}

export interface XrayResult {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  verdict: XrayVerdict;
  reasons: string[];
  flags: string[];
  linkedPRs: XrayLinkedPR[];
  claimFlags: XrayClaimFlag[];
  deepVerified: true;
  /** API calls consumed by this x-ray (measured, for budget honesty). */
  apiCalls: number;
}

const xrefLabel = (pr: XrayLinkedPR): string =>
  `#${pr.number} "${pr.title}" [${pr.state}/${pr.linkStrength}${pr.via ? `/${pr.via}` : ""}]${pr.reporterOwned ? " (reporter's own PR)" : ""} (${pr.url})`;

/** Issue author + title, cached; prefers the check pipeline's snapshot cache. */
async function xrayIssueMeta(
  owner: string,
  repo: string,
  number: number
): Promise<{ author: string; title: string }> {
  const key = [owner, repo, String(number), "author"];
  const cached = cacheGet("issue", key) as { author: string; title: string } | undefined;
  if (cached !== undefined) return cached;
  // scan --deep runs the check pipeline first, which caches the snapshot.
  const snap = cacheGet("issue", [owner, repo, String(number), "snapshot"]) as
    | { author?: string; title?: string }
    | undefined;
  if (snap?.author !== undefined) {
    const meta = { author: snap.author ?? "", title: snap.title ?? "" };
    cacheSet("issue", key, meta);
    return meta;
  }
  try {
    const issue = (await apiGet(`/repos/${owner}/${repo}/issues/${number}`)) as {
      user?: { login?: unknown };
      title?: unknown;
    };
    const meta = { author: String(issue.user?.login ?? ""), title: String(issue.title ?? "") };
    cacheSet("issue", key, meta);
    return meta;
  } catch {
    const meta = { author: "", title: "" };
    cacheSet("issue", key, meta);
    return meta;
  }
}

export async function xrayIssue(owner: string, repo: string, number: number): Promise<XrayResult> {
  const callsBefore = apiCallsUsed();
  const url = `https://github.com/${owner}/${repo}/issues/${number}`;
  const fail = (reasons: string[]): XrayResult => ({
    owner, repo, number, url, title: "",
    verdict: "ERROR", reasons, flags: [],
    linkedPRs: [], claimFlags: [], deepVerified: true,
    apiCalls: apiCallsUsed() - callsBefore,
  });

  let linked: Awaited<ReturnType<typeof fetchLinkedPRs>>;
  let issueAuthor: string;
  let issueTitle: string;
  try {
    linked = await fetchLinkedPRs(owner, repo, number);
    ({ author: issueAuthor, title: issueTitle } = await xrayIssueMeta(owner, repo, number));
  } catch (err) {
    return fail([`x-ray fetch failed: ${err instanceof Error ? err.message : String(err)}`]);
  }

  const reasons: string[] = [];
  const flags: string[] = [];
  const xrayPRs: XrayLinkedPR[] = linked.map((pr) => {
    const author = pr.author ?? "";
    return { ...pr, author, reporterOwned: author !== "" && author === issueAuthor };
  });

  const open = xrayPRs.filter((p) => p.state === "open");
  const openClosing = open.filter((p) => isClosingPR(p));
  const openTimeline = open.filter((p) => !isClosingPR(p) && p.via === "timeline");
  const openReporter = open.filter((p) => !isClosingPR(p) && p.via !== "timeline" && p.reporterOwned);
  const openMention = open.filter(
    (p) => !isClosingPR(p) && p.via !== "timeline" && !p.reporterOwned
  );

  const done = (
    verdict: XrayVerdict,
    claimFlags: XrayClaimFlag[] = []
  ): XrayResult => ({
    owner, repo, number, url, title: issueTitle,
    verdict, reasons, flags,
    linkedPRs: xrayPRs, claimFlags, deepVerified: true,
    apiCalls: apiCallsUsed() - callsBefore,
  });

  if (openClosing.length > 0) {
    const first = openClosing[0];
    reasons.push(`open PR #${first.number} closes this issue (${first.linkStrength}, via ${first.via ?? "unknown"})`);
    const others = open.filter((p) => p.number !== first.number);
    if (others.length > 0) {
      flags.push("cross-referenced-pr");
      reasons.push(`also in flight: ${others.map(xrefLabel).join("; ")}`);
    }
    return done("TAKEN");
  }

  if (openTimeline.length > 0) {
    flags.push("cross-referenced-pr");
    reasons.push(
      `open PR(s) cross-referenced in the issue timeline: ${openTimeline.map(xrefLabel).join("; ")}`
    );
    return done("TAKEN");
  }

  if (openReporter.length > 0) {
    const first = openReporter[0];
    flags.push("reporter-own-pr");
    reasons.push(
      `open PR #${first.number} is the reporter's own fix PR (${first.url}) — the classic hidden-trap shape`
    );
    const others = open.filter((p) => p.number !== first.number);
    if (others.length > 0) reasons.push(`also in flight: ${others.map(xrefLabel).join("; ")}`);
    return done("TAKEN");
  }

  // No open PR takes the issue: scan comments for human claim language.
  // Lazy by design (see module doc): claim flags cannot overturn a
  // PR-driven verdict, so this fetch is skipped when open PRs exist.
  let claimFlags: XrayClaimFlag[] = [];
  let freshStrong = 0;
  try {
    const comments = await fetchComments(owner, repo, number);
    const claims = detectClaims(issueAuthor, comments);
    claimFlags = claims.map((c) => ({
      author: c.author,
      createdAt: c.createdAt,
      ageDays: c.ageDays,
      phrase: c.phrase,
    }));
    for (const c of claimFlags) {
      flags.push(`claimed-by @${c.author} (${c.ageDays}d ago: "${c.phrase}")`);
    }
    freshStrong = strongClaimants(claims).filter((c) => c.scope !== "partial").length;
  } catch {
    // Comments are best-effort; a failure degrades to no claim flags.
  }

  if (freshStrong >= 2) {
    reasons.push(`claim race: ${freshStrong} strong claimants in comments`);
    flags.push("claimed");
    return done("TAKEN", claimFlags);
  }

  if (openMention.length > 0) {
    flags.push("weak-pr-mention");
    reasons.push(
      `open PR(s) only mention this issue (no closing link): ${openMention.map(xrefLabel).join("; ")}`
    );
    return done("RISKY", claimFlags);
  }

  if (freshStrong === 1) {
    const c = claimFlags[0];
    reasons.push(
      `claimed by ${c.author} ${c.ageDays} day(s) ago ("${c.phrase}"), no PR in flight`
    );
    flags.push("claimed");
    return done("RISKY", claimFlags);
  }

  const closedOrMerged = xrayPRs.filter((p) => p.state !== "open");
  if (closedOrMerged.length > 0) {
    reasons.push(
      `only closed/merged PRs reference this issue: ${closedOrMerged.map(xrefLabel).join("; ")}`
    );
  } else {
    reasons.push("no linked PRs in the issue timeline or search; no comment claims");
  }
  return done("GO", claimFlags);
}

/** X-Ray a list of issues serially (rate-limit discipline over speed). */
export async function xrayIssues(
  owner: string,
  repo: string,
  numbers: number[]
): Promise<XrayResult[]> {
  const out: XrayResult[] = [];
  for (const n of numbers) {
    out.push(await xrayIssue(owner, repo, n));
  }
  return out;
}

/**
 * Merge an X-Ray result into a scan/check verdict (used by `scan --deep`
 * and the scan_repo `deep` param). The x-ray verdict only ever demotes:
 * when it is worse than the scan verdict (and not ERROR), the scan
 * verdict, reasons, and flags are replaced/augmented; the
 * `xray-deep-verified` flag is always recorded. Returns true when the
 * verdict changed.
 */
export function applyXrayDemotion(
  scan: { verdict: string; reasons: string[]; flags: string[] },
  xr: XrayResult
): boolean {
  const rank: Record<string, number> = { GO: 0, RISKY: 1, GATED: 2, STALE: 3, TAKEN: 4, ERROR: 5 };
  if (!scan.flags.includes("xray-deep-verified")) scan.flags.push("xray-deep-verified");
  if (xr.verdict === "ERROR") return false;
  if ((rank[xr.verdict] ?? 9) <= (rank[scan.verdict] ?? 9)) return false;
  scan.verdict = xr.verdict;
  scan.reasons = [...xr.reasons, ...scan.reasons];
  for (const fl of xr.flags) if (!scan.flags.includes(fl)) scan.flags.push(fl);
  return true;
}

/** Sort order for x-ray output: worst news first (triage order). */
export function sortXrayResults(results: XrayResult[]): XrayResult[] {
  const rank: Record<XrayVerdict, number> = { TAKEN: 0, RISKY: 1, GO: 2, ERROR: 3 };
  return [...results].sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.number - b.number);
}
