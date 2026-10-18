/**
 * Mechanical fix resolvers for Autopilot (v0.11.0).
 *
 * The rule is strict: Autopilot may only resolve conflicts that are
 * provably mechanical. Anything that touches source logic in a
 * non-trivial way aborts the fix and reports NEEDS_HUMAN with the
 * conflicted files. Every resolver below is a pure function, tested
 * against fixtures, so the merge decision is reviewable before it runs.
 */
import { execFile } from "node:child_process";

export type ConflictStrategy = "lockfile" | "changelog" | "version-bump" | "manual";

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "Pipfile.lock",
]);

/** Decide how a conflicted file may be resolved: mechanical, or manual only. */
export function conflictFileStrategy(path: string): ConflictStrategy {
  const base = path.split("/").pop() ?? path;
  if (LOCKFILE_NAMES.has(base)) return "lockfile";
  if (/^changelog/i.test(base) || /^changes\.md$/i.test(base)) return "changelog";
  return "manual";
}

export interface ConflictHunk {
  base: string[];
  ours: string[];
  theirs: string[];
}

/**
 * Parse git conflict markers into hunks. Returns null when the text has no
 * markers or a marker is malformed.
 */
export function parseConflictHunks(text: string): ConflictHunk[] | null {
  const hunks: ConflictHunk[] = [];
  const lines = text.split("\n");
  let i = 0;
  let inConflict = false;
  let ours: string[] = [];
  let theirs: string[] = [];
  let mid = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("<<<<<<<")) {
      if (inConflict) return null;
      inConflict = true;
      mid = false;
      ours = [];
      theirs = [];
      continue;
    }
    if (!inConflict) continue;
    if (line.startsWith("=======")) {
      mid = true;
      continue;
    }
    if (line.startsWith(">>>>>>>")) {
      // base is unknown at this level; the caller supplies it per hunk.
      hunks.push({ base: [], ours, theirs });
      inConflict = false;
      continue;
    }
    (mid ? theirs : ours).push(line);
  }
  if (inConflict) return null;
  return hunks.length > 0 ? hunks : null;
}

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function compareSemver(a: string, b: string): number | null {
  if (!SEMVER.test(a) || !SEMVER.test(b)) return null;
  const pa = a.split(".").map((x) => Number(x));
  const pb = b.split(".").map((x) => Number(x));
  for (let k = 0; k < 3; k++) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return 0;
}

function compareCounter(a: string, b: string): number | null {
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
  const na = Number(a);
  const nb = Number(b);
  return na === nb ? 0 : na < nb ? -1 : 1;
}

/**
 * Mechanical single-line bump resolution (reticle's guard 13->14 class):
 * when a hunk changed exactly one token on each side, one side kept the
 * base value, and the other side is a strict increase (semver or integer
 * counter), the increase wins. Anything else is not mechanical: null.
 *
 * The hunk's base lines are passed explicitly (git markers do not carry them).
 */
export function resolveVersionBumpHunk(
  hunk: ConflictHunk,
  baseLines: string[]
): { resolved: string[]; taken: "ours" | "theirs" } | null {
  if (hunk.ours.length !== 1 || hunk.theirs.length !== 1 || baseLines.length !== 1) return null;
  const [oursLine] = hunk.ours;
  const [theirsLine] = hunk.theirs;
  const [baseLine] = baseLines;
  // Find the single changed token: walk from both ends.
  const clean = (t: string): string => t.replace(/[;,)]+$/, "");
  const tokenOf = (oursTok: string, theirsTok: string, baseTok: string) => {
    if (oursTok === theirsTok) return null;
    const oursKept = oursTok === baseTok;
    const theirsKept = theirsTok === baseTok;
    if (oursKept === theirsKept) return null;
    const bumped = clean(oursKept ? theirsTok : oursTok);
    const kept = clean(oursKept ? oursTok : theirsTok);
    const cmp = compareSemver(kept, bumped) ?? compareCounter(kept, bumped);
    if (cmp === null || cmp >= 0) return null;
    return oursKept ? ("theirs" as const) : ("ours" as const);
  };
  // Tokenize on whitespace; the single differing token decides.
  const ot = oursLine.split(/(\s+)/);
  const tt = theirsLine.split(/(\s+)/);
  const bt = baseLine.split(/(\s+)/);
  if (ot.length !== tt.length || ot.length !== bt.length) return null;
  let decided: "ours" | "theirs" | null = null;
  for (let i = 0; i < ot.length; i++) {
    const winner = tokenOf(ot[i], tt[i], bt[i]);
    if (winner === null) continue;
    if (decided !== null && decided !== winner) return null;
    decided = winner;
  }
  if (decided === null) return null;
  return { resolved: decided === "ours" ? hunk.ours : hunk.theirs, taken: decided };
}

/**
 * Changelog merge: union of added lines from both sides, base lines kept in
 * order, each side's new lines appended in the order they appear. Exact
 * duplicate lines are not duplicated.
 */
export function resolveChangelogMerge(base: string, ours: string, theirs: string): string {
  const baseLines = base.split("\n");
  const ourLines = ours.split("\n");
  const theirLines = theirs.split("\n");
  const baseSet = new Set(baseLines);
  const out: string[] = [...baseLines];
  const seen = new Set(baseLines);
  for (const line of [...ourLines, ...theirLines]) {
    if (baseSet.has(line) || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.join("\n");
}

/** Detect the package manager for lockfile regeneration from lockfile name. */
export function lockfileManager(lockfileName: string): string | null {
  const base = lockfileName.split("/").pop() ?? lockfileName;
  switch (base) {
    case "package-lock.json":
      return "npm";
    case "pnpm-lock.yaml":
      return "pnpm";
    case "yarn.lock":
      return "yarn";
    case "bun.lockb":
      return "bun";
    case "Cargo.lock":
      return "cargo";
    case "go.sum":
      return "go";
    default:
      return null;
  }
}

export interface GitRunner {
  run: (cwd: string, args: string[], stdin?: string) => Promise<{ stdout: string; stderr: string }>;
}

export function defaultGitRunner(): GitRunner {
  return {
    run: (cwd, args) =>
      new Promise((resolve, reject) => {
        execFile("git", args, { cwd, timeout: 120_000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
          else resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
      }),
  };
}

/**
 * Formatting-only verification: after running a formatter, the diff must be
 * whitespace-only. `git diff -w` empty means no non-whitespace changes.
 */
export async function diffIsFormattingOnly(git: GitRunner, cwd: string): Promise<boolean> {
  const { stdout } = await git.run(cwd, ["diff", "-w", "--numstat"]);
  return stdout.trim().length === 0;
}

/** Detect a formatter path in a repo dir: npm scripts or known configs. */
export function detectFormatter(
  files: string[],
  scripts: Record<string, string>
): { name: string; cmd: string[] } | null {
  if (scripts["format"]) return { name: "npm run format", cmd: ["npm", "run", "format"] };
  if (scripts["lint:fix"]) return { name: "npm run lint:fix", cmd: ["npm", "run", "lint:fix"] };
  if (scripts["lint"] && /--fix/.test(scripts["lint"])) return { name: "npm run lint", cmd: ["npm", "run", "lint"] };
  const has = (n: string) => files.includes(n);
  if (
    has(".prettierrc") ||
    has(".prettierrc.json") ||
    has("prettier.config.js") ||
    has("prettier.config.cjs")
  ) {
    return { name: "prettier", cmd: ["npx", "--no-install", "prettier", "--write", "."] };
  }
  return null;
}
