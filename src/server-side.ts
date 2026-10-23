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
/**
 * Error-context vocabulary (v0.21.2, GL-5): a double-quoted capitalized
 * span counts as candidate error text only when error-ish wording
 * appears in or around it. Feature requests quote capitalized example
 * names ("Public Subfolder" in a hypothetical folder tree) that are
 * not error text at all; without this gate the heuristic asserted a
 * backend-enforced "error" that does not exist (bruno#9611).
 */
const ERROR_CONTEXT =
  /\b(error|errors|fail|fails|failed|failure|exception|throw|throws|thrown|reject|rejected|denied|invalid|status|code|http|unable|cannot|crash|permission|denied|warning|returned|returns)\b/i;

export function extractErrorStrings(body: string): string[] {
  const out: string[] = [];
  const add = (s: string): void => {
    const t = s.trim();
    if (t.length >= 8 && t.length <= 160 && !out.includes(t)) out.push(t);
  };
  for (const m of body.matchAll(/`([^`]{8,160})`/g)) add(m[1]);
  for (const m of body.matchAll(/"([A-Z][^"\n]{7,159})"/g)) {
    // Gate double-quoted spans on error context in the surrounding
    // text (the span itself included: genuine error strings carry
    // error vocabulary — "Invalid connection status…"). Backticked
    // spans and explicit error: lines are deliberate error quoting
    // and stay ungated.
    const start = Math.max(0, (m.index ?? 0) - 100);
    const window = body.slice(start, (m.index ?? 0) + m[0].length + 100);
    if (ERROR_CONTEXT.test(window)) add(m[1]);
  }
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
