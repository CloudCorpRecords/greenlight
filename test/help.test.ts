import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMANDS,
  NEEDS_TARGET,
  findCommand,
  overviewText,
  commandHelpText,
  helpText,
  suggestCommand,
  versionText,
} from "../src/help.js";

describe("greenlight help", () => {
  it("every command has usage, a description, and at least one example", () => {
    assert.ok(COMMANDS.length >= 10, "help covers the full command surface");
    const names = new Set<string>();
    for (const c of COMMANDS) {
      assert.ok(c.name && !names.has(c.name), `unique command name: ${c.name}`);
      names.add(c.name);
      assert.ok(c.usage.includes(c.name), `${c.name} usage names the command`);
      assert.ok(c.description.length > 10, `${c.name} has a description`);
      assert.ok(c.examples.length >= 1, `${c.name} has an example`);
      for (const e of c.examples) {
        assert.ok(e.startsWith("greenlight "), `${c.name} example is runnable: ${e}`);
      }
    }
  });

  it("the overview names every command and the quickstart", () => {
    const text = overviewText();
    for (const c of COMMANDS) {
      assert.ok(text.includes(c.name), `overview names ${c.name}`);
    }
    assert.ok(text.includes("greenlight doctor"), "quickstart starts with doctor");
    assert.ok(text.includes("greenlight help <command>"), "overview points at per-command help");
    assert.ok(text.includes("DRY RUN"), "overview keeps the dry-run warning");
  });

  it("helpText resolves commands and reports unknown ones with a suggestion", () => {
    assert.equal(helpText(), overviewText());
    assert.ok(helpText("check").includes("greenlight check <issue-url>"));
    const unknown = helpText("chek");
    assert.ok(unknown.includes('Unknown command "chek"'));
    assert.ok(unknown.includes('"check"'), "unknown help suggests the real command");
  });

  it("suggestCommand tolerates typos but stays silent on garbage", () => {
    assert.equal(suggestCommand("chek"), "check");
    assert.equal(suggestCommand("frictio"), "friction");
    assert.equal(suggestCommand("doct"), "doctor");
    assert.equal(suggestCommand("zzzqqq"), undefined);
  });

  it("commandHelpText renders usage, flags, and examples", () => {
    const text = commandHelpText(findCommand("init")!);
    assert.ok(text.includes("--agent <tool>"));
    assert.ok(text.includes("--dry-run"));
    assert.ok(text.includes("greenlight init --agent claude-code"));
  });

  it("every missing-argument command has per-command help", () => {
    for (const name of Object.keys(NEEDS_TARGET)) {
      const cmd = findCommand(name);
      assert.ok(cmd, `NEEDS_TARGET key resolves in help: ${name}`);
      assert.ok(commandHelpText(cmd!).includes(`greenlight ${name}`));
    }
  });

  it("versionText matches package.json", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    assert.equal(versionText(), `greenlight ${pkg.version}`);
  });
});

describe("v0.17.1 per-command API budgets (item 21)", () => {
  it("the heavy commands document their API budget in help", () => {
    // Operators plan runs against the shared API budget; the budget
    // line must never silently disappear from a command's help.
    const heavy = ["friction", "check", "scan", "wave", "babysit", "autopilot"];
    for (const name of heavy) {
      const cmd = COMMANDS.find((c) => c.name === name);
      assert.ok(cmd, `help covers ${name}`);
      const text = `${cmd.description} ${cmd.flags.join(" ")}`;
      assert.ok(
        text.includes("API budget"),
        `${name} help documents its API budget`
      );
    }
  });
});
