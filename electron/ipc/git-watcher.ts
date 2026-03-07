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
  watchers: fs.FSWatcher[];
  timeout: ReturnType<typeof setTimeout> | null;
  /** Prevents overlapping refreshes */
  refreshing: boolean;
}

const activeWatchers = new Map<string, GitWatcher>();

const DEBOUNCE_MS = 300;

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
 *   - .git/index          - staging area changes (git add/reset)
 *   - .git/HEAD           - branch switches, commits
 *   - .git/refs/heads/    - local commits, branch creation
 *   - .git dir itself     - MERGE_HEAD, REBASE_HEAD, COMMIT_EDITMSG
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

  const entry: GitWatcher = { watchers, timeout: null, refreshing: false };
  activeWatchers.set(taskId, entry);

  async function refresh(): Promise<void> {
    if (entry.refreshing) return;
    entry.refreshing = true;
    try {
      const [status, changedFiles] = await Promise.all([
        getWorktreeStatus(worktreePath).catch(() => ({
          has_committed_changes: false,
          has_uncommitted_changes: false,
        })),
        getChangedFiles(worktreePath).catch(() => []),
      ]);
      onGitChange({ taskId, worktreePath, status, changedFiles });
    } finally {
      entry.refreshing = false;
    }
  }

  function onFsChange(): void {
    if (!activeWatchers.has(taskId)) return;
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.timeout = setTimeout(() => {
      entry.timeout = null;
      void refresh();
    }, DEBOUNCE_MS);
  }

  // Watch directories (refs/heads)
  const dirsToWatch = [path.join(gitDir, 'refs', 'heads'), path.join(commonDir, 'refs', 'heads')];

  const uniqueDirs = [...new Set(dirsToWatch)];

  for (const dirPath of uniqueDirs) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      const w = fs.watch(dirPath, { recursive: false }, onFsChange);
      w.on('error', () => {
        /* directory may be recreated */
      });
      watchers.push(w);
    } catch {
      // Directory does not exist
    }
  }

  // Watch the git dir itself for MERGE_HEAD/REBASE_HEAD creation/deletion
  try {
    const w = fs.watch(gitDir, (_eventType, filename) => {
      if (
        filename === 'MERGE_HEAD' ||
        filename === 'REBASE_HEAD' ||
        filename === 'COMMIT_EDITMSG' ||
        filename === 'index' ||
        filename === 'HEAD'
      ) {
        onFsChange();
      }
    });
    w.on('error', () => {});
    watchers.push(w);
  } catch {
    // gitDir does not exist
  }
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
