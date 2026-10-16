/**
 * The Verified PR evidence pack. One markdown document per PR that a
 * reader can check without trusting Greenlight's word: every claim in
 * it cites its source (the check run, the review anchor, the claim
 * comment URL).
 *
 * Assembled from the existing engines: the guard, CI triage, review
 * triage, and the Claim Protocol state of the PR's linked issues. The
 * test-suite delta is included only when the caller passes a prior
 * `greenlight verify --json` report via --verify-json: the pack never
 * runs suites itself (they take minutes and belong where the code is).
 */
import { apiGet, parsePullUrl, parseIssueUrl } from "./github.js";
import { guardPr, type GuardResult } from "./guard.js";
import { triagePr, type CiTriageResult } from "./ci-triage.js";
import { triageReview as defaultTriageReview, type ReviewTriageResult } from "./review-triage.js";
import { fetchProtocolState, type ProtocolFetchResult } from "./protocol-fetch.js";
import type { VerifyResult } from "./verify.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const GREENLIGHT_VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
})();

export interface EvidenceDeps {
  guard?: (prUrl: string) => Promise<GuardResult>;
  triageCi?: (prUrl: string) => Promise<CiTriageResult>;
  triageReview?: (prUrl: string) => Promise<ReviewTriageResult>;
  fetchPrMeta?: (owner: string, repo: string, number: number) => Promise<{ createdAt: string; headSha: string }>;
  protocolStatus?: (owner: string, repo: string, number: number) => Promise<ProtocolFetchResult | null>;
  readVerifyJson?: (path: string) => Promise<VerifyResult | null>;
}

interface PullApiItem {
  created_at?: unknown;
  head?: { sha?: unknown };
}

async function defaultFetchPrMeta(owner: string, repo: string, number: number): Promise<{ createdAt: string; headSha: string }> {
  const p = (await apiGet(`/repos/${owner}/${repo}/pulls/${number}`)) as PullApiItem;
  return {
    createdAt: String(p.created_at ?? ""),
    headSha: String(p.head?.sha ?? ""),
  };
}

async function defaultReadVerifyJson(path: string): Promise<VerifyResult | null> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as VerifyResult;
    if (parsed && typeof parsed === "object" && typeof parsed.outcome === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

export interface EvidenceIssueProtocol {
  issue: string;
  url: string;
  activeClaim: { claimant: string; state: string; claimedAt: string; expiresAt: string; commentUrl: string | null } | null;
  queue: string[];
}

export interface EvidencePack {
  pr: string;
  title: string;
  author: string;
  assembledAt: string;
  version: string;
  markdown: string;
  json: Record<string, unknown>;
}

export interface EvidenceOptions {
  verifyJsonPath?: string;
  deps?: EvidenceDeps;
  now?: Date;
}

function cite(url: string | undefined | null): string {
  return url && url.length > 0 ? url : "(no link recorded)";
}

/**
 * Assemble the evidence pack. Best-effort throughout: a source that
 * cannot be read becomes an explicit "could not be read" line, never a
 * silent gap and never invented content.
 */
export async function buildEvidencePack(prUrl: string, opts: EvidenceOptions = {}): Promise<EvidencePack> {
  const deps = opts.deps ?? {};
  const now = opts.now ?? new Date();
  const { owner, repo, number } = parsePullUrl(prUrl);

  const guard = deps.guard ?? guardPr;
  const triageCi = deps.triageCi ?? triagePr;
  const triageReview = deps.triageReview ?? defaultTriageReview;
  const fetchPrMeta = deps.fetchPrMeta ?? defaultFetchPrMeta;
  const protocolStatus = deps.protocolStatus ?? fetchProtocolState;
  const readVerifyJson = deps.readVerifyJson ?? defaultReadVerifyJson;

  const [guardRes, ciRes, reviewRes, meta] = await Promise.all([
    guard(prUrl).catch((e) => ({ error: e instanceof Error ? e.message : String(e) })),
    triageCi(prUrl).catch((e) => ({ error: e instanceof Error ? e.message : String(e) })),
    triageReview(prUrl).catch((e) => ({ error: e instanceof Error ? e.message : String(e) })),
    fetchPrMeta(owner, repo, number).catch(() => ({ createdAt: "", headSha: "" })),
  ]);

  const guardOk = (r: unknown): r is GuardResult => typeof r === "object" && r !== null && !("error" in r);
  const ciOk = (r: unknown): r is CiTriageResult => typeof r === "object" && r !== null && !("error" in r);
  const reviewOk = (r: unknown): r is ReviewTriageResult => typeof r === "object" && r !== null && !("error" in r);

  // Protocol status for each linked issue the guard found.
  const issueProtocols: EvidenceIssueProtocol[] = [];
  if (guardOk(guardRes)) {
    for (const li of guardRes.linkedIssues) {
      try {
        const { owner: iOwner, repo: iRepo, number: iNumber } = parseIssueUrl(li.url);
        const proto = await protocolStatus(iOwner, iRepo, iNumber).catch(() => null);
        const active = proto?.computation.active ?? null;
        issueProtocols.push({
          issue: `${iOwner}/${iRepo}#${iNumber}`,
          url: li.url,
          activeClaim: active
            ? {
                claimant: active.claimant,
                state: active.state,
                claimedAt: active.claimedAt,
                expiresAt: active.expiresAt,
                commentUrl: active.commentUrl,
              }
            : null,
          queue: (proto?.computation.queue ?? []).map((q) => q.claimant),
        });
      } catch {
        issueProtocols.push({ issue: li.url, url: li.url, activeClaim: null, queue: [] });
      }
    }
  }

  let verifySection: string;
  let verifyJson: Record<string, unknown> | null = null;
  if (opts.verifyJsonPath) {
    const vr = await readVerifyJson(opts.verifyJsonPath).catch(() => null);
    if (vr && vr.delta) {
      verifyJson = { outcome: vr.outcome, delta: vr.delta };
      const d = vr.delta;
      verifySection =
        `Outcome: **${vr.outcome}** (from the provided verify report; the pack does not run suites itself).\n\n` +
        `- newly failing (yours): ${d.newlyFailing.length > 0 ? d.newlyFailing.join(", ") : "none"}\n` +
        `- newly passing (fixed by this PR): ${d.newlyPassing.length > 0 ? d.newlyPassing.join(", ") : "none"}\n` +
        `- still failing (pre-existing): ${d.stillFailing.length > 0 ? d.stillFailing.join(", ") : "none"}\n` +
        `- base ${d.baseTotal.passed}/${d.baseTotal.failed} passed/failed; head ${d.headTotal.passed}/${d.headTotal.failed} passed/failed`;
    } else {
      verifySection = `No usable verify report at \`${opts.verifyJsonPath}\` (unreadable or not a verify result). Run \`greenlight verify --json\` where the code lives and pass it with --verify-json.`;
    }
  } else {
    verifySection = "Not included. Run `greenlight verify --json` where the code lives and pass the report with --verify-json to add the honest red-green delta.";
  }

  const lines: string[] = [];
  const title = guardOk(guardRes) ? guardRes.title : "(title unavailable)";
  const author = guardOk(guardRes) ? guardRes.author : "(unknown)";
  lines.push(`# Evidence pack: ${owner}/${repo}#${number}`);
  lines.push("");
  lines.push(`"${title}" by @${author}. PR opened ${meta.createdAt ? meta.createdAt.slice(0, 10) : "(date unavailable)"}, head ${meta.headSha ? meta.headSha.slice(0, 7) : "(unknown)"}.`);
  lines.push(`Assembled ${now.toISOString().slice(0, 10)} by Greenlight v${GREENLIGHT_VERSION}. Every claim below cites its source.`);
  lines.push("");

  // Guard section
  lines.push("## Guard verdict");
  if (guardOk(guardRes)) {
    lines.push(guardRes.summary);
    const flags = guardRes.findings.filter((f) => f.severity === "flag");
    if (flags.length === 0) {
      lines.push("No flags. Source: the guard's five checks (competing fix, prior claims, artifacts, first-time, protocol claims).");
    } else {
      lines.push("");
      lines.push("| Finding | Evidence |");
      lines.push("|---|---|");
      for (const f of flags) {
        lines.push(`| ${f.title} | ${f.evidence.join(" ")} |`);
      }
    }
    const notes = guardRes.findings.filter((f) => f.severity === "note");
    if (notes.length > 0) {
      lines.push("");
      lines.push("Notes: " + notes.map((f) => f.evidence.join(" ")).join(" "));
    }
  } else {
    lines.push(`Could not be read this run: ${(guardRes as { error: string }).error}`);
  }
  lines.push("");

  // CI section
  lines.push("## CI triage");
  if (ciOk(ciRes)) {
    lines.push(`Verdict: **${ciRes.verdict}**.`);
    if (ciRes.checks.length === 0) {
      lines.push("No failing checks on the PR head. Source: the check runs on the PR head.");
    } else {
      lines.push("");
      lines.push("| Check | Class | Evidence | Source |");
      lines.push("|---|---|---|---|");
      for (const c of ciRes.checks) {
        lines.push(`| \`${c.name}\` | ${c.class}${c.lean ? ` (lean: ${c.lean})` : ""} | ${c.evidence} | ${cite(c.detailsUrl)} |`);
      }
    }
  } else {
    lines.push(`Could not be read this run: ${(ciRes as { error: string }).error}`);
  }
  lines.push("");

  // Review section
  lines.push("## Review triage");
  if (reviewOk(reviewRes)) {
    const c = reviewRes.counts;
    lines.push(`Verdict: **${reviewRes.verdict}** (${c.likelyReal} likely-real, ${c.needsDecision} needs-decision, ${c.likelyNoise} likely-noise).`);
    const actionable = reviewRes.findings.filter((f) => f.class === "likely-real" || f.class === "needs-decision");
    if (actionable.length === 0) {
      lines.push("No actionable findings. Source: review and issue comments on the PR.");
    } else {
      lines.push("");
      lines.push("| Finding | Class | Reviewer | Source |");
      lines.push("|---|---|---|---|");
      for (const f of actionable) {
        const anchor = f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : "(review-level)";
        lines.push(`| ${f.summary} | ${f.class} | @${f.author} (${f.authorKind}) | ${anchor} |`);
      }
      lines.push("");
      lines.push("Reply drafts for each finding are in the review triage output; this pack records the findings, not the replies.");
    }
  } else {
    lines.push(`Could not be read this run: ${(reviewRes as { error: string }).error}`);
  }
  lines.push("");

  // Protocol section
  lines.push("## Claim Protocol status of linked issues");
  if (issueProtocols.length === 0) {
    lines.push("No linked issues with readable protocol state.");
  } else {
    for (const ip of issueProtocols) {
      if (!ip.activeClaim) {
        lines.push(`- ${ip.issue}: no protocol claims. Source: ${cite(ip.url)}`);
      } else {
        const a = ip.activeClaim;
        lines.push(
          `- ${ip.issue}: **${a.state}** claim held by @${a.claimant}, claimed ${a.claimedAt.slice(0, 10)}, expires ${a.expiresAt.slice(0, 10)}. Source: ${cite(a.commentUrl)}`
        );
        if (ip.queue.length > 0) lines.push(`  Queue: ${ip.queue.map((q) => `@${q}`).join(", ")}`);
      }
    }
  }
  lines.push("");

  // Verify section
  lines.push("## Test-suite delta");
  lines.push(verifySection);
  lines.push("");

  // Sources
  lines.push("## Sources");
  lines.push(`- PR: ${cite(prUrl)}`);
  if (guardOk(guardRes)) {
    for (const li of guardRes.linkedIssues) lines.push(`- Linked issue: ${cite(li.url)}`);
  }
  lines.push(`- Pack generator: Greenlight v${GREENLIGHT_VERSION} (guard + ci_triage + review_triage + protocol engines).`);
  lines.push("");

  const markdown = lines.join("\n");
  return {
    pr: `${owner}/${repo}#${number}`,
    title,
    author,
    assembledAt: now.toISOString(),
    version: GREENLIGHT_VERSION,
    markdown,
    json: {
      pr: `${owner}/${repo}#${number}`,
      title,
      author,
      version: GREENLIGHT_VERSION,
      guard: guardOk(guardRes) ? { summary: guardRes.summary, flags: guardRes.findings.filter((f) => f.severity === "flag").map((f) => ({ check: f.check, title: f.title, evidence: f.evidence })) } : { error: (guardRes as { error: string }).error },
      ci: ciOk(ciRes) ? { verdict: ciRes.verdict, checks: ciRes.checks } : { error: (ciRes as { error: string }).error },
      review: reviewOk(reviewRes) ? { verdict: reviewRes.verdict, counts: reviewRes.counts, findings: reviewRes.findings } : { error: (reviewRes as { error: string }).error },
      protocol: issueProtocols,
      verify: verifyJson,
    },
  };
}
