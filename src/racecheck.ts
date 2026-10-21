/**
 * Keyword Race Check: find competing PRs that never link the issue.
 *
 * Field case (2026-10-20, sveltejs/kit): issue #17465 (the root route
 * $types.d.ts is deleted and regenerated on every sync run) got our PR
 * #17489 closed in favor of PR #17453, "fix: correctly cache type
 * generation", opened 2026-10-15, two days before ours. #17453 fixed the
 * same problem but its body NEVER mentioned #17465, so every existing
 * check (comment claims, timeline cross-references, Timeline X-Ray) —
 * all of which key off issue links — saw a clean race.
 *
 * Racecheck closes that hole with keyword evidence instead of links:
 *   1. Extract significant problem keywords from the issue: distinctive
 *      title terms, quoted strings, CamelCase / snake_case identifiers,
 *      file paths and filenames (e.g. $types.d.ts), minus stopwords and
 *      generic words (fix, bug, issue, error alone, ...).
 *   2. Find the repo's OPEN PRs two ways: the GitHub search API seeded
 *      with the strongest keywords, and a scan of the open-PR list
 *      (titles and bodies) for keyword overlap.
 *   3. Score each candidate deterministically. Changed files are fetched
 *      under a small cap (text-matching candidates first; the whole pool
 *      when it fits the cap), and a shared file with the issue is itself
 *      race evidence.
 *
 * Verdicts (per candidate, then overall):
 *   RACE    — strong match: >= 2 significant term matches, OR 1 rare
 *             term (filename, $-token, identifier), OR 1 phrase match,
 *             OR a shared changed file.
 *   SUSPECT — a single weak/generic term match.
 *   CLEAR   — nothing.
 * Every non-CLEAR verdict quotes its evidence: PR number, title,
 * author, created date, and exactly which keywords matched.
 *
 * False-positive discipline (the radar "issue #2 from oauth2" lesson):
 * tokenization is delimiter-aware — "oauth2" is ONE token, never the
 * words "oauth" + "2"; pure numbers are never keywords; generic single
 * words are filtered at extraction, so a lone generic overlap cannot
 * reach RACE (it cannot even reach the match list).
 */
import { apiCallsUsed, apiGet, cacheGet, cacheSet } from "./github.js";

export type RaceVerdict = "RACE" | "SUSPECT" | "CLEAR" | "ERROR";

export interface KeywordSet {
  /** Rare tokens: filenames/paths, $-tokens, CamelCase/snake identifiers, quoted code. */
  rare: string[];
  /** Significant single words from the title, labels, and quoted text. */
  terms: string[];
  /** Multi-word phrases (title bigrams, quoted strings). */
  phrases: string[];
  /** File paths/names named in the issue (full form as written). */
  files: string[];
}

export interface RaceIssue {
  title: string;
  body: string;
  labels: string[];
  author: string;
}

export interface RacePRCandidate {
  number: number;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  url: string;
}

export interface RaceMatch {
  number: number;
  title: string;
  author: string;
  createdAt: string;
  url: string;
  verdict: "RACE" | "SUSPECT";
  /** All matched keywords (rare + phrases + terms + files), deduped. */
  matchedKeywords: string[];
  rareHits: string[];
  phraseHits: string[];
  termHits: string[];
  fileHits: string[];
  evidence: string;
}

export interface RacecheckResult {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  verdict: RaceVerdict;
  keywords: KeywordSet;
  matches: RaceMatch[];
  reasons: string[];
  /** API calls consumed (measured, for budget honesty). */
  apiCalls: number;
}

export interface RacecheckDeps {
  fetchIssue?: (owner: string, repo: string, number: number) => Promise<RaceIssue>;
  searchOpenPRs?: (owner: string, repo: string, keywords: KeywordSet) => Promise<RacePRCandidate[]>;
  listOpenPRs?: (owner: string, repo: string, limit: number) => Promise<RacePRCandidate[]>;
  fetchFiles?: (owner: string, repo: string, prNumber: number) => Promise<string[]>;
}

/** Words that carry no problem signal on their own. */
const STOPWORDS = new Set(
  (
    "the,a,an,and,or,of,to,in,for,on,with,by,from,at,as,it,its,this,that,these,those," +
    "are,is,was,were,be,been,being,has,have,had,do,does,did,when,while,after,before," +
    "into,over,under,again,once,twice,every,any,all,some,one,two,first,second,not,no," +
    "yes,if,but,so,than,then,there,here,what,which,who,whom,how,why,can,could,should," +
    "would,will,shall,may,might,must,also,just,only,even,still,already,get,gets,got," +
    "make,makes,made,using,use,used,via,per,etc,eg,ie,you,your,our,they,them,their,he,she,we"
  ).split(",")
);

/**
 * Generic problem words: real in almost every issue, distinctive in
 * none. A match on one of these alone must never signal a race, so
 * they are removed at extraction time (spec: "error alone" et al.).
 */
const GENERIC = new Set(
  (
    "fix,fixes,fixed,fixing,bug,bugs,issue,issues,error,errors,problem,problems," +
    "broken,fail,fails,failed,failing,failure,failures,crash,crashes,crashed,crashing," +
    "wrong,incorrect,invalid,missing,add,adds,added,adding,feature,features,support," +
    "supports,supported,update,updates,updated,updating,improve,improves,improved," +
    "change,changes,changed,new,work,works,worked,working,app,application,page,pages," +
    "user,users,unable,cannot,can't,won't,doesn't,don't,isn't,aren't,run,runs,running," +
    "open,opens,opened,opening,close,closes,closed,remove,removes,removed,create," +
    "creates,created,show,shows,shown,display,displays,option,options,setting,settings," +
    "request,requests,allow,allows,enable,enables,enabled,disable,disabled,handle," +
    "handles,handling,check,checks,move,moves,moved,set,sets,currently,actual,expected," +
    "behavior,behaviour,happen,happens,happened,occur,occurs,occurred,see,seen,look,looks"
  ).split(",")
);

const FILE_EXTENSIONS = new Set(
  (
    "ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,c,h,cpp,hpp,cs,swift,kt,scala,sh," +
    "json,yml,yaml,toml,md,mdx,css,scss,html,vue,svelte,sql,lock"
  ).split(",")
);

const MAX_RARE = 12;
const MAX_TERMS = 20;
const MAX_PHRASES = 8;
const DEFAULT_PR_LIMIT = 100;
const MAX_FILE_FETCHES = 5;

/**
 * Delimiter-aware word tokens: lowercase, split on anything that is not
 * a letter or digit. "oauth2" stays one token (never "oauth" + "2"),
 * "$types.d.ts" yields "types" and "d" and "ts" here — its intact form
 * is captured by specialTokens below.
 */
export function wordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function isSignificantWord(w: string): boolean {
  return w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w) && !GENERIC.has(w);
}

/**
 * Special tokens from raw text: dotted filenames and paths, $-tokens,
 * CamelCase and snake_case identifiers. These are the rare terms: one
 * hit is already race evidence.
 */
export function specialTokens(text: string): string[] {
  const out = new Set<string>();
  const dotted = /[A-Za-z0-9_$][A-Za-z0-9_$./-]*\.[A-Za-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = dotted.exec(text)) !== null) {
    const tok = m[0].replace(/[.\-/]+$/, "").toLowerCase();
    if (tok.length >= 3) out.add(tok);
  }
  const dollar = /\$[A-Za-z0-9_][A-Za-z0-9_.-]*/g;
  while ((m = dollar.exec(text)) !== null) {
    const tok = m[0].replace(/[.-]+$/, "").toLowerCase();
    if (tok.length >= 2) out.add(tok);
  }
  const camel = /\b[A-Za-z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g;
  while ((m = camel.exec(text)) !== null) {
    if (m[0].length >= 6) out.add(m[0].toLowerCase());
  }
  const snake = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
  while ((m = snake.exec(text)) !== null) {
    if (m[0].length >= 6) out.add(m[0].toLowerCase());
  }
  return [...out];
}

/** A dotted token counts as a named file when it has a known file shape. */
function looksLikeFile(tok: string): boolean {
  if (tok.includes("/")) return true;
  if (tok.startsWith("$")) return true;
  const ext = tok.split(".").pop() ?? "";
  return FILE_EXTENSIONS.has(ext);
}

/** Quoted strings ("...", '...', `...`), trimmed, 2-80 chars. */
function quotedStrings(text: string): string[] {
  const out: string[] = [];
  const re = /["'`]([^"'`\n]{2,80})["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[1].trim();
    if (s.length >= 2) out.push(s);
  }
  return out;
}

/**
 * Extract the significant problem keywords from an issue. Pure.
 *
 * Rare terms come from the title AND body (filenames and identifiers
 * usually live in the body). Significant single words come from the
 * title, the labels, and quoted strings; body prose contributes words
 * only when quoted or identifier-shaped, so a long generic body cannot
 * flood the term list with noise.
 */
export function extractKeywords(issue: RaceIssue): KeywordSet {
  const rare = new Set<string>();
  const files = new Set<string>();
  const terms = new Set<string>();
  const phrases = new Set<string>();

  const allText = `${issue.title}\n${issue.body}`;
  for (const tok of specialTokens(allText)) {
    if (looksLikeFile(tok)) {
      files.add(tok);
      rare.add(tok);
      const base = tok.split("/").pop()!;
      if (base !== tok) rare.add(base);
    } else {
      rare.add(tok);
    }
  }

  const addTermsFrom = (text: string): string[] => {
    const words = wordTokens(text).filter(isSignificantWord);
    for (const w of words) terms.add(w);
    return words;
  };

  // Title words + bigrams.
  const titleWords = addTermsFrom(issue.title);
  for (let i = 0; i + 1 < titleWords.length; i++) {
    phrases.add(`${titleWords[i]} ${titleWords[i + 1]}`);
  }
  // Label words.
  for (const label of issue.labels) addTermsFrom(label.replace(/[-_]/g, " "));
  // Quoted strings: their words are terms, the whole string a phrase,
  // and any special token inside them is rare.
  for (const q of quotedStrings(allText)) {
    const words = addTermsFrom(q);
    if (words.length >= 2 && words.length <= 6) phrases.add(words.join(" "));
    for (const tok of specialTokens(q)) rare.add(tok);
  }
  // Error-ish lines in the body: quoted on their own by users often;
  // unquoted, only their special tokens count (already collected).

  return {
    rare: [...rare].slice(0, MAX_RARE),
    terms: [...terms].slice(0, MAX_TERMS),
    phrases: [...phrases].slice(0, MAX_PHRASES),
    files: [...files],
  };
}

export interface CandidateScore {
  verdict: "RACE" | "SUSPECT" | null;
  rareHits: string[];
  phraseHits: string[];
  termHits: string[];
  fileHits: string[];
}

/**
 * Score one open PR against the keyword set. Pure.
 *
 * RACE: >= 1 rare hit, >= 1 phrase hit, >= 2 term hits, or >= 1 shared
 * file. SUSPECT: exactly 1 term hit and nothing stronger. Everything
 * else is no match. Generic words can never appear here: they were
 * filtered out of the keyword set at extraction.
 */
export function scoreCandidate(
  keywords: KeywordSet,
  pr: { title: string; body: string },
  changedFiles?: string[]
): CandidateScore {
  const text = `${pr.title}\n${pr.body}`;
  const words = new Set(wordTokens(text));
  const specials = new Set(specialTokens(text));
  // Phrase stream: stopwords/generic words removed, so a phrase built
  // from an issue's significant words ("segmentation fault worker")
  // matches the same words in a PR even with stopwords between them
  // in the raw text ("segmentation fault in worker").
  const stream = wordTokens(text)
    .filter((w) => !STOPWORDS.has(w) && !GENERIC.has(w))
    .join(" ");

  const rareHits = keywords.rare.filter((r) => {
    if (specials.has(r)) return true;
    const base = r.split("/").pop()!;
    if (base !== r && specials.has(base)) return true;
    // A rare token with no dot/$ (identifier) matches as a whole word.
    if (!r.includes(".") && !r.includes("/") && words.has(r)) return true;
    return false;
  });
  const phraseHits = keywords.phrases.filter((p) => stream.includes(p));
  const phraseWords = new Set(phraseHits.flatMap((p) => p.split(" ")));
  const termHits = keywords.terms.filter((t) => words.has(t) && !phraseWords.has(t));

  const fileHits: string[] = [];
  if (changedFiles) {
    const bases = new Set(changedFiles.map((f) => f.split("/").pop()!.toLowerCase()));
    for (const f of keywords.files) {
      const base = f.split("/").pop()!;
      if (changedFiles.some((c) => c.toLowerCase() === f) || bases.has(base)) {
        fileHits.push(f);
      }
    }
  }

  let verdict: CandidateScore["verdict"] = null;
  if (rareHits.length >= 1 || phraseHits.length >= 1 || termHits.length >= 2 || fileHits.length >= 1) {
    verdict = "RACE";
  } else if (termHits.length === 1) {
    verdict = "SUSPECT";
  }
  return { verdict, rareHits, phraseHits, termHits, fileHits };
}

function evidenceFor(pr: RacePRCandidate, score: CandidateScore): string {
  const parts: string[] = [];
  if (score.rareHits.length > 0) parts.push(`rare term(s): ${score.rareHits.join(", ")}`);
  if (score.phraseHits.length > 0) parts.push(`phrase(s): ${score.phraseHits.map((p) => `"${p}"`).join(", ")}`);
  if (score.termHits.length > 0) parts.push(`keyword(s): ${score.termHits.join(", ")}`);
  if (score.fileHits.length > 0) parts.push(`shared file(s): ${score.fileHits.join(", ")}`);
  return (
    `#${pr.number} "${pr.title}" by @${pr.author} (created ${pr.createdAt.slice(0, 10)}, ${pr.url}) ` +
    `matched ${parts.join("; ")}`
  );
}

function toMatch(pr: RacePRCandidate, score: CandidateScore): RaceMatch {
  return {
    number: pr.number,
    title: pr.title,
    author: pr.author,
    createdAt: pr.createdAt,
    url: pr.url,
    verdict: score.verdict!,
    matchedKeywords: [
      ...new Set([...score.rareHits, ...score.phraseHits, ...score.termHits, ...score.fileHits]),
    ],
    rareHits: score.rareHits,
    phraseHits: score.phraseHits,
    termHits: score.termHits,
    fileHits: score.fileHits,
    evidence: evidenceFor(pr, score),
  };
}

// --- live defaults (apiGet-backed, cached like radar's) ---

interface RawIssueItem {
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  user?: { login?: unknown };
  number?: unknown;
  state?: unknown;
  created_at?: unknown;
  html_url?: unknown;
}

function toCandidate(item: RawIssueItem): RacePRCandidate {
  return {
    number: Number(item.number ?? 0),
    title: String(item.title ?? ""),
    body: String(item.body ?? ""),
    author: String(item.user?.login ?? "unknown"),
    createdAt: String(item.created_at ?? ""),
    url: String(item.html_url ?? ""),
  };
}

async function defaultFetchIssue(owner: string, repo: string, number: number): Promise<RaceIssue> {
  const key = [owner, repo, String(number), "race-issue"];
  const cached = cacheGet("issue", key) as RaceIssue | undefined;
  if (cached) return cached;
  const d = (await apiGet(`/repos/${owner}/${repo}/issues/${number}`)) as RawIssueItem;
  const labels = Array.isArray(d.labels)
    ? d.labels.map((l) =>
        typeof l === "string" ? l : String((l as { name?: unknown }).name ?? "")
      ).filter((s) => s.length > 0)
    : [];
  const issue: RaceIssue = {
    title: String(d.title ?? ""),
    body: String(d.body ?? ""),
    labels,
    author: String(d.user?.login ?? ""),
  };
  cacheSet("issue", key, issue);
  return issue;
}

/** The strongest keywords to seed GitHub search with: rare files first, then longest terms. */
export function searchSeeds(keywords: KeywordSet): string[] {
  const seeds: string[] = [];
  for (const f of keywords.files) {
    const base = f.split("/").pop()!;
    if (!seeds.includes(base)) seeds.push(base);
  }
  const byLength = [...keywords.terms].sort((a, b) => b.length - a.length);
  for (const t of byLength) {
    if (seeds.length >= 3) break;
    if (!seeds.includes(t)) seeds.push(t);
  }
  return seeds.slice(0, 3);
}

async function defaultSearchOpenPRs(
  owner: string,
  repo: string,
  keywords: KeywordSet
): Promise<RacePRCandidate[]> {
  const out = new Map<number, RacePRCandidate>();
  for (const seed of searchSeeds(keywords)) {
    try {
      const q = encodeURIComponent(`repo:${owner}/${repo} type:pr state:open ${seed}`);
      const data = (await apiGet(`/search/issues?q=${q}&per_page=20`)) as {
        items?: RawIssueItem[];
      };
      for (const item of data.items ?? []) {
        const c = toCandidate(item);
        if (c.number > 0) out.set(c.number, c);
      }
    } catch { /* search is best-effort; the list scan still runs */ }
  }
  return [...out.values()];
}

async function defaultListOpenPRs(
  owner: string,
  repo: string,
  limit: number
): Promise<RacePRCandidate[]> {
  const key = [owner, repo, `race-open-prs-${limit}`];
  const cached = cacheGet("search", key) as RacePRCandidate[] | undefined;
  if (cached) return cached;
  const out: RacePRCandidate[] = [];
  for (let page = 1; page <= 2 && out.length < limit; page++) {
    const data = (await apiGet(
      `/repos/${owner}/${repo}/pulls?state=open&sort=created&direction=desc&per_page=100&page=${page}`
    )) as RawIssueItem[];
    out.push(...(data ?? []).map(toCandidate));
    if ((data ?? []).length < 100) break;
  }
  const sliced = out.slice(0, limit);
  cacheSet("search", key, sliced);
  return sliced;
}

async function defaultFetchFiles(owner: string, repo: string, prNumber: number): Promise<string[]> {
  const key = [owner, repo, String(prNumber), "files"];
  const cached = cacheGet("search", key) as string[] | undefined;
  if (cached) return cached;
  const files: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const data = (await apiGet(
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`
    )) as Array<{ filename?: unknown }>;
    for (const f of data ?? []) {
      if (typeof f.filename === "string") files.push(f.filename);
    }
    if ((data ?? []).length < 100) break;
  }
  cacheSet("search", key, files);
  return files;
}

/**
 * The racecheck pipeline. Best-effort per source: a failed search or
 * list degrades to the other source; only an unreadable issue is an
 * ERROR. Changed files are fetched for at most MAX_FILE_FETCHES
 * text-matching candidates, and only when the issue names files.
 */
export async function racecheckIssue(
  owner: string,
  repo: string,
  number: number,
  deps: RacecheckDeps = {},
  opts: { limit?: number } = {}
): Promise<RacecheckResult> {
  const callsBefore = apiCallsUsed();
  const url = `https://github.com/${owner}/${repo}/issues/${number}`;
  const fetchIssue = deps.fetchIssue ?? defaultFetchIssue;
  const searchOpenPRs = deps.searchOpenPRs ?? defaultSearchOpenPRs;
  const listOpenPRs = deps.listOpenPRs ?? defaultListOpenPRs;
  const fetchFiles = deps.fetchFiles ?? defaultFetchFiles;
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PR_LIMIT, 200));

  let issue: RaceIssue;
  try {
    issue = await fetchIssue(owner, repo, number);
  } catch (err) {
    return {
      owner, repo, number, url, title: "",
      verdict: "ERROR",
      keywords: { rare: [], terms: [], phrases: [], files: [] },
      matches: [],
      reasons: [`racecheck issue fetch failed: ${err instanceof Error ? err.message : String(err)}`],
      apiCalls: apiCallsUsed() - callsBefore,
    };
  }

  const keywords = extractKeywords(issue);
  const done = (verdict: RaceVerdict, matches: RaceMatch[], reasons: string[]): RacecheckResult => ({
    owner, repo, number, url, title: issue.title,
    verdict, keywords, matches, reasons,
    apiCalls: apiCallsUsed() - callsBefore,
  });

  if (keywords.rare.length === 0 && keywords.terms.length === 0 && keywords.phrases.length === 0) {
    return done("CLEAR", [], ["no significant problem keywords could be extracted from the issue"]);
  }

  const byNumber = new Map<number, RacePRCandidate>();
  try {
    for (const c of await searchOpenPRs(owner, repo, keywords)) byNumber.set(c.number, c);
  } catch { /* best-effort */ }
  try {
    for (const c of await listOpenPRs(owner, repo, limit)) {
      if (!byNumber.has(c.number)) byNumber.set(c.number, c);
    }
  } catch { /* best-effort */ }

  const scored: Array<{ pr: RacePRCandidate; score: CandidateScore }> = [];
  for (const pr of byNumber.values()) {
    const score = scoreCandidate(keywords, pr);
    if (score.verdict) scored.push({ pr, score });
  }

  // File pass: only when the issue names files, capped at
  // MAX_FILE_FETCHES. Text-matching candidates go first; when the whole
  // candidate pool is small enough to fit the cap, unscored candidates
  // are checked too, so a pure file-overlap race (no keyword overlap at
  // all) is still caught where cheaply available. A shared file is RACE
  // evidence on its own.
  if (keywords.files.length > 0) {
    let fetches = 0;
    const tryFiles = async (pr: RacePRCandidate): Promise<CandidateScore | null> => {
      if (fetches >= MAX_FILE_FETCHES) return null;
      fetches++;
      try {
        return scoreCandidate(keywords, pr, await fetchFiles(owner, repo, pr.number));
      } catch {
        return null; // best-effort: text score stands
      }
    };
    for (const entry of scored) {
      const rescored = await tryFiles(entry.pr);
      if (rescored) entry.score = rescored;
    }
    if (byNumber.size <= MAX_FILE_FETCHES) {
      const scoredNumbers = new Set(scored.map((s) => s.pr.number));
      for (const pr of byNumber.values()) {
        if (scoredNumbers.has(pr.number)) continue;
        const rescored = await tryFiles(pr);
        if (rescored?.verdict) scored.push({ pr, score: rescored });
      }
    }
  }

  const matches = scored
    .filter((s) => s.score.verdict)
    .map((s) => toMatch(s.pr, s.score))
    .sort((a, b) => {
      if (a.verdict !== b.verdict) return a.verdict === "RACE" ? -1 : 1;
      return b.matchedKeywords.length - a.matchedKeywords.length || a.number - b.number;
    });

  if (matches.some((m) => m.verdict === "RACE")) {
    const races = matches.filter((m) => m.verdict === "RACE");
    return done("RACE", matches, [
      `keyword race: ${races.length} open PR(s) match this issue's problem keywords without linking it: ${races.map((m) => m.evidence).join("; ")}`,
    ]);
  }
  if (matches.length > 0) {
    return done("SUSPECT", matches, [
      `possible race: ${matches.map((m) => m.evidence).join("; ")}`,
    ]);
  }
  return done("CLEAR", [], [
    `no open PR matched the issue's problem keywords (rare: ${keywords.rare.join(", ") || "none"}; terms: ${keywords.terms.join(", ") || "none"})`,
  ]);
}

/**
 * Merge a racecheck result into a scan/xray verdict object (used by the
 * xray path, which scan --deep and wave ride on). The race verdict only
 * ever demotes: RACE lifts the target to TAKEN with the flag
 * "keyword-race"; SUSPECT lifts a CLEAR/GO target to RISKY with
 * "keyword-race-suspect". Returns true when the verdict changed.
 */
export function applyRaceDemotion(
  target: { verdict: string; reasons: string[]; flags: string[] },
  rc: RacecheckResult
): boolean {
  if (rc.verdict === "ERROR" || rc.matches.length === 0) return false;
  const top = rc.matches[0];
  if (rc.verdict === "RACE" && target.verdict !== "TAKEN") {
    target.verdict = "TAKEN";
    target.reasons = [
      `keyword race: open PR ${top.evidence} — it never links this issue, so link-based checks missed it`,
      ...target.reasons,
    ];
    if (!target.flags.includes("keyword-race")) target.flags.push("keyword-race");
    return true;
  }
  if (rc.verdict === "SUSPECT" && (target.verdict === "GO" || target.verdict === "CLEAR")) {
    target.verdict = "RISKY";
    target.reasons = [
      `possible keyword race: open PR ${top.evidence}`,
      ...target.reasons,
    ];
    if (!target.flags.includes("keyword-race-suspect")) target.flags.push("keyword-race-suspect");
    return true;
  }
  return false;
}
