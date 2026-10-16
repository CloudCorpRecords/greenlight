/**
 * Server-side-only detection. Some issues cannot be fixed in the repo at
 * all: ComposioHQ/composio#4852's HTTP 422 / code 1706 rejection is enforced
 * by Composio's closed backend, while the repo holds only SDKs that pass
 * the auth config straight through. A full build burned on it before anyone
 * noticed the error text existed nowhere in the codebase.
 *
 * Heuristic: extract quoted error strings from the issue body and code-search
 * the repo for them. Zero hits on a distinctive string means the check
 * probably lives outside the repo. Best-effort by contract: rate limits,
 * search failures, or an empty candidate list all yield null, never a
 * guess. No verdict change, warning only.
 */
import { apiGet } from "./github.js";

export interface ServerSideDeps {
  /** Test seam: number of code-search hits for a literal string in the repo. */
  codeSearch?: (owner: string, repo: string, literal: string) => Promise<number>;
}

/**
 * Pull candidate error strings out of an issue body: backtick-quoted spans,
 * double-quoted spans that start capitalized (error text, not prose), and
 * explicit "error:" lines. Bounded at 4 candidates; each 8-160 chars so
 * short tokens do not become useless search queries.
 */
export function extractErrorStrings(body: string): string[] {
  const out: string[] = [];
  const add = (s: string): void => {
    const t = s.trim();
    if (t.length >= 8 && t.length <= 160 && !out.includes(t)) out.push(t);
  };
  for (const m of body.matchAll(/`([^`]{8,160})`/g)) add(m[1]);
  for (const m of body.matchAll(/"([A-Z][^"\n]{7,159})"/g)) add(m[1]);
  for (const m of body.matchAll(/\berror\s*[:=]\s*["']?([^"'\n]{8,160})/gi)) add(m[1]);
  return out.slice(0, 4);
}

/**
 * Returns { flag: "possibly-server-side", evidence } when a distinctive
 * quoted error string from the body has zero hits in the repo, else null.
 * Only the first two candidates are searched (each costs one API call).
 * Any search failure returns null: no evidence, no flag.
 */
export async function detectServerSideOnly(
  owner: string,
  repo: string,
  body: string,
  deps: ServerSideDeps = {}
): Promise<{ flag: string; evidence: string } | null> {
  const candidates = extractErrorStrings(body);
  if (candidates.length === 0) return null;
  const search =
    deps.codeSearch ??
    (async (o: string, r: string, literal: string): Promise<number> => {
      const data = (await apiGet(
        `/search/code?q=${encodeURIComponent(`repo:${o}/${r} "${literal}"`)}&per_page=1`
      )) as { total_count?: number };
      return data.total_count ?? 0;
    });
  for (const c of candidates.slice(0, 2)) {
    let hits: number;
    try {
      hits = await search(owner, repo, c);
    } catch {
      return null; // rate limited or search failed: emit nothing rather than guessing
    }
    if (hits === 0) {
      return {
        flag: "possibly-server-side",
        evidence: `error text "${c}" not found anywhere in ${owner}/${repo}; the check may be enforced by a backend service outside this repo`,
      };
    }
  }
  return null;
}
