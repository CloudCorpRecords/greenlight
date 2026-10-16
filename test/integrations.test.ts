import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "integrations");

function jsonFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) jsonFiles(p, out);
    else if (entry.endsWith(".json")) out.push(p);
  }
  return out;
}

const REQUIRED_COMMAND = "npx";
const REQUIRED_ARGS = ["-y", "@reneturcios/greenlight", "mcp"];

describe("integrations pack", () => {
  it("every .json in integrations/ parses", () => {
    const files = jsonFiles(root);
    assert.ok(files.length >= 6, `expected at least 6 json configs, got ${files.length}`);
    for (const f of files) {
      assert.doesNotThrow(() => JSON.parse(readFileSync(f, "utf8")), f);
    }
  });

  it("every server entry uses the npx greenlight mcp command shape", () => {
    for (const f of jsonFiles(root)) {
      const doc = JSON.parse(readFileSync(f, "utf8")) as Record<string, any>;
      // Each file has exactly one top-level server map: mcpServers (most
      // clients) or servers (VS Code). Find whichever key holds servers.
      const map = doc.mcpServers ?? doc.servers;
      assert.ok(map && typeof map === "object", `${f}: needs mcpServers or servers`);
      for (const [name, entry] of Object.entries(map) as Array<[string, any]>) {
        assert.equal(entry.command, REQUIRED_COMMAND, `${f} [${name}].command`);
        assert.deepEqual(entry.args, REQUIRED_ARGS, `${f} [${name}].args`);
        if (doc.servers) {
          assert.equal(entry.type, "stdio", `${f} [${name}].type (VS Code needs stdio)`);
        }
      }
    }
  });

  it("every instruction file mentions check_issue and the stop rule", () => {
    const instructionFiles = [
      "claude-code/CLAUDE.snippet.md",
      "cursor/greenlight.mdc",
      "copilot/copilot-instructions.snippet.md",
    ];
    for (const rel of instructionFiles) {
      const text = readFileSync(join(root, rel), "utf8");
      assert.ok(text.includes("check_issue"), `${rel} must mention check_issue`);
      assert.ok(text.includes("TAKEN") && text.includes("GATED"), `${rel} must carry the stop rule`);
    }
  });

  it("the integrations README names all 13 MCP tools", () => {
    const text = readFileSync(join(root, "README.md"), "utf8");
    for (const tool of [
      "check_issue",
      "scan_repo",
      "repo_friction",
      "claim_issue",
      "prep_issue",
      "open_pr",
      "ci_triage",
      "review_triage",
      "guard_pr",
      "repo_digest",
      "claim_status",
      "preflight",
      "verify_comment",
    ]) {
      assert.ok(text.includes(tool), `README must name ${tool}`);
    }
  });

  it("the Cursor rule carries valid frontmatter", () => {
    const text = readFileSync(join(root, "cursor/greenlight.mdc"), "utf8");
    assert.ok(text.startsWith("---\n"), "mdc must start with frontmatter");
    const end = text.indexOf("\n---", 4);
    assert.ok(end > 0, "mdc frontmatter must close");
    const head = text.slice(4, end);
    assert.ok(head.includes("description:"), "mdc needs a description");
    assert.ok(head.includes("alwaysApply: false"), "mdc needs alwaysApply: false");
  });
});
