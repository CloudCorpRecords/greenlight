/**
 * Autopilot git surgery tests (v0.11.0).
 *
 * The DCO engine productizes the manual pdfcn #95/#96/#97 work: commits
 * that lack the Signed-off-by trailer get message-only rewrites with
 * byte-identical trees, then the branch ref moves. Anchored (already
 * signed) commits keep their SHAs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasSignoff,
  withSignoff,
  planDcoSurgery,
  applyDcoSurgery,
  DCO_SIGNOFF_LINE,
  type CommitObject,
  type GitOpsDeps,
} from "../src/autopilot-git.js";

function commit(sha: string, message: string, tree = `tree-${sha}`): CommitObject {
  return {
    sha,
    treeSha: tree,
    message,
    parents: [],
    authorName: "Rene Turcios",
    authorEmail: "95189389+CloudCorpRecords@users.noreply.github.com",
    committerName: "Rene Turcios",
    committerEmail: "95189389+CloudCorpRecords@users.noreply.github.com",
  };
}

describe("signoff helpers", () => {
  it("detects a Signed-off-by trailer", () => {
    assert.ok(hasSignoff("fix\n\nSigned-off-by: Rene Turcios <a@b>"));
    assert.ok(hasSignoff("fix\n\nsigned-off-by: Rene Turcios <a@b>"));
    assert.ok(!hasSignoff("fix\n\nsome other line"));
    assert.ok(!hasSignoff("fix"));
  });

  it("withSignoff appends once and leaves signed messages alone", () => {
    const unsigned = "Add forge pr checks command";
    const signed = withSignoff(unsigned);
    assert.ok(signed.endsWith(DCO_SIGNOFF_LINE));
    assert.equal(withSignoff(signed), signed);
  });
});

describe("planDcoSurgery", () => {
  it("rewrites only unsigned commits and keeps anchors", () => {
    const a = commit("a", "first\n\n" + DCO_SIGNOFF_LINE);
    const b = commit("b", "second");
    const c = commit("c", "third");
    const plan = planDcoSurgery([a, b, c]);
    assert.deepEqual(plan.anchors, ["a"]);
    assert.deepEqual(plan.rewrites.map((r) => r.sha), ["b", "c"]);
    assert.ok(plan.rewrites[0].newMessage.endsWith(DCO_SIGNOFF_LINE));
    assert.ok(plan.rewrites[0].newMessage.startsWith("second"));
  });

  it("empty when everything is signed", () => {
    const plan = planDcoSurgery([commit("a", "x\n\n" + DCO_SIGNOFF_LINE)]);
    assert.equal(plan.rewrites.length, 0);
    assert.deepEqual(plan.anchors, ["a"]);
  });
});

describe("applyDcoSurgery", () => {
  function fakeDeps(store: Map<string, CommitObject>): GitOpsDeps & { moved: { branch: string; sha: string; force: boolean }[] } {
    const moved: { branch: string; sha: string; force: boolean }[] = [];
    let n = 0;
    return {
      moved,
      getCommit: async (_o, _r, sha) => {
        const c = store.get(sha);
        if (!c) throw new Error("unknown commit " + sha);
        return c;
      },
      createCommit: async (_o, _r, args) => {
        n += 1;
        const sha = `new-${n}`;
        store.set(sha, {
          sha,
          treeSha: args.tree,
          message: args.message,
          parents: args.parents,
          authorName: args.author.name,
          authorEmail: args.author.email,
          committerName: args.committer.name,
          committerEmail: args.committer.email,
        });
        return sha;
      },
      updateRef: async (_o, _r, branch, sha, force) => {
        moved.push({ branch, sha, force });
      },
    };
  }

  it("rewrites unsigned commits with byte-identical trees and force-moves the ref", async () => {
    const a = commit("a", "first\n\n" + DCO_SIGNOFF_LINE);
    const b = { ...commit("b", "second"), parents: ["a"] };
    const c = { ...commit("c", "third"), parents: ["b"] };
    const store = new Map([["a", a], ["b", b], ["c", c]]);
    const deps = fakeDeps(store);
    const res = await applyDcoSurgery("CloudCorpRecords", "pdfcn", "feat/x", [a, b, c], deps);
    assert.equal(res.fixed, 2);
    assert.equal(res.anchored, 1);
    assert.ok(res.treesIdentical);
    assert.equal(res.oldHead, "c");
    assert.equal(res.newHead, "new-2");
    // Anchor kept its SHA in the chain.
    const second = store.get("new-1");
    assert.ok(second);
    assert.deepEqual(second.parents, ["a"]);
    assert.equal(second.treeSha, "tree-b");
    assert.ok(second.message.endsWith(DCO_SIGNOFF_LINE));
    // Ref was force-moved exactly once, to the new head.
    assert.equal(deps.moved.length, 1);
    assert.deepEqual(deps.moved[0], { branch: "feat/x", sha: "new-2", force: true });
  });

  it("does nothing when everything is signed", async () => {
    const a = commit("a", "first\n\n" + DCO_SIGNOFF_LINE);
    const store = new Map([["a", a]]);
    const deps = fakeDeps(store);
    const res = await applyDcoSurgery("CloudCorpRecords", "pdfcn", "feat/x", [a], deps);
    assert.equal(res.fixed, 0);
    assert.equal(res.oldHead, "a");
    assert.equal(res.newHead, "a");
    assert.equal(deps.moved.length, 0);
  });

  it("aborts before the ref move when a tree would change", async () => {
    const b = commit("b", "second");
    const store = new Map([["b", b]]);
    const evil: GitOpsDeps = {
      getCommit: async (_o, _r, sha) => {
        const c = store.get(sha);
        if (!c) throw new Error("unknown");
        // Lie about the replacement's tree on verification read.
        if (sha.startsWith("new-")) return { ...c, treeSha: "tampered" };
        return c;
      },
      createCommit: async (_o, _r, args) => {
        store.set("new-1", { sha: "new-1", treeSha: args.tree, message: args.message, parents: args.parents, authorName: "", authorEmail: "", committerName: "", committerEmail: "" });
        return "new-1";
      },
      updateRef: async () => {
        throw new Error("ref move must never happen");
      },
    };
    await assert.rejects(
      () => applyDcoSurgery("CloudCorpRecords", "pdfcn", "feat/x", [b], evil),
      /aborted/
    );
  });
});
