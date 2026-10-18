/**
 * `greenlight shipcheck`: independently verify every link of a release
 * chain, so a broken ship can never again be reported as shipped.
 *
 * Field lesson 2026-10-18 (F1): a v0.9.3 ship report claimed a git
 * commit that did not exist; tag v0.9.3 pointed at a nonexistent object
 * while npm and the registry were genuinely fine. Every verification
 * step that day checked the package and the listing, but nobody checked
 * the git links. shipcheck checks all of them: tag ref, commit object,
 * package.json at the tag, GitHub release, npm, and the MCP Registry.
 * It exits non-zero and names the broken link on the first failure.
 * Reads only: it never creates or changes anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apiGet, ApiNotFoundError } from "./github.js";

export type HttpResult = {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type HttpGet = (url: string, headers?: Record<string, string>) => Promise<HttpResult>;

const defaultHttpGet: HttpGet = async (url, headers) => {
  const res = await fetch(url, { headers });
  return {
    status: res.status,
    json: () => res.json() as Promise<unknown>,
    text: () => res.text(),
  };
};

export interface ShipcheckOptions {
  owner: string;
  repo: string;
  /** Release version without the v prefix, e.g. "0.10.1". */
  version: string;
  /** npm package name; defaults from ./package.json, then the API. */
  npmPackage?: string;
  /** MCP registry server name; defaults from ./server.json (mcpName), then the API. */
  mcpName?: string;
  /** Injectable HTTP for the non-GitHub registries (tests). */
  httpGet?: HttpGet;
}

export interface ShipcheckLink {
  /** Stable id: tag, commit, package-json, release, npm, registry. */
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface ShipcheckResult {
  owner: string;
  repo: string;
  version: string;
  tag: string;
  npmPackage: string;
  mcpName?: string;
  links: ShipcheckLink[];
  pass: boolean;
}

function readLocalJsonFile(name: string): Record<string, unknown> | undefined {
  try {
    const path = join(process.cwd(), name);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function decodeContents(data: unknown): string | undefined {
  const d = data as { content?: unknown; encoding?: unknown };
  if (typeof d.content !== "string") return undefined;
  try {
    return Buffer.from(d.content, d.encoding === "base64" ? "base64" : "utf8").toString("utf8");
  } catch {
    return undefined;
  }
}

async function packageJsonFromApi(owner: string, repo: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = decodeContents(await apiGet(`/repos/${owner}/${repo}/contents/package.json`));
    if (!text) return undefined;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function serverJsonFromApi(owner: string, repo: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = decodeContents(await apiGet(`/repos/${owner}/${repo}/contents/server.json`));
    if (!text) return undefined;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function runShipcheck(opts: ShipcheckOptions): Promise<ShipcheckResult> {
  const { owner, repo, version } = opts;
  const tag = `v${version}`;
  const httpGet = opts.httpGet ?? defaultHttpGet;
  const links: ShipcheckLink[] = [];
  const fail = (id: string, label: string, detail: string): false => {
    links.push({ id, label, ok: false, detail });
    return false;
  };

  // npm package and MCP name: explicit flags win, then the local
  // checkout, then the API. A missing MCP name is not a broken link:
  // it just skips the registry check.
  let npmPackage = opts.npmPackage;
  let mcpName = opts.mcpName;
  if (!npmPackage || !mcpName) {
    const localPkg = readLocalJsonFile("package.json");
    const localServer = readLocalJsonFile("server.json");
    npmPackage = npmPackage ?? (typeof localPkg?.name === "string" ? localPkg.name : undefined);
    mcpName = mcpName ?? (typeof localServer?.name === "string" ? localServer.name : undefined);
  }
  if (!npmPackage || !mcpName) {
    const apiPkg = await packageJsonFromApi(owner, repo);
    const apiServer = !mcpName ? await serverJsonFromApi(owner, repo) : undefined;
    npmPackage = npmPackage ?? (typeof apiPkg?.name === "string" ? apiPkg.name : undefined);
    mcpName = mcpName ?? (typeof apiServer?.name === "string" ? apiServer.name : undefined);
  }
  if (!npmPackage) {
    fail("npm", "npm package", `could not determine the npm package name for ${owner}/${repo}; pass --npm <name>`);
  }

  // Link 1: the tag ref must exist.
  let tagSha: string | undefined;
  try {
    const ref = (await apiGet(`/repos/${owner}/${repo}/git/ref/tags/${tag}`)) as {
      object?: { sha?: unknown };
    };
    tagSha = String(ref.object?.sha ?? "");
    if (!tagSha) {
      fail("tag", `tag ${tag}`, `tag ${tag} exists but carries no object SHA`);
    } else {
      links.push({ id: "tag", label: `tag ${tag}`, ok: true, detail: `resolves to ${tagSha.slice(0, 12)}` });
    }
  } catch (err) {
    if (err instanceof ApiNotFoundError) {
      fail("tag", `tag ${tag}`, `tag ${tag} does not exist on ${owner}/${repo}`);
    } else {
      fail("tag", `tag ${tag}`, `could not read the tag ref: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Link 2: the commit object the tag points at must exist. This is
  // the exact F1 failure: the ref was present, the object was not.
  if (tagSha) {
    try {
      await apiGet(`/repos/${owner}/${repo}/git/commits/${tagSha}`);
      links.push({ id: "commit", label: "commit object", ok: true, detail: `${tagSha.slice(0, 12)} resolves` });
    } catch (err) {
      if (err instanceof ApiNotFoundError) {
        fail(
          "commit",
          "commit object",
          `tag ${tag} points at ${tagSha} but the commit object is missing (404): the tag is dangling`
        );
      } else {
        fail("commit", "commit object", `could not read the commit object: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Link 3: package.json at the tag must carry this version.
  if (tagSha) {
    try {
      const text = decodeContents(await apiGet(`/repos/${owner}/${repo}/contents/package.json?ref=${encodeURIComponent(tag)}`));
      const atTag = text ? (JSON.parse(text) as { version?: unknown }) : undefined;
      const atVersion = String(atTag?.version ?? "");
      if (atVersion === version) {
        links.push({ id: "package-json", label: "package.json at tag", ok: true, detail: `version ${atVersion}` });
      } else {
        fail("package-json", "package.json at tag", `tag ${tag} carries version "${atVersion || "(unreadable)"}", expected "${version}"`);
      }
    } catch (err) {
      fail("package-json", "package.json at tag", `could not read package.json at ${tag}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Link 4: a GitHub release must exist for the tag.
  try {
    await apiGet(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    links.push({ id: "release", label: "GitHub release", ok: true, detail: `release for ${tag} exists` });
  } catch (err) {
    if (err instanceof ApiNotFoundError) {
      fail("release", "GitHub release", `no GitHub release exists for tag ${tag}`);
    } else {
      fail("release", "GitHub release", `could not read the release: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Link 5: npm must show this version.
  if (npmPackage && links.every((l) => l.id !== "npm" || l.ok)) {
    try {
      const res = await httpGet(`https://registry.npmjs.org/${encodeURIComponent(npmPackage)}`);
      if (res.status !== 200) {
        fail("npm", "npm package", `registry.npmjs.org returned ${res.status} for ${npmPackage}`);
      } else {
        const data = (await res.json()) as { versions?: Record<string, unknown> };
        if (data.versions && Object.prototype.hasOwnProperty.call(data.versions, version)) {
          links.push({ id: "npm", label: "npm package", ok: true, detail: `${npmPackage}@${version} published` });
        } else {
          fail("npm", "npm package", `${npmPackage} has no published version ${version}`);
        }
      }
    } catch (err) {
      fail("npm", "npm package", `could not reach the npm registry: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Link 6: the MCP Registry must show this version active, when a name is known.
  if (mcpName) {
    try {
      const res = await httpGet(
        `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(mcpName)}`
      );
      if (res.status !== 200) {
        fail("registry", "MCP Registry", `registry returned ${res.status} for search ${mcpName}`);
      } else {
        const data = (await res.json()) as {
          servers?: Array<{
            server?: { name?: unknown; version?: unknown };
            _meta?: Record<string, { status?: unknown; isLatest?: unknown }>;
          }>;
        };
        const match = (data.servers ?? []).find(
          (s) =>
            String(s.server?.name ?? "") === mcpName &&
            String(s.server?.version ?? "") === version &&
            String(s._meta?.["io.modelcontextprotocol.registry/official"]?.status ?? "") === "active"
        );
        if (match) {
          links.push({ id: "registry", label: "MCP Registry", ok: true, detail: `${mcpName}@${version} active` });
        } else {
          fail("registry", "MCP Registry", `no active registry record for ${mcpName}@${version}`);
        }
      }
    } catch (err) {
      fail("registry", "MCP Registry", `could not reach the registry: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    links.push({ id: "registry", label: "MCP Registry", ok: true, detail: "skipped: no MCP name known (pass --mcp-name)" });
  }

  const pass = links.every((l) => l.ok);
  return { owner, repo, version, tag, npmPackage: npmPackage ?? "", mcpName, links, pass };
}

export function formatShipcheckHuman(r: ShipcheckResult): string {
  const lines = [
    `${r.pass ? "[PASS]" : "[FAIL]"} shipcheck ${r.owner}/${r.repo}@${r.version}`,
  ];
  for (const l of r.links) {
    lines.push(`  ${l.ok ? "ok  " : "FAIL"} ${l.label}: ${l.detail}`);
  }
  if (!r.pass) {
    const broken = r.links.filter((l) => !l.ok).map((l) => l.id);
    lines.push(`broken links: ${broken.join(", ")}`);
  }
  return lines.join("\n");
}
