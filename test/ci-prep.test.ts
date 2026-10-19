/**
 * Tests for CI Pre-flight (greenlight ci-prep).
 *
 * Fixture style: real scratch checkouts (tmp dirs + git) so discovery,
 * mapping, execution, and convention checks run against the real code
 * paths. Workflow YAML fixtures exercise the subset parser; the honesty
 * rule under test everywhere: a check is PASS only when it ran, FAIL only
 * on evidence, otherwise SKIPPED with a named reason.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorkflowYaml,
  triggersOnPullRequest,
  discoverWorkflows,
  mapRunStep,
  mapUsesStep,
  isPushOnlyCondition,
  runCiPrep,
  renderCiPrepMarkdown,
  formatCiPrepHuman,
  type CiPrepCheck,
} from "../src/ci-prep.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "greenlight-ciprep-"));
  dirs.push(d);
  return d;
}

function gitInit(d: string): void {
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: d });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: d });
}

function commitAll(d: string, msg: string, signoff = false): string {
  execFileSync("git", ["add", "-A"], { cwd: d });
  const args = ["commit", "-q", "-m", msg];
  if (signoff) args.push("--signoff");
  execFileSync("git", args, { cwd: d });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
}

function writeWorkflow(d: string, name: string, body: string): void {
  const wf = join(d, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, name), body);
}

function statusOf(checks: CiPrepCheck[], substr: string): string {
  const c = checks.find((x) => x.name.includes(substr));
  assert.ok(c, `expected a check matching ${substr}; got ${checks.map((x) => x.name).join(" | ")}`);
  return c.status;
}

// ---------------------------------------------------------------------------
// YAML subset parser + trigger detection
// ---------------------------------------------------------------------------

describe("workflow YAML subset parser", () => {
  it("parses on: scalar, flow list, and mapping forms", () => {
    assert.equal(triggersOnPullRequest(parseWorkflowYaml("on: pull_request\njobs: {}\n")), true);
    assert.equal(triggersOnPullRequest(parseWorkflowYaml("on: [push, pull_request]\njobs: {}\n")), true);
    assert.equal(triggersOnPullRequest(parseWorkflowYaml("on:\n  pull_request:\n    branches: [main]\njobs: {}\n")), true);
    assert.equal(triggersOnPullRequest(parseWorkflowYaml("on:\n  pull_request_target:\n    types: [opened]\njobs: {}\n")), true);
    assert.equal(triggersOnPullRequest(parseWorkflowYaml("on: push\njobs: {}\n")), false);
    assert.equal(triggersOnPullRequest(parseWorkflowYaml("jobs: {}\n")), false);
  });

  it("keeps `on` as a string key (no YAML 1.1 boolean trap)", () => {
    const doc = parseWorkflowYaml("on: pull_request\n");
    assert.ok("on" in doc, "key is the string 'on'");
    assert.ok(!("true" in doc), "key is not boolean true");
  });

  it("parses jobs, steps, block scalars, and nested maps", () => {
    const doc = parseWorkflowYaml(
      [
        "on: pull_request",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    strategy:",
        "      matrix:",
        "        node: [18, 20]",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - name: run tests",
        "        run: |",
        "          npm test",
        "          npm run lint",
        "      - name: setup",
        "        uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 20",
        "",
      ].join("\n"),
    );
    const jobs = (doc["jobs"] as Record<string, unknown>)["test"] as Record<string, unknown>;
    const steps = jobs["steps"] as Array<Record<string, unknown>>;
    assert.equal(steps.length, 3);
    assert.equal(steps[0]["uses"], "actions/checkout@v4");
    assert.equal(steps[1]["name"], "run tests");
    assert.equal(steps[1]["run"], "npm test\nnpm run lint");
    assert.equal((jobs["strategy"] as Record<string, unknown>)["matrix"] !== undefined, true);
  });

  it("a structurally broken workflow throws instead of guessing", () => {
    assert.throws(() => parseWorkflowYaml("jobs:\n- orphan: 1\nnot a mapping at all\n  : : :\n"));
  });
});

// ---------------------------------------------------------------------------
// Step mapping
// ---------------------------------------------------------------------------

describe("step mapping", () => {
  it("executes plain package-script steps", () => {
    assert.deepEqual(mapRunStep("npm test"), { kind: "execute", script: "npm test" });
    assert.deepEqual(mapRunStep("npm run lint && npm run build"), { kind: "execute", script: "npm run lint && npm run build" });
    assert.deepEqual(mapRunStep("pnpm typecheck"), { kind: "execute", script: "pnpm typecheck" });
    assert.deepEqual(mapRunStep("prettier --check ."), { kind: "execute", script: "prettier --check ." });
  });

  it("skips secrets, publishes, and deploys with named reasons", () => {
    assert.equal(mapRunStep("echo ${{ secrets.NPM_TOKEN }} | npm login").kind, "skip");
    assert.ok((mapRunStep("npm publish --access public") as { reason: string }).reason.includes("publish"));
    assert.ok((mapRunStep("npm run deploy") as { reason: string }).reason.includes("deploy"));
    assert.ok((mapRunStep("run: docker push img") as { reason: string }).reason.length > 0);
  });

  it("skips unmapped steps conservatively, never passes them", () => {
    const m = mapRunStep("./scripts/mystery.sh --frobnicate");
    assert.equal(m.kind, "skip");
    assert.ok((m as { reason: string }).reason.includes("conservative"));
  });

  it("maps actions/* steps to skips with reasons", () => {
    assert.ok((mapUsesStep("actions/checkout@v4") as { reason: string }).reason.includes("checkout"));
    assert.ok((mapUsesStep("actions/setup-node@v4") as { reason: string }).reason.includes("toolchain"));
    assert.ok((mapUsesStep("someone/deploy-action@v1") as { reason: string }).reason.includes("cannot run locally"));
  });

  it("detects push-only if: conditions", () => {
    assert.equal(isPushOnlyCondition("github.ref == 'refs/heads/main'"), true);
    assert.equal(isPushOnlyCondition('github.event_name == \'pull_request\''), false);
  });
});

// ---------------------------------------------------------------------------
// End to end: node repo fixture
// ---------------------------------------------------------------------------

const NODE_WORKFLOW = `on: pull_request
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: tests
        run: npm test
      - name: lint
        run: npm run lint
      - name: publish
        run: npm publish --access public
`;

function nodeFixture(): string {
  const d = scratch();
  gitInit(d);
  writeFileSync(
    join(d, "package.json"),
    JSON.stringify({ name: "fx", scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }, null, 2),
  );
  writeWorkflow(d, "ci.yml", NODE_WORKFLOW);
  writeFileSync(join(d, "index.js"), "module.exports = 1;\n");
  commitAll(d, "chore: initial");
  return d;
}

describe("runCiPrep on a node repo", () => {
  it("runs test/lint, skips checkout/setup/publish, verdict GO", async () => {
    const d = nodeFixture();
    const r = await runCiPrep(d, { timeoutSecs: 60 });
    assert.equal(statusOf(r.checks, "tests (workflow ci"), "PASS");
    assert.equal(statusOf(r.checks, "lint (workflow ci"), "PASS");
    const pub = r.checks.find((c) => c.name.includes("publish"));
    assert.ok(pub && pub.status === "SKIPPED", "publish step is SKIPPED, never PASS");
    assert.ok(pub.detail.includes("publish"));
    assert.equal(statusOf(r.checks, "actions/checkout"), "SKIPPED");
    assert.equal(r.verdict, "GO");
    assert.ok(r.markdown.includes("Verdict: GO"));
  });

  it("a failing test step makes the verdict NO-GO with evidence", async () => {
    const d = nodeFixture();
    writeFileSync(
      join(d, "package.json"),
      JSON.stringify({ name: "fx", scripts: { test: 'node -e "process.exit(3)"', lint: 'node -e "process.exit(0)"' } }, null, 2),
    );
    const r = await runCiPrep(d, { timeoutSecs: 60 });
    const t = r.checks.find((c) => c.name.includes("tests (workflow ci"));
    assert.ok(t && t.status === "FAIL");
    assert.ok(t.detail.includes("exit 3"));
    assert.equal(r.verdict, "NO-GO");
  });

  it("no workflows: nothing to run, GO with a note", async () => {
    const d = scratch();
    gitInit(d);
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "node -e 1" } }));
    commitAll(d, "chore: initial");
    const r = await runCiPrep(d);
    assert.equal(statusOf(r.checks, "discover"), "SKIPPED");
    assert.ok(r.checks[0].detail.includes("nothing to run"));
    assert.equal(r.verdict, "GO");
  });

  it("missing directory is a NO-GO with a named check", async () => {
    const r = await runCiPrep(join(tmpdir(), "greenlight-ciprep-nope-12345"));
    assert.equal(r.verdict, "NO-GO");
    assert.equal(r.checks[0].status, "FAIL");
  });
});

// ---------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------

function changesetFixture(withChangeset: boolean): { dir: string; base: string } {
  const d = scratch();
  gitInit(d);
  mkdirSync(join(d, ".changeset"), { recursive: true });
  writeFileSync(join(d, ".changeset", "config.json"), "{}");
  writeFileSync(join(d, "CONTRIBUTING.md"), "# Contributing\n\nPlease add a changeset for user-facing changes.\n");
  writeWorkflow(d, "ci.yml", "on: pull_request\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - name: changeset check\n        run: npm test\n");
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "index.js"), "1\n");
  commitAll(d, "chore: initial");
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  writeFileSync(join(d, "src", "index.js"), "2\n");
  if (withChangeset) writeFileSync(join(d, ".changeset", "nice-change.md"), "---\n'fx': patch\n---\n\nFix.\n");
  commitAll(d, "fix: change behavior");
  return { dir: d, base };
}

describe("changeset convention", () => {
  it("FAILs when source changes lack a changeset", async () => {
    const { dir, base } = changesetFixture(false);
    const r = await runCiPrep(dir, { base, timeoutSecs: 60 });
    const c = r.checks.find((x) => x.name.includes("changesets"));
    assert.ok(c && c.status === "FAIL", `expected FAIL, got ${c?.status}: ${c?.detail}`);
    assert.ok(c.detail.includes(".changeset"));
    assert.equal(r.verdict, "NO-GO");
  });

  it("PASSes when a changeset is added", async () => {
    const { dir, base } = changesetFixture(true);
    const r = await runCiPrep(dir, { base, timeoutSecs: 60 });
    assert.equal(statusOf(r.checks, "changesets"), "PASS");
  });

  it("SKIPs when the repo has no changeset convention", async () => {
    const d = nodeFixture();
    const r = await runCiPrep(d, { timeoutSecs: 60 });
    assert.equal(statusOf(r.checks, "changesets"), "SKIPPED");
  });
});

function commitlintFixture(): { dir: string; base: string } {
  const d = scratch();
  gitInit(d);
  writeFileSync(join(d, "commitlint.config.js"), "module.exports = {};\n");
  writeFileSync(join(d, "a.txt"), "1\n");
  commitAll(d, "chore: initial");
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  writeFileSync(join(d, "a.txt"), "2\n");
  commitAll(d, "fix: a proper subject");
  writeFileSync(join(d, "a.txt"), "3\n");
  commitAll(d, "oops forgot the format");
  return { dir: d, base };
}

describe("commit-format convention", () => {
  it("FAILs on non-conventional subjects and names them", async () => {
    const { dir, base } = commitlintFixture();
    const r = await runCiPrep(dir, { base, timeoutSecs: 60 });
    const c = r.checks.find((x) => x.name.includes("commit format"));
    assert.ok(c && c.status === "FAIL", `expected FAIL, got ${c?.status}`);
    assert.ok(c.detail.includes("oops forgot the format"));
    assert.equal(r.verdict, "NO-GO");
  });

  it("SKIPs when no commit-format convention is signaled", async () => {
    const d = nodeFixture();
    const r = await runCiPrep(d, { timeoutSecs: 60 });
    assert.equal(statusOf(r.checks, "commit format"), "SKIPPED");
  });
});

function dcoFixture(signoff: boolean): { dir: string; base: string } {
  const d = scratch();
  gitInit(d);
  writeFileSync(join(d, "CONTRIBUTING.md"), "# Contributing\n\nAll commits must carry a Signed-off-by line (DCO).\n");
  writeFileSync(join(d, "a.txt"), "1\n");
  commitAll(d, "chore: initial", true);
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  writeFileSync(join(d, "a.txt"), "2\n");
  commitAll(d, "fix: something", signoff);
  return { dir: d, base };
}

describe("DCO convention", () => {
  it("FAILs when a commit lacks Signed-off-by", async () => {
    const { dir, base } = dcoFixture(false);
    const r = await runCiPrep(dir, { base, timeoutSecs: 60 });
    const c = r.checks.find((x) => x.name.includes("DCO"));
    assert.ok(c && c.status === "FAIL", `expected FAIL, got ${c?.status}: ${c?.detail}`);
    assert.equal(r.verdict, "NO-GO");
  });

  it("PASSes when every commit is signed off", async () => {
    const { dir, base } = dcoFixture(true);
    const r = await runCiPrep(dir, { base, timeoutSecs: 60 });
    assert.equal(statusOf(r.checks, "DCO"), "PASS");
  });

  it("SKIPs when base equals HEAD (no commits in range)", async () => {
    const { dir } = dcoFixture(true);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const r = await runCiPrep(dir, { base: head, timeoutSecs: 60 });
    const c = r.checks.find((x) => x.name.includes("DCO"));
    assert.ok(c && c.status === "SKIPPED");
    assert.ok(c.detail.includes("no commits"));
  });
});

// ---------------------------------------------------------------------------
// act mode
// ---------------------------------------------------------------------------

describe("act mode", () => {
  it("reports unavailable and falls back to native when act/docker are missing", async () => {
    const d = nodeFixture();
    const r = await runCiPrep(d, { timeoutSecs: 60, useAct: true, actAvailable: false });
    assert.equal(r.actMode, "unavailable");
    const a = r.checks.find((c) => c.name === "act");
    assert.ok(a && a.status === "SKIPPED");
    assert.ok(a.detail.includes("fell back to native"));
    // Native checks still ran.
    assert.equal(statusOf(r.checks, "tests (workflow ci"), "PASS");
  });

  it("not-requested by default", async () => {
    const d = nodeFixture();
    const r = await runCiPrep(d, { timeoutSecs: 60 });
    assert.equal(r.actMode, "not-requested");
    assert.ok(!r.checks.some((c) => c.name === "act"));
  });
});

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

describe("output", () => {
  it("markdown and human formats carry every check and the verdict", async () => {
    const d = nodeFixture();
    const r = await runCiPrep(d, { timeoutSecs: 60 });
    const md = renderCiPrepMarkdown(r);
    assert.ok(md.includes("## CI pre-flight"));
    assert.ok(md.includes("**PASS**"));
    assert.ok(md.includes("**SKIPPED**"));
    assert.ok(md.includes("Verdict: GO"));
    const human = formatCiPrepHuman(r);
    assert.ok(human.includes("[PASS]"));
    assert.ok(human.includes("Verdict: GO"));
  });

  it("result JSON-serializes cleanly", async () => {
    const d = nodeFixture();
    const r = await runCiPrep(d, { timeoutSecs: 60 });
    const parsed = JSON.parse(JSON.stringify(r)) as typeof r;
    assert.equal(parsed.verdict, "GO");
    assert.ok(Array.isArray(parsed.checks));
  });

  it("an unrunnable deploy step is SKIPPED, never PASS, in the full run", async () => {
    const d = scratch();
    gitInit(d);
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    writeWorkflow(d, "release.yml", "on: pull_request\njobs:\n  rel:\n    runs-on: ubuntu-latest\n    steps:\n      - name: ship it\n        run: npm publish --access public\n");
    writeFileSync(join(d, "index.js"), "1\n");
    commitAll(d, "chore: initial");
    const r = await runCiPrep(d, { timeoutSecs: 60 });
    assert.ok(!r.checks.some((c) => c.status === "PASS" && c.name.includes("ship it")), "deploy step must not PASS");
    assert.equal(statusOf(r.checks, "ship it"), "SKIPPED");
    assert.equal(r.verdict, "GO");
  });
});
