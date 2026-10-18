/**
 * Git operations for Autopilot, through the GitHub Git Data API only.
 *
 * Autopilot fixes must never push arbitrary code, so every mutation goes
 * through these primitives: create a blob, a tree, a commit, and move a
 * ref. The DCO surgery (message-only commit rewrites) and the format fix
 * (computed merge trees) both reduce to "commit with an exact tree, then
 * move the branch ref", which this module verifies step by step.
 */
import { apiGet, apiPost } from "./github.js";

/** Rene's standing DCO identity: he authorized Tree to sign non-legal attestations in his name. */
export const DCO_SIGNOFF_LINE =
  "Signed-off-by: Rene Turcios <95189389+CloudCorpRecords@users.noreply.github.com>";

export interface CommitObject {
  sha: string;
  treeSha: string;
  message: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}

interface GitCommitApiItem {
  sha?: unknown;
  tree?: { sha?: unknown };
  message?: unknown;
  parents?: Array<{ sha?: unknown }>;
  author?: { name?: unknown; email?: unknown };
  committer?: { name?: unknown; email?: unknown };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** True when the message carries a DCO Signed-off-by trailer on any line. */
export function hasSignoff(message: string): boolean {
  return message
    .split("\n")
    .some((line) => /^Signed-off-by:\s*\S/i.test(line.trim()));
}

/** Append the sign-off line to a message that lacks it; leave signed messages untouched. */
export function withSignoff(message: string, line: string = DCO_SIGNOFF_LINE): string {
  if (hasSignoff(message)) return message;
  return `${message.replace(/\n+$/, "")}\n\n${line}`;
}

export interface GitOpsDeps {
  getCommit?: (owner: string, repo: string, sha: string) => Promise<CommitObject>;
  createCommit?: (
    owner: string,
    repo: string,
    args: {
      message: string;
      tree: string;
      parents: string[];
      author: { name: string; email: string };
      committer: { name: string; email: string };
    }
  ) => Promise<string>;
  updateRef?: (owner: string, repo: string, branch: string, sha: string, force: boolean) => Promise<void>;
  getRef?: (owner: string, repo: string, branch: string) => Promise<string | null>;
  createBlob?: (owner: string, repo: string, content: string) => Promise<string>;
  createTree?: (owner: string, repo: string, baseTree: string, entries: Array<{ path: string; sha: string; mode: string }>) => Promise<string>;
}

async function defaultGetCommit(owner: string, repo: string, sha: string): Promise<CommitObject> {
  const c = (await apiGet(`/repos/${owner}/${repo}/git/commits/${sha}`)) as GitCommitApiItem;
  return {
    sha,
    treeSha: str(c.tree?.sha),
    message: str(c.message),
    parents: (c.parents ?? []).map((p) => str(p.sha)).filter(Boolean),
    authorName: str(c.author?.name),
    authorEmail: str(c.author?.email),
    committerName: str(c.committer?.name),
    committerEmail: str(c.committer?.email),
  };
}

async function defaultCreateCommit(
  owner: string,
  repo: string,
  args: {
    message: string;
    tree: string;
    parents: string[];
    author: { name: string; email: string };
    committer: { name: string; email: string };
  }
): Promise<string> {
  const c = (await apiPost(`/repos/${owner}/${repo}/git/commits`, args)) as { sha?: unknown };
  const sha = str(c.sha);
  if (!sha) throw new Error("Git Data API did not return a commit sha");
  return sha;
}

async function defaultUpdateRef(
  owner: string,
  repo: string,
  branch: string,
  sha: string,
  force: boolean
): Promise<void> {
  await apiPost(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha, force });
}

async function defaultGetRef(owner: string, repo: string, branch: string): Promise<string | null> {
  try {
    const r = (await apiGet(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)) as {
      object?: { sha?: unknown };
    };
    const sha = str(r.object?.sha);
    return sha || null;
  } catch {
    return null;
  }
}

async function defaultCreateBlob(owner: string, repo: string, content: string): Promise<string> {
  const b = (await apiPost(`/repos/${owner}/${repo}/git/blobs`, {
    content,
    encoding: "utf-8",
  })) as { sha?: unknown };
  return str(b.sha);
}

async function defaultCreateTree(
  owner: string,
  repo: string,
  baseTree: string,
  entries: Array<{ path: string; sha: string; mode: string }>
): Promise<string> {
  const t = (await apiPost(`/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseTree,
    tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: "blob", sha: e.sha })),
  })) as { sha?: unknown };
  return str(t.sha);
}

/**
 * Pure planner for DCO surgery: given the PR's commit chain (oldest first),
 * decide which commits need a rewritten message. Signed commits anchor the
 * chain and keep their SHAs; unsigned commits get a replacement mapped
 * old->new parent. Trees are never touched, so every replacement commit
 * carries the exact tree of its original.
 */
export interface DcoPlan {
  /** Commits that need rewriting, in chain order (oldest first). */
  rewrites: Array<{ sha: string; treeSha: string; message: string; newMessage: string }>;
  /** Commits already signed: anchors, untouched. */
  anchors: string[];
}

/** The plan for one PR's commit list, given the full commit objects. */
export function planDcoSurgery(commits: CommitObject[]): DcoPlan {
  const rewrites: DcoPlan["rewrites"] = [];
  const anchors: string[] = [];
  for (const c of commits) {
    if (hasSignoff(c.message)) {
      anchors.push(c.sha);
    } else {
      rewrites.push({
        sha: c.sha,
        treeSha: c.treeSha,
        message: c.message,
        newMessage: withSignoff(c.message),
      });
    }
  }
  return { rewrites, anchors };
}

export interface DcoSurgeryResult {
  oldHead: string;
  newHead: string;
  fixed: number;
  anchored: number;
  /** Every replacement tree matched its original: the diff is byte-identical. */
  treesIdentical: boolean;
}

/**
 * Apply DCO surgery on a fork branch: message-only commit rewrites with
 * byte-identical trees, then force-move the branch ref. Throws before the
 * ref move if any tree would change.
 */
export async function applyDcoSurgery(
  forkOwner: string,
  forkRepo: string,
  branch: string,
  commits: CommitObject[],
  deps: GitOpsDeps = {}
): Promise<DcoSurgeryResult> {
  const getCommit = deps.getCommit ?? defaultGetCommit;
  const createCommit = deps.createCommit ?? defaultCreateCommit;
  const updateRef = deps.updateRef ?? defaultUpdateRef;

  const plan = planDcoSurgery(commits);
  if (plan.rewrites.length === 0) {
    const head = commits.length > 0 ? commits[commits.length - 1].sha : "";
    return { oldHead: head, newHead: head, fixed: 0, anchored: plan.anchors.length, treesIdentical: true };
  }

  const full = new Map(commits.map((c) => [c.sha, c]));
  const shaToNew = new Map<string, string>();
  let lastNewParent = "";
  for (const c of commits) {
    if (hasSignoff(c.message)) {
      shaToNew.set(c.sha, c.sha);
      lastNewParent = c.sha;
      continue;
    }
    const orig = full.get(c.sha) ?? (await getCommit(forkOwner, forkRepo, c.sha));
    const newParents = orig.parents.map((p) => shaToNew.get(p) ?? p);
    // The very first unsigned commit parents a signed anchor; keep going.
    const newSha = await createCommit(forkOwner, forkRepo, {
      message: withSignoff(orig.message),
      tree: orig.treeSha,
      parents: newParents.length > 0 ? newParents : [],
      author: { name: orig.authorName, email: orig.authorEmail },
      committer: { name: orig.committerName, email: orig.committerEmail },
    });
    shaToNew.set(c.sha, newSha);
    lastNewParent = newSha;
  }

  // Verify: every replacement tree equals its original tree.
  let treesIdentical = true;
  for (const c of commits) {
    if (hasSignoff(c.message)) continue;
    const replacement = await getCommit(forkOwner, forkRepo, shaToNew.get(c.sha) ?? "");
    const original = full.get(c.sha) ?? (await getCommit(forkOwner, forkRepo, c.sha));
    if (replacement.treeSha !== original.treeSha) {
      treesIdentical = false;
      break;
    }
  }
  if (!treesIdentical) {
    throw new Error("DCO surgery aborted: a replacement tree differs from its original");
  }

  const oldHead = commits[commits.length - 1].sha;
  const newHead = shaToNew.get(oldHead) ?? oldHead;
  await updateRef(forkOwner, forkRepo, branch, newHead, true);
  return {
    oldHead,
    newHead,
    fixed: plan.rewrites.length,
    anchored: plan.anchors.length,
    treesIdentical: true,
  };
}

export interface GitOps {
  getCommit: NonNullable<GitOpsDeps["getCommit"]>;
  createCommit: NonNullable<GitOpsDeps["createCommit"]>;
  updateRef: NonNullable<GitOpsDeps["updateRef"]>;
  getRef: NonNullable<GitOpsDeps["getRef"]>;
  createBlob: NonNullable<GitOpsDeps["createBlob"]>;
  createTree: NonNullable<GitOpsDeps["createTree"]>;
}

export function defaultGitOps(): GitOps {
  return {
    getCommit: defaultGetCommit,
    createCommit: defaultCreateCommit,
    updateRef: defaultUpdateRef,
    getRef: defaultGetRef,
    createBlob: defaultCreateBlob,
    createTree: defaultCreateTree,
  };
}
