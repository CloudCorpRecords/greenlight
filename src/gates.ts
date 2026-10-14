/**
 * CONTRIBUTING.md gate parser.
 *
 * Problem this solves: repos have unwritten rituals before an outside PR is
 * even allowed, and they differ per repo. FastMCP requires assignment
 * (PrefectHQ/fastmcp#4557). trigger.dev auto-closes PRs from unvouched
 * authors. modelcontextprotocol/servers and
 * openai/openai-agents-python are collaborators-only for PR creation.
 * shadcn-labs/pdfcn asks contributors to comment before starting work:
 * that is a soft claim-first ritual, satisfied by posting a comment, not a
 * hard assignment gate. This parser extracts those gates from contributing
 * text so the verdict engine can flag GATED instead of letting you code
 * first and get rejected, while soft gates like claim_first only add a note.
 */
import type { Gate, GateKind } from "./types.js";

interface GateRule {
  kind: GateKind;
  regexes: RegExp[];
}

const RULES: GateRule[] = [
  {
    kind: "assignment_required",
    regexes: [
      /ask (to be|for) (assigned|assignment)/i,
      /request (an )?assignment/i,
      /must be assigned/i,
      /assign.*before (submitting|opening|a PR)/i,
      /please (wait|hold) (for|until).*assign/i,
      /\bgood first issue\b.{0,40}\bassign/i,
    ],
  },
  {
    // Soft ritual: comment (or claim) on the issue before starting work.
    // Satisfied by posting a comment; never a hard block.
    kind: "claim_first",
    regexes: [
      /comment.{0,60}before (starting|working|opening)/i,
      /claim.*before (you )?start/i,
      /comment.{0,60}before you (start|code|submit)/i,
    ],
  },
  {
    kind: "vouch_required",
    regexes: [/\bvouch/i, /vouched (author|contributor)/i],
  },
  {
    kind: "cla_required",
    regexes: [
      /contributor license agreement/i,
      /\bcla\b.{0,20}(sign|require)/i,
      /sign.{0,20}\bcla\b/i,
    ],
  },
  {
    kind: "dco_required",
    regexes: [
      /\bdco\b/i,
      /developer certificate of origin/i,
      /sign-?off.*commit/i,
      /signed-off-by/i,
    ],
  },
  {
    kind: "discussion_first",
    regexes: [
      /discuss.*before (opening|submitting|a PR)/i,
      /open an issue before/i,
      /proposal.*(first|before)/i,
      /rfc.*(first|before)/i,
      /start (a |with a )?discussion/i,
    ],
  },
  {
    kind: "collaborators_only",
    regexes: [
      /collaborators only/i,
      /collaborators-only/i,
      /only (repo )?collaborators/i,
      /external (prs|pull requests) (are not|will not be) accepted/i,
    ],
  },
];

/** Cut a short evidence snippet around the first regex match. */
function snippet(text: string, regex: RegExp): string {
  const match = regex.exec(text);
  if (!match) return "";
  const idx = Math.max(0, match.index - 60);
  const raw = text.slice(idx, idx + 160).replace(/\s+/g, " ").trim();
  return raw.length > 140 ? raw.slice(0, 140) + "..." : raw;
}

export interface ParseOptions {
  /** Repo-level policy passed in when detectable (e.g. from repo metadata). */
  collaboratorsOnlyPolicy?: boolean;
}

/** One policy file's raw text: CONTRIBUTING variants, AGENTS.md, CLAUDE.md. */
export interface PolicySource {
  file: string;
  text: string;
}

/**
 * Parse several policy files at once. Binding rules increasingly live in
 * house-rules files that CONTRIBUTING only links to (reticle keeps its
 * claim-first, DCO, .changes and `pnpm verify` rules in AGENTS.md), so the
 * same gate rules run over all of them. Sources are merged without
 * duplicating kinds: CONTRIBUTING variants win ties, and each detected gate
 * records the file its evidence came from.
 */
export function parseGatesFromSources(sources: PolicySource[]): Gate[] {
  const contributingFirst = (f: string) => (f.toLowerCase().includes("contributing") ? 0 : 1);
  const ordered = [...sources].sort((a, b) => contributingFirst(a.file) - contributingFirst(b.file));
  const merged: Gate[] = RULES.map((r) => ({
    kind: r.kind,
    detected: false,
    evidence: "",
    source: undefined,
  }));
  for (const src of ordered) {
    const gates = parseGates(src.text);
    for (const g of gates) {
      if (!g.detected) continue;
      const m = merged.find((x) => x.kind === g.kind);
      if (m && !m.detected) {
        m.detected = true;
        m.evidence = g.evidence;
        m.source = src.file;
      }
    }
  }
  return merged;
}

/**
 * Parse contributing text into a gate list. Always returns all seven gates
 * with detected true/false, plus an evidence snippet when detected.
 */
export function parseGates(text: string | undefined, options: ParseOptions = {}): Gate[] {
  const body = text ?? "";
  return RULES.map((rule) => {
    const found = rule.regexes.find((re) => re.test(body));
    if (rule.kind === "collaborators_only" && options.collaboratorsOnlyPolicy) {
      return {
        kind: rule.kind,
        detected: true,
        evidence: "repo policy: PR creation restricted to collaborators",
      };
    }
    return {
      kind: rule.kind,
      detected: Boolean(found),
      evidence: found ? snippet(body, found) : "",
    };
  });
}

/** Gates that block an outside PR before it can even be opened. */
const HARD_GATES: GateKind[] = ["assignment_required", "vouch_required", "collaborators_only"];

export function hardGates(gates: Gate[]): Gate[] {
  return gates.filter((g) => g.detected && HARD_GATES.includes(g.kind));
}

/** Human-friendly name for a gate kind. */
export function gateLabel(kind: GateKind): string {
  switch (kind) {
    case "assignment_required": return "assignment required before PR";
    case "claim_first": return "comment first before starting";
    case "vouch_required": return "vouch required before PR";
    case "cla_required": return "CLA signature required";
    case "dco_required": return "DCO sign-off required";
    case "discussion_first": return "discussion first";
    case "collaborators_only": return "PR creation restricted to collaborators";
  }
}
