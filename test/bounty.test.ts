import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectBounty } from "../src/bounty.js";

describe("detectBounty", () => {
  it("flags an Algora bounty as a dead platform (onyx #2281 style)", () => {
    const s = detectBounty({
      labels: ["💎 Bounty"],
      title: "Feature: dark mode for the dashboard",
      body: "This issue has a $250 bounty via Algora. Claim it to get started.",
    });
    assert.ok(s);
    assert.equal(s.flag, "bounty-platform-dead");
    assert.equal(s.platform, "algora");
    assert.ok(s.evidence.includes("404"));
  });

  it("flags a dollar bounty with no platform as unverified", () => {
    const s = detectBounty({
      labels: ["bounty"],
      title: "Fix the export crash",
      body: "$100 bounty for a fix that lands with tests.",
    });
    assert.ok(s);
    assert.equal(s.flag, "bounty-unverified");
    assert.equal(s.amount, "$100");
  });

  it("flags a USDC bounty with no platform as unverified", () => {
    const s = detectBounty({
      labels: [],
      title: "[Bounty: $125] Add AbortSignal support",
      body: "125 USDC on merge.",
    });
    assert.ok(s);
    assert.equal(s.flag, "bounty-unverified");
  });

  it("passes a live platform through with no flag", () => {
    const s = detectBounty({
      labels: ["bounty"],
      title: "Small docs fix",
      body: "Funded via Polar. $50.",
    });
    assert.ok(s);
    assert.equal(s.flag, null);
    assert.equal(s.platform, "polar");
  });

  it("returns null when the issue advertises no bounty", () => {
    assert.equal(detectBounty({ labels: ["bug"], title: "Crash on start", body: "stacktrace here" }), null);
  });

  it("does not mistake a bare dollar figure for a bounty", () => {
    // A $ amount without bounty/reward language is pricing or data, not a bounty.
    assert.equal(
      detectBounty({ labels: [], title: "Report totals", body: "The budget is $250 for Q4." }),
      null
    );
  });
});
