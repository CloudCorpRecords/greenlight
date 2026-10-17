#!/usr/bin/env node
/**
 * Live smoke for the optional Fireworks claim-intent layer (v0.8.0).
 *
 * Reads FIREWORKS_API_KEY from the environment (never printed, never logged).
 * Optionally GITHUB_TOKEN for the GitHub comment fetch (60 req/hr works too).
 *
 * Usage:
 *   npm run build
 *   FIREWORKS_API_KEY=... node scripts/llm-claim-smoke.mjs
 *
 * Expected: resend/resend-node#1147 yields one AI flag for sahyl whose
 * quote contains "looking into contributing a fix" (the real comment uses
 * a curly apostrophe); the Acrotux-style explicit non-claim yields no flags.
 */
import { fetchComments } from "../dist/github.js";
import { classifyIssueClaims, llmModelId, llmBaseUrl } from "../dist/llm-claims.js";

const apiKey = process.env.FIREWORKS_API_KEY;
if (!apiKey) {
  console.error("FIREWORKS_API_KEY is not set; nothing to smoke.");
  process.exit(2);
}

const ACROTUX = `I've audited the CI configuration end to end. Findings: the pull_request trigger has no path filters, so docs-only changes run the full backend matrix; the database matrix always runs all three engines; CodeQL analyzes both languages on every PR. These are real, but I'm not opening a PR for this one either.`;

async function smoke(owner, repo, number, author) {
  console.log(`\n=== ${owner}/${repo}#${number} ===`);
  const comments = await fetchComments(owner, repo, number);
  console.log(`fetched ${comments.length} comments`);
  const flags = await classifyIssueClaims(author, comments, { apiKey, model: llmModelId(), baseUrl: llmBaseUrl() });
  console.log(`model: ${llmModelId()}`);
  if (flags.length === 0) {
    console.log("no AI claim flags");
  }
  for (const f of flags) {
    console.log(`- @${f.author} (${f.confidence.toFixed(2)}): "${f.quote}"`);
    console.log(`  reason: ${f.reason}`);
  }
  return flags;
}

const resend = await smoke("resend", "resend-node", 1147, "");
const acrotux = await classifyIssueClaims("reporter", [
  { author: "Acrotux", body: ACROTUX, createdAt: "2026-10-16T10:00:00Z", id: 9001 },
], { apiKey, model: llmModelId(), baseUrl: llmBaseUrl() });
console.log(`\n=== Acrotux explicit non-claim ===`);
console.log(acrotux.length === 0 ? "no AI claim flags (correct)" : `UNEXPECTED FLAGS: ${JSON.stringify(acrotux)}`);

const ok =
  resend.some((f) => f.author === "sahyl" && f.quote.includes("looking into contributing a fix")) &&
  acrotux.length === 0;
console.log(ok ? "\nSMOKE PASSED" : "\nSMOKE FAILED");
process.exit(ok ? 0 : 1);
