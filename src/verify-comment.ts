/**
 * Verified-comment mode.
 *
 * Some repos take no outside PRs at all. The proven examples are
 * modelcontextprotocol/inspector ("Pull requests against this repo are
 * opened by the repo maintainers only") and modelcontextprotocol/servers
 * ("We accept issues, not pull requests"): outside PRs are closed on
 * sight, and the contribution that lands is a detailed, verified issue
 * comment instead — a reproduced problem, a located root cause, a
 * fix sketch, and honest notes on what was actually run.
 *
 * This module assembles that comment from contributor-supplied inputs.
 * It never posts anything (there is no post path), and it never invents
 * facts: any section the contributor did not fill renders as an explicit
 * gap marker ("not yet run", "not yet isolated", "not recorded") so a
 * maintainer can see exactly what is verified and what is not. A
 * plausible-looking filled-in section would be a lie; a labeled gap is
 * the product.
 */
import type { Gate } from "./types.js";

export interface VerifiedCommentFields {
  /** One-line claim of the problem (usually the issue title restated). */
  claim: string;
  /** Environment: repo, ref/commit, date, platform. */
  environment: string;
  /** Reproduction steps, in order, exact commands. */
  reproduction: string[];
  /** What was observed when the repro ran. */
  observed: string;
  /** What should have happened instead. */
  expected: string;
  /** Root cause: file paths and line refs when known. */
  rootCause: string;
  /** Proposed fix sketch, not a code dump. */
  fixSketch: string;
  /** What was actually run (commands, counts). */
  ran: string;
  /** Who ran it. */
  verifiedBy: string;
}

export type VerifiedCommentInput = Partial<VerifiedCommentFields>;

export interface BuiltComment {
  markdown: string;
  /** Names of sections that rendered as gap markers. */
  gaps: string[];
}

const GAP = (label: string) => `*${label}: not recorded*`;

function section(title: string, body: string, gaps: string[], gapName: string): string {
  if (body.trim().length === 0) gaps.push(gapName);
  return `## ${title}\n\n${body.trim().length > 0 ? body.trim() : GAP("not yet filled in")}\n`;
}

/**
 * Assemble the verified comment. Everything comes from the contributor's
 * inputs (or the --from-file parse); nothing is fetched and nothing is
 * invented. The greenlight version in the footer is a real fact about the
 * tool that assembled the comment, not a fact about the bug.
 */
export function buildVerifiedComment(
  issueUrl: string,
  fields: VerifiedCommentInput,
  greenlightVersion: string
): BuiltComment {
  const gaps: string[] = [];
  const f = (k: keyof VerifiedCommentFields): string =>
    (fields[k] as string | string[] | undefined) instanceof Array
      ? (fields[k] as string[]).join("\n")
      : ((fields[k] as string | undefined) ?? "").trim();

  const parts: string[] = [];
  parts.push(`<!-- greenlight-verified-comment v1 -->`);
  parts.push(`# Verified finding for ${issueUrl}`);
  parts.push(``);
  parts.push(
    section(
      "Claim of the problem",
      f("claim"),
      gaps,
      "claim"
    )
  );
  parts.push(
    section(
      "Environment",
      f("environment"),
      gaps,
      "environment"
    )
  );
  const repro = fields.reproduction ?? [];
  const reproBody =
    repro.length > 0
      ? repro.map((s, i) => `${i + 1}. ${s.trim()}`).join("\n")
      : `*Repro: not yet run*`;
  if (repro.length === 0) gaps.push("reproduction");
  parts.push(`## Reproduction\n\n${reproBody}\n`);
  parts.push(
    section(
      "Observed vs expected",
      [f("observed"), f("expected")].some((s) => s.length > 0)
        ? `**Observed:** ${f("observed") || "*not recorded*"}\n\n**Expected:** ${f("expected") || "*not recorded*"}`
        : "",
      gaps,
      "observed/expected"
    )
  );
  parts.push(
    section(
      "Root cause",
      f("rootCause"),
      gaps,
      "root-cause"
    ).replace("not yet filled in", "not yet isolated")
  );
  parts.push(
    section(
      "Proposed fix",
      f("fixSketch"),
      gaps,
      "fix-sketch"
    ).replace("not yet filled in", "not sketched yet")
  );
  const ran = f("ran");
  if (ran.length === 0) gaps.push("verification");
  const by = f("verifiedBy");
  parts.push(
    `## Verification\n\n` +
      `What was actually run: ${ran.length > 0 ? ran : "*not yet run*"}\n\n` +
      `Verified by: ${by.length > 0 ? by : "*contributor not stated*"}\n\n` +
      `---\n` +
      `*Comment drafted with Greenlight v${greenlightVersion} (verified-comment mode). ` +
      `Assembled locally from the contributor's notes; nothing here was posted automatically.*\n`
  );
  return { markdown: parts.join("\n"), gaps };
}

/**
 * True when the repo class is maintainer-only PRs: outside PRs are
 * refused on sight, so the useful contribution is a verified comment.
 * That is Greenlight's `collaborators_only` gate (inspector and servers
 * both land there: their policy text is matched by the gate parser).
 */
export function suggestsVerifiedComment(gates: Gate[]): boolean {
  return gates.some((g) => g.detected && g.kind === "collaborators_only");
}

/** The suggestion line check_issue prints for maintainer-only repos. */
export function verifiedCommentSuggestion(issueUrl: string): string {
  return `This repo takes verified comments instead of PRs: draft one with greenlight verify-comment ${issueUrl}`;
}

// ---------------------------------------------------------------------------
// --from-file parsing: headings map onto sections, everything else is kept.
// ---------------------------------------------------------------------------

const HEADING_MAP: Array<{ match: RegExp; field: keyof VerifiedCommentFields }> = [
  { match: /^(claim|problem|summary|title)$/i, field: "claim" },
  { match: /^(environment|env|setup|context)$/i, field: "environment" },
  { match: /^(repro|reproduction|reproduction steps|steps|how to reproduce)$/i, field: "reproduction" },
  { match: /^(observed)$/i, field: "observed" },
  { match: /^(expected)$/i, field: "expected" },
  { match: /^(observed vs expected|observed\/expected|behavior)$/i, field: "observed" },
  { match: /^(root cause|cause|analysis)$/i, field: "rootCause" },
  { match: /^(fix|proposed fix|fix sketch|proposal|solution)$/i, field: "fixSketch" },
  { match: /^(ran|verification|what was run|testing|test results)$/i, field: "ran" },
  { match: /^(by|verified by|author|contributor)$/i, field: "verifiedBy" },
];

export interface ParsedNoteFile {
  fields: VerifiedCommentInput;
  /** Sections that did not map to a known field, kept verbatim. */
  additionalNotes: string;
}

/**
 * Parse a markdown notes file into comment fields. Lines under a heading
 * map to that section; unmapped headings are preserved under
 * "Additional notes" instead of being dropped, so contributor content is
 * never silently lost. Unheaded text at the top of the file becomes the
 * claim.
 */
export function parseNoteFile(text: string): ParsedNoteFile {
  const fields: VerifiedCommentInput = {};
  const extras: string[] = [];
  const lines = text.split("\n");
  let current: { field: keyof VerifiedCommentFields | null; extraTitle: string | null } = {
    field: null,
    extraTitle: null,
  };
  const buffers = new Map<string, string[]>();
  const push = (key: string, line: string) => {
    const b = buffers.get(key) ?? [];
    b.push(line);
    buffers.set(key, b);
  };
  const flushExtra = () => {
    if (current.extraTitle) {
      const b = buffers.get(`extra:${current.extraTitle}`) ?? [];
      if (b.join("\n").trim().length > 0) {
        extras.push(`### ${current.extraTitle}\n\n${b.join("\n").trim()}`);
      }
      current.extraTitle = null;
    }
  };

  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flushExtra();
      const title = m[2].trim();
      const hit = HEADING_MAP.find((h) => h.match.test(title));
      current = hit
        ? { field: hit.field, extraTitle: null }
        : { field: null, extraTitle: title };
      if (!hit) buffers.set(`extra:${title}`, []);
      continue;
    }
    if (current.field) {
      push(current.field, line);
    } else if (current.extraTitle) {
      push(`extra:${current.extraTitle}`, line);
    } else {
      // Unheaded leading text: treat as the claim of the problem.
      push("claim", line);
    }
  }
  flushExtra();

  for (const [k, b] of buffers) {
    if (k.startsWith("extra:")) continue;
    const value = b.join("\n").trim();
    if (value.length === 0) continue;
    if (k === "reproduction") {
      fields.reproduction = value
        .split("\n")
        .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*])\s+/, "").trim())
        .filter((s) => s.length > 0);
    } else {
      (fields as Record<string, string>)[k] = value;
    }
  }
  return { fields, additionalNotes: extras.join("\n\n") };
}
