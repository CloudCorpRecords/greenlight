/**
 * Bounty-liveness classification. A bounty is context for the contributor,
 * never evidence of landability, so this module never raises a verdict: it
 * only classifies what the issue advertises.
 *
 * Motivation: algora.io 404s and its public API returns zero items (dead
 * since 2025), yet thousands of GitHub issues still wear its bounty labels;
 * onyx#2281 carried a $250 "bounty" with ~30 competing PRs and no live
 * platform behind it. Chasing a dead bounty is wasted work.
 */

export type BountyFlag = "bounty-platform-dead" | "bounty-unverified";

export interface BountySignal {
  /** Lowercased platform name when one is named, e.g. "algora". */
  platform?: string;
  /** The advertised amount when visible, e.g. "$250" or "125 USDC". */
  amount?: string;
  /** Null when the platform is named and not known-dead. */
  flag: BountyFlag | null;
  /** Evidence string for the flag, or "" when flag is null. */
  evidence: string;
}

const DEAD_PLATFORMS: Record<string, string> = {
  algora: "algora.io 404s and its public API returns zero items (dead since 2025)",
};

const PLATFORM_RE = /(algora|opire|issuehunt|polar|gitcoin|oss[-.]?hunter|bountysource)/i;

function normalizePlatform(name: string): string {
  return name.toLowerCase().replace(/[-.]/g, "");
}

export function detectBounty(input: {
  labels: string[];
  title: string;
  body?: string;
}): BountySignal | null {
  const text = [...input.labels, input.title, input.body ?? ""].join("\n");
  const signalsBounty =
    /\bbounty\b/i.test(text) ||
    /💎/.test(text) ||
    (/\$\s?\d[\d,]*/.test(text) && /bounty|reward|paid|usdc/i.test(text)) ||
    /\b\d[\d,]*\s*usdc\b/i.test(text);
  if (!signalsBounty) return null;

  const pm = PLATFORM_RE.exec(text);
  const platform = pm ? normalizePlatform(pm[1]) : undefined;
  const am = /\$\s?(\d[\d,]*)|(\d[\d,]*)\s*usdc/i.exec(text);
  const amount = am ? am[0].trim() : undefined;

  if (platform && DEAD_PLATFORMS[platform]) {
    return {
      platform,
      amount,
      flag: "bounty-platform-dead",
      evidence: `bounty names "${platform}", which is dead: ${DEAD_PLATFORMS[platform]}`,
    };
  }
  if (!platform) {
    return {
      platform: undefined,
      amount,
      flag: "bounty-unverified",
      evidence: "bounty advertised but no identifiable platform or payer in the issue",
    };
  }
  return { platform, amount, flag: null, evidence: "" };
}
