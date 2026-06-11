import fs from 'fs';
import path from 'path';

import { detectMainBranch, getCurrentBranchName, listBranches } from './git-branch.js';
import { cacheKey, MAX_BUFFER, withGitQueryCache } from './git-cache.js';
import { execGit } from './git-exec.js';
import { getMergeBaseOrFallback } from './git-merge-base.js';
import { listGitWorktrees, worktreeExists, SYMLINK_CANDIDATES } from './git-worktree.js';
import type { ImportableWorktree } from '../../src/ipc/types.js';

export { invalidateGitQueryCacheForPath, invalidateWorktreeStatusCache } from './git-cache.js';
export { createWorktree, removeWorktree, worktreeExists } from './git-worktree.js';
export type { FileDiffResult, GitChangedFile, ProjectDiffResult } from './git-types.js';
export {
  getAllFileDiffs,
  getAllFileDiffsFromBranch,
  getChangedFiles,
  getChangedFilesFromBranch,
  getChangedFilesFromBranchWithRevision,
  getFileDiff,
  getFileDiffFromBranch,
  getProjectDiff,
} from './git-diff-ops.js';
export { getBranchCommitHistory } from './git-commit-history.js';
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
      await execGit(['check-ignore', '-q', name], { cwd: projectRoot });
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

export { listBranches };

export async function checkoutBranch(projectRoot: string, branchName: string): Promise<void> {
  await execGit(['checkout', branchName], {
    cwd: projectRoot,
    maxBuffer: MAX_BUFFER,
  });
}

export async function getGitRepoRoot(candidatePath: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(['rev-parse', '--show-toplevel'], {
      cwd: candidatePath,
      maxBuffer: MAX_BUFFER,
    });
    const repoRoot = stdout.trim();
    if (repoRoot.length === 0) {
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

export async function getGitCommonDirectory(candidatePath: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(['rev-parse', '--git-common-dir'], {
      cwd: candidatePath,
      maxBuffer: MAX_BUFFER,
    });
    const commonDir = stdout.trim();
    if (commonDir.length === 0) {
      return null;
    }

    return path.isAbsolute(commonDir) ? commonDir : path.resolve(candidatePath, commonDir);
  } catch {
    return null;
  }
}

async function getMergeBaseForHead(worktreePath: string, mainBranch: string): Promise<string> {
  return getMergeBaseOrFallback(worktreePath, mainBranch, 'HEAD', mainBranch);
}

export async function getWorktreeStatus(
  worktreePath: string,
  baseBranch?: string,
): Promise<{ has_committed_changes: boolean; has_uncommitted_changes: boolean }> {
  return withGitQueryCache(
    `worktree-status:${cacheKey(worktreePath)}:${baseBranch ?? ''}`,
    async () => {
      const exists = await worktreeExists(worktreePath);
      if (exists === false) {
        return { has_committed_changes: false, has_uncommitted_changes: false };
      }

      const { stdout: statusOut } = await execGit(['status', '--porcelain'], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      const hasUncommittedChanges = statusOut.trim().length > 0;

      const mainBranch = await detectMainBranch(worktreePath, baseBranch).catch(() => 'HEAD');
      const mergeBase = await getMergeBaseForHead(worktreePath, mainBranch);
      let hasCommittedChanges = false;
      try {
        const { stdout: logOut } = await execGit(['log', mergeBase + '..HEAD', '--oneline'], {
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
    },
  );
}

function normalizeKnownPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

export async function listImportableWorktrees(
  projectRoot: string,
  options?: {
    baseBranch?: string;
    registeredWorktreePaths?: readonly string[];
  },
): Promise<ImportableWorktree[]> {
  const registeredPaths = new Set(
    (options?.registeredWorktreePaths ?? []).map((worktreePath) =>
      normalizeKnownPath(worktreePath),
    ),
  );
  const normalizedProjectRoot = normalizeKnownPath(projectRoot);
  const worktrees = await listGitWorktrees(projectRoot);
  const importableWorktrees = worktrees.filter((worktree) => {
    if (worktree.detached || !worktree.branchName) {
      return false;
    }

    const normalizedPath = normalizeKnownPath(worktree.path);
    return normalizedPath !== normalizedProjectRoot && !registeredPaths.has(normalizedPath);
  });

  return Promise.all(
    importableWorktrees.map(async (worktree) => {
      const status = await getWorktreeStatus(worktree.path, options?.baseBranch);
      return {
        branchName: worktree.branchName ?? '',
        has_committed_changes: status.has_committed_changes,
        has_uncommitted_changes: status.has_uncommitted_changes,
        path: worktree.path,
      };
    }),
  );
}

export async function getBranchLog(worktreePath: string, baseBranch?: string): Promise<string> {
  const mainBranch = await detectMainBranch(worktreePath, baseBranch).catch(() => 'HEAD');
  const mergeBase = await getMergeBaseForHead(worktreePath, mainBranch);
  try {
    const { stdout } = await execGit(['log', mergeBase + '..HEAD', '--pretty=format:- %h %s'], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch {
    return '';
  }
}
