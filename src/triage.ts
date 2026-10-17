/**
 * Triage-hold detection (Greenlight v0.9.0).
 *
 * Field case 2026-10-17: mastra-ai/mastra issues all carried a bot
 * notice telling contributors to wait until maintainers remove the
 * triage or approval label before opening a PR, and every one of them
 * scored GO because the verdict engine had no gate kind for it. nuxt/nuxt
 * uses a standing "pending triage" label with the same practical effect.
 *
 * A triage hold is not a claim and never produces TAKEN. It is a
 * downgrade signal: the issue is real work that nobody is allowed to
 * build yet, so GO caps at RISKY with the hold named, and scan/digest
 * treat held issues as future pipeline rather than current targets.
 */
import { isBotAuthor } from "./claims.js";

/** Label texts that mean "do not build yet" (compared case-insensitively). */
const TRIAGE_LABELS = new Set([
  "needs triage",
  "pending triage",
  "status: needs triage",
  "needs-triage",
  "triage needed",
  "awaiting triage",
  "triage",
]);

/**
 * Bot triage notices: a comment telling contributors to wait for triage
 * before opening a PR. Anchored on the "wait ... before opening a pull
 * request" shape mastra's bot uses, plus the label-clearance variant.
 */
const TRIAGE_NOTICE_RES = [
  /wait until.{0,120}(triage|approval).{0,60}label.{0,60}before (opening|submitting)/i,
  /before (opening|submitting) (a )?pull request.{0,80}(until|unless).{0,80}triag/i,
  /do not open.{0,60}pull request.{0,60}(until|before).{0,60}triag/i,
];

export interface TriageHold {
  held: boolean;
  /** What caused the hold: the matched label, or the quoted bot notice. */
  evidence: string;
}

export function hasTriageLabel(labels: string[] | undefined): string | undefined {
  if (!labels) return undefined;
  for (const label of labels) {
    const norm = label.trim().toLowerCase();
    if (TRIAGE_LABELS.has(norm)) return label;
  }
  return undefined;
}

export interface TriageComment {
  author: string;
  body: string;
}

export function hasTriageNoticeComment(comments: TriageComment[] | undefined): { author: string; quote: string } | undefined {
  if (!comments) return undefined;
  for (const c of comments) {
    // Triage notices come from bots (mastra's dane-ai-mastra[bot]) or from
    // maintainer-named accounts. A random human matching the notice shape
    // is almost always quoting the bot, not issuing a hold.
    if (!isBotAuthor(c.author) && !/maintainer|owner/i.test(c.author)) continue;
    const re = TRIAGE_NOTICE_RES.find((r) => r.test(c.body));
    if (!re) continue;
    const match = re.exec(c.body);
    const quote = match ? match[0].replace(/\s+/g, " ").trim().slice(0, 140) : "";
    return { author: c.author, quote };
  }
  return undefined;
}

/**
 * Detect a triage hold from an issue's labels and comments. Labels alone
 * are enough (the cheap digest path); the bot-notice variant covers the
 * comment case the verdict engine sees (mastra's dane-ai-mastra notice).
 */
export function detectTriageHold(args: {
  labels?: string[];
  comments?: TriageComment[];
}): TriageHold {
  const label = hasTriageLabel(args.labels);
  if (label) {
    return { held: true, evidence: `label "${label}" means the issue is still in triage; do not build until it clears` };
  }
  const notice = hasTriageNoticeComment(args.comments);
  if (notice) {
    return {
      held: true,
      evidence: `triage notice from @${notice.author}: "${notice.quote}"`,
    };
  }
  return { held: false, evidence: "" };
}
