/**
 * Claim-to-PR prep hardening (v0.3.7).
 *
 * The `prep` command already learned fork/branch basics and the repo's
 * ritual files. What it never answered: how do I actually sign what the
 * repo demands, what release-note artifact do I owe, is the fix even in
 * this repo, and what are the house rules in one glance.
 *
 * Every detector below is a pure function over injected text/data (offline
 * tests), and prepIssue calls them best-effort against live probes. When
 * evidence is thin the detectors say "not detected" instead of guessing.
 */
import { parseGatesFromSources } from "./gates.js";
import { detectServerSideOnly, type ServerSideDeps } from "./server-side.js";
import type { Gate, RepoConventions } from "./types.js";

/** One policy text: CONTRIBUTING variants, AGENTS.md, CLAUDE.md. */
export interface PolicyText {
  file: string;
  text: string;
}

function gateDetected(gates: Gate[], kind: Gate["kind"]): boolean {
  return gates.some((g) => g.kind === kind && g.detected);
}

function gateSource(gates: Gate[], kind: Gate["kind"]): string | undefined {
  return gates.find((g) => g.kind === kind && g.detected)?.source;
}

/* ------------------------------------------------------------------ */
/* 1. CLA path naming                                                  */
/* ------------------------------------------------------------------ */

/**
 * The exact signing path a repo demands. Named so the prep checklist can
 * tell the contributor the real method with the real link or phrase:
 * cla-assistant (standard phrase), a repo-specific CLA bot with its own
 * signing page (the n8n pattern), or DCO instead of a CLA.
 */
export interface ClaPath {
  kind: "cla-assistant" | "custom-cla-bot" | "dco" | "none";
  /** One-line how-to for the checklist. */
  method: string;
  /** Signing page URL when one was found. */
  link?: string;
  /** Exact phrase to comment when the flow is comment-based. */
  signaturePhrase?: string;
  /** Policy files the call was drawn from. */
  sources: string[];
  /** Extra notes (e.g. "also requires DCO sign-off on every commit"). */
  notes: string[];
}

const CLA_SIGNATURE_PHRASE = "I have read the CLA Document and I hereby sign the CLA";

/** Pull bare and markdown-link URLs out of a text. */
function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s)"'>]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * A repo-specific CLA bot leaves a signing-page URL in policy text:
 * /webhook/cla paths, cla-bot subdomains/hostnames, or any URL in the
 * same sentence as "CLA". Returns the first such URL found.
 */
function findCustomClaUrl(text: string): string | undefined {
  const urls = extractUrls(text);
  // Strong patterns first: webhook/cla paths and cla bot hostnames.
  const strong = urls.find((u) => /webhook\/cla|cla[-_]?bot/i.test(u));
  if (strong) return strong;
  // Any URL in a line that mentions CLA signing.
  for (const line of text.split("\n")) {
    if (/cla/i.test(line) && /sign|accept|agree/i.test(line)) {
      const m = line.match(/https?:\/\/[^\s)"'>]+/);
      if (m) return m[0].replace(/[.,;:!?]+$/, "");
    }
  }
  return undefined;
}

export function detectClaPath(sources: PolicyText[], gates?: Gate[]): ClaPath {
  const resolvedGates = gates ?? parseGatesFromSources(sources);
  const combined = sources.map((s) => s.text).join("\n");
  const files = sources.map((s) => s.file);
  const notes: string[] = [];

  // (b) Repo-specific CLA bot with its own signing page, checked first
  // because a cla_required gate is usually also detected underneath it.
  const customUrl = findCustomClaUrl(combined);
  const customUrlSource = customUrl
    ? files.find((f, i) => sources[i].text.includes(customUrl))
    : undefined;
  if (customUrl) {
    if (gateDetected(resolvedGates, "dco_required")) {
      notes.push(
        `Also requires DCO sign-off on every commit (${gateSource(resolvedGates, "dco_required") ?? "house rules"}).`
      );
    }
    return {
      kind: "custom-cla-bot",
      method: `Sign this repo's own CLA at the signing page below (GitHub OAuth), then the CLA bot marks the PR.`,
      link: customUrl,
      sources: customUrlSource ? [customUrlSource] : files,
      notes,
    };
  }

  // (a) cla-assistant: explicit mention, or a bare cla_required gate.
  const claAssistantMention = /cla[- ]?assistant(\.io)?/i.test(combined);
  if (claAssistantMention || gateDetected(resolvedGates, "cla_required")) {
    const explicit = claAssistantMention;
    if (gateDetected(resolvedGates, "dco_required")) {
      notes.push(
        `Also requires DCO sign-off on every commit (${gateSource(resolvedGates, "dco_required") ?? "house rules"}).`
      );
    }
    return {
      kind: "cla-assistant",
      method: explicit
        ? "Sign via CLA Assistant: the CLA Assistant bot comments on the PR; reply with the signature phrase and it marks the check green."
        : "A CLA is required (detected in house rules); the standard flow is CLA Assistant, which prompts on the PR.",
      link: "https://cla-assistant.io",
      signaturePhrase: CLA_SIGNATURE_PHRASE,
      sources: files,
      notes,
    };
  }

  // (c) DCO instead of a CLA.
  if (gateDetected(resolvedGates, "dco_required")) {
    return {
      kind: "dco",
      method: "No CLA. Sign every commit with `git commit -s` (Signed-off-by trailer); the PR check verifies it.",
      sources: gateSource(resolvedGates, "dco_required") ? [gateSource(resolvedGates, "dco_required") as string] : files,
      notes,
    };
  }

  // (d) Nothing detected.
  return {
    kind: "none",
    method: "No CLA or DCO requirement detected in the repo's policy files.",
    sources: files,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* 2. Changeset and release-note conventions                           */
/* ------------------------------------------------------------------ */

/** The release-note artifact a PR owes the repo. */
export interface ChangesetConvention {
  style: "changesets" | "changes-dir" | "towncrier" | "changelog-notes";
  /** Path pattern, e.g. ".changeset/*.md". */
  pattern: string;
  /** Example filename built from the issue number. */
  example: string;
  /** What the file should contain. */
  note: string;
  /** Where it was detected: repo root listing or a policy file name. */
  source: string;
}

/**
 * Detect the release-note ritual: changesets (.changeset/), the reticle
 * .changes/ pattern (one file per change, assembled into the changelog),
 * towncrier fragments (towncrier.toml or [tool.towncrier] in pyproject),
 * or a CONTRIBUTING instruction to update CHANGELOG by hand.
 */
export function detectChangesetConvention(args: {
  rootNames: string[];
  policyText: string;
  policySource?: string;
  pyprojectText?: string;
  issueNumber: number;
  slug: string;
}): ChangesetConvention | undefined {
  const { rootNames, policyText, policySource, pyprojectText, issueNumber, slug } = args;
  const has = (n: string) => rootNames.some((r) => r.toLowerCase() === n);

  if (has(".changeset")) {
    return {
      style: "changesets",
      pattern: ".changeset/*.md",
      example: `.changeset/${issueNumber}-${slug}.md`,
      note: "changesets: one markdown file per change describing it for the changelog (frontmatter with semver bump, then prose).",
      source: "repo root (.changeset/)",
    };
  }
  if (has(".changes")) {
    return {
      style: "changes-dir",
      pattern: ".changes/*.md",
      example: `.changes/${issueNumber}-${slug}.md`,
      note: "one file per issue in .changes/; the repo assembles its changelog from this directory, never edit CHANGELOG.md directly.",
      source: "repo root (.changes/)",
    };
  }
  const towncrierConfig = has("towncrier.toml") || /\[tool\.towncrier\]/i.test(pyprojectText ?? "");
  if (towncrierConfig) {
    // The fragment directory is project-specific; towncrier's own default
    // is "newsfragments", overridden by the `directory` key. Without
    // reading the config value, name the common candidates.
    return {
      style: "towncrier",
      pattern: "<fragment-dir>/<issue>.<type>.md",
      example: `newsfragments/${issueNumber}.bugfix.md`,
      note: "towncrier: one news fragment named <issue-or-PR-number>.<type> (feature, bugfix, doc, removal, misc) in the fragment directory set by the `directory` key of [tool.towncrier]; common dirs: newsfragments/, changelog.d/, changes/.",
      source: has("towncrier.toml") ? "towncrier.toml" : "pyproject.toml [tool.towncrier]",
    };
  }
  if (/update (the )?changelog|changelog.{0,40}(entry|note|update)/i.test(policyText)) {
    return {
      style: "changelog-notes",
      pattern: "CHANGELOG.md",
      example: "an entry under the Unreleased section of CHANGELOG.md",
      note: "add a changelog entry by hand; check the file's Unreleased section format first.",
      source: policySource ?? "house rules",
    };
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 3. Fix-lives-here check                                             */
/* ------------------------------------------------------------------ */

/**
 * Satellite-repo hint: the repo's own docs name a companion repo where the
 * behavior actually lives (e.g. a label bot or CLI in a second repo).
 * Only fires on tight textual evidence: a github.com/org/repo URL
 * immediately preceded (within ~60 chars) by a relationship verb like
 * "source lives at" or "enforced by", and which is not the repo being
 * prepped. Never guesses.
 */
export function detectSatelliteRepo(
  owner: string,
  repo: string,
  policyText: string
): { candidate: string; evidence: string } | undefined {
  const urlRe = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(policyText)) !== null) {
    const candidate = `${m[1]}/${m[2]}`.replace(/[.]+$/, "");
    if (candidate.toLowerCase() === `${owner}/${repo}`.toLowerCase() || seen.has(candidate)) continue;
    seen.add(candidate);
    // Code-location evidence in the ~60 chars before the URL: a phrase
    // like "source lives at" or "enforced by our backend". Plain
    // "documentation lives at" for a docs repo, or install
    // instructions, deliberately do not count.
    const before = policyText.slice(Math.max(0, m.index - 60), m.index).replace(/\s+/g, " ");
    const codeLocated = /\b(source|code(base)?|implementation)\b.{0,40}\b(lives?|maintained|hosted|located|found)\b/i.test(before);
    const enforcedBy = /\b(enforced|handled|maintained|implemented|hosted)\s+by\b/i.test(before);
    if ((codeLocated || enforcedBy) && !/\b(install|download|uninstall)\b/i.test(before)) {
      const evidence = policyText
        .slice(Math.max(0, m.index - 160), Math.min(policyText.length, m.index + 40))
        .replace(/\s+/g, " ");
      return {
        candidate,
        evidence: `the behavior may live in ${candidate}: policy text names it near "...${evidence.trim()}..."`,
      };
    }
  }
  return undefined;
}

/** Warnings that the fix may not be buildable from this repo. */
export interface FixLivesHereWarning {
  /** "server-side" or "satellite". */
  kind: string;
  /** Prominent warning line for the prep checklist. */
  line: string;
}

/**
 * Combine the v0.3.4 server-side signal with the satellite hint into
 * checklist warnings. Best-effort: code-search failures or empty policy
 * text yield no warnings, never guesses.
 */
export async function detectFixLivesHere(args: {
  owner: string;
  repo: string;
  issueBody: string;
  policyText: string;
  deps?: ServerSideDeps;
}): Promise<FixLivesHereWarning[]> {
  const { owner, repo, issueBody, policyText, deps } = args;
  const warnings: FixLivesHereWarning[] = [];
  const serverSide = await detectServerSideOnly(owner, repo, issueBody, deps ?? {});
  if (serverSide) {
    warnings.push({
      kind: "server-side",
      line: `WARNING: the fix may not be buildable from this repo. ${serverSide.evidence}. Check with the maintainers before building.`,
    });
  }
  const satellite = detectSatelliteRepo(owner, repo, policyText);
  if (satellite) {
    warnings.push({
      kind: "satellite",
      line: `WARNING: ${satellite.evidence}.`,
    });
  }
  return warnings;
}

/* ------------------------------------------------------------------ */
/* 4. House-rules summary block                                        */
/* ------------------------------------------------------------------ */

/**
 * One-glance house rules at the top of the prep checklist: the required
 * claim style, PR title conventions, draft-first norm, and the repo's test
 * command. Every line names its source; absent rules are stated plainly
 * instead of invented.
 */
export function buildHouseRulesSummary(args: {
  gates: Gate[];
  policyText: string;
  policyFiles: string[];
  conventions?: RepoConventions;
}): string[] {
  const { gates, policyText, policyFiles, conventions } = args;
  const out: string[] = [];
  const files = policyFiles.length > 0 ? ` (${policyFiles.join(", ")})` : "";

  // Claim style.
  if (gateDetected(gates, "assignment_required")) {
    out.push(`Claim style: request assignment on the issue first (${gateSource(gates, "assignment_required") ?? "house rules"}).`);
  } else if (gateDetected(gates, "claim_first")) {
    out.push(`Claim style: comment on the issue before starting (${gateSource(gates, "claim_first") ?? "house rules"}).`);
  } else {
    out.push(`Claim style: none required${files}.`);
  }

  // PR title convention.
  if (/conventional commits/i.test(policyText)) {
    out.push(`PR titles: Conventional Commits${files}.`);
  } else if (/semantic (pr )?titles?/i.test(policyText)) {
    out.push(`PR titles: semantic titles${files}.`);
  }

  // Draft-first norm.
  if (/\bopen.{0,30}as (a )?draft/i.test(policyText) || /\bdraft.{0,30}(first|before)/i.test(policyText)) {
    out.push(`Draft-first: open the PR as a draft${files}.`);
  }

  // Test command.
  if (conventions) {
    if (conventions.verifyCommands.length > 0) {
      out.push(`Test command: \`${conventions.verifyCommands[0]}\`${files || " (house rules)"}.`);
    } else if (conventions.packageScripts.length > 0) {
      out.push(
        `Before pushing: ${conventions.packageScripts.map((s) => `\`pnpm ${s}\``).join(", ")} (package.json).`
      );
    }
  }
  return out;
}

/** All four enhancements gathered for a prep run. */
export interface PrepDetail {
  claPath: ClaPath;
  changeset?: ChangesetConvention;
  fixLivesHereWarnings: FixLivesHereWarning[];
  houseRulesSummary: string[];
}

export interface PrepDetailDeps extends ServerSideDeps {
  /** Root names for the changeset/towncrier probes. */
  rootNames?: () => Promise<string[]>;
  /** pyproject.toml text for the towncrier probe, or undefined. */
  pyprojectText?: () => Promise<string | undefined>;
}

/**
 * Gather all four prep enhancements best-effort for a prep run. The
 * snapshot's houseRules carry {file, text}; snapshot.contributing carries
 * the joined text. Any failing probe degrades to "not detected".
 */
export async function gatherPrepDetail(args: {
  owner: string;
  repo: string;
  issueNumber: number;
  slug: string;
  policyTexts: PolicyText[];
  contributing: string | undefined;
  issueBody?: string;
  conventions?: RepoConventions;
  deps?: PrepDetailDeps;
}): Promise<PrepDetail> {
  const { owner, repo, issueNumber, slug, policyTexts, contributing, issueBody, conventions, deps } = args;
  const policyText = [contributing ?? "", ...policyTexts.map((p) => p.text)].join("\n\n");
  const policyFiles = policyTexts.map((p) => p.file).filter((f, i, a) => a.indexOf(f) === i);

  const gates = parseGatesFromSources(policyTexts.length > 0 ? policyTexts : [{ file: "CONTRIBUTING.md", text: contributing ?? "" }]);
  const claPath = detectClaPath(policyTexts.length > 0 ? policyTexts : [{ file: "CONTRIBUTING.md", text: contributing ?? "" }], gates);

  let rootNames: string[] = [];
  try {
    if (deps?.rootNames) rootNames = await deps.rootNames();
  } catch { /* root listing failed; skip */ }
  let pyprojectText: string | undefined;
  try {
    if (deps?.pyprojectText) pyprojectText = await deps.pyprojectText();
  } catch { /* no pyproject; skip */ }
  const changeset = detectChangesetConvention({
    rootNames,
    policyText,
    policySource: policyFiles[0],
    pyprojectText,
    issueNumber,
    slug,
  });

  const fixLivesHereWarnings = await detectFixLivesHere({
    owner,
    repo,
    issueBody: issueBody ?? "",
    policyText,
    deps,
  });

  const houseRulesSummary = buildHouseRulesSummary({
    gates,
    policyText,
    policyFiles,
    conventions,
  });

  return { claPath, changeset, fixLivesHereWarnings, houseRulesSummary };
}
