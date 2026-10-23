import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initTools,
  detectTools,
  parseAgentList,
  findTool,
  INIT_BEGIN_MARKER,
  defaultPackDir,
} from "../src/init.js";

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "gl-init-proj-"));
  homeDir = mkdtempSync(join(tmpdir(), "gl-init-home-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

const opts = () => ({ projectDir, homeDir, packDir: defaultPackDir() });

function mcpJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("greenlight init", () => {
  it("installs the Claude Code config and appends instructions with markers", () => {
    const [r] = initTools(["claude-code"], opts());
    assert.equal(r.files.length, 2);
    assert.ok(r.files.every((f) => f.action === "created"));
    const doc = mcpJson(join(projectDir, ".mcp.json"));
    // v0.21.2: the shipped pack config is pinned to the package version
    // (P-196); init installs it verbatim, so the installed args are the
    // pinned form for the current version.
    const pkgVersion = (
      JSON.parse(readFileSync(join(defaultPackDir(), "..", "package.json"), "utf8")) as { version: string }
    ).version;
    assert.deepEqual(doc.mcpServers.greenlight.args, ["-y", `@reneturcios/greenlight@${pkgVersion}`, "mcp"]);
    const claude = readFileSync(join(projectDir, "CLAUDE.md"), "utf8");
    assert.ok(claude.includes(INIT_BEGIN_MARKER));
    assert.ok(claude.includes("check_issue"));
  });

  it("is idempotent: a second run only skips", () => {
    initTools(["claude-code", "cursor"], opts());
    const results = initTools(["claude-code", "cursor"], opts());
    for (const r of results) {
      assert.ok(r.files.every((f) => f.action === "skipped"), JSON.stringify(r.files));
    }
  });

  it("merges into an existing config without touching other servers", () => {
    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other", args: [] } } }),
      "utf8"
    );
    const [r] = initTools(["claude-code"], { ...opts(), includeInstructions: false });
    assert.equal(r.files[0].action, "merged");
    const doc = mcpJson(join(projectDir, ".mcp.json"));
    assert.ok(doc.mcpServers.other, "existing server preserved");
    assert.ok(doc.mcpServers.greenlight, "greenlight server added");
  });

  it("keeps existing user text when appending instructions", () => {
    writeFileSync(join(projectDir, "CLAUDE.md"), "# My project\n", "utf8");
    const [r] = initTools(["claude-code"], opts());
    const updated = r.files.find((f) => f.path.endsWith("CLAUDE.md"))!;
    assert.equal(updated.action, "updated");
    const text = readFileSync(join(projectDir, "CLAUDE.md"), "utf8");
    assert.ok(text.startsWith("# My project\n"), "user content kept at the top");
    assert.ok(text.includes("check_issue"));
  });

  it("refuses to clobber invalid JSON without --force, overwrites with it", () => {
    writeFileSync(join(projectDir, ".mcp.json"), "{not json", "utf8");
    assert.throws(
      () => initTools(["claude-code"], { ...opts(), includeInstructions: false }),
      /not valid JSON/
    );
    const [r] = initTools(["claude-code"], { ...opts(), includeInstructions: false, force: true });
    assert.equal(r.files[0].action, "overwritten");
    assert.ok(mcpJson(join(projectDir, ".mcp.json")).mcpServers.greenlight);
  });

  it("copies the Cursor rule file and reports the restart note", () => {
    const [r] = initTools(["cursor"], opts());
    assert.ok(existsSync(join(projectDir, ".cursor", "rules", "greenlight.mdc")));
    assert.ok(r.notes.some((n) => /restart/i.test(n)));
  });

  it("writes the Windsurf config under home, not the project", () => {
    const [r] = initTools(["windsurf"], opts());
    assert.equal(r.files.length, 1);
    assert.ok(existsSync(join(homeDir, ".codeium", "windsurf", "mcp_config.json")));
    assert.ok(!existsSync(join(projectDir, ".codeium")));
  });

  it("merges the VS Code servers key (not mcpServers) for copilot", () => {
    const [r] = initTools(["copilot"], opts());
    assert.equal(r.files[0].action, "created");
    const doc = mcpJson(join(projectDir, ".vscode", "mcp.json"));
    assert.equal(doc.servers.greenlight.type, "stdio");
  });

  it("--dry-run reports without writing anything", () => {
    const [r] = initTools(["claude-code"], { ...opts(), dryRun: true });
    assert.equal(r.files[0].action, "created");
    assert.ok(!existsSync(join(projectDir, ".mcp.json")));
    assert.ok(!existsSync(join(projectDir, "CLAUDE.md")));
  });

  it("unknown tools fail before writing, naming --list", () => {
    assert.throws(() => initTools(["nope"], opts()), /--list/);
    assert.ok(!existsSync(join(projectDir, ".mcp.json")));
  });

  it("parseAgentList splits commas, lowercases, and dedupes", () => {
    assert.deepEqual(parseAgentList(["Cursor, cline", "CURSOR", " copilot "]), [
      "cursor",
      "cline",
      "copilot",
    ]);
  });

  it("detectTools spots marker files already in the project", () => {
    mkdirSync(join(projectDir, ".cursor"), { recursive: true });
    writeFileSync(join(projectDir, "CLAUDE.md"), "# hi\n", "utf8");
    assert.deepEqual(detectTools(projectDir).sort(), ["claude-code", "cursor"]);
    assert.ok(findTool("generic"), "generic fallback exists");
  });
});
