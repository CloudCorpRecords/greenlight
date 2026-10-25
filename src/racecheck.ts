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
 *   RACE    — strong match: 1 FILE-like rare term (filename,
 *             $-token), OR >= 2 distinct rare terms, OR 1 matched
 *             multi-word phrase, OR a shared changed file PLUS a rare
 *             or phrase hit, OR >= 3 term matches with at least two
 *             DISTINCTIVE terms derived from the issue TITLE.
 *             (v0.21.2: a single non-file rare term, and generic title
 *             vocabulary, no longer reach RACE alone — the bruno#9611
 *             "e.g" false-RACE fix.)
 *   SUSPECT — anything weaker: body-only term overlap (never RACE),
 *             a single term match, a shared file on its own or with
 *             only a bare term for company.
 *   CLEAR   — nothing.
 * Every non-CLEAR verdict quotes its evidence: PR number, title,
 * author, created date, and exactly which keywords matched.
 *
 * False-positive discipline (the radar "issue #2 from oauth2" lesson):
 * tokenization is delimiter-aware — "oauth2" is ONE token, never the
 * words "oauth" + "2"; pure numbers are never keywords; generic single
 * words are filtered at extraction, so a lone generic overlap cannot
 * reach RACE (it cannot even reach the match list).
 *
 * Precision pass (v0.20.1, from the v0.20.0 field failure): the first
 * version cried RACE on real repos (sloptotal #21/#22 and cubrid
 * #882/#859 all false-RACEd off template vocabulary like "ruff" and
 * "passes" in every PR body, label words like "help wanted", and
 * blob-URL path segments). Countermeasures, all pinned by tests:
 *   - GitHub label names are NEVER keywords (labels are not read).
 *   - URLs are stripped before harvesting; long or slash-bearing
 *     quoted strings contribute rare tokens only, never terms.
 *   - Owner/repo tokens and pure path segments (packages, kit, src,
 *     core, index, generated, blob, master, main) are never terms;
 *     generic config filenames (pyproject.toml, package.json, ...)
 *     and pure version tokens (3.10) are never rare.
 *   - Document-frequency suppression: a keyword appearing in more
 *     than ~25% of the repo's scanned open-PR bodies (and in at
 *     least 2 of them) is template boilerplate and is dropped
 *     before scoring.
 *
 * Dependency-bot exclusion (v0.21.1, from the residual v0.20.1 noise
 * item): in the sveltejs/kit #17465 battery, PR #17481 ("chore(deps):
 * update all non-major dependencies" by renovate[bot], branch
 * renovate/all-minor-patch) scored RACE. Its 51k-char body is a
 * dependency table plus the upstream release notes of the bumped
 * packages, and those notes happen to share enough problem vocabulary
 * with the issue (root, sync, trailing, output, empty, out: 6 term
 * hits, 2 of them title terms) to clear the RACE-by-terms bar. But a
 * dependency-update bot PR that changes only dependency manifests and
 * lockfiles cannot be implementing a feature or bug fix, so it can
 * never be a competitor. The pipeline therefore runs one extra pass
 * after scoring: a text-matching candidate that is bot-shaped
 * (dependency-bot author, or a renovate/* or dependabot/* branch)
 * gets its changed files fetched, and when every changed file is a
 * dependency manifest or lockfile the candidate is excluded from the
 * verdict and reported in ignoredMatches with the reason, instead of
 * driving RACE or SUSPECT. The check is deliberately narrow: it runs
 * only for bot-shaped candidates (so the extra API calls stay
 * bounded in huge queues), it never applies to human PRs, a bot PR
 * that touches any non-dependency file still counts in full, and an
 * unreadable or empty file list fails open (the candidate counts).
 */
import { apiCallsUsed, apiGet, cacheGet, cacheSet } from "./github.js";
import { canonicalRepoKey, type TrustStore } from "./trust.js";

export type RaceVerdict = "RACE" | "SUSPECT" | "CLEAR" | "ERROR" | "SKIP";

export interface KeywordSet {
  /** Rare tokens: filenames/paths, $-tokens, CamelCase/snake identifiers, quoted code. */
  rare: string[];
  /** Significant single words from the title and short quoted text. */
  terms: string[];
  /** Multi-word phrases (title bigrams, quoted strings). */
  phrases: string[];
  /** File paths/names named in the issue (full form as written). */
  files: string[];
  /** Subset of terms derived from the issue TITLE (RACE-by-terms needs one). */
  titleTerms?: string[];
  /** Subset of phrases derived from the issue TITLE. */
  titlePhrases?: string[];
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
  /** Head branch name (pulls API only; search results carry none). */
  headRef?: string;
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

/**
 * A text-matching candidate excluded from the verdict because it is a
 * dependency-update bot PR (v0.21.1): reported for transparency, never
 * a RACE or SUSPECT driver. Carries the full match shape plus why it
 * was ignored and the changed-file list that proved it dep-only.
 */
export interface IgnoredMatch extends RaceMatch {
  ignoreReason: string;
  changedFiles: string[];
}

/** One trust-memory entry the consult found for this repo. */
export interface RacecheckTrustEntry {
  dimension: "prs" | "comments" | "claims";
  state: string;
  label: string;
  source: string;
  evidence: string;
  checkedAt: string;
}

/**
 * The trust-memory consult result (Lane B), present on the result
 * only when the GREENLIGHT_TRUST_MEMORY flag was active for the run.
 */
export interface RacecheckTrustInfo {
  mode: "dry-run" | "on";
  repoKey: string;
  blocked: boolean;
  entries: RacecheckTrustEntry[];
  note: string;
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
  /** Dependency-bot PRs excluded from the verdict (v0.21.1). */
  ignoredMatches: IgnoredMatch[];
  reasons: string[];
  /** API calls consumed (measured, for budget honesty). */
  apiCalls: number;
  /** Trust-memory consult, only when the flag was active (Lane B). */
  trust?: RacecheckTrustInfo;
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
    "behavior,behaviour,happen,happens,happened,occur,occurs,occurred,see,seen,look,looks," +
    "documentation,docs,related,live,test,tests,testing,base,key,keys,value,values," +
    "type,types,help,wanted,hacktoberfest,beginner,beginners,write,writes,written," +
    "file,files,dir,without,select,tool,tools,import,imports,imported"
  ).split(",")
);

/**
 * Pure path segments and URL vocabulary: they describe where code
 * lives, never what the problem is. Never significant terms, and a
 * filename whose stem is one of these (index.js, main.py) is not a
 * rare token either.
 */
const PATH_SEGMENTS = new Set(
  (
    "packages,package,kit,src,core,index,generated,blob,master,main,lib,dist,build," +
    "github,http,https,www,com,org,io,dev,app,apps,mod,init"
  ).split(",")
);

/**
 * Ubiquitous project config filenames: named in countless issue and
 * PR bodies in any repo that has them. A body mention is no evidence
 * at all, so they are never rare terms and never named files here.
 */
const GENERIC_FILES = new Set(
  (
    "pyproject.toml,package.json,package-lock.json,yarn.lock,pnpm-lock.yaml," +
    "cargo.toml,cargo.lock,go.mod,go.sum,readme.md,changelog.md,license,licence," +
    "dockerfile,tsconfig.json,setup.py,setup.cfg,requirements.txt,composer.json," +
    "gemfile,gemfile.lock,pom.xml,build.gradle,makefile,.gitignore," +
    "agents.md,contributing.md,code_of_conduct.md,security.md,support.md," +
    // Framework-mandated route/entry filenames (SvelteKit +page/+layout
    // and kin): present in every app built on the framework, so a body
    // mention is convention, not signal.
    "page.svelte,page.js,page.ts,page.jsx,page.tsx,layout.svelte,layout.js," +
    "layout.ts,layout.jsx,layout.tsx,error.svelte,page.server.js,page.server.ts," +
    "layout.server.js,layout.server.ts"
  ).split(",")
);

/**
 * Filename stems that are generic across codebases (types.py,
 * utils.ts, index.js, main.py, __init__.py): the package's own
 * plumbing modules, touched by half the PRs in a repo. A $-prefixed
 * name ($types.d.ts) is exempt: the $ marks a specific generated
 * artifact, not plumbing.
 */
const GENERIC_FILE_STEMS = new Set([
  ...PATH_SEGMENTS,
  "types", "type", "utils", "util", "helpers", "common", "base",
]);

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
  // Long hex strings are commit SHAs quoted as evidence, not words.
  if (/^[0-9a-f]{20,}$/.test(w) && /[a-f]/.test(w) && /\d/.test(w)) return false;
  return (
    w.length >= 3 &&
    !/^\d+$/.test(w) &&
    !STOPWORDS.has(w) &&
    !GENERIC.has(w) &&
    !PATH_SEGMENTS.has(w)
  );
}

/**
 * Special tokens from raw text: dotted filenames and paths, $-tokens,
 * CamelCase and snake_case identifiers. These are the rare terms: one
 * hit is already race evidence.
 */
/**
 * Prose abbreviations that look like dotted identifiers to the regex
 * below ("e.g." -> "e.g", "i.e." -> "i.e"). They are ordinary English,
 * never filenames or identifiers (v0.21.2, GL-1: the bruno#9611 false
 * RACE was built entirely on "e.g" harvested from issue prose).
 */
const PROSE_ABBREVIATIONS = new Set(
  (
    "e.g,i.e,etc,vs,approx,fig,figs,dr,mr,mrs,ms,prof,sr,jr,st,inc,ltd,corp," +
    "no,nos,vol,pp,a.m,p.m,u.s,u.k,ph.d,m.d,ed,eds,al,ca"
  ).split(",")
);

export function specialTokens(text: string): string[] {
  const out = new Set<string>();
  const dotted = /[A-Za-z0-9_$][A-Za-z0-9_$./-]*\.[A-Za-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = dotted.exec(text)) !== null) {
    const tok = m[0].replace(/[.\-/]+$/, "").toLowerCase();
    // A dotted token needs a letter: pure version strings (3.10,
    // 0.20.0) are not identifiers and never rare.
    if (tok.length < 3 || !/[a-z]/.test(tok)) continue;
    // Prose abbreviations are not rare tokens (v0.21.2): a denylist,
    // plus the structural rule that a token whose every dot-segment is
    // a single letter (e.g, i.e, u.s.a) is an abbreviation, not a file
    // or identifier — real dotted names have a longer segment (d.ts,
    // importer.ts, $types.d.ts).
    if (PROSE_ABBREVIATIONS.has(tok)) continue;
    if (tok.split(".").every((s) => s.length <= 1)) continue;
    out.add(tok);
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

/**
 * A token is usable as a rare file/identifier only when it is not
 * generic on its face: ubiquitous config filenames (pyproject.toml)
 * and files whose stem is a pure path segment (index.js, main.py)
 * carry no problem signal.
 */
function isGenericFileToken(tok: string): boolean {
  const base = tok.split("/").pop()!;
  if (GENERIC_FILES.has(base)) return true;
  if (base.startsWith("$")) return false; // $-artifacts are specific, never plumbing
  const stem = base.split(".")[0].replace(/^_+|_+$/g, "");
  return GENERIC_FILE_STEMS.has(stem);
}

/**
 * Strip URLs before harvesting. A URL's path segments are where code
 * lives, not what the problem is (the v0.20.0 svelte run harvested
 * packages/kit/src/core/index/generated from one blob URL). Only the
 * basename survives, so a filename a URL points at can still count as
 * a rare token.
 */
export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s)>"'`]+/g, (u) => {
    const clean = u.replace(/[.,;:]+$/, "");
    const base = clean.split("/").pop() ?? "";
    return /[a-z]/i.test(base) && base.includes(".") ? ` ${base} ` : " ";
  });
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
 * title and from SHORT quoted strings; body prose contributes words
 * only when quoted or identifier-shaped, so a long generic body
 * cannot flood the term list with noise.
 *
 * v0.20.1 discipline:
 * - Labels are never read: GitHub label names (help wanted, good
 *   first issue, hacktoberfest, beginner, easy) are triage
 *   vocabulary, not problem vocabulary.
 * - URLs are stripped first (basename kept for rare tokens).
 * - A quoted string longer than ~40 chars, or containing "/" or
 *   "http", contributes NO terms or phrases; filenames and
 *   identifiers inside it still count as rare (via the global
 *   special-token scan).
 * - Owner and repo name tokens are never keywords.
 * - Generic config filenames and path-stem files are never rare.
 */
export function extractKeywords(
  issue: RaceIssue,
  opts: { owner?: string; repo?: string } = {}
): KeywordSet {
  const rare = new Set<string>();
  const files = new Set<string>();
  const terms = new Set<string>();
  const phrases = new Set<string>();
  const titleTerms = new Set<string>();
  const titlePhrases = new Set<string>();

  const blocked = new Set<string>();
  for (const part of [opts.owner ?? "", opts.repo ?? ""]) {
    for (const tok of wordTokens(part.replace(/[-_]/g, " "))) blocked.add(tok);
    if (part) blocked.add(part.toLowerCase());
  }

  // The repo's own package prefix (sqlalchemy_cubrid.*, the
  // sqlalchemy-cubrid package) is address, not signal: strip it and
  // keep only the distinctive remainder (timestamptz), dropping the
  // token entirely when nothing distinctive remains (the package
  // itself, its types module, its __init__).
  const pkgPrefix = opts.repo ? opts.repo.toLowerCase().replace(/-/g, "_") : null;
  const normalizeSpecial = (raw: string): string | null => {
    let tok = raw;
    if (pkgPrefix && (tok === pkgPrefix || tok.startsWith(`${pkgPrefix}.`) || tok.startsWith(`${pkgPrefix}/`))) {
      const rest = tok.slice(pkgPrefix.length).replace(/^[./]+/, "");
      if (!rest) return null;
      tok = rest;
      // A plain remainder word counts only when it is a real word
      // (timestamptz yes; types no, it is generic vocabulary).
      if (!/[./$]/.test(tok) && !isSignificantWord(tok)) return null;
    }
    return tok;
  };

  const allText = stripUrls(`${issue.title}\n${issue.body}`);
  for (const rawTok of specialTokens(allText)) {
    const tok = normalizeSpecial(rawTok);
    if (tok === null || blocked.has(tok)) continue;
    if (looksLikeFile(tok)) {
      if (isGenericFileToken(tok)) continue;
      files.add(tok);
      rare.add(tok);
      const base = tok.split("/").pop()!;
      if (base !== tok && !isGenericFileToken(base)) rare.add(base);
    } else {
      rare.add(tok);
    }
  }

  const addTermsFrom = (text: string, track?: Set<string>): string[] => {
    const words = wordTokens(text).filter((w) => isSignificantWord(w) && !blocked.has(w));
    for (const w of words) {
      terms.add(w);
      track?.add(w);
    }
    return words;
  };

  // Title words + bigrams (tracked: RACE-by-terms needs a title term).
  const titleWords = addTermsFrom(issue.title, titleTerms);
  for (let i = 0; i + 1 < titleWords.length; i++) {
    const p = `${titleWords[i]} ${titleWords[i + 1]}`;
    phrases.add(p);
    titlePhrases.add(p);
  }
  // Quoted strings: short, slash-free ones contribute terms and a
  // phrase. Long or URL/path-bearing quotes contribute nothing here;
  // their special tokens were already collected as rare above.
  for (const q of quotedStrings(allText)) {
    if (q.length > 40 || q.includes("/") || q.includes("http")) continue;
    // A quoted single dotted token is a filename or identifier
    // (`pyproject.toml`): its segments are not terms.
    if (!/\s/.test(q) && q.includes(".")) continue;
    const words = addTermsFrom(q);
    if (words.length >= 2 && words.length <= 6) phrases.add(words.join(" "));
    for (const rawTok of specialTokens(q)) {
      const tok = normalizeSpecial(rawTok);
      if (tok !== null && !blocked.has(tok) && !isGenericFileToken(tok)) rare.add(tok);
    }
  }
  // Error-ish lines in the body: quoted on their own by users often;
  // unquoted, only their special tokens count (already collected).

  return {
    rare: [...rare].slice(0, MAX_RARE),
    terms: [...terms].slice(0, MAX_TERMS),
    phrases: [...phrases].slice(0, MAX_PHRASES),
    files: [...files],
    titleTerms: [...titleTerms],
    titlePhrases: [...titlePhrases],
  };
}

export interface CandidateScore {
  verdict: "RACE" | "SUSPECT" | null;
  rareHits: string[];
  phraseHits: string[];
  termHits: string[];
  /** Subset of termHits derived from the issue title. */
  titleTermHits: string[];
  fileHits: string[];
}

/**
 * Phrase stream for a text: stopwords/generic/path words removed, so
 * a phrase built from an issue's significant words ("segmentation
 * fault worker") matches the same words in a PR even with stopwords
 * between them in the raw text ("segmentation fault in worker").
 */
export function significantStream(text: string): string {
  return wordTokens(text)
    .filter((w) => !STOPWORDS.has(w) && !GENERIC.has(w) && !PATH_SEGMENTS.has(w))
    .join(" ");
}

function rareHitsIn(rare: string[], text: string): string[] {
  const words = new Set(wordTokens(text));
  const specials = new Set(specialTokens(text));
  return rare.filter((r) => {
    if (specials.has(r)) return true;
    const base = r.split("/").pop()!;
    if (base !== r && specials.has(base)) return true;
    // A rare token with no dot/$ (identifier) matches as a whole word.
    if (!r.includes(".") && !r.includes("/") && words.has(r)) return true;
    return false;
  });
}

/**
 * Score one open PR against the keyword set. Pure.
 *
 * RACE (v0.20.1 thresholds): >= 1 rare hit, >= 1 phrase hit, a shared
 * changed file PLUS a rare or phrase hit, or >= 3 term hits with at
 * least TWO of them derived from the issue TITLE. (The v0.20.0 bar,
 * any 2 terms, false-fired constantly on verbose issues: with a long
 * harvested term list, unrelated PRs clear 2 hits by chance; title
 * terms are the issue's own summary of the problem, so two of them
 * plus a third hit is the honest signal.) Body-only term overlap can
 * never pass SUSPECT: body vocabulary is where template boilerplate
 * lives. A shared file plus only a bare term is also SUSPECT, not
 * RACE (field evidence, cubrid #882 vs PR #980: same central module,
 * one shared word "reflected", completely different change;
 * adjacency is not a race). SUSPECT: any weaker hit. Generic words
 * can never appear here: they were filtered out at extraction.
 */
export function scoreCandidate(
  keywords: KeywordSet,
  pr: { title: string; body: string },
  changedFiles?: string[]
): CandidateScore {
  const text = `${pr.title}\n${pr.body}`;
  const words = new Set(wordTokens(text));
  const stream = significantStream(text);

  const rareHits = rareHitsIn(keywords.rare, text);
  const phraseHits = keywords.phrases.filter((p) => stream.includes(p));
  const phraseWords = new Set(phraseHits.flatMap((p) => p.split(" ")));
  const termHits = keywords.terms.filter((t) => words.has(t) && !phraseWords.has(t));
  const titleTerms = new Set(keywords.titleTerms ?? keywords.terms);
  const titleTermHits = termHits.filter((t) => titleTerms.has(t));

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

  const otherHits = rareHits.length + phraseHits.length + termHits.length;
  // v0.21.2 (GL-1): a NON-file rare hit alone is no longer RACE-grade.
  // A single identifier/abbreviation-shaped token appearing in a PR
  // body is weak evidence (bruno#9611: 15 unrelated PRs "raced" on one
  // harvested token). File-like rare hits (a named file, a $-artifact)
  // stay RACE-grade alone — a PR naming the issue's file is specific
  // in a way a bare word never is. Non-file rare hits need
  // corroboration: a second distinct rare hit, a phrase hit, or a
  // shared changed file (the file-hit branch below).
  const fileRareHits = rareHits.filter((r) => looksLikeFile(r) || keywords.files.includes(r));
  // Term-only RACE needs DISTINCTIVE title terms (v0.21.2, GL-1):
  // generic tech vocabulary (adapter, platform, proxy, env, reloads…)
  // appears in every third PR in a repo and cannot carry a RACE on its
  // own — svelte "Version Packages" and an @font-face PR both cleared
  // the old bar on such words alone.
  const distinctiveTitleTermHits = titleTermHits.filter((t) => !NON_DISTINCTIVE_TERMS.has(t));
  // Same floor for TITLE-derived phrases (v0.21.3): title bigrams are
  // generated mechanically from title words, so a bigram built only of
  // generic words ("adapter cloudflare", "platform proxy") is generic
  // vocabulary in sequence, not a distinctive phrase — svelte's
  // "Version Packages" release train matched three of them verbatim.
  // Author-QUOTED phrases are exempt: a quoted string is a deliberate
  // artifact (usually error text), and keeps single-hit RACE grade.
  const titlePhraseSet = new Set(keywords.titlePhrases ?? []);
  const strongPhraseHits = phraseHits.filter(
    (p) => !titlePhraseSet.has(p) || p.split(" ").some((w) => !NON_DISTINCTIVE_TERMS.has(w))
  );
  let verdict: CandidateScore["verdict"] = null;
  if (
    fileRareHits.length >= 1 ||
    strongPhraseHits.length >= 1 ||
    rareHits.length >= 2 ||
    (fileHits.length >= 1 && rareHits.length + phraseHits.length >= 1) ||
    // v0.21.4: a shared changed file PLUS strong term overlap is RACE
    // even when every term is generic — the changed file (the exact
    // file the issue names) is itself the distinctive evidence, and
    // the >=3 term / >=2 title-term bar keeps the v0.20.1 cubrid
    // lesson (file + one bare term = SUSPECT) intact. This is the
    // sveltejs/kit#17530 shape: the triage-bot racer changes
    // virtual-cloudflare-workers.js and overlaps the issue's
    // vendor-flavored title vocabulary.
    (fileHits.length >= 1 && termHits.length >= 3 && titleTermHits.length >= 2) ||
    (termHits.length >= 3 && titleTermHits.length >= 2 && distinctiveTitleTermHits.length >= 2)
  ) {
    verdict = "RACE";
  } else if (otherHits >= 1 || fileHits.length >= 1) {
    verdict = "SUSPECT";
  }
  return { verdict, rareHits, phraseHits, termHits, titleTermHits, fileHits };
}

/**
 * Ordinary tech/English vocabulary that is never distinctive enough to
 * carry a term-only RACE (v0.21.2): these words describe where code
 * runs and how software generally behaves, not what one specific
 * problem is. Used only as a floor on the RACE-by-terms branch;
 * extraction and SUSPECT grading are unaffected.
 */
const NON_DISTINCTIVE_TERMS = new Set(
  (
    "adapter,adapters,platform,platforms,proxy,proxies,env,environment,environments," +
    "keeps,keep,keeping,reload,reloads,reloaded,reloading,version,versions,package," +
    "packages,release,releases,server,servers,client,clients,browser,window,windows," +
    "load,loads,loading,loaded,dev,development,build,builds,building,config," +
    "configuration,configurations,data,state,states,local,remote,public,private," +
    "image,images,api,apis,service,services,default,defaults,custom,current,list," +
    "lists,view,views,web,project,projects,module,modules,library,libraries," +
    "framework,frameworks,system,systems,start,starts,starting,stop,stops,stopped," +
    // Vendor/platform names: in any repo that integrates them they are
    // the shared substrate vocabulary of a third of the PR queue
    // (cloudflare/wrangler in sveltejs/kit), not one problem's signal.
    // They stay RACE-grade in file paths, rare tokens and quoted
    // phrases — this floor only governs title terms and title phrases.
    "cloudflare,wrangler,vercel,netlify,aws,azure,gcp,firebase,supabase,docker,kubernetes"
  ).split(",")
);

/**
 * Document-frequency suppression (v0.20.1). A keyword that appears in
 * more than `threshold` (default 25%) of the repo's scanned open-PR
 * bodies, and in at least 2 of them, is template boilerplate for that
 * repo (every PR body says "ruff check passes") and is dropped before
 * scoring. Distinctive keywords survive: a real competitor's problem
 * words appear in a handful of bodies, not a quarter of the queue.
 * Pure; the pipeline feeds it the merged candidate pool.
 */
export function suppressByDocumentFrequency(
  keywords: KeywordSet,
  corpus: Array<{ title: string; body: string }>,
  threshold = 0.25
): { keywords: KeywordSet; suppressed: string[] } {
  if (corpus.length === 0) return { keywords, suppressed: [] };
  const texts = corpus.map((c) => `${c.title}\n${c.body}`);
  const wordSets = texts.map((t) => new Set(wordTokens(t)));
  const streams = texts.map((t) => significantStream(t));
  const df = (count: number) => count >= 2 && count / texts.length > threshold;

  const suppressed: string[] = [];
  const drop = (list: string[], present: (item: string, i: number) => boolean): string[] =>
    list.filter((item) => {
      let count = 0;
      for (let i = 0; i < texts.length; i++) if (present(item, i)) count++;
      if (df(count)) {
        suppressed.push(item);
        return false;
      }
      return true;
    });

  const terms = drop(keywords.terms, (t, i) => wordSets[i].has(t));
  const phrases = drop(keywords.phrases, (p, i) => streams[i].includes(p));
  const rare = drop(keywords.rare, (r, i) => rareHitsIn([r], texts[i]).length > 0);
  // Files are exempt: their evidence comes from changed-file lists,
  // not body text, and generic files never reach the file list.
  const keptTerms = new Set(terms);
  const keptPhrases = new Set(phrases);
  return {
    keywords: {
      ...keywords,
      rare,
      terms,
      phrases,
      titleTerms: (keywords.titleTerms ?? []).filter((t) => keptTerms.has(t)),
      titlePhrases: (keywords.titlePhrases ?? []).filter((p) => keptPhrases.has(p)),
    },
    suppressed,
  };
}

/**
 * Dependency-update bot detection (v0.21.1). A candidate is
 * "bot-shaped" when its author is a known dependency bot login (or a
 * similar [bot] login naming renovate or dependabot), or when its
 * head branch lives under renovate/ or dependabot/. Bot shape alone
 * never excludes anything: it only selects the candidates whose
 * changed files are worth one extra fetch.
 */
const DEPENDENCY_BOT_LOGINS = new Set([
  "renovate[bot]",
  "dependabot[bot]",
  "dependabot-preview[bot]",
  "renovate-bot",
  "dependabot",
]);

export function isDependencyBotAuthor(author: string): boolean {
  const a = author.toLowerCase();
  if (DEPENDENCY_BOT_LOGINS.has(a)) return true;
  return a.endsWith("[bot]") && (a.includes("renovate") || a.includes("dependabot"));
}

export function isDependencyBotBranch(headRef?: string): boolean {
  if (!headRef) return false;
  const b = headRef.toLowerCase();
  return (
    b === "renovate" ||
    b === "dependabot" ||
    b.startsWith("renovate/") ||
    b.startsWith("dependabot/")
  );
}

export function isBotShapedDependencyCandidate(pr: {
  author: string;
  headRef?: string;
}): boolean {
  return isDependencyBotAuthor(pr.author) || isDependencyBotBranch(pr.headRef);
}

/**
 * Dependency manifests and lockfiles, by basename: the complete set
 * of files a dependency-update bot PR may touch while still being
 * incapable of implementing an issue fix. Anything outside this set
 * (source, tests, docs, workflows, config with logic) keeps the PR in
 * the race.
 */
const DEPENDENCY_FILE_BASENAMES = new Set([
  // JavaScript / TypeScript
  "package.json", "package-lock.json", "npm-shrinkwrap.json",
  "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock",
  "bun.lockb", "bun.lock", "deno.lock",
  // Rust
  "cargo.toml", "cargo.lock",
  // Go
  "go.mod", "go.sum",
  // Python
  "pipfile", "pipfile.lock", "poetry.lock", "uv.lock", "pdm.lock",
  // PHP
  "composer.json", "composer.lock",
  // Ruby
  "gemfile", "gemfile.lock",
  // JVM
  "pom.xml", "build.gradle", "build.gradle.kts", "gradle.lockfile",
  // .NET
  "packages.lock.json",
]);

export function isDependencyFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  const base = lower.split("/").pop() ?? "";
  if (DEPENDENCY_FILE_BASENAMES.has(base)) return true;
  // Python requirements and constraints files: requirements.txt,
  // requirements-dev.txt, and friends at any depth, plus any .txt
  // inside a requirements/ directory (requirements/base.txt).
  if (/^requirements[^/]*\.txt$/.test(base)) return true;
  if (/^constraints[^/]*\.txt$/.test(base)) return true;
  if (/(^|\/)requirements\/[^/]+\.txt$/.test(lower)) return true;
  return false;
}

/**
 * True only for a non-empty file list in which every file is a
 * dependency manifest or lockfile. An empty list proves nothing (the
 * fetch may have failed or been stubbed), so it never excludes.
 */
export function isDependencyOnlyFileList(files: string[]): boolean {
  return files.length > 0 && files.every((f) => isDependencyFile(f));
}

/** The full exclusion predicate: bot-shaped AND provably dep-only. */
export function isDependencyUpdateBotPR(
  pr: { author: string; headRef?: string },
  changedFiles: string[]
): boolean {
  return isBotShapedDependencyCandidate(pr) && isDependencyOnlyFileList(changedFiles);
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
  head?: { ref?: unknown };
}

function toCandidate(item: RawIssueItem): RacePRCandidate {
  return {
    number: Number(item.number ?? 0),
    title: String(item.title ?? ""),
    body: String(item.body ?? ""),
    author: String(item.user?.login ?? "unknown"),
    createdAt: String(item.created_at ?? ""),
    url: String(item.html_url ?? ""),
    headRef: typeof item.head?.ref === "string" ? item.head.ref : undefined,
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
 * One further bounded fetch set: each bot-shaped scored candidate
 * (dependency-bot author or branch) gets one files fetch for the
 * v0.21.1 dep-only exclusion check.
 */
export async function racecheckIssue(
  owner: string,
  repo: string,
  number: number,
  deps: RacecheckDeps = {},
  opts: { limit?: number; trustMode?: "off" | "dry-run" | "on"; trustStore?: TrustStore } = {}
): Promise<RacecheckResult> {
  const callsBefore = apiCallsUsed();
  const url = `https://github.com/${owner}/${repo}/issues/${number}`;
  const fetchIssue = deps.fetchIssue ?? defaultFetchIssue;
  const searchOpenPRs = deps.searchOpenPRs ?? defaultSearchOpenPRs;
  const listOpenPRs = deps.listOpenPRs ?? defaultListOpenPRs;
  const fetchFiles = deps.fetchFiles ?? defaultFetchFiles;
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PR_LIMIT, 200));

  // Trust memory consult (Lane B of the dyva-patterns plan, behind
  // the GREENLIGHT_TRUST_MEMORY flag): racecheck asks the trust
  // store about this repo on the claims and prs dimensions BEFORE
  // vetting. A blocked mark means the repo is known hostile, so
  // mode "on" returns SKIP before a single API call is spent
  // reading comments or PR lists. Mode "dry-run" records the
  // consult on the result and vets exactly as before. With the
  // flag off (the default) or no store supplied, this block never
  // runs and behavior is unchanged.
  let trustInfo: RacecheckTrustInfo | undefined;
  const trustMode = opts.trustMode ?? "off";
  if (trustMode !== "off" && opts.trustStore) {
    const repoKey = canonicalRepoKey(`${owner}/${repo}`);
    const entries: RacecheckTrustEntry[] = [];
    for (const dimension of ["claims", "prs"] as const) {
      const d = opts.trustStore.derive(dimension, repoKey);
      if (d) {
        entries.push({
          dimension: d.dimension,
          state: d.state,
          label: d.label,
          source: d.source,
          evidence: d.evidence,
          checkedAt: d.checkedAt,
        });
      }
    }
    const blockedEntry = entries.find((e) => e.state === "blocked");
    trustInfo = {
      mode: trustMode,
      repoKey,
      blocked: blockedEntry !== undefined,
      entries,
      note: blockedEntry
        ? `trust memory: ${repoKey} is blocked on the ${blockedEntry.dimension} dimension (${blockedEntry.label}, source ${blockedEntry.source}, checked ${blockedEntry.checkedAt.slice(0, 10)}): ${blockedEntry.evidence}`
        : `trust memory: no blocked mark for ${repoKey}`,
    };
    if (trustInfo.blocked && trustMode === "on") {
      return {
        owner, repo, number, url, title: "",
        verdict: "SKIP",
        keywords: { rare: [], terms: [], phrases: [], files: [] },
        matches: [],
        ignoredMatches: [],
        reasons: [`${trustInfo.note}; skipped before vetting, no API calls spent`],
        apiCalls: 0,
        trust: trustInfo,
      };
    }
  }

  let issue: RaceIssue;
  try {
    issue = await fetchIssue(owner, repo, number);
  } catch (err) {
    return {
      owner, repo, number, url, title: "",
      verdict: "ERROR",
      keywords: { rare: [], terms: [], phrases: [], files: [] },
      matches: [],
      ignoredMatches: [],
      reasons: [`racecheck issue fetch failed: ${err instanceof Error ? err.message : String(err)}`],
      apiCalls: apiCallsUsed() - callsBefore,
      ...(trustInfo ? { trust: trustInfo } : {}),
    };
  }

  let keywords = extractKeywords(issue, { owner, repo });
  let suppressed: string[] = [];
  let ignoredMatches: IgnoredMatch[] = [];
  const done = (verdict: RaceVerdict, matches: RaceMatch[], reasons: string[]): RacecheckResult => ({
    owner, repo, number, url, title: issue.title,
    verdict, keywords, matches, ignoredMatches,
    reasons:
      trustInfo && trustInfo.blocked && trustInfo.mode === "dry-run"
        ? [`${trustInfo.note}; dry-run only, the verdict below is unchanged`, ...reasons]
        : reasons,
    apiCalls: apiCallsUsed() - callsBefore,
    ...(trustInfo ? { trust: trustInfo } : {}),
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
      const existing = byNumber.get(c.number);
      if (!existing) {
        byNumber.set(c.number, c);
      } else if (!existing.headRef && c.headRef) {
        // Search results carry no head branch; the list copy does, and
        // the branch is half of the dependency-bot shape test.
        existing.headRef = c.headRef;
      }
    }
  } catch { /* best-effort */ }

  // Document-frequency suppression over the scanned pool: keywords
  // living in more than ~25% of this repo's open-PR bodies are
  // template boilerplate, not problem signal (v0.20.1).
  const dfResult = suppressByDocumentFrequency(keywords, [...byNumber.values()]);
  keywords = dfResult.keywords;
  suppressed = dfResult.suppressed;
  const suppressionNote =
    suppressed.length > 0
      ? `document-frequency suppression dropped ${suppressed.length} boilerplate keyword(s) present in >25% of scanned open PRs: ${suppressed.join(", ")}`
      : null;

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

  // Dependency-bot exclusion pass (v0.21.1): a scored candidate that
  // is bot-shaped gets its changed files fetched (one extra call per
  // bot-shaped match, so the cost stays bounded in huge queues), and
  // a provably dep-only file list moves it out of the verdict into
  // ignoredMatches. A fetch failure or an empty or source-bearing
  // file list fails open: the candidate keeps its score.
  const kept: Array<{ pr: RacePRCandidate; score: CandidateScore }> = [];
  for (const entry of scored) {
    if (!isBotShapedDependencyCandidate(entry.pr)) {
      kept.push(entry);
      continue;
    }
    let files: string[] | null = null;
    try {
      files = await fetchFiles(owner, repo, entry.pr.number);
    } catch {
      files = null; // best-effort: unproven shape keeps its score
    }
    if (files !== null && isDependencyOnlyFileList(files)) {
      const match = toMatch(entry.pr, entry.score);
      ignoredMatches.push({
        ...match,
        ignoreReason:
          `dependency-update bot PR (@${entry.pr.author}` +
          `${entry.pr.headRef ? `, branch ${entry.pr.headRef}` : ""}) changing only ` +
          `dependency manifests and lockfiles: ${files.join(", ")}; ` +
          `a dep-only change cannot implement this issue`,
        changedFiles: files,
      });
    } else {
      kept.push(entry);
    }
  }

  const matches = kept
    .filter((s) => s.score.verdict)
    .map((s) => toMatch(s.pr, s.score))
    .sort((a, b) => {
      if (a.verdict !== b.verdict) return a.verdict === "RACE" ? -1 : 1;
      return b.matchedKeywords.length - a.matchedKeywords.length || a.number - b.number;
    });

  const ignoredNote =
    ignoredMatches.length > 0
      ? `ignored ${ignoredMatches.length} dependency-update bot PR(s) that cannot implement this issue: ${ignoredMatches.map((m) => `#${m.number} by @${m.author} (${m.ignoreReason})`).join("; ")}`
      : null;
  const withNote = (reasons: string[]): string[] => {
    const out = [...reasons];
    if (suppressionNote) out.push(suppressionNote);
    if (ignoredNote) out.push(ignoredNote);
    return out;
  };
  if (matches.some((m) => m.verdict === "RACE")) {
    const races = matches.filter((m) => m.verdict === "RACE");
    return done("RACE", matches, withNote([
      `keyword race: ${races.length} open PR(s) match this issue's problem keywords without linking it: ${races.map((m) => m.evidence).join("; ")}`,
    ]));
  }
  if (matches.length > 0) {
    return done("SUSPECT", matches, withNote([
      `possible race: ${matches.map((m) => m.evidence).join("; ")}`,
    ]));
  }
  return done("CLEAR", [], withNote([
    `no open PR matched the issue's problem keywords (rare: ${keywords.rare.join(", ") || "none"}; terms: ${keywords.terms.join(", ") || "none"})`,
  ]));
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
