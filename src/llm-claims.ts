/**
 * Optional AI claim-intent detection, backed by Fireworks.
 *
 * Governance (this is the whole point of the module):
 * - OFF by default. Nothing here runs unless FIREWORKS_API_KEY is set.
 * - The deterministic pattern layer (src/claims.ts) stays primary and
 *   cheaper: the LLM only runs when it found no strong claim.
 * - The LLM never invents evidence. Every flag must carry a quote that is
 *   an exact substring of the comment body; results without one are
 *   dropped before they can reach the verdict.
 * - Flags only ever downgrade GO to RISKY (flag "llm-claim"), mirroring
 *   soft-signal semantics. They can never produce TAKEN and never
 *   override GATED.
 * - Failures are silent by design: a timeout (~15s), a non-200 response,
 *   or an unparseable model reply returns no signal, never an exception
 *   into the check path.
 * - Classifications are cached (comment id + model id) in the existing
 *   file cache, so repeat checks do not re-bill.
 */
import { createHash } from "node:crypto";
import type {
  CommentSignal,
  IssueSnapshot,
  LLMClaimFlag,
  LlmLayerStatus,
  VerdictResult,
} from "./types.js";
import { isBotAuthor, strongClaimants } from "./claims.js";
import { cacheGet, cacheSet } from "./github.js";

export type { LlmLayerStatus };

/** Default model, verified live against the Fireworks catalog on 2026-10-16. */
export const DEFAULT_LLM_MODEL = "accounts/fireworks/models/glm-5p3-flash";
export const DEFAULT_LLM_BASE_URL = "https://api.fireworks.ai/inference/v1";
/** A slow model must never stall a check: this bounds one classification call. */
export const LLM_TIMEOUT_MS = 15_000;
/** Comment bodies are truncated in the prompt to bound token cost. */
const MAX_COMMENT_CHARS = 2000;
/** One batched call covers at most this many uncached comments. */
const MAX_COMMENTS_PER_CALL = 25;

export function llmModelId(env: NodeJS.ProcessEnv = process.env): string {
  return env.GREENLIGHT_LLM_MODEL || DEFAULT_LLM_MODEL;
}

export function llmBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GREENLIGHT_LLM_BASE_URL || DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");
}

export function llmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.FIREWORKS_API_KEY);
}

type FetchImpl = typeof fetch;

function commentKey(comment: CommentSignal): string {
  if (comment.id != null) return `id${comment.id}`;
  const h = createHash("sha256")
    .update(`${comment.author}\n${comment.createdAt}\n${comment.body}`)
    .digest("hex")
    .slice(0, 16);
  return `h${h}`;
}

function modelKeyPart(model: string): string {
  return model.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

const SYSTEM_PROMPT = `You classify GitHub issue comments as claims of work or not.
A CLAIM is a statement of intent by the commenter to DO the work (present or near-future), including soft forms: "looking into contributing a fix", "investigating this, will open a PR", "working on it".
NOT a claim: discussing the bug, reporting a reproduction, asking questions, saying you will NOT work on it, or a maintainer triaging.
Reply with STRICT JSON only, no prose outside the JSON:
{"classifications":[{"index":0,"claim":true,"quote":"<exact substring of the comment body showing the intent>","confidence":0.9,"reason":"<one short sentence>"}]}
Include every comment index. For non-claims use "claim":false and empty quote and reason.`;

// Few-shot anchors from real campaign field data (2026-10-16).
const FEWSHOTS = [
  {
    input: `[0] @sahyl (2026-10-14): I'm looking into contributing a fix here. @maintainer which approach do you prefer, A or B?`,
    output: `{"classifications":[{"index":0,"claim":true,"quote":"I'm looking into contributing a fix here","confidence":0.9,"reason":"States intent to contribute a fix and asks the maintainer for direction."}]}`,
  },
  {
    input: `[0] @Acrotux (2026-10-16): <a long audit of the CI configuration with specific findings> ... I'm not opening a PR for this one either.`,
    output: `{"classifications":[{"index":0,"claim":false,"quote":"","confidence":0.95,"reason":"Explicitly declines to open a PR."}]}`,
  },
  {
    input: `[0] @dev (2026-10-16): I can reproduce this on 2.4, looking into the logs now.`,
    output: `{"classifications":[{"index":0,"claim":false,"quote":"","confidence":0.9,"reason":"Investigating the bug for diagnosis, no stated intent to fix it."}]}`,
  },
];

function buildPrompt(comments: CommentSignal[]): string {
  const lines = [SYSTEM_PROMPT, "", "Examples:"];
  for (const fs of FEWSHOTS) {
    lines.push(`Comment: ${fs.input}`);
    lines.push(fs.output);
    lines.push("");
  }
  lines.push("Now classify these comments:");
  comments.forEach((c, i) => {
    const body = c.body.length > MAX_COMMENT_CHARS ? c.body.slice(0, MAX_COMMENT_CHARS) + "..." : c.body;
    lines.push(`[${i}] @${c.author} (${c.createdAt}): ${body}`);
  });
  return lines.join("\n");
}

interface RawClassification {
  index: number;
  claim: boolean;
  quote: string;
  confidence: number;
  reason: string;
}

/** Parse the model's strict JSON defensively. Never throws; [] means no signal. */
export function parseLlmClassifications(text: string): RawClassification[] {
  const candidates: string[] = [];
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  candidates.push(stripped);
  const brace = extractFirstJsonObject(stripped);
  if (brace && brace !== stripped) candidates.push(brace);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { classifications?: unknown };
      const list = Array.isArray(parsed?.classifications) ? parsed.classifications : [];
      const out: RawClassification[] = [];
      for (const item of list) {
        if (typeof item !== "object" || item === null) continue;
        const o = item as Record<string, unknown>;
        out.push({
          index: typeof o.index === "number" ? o.index : -1,
          claim: o.claim === true,
          quote: typeof o.quote === "string" ? o.quote : "",
          confidence: typeof o.confidence === "number" ? Math.min(1, Math.max(0, o.confidence)) : 0.5,
          reason: typeof o.reason === "string" ? o.reason : "",
        });
      }
      return out;
    } catch {
      // try the next candidate
    }
  }
  return [];
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export interface ClassifyOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/**
 * Classify the eligible comments of one issue (same eligibility pool the
 * pattern detector uses: no bots, no issue author). Returns validated
 * flags; any failure (timeout, non-200, unparseable reply) yields [] and
 * never throws.
 */
export interface ClassifyDetail {
  flags: LLMClaimFlag[];
  /**
   * True when a classification round completed (or there was nothing to
   * classify). False when the round never finished (transport failure,
   * non-200, unparseable reply): the caller must not mistake it for "no
   * claims". Nothing is cached in that case.
   */
  roundCompleted: boolean;
}

export async function classifyIssueClaims(
  issueAuthor: string,
  comments: CommentSignal[],
  opts: ClassifyOptions
): Promise<LLMClaimFlag[]> {
  return (await classifyIssueClaimsDetailed(issueAuthor, comments, opts)).flags;
}

export async function classifyIssueClaimsDetailed(
  issueAuthor: string,
  comments: CommentSignal[],
  opts: ClassifyOptions
): Promise<ClassifyDetail> {
  const model = opts.model ?? DEFAULT_LLM_MODEL;
  const baseUrl = (opts.baseUrl ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");
  const fetchImpl: FetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;

  const eligible = comments.filter(
    (c) => !isBotAuthor(c.author) && c.author !== issueAuthor && c.body.trim().length > 0
  );
  if (eligible.length === 0) return { flags: [], roundCompleted: true };

  // Newest first: claim intent matters most in recent comments.
  const ordered = [...eligible].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const modelPart = modelKeyPart(model);

  const cached = new Map<CommentSignal, LLMClaimFlag | null>();
  const toClassify: CommentSignal[] = [];
  for (const c of ordered.slice(0, MAX_COMMENTS_PER_CALL)) {
    const hit = cacheGet("llm", [modelPart, commentKey(c)]) as LLMClaimFlag | null | undefined;
    if (hit !== undefined) {
      cached.set(c, hit);
    } else {
      toClassify.push(c);
    }
  }

  let roundCompleted = true;
  if (toClassify.length > 0) {
    const raw = await callFireworks(buildPrompt(toClassify), {
      apiKey: opts.apiKey,
      model,
      baseUrl,
      fetchImpl,
      timeoutMs,
    });
    roundCompleted = raw !== null;
    // raw === null means the round never completed (transport failure,
    // non-200, unparseable reply). Cache NOTHING in that case: a cached
    // null would blind this comment for the full 30-day TTL, so the next
    // check must retry instead.
    if (raw !== null) {
    for (const r of raw) {
      const target = toClassify[r.index];
      // Index must be ours, and the quote must be an exact substring of
      // the comment body. Anything else is dropped: the model never
      // invents evidence.
      if (!target || r.index < 0) continue;
      if (r.claim && r.quote.length > 0 && target.body.includes(r.quote)) {
        const flag: LLMClaimFlag = {
          commentId: commentKey(target),
          author: target.author,
          createdAt: target.createdAt,
          quote: r.quote,
          confidence: r.confidence,
          reason: r.reason,
          model,
        };
        cacheSet("llm", [modelPart, commentKey(target)], flag);
        cached.set(target, flag);
      } else {
        cacheSet("llm", [modelPart, commentKey(target)], null);
        cached.set(target, null);
      }
    }
    // Indices the model never answered count as no-signal, and are cached
    // so a sparse reply does not re-bill.
    for (const c of toClassify) {
      if (!cached.has(c)) {
        cacheSet("llm", [modelPart, commentKey(c)], null);
        cached.set(c, null);
      }
    }
    }
  }

  const flags: LLMClaimFlag[] = [];
  for (const c of ordered) {
    const f = cached.get(c);
    if (f) flags.push(f);
  }
  return { flags, roundCompleted };
}

interface CallOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchImpl: FetchImpl;
  timeoutMs: number;
}

/** True when the reply carries any parseable JSON object, even an empty classifications list. */
function hasParseableJson(text: string): boolean {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  for (const candidate of [stripped, extractFirstJsonObject(stripped)]) {
    if (!candidate) continue;
    try {
      JSON.parse(candidate);
      return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

/**
 * One classification round. Returns null when the round never completed
 * (transport failure, non-200, unparseable reply) so the caller can tell
 * "no answer yet" apart from a completed round with no claims, and only
 * cache the latter.
 */
async function callFireworks(prompt: string, opts: CallOptions): Promise<RawClassification[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await opts.fetchImpl(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: "You are a precise classifier. Reply with strict JSON only." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    // Read choices[0].message.content only; reasoning models also return a
    // reasoning_content field, which is never the answer.
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) return null;
    if (!hasParseableJson(content)) return null;
    return parseLlmClassifications(content);
  } catch {
    // Timeout, network failure, or a JSON shape we do not recognize:
    // no signal, never an exception into the check path.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ApplyLlmOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
}

/**
 * Apply the optional LLM claim layer to a scored verdict. Runs only when
 * the key is set, the verdict is GO or RISKY (never GATED/TAKEN/STALE),
 * and the deterministic layer found no strong claim. A flag downgrades
 * GO to RISKY and adds flag "llm-claim" with the quote as evidence.
 * Returns the input verdict object unchanged when the layer is off or
 * has nothing to add, so disabled-by-default output is identical to
 * the deterministic engine's.
 */
export async function applyLlmClaims(
  snapshot: IssueSnapshot,
  legacy: VerdictResult,
  opts: ApplyLlmOptions = {}
): Promise<VerdictResult> {
  const env = opts.env ?? process.env;
  const model = llmModelId(env);

  // v0.9.2: every path reports the layer's status, so a dead layer can
  // never hide behind patterns-only output (the 2026-10-17 field misses).
  if (!llmEnabled(env)) {
    return {
      ...legacy,
      llm_status: {
        ran: false,
        reason: "FIREWORKS_API_KEY not set; the AI claim layer is off by default",
      },
    };
  }
  if (legacy.verdict !== "GO" && legacy.verdict !== "RISKY") {
    return {
      ...legacy,
      llm_status: {
        ran: false,
        model,
        reason: `the AI claim layer runs only on GO/RISKY verdicts (this issue scored ${legacy.verdict})`,
      },
    };
  }
  if (strongClaimants(legacy.claims).length > 0) {
    return {
      ...legacy,
      llm_status: {
        ran: false,
        model,
        reason: "the pattern layer already found a strong claim; the AI layer was skipped",
      },
    };
  }

  const { flags, roundCompleted } = await classifyIssueClaimsDetailed(
    snapshot.author ?? "",
    snapshot.comments,
    {
      apiKey: env.FIREWORKS_API_KEY as string,
      model,
      baseUrl: llmBaseUrl(env),
      fetchImpl: opts.fetchImpl,
    }
  );
  if (!roundCompleted) {
    return {
      ...legacy,
      llm_status: {
        ran: false,
        model,
        reason:
          "the AI claim round did not complete (transport failure, non-200, or unparseable reply); nothing was cached and no flags were added",
      },
    };
  }
  const llm_status: LlmLayerStatus = { ran: true, model };
  if (flags.length === 0) return { ...legacy, llm_status };

  const reasons = [...legacy.reasons];
  for (const f of flags) {
    reasons.push(
      `possible claim by ${f.author} (AI-detected, confidence ${f.confidence.toFixed(2)}): "${f.quote}"`
    );
  }
  return {
    ...legacy,
    verdict: legacy.verdict === "GO" ? "RISKY" : legacy.verdict,
    reasons,
    flags: [...legacy.flags, "llm-claim"],
    llm_claims: flags,
    llm_status,
  };
}
