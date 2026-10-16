/**
 * Honest verify: the red-green runner.
 *
 * `greenlight verify` answers one question with evidence: did my change
 * fix the failing test, break something new, or neither? It runs the
 * repo's test command on a base worktree and on the current tree, parses
 * both runs into test identities with verify-parsers, and reports the
 * DELTA: newly failing (yours), newly passing (fixed), still failing
 * (pre-existing, not yours). Counts come from parsed output, never raw
 * log lines.
 *
 * CLI only, on purpose: this runs test suites on the machine where the
 * code lives, and suites can take minutes. The MCP server is for agents
 * on other machines; the thing that runs your tests belongs in the CLI.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parserForCommand, RUNNER_PARSERS, type TestRunnerParser } from "./verify-parsers.js";

export interface VerifyOptions {
  /** Base ref for the comparison (default: merge-base with upstream, or origin/main). */
  base?: string;
  /** Override the detected test command. */
  cmd?: string;
  /** Override the parser choice (parser name, e.g. "node:test", "pytest"). */
  parser?: string;
  /** Per-run timeout in seconds. */
  timeoutSecs?: number;
  /** Run even when the working tree has uncommitted changes. */
  allowDirty?: boolean;
}

export interface VerifyDelta {
  newlyFailing: string[];
  newlyPassing: string[];
  stillFailing: string[];
  baseTotal: { passed: number; failed: number };
  headTotal: { passed: number; failed: number };
}

export interface VerifyResult {
  ok: boolean;
  /** Machine form of the outcome. */
  outcome: "fixed" | "broke" | "clean" | "no-change" | "unverifiable";
  /** "unverifiable" only: why the comparison could not be made. */
  reason?: string;
  command?: string;
  parser?: string;
  base?: string;
  delta?: VerifyDelta;
  markdown: string;
}

function sh(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function isGitRepo(dir: string): boolean {
  try {
    sh(dir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

function isTreeClean(dir: string): boolean {
  try {
    return sh(dir, ["status", "--porcelain"]).length === 0;
  } catch {
    return false;
  }
}

/**
 * Detect the repo's test command from its manifest files. Returns null
 * when nothing is detectable; the caller must then report unverifiable
 * rather than guess a command.
 */
export function detectTestCommand(dir: string): string | null {
  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      const doc = JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> };
      // Return the script itself, not "npm test": the parser needs to see
      // the real runner (node --test, vitest, pytest) to claim the output.
      if (doc.scripts?.test) return doc.scripts.test;
    } catch {
      // fall through
    }
  }
  if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "pytest.ini")) || existsSync(join(dir, "setup.cfg"))) {
    return "pytest -q";
  }
  if (existsSync(join(dir, "go.mod"))) return "go test ./...";
  if (existsSync(join(dir, "Cargo.toml"))) return "cargo test";
  return null;
}

/** Resolve the default base ref: upstream merge-base, else local origin/main. */
export function defaultBase(dir: string): string | null {
  try {
    const upstream = sh(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    return sh(dir, ["merge-base", "HEAD", upstream]);
  } catch {
    // no upstream tracking
  }
  for (const cand of ["origin/main", "origin/master"]) {
    try {
      sh(dir, ["rev-parse", "--verify", cand]);
      return sh(dir, ["merge-base", "HEAD", cand]);
    } catch {
      // try next
    }
  }
  return null;
}

interface RunOutcome {
  output: string;
  exitCode: number;
  timedOut: boolean;
  spawnFailed: boolean;
}

/** Run a shell command in dir with a timeout, capturing merged output. */
function runCommand(dir: string, command: string, timeoutMs: number): RunOutcome {
  try {
    const r = spawnSync("sh", ["-c", command], {
      cwd: dir,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) {
      const err = r.error as NodeJS.ErrnoException & { killed?: boolean };
      if (err.code === "ENOENT") return { output: "", exitCode: -1, timedOut: false, spawnFailed: true };
      if (err.killed) return { output: (r.stdout as string) + (r.stderr as string), exitCode: -1, timedOut: true, spawnFailed: false };
      return { output: String(err.message), exitCode: -1, timedOut: false, spawnFailed: true };
    }
    return {
      output: ((r.stdout as string) ?? "") + ((r.stderr as string) ?? ""),
      exitCode: r.status ?? -1,
      timedOut: false,
      spawnFailed: false,
    };
  } catch (err) {
    return { output: String(err), exitCode: -1, timedOut: false, spawnFailed: true };
  }
}

function deltaOf(baseFailed: string[], headFailed: string[]): VerifyDelta {
  const b = new Set(baseFailed);
  const h = new Set(headFailed);
  return {
    newlyFailing: [...h].filter((t) => !b.has(t)),
    newlyPassing: [...b].filter((t) => !h.has(t)),
    stillFailing: [...h].filter((t) => b.has(t)),
    baseTotal: { passed: 0, failed: baseFailed.length },
    headTotal: { passed: 0, failed: headFailed.length },
  };
}

export function renderVerifyMarkdown(r: VerifyResult): string {
  if (r.outcome === "unverifiable") {
    return `## Verify: unverifiable\n\n${r.reason ?? "no reason given"}\n`;
  }
  const d = r.delta!;
  const lines = [
    `## Verify: base \`${r.base}\` vs working tree`,
    ``,
    `Test command: \`${r.command}\` (parsed with ${r.parser})`,
    `Base: ${d.baseTotal.failed} failing | Head: ${d.headTotal.failed} failing`,
    ``,
  ];
  if (d.newlyPassing.length > 0) {
    lines.push(`### Fixed by your change (${d.newlyPassing.length})`);
    for (const t of d.newlyPassing) lines.push(`- ${t}`);
    lines.push(``);
  }
  if (d.newlyFailing.length > 0) {
    lines.push(`### Newly failing: these are yours (${d.newlyFailing.length})`);
    for (const t of d.newlyFailing) lines.push(`- ${t}`);
    lines.push(``);
  }
  if (d.stillFailing.length > 0) {
    lines.push(`### Still failing: pre-existing, not yours (${d.stillFailing.length})`);
    for (const t of d.stillFailing) lines.push(`- ${t}`);
    lines.push(``);
  }
  if (d.newlyPassing.length === 0 && d.newlyFailing.length === 0 && d.stillFailing.length === 0) {
    lines.push(`No failing tests on either side; nothing to report.`);
  }
  return lines.join("\n");
}

/**
 * Run the red-green comparison. All failure paths are explicit: this
 * function would rather say "unverifiable" with a reason than report a
 * delta it cannot defend.
 */
export function verifyRepo(dir: string, opts: VerifyOptions = {}): VerifyResult {
  const timeoutMs = (opts.timeoutSecs ?? 600) * 1000;

  if (!isGitRepo(dir)) {
    return { ok: false, outcome: "unverifiable", reason: `${dir} is not a git repository`, markdown: "" };
  }
  if (!opts.allowDirty && !isTreeClean(dir)) {
    return {
      ok: false,
      outcome: "unverifiable",
      reason:
        "working tree has uncommitted changes; commit or stash first, or re-run with --allow-dirty (the head run will then include your uncommitted changes)",
      markdown: "",
    };
  }
  const base = opts.base ?? defaultBase(dir);
  if (!base) {
    return {
      ok: false,
      outcome: "unverifiable",
      reason:
        "could not determine a base ref (no upstream tracking branch, no local origin/main); pass --base <ref>",
      markdown: "",
    };
  }
  const command = opts.cmd ?? detectTestCommand(dir);
  if (!command) {
    return {
      ok: false,
      outcome: "unverifiable",
      reason: "no test command detected (checked package.json scripts.test, pytest, go, cargo); pass --cmd \"<test command>\"",
      markdown: "",
    };
  }
  const parser: TestRunnerParser | null = opts.parser
    ? (RUNNER_PARSERS.find((p) => p.name === opts.parser) ?? null)
    : parserForCommand(command);
  if (!parser) {
    return {
      ok: false,
      outcome: "unverifiable",
      reason: `no output parser claims "${command}" (parsers: ${["node:test", "pytest"].join(", ")}); pass --cmd with a supported runner`,
      markdown: "",
    };
  }

  // Base runs in a detached temp worktree so the working tree is never
  // touched. Removed afterwards even on failure.
  const baseDir = mkdtempSync(join(tmpdir(), "greenlight-verify-base-"));
  try {
    try {
      sh(dir, ["worktree", "add", "--detach", baseDir, base]);
    } catch (err) {
      return { ok: false, outcome: "unverifiable", reason: `could not create base worktree: ${err instanceof Error ? err.message : String(err)}`, markdown: "" };
    }
    const baseRun = runCommand(baseDir, command, timeoutMs);
    const headRun = runCommand(dir, command, timeoutMs);

    for (const [name, run] of [["base", baseRun], ["head", headRun]] as const) {
      if (run.spawnFailed) {
        return { ok: false, outcome: "unverifiable", reason: `could not run the test command on ${name}: ${run.output || "spawn failed"}`, markdown: "" };
      }
      if (run.timedOut) {
        return { ok: false, outcome: "unverifiable", reason: `test command timed out on ${name} after ${opts.timeoutSecs ?? 600}s`, markdown: "" };
      }
    }

    const baseParsed = parser.parse(baseRun.output);
    const headParsed = parser.parse(headRun.output);
    if (baseParsed.passed.length + baseParsed.failed.length === 0 || headParsed.passed.length + headParsed.failed.length === 0) {
      return {
        ok: false,
        outcome: "unverifiable",
        reason: `parsed zero tests from the ${parser.name} output (base: ${baseParsed.passed.length + baseParsed.failed.length}, head: ${headParsed.passed.length + headParsed.failed.length}); the parser may not understand this runner's output format`,
        markdown: "",
      };
    }

    const delta = deltaOf(baseParsed.failed, headParsed.failed);
    delta.baseTotal = { passed: baseParsed.passed.length, failed: baseParsed.failed.length };
    delta.headTotal = { passed: headParsed.passed.length, failed: headParsed.failed.length };

    const outcome: VerifyResult["outcome"] =
      delta.newlyFailing.length > 0
        ? "broke"
        : delta.newlyPassing.length > 0
          ? "fixed"
          : delta.stillFailing.length > 0
            ? "no-change"
            : "clean";
    const result: VerifyResult = {
      ok: true,
      outcome,
      command,
      parser: parser.name,
      base,
      delta,
      markdown: "",
    };
    result.markdown = renderVerifyMarkdown(result);
    return result;
  } finally {
    try {
      sh(dir, ["worktree", "remove", "--force", baseDir]);
    } catch {
      try {
        rmSync(baseDir, { recursive: true, force: true });
      } catch {
        // best effort; a stale worktree dir is cleaned by git gc
      }
    }
  }
}
