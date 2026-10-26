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
 *   - 1 stale-band (46-180d) full-strength claimant  -> RISKY (stale claim)
 *   - strong PARTIAL (scoped) claimant               -> RISKY (partial-claim;
 *     part of the work is taken, the rest may be open)
 *   - claims older than STALE_SIGNAL_DAYS (180d) with no closing PR in
 *     the linked set are DECAYED (verdict parity, v0.19.0 item 17):
 *     disclosed with the "stale-signal" flag and a down-weighting
 *     reason, but they never count toward a race or a claim verdict
 *   - only closed/merged linked PRs, or nothing      -> GO (with a note)
 *
 * Closed/merged PRs are evidence, never blockers. Every linked PR is
 * reported with number, state, link strength, discovery path (via),
 * author, and URL, so a human can audit the verdict in seconds.
 *
 * v0.20.0: GO/RISKY outcomes also pass through the keyword race check
 * (racecheck.ts). A competing PR that never links the issue is
 * invisible to every rule above (sveltejs/kit #17453 vs issue #17465);
 * a RACE result demotes the issue to TAKEN with the flag
 * "keyword-race", a SUSPECT result demotes GO to RISKY.
 *
 * v0.22.1: the claim rules now match the verdict engine exactly. The
 * x-ray used to (1) count claims the check pipeline had already
 * decayed, so a claim race from over 180 days ago with no PR ever
 * opened still read TAKEN here while `check` read the same issue
 * clean; (2) name claimFlags[0], the newest claim of ANY strength, as
 * the claimant in its single-claim reason, so a soft "take a look"
 * commenter was blamed for someone else's strong claim; and (3)
 * ignore strong partial claims entirely, where `check` caps the same
 * issue at RISKY (rule 5b). All three divergences are pinned by
 * regression tests in test/xray.test.ts.
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
import { FRESH_CLAIM_DAYS, STALE_SIGNAL_DAYS } from "./verdict.js";
import { racecheckIssue, applyRaceDemotion, type RacecheckResult } from "./racecheck.js";

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
  /**
   * v0.20.0: the keyword race check result, present when the verdict
   * was GO or RISKY and racecheck ran (link-based evidence already
   * settled TAKEN verdicts without it).
   */
  racecheck?: RacecheckResult;
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

  // v0.20.0: keyword race check. Link-based evidence above settles
  // TAKEN verdicts on its own; for GO/RISKY outcomes, an open PR that
  // fixes the same problem WITHOUT ever linking the issue is still a
  // lost race (sveltejs/kit #17465 -> PR #17453, which our #17489 died
  // to). Racecheck only ever demotes; failures degrade to the x-ray
  // verdict unchanged.
  const finishWithRace = async (
    verdict: XrayVerdict,
    claimFlags: XrayClaimFlag[] = []
  ): Promise<XrayResult> => {
    const base = done(verdict, claimFlags);
    if (verdict !== "GO" && verdict !== "RISKY") return base;
    try {
      const rc = await racecheckIssue(owner, repo, number);
      base.racecheck = rc;
      const holder = { verdict: base.verdict as string, reasons: base.reasons, flags: base.flags };
      applyRaceDemotion(holder, rc);
      base.verdict = holder.verdict as XrayVerdict;
      base.reasons = holder.reasons;
      base.flags = holder.flags;
      base.apiCalls = apiCallsUsed() - callsBefore;
    } catch {
      // Racecheck is best-effort; the x-ray verdict stands.
    }
    return base;
  };

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
  let fullStrong: ReturnType<typeof strongClaimants> = [];
  let partialStrong: ReturnType<typeof strongClaimants> = [];
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
    // Verdict parity (v0.22.1): the check pipeline decays a claim whose
    // author went silent more than STALE_SIGNAL_DAYS ago when no closing
    // PR was ever opened (verdict.ts, v0.19.0 item 17). The x-ray used
    // to count those claims at full strength, so an ancient claim race
    // read TAKEN here while `check` read the same issue clean. Decayed
    // claims stay in claimFlags as evidence and are disclosed here;
    // they just never count toward a verdict.
    const hasClosingPR = xrayPRs.some((p) => isClosingPR(p));
    const decayed = new Set(
      claims.filter((c) => c.ageDays > STALE_SIGNAL_DAYS && !hasClosingPR)
    );
    if (decayed.size > 0) {
      flags.push("stale-signal");
      for (const c of decayed) {
        reasons.push(
          `stale signal: claim by ${c.author} ${c.ageDays} day(s) ago exceeds the ${STALE_SIGNAL_DAYS}-day staleness threshold with no PR opened; down-weighted`
        );
      }
    }
    const liveStrong = strongClaimants(claims).filter((c) => !decayed.has(c));
    fullStrong = liveStrong.filter((c) => c.scope !== "partial");
    partialStrong = liveStrong.filter((c) => c.scope === "partial");
  } catch {
    // Comments are best-effort; a failure degrades to no claim flags.
  }

  if (fullStrong.length >= 2) {
    const names = fullStrong.map((c) => c.author).join(", ");
    reasons.push(`claim race: ${fullStrong.length} strong claimants in comments (${names})`);
    flags.push("claimed");
    return done("TAKEN", claimFlags);
  }

  if (openMention.length > 0) {
    flags.push("weak-pr-mention");
    reasons.push(
      `open PR(s) only mention this issue (no closing link): ${openMention.map(xrefLabel).join("; ")}`
    );
    return finishWithRace("RISKY", claimFlags);
  }

  if (fullStrong.length === 1) {
    // Name the actual strong claimant. The pre-0.22.1 code used
    // claimFlags[0], the newest claim of ANY strength, so a soft
    // commenter was named as the claimant for someone else's claim.
    const c = fullStrong[0];
    flags.push("claimed");
    if (c.ageDays <= FRESH_CLAIM_DAYS) {
      reasons.push(
        `claimed by ${c.author} ${c.ageDays} day(s) ago ("${c.phrase}"), no PR in flight`
      );
    } else {
      reasons.push(
        `stale claim by ${c.author} ${c.ageDays} day(s) ago ("${c.phrase}"), no PR in flight`
      );
      flags.push("stale_claim");
    }
    return finishWithRace("RISKY", claimFlags);
  }

  if (partialStrong.length > 0) {
    // Verdict rule 5b parity: a strong scoped claim takes part of the
    // issue. It never makes the issue TAKEN, but an otherwise-GO issue
    // is RISKY because part of the work is already spoken for. The
    // pre-0.22.1 x-ray filtered partial claims out and read GO.
    const c = partialStrong[0];
    const part = c.scopeWord ? `the ${c.scopeWord} part` : "part of the issue";
    flags.push("claimed");
    flags.push("partial-claim");
    if (c.ageDays <= FRESH_CLAIM_DAYS) {
      reasons.push(`${c.author} claimed ${part} ${c.ageDays} day(s) ago; the rest may still be open`);
    } else {
      reasons.push(`stale partial claim by ${c.author} ${c.ageDays} day(s) ago ("${c.phrase}"); the rest may still be open`);
    }
    return finishWithRace("RISKY", claimFlags);
  }

  const closedOrMerged = xrayPRs.filter((p) => p.state !== "open");
  if (closedOrMerged.length > 0) {
    reasons.push(
      `only closed/merged PRs reference this issue: ${closedOrMerged.map(xrefLabel).join("; ")}`
    );
  } else {
    reasons.push("no linked PRs in the issue timeline or search; no comment claims");
  }
  return finishWithRace("GO", claimFlags);
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
