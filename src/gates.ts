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

/**
 * v0.9.3: ban patterns scoped to a KIND of agent operation rather than a
 * blanket prohibition. TypeScript's CONTRIBUTING refuses "bulk,
 * agent-driven contributions" outright while welcoming human-led AI work
 * with disclosure; ppt-master closes "purely AI-generated PRs submitted
 * without human review" while welcoming reviewed AI assistance. A scoped
 * ban is still a ban for autonomous operation, but the file's welcome or
 * disclosure path must survive next to it (dual-class), never be silently
 * swallowed by the ban verdict. These patterns are spread into the
 * agents_banned rule below and are ALSO listed here so the contradiction
 * resolver can tell a scoped ban from an unscoped one. Every scoped
 * pattern requires a consequence clause (refused, closed, not accepted)
 * so bare quality guidance ("understand what you submit") never counts
 * as a ban.
 */
const SCOPED_BAN_REGEXES: RegExp[] = [
  /do not accept.{0,80}(bulk|autonomous).{0,30}(agent|ai)[-\s]?driven (contributions?|pull requests?|prs?)/i,
  /(bulk|mass)[-\s]?(agent|ai)[-\s]?driven (contributions?|pull requests?|prs?).{0,80}(not accepted|refused|will be closed|are not welcome|do not accept)/i,
  /(purely|fully|entirely) ai[-\s]?(generated|authored|drafted).{0,50}(without human review|unreviewed|without (a )?human in the loop).{0,80}(closed|rejected|not a contribution|will not be merged)/i,
];

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
    //
    // v0.9.3: the Agent Policy Index field work found nine more bans the
    // old patterns missed because they live in CONTRIBUTING.md or in an
    // org-level AI_POLICY.md, in prose the old patterns never covered:
    // immich ("We ask you not to open PRs generated with an LLM"),
    // meilisearch ("We will not consider any content generated by
    // generative AI tooling"), alacritty ("must not include content
    // generated by large language models"), zed ("we don't accept
    // contributions from autonomous agents"), astral-sh ("We do not allow
    // autonomous agents to be used for contributing"), dspy ("Do not
    // submit issues, PRs, or reviews from fully autonomous AI agents"),
    // kedro ("We do not welcome AI contributions by bots with no human in
    // the loop", "PRs must not be opened by bots"), home-assistant
    // ("Contributions made by autonomous agents are not accepted", via
    // its AI_POLICY.md). Each new pattern below is anchored on an
    // explicit prohibition, never on the mere mention of AI tooling.
    kind: "agents_banned",
    regexes: [
      /autonomous agents? (are|will be) not (allowed|accepted|welcome|permitted)/i,
      /contributions? (by|from) autonomous agents? (are|is) not allowed/i,
      /may only be submitted by a human/i,
      /no ai[-\s]?(generated|authored|written) (pull requests?|prs?|contributions?)/i,
      /do not (draft|post).{0,80}(pr titles?|pr descriptions?|pull requests?|issues?, or discussion)/i,
      /\b(bots?|agents?) (are|will be) (prohibited|banned|forbidden).{0,60}(from )?(contribut|opening|submitting)/i,
      /(ask you )?not to open (prs?|pull requests?) generated (with|by) (an? )?(llm|ai)\b/i,
      /(will not|do not|don't|does not) consider.{0,50}(content )?generated by (generative )?ai\b/i,
      /(must not|shall not|may not|cannot).{0,50}content generated by (large language models|llms?|generative ai|ai)\b/i,
      /(do not|don't|does not) accept.{0,60}(contributions?|prs?|pull requests?).{0,40}(from )?autonomous agents?/i,
      /(do not|don't|does not) allow.{0,50}autonomous agents?/i,
      /do not submit.{0,80}(from )?(fully )?autonomous (ai )?agents?/i,
      /(do not|don't|does not) welcome.{0,40}ai contributions?/i,
      /(pull requests?|prs?).{0,40}(must not|may not|cannot|will not) be opened by (bots|automated|agents?)/i,
      /autonomous (ai )?agents? may not (submit|open|contribute)/i,
      ...SCOPED_BAN_REGEXES,
    ],
  },
  {
    // Field case 2026-10-17: actualbudget/actual's AI Usage Policy plus
    // AGENTS.md requires an [AI] prefix on agent PR titles and commits
    // and an AI disclosure sentence in the PR description. Disclosure is
    // a ritual to satisfy, not a block, so this is a flag, never a
    // verdict change: prep turns it into concrete required actions.
    //
    // v0.9.3: the old patterns only caught "disclosure" next to "AI" in
    // one word order, so meilisearch ("If you use AI tools during your
    // work, remember to disclose it in your PR description"), astral-sh
    // ("disclosed as such"), and coolify ("If AI tools were used at any
    // stage, mention it in the pull request description") all slipped
    // through. The new patterns cover both orders and the "mention"
    // phrasing. They stay anchored on an explicit ask, so a repo that
    // merely waives disclosure (hyperframes: "there is no need to
    // disclose it") still reads as no disclosure gate.
    kind: "agents_disclosure",
    regexes: [
      /\bai\b.{0,40}disclosure/i,
      /disclos(e|ing).{0,40}\bai\b/i,
      /\bai\b.{0,60}disclos(e|ing|ure)/i,
      /\b(ai|artificial intelligence)\b.{0,40}(mention|state|note|indicate|declare|disclose)/i,
      /require.{0,25}(you )?to disclose/i,
      /disclosed as such/i,
      /\[ai\].{0,60}(prefix|title|commit)/i,
      /(prefix|title).{0,60}\[ai\]/i,
      /ai[-\s]?generated.{0,60}(disclos|prefix|declare)/i,
    ],
  },
];

/**
 * v0.9.3: explicit welcome of AI-assisted contributions. Internal signal
 * only, never a gate kind: it feeds the contradiction resolver so a ban
 * verdict can never silently erase a file's welcome or disclosure path
 * (the hyperframes false-ban shape: "Do not submit AI-generated code you
 * don't understand" next to "We welcome contributions that use AI tools...
 * there is no need to disclose it"). Generic "we welcome contributions"
 * prose does not count; the welcome must name AI.
 */
const AI_WELCOME_RES: RegExp[] = [
  /we welcome.{0,80}\b(ai|artificial intelligence|llms?)\b/i,
  /\bai[-\s]?(assistance|tools?) (is|are) welcome/i,
  /we are pro ai assisted coding/i,
  /(have|has) no objection to.{0,60}ai\b/i,
  /there is no need to disclose/i,
];

/**
 * v0.9.3 contradiction resolution (per policy file, never across files).
 * Runs over one source's parsed gates plus its raw text:
 * - An UNSCOPED ban (explicit prohibition: no autonomous agents, no AI
 *   PRs) stands on its own; welcome language elsewhere does not cancel an
 *   explicit prohibition (zed welcomes LLM coding and still bans
 *   autonomous-agent contributions, and both verdicts are correct).
 * - A SCOPED ban (bulk/autonomous-only, unreviewed-only) plus welcome or
 *   disclosure language in the same file dual-classes: agents_banned
 *   (evidence: the scoped quote) AND agents_disclosure. If no disclosure
 *   pattern fired, the disclosure entry is synthesized from the welcome
 *   sentence so the human path is never silently lost (ppt-master,
 *   TypeScript). The ban is never downgraded away: for autonomous
 *   operation it is real.
 */
export function resolveBanContradictions(gates: Gate[], text: string): Gate[] {
  const body = (text ?? "").replace(/\*+/g, "").replace(/\s+/g, " ");
  const ban = gates.find((g) => g.kind === "agents_banned");
  if (!ban || !ban.detected) return gates;
  const unscopedFired = UNSCOPED_BAN_RES.some((re) => re.test(body));
  if (unscopedFired) return gates;
  const scopedFired = SCOPED_BAN_REGEXES.some((re) => re.test(body));
  if (!scopedFired) return gates;
  const disclosure = gates.find((g) => g.kind === "agents_disclosure");
  const welcomeFired = AI_WELCOME_RES.some((re) => re.test(body));
  if (disclosure && disclosure.detected) return gates;
  if (!welcomeFired) return gates;
  // Scoped ban plus a welcome, but no disclosure pattern matched: the
  // file describes a human-led path (review, understand, disclose), so
  // surface it as agents_disclosure with the welcome as evidence rather
  // than letting the ban verdict stand alone.
  if (disclosure) {
    disclosure.detected = true;
    disclosure.evidence = snippet(body, AI_WELCOME_RES.find((re) => re.test(body))!);
  }
  return gates;
}

/** The agents_banned patterns that are NOT scoped (explicit prohibitions). */
const UNSCOPED_BAN_RES: RegExp[] = [
  /autonomous agents? (are|will be) not (allowed|accepted|welcome|permitted)/i,
  /contributions? (by|from) autonomous agents? (are|is) not allowed/i,
  /may only be submitted by a human/i,
  /no ai[-\s]?(generated|authored|written) (pull requests?|prs?|contributions?)/i,
  /do not (draft|post).{0,80}(pr titles?|pr descriptions?|pull requests?|issues?, or discussion)/i,
  /\b(bots?|agents?) (are|will be) (prohibited|banned|forbidden).{0,60}(from )?(contribut|opening|submitting)/i,
  /(ask you )?not to open (prs?|pull requests?) generated (with|by) (an? )?(llm|ai)\b/i,
  /(will not|do not|don't|does not) consider.{0,50}(content )?generated by (generative )?ai\b/i,
  /(must not|shall not|may not|cannot).{0,50}content generated by (large language models|llms?|generative ai|ai)\b/i,
  /(do not|don't|does not) accept.{0,60}(contributions?|prs?|pull requests?).{0,40}(from )?autonomous agents?/i,
  /(do not|don't|does not) allow.{0,50}autonomous agents?/i,
  /do not submit.{0,80}(from )?(fully )?autonomous (ai )?agents?/i,
  /(do not|don't|does not) welcome.{0,40}ai contributions?/i,
  /(pull requests?|prs?).{0,40}(must not|may not|cannot|will not) be opened by (bots|automated|agents?)/i,
  /autonomous (ai )?agents? may not (submit|open|contribute)/i,
];

/**
 * v0.9.3: explicit disclosure WAIVERS. hyperframes welcomes AI help and
 * says "there is no need to disclose it" — a waiver is the opposite of a
 * disclosure gate, so when waiver language is present the disclosure gate
 * is suppressed. A file cannot both require and waive disclosure; the
 * waiver wins because it is the more specific statement about the repo's
 * actual ask.
 */
const DISCLOSURE_WAIVER_RES: RegExp[] = [
  /there is no need to disclose/i,
  /no disclosure (is )?required/i,
  /disclosure is not required/i,
  /waives? disclosure/i,
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
    // v0.9.3: contradiction resolution runs per file, before merging, so
    // a scoped ban plus welcome/disclosure in the same file dual-classes
    // instead of the ban verdict silently erasing the human path.
    const gates = resolveBanContradictions(parseGates(src.text), src.text);
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
  // v0.9.3: collapse whitespace and strip markdown emphasis before
  // matching. Policy files wrap lines mid-phrase ("autonomous\nagents
  // are not accepted"), and bold markers split keywords ("to
  // **disclose"), both of which a literal pattern would miss. Matching
  // is on the normalized body; evidence snippets were already
  // whitespace-collapsed for display.
  const body = (text ?? "").replace(/\*+/g, "").replace(/\s+/g, " ");
  const gates = RULES.map((rule) => {
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
  const disclosure = gates.find((g) => g.kind === "agents_disclosure");
  if (disclosure && disclosure.detected && DISCLOSURE_WAIVER_RES.some((re) => re.test(body))) {
    disclosure.detected = false;
    disclosure.evidence = "";
  }
  return gates;
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
