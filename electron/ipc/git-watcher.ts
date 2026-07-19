import fs from 'fs';

import { execGit } from './git-exec.js';

const DEBOUNCE_MS = 500;

interface GitWatcher {
  onChanged: () => void;
  watchers: fs.FSWatcher[];
  worktreePath: string;
  timeout: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<string, GitWatcher>();

interface PendingGitWatcherStart {
  onChanged: () => void;
  promise: Promise<void>;
  worktreePath: string;
}

const pendingWatcherStarts = new Map<string, PendingGitWatcherStart>();

async function resolveGitDir(worktreePath: string): Promise<string> {
  const { stdout } = await execGit(['rev-parse', '--git-dir'], {
    cwd: worktreePath,
    timeout: 5_000,
  });
  const gitDir = stdout.trim();
  return gitDir.startsWith('/') ? gitDir : `${worktreePath}/${gitDir}`;
}

/**
 * Watches the git internals for a task's worktree.
 * Monitors `<gitdir>/index` (staged/unstaged) and `<gitdir>/HEAD` (commits/checkouts).
 * Fires `onChanged` with 500ms debounce when either file changes.
 */
export function startGitWatcher(
  taskId: string,
  worktreePath: string,
  onChanged: () => void,
): Promise<void> {
  const existing = watchers.get(taskId);
  if (existing?.worktreePath === worktreePath) {
    existing.onChanged = onChanged;
    return Promise.resolve();
  }

  const pending = pendingWatcherStarts.get(taskId);
  if (pending?.worktreePath === worktreePath) {
    pending.onChanged = onChanged;
    return pending.promise;
  }

  stopGitWatcher(taskId);
  const nextStart: PendingGitWatcherStart = {
    onChanged,
    promise: Promise.resolve(),
    worktreePath,
  };
  nextStart.promise = resolveAndStartGitWatcher(taskId, nextStart);
  pendingWatcherStarts.set(taskId, nextStart);
  return nextStart.promise;
}

async function resolveAndStartGitWatcher(
  taskId: string,
  pending: PendingGitWatcherStart,
): Promise<void> {
  let gitDir: string;
  try {
    gitDir = await resolveGitDir(pending.worktreePath);
  } catch {
    if (pendingWatcherStarts.get(taskId) === pending) {
      pendingWatcherStarts.delete(taskId);
    }
    return; // not a git repo or git not available — degrade silently
  }

  if (pendingWatcherStarts.get(taskId) !== pending) {
    return;
  }
  pendingWatcherStarts.delete(taskId);

  const entry: GitWatcher = {
    onChanged: pending.onChanged,
    watchers: [],
    worktreePath: pending.worktreePath,
    timeout: null,
  };

  const trigger = () => {
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.timeout = setTimeout(() => {
      entry.timeout = null;
      entry.onChanged();
    }, DEBOUNCE_MS);
  };

  for (const target of [`${gitDir}/index`, `${gitDir}/HEAD`]) {
    try {
      const w = fs.watch(target, trigger);
      w.on('error', () => {
        if (watchers.get(taskId) === entry) {
          stopGitWatcher(taskId);
        }
      });
      entry.watchers.push(w);
    } catch {
      // file may not exist yet — ignore
    }
  }

  if (entry.watchers.length > 0) {
    watchers.set(taskId, entry);
  }
}

export function stopGitWatcher(taskId: string): void {
  pendingWatcherStarts.delete(taskId);
  const entry = watchers.get(taskId);
  if (!entry) return;
  if (entry.timeout) clearTimeout(entry.timeout);
  for (const w of entry.watchers) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
  watchers.delete(taskId);
}

export function stopAllGitWatchers(): void {
  const taskIds = new Set([...watchers.keys(), ...pendingWatcherStarts.keys()]);
  for (const taskId of taskIds) {
    stopGitWatcher(taskId);
  }
}
