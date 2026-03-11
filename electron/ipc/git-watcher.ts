import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const DEBOUNCE_MS = 500;

interface GitWatcher {
  watchers: fs.FSWatcher[];
  timeout: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<string, GitWatcher>();

async function resolveGitDir(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-dir'], {
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
export async function startGitWatcher(
  taskId: string,
  worktreePath: string,
  onChanged: () => void,
): Promise<void> {
  stopGitWatcher(taskId);

  let gitDir: string;
  try {
    gitDir = await resolveGitDir(worktreePath);
  } catch {
    return; // not a git repo or git not available — degrade silently
  }

  const entry: GitWatcher = { watchers: [], timeout: null };

  const trigger = () => {
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.timeout = setTimeout(() => {
      entry.timeout = null;
      onChanged();
    }, DEBOUNCE_MS);
  };

  for (const target of [`${gitDir}/index`, `${gitDir}/HEAD`]) {
    try {
      const w = fs.watch(target, trigger);
      w.on('error', () => stopGitWatcher(taskId));
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
  for (const taskId of [...watchers.keys()]) {
    stopGitWatcher(taskId);
  }
}
