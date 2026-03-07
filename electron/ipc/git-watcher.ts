import fs from 'fs';
import path from 'path';
import { getWorktreeStatus, getChangedFiles } from './git.js';

export interface GitWatcherEvent {
  taskId: string;
  worktreePath: string;
  status: { has_committed_changes: boolean; has_uncommitted_changes: boolean };
  changedFiles: Array<{
    path: string;
    lines_added: number;
    lines_removed: number;
    status: string;
    committed: boolean;
  }>;
}

interface GitWatcher {
  worktreePath: string;
  watchers: fs.FSWatcher[];
  timeout: ReturnType<typeof setTimeout> | null;
  /** Prevents overlapping refreshes */
  refreshing: boolean;
  /** Ensures fs events during a refresh trigger one more refresh afterward */
  pendingRefresh: boolean;
  lastStatus: { has_committed_changes: boolean; has_uncommitted_changes: boolean } | null;
  lastChangedFiles: GitWatcherEvent['changedFiles'] | null;
}

const activeWatchers = new Map<string, GitWatcher>();

const DEBOUNCE_MS = 300;
const ARENA_GIT_WATCHER_PREFIX = 'arena:';

export function getArenaGitWatcherId(projectRoot: string, branchName: string): string {
  return `${ARENA_GIT_WATCHER_PREFIX}${projectRoot}\u0000${branchName}`;
}

function isArenaGitWatcherId(watcherId: string): boolean {
  return watcherId.startsWith(ARENA_GIT_WATCHER_PREFIX);
}

/**
 * Resolve the .git directory for a worktree. Git worktrees use a .git *file*
 * that contains `gitdir: <path>` pointing to the real git directory.
 */
function resolveGitDir(worktreePath: string): string {
  const dotGit = path.join(worktreePath, '.git');
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
  } catch {
    // .git does not exist - fallback below
  }

  // Worktree: .git is a file containing "gitdir: <path>"
  try {
    const content = fs.readFileSync(dotGit, 'utf-8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (match) {
      const gitdir = match[1];
      return path.isAbsolute(gitdir) ? gitdir : path.resolve(worktreePath, gitdir);
    }
  } catch {
    // Not a worktree
  }

  return dotGit;
}

/**
 * Get the common git directory (shared across all worktrees).
 * Used to watch shared refs.
 */
function resolveCommonDir(gitDir: string): string {
  const commonDirFile = path.join(gitDir, 'commondir');
  try {
    const rel = fs.readFileSync(commonDirFile, 'utf-8').trim();
    return path.resolve(gitDir, rel);
  } catch {
    return gitDir;
  }
}

/**
 * Start watching git internals for a task worktree.
 *
 * Watches:
 *   - .git/refs/heads/    - local commits, branch creation
 *   - git root dirs       - HEAD/index, merge/rebase state, packed refs
 *   - common .git/refs/heads/ - shared refs across worktrees
 *
 * On change (debounced 300ms), runs getWorktreeStatus + getChangedFiles
 * and notifies via callback.
 */
export function startGitWatcher(
  taskId: string,
  worktreePath: string,
  onGitChange: (event: GitWatcherEvent) => void,
): void {
  stopGitWatcher(taskId);

  const gitDir = resolveGitDir(worktreePath);
  const commonDir = resolveCommonDir(gitDir);
  const watchers: fs.FSWatcher[] = [];

  const entry: GitWatcher = {
    worktreePath,
    watchers,
    timeout: null,
    refreshing: false,
    pendingRefresh: false,
    lastStatus: null,
    lastChangedFiles: null,
  };
  activeWatchers.set(taskId, entry);

  function isActiveEntry(): boolean {
    return activeWatchers.get(taskId) === entry;
  }

  async function refresh(): Promise<void> {
    if (!isActiveEntry()) return;
    if (entry.refreshing) {
      entry.pendingRefresh = true;
      return;
    }
    entry.refreshing = true;
    try {
      do {
        entry.pendingRefresh = false;
        const [statusResult, changedFilesResult] = await Promise.allSettled([
          getWorktreeStatus(worktreePath),
          getChangedFiles(worktreePath),
        ]);

        if (!isActiveEntry()) return;

        const status =
          statusResult.status === 'fulfilled' ? statusResult.value : (entry.lastStatus ?? null);
        const changedFiles =
          changedFilesResult.status === 'fulfilled'
            ? changedFilesResult.value
            : (entry.lastChangedFiles ?? null);

        if (!status || !changedFiles) {
          if (statusResult.status === 'rejected' && changedFilesResult.status === 'rejected') {
            console.warn(`git watcher refresh failed for ${taskId}:`, {
              statusError: statusResult.reason,
              changedFilesError: changedFilesResult.reason,
            });
          }
          continue;
        }

        entry.lastStatus = status;
        entry.lastChangedFiles = changedFiles;
        try {
          onGitChange({ taskId, worktreePath, status, changedFiles });
        } catch (error) {
          console.warn(`git watcher callback failed for ${taskId}:`, error);
        }
      } while (entry.pendingRefresh && isActiveEntry());
    } finally {
      entry.refreshing = false;
    }
  }

  function onFsChange(): void {
    if (!isActiveEntry()) return;
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.timeout = setTimeout(() => {
      entry.timeout = null;
      if (!isActiveEntry()) return;
      void refresh();
    }, DEBOUNCE_MS);
  }

  // Watch directories (refs/heads)
  const dirsToWatch = [path.join(gitDir, 'refs', 'heads'), path.join(commonDir, 'refs', 'heads')];

  const uniqueDirs = [...new Set(dirsToWatch)];

  for (const dirPath of uniqueDirs) {
    try {
      if (!fs.existsSync(dirPath)) continue;
      const w = fs.watch(dirPath, { recursive: false }, onFsChange);
      w.on('error', () => {
        /* directory may be recreated */
      });
      watchers.push(w);
    } catch {
      // Directory does not exist
    }
  }

  // Watch git roots for HEAD/index, merge state, and packed ref updates.
  for (const rootPath of [...new Set([gitDir, commonDir])]) {
    try {
      const w = fs.watch(rootPath, (_eventType, filename) => {
        const name = typeof filename === 'string' ? filename : undefined;
        if (
          name === undefined ||
          name === 'MERGE_HEAD' ||
          name === 'REBASE_HEAD' ||
          name === 'COMMIT_EDITMSG' ||
          name === 'index' ||
          name === 'HEAD' ||
          name === 'packed-refs' ||
          name === 'refs'
        ) {
          onFsChange();
        }
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      // git root does not exist
    }
  }

  // Push an initial snapshot on start/restart.
  void refresh();
}

/** Stop the git watcher for a given task. */
export function stopGitWatcher(taskId: string): void {
  const entry = activeWatchers.get(taskId);
  if (!entry) return;
  if (entry.timeout) clearTimeout(entry.timeout);
  for (const w of entry.watchers) {
    try {
      w.close();
    } catch {
      /* already closed */
    }
  }
  activeWatchers.delete(taskId);
}

/** Stop all git watchers. */
export function stopAllGitWatchers(): void {
  for (const taskId of [...activeWatchers.keys()]) {
    stopGitWatcher(taskId);
  }
}

/** Get list of currently watched task IDs. */
export function getWatchedTaskIds(): string[] {
  return [...activeWatchers.keys()];
}

export function syncTaskGitWatchers(
  tasks: Array<{ taskId: string; worktreePath: string }>,
  onGitChange: (event: GitWatcherEvent) => void,
): void {
  const desired = new Map<string, string>();
  for (const task of tasks) {
    if (!task.taskId || !task.worktreePath) continue;
    desired.set(task.taskId, task.worktreePath);
  }

  for (const [watcherId, entry] of activeWatchers) {
    if (isArenaGitWatcherId(watcherId)) continue;
    const nextPath = desired.get(watcherId);
    if (!nextPath) {
      stopGitWatcher(watcherId);
      continue;
    }
    if (nextPath === entry.worktreePath) {
      desired.delete(watcherId);
      continue;
    }
    stopGitWatcher(watcherId);
  }

  for (const [taskId, worktreePath] of desired) {
    startGitWatcher(taskId, worktreePath, onGitChange);
  }
}
