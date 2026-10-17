import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectTriageHold, hasTriageLabel, hasTriageNoticeComment } from "../src/triage.js";
import { buildTriageHolds } from "../src/digest.js";
import { scoreIssue } from "../src/verdict.js";
import type { IssueSnapshot } from "../src/types.js";

function snap(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    sourceUrl: "https://github.com/mastra-ai/mastra/issues/27360",
    owner: "mastra-ai",
    repo: "mastra",
    number: 27360,
    state: "open",
    title: "Idle HTTP transports prevent Node.js processes from exiting",
    author: "reporter",
    assignees: [],
    labels: [],
    comments: [],
    linkedPRs: [],
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

describe("triage hold detection", () => {
  it("matches triage labels case-insensitively", () => {
    assert.equal(hasTriageLabel(["bug", "Needs Triage"]), "Needs Triage");
    assert.equal(hasTriageLabel(["pending triage"]), "pending triage");
    assert.equal(hasTriageLabel(["status: needs triage"]), "status: needs triage");
    assert.equal(hasTriageLabel(["bug", "enhancement"]), undefined);
    assert.equal(hasTriageLabel([]), undefined);
  });

  it("matches a bot triage notice comment (mastra shape)", () => {
    const hit = hasTriageNoticeComment([
      {
        author: "dane-ai-mastra[bot]",
        body: "Please wait until maintainers remove the triage or approval label before opening a pull request for this issue.",
      },
    ]);
    assert.ok(hit);
    assert.equal(hit.author, "dane-ai-mastra[bot]");
    assert.ok(hit.quote.length > 0);
  });

  it("ignores a random human matching the notice shape", () => {
    const hit = hasTriageNoticeComment([
      { author: "somehuman", body: "wait until triage clears before opening a pull request, per the bot" },
    ]);
    assert.equal(hit, undefined);
  });

  it("caps an otherwise-GO verdict at RISKY with the hold named", () => {
    const r = scoreIssue(snap({ labels: ["pending triage"] }));
    assert.equal(r.verdict, "RISKY");
    assert.ok(r.flags.includes("triage-hold"));
    assert.ok(r.reasons.some((x) => x.includes("pending triage")));
  });

  it("flags the bot-notice variant in the verdict", () => {
    const r = scoreIssue(
      snap({
        comments: [
          {
            author: "dane-ai-mastra[bot]",
            body: "Please wait until maintainers remove the triage or approval label before opening a pull request for this issue.",
            createdAt: "2026-10-12T00:00:00Z",
          },
        ],
      })
    );
    assert.equal(r.verdict, "RISKY");
    assert.ok(r.flags.includes("triage-hold"));
  });

  it("never produces TAKEN from a hold", () => {
    const r = scoreIssue(snap({ labels: ["needs triage"] }));
    assert.notEqual(r.verdict, "TAKEN");
  });

  it("does not demote an already-RISKY issue beyond RISKY", () => {
    // A fresh strong claim returns RISKY from its own rule before the
    // warning-only section runs; the hold must not push it lower, and the
    // claim's own reason still leads.
    const r = scoreIssue(
      snap({
        labels: ["needs triage"],
        comments: [
          { author: "dev", body: "I am working on this.", createdAt: new Date().toISOString() },
        ],
      })
    );
    assert.equal(r.verdict, "RISKY");
    assert.ok(r.flags.includes("claimed"));
  });
});

describe("digest triage holds", () => {
  it("builds holds from the issue list without extra calls", () => {
    const holds = buildTriageHolds([
      { number: 1, title: "a", url: "https://x/1", labels: ["pending triage"] },
      { number: 2, title: "b", url: "https://x/2", labels: ["bug"] },
      { number: 3, title: "c", url: "https://x/3", labels: [] },
    ]);
    assert.equal(holds.length, 1);
    assert.equal(holds[0].number, 1);
    assert.ok(holds[0].evidence.includes("pending triage"));
  });
});
