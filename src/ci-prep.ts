/**
 * CI Pre-flight (`greenlight ci-prep` / MCP `ci_prep`).
 *
 * Answers one question with evidence, BEFORE a PR is pushed: would this
 * repo's own pull_request workflows pass on the current tree?
 *
 * Pipeline:
 *   1. DISCOVER: parse .github/workflows/*.yml for workflows triggered on
 *      pull_request / pull_request_target; extract jobs and steps.
 *   2. MAP + RUN (native mode): translate each step into a local check.
 *      Steps that map to package scripts or common binaries (test, lint,
 *      typecheck, build) are EXECUTED with a per-step timeout. Steps that
 *      cannot run locally (deploys, secrets, external services, publishes)
 *      are SKIPPED with the reason named. A check is never reported PASS
 *      unless it actually ran.
 *   3. CONVENTIONS: changeset requirement, conventional-commit subjects,
 *      and DCO sign-off are checked against git history when the repo
 *      signals that it requires them.
 *   4. ACT MODE (--act): when `act` and a working docker daemon are both
 *      present, the discovered PR workflows run through `act` for real;
 *      otherwise the tool says so plainly and falls back to native mode.
 *
 * Honesty contract (same as verify.ts): this would rather say SKIPPED with
 * a reason than report a verdict it cannot defend. Verdict is GO only
 * when zero checks FAIL.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type CiPrepStatus = "PASS" | "FAIL" | "SKIPPED";

export interface CiPrepCheck {
  /** e.g. "test (workflow ci, job build)" or "convention: changesets". */
  name: string;
  kind: "workflow-step" | "convention" | "act";
  status: CiPrepStatus;
  /** One-line evidence: exit code, timing, or the skip reason. */
  detail: string;
  /** Last ~30 lines of captured output when the step was executed. */
  outputTail?: string;
}

export interface CiPrepResult {
  repoDir: string;
  base: string | null;
  verdict: "GO" | "NO-GO";
  actMode: "used" | "unavailable" | "not-requested";
  checks: CiPrepCheck[];
  markdown: string;
}

export interface CiPrepOptions {
  /** Base ref for convention checks (changesets/commits/DCO). */
  base?: string;
  /** Per-step execution timeout in seconds (default 300). */
  timeoutSecs?: number;
  /** Try act+docker; fall back to native mode when unavailable. */
  useAct?: boolean;
  /** Test seam: override the detected package manager. */
  packageManager?: string;
  /** Test seam: override act/docker detection. */
  actAvailable?: boolean;
}

// ---------------------------------------------------------------------------
// Minimal YAML-subset parser for GitHub Actions workflow files.
// ---------------------------------------------------------------------------
// Deliberate scope: workflow files are machine-generated-simple. We need
// `on:` triggers, `jobs.<id>.steps[]` with `name`/`uses`/`run`/
// `working-directory`/`if`, and job-level `strategy.matrix`. Supported:
// 2-space (or any consistent) indentation, `key: value`, `key:` with a
// nested block, `- item` and `- key: value` list items, block scalars
// `|`/`>` with indented content, single/double-quoted scalars, and `#`
// comments outside quotes and outside ${{ }} expressions. Anything exotic
// (anchors, merge keys, flow maps beyond `on: [a, b]`) is out of scope:
// a file we cannot parse yields a SKIPPED check naming the file, never a
// crash and never a guessed verdict.

type YamlNode = string | number | boolean | null | YamlNode[] | { [k: string]: YamlNode };

interface Line {
  indent: number;
  text: string;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let exprDepth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble && exprDepth === 0) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && exprDepth === 0) inDouble = !inDouble;
    else if (!inSingle && !inDouble && line.startsWith("${{", i)) exprDepth++;
    else if (exprDepth > 0 && line.startsWith("}}", i)) exprDepth--;
    else if (ch === "#" && !inSingle && !inDouble && exprDepth === 0) {
      // A `#` starts a comment only when preceded by whitespace or at start.
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw: string): YamlNode {
  const t = raw.trim();
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) {
    const inner = t.slice(1, -1);
    return t[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  // Flow sequence: [a, b, c] — only top-level commas, good enough for `on:`.
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner).map((s) => parseScalar(s) as YamlNode);
  }
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (t === "true" || t === "True" || t === "TRUE") return true;
  if (t === "false" || t === "False" || t === "FALSE") return false;
  return t;
}

function splitFlow(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (!inS && !inD && (ch === "[" || ch === "{")) depth++;
    else if (!inS && !inD && (ch === "]" || ch === "}")) depth--;
    if (ch === "," && depth === 0 && !inS && !inD) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Parse a GitHub Actions workflow file into a plain object tree. Throws on structural problems. */
export function parseWorkflowYaml(text: string): Record<string, YamlNode> {
  const rawLines = text.split("\n");
  const lines: Line[] = [];
  for (const raw of rawLines) {
    if (/^\s*$/.test(raw)) continue;
    const noComment = stripComment(raw);
    if (/^\s*$/.test(noComment)) continue;
    const indent = noComment.length - noComment.trimStart().length;
    lines.push({ indent, text: noComment.trim() });
  }
  if (lines.length === 0) return {};
  if (lines[0].indent !== 0) throw new Error("workflow does not start at indent 0");

  const root: Record<string, YamlNode> = {};
  // Stack of {indent, container} where container is a map or list being filled.
  const stack: Array<{ indent: number; node: YamlNode }> = [{ indent: -1, node: root }];

  const peek = () => stack[stack.length - 1];

  let i = 0;
  while (i < lines.length) {
    const { indent, text: line } = lines[i];

    // Block scalar: `key: |` or `key: >`
    const blockMatch = line.match(/^([^:#]+):\s*([|>])([+-]?)\s*$/);
    if (blockMatch) {
      const key = blockMatch[1].trim();
      const style = blockMatch[2];
      i++;
      const chunks: string[] = [];
      while (i < lines.length && lines[i].indent > indent) {
        chunks.push(lines[i].text);
        i++;
      }
      const value = style === "|" ? chunks.join("\n") : chunks.join(" ");
      while (stack.length > 1 && peek().indent >= indent) stack.pop();
      (peek().node as Record<string, YamlNode>)[key] = value;
      continue;
    }

    // List item
    if (line.startsWith("- ") || line === "-") {
      const itemText = line === "-" ? "" : line.slice(2);
      while (stack.length > 1 && peek().indent >= indent) stack.pop();
      const parent = peek().node;
      if (!Array.isArray(parent)) throw new Error(`list item at indent ${indent} without a list parent`);
      if (itemText === "") {
        const m: Record<string, YamlNode> = {};
        parent.push(m);
        stack.push({ indent, node: m });
      } else if (/^[^:#]+:\s*(\S.*)?$/.test(itemText) && !itemText.startsWith("[") && !itemText.startsWith("{") && !itemText.startsWith('"') && !itemText.startsWith("'")) {
        // `- key: value` — a map entry starting the list item.
        const m: Record<string, YamlNode> = {};
        parent.push(m);
        stack.push({ indent, node: m });
        // Re-process this same line as a map entry inside the new map.
        const colonAt = itemText.indexOf(":");
        const key = itemText.slice(0, colonAt).trim();
        const rest = itemText.slice(colonAt + 1).trim();
        m[key] = rest === "" ? null : parseScalar(rest);
        // The map stays on the stack even when rest is non-empty: deeper-
        // indented lines that follow (e.g. a `run: |` block scalar) belong
        // to this map. The list-item branch pops it when the next `- `
        // arrives at the same indent.
      } else {
        parent.push(parseScalar(itemText));
      }
      i++;
      continue;
    }

    // NOTE: `- key: value` maps are intentionally left on the stack (not
    // popped): deeper-indented lines that follow (e.g. a `run: |` block
    // scalar) belong to that map. The list-item branch pops them when the
    // next `- ` arrives at the same indent.

    // Map entry: `key: value` or `key:`
    const colonAt = line.indexOf(":");
    if (colonAt > 0) {
      const key = line.slice(0, colonAt).trim();
      const rest = line.slice(colonAt + 1).trim();
      while (stack.length > 1 && peek().indent >= indent) stack.pop();
      const parent = peek().node as Record<string, YamlNode>;
      if (rest === "") {
        // Could be a nested map or a list; decide by peeking at the next line.
        const next = lines[i + 1];
        if (next && next.indent > indent && (next.text.startsWith("- ") || next.text === "-")) {
          const arr: YamlNode[] = [];
          parent[key] = arr;
          stack.push({ indent, node: arr });
        } else if (next && next.indent > indent) {
          const m: Record<string, YamlNode> = {};
          parent[key] = m;
          stack.push({ indent, node: m });
        } else {
          parent[key] = null;
        }
      } else {
        parent[key] = parseScalar(rest);
      }
      i++;
      continue;
    }

    throw new Error(`cannot parse workflow line: ${line.slice(0, 80)}`);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface WorkflowStep {
  name: string;
  uses?: string;
  run?: string;
  if?: string;
  workingDirectory?: string;
}

export interface WorkflowJob {
  id: string;
  name: string;
  steps: WorkflowStep[];
  matrix?: string;
}

export interface DiscoveredWorkflow {
  file: string;
  jobs: WorkflowJob[];
  /** Why this workflow was skipped entirely (unparseable, no PR trigger). */
  skipReason?: string;
}

function asRecord(n: YamlNode): Record<string, YamlNode> | null {
  return n !== null && typeof n === "object" && !Array.isArray(n) ? (n as Record<string, YamlNode>) : null;
}

/** Does this workflow run on pull_request / pull_request_target? */
export function triggersOnPullRequest(doc: Record<string, YamlNode>): boolean {
  const on = doc["on"] ?? (doc as Record<string, YamlNode>)["true"]; // never the YAML-1.1 trap here; belt and suspenders
  if (on === undefined || on === null) return false;
  if (typeof on === "string") return on === "pull_request" || on === "pull_request_target";
  if (Array.isArray(on)) return on.some((t) => t === "pull_request" || t === "pull_request_target");
  const rec = asRecord(on);
  if (rec) return "pull_request" in rec || "pull_request_target" in rec;
  return false;
}

function stepsOf(job: Record<string, YamlNode>): WorkflowStep[] {
  const raw = job["steps"];
  if (!Array.isArray(raw)) return [];
  const out: WorkflowStep[] = [];
  for (const s of raw) {
    const r = asRecord(s);
    if (!r) continue;
    out.push({
      name: typeof r["name"] === "string" ? r["name"] : typeof r["uses"] === "string" ? r["uses"] : typeof r["run"] === "string" ? r["run"].split("\n")[0].slice(0, 60) : "step",
      uses: typeof r["uses"] === "string" ? r["uses"] : undefined,
      run: typeof r["run"] === "string" ? r["run"] : undefined,
      if: typeof r["if"] === "string" ? r["if"] : undefined,
      workingDirectory: typeof r["working-directory"] === "string" ? (r["working-directory"] as string) : undefined,
    });
  }
  return out;
}

export function discoverWorkflows(dir: string): DiscoveredWorkflow[] {
  const wfDir = join(dir, ".github", "workflows");
  if (!existsSync(wfDir)) return [];
  const files = readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort();
  const out: DiscoveredWorkflow[] = [];
  for (const file of files) {
    let doc: Record<string, YamlNode>;
    try {
      doc = parseWorkflowYaml(readFileSync(join(wfDir, file), "utf8"));
    } catch (err) {
      out.push({ file, jobs: [], skipReason: `could not parse ${file} (subset YAML parser): ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!triggersOnPullRequest(doc)) {
      out.push({ file, jobs: [], skipReason: `not triggered on pull_request` });
      continue;
    }
    const jobsNode = asRecord(doc["jobs"]);
    const jobs: WorkflowJob[] = [];
    if (jobsNode) {
      for (const [id, jn] of Object.entries(jobsNode)) {
        const jr = asRecord(jn);
        if (!jr) continue;
        const matrixNode = asRecord(jr["strategy"])?.["matrix"];
        jobs.push({
          id,
          name: typeof jr["name"] === "string" ? jr["name"] : id,
          steps: stepsOf(jr),
          matrix: matrixNode !== undefined ? JSON.stringify(matrixNode).slice(0, 120) : undefined,
        });
      }
    }
    out.push({ file, jobs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step mapping: workflow step -> local check
// ---------------------------------------------------------------------------

const UNRUNNABLE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\$\{\{\s*secrets\./, reason: "needs GitHub secrets" },
  { re: /\bsecrets\.[A-Z_]+/, reason: "needs GitHub secrets" },
  { re: /\b(npm|pnpm|yarn|bun)\s+publish\b/, reason: "publishes a package" },
  { re: /\bpublish\s+--access\b/, reason: "publishes a package" },
  { re: /\btwine\s+upload\b/, reason: "publishes a package" },
  { re: /\bcargo\s+publish\b/, reason: "publishes a package" },
  { re: /\bdeploy\b/i, reason: "deploys somewhere" },
  { re: /\bgh\s+release\b/, reason: "creates a GitHub release" },
  { re: /\bdocker\s+(push|login)\b/, reason: "needs a container registry" },
  { re: /\b(aws|gcloud|az|terraform|kubectl)\s+(apply|destroy|deploy|push|login)/, reason: "needs cloud credentials" },
  { re: /\b(ssh|scp)\s+/, reason: "needs remote access" },
  { re: /\bnpm\s+login\b/, reason: "needs registry credentials" },
  { re: /\bgoreleaser\b/, reason: "release automation" },
];

/** Shell commands we are willing to execute locally. */
const SAFE_RUN_RE =
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|lint|typecheck|tsc|build|check|checks|format|format:check|verify|ci)\b/;

const SAFE_BIN_RE = /^(npx|pnpm dlx|yarn dlx|bunx)\s+(tsc|eslint|prettier|vitest|jest)\b/;

const SAFE_BARE_RE = /^((tsc|eslint)(\s|$)|prettier\s+--(check|list-different)\b)/;

export type StepMapping =
  | { kind: "execute"; script: string }
  | { kind: "skip"; reason: string };

function splitCommands(script: string): string[] {
  return script
    .split("\n")
    .flatMap((l) => l.split("&&"))
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

/**
 * Decide what to do with a `run:` step. Conservative by design: anything
 * that is not clearly a local test/lint/build invocation, or that touches
 * secrets/publishes/deploys, becomes SKIPPED with a named reason.
 */
export function mapRunStep(script: string): StepMapping {
  for (const { re, reason } of UNRUNNABLE_PATTERNS) {
    if (re.test(script)) return { kind: "skip", reason };
  }
  const cmds = splitCommands(script);
  if (cmds.length === 0) return { kind: "skip", reason: "empty run script" };
  const allSafe = cmds.every((c) => SAFE_RUN_RE.test(c) || SAFE_BIN_RE.test(c) || SAFE_BARE_RE.test(c));
  if (allSafe) return { kind: "execute", script };
  return { kind: "skip", reason: "no local mapping for this step (conservative)" };
}

const USES_SKIP_REASONS: Array<{ re: RegExp; reason: string }> = [
  { re: /^actions\/checkout@/, reason: "checkout: the working tree is the checkout" },
  { re: /^actions\/setup-(node|python|go|java|dotnet|ruby|rust)@/, reason: "toolchain setup: assumed present locally" },
  { re: /^actions\/(cache|upload-artifact|download-artifact|setup-nix)@/, reason: "CI plumbing: not applicable locally" },
];

export function mapUsesStep(uses: string): StepMapping {
  for (const { re, reason } of USES_SKIP_REASONS) {
    if (re.test(uses)) return { kind: "skip", reason };
  }
  return { kind: "skip", reason: `action ${uses} cannot run locally` };
}

/** Push-only / main-only `if:` conditions make a step irrelevant to PRs. */
export function isPushOnlyCondition(ifExpr: string): boolean {
  return /github\.ref\s*==\s*['"]refs\/heads\/(main|master)['"]/.test(ifExpr) && !/pull_request/i.test(ifExpr);
}

// ---------------------------------------------------------------------------
// Local execution
// ---------------------------------------------------------------------------

export function detectPackageManager(dir: string, override?: string): string | null {
  if (override) return override;
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  if (existsSync(join(dir, "package.json"))) return "npm";
  return null;
}

interface ExecOutcome {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

function execStep(cwd: string, script: string, timeoutMs: number): ExecOutcome {
  const r = spawnSync("sh", ["-c", script], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: "true" },
  });
  const output = ((r.stdout as string) ?? "") + ((r.stderr as string) ?? "");
  if (r.error) {
    const err = r.error as NodeJS.ErrnoException & { killed?: boolean };
    if (err.killed) return { exitCode: -1, output, timedOut: true };
    return { exitCode: -1, output: output || String(err.message), timedOut: false };
  }
  return { exitCode: r.status ?? -1, output, timedOut: false };
}

function tailLines(output: string, n = 30): string {
  const lines = output.split("\n");
  const tail = lines.slice(-n);
  return tail.join("\n").slice(0, 4000);
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30000 }).trim();
}

function isGitRepo(dir: string): boolean {
  try {
    git(dir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Convention checks
// ---------------------------------------------------------------------------

function readTextIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function workflowText(dir: string): string {
  const wfDir = join(dir, ".github", "workflows");
  if (!existsSync(wfDir)) return "";
  return readdirSync(wfDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => readTextIfExists(join(wfDir, f)) ?? "")
    .join("\n");
}

function changedFiles(dir: string, base: string): string[] | null {
  try {
    const out = git(dir, ["diff", "--name-only", `${base}...HEAD`]);
    // Fall back to two-dot when there is no merge base (e.g. shallow trees).
    const list = out.split("\n").map((s) => s.trim()).filter(Boolean);
    return list;
  } catch {
    try {
      return git(dir, ["diff", "--name-only", `${base}..HEAD`])
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return null;
    }
  }
}

const SOURCE_FILE_RE = /^(packages\/[^/]+\/src\/|src\/|lib\/|app\/)/;
const NON_SOURCE_RE = /(\.md$|\.test\.|__tests__|[/\\]test[s]?[/\\]|\.changeset[/\\])/;

function checkChangesets(dir: string, base: string | null): CiPrepCheck {
  const name = "convention: changesets";
  const hasDir = existsSync(join(dir, ".changeset"));
  const signaled =
    hasDir && (/changeset/i.test(workflowText(dir)) || /changeset/i.test(readTextIfExists(join(dir, "CONTRIBUTING.md")) ?? ""));
  if (!hasDir || !signaled) return { name, kind: "convention", status: "SKIPPED", detail: "no changeset convention detected" };
  if (!base || !isGitRepo(dir)) return { name, kind: "convention", status: "SKIPPED", detail: "no base ref to diff against" };
  const files = changedFiles(dir, base);
  if (files === null) return { name, kind: "convention", status: "SKIPPED", detail: "could not list changed files" };
  const sourceChanged = files.some((f) => SOURCE_FILE_RE.test(f) && !NON_SOURCE_RE.test(f));
  const changesetAdded = files.some((f) => f.startsWith(".changeset/") && f.endsWith(".md") && !f.endsWith(".changeset/README.md"));
  if (sourceChanged && !changesetAdded) {
    return {
      name,
      kind: "convention",
      status: "FAIL",
      detail: `source files changed without a .changeset/*.md entry (${files.filter((f) => SOURCE_FILE_RE.test(f) && !NON_SOURCE_RE.test(f)).slice(0, 5).join(", ")})`,
    };
  }
  return {
    name,
    kind: "convention",
    status: "PASS",
    detail: changesetAdded ? "changeset entry present" : "no source changes in range",
  };
}

const CONVENTIONAL_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?(!)?: \S/;

function commitSubjects(dir: string, base: string): string[] | null {
  try {
    const out = git(dir, ["log", "--format=%s", `${base}..HEAD`]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function checkCommitFormat(dir: string, base: string | null): CiPrepCheck {
  const name = "convention: commit format";
  const wf = workflowText(dir);
  const signaled =
    existsSync(join(dir, "commitlint.config.js")) ||
    existsSync(join(dir, "commitlint.config.cjs")) ||
    existsSync(join(dir, "commitlint.config.mjs")) ||
    existsSync(join(dir, ".commitlintrc")) ||
    existsSync(join(dir, ".commitlintrc.json")) ||
    /commitlint/i.test(wf) ||
    /conventional.?commits/i.test(wf);
  if (!signaled) return { name, kind: "convention", status: "SKIPPED", detail: "no commit-format convention detected" };
  if (!base || !isGitRepo(dir)) return { name, kind: "convention", status: "SKIPPED", detail: "no base ref to list commits" };
  const subjects = commitSubjects(dir, base);
  if (subjects === null) return { name, kind: "convention", status: "SKIPPED", detail: "could not list commits" };
  if (subjects.length === 0) return { name, kind: "convention", status: "SKIPPED", detail: "no commits between base and HEAD" };
  const bad = subjects.filter((s) => !CONVENTIONAL_RE.test(s));
  if (bad.length > 0) {
    return { name, kind: "convention", status: "FAIL", detail: `${bad.length} non-conventional subject(s): ${bad.slice(0, 3).join(" | ")}` };
  }
  return { name, kind: "convention", status: "PASS", detail: `${subjects.length} conventional subject(s)` };
}

function checkDco(dir: string, base: string | null): CiPrepCheck {
  const name = "convention: DCO sign-off";
  const wf = workflowText(dir);
  const contributing = readTextIfExists(join(dir, "CONTRIBUTING.md")) ?? "";
  const signaled = /dco/i.test(wf) || /sign-?off/i.test(contributing) || /\bDCO\b/.test(contributing);
  if (!signaled) return { name, kind: "convention", status: "SKIPPED", detail: "no DCO requirement detected" };
  if (!base || !isGitRepo(dir)) return { name, kind: "convention", status: "SKIPPED", detail: "no base ref to list commits" };
  let entries: string[];
  try {
    entries = git(dir, ["log", "--format=%H%x00%B%x1e", `${base}..HEAD`]).split("");
  } catch {
    return { name, kind: "convention", status: "SKIPPED", detail: "could not list commits" };
  }
  const commits = entries.map((e) => e.split(" ")[0]).filter(Boolean);
  if (commits.length === 0) {
    return { name, kind: "convention", status: "SKIPPED", detail: "no commits between base and HEAD" };
  }
  const missing: string[] = [];
  for (const e of entries) {
    const [sha, body] = e.split(" ");
    if (!sha) continue;
    if (!/^signed-off-by: /im.test(body ?? "")) missing.push(sha.slice(0, 7));
  }
  if (missing.length > 0) {
    return { name, kind: "convention", status: "FAIL", detail: `missing Signed-off-by on: ${missing.slice(0, 5).join(", ")}` };
  }
  return { name, kind: "convention", status: "PASS", detail: "all commits carry Signed-off-by" };
}

// ---------------------------------------------------------------------------
// act mode
// ---------------------------------------------------------------------------

export function actAvailable(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v act"], { encoding: "utf8", timeout: 10000 });
  } catch {
    return false;
  }
  try {
    execFileSync("docker", ["info"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function runAct(dir: string, timeoutMs: number): CiPrepCheck[] {
  const checks: CiPrepCheck[] = [];
  const r = spawnSync("act", ["pull_request", "--no-cache-server"], {
    cwd: dir,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CI: "true" },
  });
  const output = ((r.stdout as string) ?? "") + ((r.stderr as string) ?? "");
  if (r.error) {
    checks.push({
      name: "act: pull_request",
      kind: "act",
      status: "SKIPPED",
      detail: `act failed to start: ${(r.error as Error).message}`,
      outputTail: tailLines(output),
    });
    return checks;
  }
  // act prints lines like: [Build/test]  ✅  Success - Main npm test
  // and a final per-job verdict. Parse job-level success/failure.
  const jobStatus = new Map<string, boolean>();
  for (const line of output.split("\n")) {
    const m = line.match(/\[(.+?)\]\s+(?:✅|❌|✔|✖|Success|Failure)\s*-\s*(.+)/);
    if (m) {
      const job = m[1].trim();
      const ok = /✅|✔|Success/.test(line);
      jobStatus.set(job, (jobStatus.get(job) ?? true) && ok);
    }
  }
  if (jobStatus.size === 0) {
    checks.push({
      name: "act: pull_request",
      kind: "act",
      status: "SKIPPED",
      detail: `act ran but no job results could be parsed (exit ${r.status ?? "?"})`,
      outputTail: tailLines(output),
    });
    return checks;
  }
  for (const [job, ok] of jobStatus) {
    checks.push({
      name: `act: ${job}`,
      kind: "act",
      status: ok ? "PASS" : "FAIL",
      detail: ok ? "act job succeeded" : "act job failed",
      outputTail: tailLines(output),
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function defaultBase(dir: string): string | null {
  if (!isGitRepo(dir)) return null;
  try {
    const upstream = execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15000,
    }).trim();
    return execFileSync("git", ["merge-base", "HEAD", upstream], { cwd: dir, encoding: "utf8", timeout: 15000 }).trim();
  } catch {
    // fall through
  }
  for (const cand of ["origin/main", "origin/master", "main", "master"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", cand], { cwd: dir, encoding: "utf8", timeout: 15000 });
      return execFileSync("git", ["merge-base", "HEAD", cand], { cwd: dir, encoding: "utf8", timeout: 15000 }).trim();
    } catch {
      // try next
    }
  }
  return null;
}

export async function runCiPrep(targetDir: string, opts: CiPrepOptions = {}): Promise<CiPrepResult> {
  const dir = resolve(targetDir);
  const timeoutMs = (opts.timeoutSecs ?? 300) * 1000;
  const checks: CiPrepCheck[] = [];

  if (!existsSync(dir)) {
    const r: CiPrepResult = {
      repoDir: dir,
      base: null,
      verdict: "NO-GO",
      actMode: "not-requested",
      checks: [{ name: "discover", kind: "workflow-step", status: "FAIL", detail: `directory does not exist: ${dir}` }],
      markdown: "## CI pre-flight\n\nDirectory does not exist.\n",
    };
    r.markdown = renderCiPrepMarkdown(r);
    return r;
  }

  const base = opts.base ?? defaultBase(dir);
  let actMode: CiPrepResult["actMode"] = "not-requested";

  if (opts.useAct) {
    const available = opts.actAvailable ?? actAvailable();
    if (available) {
      actMode = "used";
      checks.push(...runAct(dir, Math.max(timeoutMs, 600_000)));
    } else {
      actMode = "unavailable";
      checks.push({
        name: "act",
        kind: "act",
        status: "SKIPPED",
        detail: "act and/or a working docker daemon unavailable; fell back to native mode",
      });
    }
  }

  // Native mode always runs (it is the fallback and the complement).
  const workflows = discoverWorkflows(dir);
  if (workflows.length === 0) {
    checks.push({
      name: "discover",
      kind: "workflow-step",
      status: "SKIPPED",
      detail: "no .github/workflows found: nothing to run",
    });
  }
  for (const wf of workflows) {
    if (wf.skipReason) {
      checks.push({ name: `workflow ${wf.file}`, kind: "workflow-step", status: "SKIPPED", detail: wf.skipReason });
      continue;
    }
    if (wf.jobs.length === 0) {
      checks.push({ name: `workflow ${wf.file}`, kind: "workflow-step", status: "SKIPPED", detail: "PR-triggered but no jobs found" });
      continue;
    }
    for (const job of wf.jobs) {
      for (const step of job.steps) {
        const label = `${step.name} (workflow ${wf.file.replace(/\.ya?ml$/, "")}, job ${job.id}${job.matrix ? `, matrix ${job.matrix}` : ""})`;
        if (step.if && isPushOnlyCondition(step.if)) {
          checks.push({ name: label, kind: "workflow-step", status: "SKIPPED", detail: "push-only condition; not a PR check" });
          continue;
        }
        let mapping: StepMapping;
        if (step.run) mapping = mapRunStep(step.run);
        else if (step.uses) mapping = mapUsesStep(step.uses);
        else mapping = { kind: "skip", reason: "neither run nor uses" };
        if (mapping.kind === "skip") {
          checks.push({ name: label, kind: "workflow-step", status: "SKIPPED", detail: mapping.reason });
          continue;
        }
        const cwd = step.workingDirectory ? join(dir, step.workingDirectory) : dir;
        const started = Date.now();
        const outcome = execStep(cwd, mapping.script, timeoutMs);
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        if (outcome.timedOut) {
          checks.push({ name: label, kind: "workflow-step", status: "FAIL", detail: `timed out after ${timeoutMs / 1000}s`, outputTail: tailLines(outcome.output) });
        } else if (outcome.exitCode !== 0) {
          checks.push({ name: label, kind: "workflow-step", status: "FAIL", detail: `exit ${outcome.exitCode} in ${secs}s`, outputTail: tailLines(outcome.output) });
        } else {
          checks.push({ name: label, kind: "workflow-step", status: "PASS", detail: `exit 0 in ${secs}s`, outputTail: tailLines(outcome.output) });
        }
      }
    }
  }

  // Convention checks run in both modes; they are cheap and high-value.
  checks.push(checkChangesets(dir, base));
  checks.push(checkCommitFormat(dir, base));
  checks.push(checkDco(dir, base));

  const verdict: CiPrepResult["verdict"] = checks.some((c) => c.status === "FAIL") ? "NO-GO" : "GO";
  const result: CiPrepResult = { repoDir: dir, base, verdict, actMode, checks, markdown: "" };
  result.markdown = renderCiPrepMarkdown(result);
  return result;
}

export function renderCiPrepMarkdown(r: CiPrepResult): string {
  const lines = [`## CI pre-flight: ${r.repoDir}`, ``];
  lines.push(`Base: ${r.base ?? "unknown"} | act mode: ${r.actMode}`);
  lines.push(``);
  if (r.checks.length === 0) lines.push(`No checks discovered.`);
  for (const c of r.checks) {
    lines.push(`- **${c.status}** ${c.name} — ${c.detail}`);
  }
  lines.push(``);
  lines.push(r.verdict === "GO" ? `**Verdict: GO** — no failing checks; safe to push.` : `**Verdict: NO-GO** — fix the FAIL items before opening the PR.`);
  return lines.join("\n");
}

/** Human-readable console rendering (the --json flag prints the raw result). */
export function formatCiPrepHuman(r: CiPrepResult): string {
  const lines = [`CI pre-flight for ${r.repoDir} (base ${r.base ?? "unknown"}, act: ${r.actMode})`];
  for (const c of r.checks) {
    lines.push(`  [${c.status}] ${c.name}`);
    lines.push(`    ${c.detail}`);
  }
  lines.push(r.verdict === "GO" ? `Verdict: GO` : `Verdict: NO-GO`);
  return lines.join("\n");
}

/** Ensure the tmp fixture helper can create scratch dirs outside the repo. */
export function scratchDir(prefix: string): string {
  const d = join(tmpdir(), `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(d, { recursive: true });
  return d;
}
