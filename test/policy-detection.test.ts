/**
 * v0.9.3 "the tool learns": gate-detection coverage from the Agent Policy
 * Index field work. The 5k scan found nine agent bans Greenlight missed
 * because they live in CONTRIBUTING.md (all probed locations) or in an
 * org-level AI_POLICY.md, in prose the old patterns never covered. The
 * independent audit then found the opposite disease in the scan-side
 * classifier (false bans from fixed-window keyword matching), so three
 * nuance specimens pin the correct behavior: welcome/waiver text must
 * never read as a ban, and a scoped ban plus a human path must
 * dual-class, never collapse.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseGates,
  parseGatesFromSources,
  resolveBanContradictions,
} from "../src/gates.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "policy");
const read = (name: string) => readFileSync(join(DIR, name), "utf8");
const detected = (text: string) =>
  parseGates(text).filter((g) => g.detected).map((g) => g.kind);
const detectedFromSources = (sources: { file: string; text: string }[]) =>
  parseGatesFromSources(sources).filter((g) => g.detected).map((g) => g.kind);

describe("v0.9.3 field-ban fixtures (all nine were missed before)", () => {
  it("immich: 'We ask you not to open PRs generated with an LLM'", () => {
    const kinds = detected(read("immich-contributing.md"));
    assert.ok(kinds.includes("agents_banned"), `expected agents_banned, got ${kinds}`);
  });

  it("home-assistant: ban lives in the repo AI_POLICY.md", () => {
    const kinds = detected(read("home-assistant-ai-policy.md"));
    assert.ok(kinds.includes("agents_banned"), `expected agents_banned, got ${kinds}`);
  });

  it("zed: unscoped autonomous-agent ban plus disclosure ask", () => {
    const kinds = detected(read("zed-contributing.md"));
    assert.ok(kinds.includes("agents_banned"), `expected agents_banned, got ${kinds}`);
    assert.ok(kinds.includes("agents_disclosure"), `expected agents_disclosure, got ${kinds}`);
  });

  it("meilisearch: refuses generative-AI content, asks disclosure", () => {
    const kinds = detected(read("meilisearch-contributing.md"));
    assert.ok(kinds.includes("agents_banned"), `expected agents_banned, got ${kinds}`);
    assert.ok(kinds.includes("agents_disclosure"), `expected agents_disclosure, got ${kinds}`);
  });

  it("dspy: fully autonomous agents banned, disclosure required", () => {
    const kinds = detected(read("dspy-contributing.md"));
    assert.ok(kinds.includes("agents_banned"), `expected agents_banned, got ${kinds}`);
    assert.ok(kinds.includes("agents_disclosure"), `expected agents_disclosure, got ${kinds}`);
  });

  it("kedro: no AI contributions by bots with no human in the loop", () => {
    const kinds = detected(read("kedro-contributing.md"));
    assert.ok(kinds.includes("agents_banned"), `expected agents_banned, got ${kinds}`);
    // kedro's text states a ban with an approval path, not a disclosure
    // ritual, so disclosure must not be invented for it.
    assert.ok(!kinds.includes("agents_disclosure"), `no disclosure ask here, got ${kinds}`);
  });

  it("alacritty: must not include LLM-generated content", () => {
    const kinds = detected(read("alacritty-contributing.md"));
    assert.ok(kinds.includes("agents_banned"), `expected agents_banned, got ${kinds}`);
  });

  it("astral-sh org policy: autonomous agents banned, disclosure required", () => {
    const kinds = detected(read("astral-ai-policy.md"));
    assert.ok(kinds.includes("agents_banned"), `expected agents_banned, got ${kinds}`);
    assert.ok(kinds.includes("agents_disclosure"), `expected agents_disclosure, got ${kinds}`);
  });

  it("mastodon: ban via the org .github AI_POLICY.md source", () => {
    const kinds = detectedFromSources([
      { file: "CONTRIBUTING.md", text: "You should also read the project's [AI Contribution Policy](https://github.com/mastodon/.github/blob/main/AI_POLICY.md)." },
      { file: "AI_POLICY.md (org mastodon)", text: read("mastodon-ai-policy.md") },
    ]);
    assert.ok(kinds.includes("agents_banned"), `expected agents_banned, got ${kinds}`);
    assert.ok(kinds.includes("agents_disclosure"), `expected agents_disclosure, got ${kinds}`);
  });
});

describe("v0.9.3 nuance specimens (the audit's false-ban shapes)", () => {
  it("hyperframes: welcomes AI and waives disclosure -> open, no ban, no disclosure gate", () => {
    const kinds = detected(read("hyperframes-contributing.md"));
    assert.ok(!kinds.includes("agents_banned"), `must not be banned, got ${kinds}`);
    assert.ok(!kinds.includes("agents_disclosure"), `waiver means no disclosure gate, got ${kinds}`);
  });

  it("coolify: a disclosure rule is not a ban", () => {
    const kinds = detected(read("coolify-contributing.md"));
    assert.ok(!kinds.includes("agents_banned"), `must not be banned, got ${kinds}`);
    assert.ok(kinds.includes("agents_disclosure"), `expected agents_disclosure, got ${kinds}`);
  });

  it("ppt-master: scoped ban on unreviewed dumps plus welcome -> dual-class", () => {
    const kinds = detectedFromSources([
      { file: "CONTRIBUTING.md", text: read("pptmaster-contributing.md") },
    ]);
    assert.ok(kinds.includes("agents_banned"), `expected agents_banned, got ${kinds}`);
    assert.ok(kinds.includes("agents_disclosure"), `expected dual agents_disclosure, got ${kinds}`);
    const ban = parseGatesFromSources([
      { file: "CONTRIBUTING.md", text: read("pptmaster-contributing.md") },
    ]).find((g) => g.kind === "agents_banned")!;
    assert.match(ban.evidence, /without human review/i, "ban evidence names the scope");
  });

  it("typescript: bulk agent-driven ban plus disclosure path -> dual-class", () => {
    const kinds = detectedFromSources([
      { file: "CONTRIBUTING.md", text: read("typescript-contributing.md") },
    ]);
    assert.ok(kinds.includes("agents_banned"), `expected agents_banned, got ${kinds}`);
    assert.ok(kinds.includes("agents_disclosure"), `expected agents_disclosure, got ${kinds}`);
  });
});

describe("v0.9.3 contradiction resolution", () => {
  it("an unscoped explicit ban stands even next to welcome language (zed shape)", () => {
    const text = "We welcome the use of LLMs for coding. We don't accept contributions from autonomous agents.";
    const kinds = detectedFromSources([{ file: "AGENTS.md", text }]);
    assert.ok(kinds.includes("agents_banned"), `unscoped ban must stand, got ${kinds}`);
  });

  it("a scoped ban plus welcome synthesizes disclosure instead of standing alone", () => {
    const text = "AI assistance is welcome. Purely AI-generated PRs submitted without human review will be closed unmerged.";
    const gates = resolveBanContradictions(parseGates(text), text);
    assert.ok(gates.find((g) => g.kind === "agents_banned")!.detected);
    const dis = gates.find((g) => g.kind === "agents_disclosure")!;
    assert.equal(dis.detected, true, "welcome must survive as disclosure");
    assert.ok(dis.evidence.length > 0);
  });

  it("a disclosure waiver suppresses the disclosure gate", () => {
    const gates = parseGates("If you used AI to help, there is no need to disclose it.");
    assert.equal(gates.find((g) => g.kind === "agents_disclosure")!.detected, false);
  });

  it("ban phrases split across line wraps are still detected", () => {
    const kinds = detected("Contributions made by autonomous\nagents are not accepted.");
    assert.ok(kinds.includes("agents_banned"), `expected agents_banned, got ${kinds}`);
  });
});
