import { normalizeBaseBranch } from '../../src/lib/base-branch.js';
import { toSavedStateDocument, type SavedStateDocument } from './saved-state-document.js';
import {
  cacheKey,
  clearCachedMainBranches,
  getCachedMainBranch,
  setCachedMainBranch,
} from './git-cache.js';
import { execGit } from './git-exec.js';
import type { GitBranchInfo, GitBranchListResult } from '../../src/ipc/types.js';

const configuredBaseBranchByProjectPath = new Map<string, string>();

function getConfiguredBaseBranch(repoRoot: string): string | undefined {
  const normalizedRoot = cacheKey(repoRoot);
  const directMatch = configuredBaseBranchByProjectPath.get(normalizedRoot);
  if (directMatch) {
    return directMatch;
  }

  for (const [projectRoot, baseBranch] of configuredBaseBranchByProjectPath) {
    if (normalizedRoot.startsWith(`${projectRoot}/.worktrees/`)) {
      return baseBranch;
    }
  }

  return undefined;
}

export function syncConfiguredBaseBranchesFromSavedState(
  savedState: string | SavedStateDocument,
): void {
  const parsed = toSavedStateDocument(savedState).taskLookup;
  configuredBaseBranchByProjectPath.clear();
  for (const project of parsed.projects) {
    if (project.projectMode === 'non-git' || !project.path || !project.baseBranch) {
      continue;
    }

    configuredBaseBranchByProjectPath.set(cacheKey(project.path), project.baseBranch);
  }
  clearCachedMainBranches();
}

export async function detectMainBranch(
  repoRoot: string,
  configuredBaseBranch?: string,
): Promise<string> {
  const explicitBaseBranch = normalizeBaseBranch(configuredBaseBranch);
  if (explicitBaseBranch) {
    return explicitBaseBranch;
  }

  const syncedBaseBranch = getConfiguredBaseBranch(repoRoot);
  if (syncedBaseBranch) {
    return syncedBaseBranch;
  }

  const cached = getCachedMainBranch(repoRoot);
  if (cached) return cached;
  const result = await detectMainBranchUncached(repoRoot);
  setCachedMainBranch(repoRoot, result);
  return result;
}

async function resolveRemoteHead(repoRoot: string, remote = 'origin'): Promise<string | null> {
  const prefix = `refs/remotes/${remote}/`;

  try {
    const { stdout } = await execGit(['symbolic-ref', `${prefix}HEAD`], {
      cwd: repoRoot,
    });
    const refname = stdout.trim();
    return refname.startsWith(prefix) ? refname.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

async function remoteTrackingRefExists(
  repoRoot: string,
  branch: string,
  remote = 'origin',
): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--verify', `refs/remotes/${remote}/${branch}`], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

async function localBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--verify', `refs/heads/${branch}`], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

async function detectMainBranchUncached(repoRoot: string): Promise<string> {
  const originHeadBranch = await resolveRemoteHead(repoRoot);
  if (originHeadBranch && (await remoteTrackingRefExists(repoRoot, originHeadBranch))) {
    return originHeadBranch;
  }

  // A locally initialized repository followed by `remote add`/`fetch` has no remote HEAD.
  // Only contact an actual configured remote, and retain the bounded offline fallback.
  const remotes = await execGit(['remote'], { cwd: repoRoot })
    .then(({ stdout }) => stdout.trim().split('\n').filter(Boolean))
    .catch((): string[] => []);
  const remote =
    originHeadBranch || remotes.includes('origin')
      ? 'origin'
      : remotes.length === 1
        ? remotes[0]
        : undefined;
  if (remote) {
    const existingHead =
      remote === 'origin' ? originHeadBranch : await resolveRemoteHead(repoRoot, remote);
    const branchLabel = async (branch: string): Promise<string> =>
      remote === 'origin' || (await localBranchExists(repoRoot, branch))
        ? branch
        : `${remote}/${branch}`;
    if (existingHead && (await remoteTrackingRefExists(repoRoot, existingHead, remote))) {
      return branchLabel(existingHead);
    }

    try {
      await execGit(['remote', 'set-head', remote, '--auto'], {
        cwd: repoRoot,
        timeout: 5_000,
      });
      const refreshedBranch = await resolveRemoteHead(repoRoot, remote);
      if (refreshedBranch && (await remoteTrackingRefExists(repoRoot, refreshedBranch, remote))) {
        return branchLabel(refreshedBranch);
      }
    } catch {
      // Fall through to default branch heuristics when the remote is unavailable
      // or the local repo cannot refresh its remote HEAD symref.
    }
  }

  for (const branch of ['main', 'master']) {
    if (await remoteTrackingRefExists(repoRoot, branch)) {
      return branch;
    }
  }

  for (const branch of ['main', 'master']) {
    if (await localBranchExists(repoRoot, branch)) {
      return branch;
    }
  }

  // Prefer the primary checkout's real branch, including an unborn custom branch. Looking at
  // this worktree's HEAD instead would incorrectly make a managed task its own comparison base.
  try {
    const { stdout } = await execGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
    const primaryEntry = stdout.split('\n\n')[0];
    const branch = primaryEntry?.split('\n').find((line) => line.startsWith('branch refs/heads/'));
    if (branch) return branch.slice('branch refs/heads/'.length);
  } catch {
    // Older Git or unavailable worktree metadata can still expose the current symbolic HEAD.
  }
  const currentBranch = await getCurrentBranchName(repoRoot).catch(() => null);
  if (currentBranch) return currentBranch;

  // No symbolic branch is available (for example detached HEAD in a repository without defaults).
  try {
    const { stdout } = await execGit(['config', '--get', 'init.defaultBranch'], {
      cwd: repoRoot,
    });
    const configured = stdout.trim();
    if (configured) return configured;
  } catch {
    /* ignore */
  }

  return 'main';
}

export async function getCurrentBranchName(repoRoot: string): Promise<string> {
  const { stdout } = await execGit(['symbolic-ref', '--short', 'HEAD'], { cwd: repoRoot });
  return stdout.trim();
}

function splitRemoteBranch(refName: string): { branchName: string; remoteName: string } | null {
  const remotePrefix = 'refs/remotes/';
  if (!refName.startsWith(remotePrefix)) {
    return null;
  }

  const remoteRef = refName.slice(remotePrefix.length);
  const separatorIndex = remoteRef.indexOf('/');
  if (separatorIndex <= 0) {
    return null;
  }

  const remoteName = remoteRef.slice(0, separatorIndex);
  const branchName = remoteRef.slice(separatorIndex + 1);
  if (!branchName || branchName === 'HEAD') {
    return null;
  }

  return { branchName, remoteName };
}

function createBranchSortKey(branch: GitBranchInfo, defaultBranch: string): string {
  if (branch.name === defaultBranch) {
    return `0:${branch.name}`;
  }
  if (branch.current) {
    return `1:${branch.name}`;
  }
  if (branch.local) {
    return `2:${branch.name}`;
  }
  return `3:${branch.name}`;
}

function sortBranches(branches: GitBranchInfo[], defaultBranch: string): GitBranchInfo[] {
  return [...branches].sort((a, b) =>
    createBranchSortKey(a, defaultBranch).localeCompare(
      createBranchSortKey(b, defaultBranch),
      undefined,
      {
        numeric: true,
        sensitivity: 'base',
      },
    ),
  );
}

function mergeBranchInfo(
  branchesByName: Map<string, GitBranchInfo>,
  name: string,
  update: Partial<GitBranchInfo> & Pick<GitBranchInfo, 'name'>,
): void {
  const previous = branchesByName.get(name);
  const merged: GitBranchInfo = {
    current: previous?.current === true || update.current === true,
    local: previous?.local === true || update.local === true,
    name,
    remote: previous?.remote === true || update.remote === true,
  };

  const remoteRef = update.remoteRef ?? previous?.remoteRef;
  if (remoteRef !== undefined) {
    merged.remoteRef = remoteRef;
  }

  const upstream = update.upstream ?? previous?.upstream;
  if (upstream !== undefined) {
    merged.upstream = upstream;
  }

  branchesByName.set(name, merged);
}

export async function listBranches(repoRoot: string): Promise<GitBranchListResult> {
  const [defaultBranch, currentBranch] = await Promise.all([
    detectMainBranch(repoRoot),
    getCurrentBranchName(repoRoot).catch(() => null),
  ]);
  const { stdout } = await execGit(
    ['for-each-ref', '--format=%(refname)%09%(upstream:short)', 'refs/heads', 'refs/remotes'],
    { cwd: repoRoot },
  );
  const branchesByName = new Map<string, GitBranchInfo>();

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const [refName, upstream] = trimmed.split('\t');
    const localPrefix = 'refs/heads/';
    if (refName?.startsWith(localPrefix)) {
      const name = refName.slice(localPrefix.length);
      mergeBranchInfo(branchesByName, name, {
        current: currentBranch === name,
        local: true,
        name,
        remote: false,
        ...(upstream ? { upstream } : {}),
      });
      continue;
    }

    if (!refName) {
      continue;
    }

    const remoteBranch = splitRemoteBranch(refName);
    if (!remoteBranch) {
      continue;
    }

    const remoteRef = `${remoteBranch.remoteName}/${remoteBranch.branchName}`;
    const name = remoteBranch.remoteName === 'origin' ? remoteBranch.branchName : remoteRef;
    mergeBranchInfo(branchesByName, name, {
      current: currentBranch === name,
      local: false,
      name,
      remote: true,
      remoteRef,
    });
  }

  if (!branchesByName.has(defaultBranch)) {
    mergeBranchInfo(branchesByName, defaultBranch, {
      current: currentBranch === defaultBranch,
      local: false,
      name: defaultBranch,
      remote: false,
    });
  }

  return {
    branches: sortBranches([...branchesByName.values()], defaultBranch),
    defaultBranch,
    generatedAt: Date.now(),
  };
}
