import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { detectMainBranch, getCurrentBranchName } from './git-branch.js';
import {
  cacheKey,
  getCachedMergeBase,
  invalidateGitQueryCacheForPath,
  invalidateMergeBaseCache,
  MAX_BUFFER,
  setCachedMergeBase,
  withGitQueryCache,
  withWorktreeLock,
} from './git-cache.js';
import { NotFoundError } from './errors.js';
import {
  normalizeStatusPath,
  parseConflictPath,
  parseDiffRawNumstat,
  parseNumstat,
} from './git-status-parser.js';
import { removeWorktree, SYMLINK_CANDIDATES, worktreeExists } from './git-worktree.js';

const exec = promisify(execFile);

export { invalidateWorktreeStatusCache } from './git-cache.js';
export { createWorktree, removeWorktree, worktreeExists } from './git-worktree.js';

async function detectMergeBase(repoRoot: string, head?: string): Promise<string> {
  const cached = getCachedMergeBase(repoRoot);
  if (cached) return cached;
  const mainBranch = await detectMainBranch(repoRoot);
  let result: string;
  try {
    const { stdout } = await exec('git', ['merge-base', mainBranch, head ?? 'HEAD'], {
      cwd: repoRoot,
    });
    const hash = stdout.trim();
    result = hash || mainBranch;
  } catch {
    result = mainBranch;
  }

  setCachedMergeBase(repoRoot, result);
  return result;
}

async function pinHead(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
    return stdout.trim();
  } catch {
    return 'HEAD';
  }
}

async function detectRepoLockKey(p: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: p });
  const commonDir = stdout.trim();
  const commonPath = path.isAbsolute(commonDir) ? commonDir : path.join(p, commonDir);
  try {
    return fs.realpathSync(commonPath);
  } catch {
    return commonPath;
  }
}

async function computeBranchDiffStats(
  projectRoot: string,
  mainBranch: string,
  branchName: string,
): Promise<{ linesAdded: number; linesRemoved: number }> {
  const { stdout } = await exec('git', ['diff', '--numstat', `${mainBranch}..${branchName}`], {
    cwd: projectRoot,
    maxBuffer: MAX_BUFFER,
  });
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    linesAdded += parseInt(parts[0], 10) || 0;
    linesRemoved += parseInt(parts[1], 10) || 0;
  }
  return { linesAdded, linesRemoved };
}

// --- IPC command functions ---

export async function getGitIgnoredDirs(projectRoot: string): Promise<string[]> {
  const results: string[] = [];
  for (const name of SYMLINK_CANDIDATES) {
    const dirPath = path.join(projectRoot, name);
    try {
      fs.statSync(dirPath); // throws if entry doesn't exist
    } catch {
      continue;
    }
    try {
      await exec('git', ['check-ignore', '-q', name], { cwd: projectRoot });
      results.push(name);
    } catch {
      /* not ignored */
    }
  }
  return results;
}

export async function getMainBranch(projectRoot: string): Promise<string> {
  return detectMainBranch(projectRoot);
}

export async function getCurrentBranch(projectRoot: string): Promise<string> {
  return getCurrentBranchName(projectRoot);
}

export async function getChangedFiles(worktreePath: string): Promise<
  Array<{
    path: string;
    lines_added: number;
    lines_removed: number;
    status: string;
    committed: boolean;
  }>
> {
  return withGitQueryCache(`changed-files:${cacheKey(worktreePath)}`, async () => {
    if (!(await worktreeExists(worktreePath))) {
      throw new NotFoundError(`Worktree not found: ${worktreePath}`);
    }

    // Pin HEAD first so merge-base and diff use the same immutable commit
    const headHash = await pinHead(worktreePath);
    const base = await detectMergeBase(worktreePath, headHash).catch(() => headHash);

    // git diff --raw --numstat <base> <head> — committed changes only (immutable)
    let diffStr = '';
    try {
      const { stdout } = await exec('git', ['diff', '--raw', '--numstat', base, headHash], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      diffStr = stdout;
    } catch {
      /* empty */
    }

    const { statusMap: committedStatusMap, numstatMap: committedNumstatMap } =
      parseDiffRawNumstat(diffStr);

    // git status --porcelain for uncommitted/untracked paths
    let statusStr = '';
    try {
      const { stdout } = await exec('git', ['status', '--porcelain'], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      statusStr = stdout;
    } catch {
      /* empty */
    }

    const uncommittedPaths = new Map<string, string>(); // path -> status letter
    const untrackedPaths = new Set<string>();
    for (const line of statusStr.split('\n')) {
      if (line.length < 3) continue;
      const p = normalizeStatusPath(line.slice(3));
      if (!p) continue;
      if (line.startsWith('??')) {
        untrackedPaths.add(p);
        uncommittedPaths.set(p, '?');
      } else {
        // Prefer working tree status, fall back to index status
        const wtStatus = line[1];
        const indexStatus = line[0];
        uncommittedPaths.set(p, wtStatus !== ' ' ? wtStatus : indexStatus);
      }
    }

    const files: Array<{
      path: string;
      lines_added: number;
      lines_removed: number;
      status: string;
      committed: boolean;
    }> = [];
    const seen = new Set<string>();

    // Committed files from diff base..HEAD
    for (const [p, [added, removed]] of committedNumstatMap) {
      const status = committedStatusMap.get(p) ?? 'M';
      // If also in uncommitted paths, mark as uncommitted (has local changes on top)
      const committed = !uncommittedPaths.has(p);
      seen.add(p);
      files.push({ path: p, lines_added: added, lines_removed: removed, status, committed });
    }

    // Uncommitted-only files (in status but not in committed diff)
    // Use git diff --numstat HEAD for tracked files to get actual changed line counts
    const uncommittedNumstat = new Map<string, [number, number]>();
    const hasTrackedUncommitted = [...uncommittedPaths.keys()].some(
      (p) => !seen.has(p) && !untrackedPaths.has(p),
    );
    if (hasTrackedUncommitted) {
      try {
        const { stdout } = await exec('git', ['diff', '--numstat', 'HEAD'], {
          cwd: worktreePath,
          maxBuffer: MAX_BUFFER,
        });
        for (const line of stdout.split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            const a = parseInt(parts[0], 10);
            const r = parseInt(parts[1], 10);
            if (!isNaN(a) && !isNaN(r)) {
              const rawPath = parts[parts.length - 1];
              const np = normalizeStatusPath(rawPath);
              if (np) uncommittedNumstat.set(np, [a, r]);
            }
          }
        }
      } catch {
        /* ignore */
      }
    }

    for (const [p, statusLetter] of uncommittedPaths) {
      if (seen.has(p)) continue;
      let added = 0;
      let removed = 0;

      if (untrackedPaths.has(p)) {
        // Untracked (new) files: count all lines as added
        const fullPath = path.join(worktreePath, p);
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.isFile() && stat.size < MAX_BUFFER) {
            const content = await fs.promises.readFile(fullPath, 'utf8');
            const lines = content.split('\n');
            added = content.endsWith('\n') ? lines.length - 1 : lines.length;
          }
        } catch {
          /* ignore */
        }
      } else {
        // Tracked files: use actual diff stats
        const stats = uncommittedNumstat.get(p);
        if (stats) {
          [added, removed] = stats;
        }
      }

      files.push({
        path: p,
        lines_added: added,
        lines_removed: removed,
        status: statusLetter,
        committed: false,
      });
    }

    files.sort((a, b) => {
      if (a.committed !== b.committed) return a.committed ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    return files;
  });
}

interface FileDiffResult {
  diff: string;
  oldContent: string;
  newContent: string;
}

/** Split content into diff-ready lines, stripping the trailing empty element from newline-terminated content. */
function toDiffLines(content: string): string[] {
  if (content === '') return [];
  return content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
}

export async function getFileDiff(worktreePath: string, filePath: string): Promise<FileDiffResult> {
  // Pin HEAD first so merge-base and all reads use the same immutable commit
  const headHash = await pinHead(worktreePath);
  const base = await detectMergeBase(worktreePath, headHash).catch(() => headHash);

  // Old content from merge base
  let oldContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${base}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    oldContent = stdout;
  } catch {
    /* file didn't exist at base — new file */
  }

  // New content: prefer committed content from HEAD, fall back to disk
  let newContent = '';
  let committedContent = '';
  let fileExistsOnDisk = false;
  let fileContentReadable = false;

  // Try reading committed content from git
  try {
    const { stdout } = await exec('git', ['show', `${headHash}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    committedContent = stdout;
  } catch {
    /* file not in HEAD — untracked or new */
  }

  // Read disk content
  const fullPath = path.join(worktreePath, filePath);
  let diskContent = '';
  try {
    const stat = await fs.promises.stat(fullPath);
    if (stat.isFile()) {
      fileExistsOnDisk = true;
      if (stat.size < MAX_BUFFER) {
        diskContent = await fs.promises.readFile(fullPath, 'utf8');
        fileContentReadable = true;
      }
    }
  } catch {
    /* file doesn't exist — deleted file */
  }

  // Detect uncommitted deletion: file tracked in HEAD but deleted locally
  const isUncommittedDeletion = !fileExistsOnDisk && committedContent !== '';

  // Select newContent based on file state
  const hasUncommittedChanges =
    committedContent && fileExistsOnDisk && fileContentReadable && diskContent !== committedContent;
  if (isUncommittedDeletion) {
    newContent = '';
    // File added in branch but deleted locally — show committed content as "old" side
    if (!oldContent && committedContent) {
      oldContent = committedContent;
    }
  } else if (hasUncommittedChanges) {
    newContent = diskContent;
  } else if (committedContent) {
    newContent = committedContent;
  } else {
    newContent = diskContent;
  }

  // Generate diff between base and HEAD for committed files (immutable, no race)
  let diff = '';
  try {
    const { stdout } = await exec('git', ['diff', base, headHash, '--', filePath], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    if (stdout.trim()) diff = stdout;
  } catch {
    /* empty */
  }

  // Untracked/uncommitted file with no committed diff — build pseudo-diff from disk content
  // Only when content was actually readable (skip for files exceeding MAX_BUFFER)
  if (!diff && fileExistsOnDisk && !oldContent && fileContentReadable) {
    const lines = toDiffLines(newContent);
    let pseudo = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n`;
    for (const line of lines) {
      pseudo += `+${line}\n`;
    }
    diff = pseudo;
  }

  // Uncommitted deletion with no committed diff — build deletion pseudo-diff
  if (!diff && isUncommittedDeletion && oldContent) {
    const lines = toDiffLines(oldContent);
    let pseudo = `--- a/${filePath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n`;
    for (const line of lines) {
      pseudo += `-${line}\n`;
    }
    diff = pseudo;
  }

  return { diff, oldContent, newContent };
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
      /* ignore */
    }

    return {
      has_committed_changes: hasCommittedChanges,
      has_uncommitted_changes: hasUncommittedChanges,
    };
  });
}

/** Stage all changes and commit in a worktree. */
export async function commitAll(worktreePath: string, message: string): Promise<void> {
  await exec('git', ['add', '-A'], { cwd: worktreePath });
  await exec('git', ['commit', '-m', message], { cwd: worktreePath });
  invalidateGitQueryCacheForPath(worktreePath);
}

/** Discard all uncommitted changes in a worktree (keeps committed work). */
export async function discardUncommitted(worktreePath: string): Promise<void> {
  await exec('git', ['checkout', '.'], { cwd: worktreePath });
  await exec('git', ['clean', '-fd'], { cwd: worktreePath });
  invalidateGitQueryCacheForPath(worktreePath);
}

export async function checkMergeStatus(
  worktreePath: string,
): Promise<{ main_ahead_count: number; conflicting_files: string[] }> {
  const mainBranch = await detectMainBranch(worktreePath);

  let mainAheadCount = 0;
  try {
    const { stdout } = await exec('git', ['rev-list', '--count', `HEAD..${mainBranch}`], {
      cwd: worktreePath,
    });
    mainAheadCount = parseInt(stdout.trim(), 10) || 0;
  } catch {
    /* ignore */
  }

  if (mainAheadCount === 0) return { main_ahead_count: 0, conflicting_files: [] };

  const conflictingFiles: string[] = [];
  try {
    await exec('git', ['merge-tree', '--write-tree', 'HEAD', mainBranch], { cwd: worktreePath });
  } catch (e: unknown) {
    // merge-tree outputs conflict info on failure
    const output = String(e);
    for (const line of output.split('\n')) {
      const p = parseConflictPath(line);
      if (p) conflictingFiles.push(p);
    }
  }

  return { main_ahead_count: mainAheadCount, conflicting_files: conflictingFiles };
}

export async function mergeTask(
  projectRoot: string,
  branchName: string,
  squash: boolean,
  message: string | null,
  cleanup: boolean,
): Promise<{ main_branch: string; lines_added: number; lines_removed: number }> {
  const lockKey = await detectRepoLockKey(projectRoot).catch(() => projectRoot);

  return withWorktreeLock(lockKey, async () => {
    const mainBranch = await detectMainBranch(projectRoot);
    const { linesAdded, linesRemoved } = await computeBranchDiffStats(
      projectRoot,
      mainBranch,
      branchName,
    );

    // Verify clean working tree
    const { stdout: statusOut } = await exec('git', ['status', '--porcelain'], {
      cwd: projectRoot,
    });
    if (statusOut.trim())
      throw new Error(
        'Project root has uncommitted changes. Please commit or stash them before merging.',
      );

    const originalBranch = await getCurrentBranchName(projectRoot).catch(() => null);

    // Checkout main
    await exec('git', ['checkout', mainBranch], { cwd: projectRoot });

    const restoreBranch = async () => {
      if (originalBranch) {
        try {
          await exec('git', ['checkout', originalBranch], { cwd: projectRoot });
        } catch (e) {
          console.warn(`Failed to restore branch '${originalBranch}':`, e);
        }
      }
    };

    if (squash) {
      try {
        await exec('git', ['merge', '--squash', '--', branchName], { cwd: projectRoot });
      } catch (e) {
        await exec('git', ['reset', '--hard', 'HEAD'], { cwd: projectRoot }).catch((recoverErr) =>
          console.warn('git reset --hard failed during squash recovery:', recoverErr),
        );
        await restoreBranch();
        throw new Error(`Squash merge failed: ${e}`);
      }
      const msg = message ?? 'Squash merge';
      try {
        await exec('git', ['commit', '-m', msg], { cwd: projectRoot });
      } catch (e) {
        await exec('git', ['reset', '--hard', 'HEAD'], { cwd: projectRoot }).catch((recoverErr) =>
          console.warn('git reset --hard failed during commit recovery:', recoverErr),
        );
        await restoreBranch();
        throw new Error(`Commit failed: ${e}`);
      }
    } else {
      try {
        await exec('git', ['merge', '--', branchName], { cwd: projectRoot });
      } catch (e) {
        await exec('git', ['merge', '--abort'], { cwd: projectRoot }).catch((recoverErr) =>
          console.warn('git merge --abort failed:', recoverErr),
        );
        await restoreBranch();
        throw new Error(`Merge failed: ${e}`);
      }
    }

    invalidateMergeBaseCache();
    invalidateGitQueryCacheForPath(projectRoot);

    if (cleanup) {
      await removeWorktree(projectRoot, branchName, true);
    }

    await restoreBranch();

    return { main_branch: mainBranch, lines_added: linesAdded, lines_removed: linesRemoved };
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

export async function getChangedFilesFromBranch(
  projectRoot: string,
  branchName: string,
): Promise<
  Array<{
    path: string;
    lines_added: number;
    lines_removed: number;
    status: string;
    committed: boolean;
  }>
> {
  return withGitQueryCache(
    `changed-files-branch:${cacheKey(projectRoot)}:${branchName}`,
    async () => {
      const mainBranch = await detectMainBranch(projectRoot);

      let diffStr = '';
      try {
        const { stdout } = await exec(
          'git',
          ['diff', '--raw', '--numstat', `${mainBranch}...${branchName}`],
          { cwd: projectRoot, maxBuffer: MAX_BUFFER },
        );
        diffStr = stdout;
      } catch {
        return [];
      }

      const { statusMap, numstatMap } = parseDiffRawNumstat(diffStr);

      const files: Array<{
        path: string;
        lines_added: number;
        lines_removed: number;
        status: string;
        committed: boolean;
      }> = [];

      for (const [p, [added, removed]] of numstatMap) {
        const status = statusMap.get(p) ?? 'M';
        files.push({
          path: p,
          lines_added: added,
          lines_removed: removed,
          status,
          committed: true,
        });
      }

      // Include files in statusMap but not in numstat (e.g. binary files)
      for (const [p, status] of statusMap) {
        if (numstatMap.has(p)) continue;
        files.push({ path: p, lines_added: 0, lines_removed: 0, status, committed: true });
      }

      files.sort((a, b) => a.path.localeCompare(b.path));
      return files;
    },
  );
}

export async function getFileDiffFromBranch(
  projectRoot: string,
  branchName: string,
  filePath: string,
): Promise<FileDiffResult> {
  const mainBranch = await detectMainBranch(projectRoot);

  let diff = '';
  try {
    const { stdout } = await exec(
      'git',
      ['diff', `${mainBranch}...${branchName}`, '--', filePath],
      { cwd: projectRoot, maxBuffer: MAX_BUFFER },
    );
    diff = stdout;
  } catch {
    /* empty */
  }

  // Find the merge base for content retrieval
  let mergeBase = mainBranch;
  try {
    const { stdout } = await exec('git', ['merge-base', mainBranch, branchName], {
      cwd: projectRoot,
    });
    if (stdout.trim()) mergeBase = stdout.trim();
  } catch {
    /* use mainBranch as fallback */
  }

  let oldContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${mergeBase}:${filePath}`], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    oldContent = stdout;
  } catch {
    /* file didn't exist at merge base */
  }

  let newContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${branchName}:${filePath}`], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    newContent = stdout;
  } catch {
    /* file doesn't exist on branch */
  }

  return { diff, oldContent, newContent };
}

export async function pushTask(projectRoot: string, branchName: string): Promise<void> {
  await exec('git', ['push', '-u', 'origin', '--', branchName], { cwd: projectRoot });
}

export async function rebaseTask(worktreePath: string): Promise<void> {
  const lockKey = await detectRepoLockKey(worktreePath).catch(() => worktreePath);

  return withWorktreeLock(lockKey, async () => {
    const mainBranch = await detectMainBranch(worktreePath);
    try {
      await exec('git', ['rebase', mainBranch], { cwd: worktreePath });
    } catch (e) {
      await exec('git', ['rebase', '--abort'], { cwd: worktreePath }).catch((recoverErr) =>
        console.warn('git rebase --abort failed:', recoverErr),
      );
      throw new Error(`Rebase failed: ${e}`);
    }
    invalidateMergeBaseCache();
    invalidateGitQueryCacheForPath(worktreePath);
  });
}

// --- Project-level diff ---

export interface ProjectDiffResult {
  files: Array<{
    path: string;
    lines_added: number;
    lines_removed: number;
    status: string;
    committed: boolean;
  }>;
  totalAdded: number;
  totalRemoved: number;
}

export async function getProjectDiff(
  worktreePath: string,
  mode: 'all' | 'staged' | 'unstaged' | 'branch',
): Promise<ProjectDiffResult> {
  let files: Array<{
    path: string;
    lines_added: number;
    lines_removed: number;
    status: string;
    committed: boolean;
  }>;

  switch (mode) {
    case 'all':
      files = await getChangedFiles(worktreePath);
      break;

    case 'staged': {
      const { stdout } = await exec('git', ['diff', '--cached', '--numstat'], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      files = parseNumstat(stdout, 'staged');
      break;
    }

    case 'unstaged': {
      const { stdout } = await exec('git', ['diff', '--numstat'], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      files = parseNumstat(stdout, 'unstaged');
      break;
    }

    case 'branch': {
      const headHash = await pinHead(worktreePath);
      const base = await detectMergeBase(worktreePath, headHash).catch(() => headHash);
      const { stdout } = await exec('git', ['diff', '--raw', '--numstat', base, headHash], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      const { statusMap, numstatMap } = parseDiffRawNumstat(stdout);

      files = Array.from(numstatMap, ([filePath, [lines_added, lines_removed]]) => ({
        path: filePath,
        lines_added,
        lines_removed,
        status: statusMap.get(filePath) ?? 'M',
        committed: true,
      }));

      // Include files in statusMap but not in numstat (e.g. binary files, mode-only changes)
      for (const [filePath, status] of statusMap) {
        if (numstatMap.has(filePath)) continue;
        files.push({
          path: filePath,
          lines_added: 0,
          lines_removed: 0,
          status,
          committed: true,
        });
      }
      break;
    }
  }

  const totalAdded = files.reduce((sum, f) => sum + f.lines_added, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.lines_removed, 0);

  return { files, totalAdded, totalRemoved };
}
