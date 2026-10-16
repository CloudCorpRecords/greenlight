import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parserForCommand } from "../src/verify-parsers.js";
import { detectTestCommand, verifyRepo, defaultBase } from "../src/verify.js";

const NODE_TEST_OUTPUT = `
✔ flattens arrays (2.15ms)
✖ rejects nulls (3.01ms)
✔ sorts keys (0.98ms)
ℹ tests 3
ℹ suites 1
ℹ pass 2
ℹ fail 1
`;

const PYTEST_OUTPUT = `
tests/test_math.py::TestAdd::test_basic PASSED
tests/test_math.py::TestAdd::test_zero FAILED
tests/test_math.py::TestAdd::test_negative ERROR
`;

describe("runner parsers", () => {
  it("node --test: picks passing and failing names", () => {
    const p = parserForCommand("node --test")!;
    assert.equal(p.name, "node:test");
    const r = p.parse(NODE_TEST_OUTPUT);
    assert.deepEqual([...r.passed].sort(), ["flattens arrays", "sorts keys"]);
    assert.deepEqual(r.failed, ["rejects nulls"]);
  });

  it("a package.json test script of node --test is claimed by the node:test parser", () => {
    assert.equal(parserForCommand("node --test test/*.test.ts")!.name, "node:test");
  });

  it("pytest: picks PASSED vs FAILED/ERROR", () => {
    const p = parserForCommand("pytest -q")!;
    assert.equal(p.name, "pytest");
    const r = p.parse(PYTEST_OUTPUT);
    assert.deepEqual(r.passed, ["tests/test_math.py::TestAdd::test_basic"]);
    assert.deepEqual([...r.failed].sort(), [
      "tests/test_math.py::TestAdd::test_negative",
      "tests/test_math.py::TestAdd::test_zero",
    ]);
  });

  it("unknown commands get no parser", () => {
    assert.equal(parserForCommand("bundle exec rspec"), null);
  });

  it("garbage output parses to zero tests", () => {
    const r = parserForCommand("node --test")!.parse("hello world\nnothing here\n");
    assert.deepEqual(r.passed, []);
    assert.deepEqual(r.failed, []);
  });
});

describe("detectTestCommand", () => {
  const dir = mkdtempSync(join(tmpdir(), "greenlight-verify-detect-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reads package.json scripts.test", () => {
    const d = mkdtempSync(join(tmpdir(), "greenlight-verify-pkg-"));
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    assert.equal(detectTestCommand(d), "node --test");
    rmSync(d, { recursive: true, force: true });
  });

  it("detects pytest, go, cargo", () => {
    for (const [file, expected] of [
      ["pyproject.toml", "pytest -q"],
      ["go.mod", "go test ./..."],
      ["Cargo.toml", "cargo test"],
    ] as const) {
      const d = mkdtempSync(join(tmpdir(), "greenlight-verify-lang-"));
      writeFileSync(join(d, file), "x");
      assert.equal(detectTestCommand(d), expected);
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns null when nothing is detectable", () => {
    assert.equal(detectTestCommand(dir), null);
  });
});

/**
 * End-to-end red-green run against tiny scratch git repos. The "test
 * command" is a committed shell script printing canned runner output, so
 * the suite stays fast while the real pipeline (git detection, worktree,
 * both runs, parsing, delta) is exercised for real.
 */
describe("verifyRepo end to end", () => {
  const root = mkdtempSync(join(tmpdir(), "greenlight-verify-e2e-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  const git = (dir: string, ...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root } });

  function makeRepo(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t.t");
    git(dir, "config", "user.name", "t");
    return dir;
  }

  let commitSeq = 0;
  function commitScript(dir: string, failing: string[], extraFailing: string[]) {
    // The script emits node --test style lines. `failing` fails in every
    // commit; `extraFailing` is the per-commit variable set. The sequence
    // comment keeps consecutive identical scripts committable.
    const allFailing = [...failing, ...extraFailing];
    const body = [
      "#!/bin/sh",
      `# checkpoint ${++commitSeq}`,
      `echo "✔ alpha (1.00ms)"`,
      ...allFailing.map((t) => `echo "✖ ${t} (1.00ms)"`),
      `echo "✔ beta (1.00ms)"`,
      allFailing.length > 0 ? "exit 1" : "exit 0",
    ].join("\n");
    writeFileSync(join(dir, "run.sh"), body, { mode: 0o755 });
    git(dir, "add", "run.sh");
    git(dir, "commit", "-qm", "checkpoint");
  }

  it("red on base, green on head: fixed; new failure: yours; old failure on both: pre-existing", () => {
    const dir = makeRepo("delta");
    commitScript(dir, ["gamma-old"], ["gamma-new-base"]);
    const base = git(dir, "rev-parse", "HEAD").trim();
    commitScript(dir, ["gamma-old"], ["gamma-new-head"]);
    const r = verifyRepo(dir, { base, cmd: "sh run.sh", parser: "node:test", timeoutSecs: 30 });
    assert.equal(r.ok, true);
    assert.equal(r.outcome, "broke");
    assert.deepEqual(r.delta!.newlyPassing, ["gamma-new-base"]);
    assert.deepEqual(r.delta!.newlyFailing, ["gamma-new-head"]);
    assert.deepEqual(r.delta!.stillFailing, ["gamma-old"]);
    assert.ok(r.markdown.includes("Fixed by your change"));
    assert.ok(r.markdown.includes("Newly failing: these are yours"));
    assert.ok(r.markdown.includes("pre-existing, not yours"));
  });

  it("everything green on both sides: clean", () => {
    const dir = makeRepo("clean");
    commitScript(dir, [], []);
    const base = git(dir, "rev-parse", "HEAD").trim();
    commitScript(dir, [], []);
    const r = verifyRepo(dir, { base, cmd: "sh run.sh", parser: "node:test", timeoutSecs: 30 });
    assert.equal(r.ok, true);
    assert.equal(r.outcome, "clean");
    assert.ok(r.markdown.includes("No failing tests on either side"));
  });

  it("refuses a dirty tree unless --allow-dirty", () => {
    const dir = makeRepo("dirty");
    commitScript(dir, [], []);
    const base = git(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "uncommitted.txt"), "x");
    const r = verifyRepo(dir, { base, cmd: "sh run.sh", parser: "node:test", timeoutSecs: 30 });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "unverifiable");
    assert.ok(r.reason!.includes("uncommitted changes"));
    const r2 = verifyRepo(dir, { base, cmd: "sh run.sh", parser: "node:test", timeoutSecs: 30, allowDirty: true });
    assert.equal(r2.ok, true);
  });

  it("says unverifiable, not zero, when not a git repo", () => {
    const r = verifyRepo(root, { base: "HEAD", cmd: "sh run.sh", parser: "node:test", timeoutSecs: 30 });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "unverifiable");
    assert.ok(r.reason!.includes("not a git repository"));
  });

  it("says unverifiable when no base is determinable", () => {
    const dir = makeRepo("nobase");
    commitScript(dir, [], []);
    const r = verifyRepo(dir, { cmd: "sh run.sh", parser: "node:test", timeoutSecs: 30 });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "unverifiable");
    assert.ok(r.reason!.includes("--base"));
  });

  it("says unverifiable when no test command is detectable", () => {
    const dir = makeRepo("nocmd");
    commitScript(dir, [], []);
    const base = git(dir, "rev-parse", "HEAD").trim();
    const r = verifyRepo(dir, { base, timeoutSecs: 30 });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "unverifiable");
    assert.ok(r.reason!.includes("--cmd"));
  });

  it("says unverifiable when the parser yields zero tests", () => {
    const dir = makeRepo("noparse");
    writeFileSync(join(dir, "run.sh"), '#!/bin/sh\necho "hello world"\nexit 0\n', { mode: 0o755 });
    git(dir, "add", "run.sh");
    git(dir, "commit", "-qm", "checkpoint");
    const base = git(dir, "rev-parse", "HEAD").trim();
    const r = verifyRepo(dir, { base, cmd: "sh run.sh", parser: "node:test", timeoutSecs: 30 });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "unverifiable");
    assert.ok(r.reason!.includes("parsed zero tests"));
  });

  it("defaultBase falls back to a local origin/main", () => {
    const origin = makeRepo("originrepo");
    commitScript(origin, [], []);
    const clone = join(root, "clone");
    execFileSync("git", ["clone", "-q", origin, clone], { encoding: "utf8" });
    execFileSync("git", ["-C", clone, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", clone, "config", "user.name", "t"]);
    const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(defaultBase(clone), head);
  });
});
