import fs from 'fs';
import path from 'node:path';

import {
  findBranchRefPrefixConflict,
  formatBranchRefPrefixConflict,
} from '../../src/lib/branch-name.js';
import { BadRequestError } from './errors.js';
import { invalidateGitQueryCacheForPath } from './git-cache.js';
import { execGit } from './git-exec.js';
import { resolveBranchRef } from './git-branch-ref.js';
import {
  applyRequestedWorktreeSymlinks,
  assertTaskWorktreeLinkRequestV1,
  type TaskWorktreeLinkRequestV1,
  WorktreeSymlinkSafetyError,
} from './git-worktree-symlinks.js';
import type { WorktreeSymlinkWarning } from '../../src/ipc/types.js';

export interface GitWorktreeListEntry {
  branchName: string | null;
  detached: boolean;
  lockedReason?: string;
  path: string;
}

export async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(worktreePath)).isDirectory();
  } catch {
    return false;
  }
}

function parseWorktreeBranch(line: string): string | null {
  const branchRef = line.slice('branch '.length).trim();
  const headsPrefix = 'refs/heads/';
  if (branchRef.startsWith(headsPrefix)) {
    return branchRef.slice(headsPrefix.length);
  }

  return branchRef.length > 0 ? branchRef : null;
}

function parseGitWorktreeList(output: string): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let currentPath: string | null = null;
  let branchName: string | null = null;
  let detached = false;
  let lockedReason: string | undefined;

  function flushEntry(): void {
    if (!currentPath) {
      return;
    }

    entries.push({
      branchName,
      detached,
      ...(lockedReason !== undefined ? { lockedReason } : {}),
      path: currentPath,
    });
    currentPath = null;
    branchName = null;
    detached = false;
    lockedReason = undefined;
  }

  for (const line of output.split('\n')) {
    if (line.trim().length === 0) {
      flushEntry();
      continue;
    }

    if (line.startsWith('worktree ')) {
      flushEntry();
      currentPath = line.slice('worktree '.length).trim();
      continue;
    }

    if (line === 'detached') {
      detached = true;
      continue;
    }

    if (line === 'locked' || line.startsWith('locked ')) {
      lockedReason = line.slice('locked'.length).trim();
      continue;
    }

    if (line.startsWith('branch ')) {
      branchName = parseWorktreeBranch(line);
    }
  }

  flushEntry();
  return entries;
}

export async function listGitWorktrees(repoRoot: string): Promise<GitWorktreeListEntry[]> {
  const { stdout } = await execGit(['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
  });
  return parseGitWorktreeList(stdout);
}

async function listLocalBranchNames(repoRoot: string): Promise<string[]> {
  const { stdout } = await execGit(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads'], {
    cwd: repoRoot,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function assertBranchRefPrefixAvailable(repoRoot: string, branchName: string): Promise<void> {
  const localBranches = await listLocalBranchNames(repoRoot);
  const conflict = findBranchRefPrefixConflict(branchName, localBranches);
  if (conflict) {
    throw new BadRequestError(formatBranchRefPrefixConflict(conflict));
  }
}

export interface CreatedWorktree {
  branch: string;
  path: string;
  symlink_warnings?: WorktreeSymlinkWarning[];
}

function pathEntryExists(candidatePath: string): boolean {
  try {
    fs.lstatSync(candidatePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

async function cleanupFailedCreatedWorktree(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  let worktreeRemoved = false;
  try {
    await execGit(['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
    worktreeRemoved = !pathEntryExists(worktreePath);
  } catch {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      worktreeRemoved = !pathEntryExists(worktreePath);
    } catch {
      worktreeRemoved = false;
    }
  }

  const failures: unknown[] = [];
  if (!worktreeRemoved) {
    failures.push(new Error(`Could not remove failed worktree ${worktreePath}`));
  }
  try {
    await execGit(['worktree', 'prune'], { cwd: repoRoot });
  } catch (error) {
    failures.push(error);
  }
  try {
    await execGit(['branch', '-D', '--', branchName], { cwd: repoRoot });
  } catch (error) {
    const message = String(error).toLowerCase();
    if (!message.includes('not found') && !message.includes('not exist')) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new WorktreeSymlinkSafetyError('Failed to clean an unsafe worktree creation', failures);
  }
}

export async function createWorktree(
  repoRoot: string,
  branchName: string,
  worktreeLinkRequest: TaskWorktreeLinkRequestV1,
  forceClean = false,
  baseBranch?: string,
): Promise<CreatedWorktree> {
  assertTaskWorktreeLinkRequestV1(worktreeLinkRequest);
  const worktreePath = `${repoRoot}/.worktrees/${branchName}`;

  if (forceClean) {
    // Clean up stale worktree/branch from a previous session that wasn't properly removed
    if (fs.existsSync(worktreePath)) {
      try {
        await execGit(['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
      } catch {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      await execGit(['worktree', 'prune'], { cwd: repoRoot }).catch((e) =>
        console.warn('git worktree prune failed:', e),
      );
    }

    // Delete stale branch ref if it still exists
    try {
      await execGit(['branch', '-D', branchName], { cwd: repoRoot });
    } catch {
      // Branch doesn't exist — fine
    }
  }

  const startRef = await resolveBranchRef(repoRoot, baseBranch);
  if (!startRef.exists) {
    const isEmptyRepo = await execGit(['rev-list', '-n1', '--all'], { cwd: repoRoot })
      .then(({ stdout }) => !stdout.trim())
      .catch(() => true);
    if (isEmptyRepo) {
      throw new Error(
        'Cannot create a worktree in a repository with no commits. Please make an initial commit first.',
      );
    }

    throw new Error(
      `Branch "${baseBranch || startRef.refName}" does not exist. Please select a valid base branch or create the branch first.`,
    );
  }

  await assertBranchRefPrefixAvailable(repoRoot, branchName);

  // Create fresh worktree with new branch
  const worktreeArgs = ['worktree', 'add', '-b', branchName, worktreePath];
  if (baseBranch) {
    worktreeArgs.push(startRef.refName);
  }
  await execGit(worktreeArgs, { cwd: repoRoot });

  let warnings: WorktreeSymlinkWarning[];
  try {
    ({ warnings } = await applyRequestedWorktreeSymlinks(
      repoRoot,
      worktreePath,
      worktreeLinkRequest,
    ));
  } catch (operationError) {
    try {
      await cleanupFailedCreatedWorktree(repoRoot, worktreePath, branchName);
    } catch (cleanupError) {
      throw new WorktreeSymlinkSafetyError(
        'Worktree link safety failed and cleanup did not settle cleanly',
        [operationError, cleanupError],
      );
    }
    throw operationError;
  }

  return {
    branch: branchName,
    path: worktreePath,
    ...(warnings.length > 0 ? { symlink_warnings: warnings } : {}),
  };
}

export async function removeWorktree(
  repoRoot: string,
  branchName: string,
  deleteBranch: boolean,
  expectedWorktreePath?: string,
): Promise<void> {
  const worktreePath = `${repoRoot}/.worktrees/${branchName}`;
  if (
    expectedWorktreePath !== undefined &&
    path.resolve(expectedWorktreePath) !== path.resolve(worktreePath)
  ) {
    throw new Error('Managed worktree cleanup target changed');
  }
  invalidateGitQueryCacheForPath(worktreePath);

  if (!fs.existsSync(repoRoot)) return;

  if (fs.existsSync(worktreePath)) {
    // Git refuses dirty worktrees here. Keeping canonical task membership on failure gives the user
    // an explicit recovery path and avoids the previous recursive-delete fallback's data loss.
    await execGit(['worktree', 'remove', worktreePath], { cwd: repoRoot });
  }

  // Prune stale worktree entries
  try {
    await execGit(['worktree', 'prune'], { cwd: repoRoot });
  } catch {
    /* ignore */
  }

  if (deleteBranch) {
    try {
      await execGit(['branch', '-D', '--', branchName], { cwd: repoRoot });
    } catch (e: unknown) {
      const msg = String(e);
      if (!msg.toLowerCase().includes('not found')) throw e;
    }
  }
}
