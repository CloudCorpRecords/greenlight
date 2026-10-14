import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPRReferences,
  fetchCommentMentionedPRs,
  fetchHouseRules,
  type PullRefDetail,
} from "../src/github.js";
import type { CommentSignal } from "../src/types.js";

function comment(author: string, body: string): CommentSignal {
  return { author, body, createdAt: "2026-10-12T10:00:00Z" };
}

const pull = (n: number, title: string, body: string, merged = false, state: "open" | "closed" = "open"): PullRefDetail => ({
  number: n,
  state,
  merged,
  title,
  body,
  url: `https://github.com/acme/widget/pull/${n}`,
});

describe("extractPRReferences", () => {
  it("extracts bare #NNN refs and full PR URLs, deduped in order", () => {
    const refs = extractPRReferences(
      [
        comment("a", "Just a heads-up that PR #861 covers that work."),
        comment("b", "See https://github.com/acme/widget/pull/902 too. #861 again."),
      ],
      "acme",
      "widget"
    );
    assert.deepEqual(refs, [861, 902]);
  });

  it("ignores full URLs from other repos", () => {
    const refs = extractPRReferences(
      [comment("a", "Upstream fix: https://github.com/other/thing/pull/123")],
      "acme",
      "widget"
    );
    assert.deepEqual(refs, []);
  });

  it("returns nothing for prose without references", () => {
    const refs = extractPRReferences([comment("a", "I can reproduce this on macOS 15.")], "acme", "widget");
    assert.deepEqual(refs, []);
  });
});

describe("fetchCommentMentionedPRs", () => {
  const depsFor = (map: Record<number, PullRefDetail | null>, calls: number[] = []) => ({
    fetchPull: async (_o: string, _r: string, n: number) => {
      calls.push(n);
      if (!(n in map)) throw new Error(`unexpected fetch for #${n}`);
      return map[n];
    },
  });

  it("counts open PRs whose body mentions the issue number", async () => {
    const out = await fetchCommentMentionedPRs(
      "acme",
      "widget",
      691,
      [comment("other", "Heads-up: PR #861 covers the fallback work.")],
      [],
      depsFor({ 861: pull(861, "Improve fallback handling", "Addresses #691") })
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 861);
    assert.equal(out[0].state, "open");
    assert.equal(out[0].mentionsIssue, true);
  });

  it("skips the issue's own number and already-known PRs", async () => {
    const calls: number[] = [];
    const out = await fetchCommentMentionedPRs(
      "acme",
      "widget",
      691,
      [comment("other", "See #691 itself and #861 and #90.")],
      [90],
      depsFor({ 861: pull(861, "x", "y") }, calls)
    );
    assert.deepEqual(calls, [861]);
    assert.equal(out.length, 1);
  });

  it("skips references that 404 as PRs (they are issue numbers)", async () => {
    const out = await fetchCommentMentionedPRs(
      "acme",
      "widget",
      691,
      [comment("other", "Related to #700 and #861.")],
      [],
      depsFor({ 700: null, 861: pull(861, "x", "Fixes #691") })
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 861);
  });

  it("marks PRs whose text does not mention the issue", async () => {
    const out = await fetchCommentMentionedPRs(
      "acme",
      "widget",
      691,
      [comment("other", "Maybe #861 helps.")],
      [],
      depsFor({ 861: pull(861, "Unrelated refactor", "No issue link here") })
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].mentionsIssue, false);
  });

  it("maps merged PR state", async () => {
    const out = await fetchCommentMentionedPRs(
      "acme",
      "widget",
      691,
      [comment("other", "Landed in #861.")],
      [],
      depsFor({ 861: pull(861, "x", "Closes #691", true, "closed") })
    );
    assert.equal(out[0].state, "merged");
  });

  it("caps fetches at 5 references", async () => {
    const calls: number[] = [];
    const map: Record<number, PullRefDetail | null> = {};
    for (let n = 100; n < 110; n++) map[n] = pull(n, "x", "y");
    const comments = [comment("other", Array.from({ length: 10 }, (_, i) => `#${100 + i}`).join(" "))];
    const out = await fetchCommentMentionedPRs("acme", "widget", 691, comments, [], depsFor(map, calls));
    assert.equal(calls.length, 5);
    assert.equal(out.length, 5);
  });

  it("ends the walk on provider failure, keeping prior results", async () => {
    let n = 0;
    const deps = {
      fetchPull: async (_o: string, _r: string, num: number) => {
        n++;
        if (n === 2) throw new Error("network down");
        return pull(num, "x", `Fixes #691`);
      },
    };
    const out = await fetchCommentMentionedPRs(
      "acme",
      "widget",
      691,
      [comment("other", "#861 and #862")],
      [],
      deps
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 861);
  });
});

describe("fetchHouseRules", () => {
  it("collects only the files that exist, in order", async () => {
    const present: Record<string, string> = {
      "CONTRIBUTING.md": "Comment before starting work.",
      "AGENTS.md": "Sign off every commit (DCO).",
    };
    const rules = await fetchHouseRules("acme", "widget", {
      fetchRaw: async (file: string) => present[file],
    });
    assert.deepEqual(rules.map((r) => r.file), ["CONTRIBUTING.md", "AGENTS.md"]);
    assert.equal(rules[1].text, "Sign off every commit (DCO).");
  });

  it("returns an empty list when no policy file exists", async () => {
    const rules = await fetchHouseRules("acme", "widget", { fetchRaw: async () => undefined });
    assert.deepEqual(rules, []);
  });
});
