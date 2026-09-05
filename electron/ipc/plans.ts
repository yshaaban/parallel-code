import fs from 'fs';
import path from 'path';

import type { PlanContentUpdate } from '../../src/domain/renderer-events.js';
import { execGitSync } from './git-sync-exec.js';
import type { PendingTaskContentRootAdmission } from './terminal-root-authority.js';
import { readBoundedTaskTextFileSync } from './task-file-access.js';

interface PlanWatcher {
  beginContentAdmission: BeginPlanContentAdmission;
  currentRelativePath: string | null;
  fsWatchers: fs.FSWatcher[];
  knownFiles: Set<string>;
  onPlanContent: ((message: PlanContentMessage) => void) | undefined;
  plansDirs: string[];
  pollTimer: ReturnType<typeof setInterval> | null;
  timeout: ReturnType<typeof setTimeout> | null;
  watchedDirs: Set<string>;
  worktreePath: string;
}

export type PlanContentMessage = PlanContentUpdate;

interface ResolvedPlanContent {
  content: string;
  fileName: string;
  relativePath: string;
}

export type BeginPlanContentAdmission = () => PendingTaskContentRootAdmission | null;

const CHANGE_DEBOUNCE_MS = 200;
const DIR_POLL_INTERVAL_MS = 3_000;
const PLAN_DIRS = ['.claude/plans', 'docs/plans'] as const;
export const PLAN_FILE_MAX_BYTES = 2 * 1024 * 1024;
const watchers = new Map<string, PlanWatcher>();

const PLAN_SETTINGS_EXCLUDE_ENTRY = '.claude/settings.local.json';

/**
 * Marks the app-managed `.claude/settings.local.json` as ignored in the
 * repo-local git exclude file. The backend writes this file into every task
 * worktree, and Claude Code's own convention keeps `settings.local.json`
 * local-only (the claude CLI gitignores it on creation too). Without the
 * exclude, the app's own bookkeeping write shows up in `git status` and the
 * review unstaged list as a phantom user change. Tracked copies are
 * unaffected: git excludes only apply to untracked files. Best-effort: no-op
 * for non-git worktrees or unwritable `.git` dirs.
 */
function ensurePlanSettingsGitExclude(worktreePath: string): void {
  try {
    const gitExcludeOutput = execGitSync(
      ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
      {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (typeof gitExcludeOutput !== 'string') {
      return;
    }
    const gitExcludePath = gitExcludeOutput.trim();
    if (!gitExcludePath) {
      return;
    }
    let existing = '';
    try {
      existing = fs.readFileSync(gitExcludePath, 'utf-8');
    } catch {
      // Exclude file does not exist yet.
    }
    if (existing.split('\n').includes(PLAN_SETTINGS_EXCLUDE_ENTRY)) {
      return;
    }

    fs.mkdirSync(path.dirname(gitExcludePath), { recursive: true });
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitExcludePath, `${separator}${PLAN_SETTINGS_EXCLUDE_ENTRY}\n`);
  } catch {
    // Non-git worktree or read-only .git; the settings write still works.
  }
}

/**
 * Reads and merges `.claude/settings.local.json` in the worktree to set
 * `plansDirectory: "./.claude/plans"`. Creates the plans dir if needed.
 * No-op if already set.
 */
export function ensurePlansDirectory(worktreePath: string): void {
  const settingsPath = path.join(worktreePath, '.claude', 'settings.local.json');
  const plansDir = path.join(worktreePath, '.claude', 'plans');
  ensurePlanSettingsGitExclude(worktreePath);

  let settings: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File doesn't exist or is invalid; start fresh.
  }

  if (settings.plansDirectory === './.claude/plans') {
    fs.mkdirSync(plansDir, { recursive: true });
    return;
  }

  settings.plansDirectory = './.claude/plans';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  fs.mkdirSync(plansDir, { recursive: true });
}

function getPlanDirs(worktreePath: string): string[] {
  return PLAN_DIRS.map((plansDir) => path.join(worktreePath, plansDir));
}

export function isPlanRelativePath(relativePath: string): boolean {
  const normalizedPath = path.normalize(relativePath);
  return PLAN_DIRS.some((plansDir) => {
    const normalizedPlanDir = path.normalize(plansDir);
    return (
      normalizedPath === normalizedPlanDir ||
      normalizedPath.startsWith(`${normalizedPlanDir}${path.sep}`)
    );
  });
}

function getKnownPlanKey(plansDir: string, fileName: string): string {
  return `${plansDir}:${fileName}`;
}

function snapshotExistingPlanFiles(plansDirs: string[]): Set<string> {
  const knownFiles = new Set<string>();

  for (const plansDir of plansDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(plansDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        knownFiles.add(getKnownPlanKey(plansDir, entry.name));
      }
    }
  }

  return knownFiles;
}

function findNewestPlan(
  worktreePath: string,
  plansDir: string,
  knownFiles?: Set<string>,
): { mtime: number; relativePath: string } | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(plansDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const markdownFiles = entries.filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith('.md') &&
      !knownFiles?.has(getKnownPlanKey(plansDir, entry.name)),
  );
  if (markdownFiles.length === 0) {
    return null;
  }

  let newestFile: { fileName: string; mtime: number } | null = null;
  for (const entry of markdownFiles) {
    try {
      const filePath = path.join(plansDir, entry.name);
      const stats = fs.statSync(filePath);
      if (!newestFile || stats.mtimeMs > newestFile.mtime) {
        newestFile = { fileName: entry.name, mtime: stats.mtimeMs };
      }
    } catch {
      // The file may have disappeared between readdir and stat.
    }
  }

  if (!newestFile) {
    return null;
  }

  return {
    mtime: newestFile.mtime,
    relativePath: path.relative(worktreePath, path.join(plansDir, newestFile.fileName)),
  };
}

function readNewestPlanFromDirs(
  admission: PendingTaskContentRootAdmission,
  knownFiles?: Set<string>,
): ResolvedPlanContent | null {
  const plansDirs = getPlanDirs(admission.root);
  let newestPlan: { mtime: number; relativePath: string } | null = null;

  for (const plansDir of plansDirs) {
    const plan = findNewestPlan(admission.root, plansDir, knownFiles);
    if (plan && (!newestPlan || plan.mtime > newestPlan.mtime)) {
      newestPlan = plan;
    }
  }

  return newestPlan ? readSpecificPlanFile(admission, newestPlan.relativePath) : null;
}

function readSpecificPlanFile(
  admission: PendingTaskContentRootAdmission,
  relativePath: string,
): ResolvedPlanContent | null {
  if (!isPlanRelativePath(relativePath) || path.extname(relativePath).toLowerCase() !== '.md') {
    return null;
  }

  const result = readBoundedTaskTextFileSync({
    admission,
    allowedRoots: getPlanDirs(admission.root),
    maxBytes: PLAN_FILE_MAX_BYTES,
    relativePath,
    acceptCanonicalPath: (canonicalPath) => path.extname(canonicalPath).toLowerCase() === '.md',
  });
  if (!result) {
    return null;
  }

  return {
    content: result.content,
    fileName: path.basename(result.canonicalPath),
    relativePath: result.relativePath,
  };
}

function createPlanContentMessage(
  taskId: string,
  result: ResolvedPlanContent | null,
): PlanContentMessage {
  if (result) {
    return {
      taskId,
      content: result.content,
      fileName: result.fileName,
      relativePath: result.relativePath,
    };
  }

  return {
    taskId,
    content: null,
    fileName: null,
    relativePath: null,
  };
}

function watchPlanDir(plansDir: string, onChange: () => void): fs.FSWatcher | null {
  try {
    const watcher = fs.watch(plansDir, onChange);
    watcher.on('error', () => {
      onChange();
    });
    return watcher;
  } catch {
    return null;
  }
}

function schedulePlanContentUpdate(taskId: string): void {
  const entry = watchers.get(taskId);
  if (!entry) {
    return;
  }

  if (entry.timeout) {
    clearTimeout(entry.timeout);
  }

  entry.timeout = setTimeout(() => {
    const currentEntry = watchers.get(taskId);
    if (!currentEntry) {
      return;
    }
    currentEntry.timeout = null;

    const admission = currentEntry.beginContentAdmission();
    if (!admission || path.resolve(admission.root) !== path.resolve(currentEntry.worktreePath)) {
      currentEntry.currentRelativePath = null;
      currentEntry.onPlanContent?.(createPlanContentMessage(taskId, null));
      return;
    }

    const nextPlan = readNewestPlanFromDirs(admission, currentEntry.knownFiles);
    if (nextPlan) {
      currentEntry.currentRelativePath = nextPlan.relativePath;
      currentEntry.onPlanContent?.(createPlanContentMessage(taskId, nextPlan));
      return;
    }

    if (!currentEntry.currentRelativePath) {
      return;
    }

    const currentAdmission = currentEntry.beginContentAdmission();
    const currentPlan = currentAdmission
      ? readSpecificPlanFile(currentAdmission, currentEntry.currentRelativePath)
      : null;
    if (currentPlan) {
      return;
    }

    currentEntry.currentRelativePath = null;
    currentEntry.onPlanContent?.(createPlanContentMessage(taskId, null));
  }, CHANGE_DEBOUNCE_MS);
}

function startPlanDirPolling(taskId: string): ReturnType<typeof setInterval> | null {
  const entry = watchers.get(taskId);
  if (!entry || entry.watchedDirs.size === entry.plansDirs.length) {
    return null;
  }

  return setInterval(() => {
    const currentEntry = watchers.get(taskId);
    if (!currentEntry) {
      return;
    }

    let addedWatcher = false;
    for (const plansDir of currentEntry.plansDirs) {
      if (currentEntry.watchedDirs.has(plansDir) || !fs.existsSync(plansDir)) {
        continue;
      }

      const watcher = watchPlanDir(plansDir, () => {
        schedulePlanContentUpdate(taskId);
      });
      if (!watcher) {
        continue;
      }

      currentEntry.watchedDirs.add(plansDir);
      currentEntry.fsWatchers.push(watcher);
      for (const knownFile of snapshotExistingPlanFiles([plansDir])) {
        currentEntry.knownFiles.add(knownFile);
      }
      addedWatcher = true;
    }

    if (addedWatcher) {
      schedulePlanContentUpdate(taskId);
    }

    if (currentEntry.pollTimer && currentEntry.watchedDirs.size === currentEntry.plansDirs.length) {
      clearInterval(currentEntry.pollTimer);
      currentEntry.pollTimer = null;
    }
  }, DIR_POLL_INTERVAL_MS);
}

/**
 * Watches `.claude/plans` and `docs/plans` for plan files created after the
 * watcher starts. Existing plans are intentionally ignored so old files do not
 * reappear as if they were freshly generated.
 */
export function startPlanWatcher(
  taskId: string,
  worktreePath: string,
  beginContentAdmission: BeginPlanContentAdmission,
  onPlanContent?: (message: PlanContentMessage) => void,
): void {
  const existingEntry = watchers.get(taskId);
  if (existingEntry?.worktreePath === worktreePath) {
    existingEntry.beginContentAdmission = beginContentAdmission;
    existingEntry.onPlanContent = onPlanContent;
    return;
  }

  stopPlanWatcher(taskId);

  const plansDirs = getPlanDirs(worktreePath);
  const primaryPlansDir = plansDirs[0];
  if (primaryPlansDir) {
    fs.mkdirSync(primaryPlansDir, { recursive: true });
  }

  const entry: PlanWatcher = {
    beginContentAdmission,
    currentRelativePath: null,
    fsWatchers: [],
    knownFiles: snapshotExistingPlanFiles(plansDirs),
    onPlanContent,
    plansDirs,
    pollTimer: null,
    timeout: null,
    watchedDirs: new Set<string>(),
    worktreePath,
  };

  watchers.set(taskId, entry);

  for (const plansDir of plansDirs) {
    if (!fs.existsSync(plansDir)) {
      continue;
    }

    const watcher = watchPlanDir(plansDir, () => {
      schedulePlanContentUpdate(taskId);
    });
    if (!watcher) {
      continue;
    }

    entry.watchedDirs.add(plansDir);
    entry.fsWatchers.push(watcher);
  }

  entry.pollTimer = startPlanDirPolling(taskId);
}

/** Stops and removes the plan watcher for a given task. */
export function stopPlanWatcher(taskId: string): void {
  const entry = watchers.get(taskId);
  if (!entry) {
    return;
  }

  if (entry.timeout) {
    clearTimeout(entry.timeout);
  }
  if (entry.pollTimer) {
    clearInterval(entry.pollTimer);
  }
  for (const watcher of entry.fsWatchers) {
    watcher.close();
  }
  watchers.delete(taskId);
}

export function readPlan(
  beginContentAdmission: BeginPlanContentAdmission,
  relativePath?: string,
): { content: string; fileName: string; relativePath: string } | null {
  const admission = beginContentAdmission();
  if (!admission || admission.kind !== 'canonical-task') {
    return null;
  }
  if (relativePath) {
    return readSpecificPlanFile(admission, relativePath);
  }
  return readNewestPlanFromDirs(admission);
}

/** Stops all plan watchers. */
export function stopAllPlanWatchers(): void {
  for (const taskId of watchers.keys()) {
    stopPlanWatcher(taskId);
  }
}
