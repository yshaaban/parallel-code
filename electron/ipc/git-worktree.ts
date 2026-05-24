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

export interface GitWorktreeListEntry {
  branchName: string | null;
  detached: boolean;
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

  function flushEntry(): void {
    if (!currentPath) {
      return;
    }

    entries.push({
      branchName,
      detached,
      path: currentPath,
    });
    currentPath = null;
    branchName = null;
    detached = false;
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

    if (line.startsWith('branch ')) {
      branchName = parseWorktreeBranch(line);
    }
  }

  flushEntry();
  return entries;
}

export async function listGitWorktrees(repoRoot: string): Promise<GitWorktreeListEntry[]> {
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
  });
  return parseGitWorktreeList(stdout);
}

async function gitRefExists(repoRoot: string, refName: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', refName], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

async function resolveWorktreeStartRef(
  repoRoot: string,
  baseBranch?: string,
): Promise<{ exists: boolean; refName: string }> {
  const startRef = baseBranch || 'HEAD';
  if (await gitRefExists(repoRoot, startRef)) {
    return { exists: true, refName: startRef };
  }

  if (baseBranch) {
    const originStartRef = `origin/${baseBranch}`;
    if (await gitRefExists(repoRoot, originStartRef)) {
      return { exists: true, refName: originStartRef };
    }
  }

  return { exists: false, refName: startRef };
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
  baseBranch?: string,
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

  const startRef = await resolveWorktreeStartRef(repoRoot, baseBranch);
  if (!startRef.exists) {
    const isEmptyRepo = await exec('git', ['rev-list', '-n1', '--all'], { cwd: repoRoot })
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

  // Create fresh worktree with new branch
  const worktreeArgs = ['worktree', 'add', '-b', branchName, worktreePath];
  if (baseBranch) {
    worktreeArgs.push(startRef.refName);
  }
  await exec('git', worktreeArgs, { cwd: repoRoot });

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
