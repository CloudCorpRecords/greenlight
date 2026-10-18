/**
 * Autopilot feedback classification (v0.11.0).
 *
 * Every actionable item on a PR gets a kind, and every bot finding gets a
 * validity verdict that is VERIFIED against the code at the PR head before
 * Autopilot touches anything:
 *
 *   REAL          the flagged code or pattern exists at head as described
 *   FALSE_POSITIVE the flagged code or pattern does not exist at head,
 *                 with the counter-evidence quoted
 *   NEEDS_HUMAN   the finding cannot be resolved deterministically
 *
 * Deterministic verification comes first. The optional LLM layer is only
 * consulted where the codebase already wires it, and stays off by default.
 */
import type { AuthorKind } from "./review-triage.js";
import { authorKindOf, type ClassifiedFinding } from "./review-triage.js";
import type { ClassifiedCheck } from "./ci-triage.js";

export type FeedbackKind =
  | "ci_failure"
  | "review_change_request"
  | "bot_finding"
  | "merge_conflict"
  | "dco_gap"
  | "maintainer_question"
  | "approval"
  | "other";

export type FindingVerdict = "REAL" | "FALSE_POSITIVE" | "NEEDS_HUMAN";

export interface FeedbackItem {
  /** Stable identity for watermarks: e.g. "review:12345", "check:build". */
  id: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  author: string;
  authorKind: AuthorKind;
  url?: string;
  path?: string;
  line?: number;
  verdict?: FindingVerdict;
  /** The evidence for the verdict: quoted code, or why it cannot be resolved. */
  evidence?: string;
  /** Draft reply for a human to post. Autopilot never posts comments. */
  draftReply?: string;
}

export interface VerifyDeps {
  /** File contents at the PR head. Returns null when the file is absent. */
  fetchFileAtHead?: (path: string) => Promise<string | null>;
}

/**
 * Pull candidate file paths and short code quotes out of a bot finding body.
 * Review comments usually name the file explicitly (backticked paths or
 * file names) or ship a diff hunk; both are usable for verification.
 */
export function extractCandidates(body: string, anchoredPath?: string): {
  paths: string[];
  quotes: string[];
} {
  const paths = new Set<string>();
  if (anchoredPath) paths.add(anchoredPath);
  const backtick = body.match(/`([^`\n]{1,120})`/g) ?? [];
  for (const b of backtick) {
    const inner = b.slice(1, -1).trim();
    if (/^[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]{1,8}$/.test(inner) || inner.startsWith("src/") || inner.startsWith("packages/")) {
      paths.add(inner.replace(/^\.\//, ""));
    }
  }
  const quoted: string[] = [];
  for (const m of body.matchAll(/^```(?:\w+)?\n([\s\S]{1,800}?)\n```/gm)) {
    const snippet = m[1].trim();
    if (snippet.length >= 12) quoted.push(snippet);
  }
  const inline = body.match(/`([^`]{12,160})`/g) ?? [];
  for (const b of inline) quoted.push(b.slice(1, -1));
  return { paths: [...paths].slice(0, 4), quotes: quoted.slice(0, 4) };
}

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Deterministically verify one bot finding against the code at head.
 * REAL when the flagged pattern exists as described; FALSE_POSITIVE when
 * it demonstrably does not (counter-evidence quoted); NEEDS_HUMAN when the
 * files cannot be resolved or the claim is not checkable this way.
 */
export async function verifyBotFinding(
  item: { body: string; path?: string },
  deps: VerifyDeps = {}
): Promise<{ verdict: FindingVerdict; evidence: string }> {
  const { paths, quotes } = extractCandidates(item.body, item.path);
  const fetchFile = deps.fetchFileAtHead;
  if (paths.length === 0 && quotes.length === 0) {
    return {
      verdict: "NEEDS_HUMAN",
      evidence: "finding names no file and quotes no code to verify against",
    };
  }
  if (!fetchFile) {
    return {
      verdict: "NEEDS_HUMAN",
      evidence: "no file fetcher available, cannot verify against head",
    };
  }
  const texts: string[] = [];
  for (const p of paths) {
    try {
      const content = await fetchFile(p);
      if (content !== null) texts.push(content);
    } catch {
      // unreadable file: keep going with what we have
    }
  }
  if (texts.length === 0) {
    return {
      verdict: "NEEDS_HUMAN",
      evidence: `could not read any of the referenced files (${paths.join(", ")}) at head`,
    };
  }
  const haystack = normalize(texts.join("\n"));
  let real = false;
  let falsePositive = false;
  let counter = "";
  for (const q of quotes) {
    const needle = normalize(q);
    if (needle.length < 12) continue;
    if (haystack.includes(needle)) {
      real = true;
    } else if (!counter) {
      // A quoted code block that does not exist at head is a candidate
      // false positive, unless it is clearly a suggestion (diff-like).
      if (!/^[+-]/.test(q.trim()) && !/\bsuggest\b|\binstead\b/i.test(item.body)) {
        falsePositive = true;
        counter = q.length > 160 ? q.slice(0, 160) + "..." : q;
      }
    }
  }
  if (real) {
    return { verdict: "REAL", evidence: `quoted code is present at head (${paths.length} file(s) checked)` };
  }
  if (falsePositive) {
    return {
      verdict: "FALSE_POSITIVE",
      evidence: `the finding quotes "${counter}", which does not exist at head in any referenced file`,
    };
  }
  return {
    verdict: "NEEDS_HUMAN",
    evidence: "the finding's claim could not be reduced to a code lookup",
  };
}

/** Kind-only classification for review items, before any verification. */
export function classifyReviewItem(input: {
  body: string;
  author: string;
  authorKind: AuthorKind;
  reviewState?: string;
}): FeedbackKind {
  const body = input.body;
  const state = (input.reviewState ?? "").toUpperCase();
  if (state === "APPROVED") return "approval";
  if (state === "CHANGES_REQUESTED") return "review_change_request";
  if (input.authorKind === "bot") return "bot_finding";
  // Human authors: questions and requests are maintainer input, not noise.
  if (/\?\s*$/.test(body.trim()) || /\?(\s|$)/.test(body.slice(0, 200))) return "maintainer_question";
  if (/\b(please|could you|would you|can you)\b/i.test(body)) return "maintainer_question";
  return "other";
}

/**
 * Build Autopilot feedback items from review-triage findings, keeping the
 * triage class and the ready reply draft. Bot findings keep kind
 * "bot_finding" so the verifier can adjudicate them.
 */
export function feedbackFromReviewFindings(
  findings: ClassifiedFinding[],
  prAuthor: string
): FeedbackItem[] {
  const out: FeedbackItem[] = [];
  for (const f of findings) {
    const isAuthor = f.author === prAuthor;
    if (isAuthor) continue; // the author's own comments are replies, not incoming
    const kind =
      f.class === "likely-noise"
        ? "other"
        : classifyReviewItem({ body: f.summary, author: f.author, authorKind: f.authorKind });
    out.push({
      id: `finding:${f.author}:${oneLineKey(f.summary)}`,
      kind: f.class === "likely-noise" ? "other" : kind,
      title: f.summary.slice(0, 120),
      body: f.summary,
      author: f.author,
      authorKind: f.authorKind,
      path: f.path,
      line: f.line,
      // Bot findings are verified against head by the Autopilot run after this.
      verdict: undefined,
      evidence: f.reason,
      draftReply: f.draft || undefined,
    });
  }
  return out;
}

function oneLineKey(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * Build feedback items from CI triage. Only failures the classifier leans
 * "yours" or cannot place (indeterminate) become fix candidates; pre-existing
 * and external blockers are reported but never touched.
 */
export function feedbackFromCiChecks(checks: ClassifiedCheck[]): FeedbackItem[] {
  return checks
    .filter((c) => c.conclusion !== "success")
    .map((c) => ({
      id: `check:${c.name}`,
      kind: "ci_failure" as const,
      title: `CI: ${c.name} (${c.conclusion})`,
      body: [c.name, c.conclusion, c.failureLines?.join(" | ") ?? ""].filter(Boolean).join(" - "),
      author: "ci",
      authorKind: "bot" as AuthorKind,
      url: c.detailsUrl,
      evidence: c.evidence,
      verdict:
        c.class === "likely-yours"
          ? ("REAL" as const)
          : c.class === "indeterminate"
            ? ("NEEDS_HUMAN" as const)
            : ("FALSE_POSITIVE" as const),
    }));
}

export interface TriageSummary {
  total: number;
  byKind: Record<FeedbackKind, number>;
  botFindingsReal: number;
  botFindingsFalsePositive: number;
  botFindingsNeedsHuman: number;
  ciIntroduced: number;
  ciPreExistingOrExternal: number;
}

export function summarizeFeedback(items: FeedbackItem[]): TriageSummary {
  const byKind = {
    ci_failure: 0,
    review_change_request: 0,
    bot_finding: 0,
    merge_conflict: 0,
    dco_gap: 0,
    maintainer_question: 0,
    approval: 0,
    other: 0,
  } as Record<FeedbackKind, number>;
  let botFindingsReal = 0;
  let botFindingsFalsePositive = 0;
  let botFindingsNeedsHuman = 0;
  let ciIntroduced = 0;
  let ciPreExistingOrExternal = 0;
  for (const i of items) {
    byKind[i.kind] += 1;
    if (i.kind === "bot_finding") {
      if (i.verdict === "REAL") botFindingsReal += 1;
      else if (i.verdict === "FALSE_POSITIVE") botFindingsFalsePositive += 1;
      else if (i.verdict === "NEEDS_HUMAN") botFindingsNeedsHuman += 1;
    }
    if (i.kind === "ci_failure") {
      if (i.verdict === "REAL") ciIntroduced += 1;
      else ciPreExistingOrExternal += 1;
    }
  }
  return {
    total: items.length,
    byKind,
    botFindingsReal,
    botFindingsFalsePositive,
    botFindingsNeedsHuman,
    ciIntroduced,
    ciPreExistingOrExternal,
  };
}

// Re-export for callers that only need the author kind helper.
export { authorKindOf };
