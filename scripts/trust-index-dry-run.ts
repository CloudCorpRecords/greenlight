/**
 * Policy Index dry run for the repo trust memory (Lane B).
 *
 * Reads an Agent Policy Index export, runs analyzePolicyIndex, and
 * prints the report as JSON. Writes nothing: the trust store is
 * never opened. Usage:
 *
 *   npx tsx scripts/trust-index-dry-run.ts [path-to-policy.json]
 *
 * Default input is the 2026-10-23 full index export in the
 * github-builds workspace; the copy bundled in docs/policy.json
 * (2,814 entries) can be passed explicitly instead.
 */
import { readFileSync } from "node:fs";
import { analyzePolicyIndex, type PolicyIndexEntry } from "../src/trust-seeds.js";

const path =
  process.argv[2] ??
  "/home/hatch/workspace/github-builds/policy-2026-10-23.json";

const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries: PolicyIndexEntry[] };
const report = analyzePolicyIndex(parsed.entries);
console.log(JSON.stringify({ input: path, ...report }, null, 2));
