import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyLinkStrength, isClosingPR, hasGenuineIssueReference } from "../src/linkstrength.js";

// Real-world shape behind issue #1: pdfcn PR #91 closes #70 and lists
// sibling issues #60-#65 in its body. It is a "closing" PR for 70 only.
const PR91_BODY =
  "Closes #70\n\nThis also touches sibling blocks requested in #60, #61, #62, #63, #65.";

describe("classifyLinkStrength", () => {
  it("closing keywords on this issue mean closing", () => {
    for (const body of ["Closes #61", "fixes #61", "Resolved: #61", "closing #61", "CLOSED #61"]) {
      assert.equal(
        classifyLinkStrength({ title: "x", body, branch: "main", issueNumber: 61 }),
        "closing",
        body
      );
    }
  });

  it("a sibling-issue body like pdfcn PR #91 is a mention for #61", () => {
    assert.equal(
      classifyLinkStrength({
        title: "Add blocks for sibling issues",
        body: PR91_BODY,
        branch: "feat/invoice-block",
        issueNumber: 61,
      }),
      "mention"
    );
  });

  it("the same body is closing for the issue it actually closes", () => {
    assert.equal(
      classifyLinkStrength({
        title: "Add blocks for sibling issues",
        body: PR91_BODY,
        branch: "feat/invoice-block",
        issueNumber: 70,
      }),
      "closing"
    );
  });

  it("issue number in the PR title is closing", () => {
    assert.equal(
      classifyLinkStrength({ title: "#61: add resume block", body: "", branch: "main", issueNumber: 61 }),
      "closing"
    );
  });

  it("issue number as a branch token is closing", () => {
    for (const branch of ["61-resume-block", "feat/61-x", "issue-61", "fix-61"]) {
      assert.equal(
        classifyLinkStrength({ title: "add resume block", body: "", branch, issueNumber: 61 }),
        "closing",
        branch
      );
    }
  });

  it("#610 does not match issue 61 (mention)", () => {
    assert.equal(
      classifyLinkStrength({ title: "x", body: "also see #610", branch: "main", issueNumber: 61 }),
      "mention"
    );
    assert.equal(
      classifyLinkStrength({ title: "x", body: "", branch: "feat/610-x", issueNumber: 61 }),
      "mention"
    );
  });

  it("closing keywords for a different issue are a mention", () => {
    assert.equal(
      classifyLinkStrength({ title: "x", body: "Closes #62", branch: "main", issueNumber: 61 }),
      "mention"
    );
  });

  it("bare body mentions and cross-references are mentions", () => {
    assert.equal(
      classifyLinkStrength({ title: "unrelated work", body: "see also #61 for context", branch: "main", issueNumber: 61 }),
      "mention"
    );
    assert.equal(
      classifyLinkStrength({ title: "unrelated work", body: "", branch: "main", issueNumber: 61 }),
      "mention"
    );
  });
});

describe("isClosingPR", () => {
  it("requires closing strength", () => {
    assert.equal(isClosingPR({ linkStrength: "closing" }), true);
    assert.equal(isClosingPR({ linkStrength: "mention" }), false);
  });

  it("defaults a missing strength to mention (old caches stay safe)", () => {
    assert.equal(isClosingPR({}), false);
  });
});

describe("hasGenuineIssueReference (v0.21.2 GL-2)", () => {
  it("bare digits inside an attachment UUID are NOT a reference", () => {
    assert.equal(
      hasGenuineIssueReference({
        title: "fix: graphql schema error messages",
        body: "![s](https://github.com/user-attachments/assets/60645217-9611-47bd-9ccb-ee5eddce84b8)",
        branch: "fix/graphql-errors",
        issueNumber: 9611,
      }),
      false
    );
    assert.equal(
      hasGenuineIssueReference({
        title: "some PR",
        body: "the number 9611 appears as plain digits in prose",
        branch: "main",
        issueNumber: 9611,
      }),
      false
    );
  });

  it("a #<n> token, an issue URL, or a branch token IS a reference", () => {
    assert.equal(
      hasGenuineIssueReference({ title: "x", body: "Related to #9611", branch: "main", issueNumber: 9611 }),
      true
    );
    assert.equal(
      hasGenuineIssueReference({
        title: "x",
        body: "See https://github.com/usebruno/bruno/issues/9611 for context",
        branch: "main",
        issueNumber: 9611,
      }),
      true
    );
    assert.equal(
      hasGenuineIssueReference({ title: "x", body: "", branch: "feat/9611-combined-docs", issueNumber: 9611 }),
      true
    );
  });

  it("#96110 does not count as a reference to #9611", () => {
    assert.equal(
      hasGenuineIssueReference({ title: "x", body: "see #96110", branch: "main", issueNumber: 9611 }),
      false
    );
  });
});
