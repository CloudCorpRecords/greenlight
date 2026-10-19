/**
 * End-to-end MCP tests: the stdio server lists 19 tools
 * (including scout_campaign, my_claims, sync_campaign, campaign_portfolio)
 * and the new tools answer.
 * Spawns the built server (dist/cli.js mcp) and speaks JSON-RPC over
 * stdio. HOME is pointed at a temp dir so my_claims sees no registry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface RpcResult {
  tools: Array<{ name: string; description?: string }>;
}

function startServer(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn("node", [join(ROOT, "dist", "cli.js"), "mcp"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Send one JSON-RPC request and resolve with the parsed response line carrying `id`. */
function rpc(proc: ChildProcess, id: number, method: string, params: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const msg = JSON.parse(trimmed) as { id?: unknown; result?: unknown; error?: unknown };
          if (msg.id === id) {
            cleanup();
            if (msg.error) reject(new Error(`rpc error: ${JSON.stringify(msg.error)}`));
            else resolve(msg as Record<string, unknown>);
            return;
          }
        } catch {
          // Not a complete JSON line yet; keep buffering.
        }
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`rpc ${method} timed out`));
    }, 30000);
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout!.off("data", onData);
    };
    proc.stdout!.on("data", onData);
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function listTools(): Promise<{ proc: ChildProcess; tools: RpcResult["tools"] }> {
  const home = mkdtempSync(join(tmpdir(), "gl-mcp-home-"));
  const proc = startServer({ ...process.env, HOME: home });
  try {
    await rpc(proc, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "gl-test", version: "0" },
    });
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const res = await rpc(proc, 2, "tools/list", {});
    const tools = ((res.result as RpcResult)?.tools ?? []) as RpcResult["tools"];
    return { proc, tools };
  } catch (err) {
    proc.kill();
    throw err;
  }
}

describe("mcp tools (v0.13.0)", () => {
  it("lists 27 tools including the claim-api client trio", async () => {
    const { proc, tools } = await listTools();
    try {
      const names = tools.map((t) => t.name);
      assert.equal(names.length, 27, `expected 27 tools, got ${names.length}: ${names.join(",")}`);
      assert.ok(names.includes("scout_campaign"), "scout_campaign listed");
      assert.ok(names.includes("my_claims"), "my_claims listed");
      assert.ok(names.includes("sync_campaign"), "sync_campaign listed");
      assert.ok(names.includes("campaign_portfolio"), "campaign_portfolio listed");
      assert.ok(names.includes("autopilot_report"), "autopilot_report listed");
      assert.ok(names.includes("claim_status"), "claim_status listed");
      assert.ok(names.includes("api_status"), "api_status listed");
      assert.ok(names.includes("claim_via_api"), "claim_via_api listed");
      assert.ok(names.includes("heartbeat_via_api"), "heartbeat_via_api listed");
      assert.ok(names.includes("xray_issues"), "xray_issues listed");
      assert.ok(names.includes("ci_prep"), "ci_prep listed");
      assert.ok(names.includes("pr_radar"), "pr_radar listed");
      assert.ok(names.includes("pr_brief"), "pr_brief listed");
    } finally {
      proc.kill();
    }
  });

  it("my_claims answers with the empty-registry shape when no registry exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "gl-mcp-home-"));
    const proc = startServer({ ...process.env, HOME: home });
    try {
      await rpc(proc, 1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "gl-test", version: "0" },
      });
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const res = await rpc(proc, 2, "tools/call", { name: "my_claims", arguments: {} });
      const result = res.result as { content?: Array<{ type: string; text: string }> };
      const text = (result.content ?? []).map((c) => c.text).join("\n");
      assert.ok(text.includes("claims"), `unexpected my_claims output: ${text.slice(0, 200)}`);
    } finally {
      proc.kill();
    }
  });
});
