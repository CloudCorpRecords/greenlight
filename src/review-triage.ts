/**
 * Review-response triage. Answers the question every contributor asks after
 * pushing a PR: "which of these review comments actually need me?"
 *
 * The engine is deterministic (no LLM) and explainable by design: every
 * finding carries the reason for its class and a ready-to-adapt reply
 * draft. It never posts anything; the drafts are output only.
 *
 * Field cases it encodes, from the campaign's real review rounds:
 *
 *   - bruno / CodeRabbit: a finding about `interpolateVars` where the
 *     anchored hunk matches the quoted token (`__proto__`) -> likely-real.
 *   - n8n / cubic: a P1 SSRF claim that the code "calls fetch directly"
 *     while the hunk shows the call going through `createAiProxyFetch`
 *     -> likely-noise ("premise contradicted by surrounding code").
 *   - A human maintainer asking "should this also apply to X?"
 *     -> needs-decision, never noise.
 *   - CodeRabbit's "## Walkthrough" summary -> noise bucket, not a finding.
 *
 * Rule order per actionable finding:
 *   1. Human (non-bot) author, substantive: needs-decision. Human
 *      reviewers are never classified as noise.
 *   2. Bot finding on a generated file, lockfile, or snapshot:
 *      likely-noise.
 *   3. Bot finding asking a question: needs-decision.
 *   4. Bot security claim whose premise is contradicted by the hunk:
 *      likely-noise ("premise contradicted by surrounding code").
 *   5. Bot style nit whose flagged style is already the surrounding
 *      code's style: likely-noise ("contradicted by the surrounding code").
 *   6. Bot finding whose quoted anchor token appears in the hunk:
 *      likely-real ("anchor matches").
 *   7. Bot finding presenting a quoted token as present code, where the
 *      token is nowhere in the hunk: likely-noise ("anchor mismatch").
 *   8. Anything mixed or unproven: needs-decision.
 *
 * Honest limits, stated up front:
 *   - GitHub's REST API does not expose per-thread resolved state
 *     (that is GraphQL-only). The closest proxy is used: findings whose
 *     parent review was DISMISSED count as resolved. A comment thread
 *     resolved without dismissing its review still reads as open here.
 *   - Anchor analysis runs on the diff hunk attached to each comment.
 *     A finding quoted as new code (a suggestion) is why rule 7 only
 *     fires when the comment presents the token as *present* code.
 */
import { apiGet, parsePullUrl } from "./github.js";

export type ReviewFindingClass = "likely-real" | "likely-noise" | "needs-decision";

export type ReviewTriageVerdict = "HAS LIKELY-REAL" | "NEEDS DECISIONS" | "ALL NOISE" | "NO FINDINGS";

export type AuthorKind = "bot" | "human";

export interface RawFinding {
  /** Review-bot or human login, as GitHub reports it. */
  author: string;
  body: string;
  /** File path the comment anchors to; absent for review-level comments. */
  path?: string;
  /** Right-side line the comment anchors to, when known. */
  line?: number;
  /** Diff hunk attached to the comment, when known. */
  diffHunk?: string;
  /** Parent review's state (APPROVED/CHANGES_REQUESTED/COMMENTED/DISMISSED). */
  reviewState?: string;
}

export interface ClassifiedFinding {
  author: string;
  authorKind: AuthorKind;
  path?: string;
  line?: number;
  summary: string;
  class: ReviewFindingClass;
  /** The deterministic signal that decided the class. */
  reason: string;
  /** A ready-to-adapt reply draft. Never posted by Greenlight. */
  draft: string;
}

export interface ReviewCounts {
  likelyReal: number;
  likelyNoise: number;
  needsDecision: number;
  /** Skipped by rule: summaries, walkthroughs, praise. */
  noise: number;
  /** Skipped because the parent review was dismissed. */
  resolved: number;
}

export interface ReviewTriageInput {
  prUrl: string;
  prTitle: string;
  /** The PR author's login: their own comments are their replies, not incoming findings. */
  prAuthor: string;
  candidates: RawFinding[];
}

export interface ReviewTriageResult {
  pr: string;
  title: string;
  findings: ClassifiedFinding[];
  counts: ReviewCounts;
  verdict: ReviewTriageVerdict;
}

/** Known review-bot logins, without the [bot] suffix GitHub adds. */
const REVIEW_BOT_LOGINS = new Set([
  "coderabbitai",
  "cubic-dev-ai",
  "greptile-apps",
  "copilot-pull-request-reviewer",
  "github-copilot",
]);

export function authorKindOf(login: string): AuthorKind {
  return REVIEW_BOT_LOGINS.has(login.toLowerCase().replace(/\[bot\]$/, "")) ? "bot" : "human";
}

/** Comments that are documentation of the review, not findings. */
const NOISE_PATTERNS: RegExp[] = [
  // CodeRabbit's walkthrough and summary blocks.
  /^#{1,3}\s*(summary|walkthrough|changes\s+requested|review\s+summary|file[- ]level\s+changes)/im,
  /prompt for ai agents/i,
  /###\s*File[- ]Level\s+Changes/i,
  // Bot status pings ("I'll review this once CI passes", approvals with no finding).
  /^(i'll review|reviewing now|approved this|nit-pick pass complete)[\s\S]{0,120}$/i,
  // cubic's review-summary block (a per-review status header, not a finding).
  /<!--\s*cubic:review-summary/i,
  /\*\*\s*\d+\s+issues?\s+found\b/i,
  /no issues? found\b/i,
  // CodeRabbit's review-summary header.
  /##\s*Summary by CodeRabbit/i,
  // CodeRabbit's mechanical rollups: the "Actionable comments posted: N"
  // checklist, review-stack entry summaries, and auto-generated replies.
  /\*\*\s*Actionable comments posted:\s*\d+\s*\*\*/i,
  /This is an auto-generated (comment|reply) by CodeRabbit/i,
  /review_stack_entry_start/i,
];

/** Pure praise with no actionable content. */
const PRAISE_PATTERN = /^(looks good|great work|lgtm|nice|awesome|well done|perfect|ship it)\b/i;

export function isNoiseBody(body: string): boolean {
  const trimmed = body.trim();
  if (NOISE_PATTERNS.some((re) => re.test(trimmed))) return true;
  if (trimmed.length < 120 && PRAISE_PATTERN.test(trimmed)) {
    // Praise only counts as noise when it references no code.
    if (!/`[^`]+`/.test(trimmed) && !/\S+\.\w{1,4}:\d+/.test(trimmed)) return true;
  }
  return false;
}

/** File shapes a bot's code finding is almost always wrong about. */
const GENERATED_PATH_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/i, label: "lockfile" },
  { pattern: /(^|\/)(dist|build|out)\//i, label: "build output directory" },
  { pattern: /\.min\.(js|css)$/i, label: "minified bundle" },
  { pattern: /(^|\/)__snapshots__\//i, label: "test snapshot directory" },
  { pattern: /\.snap$/i, label: "test snapshot" },
  { pattern: /\.d\.ts$/i, label: "generated type declarations" },
];

const STYLE_WORDS = /prettier|eslint|format(?:ting|ter)?|indentation|indented|trailing comma|semicolon|quotes?|spacing/i;

/** Security-shaped claim language. */
const SECURITY_WORDS = /\b(SSRF|security|vulnerab|XSS|injection|P0|P1|unsafe)\b/i;
/** Language asserting the code makes a direct, unguarded call. */
const DIRECT_CALL_ASSERT = /\bdirectly\b|\bno proxy\b|\bwithout (a )?proxy\b|\braw fetch\b|\bunproxied\b/i;
/** Call-expression names that mean the fetch goes through a guard. */
const PROXY_HELPER = /\b([A-Za-z_$][\w$]*(?:proxy|Proxy|guard|Guard|sanitize|Sanitize|allowlist|Allowlist)[\w$]*)\s*\(/;

/**
 * Backticked and double-quoted code tokens in the finding body, in order.
 * Used for anchor matching: the comment's claim against the hunk's code.
 *
 * Pairing note: the regex allows 1-char spans in *matching* so backtick
 * pairing stays aligned (a skipped 1-char span would re-pair the
 * surrounding backticks into phantom tokens like " uses "); tokens
 * shorter than 2 chars are dropped after matching. Newlines are excluded
 * so fenced code blocks are never swallowed into one token.
 */
export function quotedTokens(body: string): string[] {
  const tokens: string[] = [];
  const re = /`([^`\n]{1,80})`|"([A-Za-z_$][\w$.\-/]{1,60})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const token = m[1] ?? m[2];
    if (token && token.length >= 2 && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

/** First sentence, trimmed to a line. */
export function oneLineSummary(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const first = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
  return first.length > 140 ? `${first.slice(0, 137)}...` : first;
}

/** Diff-hunk lines that are pre-existing context (leading space), not added. */
function hunkContextLines(hunk: string): string[] {
  return hunk.split("\n").filter((l) => l.startsWith(" "));
}

/** Tokens the finding presents as *present* code ("uses `X`", "on line 3 `Y`"). */
function presentCodeTokens(body: string): string[] {
  const tokens: string[] = [];
  const re = /\b(line|the code|uses?|calls?|assigns?|passes?|builds?|creates?|writes?)\s+`([^`]{2,60})`/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (!tokens.includes(m[2])) tokens.push(m[2]);
  }
  return tokens;
}

function draftForReal(summary: string): string {
  return `Good catch. Fixed in <next commit>: ${summary}`;
}

function draftForNoise(reason: string, path?: string, line?: number): string {
  const anchor = path && line ? ` (${path}:${line})` : "";
  return `Thanks for the review. I don't think this applies here: ${reason}${anchor}. Let me know if I'm missing something.`;
}

function draftForDecision(summary: string): string {
  return `Good question. The tradeoff I see: ${summary}. Would you like me to go with that, or do you prefer the other direction?`;
}

/**
 * Classify one actionable finding. Pure: all evidence comes from the
 * candidate itself (author kind, body, anchor, hunk).
 */
export function classifyFinding(c: RawFinding): ClassifiedFinding {
  const kind = authorKindOf(c.author);
  const summary = oneLineSummary(c.body);
  const tokens = quotedTokens(c.body);

  const build = (cls: ReviewFindingClass, reason: string, draft: string): ClassifiedFinding => ({
    author: c.author,
    authorKind: kind,
    path: c.path,
    line: c.line,
    summary,
    class: cls,
    reason,
    draft,
  });

  // Rule 1: humans are never noise; substantive human comments need a decision.
  if (kind === "human") {
    return build(
      "needs-decision",
      "a human reviewer raised this; only the author can weigh it",
      draftForDecision(summary)
    );
  }

  // Rule 2: generated files, lockfiles, snapshots.
  if (c.path) {
    for (const { pattern, label } of GENERATED_PATH_PATTERNS) {
      if (pattern.test(c.path)) {
        const reason = `comment is on a ${label}, which is generated; the finding targets build output, not source`;
        return build("likely-noise", reason, draftForNoise(reason, c.path, c.line));
      }
    }
  }

  // Rule 3: bot questions are decisions for the author.
  if (/\?/.test(c.body)) {
    return build(
      "needs-decision",
      "the finding is phrased as a question, so it asks the author to choose",
      draftForDecision(summary)
    );
  }

  const hunk = c.diffHunk ?? "";

  // Rule 4: security claim whose premise the hunk contradicts.
  if (SECURITY_WORDS.test(c.body) && DIRECT_CALL_ASSERT.test(c.body)) {
    const helper = PROXY_HELPER.exec(hunk);
    if (helper) {
      const reason = `premise contradicted by surrounding code: the hunk shows the call going through ${helper[1]}, not a direct fetch`;
      return build("likely-noise", reason, draftForNoise(reason, c.path, c.line));
    }
  }

  // Rule 5: style nit the surrounding code already contradicts.
  if (STYLE_WORDS.test(c.body) && hunk) {
    for (const token of tokens) {
      if (hunkContextLines(hunk).some((l) => l.includes(token))) {
        const reason = `style nit contradicted by the surrounding code: the context lines already use ${token}`;
        return build("likely-noise", reason, draftForNoise(reason, c.path, c.line));
      }
    }
  }

  // Rule 6: anchor match — the quoted token is in the hunk.
  if (hunk && tokens.some((t) => hunk.includes(t))) {
    const matched = tokens.find((t) => hunk.includes(t)) as string;
    const reason = `anchor matches: the comment's quoted token ${matched} is present in the anchored hunk`;
    return build("likely-real", reason, draftForReal(summary));
  }

  // Rule 7: anchor mismatch — presented as present code, but absent.
  for (const token of presentCodeTokens(c.body)) {
    if (hunk && !hunk.includes(token)) {
      const reason = `anchor mismatch: the comment presents ${token} as present code, but the anchored hunk does not contain it`;
      return build("likely-noise", reason, draftForNoise(reason, c.path, c.line));
    }
  }

  // Rule 8: mixed or unproven — leave it to the author.
  return build(
    "needs-decision",
    "no deterministic signal either way; the finding needs the author's judgment",
    draftForDecision(summary)
  );
}

/** Roll up per-finding classes into the verdict line. */
export function reviewVerdict(findings: ClassifiedFinding[]): ReviewTriageVerdict {
  if (findings.length === 0) return "NO FINDINGS";
  if (findings.some((f) => f.class === "likely-real")) return "HAS LIKELY-REAL";
  if (findings.some((f) => f.class === "needs-decision")) return "NEEDS DECISIONS";
  return "ALL NOISE";
}

function emptyCounts(): ReviewCounts {
  return { likelyReal: 0, likelyNoise: 0, needsDecision: 0, noise: 0, resolved: 0 };
}

/**
 * The pure engine: split noise, the author's own comments, and resolved
 * comments off, classify the rest, roll up. Noise bodies (summaries,
 * walkthroughs, praise) and findings on dismissed reviews never become
 * findings. The author's own comments count as noise: they are the
 * author's replies, not incoming review feedback.
 */
export function classifyReviewTriage(input: ReviewTriageInput): ReviewTriageResult {
  const counts = emptyCounts();
  const findings: ClassifiedFinding[] = [];
  for (const c of input.candidates) {
    if (input.prAuthor && c.author.toLowerCase() === input.prAuthor.toLowerCase()) {
      counts.noise += 1;
      continue;
    }
    if (c.reviewState === "DISMISSED") {
      counts.resolved += 1;
      continue;
    }
    if (isNoiseBody(c.body)) {
      counts.noise += 1;
      continue;
    }
    const f = classifyFinding(c);
    if (f.class === "likely-real") counts.likelyReal += 1;
    else if (f.class === "likely-noise") counts.likelyNoise += 1;
    else counts.needsDecision += 1;
    findings.push(f);
  }
  return {
    pr: input.prUrl,
    title: input.prTitle,
    findings,
    counts,
    verdict: reviewVerdict(findings),
  };
}

// ---------------------------------------------------------------------------
// Live layer: REST fetch of reviews, review comments, and bot issue comments.
// ---------------------------------------------------------------------------

interface ReviewApiItem {
  id?: unknown;
  user?: { login?: unknown };
  state?: unknown;
  body?: unknown;
  html_url?: unknown;
  submitted_at?: unknown;
}

interface ReviewCommentApiItem {
  id?: unknown;
  user?: { login?: unknown };
  body?: unknown;
  path?: unknown;
  line?: unknown;
  original_line?: unknown;
  diff_hunk?: unknown;
  pull_request_review_id?: unknown;
  in_reply_to_id?: unknown;
  html_url?: unknown;
  created_at?: unknown;
}

interface IssueCommentApiItem {
  id?: unknown;
  user?: { login?: unknown };
  body?: unknown;
  created_at?: unknown;
}

export interface ReviewTriageDeps {
  fetchPull?: (owner: string, repo: string, number: number) => Promise<{ title: string; author: string }>;
  fetchReviews?: (owner: string, repo: string, number: number) => Promise<ReviewApiItem[]>;
  fetchReviewComments?: (owner: string, repo: string, number: number) => Promise<ReviewCommentApiItem[]>;
  fetchIssueComments?: (owner: string, repo: string, number: number) => Promise<IssueCommentApiItem[]>;
}

/** Cap per source so one noisy PR cannot burn the whole rate budget. */
const PER_SOURCE_LIMIT = 100;

async function paged<T>(base: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 2; page++) {
    const data = (await apiGet(`${base}?per_page=${PER_SOURCE_LIMIT}&page=${page}`)) as T[];
    out.push(...(data ?? []));
    if ((data ?? []).length < PER_SOURCE_LIMIT) break;
  }
  return out;
}

async function defaultFetchPull(owner: string, repo: string, number: number): Promise<{ title: string; author: string }> {
  const p = (await apiGet(`/repos/${owner}/${repo}/pulls/${number}`)) as { title?: unknown; user?: { login?: unknown } };
  return { title: String(p.title ?? ""), author: loginOf(p.user) };
}

async function defaultFetchReviews(owner: string, repo: string, number: number): Promise<ReviewApiItem[]> {
  return paged<ReviewApiItem>(`/repos/${owner}/${repo}/pulls/${number}/reviews`);
}

async function defaultFetchReviewComments(owner: string, repo: string, number: number): Promise<ReviewCommentApiItem[]> {
  return paged<ReviewCommentApiItem>(`/repos/${owner}/${repo}/pulls/${number}/comments`);
}

async function defaultFetchIssueComments(owner: string, repo: string, number: number): Promise<IssueCommentApiItem[]> {
  return paged<IssueCommentApiItem>(`/repos/${owner}/${repo}/issues/${number}/comments`);
}

const loginOf = (u: { login?: unknown } | undefined): string => String(u?.login ?? "unknown");
const strOr = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const numOr = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/**
 * Full triage for a PR URL. Best-effort: a source that cannot be read
 * degrades to "no findings from that source" rather than an error.
 */
export async function triageReview(prUrl: string, deps: ReviewTriageDeps = {}): Promise<ReviewTriageResult> {
  const { owner, repo, number } = parsePullUrl(prUrl);
  const fetchPull = deps.fetchPull ?? defaultFetchPull;
  const fetchReviews = deps.fetchReviews ?? defaultFetchReviews;
  const fetchReviewComments = deps.fetchReviewComments ?? defaultFetchReviewComments;
  const fetchIssueComments = deps.fetchIssueComments ?? defaultFetchIssueComments;

  const pull = await fetchPull(owner, repo, number).catch(() => ({ title: "", author: "" }));
  const reviews = await fetchReviews(owner, repo, number).catch(() => [] as ReviewApiItem[]);
  const reviewComments = await fetchReviewComments(owner, repo, number).catch(() => [] as ReviewCommentApiItem[]);
  const issueComments = await fetchIssueComments(owner, repo, number).catch(() => [] as IssueCommentApiItem[]);

  const reviewStateById = new Map<number, string>();
  for (const r of reviews) {
    const id = numOr(r.id);
    if (id !== undefined) reviewStateById.set(id, String(r.state ?? ""));
  }

  const candidates: RawFinding[] = [];

  for (const c of reviewComments) {
    const body = strOr(c.body);
    if (!body.trim()) continue;
    const reviewId = numOr(c.pull_request_review_id);
    candidates.push({
      author: loginOf(c.user),
      body,
      path: strOr(c.path) || undefined,
      line: numOr(c.line) ?? numOr(c.original_line),
      diffHunk: strOr(c.diff_hunk) || undefined,
      reviewState: reviewId !== undefined ? reviewStateById.get(reviewId) : undefined,
    });
  }

  // Review-level bodies (CHANGES_REQUESTED summaries, per-review notes).
  for (const r of reviews) {
    const body = strOr(r.body);
    if (!body.trim()) continue;
    candidates.push({ author: loginOf(r.user), body, reviewState: String(r.state ?? "") });
  }

  // Bot issue comments (review summaries some bots post on the issue).
  // Only known review bots; human issue comments are conversation, not review.
  for (const c of issueComments) {
    const author = loginOf(c.user);
    if (authorKindOf(author) !== "bot") continue;
    const body = strOr(c.body);
    if (!body.trim()) continue;
    candidates.push({ author, body });
  }

  return classifyReviewTriage({ prUrl, prTitle: pull.title, prAuthor: pull.author, candidates });
}
