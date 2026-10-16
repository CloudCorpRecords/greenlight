/**
 * `greenlight init`: one-command agent setup.
 *
 * Before this, onboarding an agent meant cloning the repo and hand-copying
 * MCP configs plus instruction snippets from integrations/ per tool. Init
 * does that from the installed package: it copies (or JSON-merges) the MCP
 * server config into the current project and installs the tool's instruction
 * snippet, then prints the restart + verify steps.
 *
 * Safety rules: existing configs are merged (other servers are preserved),
 * instruction appends are marker-guarded and idempotent, nothing is
 * overwritten unless --force is given, and --dry-run only reports.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export interface InitTool {
  id: string;
  label: string;
  /** Path of the MCP config inside the integrations pack. */
  configSrc: string;
  /** Destination: project-relative, or home-relative when homeDest is true. */
  configDest: string;
  homeDest?: boolean;
  /**
   * Top-level key holding the server map for JSON merging.
   * null means plain copy (the generic fallback file).
   */
  serverMapKey: "mcpServers" | "servers" | null;
  /** Path of the instruction snippet inside the pack, when the tool has one. */
  instructionsSrc?: string;
  /** Project-relative destination for the instructions. */
  instructionsDest?: string;
  /** append-markers: guard with markers and append; copy: whole-file copy. */
  instructionsMode?: "append-markers" | "copy";
  /** Project-relative paths whose presence suggests this tool is in use. */
  detectMarkers: string[];
  restartNote: string;
}

export const INIT_TOOLS: InitTool[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    configSrc: "claude-code/.mcp.json",
    configDest: ".mcp.json",
    serverMapKey: "mcpServers",
    instructionsSrc: "claude-code/CLAUDE.snippet.md",
    instructionsDest: "CLAUDE.md",
    instructionsMode: "append-markers",
    detectMarkers: [".mcp.json", "CLAUDE.md"],
    restartNote: "Restart Claude Code, then ask it to list its MCP tools.",
  },
  {
    id: "cursor",
    label: "Cursor",
    configSrc: "cursor/.cursor/mcp.json",
    configDest: ".cursor/mcp.json",
    serverMapKey: "mcpServers",
    instructionsSrc: "cursor/greenlight.mdc",
    instructionsDest: ".cursor/rules/greenlight.mdc",
    instructionsMode: "copy",
    detectMarkers: [".cursor"],
    restartNote: "Restart Cursor, then ask the agent to list its MCP tools.",
  },
  {
    id: "copilot",
    label: "VS Code / Copilot",
    configSrc: "copilot/.vscode/mcp.json",
    configDest: ".vscode/mcp.json",
    serverMapKey: "servers",
    instructionsSrc: "copilot/copilot-instructions.snippet.md",
    instructionsDest: ".github/copilot-instructions.md",
    instructionsMode: "append-markers",
    detectMarkers: [".vscode", ".github/copilot-instructions.md"],
    restartNote: "Reload VS Code, then check the MCP server list.",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    configSrc: "windsurf/mcp_config.json",
    configDest: ".codeium/windsurf/mcp_config.json",
    homeDest: true,
    serverMapKey: "mcpServers",
    detectMarkers: [],
    restartNote: "Restart Windsurf, then open Manage MCP Servers to confirm greenlight is listed.",
  },
  {
    id: "cline",
    label: "Cline",
    configSrc: "cline/cline_mcp_settings.json",
    configDest: ".cline/mcp_settings.json",
    serverMapKey: "mcpServers",
    detectMarkers: [".cline"],
    restartNote: "Restart your editor, then check Cline's MCP Servers list.",
  },
  {
    id: "generic",
    label: "Any other MCP client",
    configSrc: "mcp.json",
    configDest: "greenlight.mcp.json",
    serverMapKey: null,
    detectMarkers: [],
    restartNote: "Point your MCP client at greenlight.mcp.json (command npx, args -y @reneturcios/greenlight mcp).",
  },
];

/** Markers guarding an appended instruction block; presence means "already installed". */
export const INIT_BEGIN_MARKER = "<!-- greenlight:init:begin -->";
export const INIT_END_MARKER = "<!-- greenlight:init:end -->";

/** The integrations pack ships inside the npm package next to dist/. */
export function defaultPackDir(): string {
  return fileURLToPath(new URL("../integrations/", import.meta.url));
}

export function findTool(id: string): InitTool | undefined {
  return INIT_TOOLS.find((t) => t.id === id.toLowerCase());
}

/** Split --agent values on commas, lowercase, dedupe, drop empties. */
export function parseAgentList(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    for (const part of v.split(",")) {
      const id = part.trim().toLowerCase();
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Tool ids whose marker files exist in the project (a hint, never auto-applied). */
export function detectTools(projectDir: string): string[] {
  return INIT_TOOLS.filter(
    (t) => t.detectMarkers.length > 0 && t.detectMarkers.some((m) => existsSync(join(projectDir, m)))
  ).map((t) => t.id);
}

export type InitFileAction =
  | "created"
  | "merged"
  | "updated"
  | "overwritten"
  | "skipped";

export interface InitFileResult {
  path: string;
  action: InitFileAction;
  detail: string;
}

export interface InitToolResult {
  id: string;
  label: string;
  files: InitFileResult[];
  notes: string[];
}

export interface InitOptions {
  projectDir?: string;
  homeDir?: string;
  packDir?: string;
  force?: boolean;
  includeInstructions?: boolean;
  dryRun?: boolean;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function writeFileEnsured(path: string, content: string, dryRun: boolean): void {
  if (dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/**
 * Install one tool's MCP config. Existing JSON configs are merged (the
 * greenlight server is added, everything else preserved). Returns the file
 * result; throws only when the destination is unparseable and --force was
 * not given, since silently dropping a broken config would hide user data.
 */
function installConfig(
  tool: InitTool,
  destPath: string,
  packContent: string,
  force: boolean,
  dryRun: boolean
): InitFileResult {
  if (tool.serverMapKey === null) {
    if (!existsSync(destPath)) {
      writeFileEnsured(destPath, packContent, dryRun);
      return { path: destPath, action: "created", detail: "config copied" };
    }
    const existing = readFileSync(destPath, "utf8");
    if (existing === packContent) {
      return { path: destPath, action: "skipped", detail: "already set up" };
    }
    if (!force) {
      return {
        path: destPath,
        action: "skipped",
        detail: "exists with different content; re-run with --force to overwrite",
      };
    }
    writeFileEnsured(destPath, packContent, dryRun);
    return { path: destPath, action: "overwritten", detail: "overwritten with --force" };
  }

  const packDoc = JSON.parse(packContent) as Record<string, Record<string, unknown>>;
  const packEntry = packDoc[tool.serverMapKey]?.greenlight;
  if (!existsSync(destPath)) {
    writeFileEnsured(destPath, packContent.endsWith("\n") ? packContent : packContent + "\n", dryRun);
    return { path: destPath, action: "created", detail: "config copied" };
  }
  let destDoc: Record<string, Record<string, unknown>>;
  try {
    destDoc = JSON.parse(readFileSync(destPath, "utf8")) as Record<string, Record<string, unknown>>;
  } catch {
    if (!force) {
      throw new Error(
        `${destPath} exists but is not valid JSON; fix it or re-run with --force to overwrite it`
      );
    }
    writeFileEnsured(destPath, packContent.endsWith("\n") ? packContent : packContent + "\n", dryRun);
    return { path: destPath, action: "overwritten", detail: "invalid JSON overwritten with --force" };
  }
  if (typeof destDoc !== "object" || destDoc === null || Array.isArray(destDoc)) {
    if (!force) {
      throw new Error(
        `${destPath} exists but is not a JSON object; fix it or re-run with --force to overwrite it`
      );
    }
    writeFileEnsured(destPath, packContent.endsWith("\n") ? packContent : packContent + "\n", dryRun);
    return { path: destPath, action: "overwritten", detail: "non-object JSON overwritten with --force" };
  }
  if (typeof destDoc[tool.serverMapKey] !== "object" || destDoc[tool.serverMapKey] === null) {
    destDoc[tool.serverMapKey] = {};
  }
  const map = destDoc[tool.serverMapKey] as Record<string, unknown>;
  if ("greenlight" in map && sameJson(map.greenlight, packEntry)) {
    return { path: destPath, action: "skipped", detail: "greenlight server already configured" };
  }
  const hadEntry = "greenlight" in map;
  map.greenlight = packEntry;
  writeFileEnsured(destPath, JSON.stringify(destDoc, null, 2) + "\n", dryRun);
  return {
    path: destPath,
    action: hadEntry ? "updated" : "merged",
    detail: hadEntry ? "greenlight server entry refreshed, other servers kept" : "greenlight server added, other servers kept",
  };
}

/** Install one tool's instruction snippet (append-with-markers or whole copy). */
function installInstructions(
  tool: InitTool,
  destPath: string,
  snippet: string,
  force: boolean,
  dryRun: boolean
): InitFileResult {
  if (tool.instructionsMode === "copy") {
    if (!existsSync(destPath)) {
      writeFileEnsured(destPath, snippet, dryRun);
      return { path: destPath, action: "created", detail: "rule file copied" };
    }
    if (readFileSync(destPath, "utf8") === snippet) {
      return { path: destPath, action: "skipped", detail: "already set up" };
    }
    if (!force) {
      return {
        path: destPath,
        action: "skipped",
        detail: "exists with different content; re-run with --force to overwrite",
      };
    }
    writeFileEnsured(destPath, snippet, dryRun);
    return { path: destPath, action: "overwritten", detail: "overwritten with --force" };
  }

  // append-markers: idempotent by marker presence; never touches user text.
  if (existsSync(destPath) && readFileSync(destPath, "utf8").includes(INIT_BEGIN_MARKER)) {
    return { path: destPath, action: "skipped", detail: "instructions already installed" };
  }
  const block = `${INIT_BEGIN_MARKER}\n${snippet.trim()}\n${INIT_END_MARKER}\n`;
  if (!existsSync(destPath)) {
    writeFileEnsured(destPath, block, dryRun);
    return { path: destPath, action: "created", detail: "instructions installed" };
  }
  const existing = readFileSync(destPath, "utf8");
  const joined = existing + (existing.endsWith("\n") ? "\n" : "\n\n") + block;
  writeFileEnsured(destPath, joined, dryRun);
  return { path: destPath, action: "updated", detail: "instructions appended, existing content kept" };
}

/**
 * Set up the given tools. Throws on unknown tool ids or a missing pack so
 * the CLI can show the tool list instead of half-writing.
 */
export function initTools(toolIds: string[], opts: InitOptions = {}): InitToolResult[] {
  const projectDir = opts.projectDir ?? process.cwd();
  const homeDir = opts.homeDir ?? homedir();
  const packDir = opts.packDir ?? defaultPackDir();
  const force = opts.force ?? false;
  const includeInstructions = opts.includeInstructions ?? true;
  const dryRun = opts.dryRun ?? false;

  const tools = toolIds.map((id) => {
    const tool = findTool(id);
    if (!tool) {
      throw new Error(
        `Unknown agent "${id}". Run 'greenlight init --list' to see the supported tools.`
      );
    }
    return tool;
  });

  // Read every pack file up front so a missing pack fails before writing.
  const packFiles = new Map<string, string>();
  const readPack = (rel: string): string => {
    const cached = packFiles.get(rel);
    if (cached !== undefined) return cached;
    const abs = join(packDir, rel);
    if (!existsSync(abs)) {
      throw new Error(`Pack file missing: ${rel} (looked in ${packDir})`);
    }
    const content = readFileSync(abs, "utf8");
    packFiles.set(rel, content);
    return content;
  };
  for (const tool of tools) {
    readPack(tool.configSrc);
    if (includeInstructions && tool.instructionsSrc) readPack(tool.instructionsSrc);
  }

  return tools.map((tool) => {
    const notes: string[] = [];
    const files: InitFileResult[] = [];
    const base = tool.homeDest ? homeDir : projectDir;
    const configDest = join(base, tool.configDest);
    files.push(installConfig(tool, configDest, readPack(tool.configSrc), force, dryRun));
    if (includeInstructions && tool.instructionsSrc && tool.instructionsDest) {
      const snippetDest = join(projectDir, tool.instructionsDest);
      files.push(
        installInstructions(tool, snippetDest, readPack(tool.instructionsSrc), force, dryRun)
      );
    } else if (tool.instructionsSrc && !includeInstructions) {
      notes.push("instructions skipped (--no-instructions)");
    }
    notes.push(tool.restartNote);
    return { id: tool.id, label: tool.label, files, notes };
  });
}

/** Human-readable report of an init run (file actions plus next steps). */
export function formatInitHuman(results: InitToolResult[], dryRun: boolean): string {
  const verb: Record<InitFileAction, string> = {
    created: "create",
    merged: "merge into",
    updated: "update",
    overwritten: "overwrite",
    skipped: "skip",
  };
  const lines: string[] = [];
  if (dryRun) lines.push("Dry run: nothing was written. Re-run without --dry-run to apply.");
  for (const r of results) {
    lines.push(`${r.label}:`);
    for (const f of r.files) {
      const action = dryRun ? `would ${verb[f.action]}` : f.action;
      lines.push(`  ${action}: ${f.path} (${f.detail})`);
    }
    for (const n of r.notes) lines.push(`  next: ${n}`);
  }
  lines.push("Verify: ask your agent to list its MCP tools; greenlight should appear with 12 tools.");
  lines.push("Tip: set GITHUB_TOKEN (classic PAT, no scopes needed for public repos) for the 5000 req/hr limit.");
  return lines.join("\n");
}
