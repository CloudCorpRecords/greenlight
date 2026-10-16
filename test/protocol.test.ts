/**
 * Tests for the Greenlight Claim Protocol core engine (Phase 1, v0.4.0).
 * All lifecycle math runs on injected data; every spec 3.3 transition that
 * Phase 1 covers gets a test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_MARKER,
  RELEASE_MARKER,
  parseClaimComment,
  parseClaimsPolicy,
  defaultClaimsPolicy,
  computeClaimState,
  applyOverCap,
  buildIssueStatus,
  type ClaimStateInput,
  type ProtocolCommentInput,
} from "../src/protocol.js";

const BASE = Date.parse("2026-10-16T00:00:00Z");
const day = (n: number): string => new Date(BASE + n * 86_400_000).toISOString();

function claimComment(author: string, n: number, id: number, extra = ""): ProtocolCommentInput {
  return {
    author,
    body: `I would like to work on this. ${extra}\n${CLAIM_MARKER}\nplan: fix the widget\neta-days: 3\nqueue-ok: yes`,
    createdAt: day(n),
    id,
  };
}

function plainComment(author: string, body: string, n: number, id = 900): ProtocolCommentInput {
  return { author, body, createdAt: day(n), id };
}

function releaseComment(author: string, n: number, id = 950): ProtocolCommentInput {
  return {
    author,
    body: `Giving this one up, sorry.\n${RELEASE_MARKER}`,
    createdAt: day(n),
    id,
  };
}

function input(partial: Partial<ClaimStateInput> & { comments: ProtocolCommentInput[] }): ClaimStateInput {
  return { now: day(3), ...partial };
}

describe("parseClaimComment", () => {
  it("detects the marker and parses structured lines", () => {
    const p = parseClaimComment(claimComment("alice", 0, 1).body);
    assert.equal(p.isClaim, true);
    assert.equal(p.isRelease, false);
    assert.equal(p.plan, "fix the widget");
    assert.equal(p.etaDays, 3);
    assert.equal(p.queueOk, true);
  });

  it("ignores unknown structured lines", () => {
    const p = parseClaimComment(`Taking it.\n${CLAIM_MARKER}\nrocket-ship: yes\nplan: keep it simple`);
    assert.equal(p.isClaim, true);
    assert.equal(p.plan, "keep it simple");
  });

  it("the marker alone is a valid claim", () => {
    const p = parseClaimComment(`Mine.\n${CLAIM_MARKER}`);
    assert.equal(p.isClaim, true);
    assert.equal(p.plan, null);
    assert.equal(p.etaDays, null);
    assert.equal(p.queueOk, null);
  });

  it("detects the release marker", () => {
    const p = parseClaimComment(releaseComment("alice", 2).body);
    assert.equal(p.isRelease, true);
    assert.equal(p.isClaim, false);
  });

  it("queue-ok: no parses to false", () => {
    const p = parseClaimComment(`x\n${CLAIM_MARKER}\nqueue-ok: no`);
    assert.equal(p.queueOk, false);
  });

  it("ignores marker-less comments", () => {
    const p = parseClaimComment("I'll take this, starting today");
    assert.equal(p.isClaim, false);
    assert.equal(p.isRelease, false);
  });
});

describe("parseClaimsPolicy / defaultClaimsPolicy", () => {
  it("defaults match the spec", () => {
    const d = defaultClaimsPolicy();
    assert.deepEqual(d, {
      protocol: 1,
      lease_days: 7,
      tenure_cap_days: 28,
      queue: true,
      who_can_claim: "anyone",
      maintainers: [],
    });
  });

  it("clamps lease_days to 1..30", () => {
    assert.equal(parseClaimsPolicy('{"protocol":1,"lease_days":0}').lease_days, 1);
    assert.equal(parseClaimsPolicy('{"protocol":1,"lease_days":99}').lease_days, 30);
    assert.equal(parseClaimsPolicy('{"protocol":1,"lease_days":10}').lease_days, 10);
  });

  it("keeps custom values and the maintainers list", () => {
    const p = parseClaimsPolicy(
      '{"protocol":1,"lease_days":10,"tenure_cap_days":40,"queue":false,"who_can_claim":"collaborators","maintainers":["lead-dev"]}'
    );
    assert.equal(p.lease_days, 10);
    assert.equal(p.tenure_cap_days, 40);
    assert.equal(p.queue, false);
    assert.equal(p.who_can_claim, "collaborators");
    assert.deepEqual(p.maintainers, ["lead-dev"]);
    assert.equal(p.invalid, undefined);
  });

  it("raises the tenure cap to at least one lease", () => {
    const p = parseClaimsPolicy('{"protocol":1,"lease_days":10,"tenure_cap_days":3}');
    assert.equal(p.tenure_cap_days, 10);
  });

  it("garbage JSON degrades to defaults with the warning flag", () => {
    const p = parseClaimsPolicy("not json at all {{{");
    assert.equal(p.invalid, true);
    assert.equal(p.lease_days, 7);
    assert.equal(p.tenure_cap_days, 28);
  });

  it("a non-object or a different protocol version degrades too", () => {
    assert.equal(parseClaimsPolicy("[1,2]").invalid, true);
    assert.equal(parseClaimsPolicy('{"protocol":2,"lease_days":5}').invalid, true);
  });
});

describe("computeClaimState: basic lifecycle", () => {
  it("a fresh claim is active with the lease math and the spec 3.2 record", () => {
    const c = computeClaimState(input({ comments: [claimComment("alice", 0, 1)], repo: "o/r", issue: 5 }));
    assert.equal(c.active?.state, "active");
    assert.equal(c.active?.claimant, "alice");
    assert.equal(c.active?.expiresAt, day(7));
    assert.equal(c.active?.lastHeartbeatAt, day(0));
    assert.equal(c.queue.length, 0);
    const r = c.activeRecord!;
    assert.deepEqual(
      [r.v, r.repo, r.issue, r.claimant, r.claimed_at, r.state, r.lease_days, r.expires_at, r.queue_position],
      [1, "o/r", 5, "alice", day(0), "active", 7, day(7), 1]
    );
    assert.equal(r.history[0].event, "claimed");
  });

  it("a comment heartbeat extends the lease", () => {
    const c = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1), plainComment("alice", "Still working on it", 5, 2)],
        now: day(8),
      })
    );
    assert.equal(c.active?.state, "active");
    assert.equal(c.active?.expiresAt, day(12));
    assert.equal(c.active?.lastHeartbeatAt, day(5));
  });

  it("comments from other users are not heartbeats", () => {
    const c = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1), plainComment("bob", "Excited to see this", 5, 2)],
        now: day(8),
      })
    );
    assert.equal(c.active, null);
    assert.equal(c.claims[0].state, "expired");
  });

  it("silence expires the claim and frees the issue", () => {
    const c = computeClaimState(input({ comments: [claimComment("alice", 0, 1)], now: day(10) }));
    assert.equal(c.active, null);
    assert.equal(c.activeRecord, null);
    assert.equal(c.queue.length, 0);
    assert.equal(c.claims[0].state, "expired");
  });

  it("marker-less comments are ignored entirely", () => {
    const c = computeClaimState(input({ comments: [plainComment("alice", "I'll take this, starting today", 0)] }));
    assert.equal(c.claims.length, 0);
    assert.equal(c.active, null);
  });

  it("comments with unparseable timestamps are skipped", () => {
    const bad: ProtocolCommentInput = { author: "alice", body: CLAIM_MARKER, createdAt: "not-a-date", id: 1 };
    const c = computeClaimState(input({ comments: [bad, claimComment("bob", 0, 2)] }));
    assert.equal(c.claims.length, 1);
    assert.equal(c.active?.claimant, "bob");
  });

  it("a heartbeat after release is ignored", () => {
    const c = computeClaimState(
      input({
        comments: [
          claimComment("alice", 0, 1),
          releaseComment("alice", 2),
          plainComment("alice", "Actually never mind, done", 5, 3),
        ],
        now: day(6),
      })
    );
    assert.equal(c.claims[0].state, "released");
    assert.equal(c.claims[0].lastHeartbeatAt, day(0));
  });
});

describe("computeClaimState: queue and promotion", () => {
  it("promotion on release restarts the lease at promotion time", () => {
    const c = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1), claimComment("bob", 1, 2), releaseComment("alice", 2)],
        now: day(5),
      })
    );
    assert.equal(c.claims[0].state, "released");
    assert.equal(c.active?.claimant, "bob");
    assert.equal(c.active?.activatedAt, day(2));
    assert.equal(c.active?.expiresAt, day(9)); // fresh lease from day 2, not day 1 + 7
    assert.equal(c.active?.position, 2);
  });

  it("promotion on expiry: the promoted claim is not born dead", () => {
    // Bob's lease (day 2 + 7 = day 9) would already be half gone if measured
    // from his own claim; the fresh-lease rule restarts it at promotion.
    const c = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1), claimComment("bob", 2, 2)],
        now: day(8),
      })
    );
    assert.equal(c.claims[0].state, "expired");
    assert.equal(c.active?.claimant, "bob");
    assert.equal(c.active?.activatedAt, day(7));
    assert.equal(c.active?.expiresAt, day(14));
    assert.equal(c.queue.length, 0);
  });

  it("promotion cascades through a long queue", () => {
    const c = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1), claimComment("bob", 1, 2), claimComment("cara", 2, 3)],
        now: day(15),
      })
    );
    assert.equal(c.active?.claimant, "cara");
    assert.equal(c.active?.activatedAt, day(14));
    assert.equal(c.active?.expiresAt, day(21));
    assert.equal(c.claims[0].state, "expired");
    assert.equal(c.claims[1].state, "expired");
    assert.ok(c.claims[1].history.some((h) => h.event === "promoted" && h.at === day(7)));
  });

  it("a second claim by the same author while alive is a heartbeat, not a claim", () => {
    const c = computeClaimState(
      input({ comments: [claimComment("alice", 0, 1), claimComment("alice", 1, 2)], now: day(3) })
    );
    assert.equal(c.claims.length, 1);
    assert.equal(c.active?.lastHeartbeatAt, day(1));
    assert.equal(c.active?.expiresAt, day(8));
  });

  it("a release by another user is ignored", () => {
    const c = computeClaimState(
      input({ comments: [claimComment("alice", 0, 1), releaseComment("mallory", 1)], now: day(3) })
    );
    assert.equal(c.active?.state, "active");
  });

  it("claims behind the holder are queued with positions", () => {
    const c = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1), claimComment("bob", 1, 2), claimComment("cara", 2, 3)],
        now: day(3),
      })
    );
    assert.equal(c.active?.claimant, "alice");
    assert.equal(c.queue.length, 2);
    assert.deepEqual(
      c.queue.map((q) => [q.claimant, q.position, q.state]),
      [
        ["bob", 2, "queued"],
        ["cara", 3, "queued"],
      ]
    );
  });
});

describe("computeClaimState: tenure cap", () => {
  it("the cap cuts heartbeat extensions", () => {
    const comments = [claimComment("alice", 0, 1)];
    for (const n of [6, 12, 18, 24]) comments.push(plainComment("alice", "update", n, 100 + n));
    const c = computeClaimState(
      input({ comments, policy: { ...defaultClaimsPolicy(), lease_days: 7, tenure_cap_days: 28 }, now: day(27) })
    );
    assert.equal(c.active?.state, "active");
    assert.equal(c.active?.expiresAt, day(28)); // day 24 + 7 would be day 31
    assert.equal(c.active?.lastHeartbeatAt, day(24));
    const c2 = computeClaimState(
      input({ comments, policy: { ...defaultClaimsPolicy(), lease_days: 7, tenure_cap_days: 28 }, now: day(29) })
    );
    assert.equal(c2.active, null);
    assert.equal(c2.claims[0].state, "expired");
  });
});

describe("computeClaimState: linked PRs", () => {
  it("an open linked PR freezes the lease", () => {
    const c = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1)],
        linkedPrs: [{ number: 5, state: "open", createdAt: day(5) }],
        now: day(30),
      })
    );
    assert.equal(c.active?.state, "linked");
    assert.equal(c.activeRecord?.linked_pr, 5);
    assert.ok(c.active?.history.some((h) => h.event === "linked" && h.at === day(5)));
  });

  it("a merged linked PR completes the claim", () => {
    const c = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1)],
        linkedPrs: [{ number: 5, state: "merged", createdAt: day(5) }],
        now: day(30),
      })
    );
    assert.equal(c.active?.state, "completed");
    assert.equal(c.activeRecord?.linked_pr, 5);
  });

  it("mergedPrNumber works when linkedPrs lacks the detail", () => {
    // The synthesized link event lands at `now`; evaluate while the claim
    // is still the holder so the fallback path is exercised.
    const c = computeClaimState(
      input({ comments: [claimComment("alice", 0, 1)], mergedPrNumber: 9, now: day(5) })
    );
    assert.equal(c.active?.state, "completed");
    assert.equal(c.activeRecord?.linked_pr, 9);
  });

  it("a PR linked after expiry belongs to the next holder, not the dead claim", () => {
    const c = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1), claimComment("bob", 1, 2)],
        linkedPrs: [{ number: 5, state: "open", createdAt: day(9) }],
        now: day(10),
      })
    );
    assert.equal(c.claims[0].state, "expired");
    assert.equal(c.active?.claimant, "bob");
    assert.equal(c.active?.state, "linked");
  });

  it("a closed (unmerged) linked PR keeps the lease frozen", () => {
    const c = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1)],
        linkedPrs: [{ number: 5, state: "closed", createdAt: day(5) }],
        now: day(30),
      })
    );
    assert.equal(c.active?.state, "linked");
  });
});

describe("computeClaimState: rocket reactions", () => {
  it("the claimant's rocket on their own claim comment is a heartbeat", () => {
    const c = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1)],
        reactions: [{ commentId: 1, user: "alice", content: "rocket" }],
        now: day(6),
      })
    );
    // Reactions carry no timestamp in this shape: they count as of `now`.
    assert.equal(c.active?.state, "active");
    assert.equal(c.active?.expiresAt, day(13));
  });

  it("a rocket from another user does not count", () => {
    const c = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1)],
        reactions: [{ commentId: 1, user: "bob", content: "rocket" }],
        now: day(6),
      })
    );
    assert.equal(c.active?.expiresAt, day(7));
  });

  it("non-rocket reactions do not count", () => {
    const c = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1)],
        reactions: [{ commentId: 1, user: "alice", content: "hooray" }],
        now: day(6),
      })
    );
    assert.equal(c.active?.expiresAt, day(7));
  });
});

describe("applyOverCap", () => {
  it("marks claims past the 5-active-claim budget", () => {
    const c = computeClaimState(input({ comments: [claimComment("alice", 0, 1), claimComment("bob", 1, 2)] }));
    const marked = applyOverCap([c.activeRecord!], { alice: 6 });
    assert.equal(marked[0].over_cap, true);
    const plain = applyOverCap([c.activeRecord!], { alice: 5 });
    assert.equal("over_cap" in plain[0], false);
    // Input untouched.
    assert.equal("over_cap" in c.activeRecord!, false);
  });
});

describe("buildIssueStatus", () => {
  const base = {
    issueUrl: "https://github.com/o/r/issues/5",
    repoProtocol: { honored: true, lease_days: 7 },
    checkedAt: "2026-10-16T18:00:00Z",
  };

  it("active claim maps to TAKEN with the expiry in the reason", () => {
    const comp = computeClaimState(
      input({ comments: [claimComment("alice", 0, 1), claimComment("bob", 1, 2)], repo: "o/r", issue: 5 })
    );
    const s = buildIssueStatus({ ...base, computation: comp });
    assert.equal(s.verdict, "TAKEN");
    assert.ok(s.reason!.includes("@alice"));
    assert.ok(s.reason!.includes("2026-10-23")); // expires_at date in the reason
    assert.equal(s.claim?.state, "active");
    assert.equal(s.claim?.claimant, "alice");
    assert.equal(s.claim?.expires_at, day(7));
    assert.deepEqual(
      s.claim?.queue.map((q) => [q.claimant, q.position]),
      [["bob", 2]]
    );
    assert.equal(s.repo_protocol?.honored, true);
    assert.equal(s.stale_after_seconds, 21600);
  });

  it("names open competing PRs in the TAKEN reason", () => {
    const comp = computeClaimState(input({ comments: [claimComment("alice", 0, 1)] }));
    const s = buildIssueStatus({
      ...base,
      computation: comp,
      competingPrs: [{ number: 42, author: "rival", state: "open" }],
    });
    assert.ok(s.reason!.includes("#42"));
  });

  it("expired-only history maps to GO with a note", () => {
    const comp = computeClaimState(input({ comments: [claimComment("alice", 0, 1)], now: day(10) }));
    const s = buildIssueStatus({ ...base, computation: comp });
    assert.equal(s.verdict, "GO");
    assert.ok(s.reason!.includes("free to claim"));
    assert.equal(s.claim, null);
  });

  it("completed maps to TAKEN naming the merged PR", () => {
    const comp = computeClaimState(
      input({
        comments: [claimComment("alice", 0, 1)],
        linkedPrs: [{ number: 7, state: "merged", createdAt: day(2) }],
        now: day(10),
      })
    );
    const s = buildIssueStatus({ ...base, computation: comp });
    assert.equal(s.verdict, "TAKEN");
    assert.ok(s.reason!.includes("#7"));
  });

  it("no protocol claims leaves the verdict to the caller", () => {
    const comp = computeClaimState(input({ comments: [plainComment("alice", "hello", 0)] }));
    const s = buildIssueStatus({ ...base, computation: comp, repoProtocol: null });
    assert.equal(s.verdict, null);
    assert.equal(s.claim, null);
    assert.equal(s.reason, null);
    assert.ok(s.protocol_note!.includes("No protocol claims"));
    assert.equal(s.repo_protocol, null);
  });

  it("over_cap on the record flows into the payload", () => {
    const comp = computeClaimState(input({ comments: [claimComment("alice", 0, 1)], repo: "o/r", issue: 5 }));
    const rec = applyOverCap([comp.activeRecord!], { alice: 9 })[0];
    const s = buildIssueStatus({ ...base, computation: { ...comp, activeRecord: rec } });
    assert.equal(s.claim?.over_cap, true);
  });
});
