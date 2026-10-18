/**
 * Autopilot feedback classification tests (v0.11.0).
 *
 * Kinds for every actionable item; deterministic REAL / FALSE_POSITIVE /
 * NEEDS_HUMAN verdicts for bot findings verified against the code at head.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReviewItem,
  verifyBotFinding,
  extractCandidates,
  feedbackFromCiChecks,
  summarizeFeedback,
} from "../src/autopilot-triage.js";

describe("classifyReviewItem", () => {
  it("maps review states", () => {
    assert.equal(
      classifyReviewItem({ body: "great", author: "x", authorKind: "human", reviewState: "APPROVED" }),
      "approval"
    );
    assert.equal(
      classifyReviewItem({ body: "fix this", author: "x", authorKind: "human", reviewState: "CHANGES_REQUESTED" }),
      "review_change_request"
    );
  });

  it("treats bot findings as bot_finding", () => {
    assert.equal(
      classifyReviewItem({ body: "this could leak", author: "cubic-dev-ai", authorKind: "bot" }),
      "bot_finding"
    );
  });

  it("detects maintainer questions from human authors", () => {
    assert.equal(
      classifyReviewItem({ body: "Did you consider the edge case here?", author: "maintainer", authorKind: "human" }),
      "maintainer_question"
    );
    assert.equal(
      classifyReviewItem({ body: "Could you add a test for this?", author: "maintainer", authorKind: "human" }),
      "maintainer_question"
    );
  });

  it("falls back to other", () => {
    assert.equal(
      classifyReviewItem({ body: "noted", author: "maintainer", authorKind: "human" }),
      "other"
    );
  });
});

describe("extractCandidates", () => {
  it("pulls paths and code quotes from a bot finding", () => {
    const body = "In `src/cli.ts` the call `serve({ fetch: app.fetch })` should be awaited.";
    const { paths, quotes } = extractCandidates(body);
    assert.ok(paths.includes("src/cli.ts"));
    assert.ok(quotes.some((q) => q.includes("serve(")));
  });

  it("prefers the anchored path", () => {
    const { paths } = extractCandidates("look at this", "packages/nuxt/x.ts");
    assert.ok(paths.includes("packages/nuxt/x.ts"));
  });
});

describe("verifyBotFinding", () => {
  const file = "const serve = (opts) => start(opts);";
  const fetch = async (path: string) => (path === "src/x.ts" ? file : null);

  it("returns REAL when the quoted code exists at head", async () => {
    const { verdict } = await verifyBotFinding(
      { body: "This `const serve = (opts) => start(opts);` is unused.", path: "src/x.ts" },
      { fetchFileAtHead: fetch }
    );
    assert.equal(verdict, "REAL");
  });

  it("returns FALSE_POSITIVE when the quoted code is absent", async () => {
    const { verdict, evidence } = await verifyBotFinding(
      { body: "Remove `function totallyAbsentThing() {}` before merging.", path: "src/x.ts" },
      { fetchFileAtHead: fetch }
    );
    assert.equal(verdict, "FALSE_POSITIVE");
    assert.ok(evidence.includes("totallyAbsentThing"));
  });

  it("returns NEEDS_HUMAN when no files resolve", async () => {
    const { verdict } = await verifyBotFinding(
      { body: "Check `src/missing.ts` for the bug." },
      { fetchFileAtHead: async () => null }
    );
    assert.equal(verdict, "NEEDS_HUMAN");
  });

  it("returns NEEDS_HUMAN when the finding names nothing checkable", async () => {
    const { verdict } = await verifyBotFinding({ body: "overall this looks risky" }, {});
    assert.equal(verdict, "NEEDS_HUMAN");
  });
});

describe("feedbackFromCiChecks", () => {
  it("maps CI classes to verdicts", () => {
    const items = feedbackFromCiChecks([
      { name: "build", conclusion: "failure", class: "likely-yours", evidence: "e" } as never,
      { name: "flaky", conclusion: "failure", class: "pre-existing", evidence: "e" } as never,
      { name: "weird", conclusion: "failure", class: "indeterminate", evidence: "e" } as never,
    ]);
    assert.equal(items[0].verdict, "REAL");
    assert.equal(items[1].verdict, "FALSE_POSITIVE");
    assert.equal(items[2].verdict, "NEEDS_HUMAN");
    assert.ok(items.every((i) => i.kind === "ci_failure"));
  });
});

describe("summarizeFeedback", () => {
  it("counts by kind and verdict", () => {
    const s = summarizeFeedback([
      { id: "1", kind: "bot_finding", title: "t", body: "b", author: "a", authorKind: "bot", verdict: "REAL" },
      { id: "2", kind: "bot_finding", title: "t", body: "b", author: "a", authorKind: "bot", verdict: "FALSE_POSITIVE" },
      { id: "3", kind: "ci_failure", title: "t", body: "b", author: "ci", authorKind: "bot", verdict: "REAL" },
    ]);
    assert.equal(s.total, 3);
    assert.equal(s.byKind.bot_finding, 2);
    assert.equal(s.botFindingsReal, 1);
    assert.equal(s.botFindingsFalsePositive, 1);
    assert.equal(s.ciIntroduced, 1);
    assert.equal(s.ciPreExistingOrExternal, 0);
  });
});
