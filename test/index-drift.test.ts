import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareIndexDrift,
  liveIndexClasses,
  GATE_TO_INDEX_CLASS,
} from "../src/index-drift.js";
import type { Gate } from "../src/types.js";

function gatesOn(kinds: Gate["kind"][]): Gate[] {
  return kinds.map((kind) => ({ kind, detected: true, evidence: "test" }));
}

describe("liveIndexClasses", () => {
  it("maps detected gates into index vocabulary", () => {
    assert.deepEqual(liveIndexClasses(gatesOn(["agents_banned"])), ["agents-banned"]);
    assert.deepEqual(
      liveIndexClasses(gatesOn(["agents_banned", "agents_disclosure", "cla_required"])),
      ["agents-banned", "agents-disclosure", "cla-required"]
    );
  });

  it("is open when nothing is detected", () => {
    assert.deepEqual(liveIndexClasses([]), ["open"]);
    assert.deepEqual(
      liveIndexClasses([{ kind: "agents_banned", detected: false, evidence: "" }]),
      ["open"]
    );
  });

  it("every mapped kind exists in the map", () => {
    assert.equal(GATE_TO_INDEX_CLASS["collaborators_only"], "collaborators-only");
    assert.equal(GATE_TO_INDEX_CLASS["unsolicited_prs_paused"], "paused");
  });
});

describe("compareIndexDrift", () => {
  it("flags the gleam case: index open, live agents-banned", () => {
    const d = compareIndexDrift(
      { repo: "gleam-lang/gleam", policy_classes: ["open"], verified_on: "2026-10-18" },
      gatesOn(["agents_banned"])
    );
    assert.ok(d);
    assert.ok(d!.warning.includes("INDEX DRIFT"));
    assert.ok(d!.warning.includes("agents-banned"));
    assert.ok(d!.warning.includes("open"));
    assert.ok(d!.warning.includes("2026-10-18"));
    assert.equal(d!.indexVerifiedOn, "2026-10-18");
  });

  it("is silent when live and index agree", () => {
    const d = compareIndexDrift(
      { repo: "astral-sh/uv", policy_classes: ["agents-banned", "agents-disclosure"], verified_on: "2026-10-17" },
      gatesOn(["agents_banned", "agents_disclosure"])
    );
    assert.equal(d, null);
  });

  it("is silent for an agreeing open entry", () => {
    const d = compareIndexDrift(
      { repo: "acme/widgets", policy_classes: ["open"], verified_on: "2026-10-20" },
      []
    );
    assert.equal(d, null);
  });

  it("flags a door class the live read no longer finds", () => {
    const d = compareIndexDrift(
      { repo: "acme/widgets", policy_classes: ["agents-banned"], verified_on: "2026-09-01" },
      []
    );
    assert.ok(d);
    assert.deepEqual(d!.liveClasses, ["open"]);
  });

  it("falls back to scanned_on when verified_on is absent", () => {
    const d = compareIndexDrift(
      { repo: "gleam-lang/gleam", policy_classes: ["open"], scanned_on: "2026-10-19" },
      gatesOn(["agents_banned"])
    );
    assert.equal(d!.indexVerifiedOn, "2026-10-19");
  });
});
