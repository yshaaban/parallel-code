import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { detectMainBranch, getCurrentBranchName } from './git-branch.js';
import { cacheKey, MAX_BUFFER, withGitQueryCache } from './git-cache.js';
import { worktreeExists, SYMLINK_CANDIDATES } from './git-worktree.js';

const exec = promisify(execFile);

export { invalidateGitQueryCacheForPath, invalidateWorktreeStatusCache } from './git-cache.js';
export { createWorktree, removeWorktree, worktreeExists } from './git-worktree.js';
export type { FileDiffResult, GitChangedFile, ProjectDiffResult } from './git-types.js';
export {
  getAllFileDiffs,
  getAllFileDiffsFromBranch,
  getChangedFiles,
  getChangedFilesFromBranch,
  getFileDiff,
  getFileDiffFromBranch,
  getProjectDiff,
} from './git-diff-ops.js';
export {
  checkMergeStatus,
  commitAll,
  discardUncommitted,
  mergeTask,
  pushTask,
  streamPushTask,
  rebaseTask,
} from './git-mutation-ops.js';

export async function getGitIgnoredDirs(projectRoot: string): Promise<string[]> {
  const results: string[] = [];
  for (const name of SYMLINK_CANDIDATES) {
    const dirPath = path.join(projectRoot, name);
    try {
      fs.statSync(dirPath);
    } catch {
      continue;
    }

    try {
      await exec('git', ['check-ignore', '-q', name], { cwd: projectRoot });
      results.push(name);
    } catch {
      // directory is not ignored
    }
  }

  return results;
}

export async function getMainBranch(
  projectRoot: string,
  configuredBaseBranch?: string,
): Promise<string> {
  return detectMainBranch(projectRoot, configuredBaseBranch);
}

export async function getCurrentBranch(projectRoot: string): Promise<string> {
  return getCurrentBranchName(projectRoot);
}

export async function getGitRepoRoot(candidatePath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], {
      cwd: candidatePath,
      maxBuffer: MAX_BUFFER,
    });
    const repoRoot = stdout.trim();
    if (!repoRoot) {
      return null;
    }

    const resolvedCandidatePath = path.resolve(candidatePath);
    const resolvedRepoRoot = path.resolve(repoRoot);

    try {
      if (fs.realpathSync(resolvedCandidatePath) === fs.realpathSync(resolvedRepoRoot)) {
        return resolvedCandidatePath;
      }
    } catch {
      // Fall through to the resolved repo root when either path cannot be canonicalized.
    }

    return resolvedRepoRoot;
  } catch {
    return null;
  }
}

export async function getWorktreeStatus(
  worktreePath: string,
): Promise<{ has_committed_changes: boolean; has_uncommitted_changes: boolean }> {
  return withGitQueryCache(`worktree-status:${cacheKey(worktreePath)}`, async () => {
    if (!(await worktreeExists(worktreePath))) {
      return { has_committed_changes: false, has_uncommitted_changes: false };
    }

    const { stdout: statusOut } = await exec('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    const hasUncommittedChanges = statusOut.trim().length > 0;

    const mainBranch = await detectMainBranch(worktreePath).catch(() => 'HEAD');
    let hasCommittedChanges = false;
    try {
      const { stdout: logOut } = await exec('git', ['log', `${mainBranch}..HEAD`, '--oneline'], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      hasCommittedChanges = logOut.trim().length > 0;
    } catch {
      // ignore
    }

    return {
      has_committed_changes: hasCommittedChanges,
      has_uncommitted_changes: hasUncommittedChanges,
    };
  });
}

export async function getBranchLog(worktreePath: string): Promise<string> {
  const mainBranch = await detectMainBranch(worktreePath).catch(() => 'HEAD');
  try {
    const { stdout } = await exec(
      'git',
      ['log', `${mainBranch}..HEAD`, '--pretty=format:- %h %s'],
      {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      },
    );
    return stdout;
  } catch {
    return '';
  }
}
