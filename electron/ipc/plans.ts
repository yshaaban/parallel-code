import fs from 'fs';
import path from 'path';

import type { PlanContentUpdate } from '../../src/domain/renderer-events.js';

interface PlanWatcher {
  currentRelativePath: string | null;
  fsWatchers: fs.FSWatcher[];
  knownFiles: Set<string>;
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

interface TimestampedPlanContent extends ResolvedPlanContent {
  mtime: number;
}

const CHANGE_DEBOUNCE_MS = 200;
const DIR_POLL_INTERVAL_MS = 3_000;
const PLAN_DIRS = ['.claude/plans', 'docs/plans'] as const;
const watchers = new Map<string, PlanWatcher>();

/**
 * Reads and merges `.claude/settings.local.json` in the worktree to set
 * `plansDirectory: "./.claude/plans"`. Creates the plans dir if needed.
 * No-op if already set.
 */
export function ensurePlansDirectory(worktreePath: string): void {
  const settingsPath = path.join(worktreePath, '.claude', 'settings.local.json');
  const plansDir = path.join(worktreePath, '.claude', 'plans');

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

function getWorktreePathFromPlansDir(plansDir: string): string {
  return path.resolve(plansDir, '..', '..');
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

function readNewestPlan(plansDir: string, knownFiles?: Set<string>): TimestampedPlanContent | null {
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

  try {
    const content = fs.readFileSync(path.join(plansDir, newestFile.fileName), 'utf-8');
    return {
      content,
      fileName: newestFile.fileName,
      mtime: newestFile.mtime,
      relativePath: path.relative(
        getWorktreePathFromPlansDir(plansDir),
        path.join(plansDir, newestFile.fileName),
      ),
    };
  } catch {
    return null;
  }
}

function readNewestPlanFromDirs(
  plansDirs: string[],
  knownFiles?: Set<string>,
): ResolvedPlanContent | null {
  let newestPlan: TimestampedPlanContent | null = null;

  for (const plansDir of plansDirs) {
    const plan = readNewestPlan(plansDir, knownFiles);
    if (plan && (!newestPlan || plan.mtime > newestPlan.mtime)) {
      newestPlan = plan;
    }
  }

  return newestPlan
    ? {
        content: newestPlan.content,
        fileName: newestPlan.fileName,
        relativePath: newestPlan.relativePath,
      }
    : null;
}

function readSpecificPlanFile(
  worktreePath: string,
  relativePath: string,
): ResolvedPlanContent | null {
  if (!isPlanRelativePath(relativePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(path.join(worktreePath, relativePath), 'utf-8');
    return {
      content,
      fileName: path.basename(relativePath),
      relativePath,
    };
  } catch {
    return null;
  }
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

function schedulePlanContentUpdate(
  taskId: string,
  onPlanContent?: (message: PlanContentMessage) => void,
): void {
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

    const nextPlan = readNewestPlanFromDirs(currentEntry.plansDirs, currentEntry.knownFiles);
    if (nextPlan) {
      currentEntry.currentRelativePath = nextPlan.relativePath;
      onPlanContent?.(createPlanContentMessage(taskId, nextPlan));
      return;
    }

    if (!currentEntry.currentRelativePath) {
      return;
    }

    const currentPlan = readSpecificPlanFile(
      currentEntry.worktreePath,
      currentEntry.currentRelativePath,
    );
    if (currentPlan) {
      return;
    }

    currentEntry.currentRelativePath = null;
    onPlanContent?.(createPlanContentMessage(taskId, null));
  }, CHANGE_DEBOUNCE_MS);
}

function startPlanDirPolling(
  taskId: string,
  onPlanContent?: (message: PlanContentMessage) => void,
): ReturnType<typeof setInterval> | null {
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
        schedulePlanContentUpdate(taskId, onPlanContent);
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
      schedulePlanContentUpdate(taskId, onPlanContent);
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
  onPlanContent?: (message: PlanContentMessage) => void,
): void {
  stopPlanWatcher(taskId);

  const plansDirs = getPlanDirs(worktreePath);
  const primaryPlansDir = plansDirs[0];
  if (primaryPlansDir) {
    fs.mkdirSync(primaryPlansDir, { recursive: true });
  }

  const entry: PlanWatcher = {
    currentRelativePath: null,
    fsWatchers: [],
    knownFiles: snapshotExistingPlanFiles(plansDirs),
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
      schedulePlanContentUpdate(taskId, onPlanContent);
    });
    if (!watcher) {
      continue;
    }

    entry.watchedDirs.add(plansDir);
    entry.fsWatchers.push(watcher);
  }

  entry.pollTimer = startPlanDirPolling(taskId, onPlanContent);
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

export function readPlanForWorktree(
  worktreePath: string,
  relativePath?: string,
): { content: string; fileName: string; relativePath: string } | null {
  const plansDirs = getPlanDirs(worktreePath);
  if (relativePath) {
    return readSpecificPlanFile(worktreePath, relativePath);
  }
  return readNewestPlanFromDirs(plansDirs);
}

/** Stops all plan watchers. */
export function stopAllPlanWatchers(): void {
  for (const taskId of watchers.keys()) {
    stopPlanWatcher(taskId);
  }
}
