import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { invalidateGitQueryCacheForPath } from './git-cache.js';

const exec = promisify(execFile);

const SYMLINK_CANDIDATES = [
  '.claude',
  '.cursor',
  '.aider',
  '.copilot',
  '.codeium',
  '.continue',
  '.windsurf',
  '.env',
  'node_modules',
];

/** Entries inside `.claude` that must NOT be symlinked (kept per-worktree). */
const CLAUDE_DIR_EXCLUDE = new Set(['plans', 'settings.local.json']);

export { SYMLINK_CANDIDATES };

export async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(worktreePath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * "Shallow-symlink" a directory: create a real directory at `target` and
 * symlink each entry from `source` into it, EXCEPT entries in `exclude`.
 */
function shallowSymlinkDir(source: string, target: string, exclude: Set<string>): void {
  fs.mkdirSync(target, { recursive: true });
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch (err) {
    console.warn(`Failed to read directory ${source} for shallow-symlink:`, err);
    return;
  }
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    try {
      fs.symlinkSync(src, dst);
    } catch (err: unknown) {
      // EEXIST is expected if the symlink already exists; log other errors
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        console.warn(`Failed to symlink ${src} -> ${dst}:`, err);
      }
    }
  }
}

export async function createWorktree(
  repoRoot: string,
  branchName: string,
  symlinkDirs: string[],
  forceClean = false,
): Promise<{ path: string; branch: string }> {
  const worktreePath = `${repoRoot}/.worktrees/${branchName}`;

  if (forceClean) {
    // Clean up stale worktree/branch from a previous session that wasn't properly removed
    if (fs.existsSync(worktreePath)) {
      try {
        await exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
      } catch {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      await exec('git', ['worktree', 'prune'], { cwd: repoRoot }).catch((e) =>
        console.warn('git worktree prune failed:', e),
      );
    }

    // Delete stale branch ref if it still exists
    try {
      await exec('git', ['branch', '-D', branchName], { cwd: repoRoot });
    } catch {
      // Branch doesn't exist — fine
    }
  }

  // Create fresh worktree with new branch
  await exec('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: repoRoot });

  // Symlink selected directories
  for (const name of symlinkDirs) {
    // Reject names that could escape the worktree directory
    if (name.includes('/') || name.includes('\\') || name.includes('..') || name === '.') continue;
    const source = path.join(repoRoot, name);
    const target = path.join(worktreePath, name);
    try {
      if (!fs.existsSync(source)) continue;
      if (fs.existsSync(target)) continue;

      if (name === '.claude') {
        // Shallow-symlink: real dir with per-entry symlinks, excluding per-worktree entries
        shallowSymlinkDir(source, target, CLAUDE_DIR_EXCLUDE);
      } else {
        fs.symlinkSync(source, target);
      }
    } catch {
      /* ignore */
    }
  }

  return { path: worktreePath, branch: branchName };
}

export async function removeWorktree(
  repoRoot: string,
  branchName: string,
  deleteBranch: boolean,
): Promise<void> {
  const worktreePath = `${repoRoot}/.worktrees/${branchName}`;
  invalidateGitQueryCacheForPath(worktreePath);

  if (!fs.existsSync(repoRoot)) return;

  if (fs.existsSync(worktreePath)) {
    try {
      await exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
    } catch {
      // Fallback: direct directory removal
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  // Prune stale worktree entries
  try {
    await exec('git', ['worktree', 'prune'], { cwd: repoRoot });
  } catch {
    /* ignore */
  }

  if (deleteBranch) {
    try {
      await exec('git', ['branch', '-D', '--', branchName], { cwd: repoRoot });
    } catch (e: unknown) {
      const msg = String(e);
      if (!msg.toLowerCase().includes('not found')) throw e;
    }
  }
}
