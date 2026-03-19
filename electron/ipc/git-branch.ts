import { execFile } from 'child_process';
import { promisify } from 'util';

import { normalizeBaseBranch } from '../../src/lib/base-branch.js';
import { parsePersistedTaskLookupState } from './persisted-task-lookup-state.js';
import {
  cacheKey,
  clearCachedMainBranches,
  getCachedMainBranch,
  setCachedMainBranch,
} from './git-cache.js';

const exec = promisify(execFile);
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

export function syncConfiguredBaseBranchesFromSavedState(savedJson: string): void {
  const parsed = parsePersistedTaskLookupState(savedJson);
  configuredBaseBranchByProjectPath.clear();
  for (const project of parsed.projects) {
    if (!project.path || !project.baseBranch) {
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

async function resolveOriginHead(repoRoot: string): Promise<string | null> {
  const prefix = 'refs/remotes/origin/';

  try {
    const { stdout } = await exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoRoot,
    });
    const refname = stdout.trim();
    return refname.startsWith(prefix) ? refname.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

async function remoteTrackingRefExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

async function detectMainBranchUncached(repoRoot: string): Promise<string> {
  const originHeadBranch = await resolveOriginHead(repoRoot);
  if (originHeadBranch) {
    if (await remoteTrackingRefExists(repoRoot, originHeadBranch)) {
      return originHeadBranch;
    }

    try {
      await exec('git', ['remote', 'set-head', 'origin', '--auto'], {
        cwd: repoRoot,
        timeout: 5_000,
      });
      const refreshedBranch = await resolveOriginHead(repoRoot);
      if (refreshedBranch && (await remoteTrackingRefExists(repoRoot, refreshedBranch))) {
        return refreshedBranch;
      }
    } catch {
      // Fall through to default branch heuristics when the remote is unavailable
      // or the local repo cannot refresh its origin HEAD symref.
    }
  }

  for (const branch of ['main', 'master']) {
    if (await remoteTrackingRefExists(repoRoot, branch)) {
      return branch;
    }
  }

  // Empty repo (no commits yet) — use configured default branch or fall back to "main"
  try {
    const { stdout } = await exec('git', ['config', '--get', 'init.defaultBranch'], {
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
  const { stdout } = await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoRoot });
  return stdout.trim();
}
