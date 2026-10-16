import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractErrorStrings, detectServerSideOnly } from "../src/server-side.js";

const COMPOSIO_BODY = `POST /api/v3.1/connected_accounts returns HTTP 422.
\`Invalid connection status: expected "INITIALIZING" but got "ACTIVE". The connection data does not match the required status.\`
Error: code 1706 on the token import path.`;

describe("extractErrorStrings", () => {
  it("pulls backtick-quoted spans and error lines", () => {
    const out = extractErrorStrings(COMPOSIO_BODY);
    assert.ok(out.some((s) => s.includes("Invalid connection status")));
    assert.ok(out.length >= 1 && out.length <= 4);
  });

  it("returns nothing for a body with no error-shaped text", () => {
    assert.deepEqual(extractErrorStrings("Add a dark mode toggle to the settings page."), []);
  });

  it("drops very short spans", () => {
    assert.deepEqual(extractErrorStrings("The `ok` flag is fine."), []);
  });
});

describe("detectServerSideOnly", () => {
  it("flags possibly-server-side when the error text has zero repo hits", async () => {
    const out = await detectServerSideOnly("ComposioHQ", "composio", COMPOSIO_BODY, {
      codeSearch: async () => 0,
    });
    assert.ok(out);
    assert.equal(out.flag, "possibly-server-side");
    assert.ok(out.evidence.includes("Invalid connection status"));
    assert.ok(out.evidence.includes("ComposioHQ/composio"));
  });

  it("returns null when the error text exists in the repo", async () => {
    const out = await detectServerSideOnly("ComposioHQ", "composio", COMPOSIO_BODY, {
      codeSearch: async () => 3,
    });
    assert.equal(out, null);
  });

  it("returns null (no guess) when the search fails", async () => {
    const out = await detectServerSideOnly("ComposioHQ", "composio", COMPOSIO_BODY, {
      codeSearch: async () => {
        throw new Error("rate limited");
      },
    });
    assert.equal(out, null);
  });

  it("returns null when the body carries no error text", async () => {
    let called = false;
    const out = await detectServerSideOnly("acme", "widget", "Add a toggle.", {
      codeSearch: async () => {
        called = true;
        return 0;
      },
    });
    assert.equal(out, null);
    assert.equal(called, false);
  });
});
