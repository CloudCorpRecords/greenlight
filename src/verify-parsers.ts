/**
 * Test-output parsers for `greenlight verify`.
 *
 * The delta (base vs head) is only honest if it is derived from parsed
 * test identities, never from raw log lines. Each parser turns one
 * runner's output into the same shape: named passing tests and named
 * failing tests. Runners slot in by implementing TestRunnerParser; the
 * pipeline picks the first parser whose canParse matches the test
 * command.
 */
export interface ParsedTests {
  passed: string[];
  failed: string[];
}

export interface TestRunnerParser {
  /** Human name, e.g. "node:test". */
  name: string;
  /** True when this parser claims the given test command. */
  canParse(command: string): boolean;
  /** Parse one full run's stdout+stderr. */
  parse(output: string): ParsedTests;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

const nodeTest: TestRunnerParser = {
  name: "node:test",
  canParse: (cmd) => /(^|\s)(node\s+--test|tsx?\s+--test)/.test(cmd) || /\bvitest\b/.test(cmd),
  parse(output) {
    const passed: string[] = [];
    const failed: string[] = [];
    for (const line of output.split("\n")) {
      // node --test: "✔ name (1.23ms)" / "✖ name (1.23ms)"; leading spaces ok.
      // The summary headers "✖ failing tests:" / "✔ passing tests:" are not
      // tests (the live greenlight-verify run on 2026-10-16 caught "failing
      // tests:" being counted as a failure).
      const ok = /^\s*✔\s+(.+?)(?:\s+\(\d[\d.,]*m?s\))?\s*$/.exec(line);
      if (ok && !/^(passing|failing) tests:?$/i.test(ok[1].trim())) {
        passed.push(ok[1].trim());
        continue;
      }
      const bad = /^\s*✖\s+(.+?)(?:\s+\(\d[\d.,]*m?s\))?\s*$/.exec(line);
      if (bad && !/^(passing|failing) tests:?$/i.test(bad[1].trim())) {
        failed.push(bad[1].trim());
        continue;
      }
      // vitest run: "✓ src/foo.test.ts (3 tests)" is file-level; real
      // per-test lines come from node --test above. Skip to avoid mixing
      // granularities.
    }
    return { passed: dedupe(passed), failed: dedupe(failed) };
  },
};

const pytest: TestRunnerParser = {
  name: "pytest",
  canParse: (cmd) => /(^|\s)pytest(\s|$)/.test(cmd),
  parse(output) {
    const passed: string[] = [];
    const failed: string[] = [];
    for (const line of output.split("\n")) {
      // -v output: "tests/x.py::TestY::test_z PASSED" / FAILED / ERROR
      const m = /^(\S+::\S+)\s+(PASSED|FAILED|ERROR)\b/.exec(line.trim());
      if (!m) continue;
      if (m[2] === "PASSED") passed.push(m[1]);
      else failed.push(m[1]);
    }
    return { passed: dedupe(passed), failed: dedupe(failed) };
  },
};

export const RUNNER_PARSERS: TestRunnerParser[] = [nodeTest, pytest];

/** Pick the parser for a test command, or null when none claims it. */
export function parserForCommand(command: string): TestRunnerParser | null {
  return RUNNER_PARSERS.find((p) => p.canParse(command)) ?? null;
}
