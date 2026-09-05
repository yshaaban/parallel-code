import { MAX_BUFFER } from './git-cache.js';
import { execGit } from './git-exec.js';
import { getBranchUpstreamRef } from './git-branch-ref.js';

export interface PickedDiffBase {
  ref: string;
  sha: string;
}

async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--verify', ref], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function getMergeBase(
  cwd: string,
  leftRef: string,
  rightRef: string,
): Promise<string | null> {
  try {
    const { stdout } = await execGit(['merge-base', leftRef, rightRef], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getMergeBaseForExistingRef(
  cwd: string,
  refExists: boolean,
  leftRef: string,
  rightRef: string,
): Promise<string | null> {
  if (!refExists) {
    return null;
  }

  return getMergeBase(cwd, leftRef, rightRef);
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function pickClosestDiffBase(
  repoRoot: string,
  mainBranch: string,
  headRef: string,
): Promise<PickedDiffBase> {
  const localRef = mainBranch;
  const remoteRef = await getBranchUpstreamRef(repoRoot, mainBranch);
  const [hasLocalRef, hasRemoteRef] = await Promise.all([
    gitRefExists(repoRoot, `refs/heads/${mainBranch}`).then(async (exists) =>
      exists ? true : gitRefExists(repoRoot, `refs/remotes/${mainBranch}`),
    ),
    gitRefExists(repoRoot, remoteRef.startsWith('refs/') ? remoteRef : `refs/remotes/${remoteRef}`),
  ]);

  const [localMergeBase, remoteMergeBase] = await Promise.all([
    getMergeBaseForExistingRef(repoRoot, hasLocalRef, localRef, headRef),
    getMergeBaseForExistingRef(repoRoot, hasRemoteRef, remoteRef, headRef),
  ]);

  if (localMergeBase === null) {
    if (remoteMergeBase === null) {
      return { ref: headRef, sha: headRef };
    }

    return { ref: remoteRef, sha: remoteMergeBase };
  }

  if (remoteMergeBase === null) {
    return { ref: localRef, sha: localMergeBase };
  }

  if (localMergeBase === remoteMergeBase) {
    return { ref: localRef, sha: localMergeBase };
  }

  if (await isAncestor(repoRoot, remoteMergeBase, localMergeBase)) {
    return { ref: localRef, sha: localMergeBase };
  }

  if (await isAncestor(repoRoot, localMergeBase, remoteMergeBase)) {
    return { ref: remoteRef, sha: remoteMergeBase };
  }

  return { ref: localRef, sha: localMergeBase };
}

async function refineDiffBaseWithCherryPick(
  repoRoot: string,
  base: PickedDiffBase,
  headRef: string,
): Promise<PickedDiffBase> {
  try {
    const { stdout } = await execGit(
      [
        'log',
        '--cherry-pick',
        '--right-only',
        '--no-merges',
        '--reverse',
        '--pretty=%H %P',
        `${base.ref}...${headRef}`,
      ],
      { cwd: repoRoot, maxBuffer: MAX_BUFFER },
    );
    const uniqueCommitLines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (uniqueCommitLines.length === 0) {
      return { ref: headRef, sha: headRef };
    }

    const oldestUniqueCommitParts = uniqueCommitLines[0]?.split(' ') ?? [];
    const oldestUniqueCommitParent = oldestUniqueCommitParts[1];
    if (!oldestUniqueCommitParent) {
      return base;
    }

    const { stdout: countStdout } = await execGit(
      ['rev-list', '--count', '--no-merges', `${oldestUniqueCommitParent}..${headRef}`],
      { cwd: repoRoot },
    );
    const rangeCount = Number.parseInt(countStdout.trim(), 10);
    if (rangeCount === uniqueCommitLines.length) {
      return {
        ref: oldestUniqueCommitParent,
        sha: oldestUniqueCommitParent,
      };
    }
  } catch {
    return base;
  }

  return base;
}

export async function detectDiffBase(
  repoRoot: string,
  mainBranch: string,
  headRef: string,
): Promise<PickedDiffBase> {
  const pickedBase = await pickClosestDiffBase(repoRoot, mainBranch, headRef);
  return refineDiffBaseWithCherryPick(repoRoot, pickedBase, headRef);
}
