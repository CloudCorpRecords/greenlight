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
      /must (also )?be assigned/i,
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
      // Maintainer-only PR shops (field cases 2026-10-15): the MCP inspector
      // and servers repos take issues and prompts, not outside PRs, and say
      // so in workflow language rather than gate language — "Pull requests
      // against this repo are opened by the repo maintainers only" and
      // "We accept issues, not pull requests". Both scored GO with "no
      // blocking gates" until these phrasings were added. The optional
      // asterisks tolerate the Markdown bold both repos wrap the words in.
      /pull requests? (against|in|on) this (repo|repository) are opened by (the )?(\*\*)?(repo |repository )?maintainers(\*\*)? only/i,
      /accept issues, not pull requests?/i,
    ],
  },
  {
    // Field case 2026-10-15: activepieces paused unsolicited outside PRs
    // and auto-closed two finished PRs within about a minute. The policy
    // sits in CONTRIBUTING in plain prose ("We've temporarily paused
    // unsolicited pull requests from outside the core team"), blamed on
    // AI-generated PR volume. This is a hard block: an outside PR will
    // not survive even if the code is perfect.
    kind: "unsolicited_prs_paused",
    regexes: [
      /paused.{0,60}(unsolicited|solicited|external)? ?(pull requests?|prs?)/i,
      /not accepting (external )?(contributions|pull requests?)/i,
      /unsolicited pull requests?/i,
    ],
  },
  {
    // The automation end of the same policy: prose that says outside PRs
    // get closed automatically (trigger.dev's auto-close is caught by the
    // vouch rule; this is the generic version for every other repo).
    kind: "external_prs_closed",
    regexes: [
      /automatically.{0,60}(external|outside).{0,40}(pull requests?|prs?)/i,
      /auto-?clos\w*.{0,80}(external|outside).{0,40}(pull requests?|prs?)/i,
      /(external|outside).{0,40}(pull requests?|prs?).{0,60}(auto-?clos|will be closed)/i,
    ],
  },
  {
    // Field case 2026-10-17: nuxt/nuxt's AGENTS.md bans autonomous agent
    // contributions outright ("Contributions may only be submitted by a
    // human who fully understands them... autonomous agents are not
    // allowed. Do not draft or post PR titles, PR descriptions, issues,
    // or discussion comments."). This is a hard block for agent-driven
    // work, and it lives in house-rules files, not CONTRIBUTING. The
    // rules are anchored on explicit agent/bot-prohibition language, not
    // on the mere word "AI", to avoid flagging repos that merely discuss
    // AI features or ask for disclosure.
    kind: "agents_banned",
    regexes: [
      /autonomous agents? (are|will be) not (allowed|accepted|welcome|permitted)/i,
      /contributions? (by|from) autonomous agents? (are|is) not allowed/i,
      /may only be submitted by a human/i,
      /no ai[-\s]?(generated|authored|written) (pull requests?|prs?|contributions?)/i,
      /do not (use|draft|post|submit|open).{0,80}(pr titles?|pr descriptions?|pull requests?|issues?, or discussion)/i,
      /\b(bots?|agents?) (are|will be) (prohibited|banned|forbidden).{0,60}(from )?(contribut|opening|submitting)/i,
    ],
  },
  {
    // Field case 2026-10-17: actualbudget/actual's AI Usage Policy plus
    // AGENTS.md requires an [AI] prefix on agent PR titles and commits
    // and an AI disclosure sentence in the PR description. Disclosure is
    // a ritual to satisfy, not a block, so this is a flag, never a
    // verdict change: prep turns it into concrete required actions.
    kind: "agents_disclosure",
    regexes: [
      /\bai\b.{0,40}disclosure/i,
      /disclos(e|ing).{0,40}\bai\b/i,
      /\[ai\].{0,60}(prefix|title|commit)/i,
      /(prefix|title).{0,60}\[ai\]/i,
      /ai[-\s]?generated.{0,60}(disclos|prefix|declare)/i,
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
 * Parse contributing text into a gate list. Always returns all eleven gates
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

/**
 * gatefile's contribution-gates.json kinds mapped onto Greenlight kinds.
 * The two tools share a taxonomy with a few aliases: gatefile's
 * discuss_first and issue_first are Greenlight's discussion_first, and its
 * no_direct_prs is the hard block Greenlight calls collaborators_only.
 */
const GATEFILE_KIND_MAP: Record<string, GateKind> = {
  claim_first: "claim_first",
  assignment_required: "assignment_required",
  vouch_required: "vouch_required",
  collaborators_only: "collaborators_only",
  dco_required: "dco_required",
  cla_required: "cla_required",
  discuss_first: "discussion_first",
  issue_first: "discussion_first",
  no_direct_prs: "collaborators_only",
};

interface GatefileGate {
  kind?: string;
  evidence?: string;
  source?: string;
}

/**
 * Parse a gatefile contribution-gates.json document into Greenlight gates.
 * gatefile (the companion tool) extracts a repo's gates once and commits
 * them as JSON; a repo that carries that file has already answered the gate
 * question, so its verdicts should use the committed answer instead of
 * re-deriving it from prose. Returns only the detected gates, each with its
 * evidence prefixed so a verdict can say where the gate came from. Unknown
 * kinds are skipped; malformed JSON throws.
 */
export function parseGatefileJson(text: string): Gate[] {
  const doc = JSON.parse(text) as { gates?: GatefileGate[] };
  if (!doc || !Array.isArray(doc.gates)) {
    throw new Error("not a contribution-gates.json document (no gates array)");
  }
  const out: Gate[] = [];
  for (const g of doc.gates) {
    const kind = g.kind ? GATEFILE_KIND_MAP[g.kind] : undefined;
    if (!kind || out.some((x) => x.kind === kind)) continue;
    out.push({
      kind,
      detected: true,
      evidence: `gatefile: ${g.evidence ?? g.kind}`,
      source: g.source ?? "contribution-gates.json",
    });
  }
  return out;
}

/** Gates that block an outside PR before it can even be opened. */
const HARD_GATES: GateKind[] = ["assignment_required", "vouch_required", "collaborators_only", "unsolicited_prs_paused", "external_prs_closed", "agents_banned"];

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
    case "unsolicited_prs_paused": return "unsolicited PRs paused";
    case "external_prs_closed": return "external PRs closed by automation";
    case "agents_banned": return "agent contributions banned";
    case "agents_disclosure": return "AI disclosure required";
  }
}

/** One workflow file from .github/workflows: name plus raw text when fetchable. */
export interface WorkflowFile {
  name: string;
  content?: string;
}

/**
 * Scan workflow files for auto-close automation aimed at outside PRs.
 * Field case 2026-10-15: activepieces runs a workflow literally named
 * "Close external PRs" that closed two finished outside PRs within about
 * a minute. Returns a single external_prs_closed gate (detected-only);
 * name match wins, but a content match catches innocuously named files
 * whose steps close PRs from non-members.
 */
export function detectWorkflowGates(files: WorkflowFile[]): Gate[] {
  const NAME_RE = /clos(e|ing|ure).*(external|outside)|(external|outside).*clos(e|ing|ure)/i;
  // Order-agnostic: "close ... outside contributors' PRs" and "close PRs
  // from outside contributors" both count. "prs?\b" catches "PR", "prs",
  // and the standalone in "gh pr close" without eating "press".
  const PR_RE = "(pull.?requests?|prs?\\b)";
  const CONTENT_RE = new RegExp(
    `(close)[\\s\\S]{0,200}((external|outside)[\\s\\S]{0,80}${PR_RE}|${PR_RE}[\\s\\S]{0,80}(external|outside))`,
    "i"
  );
  const hit = files.find((f) => NAME_RE.test(f.name)) ??
    files.find((f) => f.content !== undefined && CONTENT_RE.test(f.content));
  if (!hit) return [];
  const byName = NAME_RE.test(hit.name);
  return [
    {
      kind: "external_prs_closed",
      detected: true,
      evidence: byName
        ? `workflow file: ${hit.name}`
        : `workflow file: ${hit.name} (closes external PRs: "${snippet(hit.content ?? "", CONTENT_RE)}")`,
      source: `.github/workflows/${hit.name}`,
    },
  ];
}
