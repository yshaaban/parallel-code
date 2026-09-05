import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, type JSHandle, type Locator, type Page } from '@playwright/test';

import { createPromptReadyScenario, type BrowserLabScenario } from './scenarios.js';

const TASK_BRANCH_NAME = 'browser-lab/merge-progress';
const TASK_WORKTREE_DIRECTORY = 'task-browser-lab';
const MERGE_FIXTURE_CONTENT =
  'merge progress line one\nmerge progress line two\nmerge progress line three\n';

export interface BrowserMergeProgressSnapshot {
  linesAdded: number;
  linesRemoved: number;
  tasksToday: number;
}

interface BrowserMergeProgressRenderTracker {
  finish(): { batches: number; snapshots: string[] };
}

export interface TaskMergeBrowserScenarioOptions {
  emptyCommit?: boolean;
  name?: string;
  taskName?: string;
}

function runGit(repoDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function getTaskMergeWorktreePath(repoDir: string): string {
  return path.join(repoDir, '.worktrees', TASK_WORKTREE_DIRECTORY);
}

export function createTaskMergeBrowserScenario(
  options: TaskMergeBrowserScenarioOptions = {},
): BrowserLabScenario {
  const base = createPromptReadyScenario(20);
  return {
    ...base,
    name: options.name ?? 'task-merge-progress',
    resolveTaskGitLocation: (repoDir, taskIndex) => {
      if (taskIndex !== 0) {
        throw new Error('The task merge browser scenario owns exactly one seeded worktree');
      }
      return {
        branchName: TASK_BRANCH_NAME,
        worktreePath: getTaskMergeWorktreePath(repoDir),
      };
    },
    seedRepo: async (repoDir) => {
      const worktreePath = getTaskMergeWorktreePath(repoDir);
      await appendFile(path.join(repoDir, '.git', 'info', 'exclude'), '\n/.worktrees/\n', 'utf8');
      await mkdir(path.dirname(worktreePath), { recursive: true });
      runGit(repoDir, ['worktree', 'add', '-b', TASK_BRANCH_NAME, worktreePath, 'main']);
      if (options.emptyCommit) {
        runGit(worktreePath, ['commit', '--allow-empty', '-m', 'empty merge progress fixture']);
      } else {
        await writeFile(
          path.join(worktreePath, 'merge-progress.txt'),
          MERGE_FIXTURE_CONTENT,
          'utf8',
        );
        runGit(worktreePath, ['add', 'merge-progress.txt']);
        runGit(worktreePath, ['commit', '-m', 'add merge progress fixture']);
      }
    },
    taskGitIsolation: 'worktree',
    taskName: options.taskName ?? 'Merge Progress Fixture',
  };
}

export function getMergeProgressStatus(page: Page): Locator {
  return page.getByRole('status', { name: 'Merge progress' });
}

export async function openMergeProgress(page: Page): Promise<void> {
  const status = getMergeProgressStatus(page);
  if (!(await status.isVisible().catch(() => false))) {
    await page.getByRole('button', { exact: true, name: 'Progress' }).click();
  }
  await expect(status).toBeVisible();
}

export async function readBrowserMergeProgress(page: Page): Promise<BrowserMergeProgressSnapshot> {
  const text = await getMergeProgressStatus(page).innerText();
  const tasks = /Merged tasks today\s+([\d,]+)/u.exec(text);
  const lines = /Merged \(total\)\s+\+([\d,]+)\s+-([\d,]+)/u.exec(text);
  if (!tasks || !lines) {
    throw new Error(`Merge progress UI is unreadable: ${JSON.stringify(text)}`);
  }
  const parseCount = (value: string): number => Number.parseInt(value.replaceAll(',', ''), 10);
  return {
    linesAdded: parseCount(lines[1] as string),
    linesRemoved: parseCount(lines[2] as string),
    tasksToday: parseCount(tasks[1] as string),
  };
}

export async function prepareTaskMerge(page: Page, cleanup: boolean): Promise<Locator> {
  await page.getByTitle('Merge into main').click();
  const dialog = page.getByRole('dialog', { name: 'Merge into main' });
  await expect(dialog).toBeVisible();
  const cleanupCheckbox = dialog.getByLabel('Delete branch and worktree after merge');
  if (cleanup) {
    await cleanupCheckbox.check();
  } else {
    await cleanupCheckbox.uncheck();
  }
  const confirm = dialog.getByRole('button', {
    exact: true,
    name: cleanup ? 'Merge & delete branch' : 'Merge',
  });
  await expect(confirm).toBeEnabled({ timeout: 15_000 });
  return confirm;
}

export async function startMergeProgressRenderTracker(
  page: Page,
): Promise<JSHandle<BrowserMergeProgressRenderTracker>> {
  await expect(getMergeProgressStatus(page)).toBeVisible();
  return page.evaluateHandle(() => {
    const root = document.querySelector<HTMLElement>(
      '[role="status"][aria-label="Merge progress"]',
    );
    if (!root) {
      throw new Error('Merge progress status is unavailable');
    }
    let batches = 0;
    let previous = root.innerText;
    const snapshots: string[] = [];
    const observer = new MutationObserver(() => {
      const current = root.innerText;
      if (current === previous) return;
      previous = current;
      batches += 1;
      snapshots.push(current);
    });
    observer.observe(root, { characterData: true, childList: true, subtree: true });
    return {
      finish() {
        observer.disconnect();
        return { batches, snapshots: [...snapshots] };
      },
    };
  });
}

export async function finishMergeProgressRenderTracker(
  page: Page,
  tracker: JSHandle<BrowserMergeProgressRenderTracker>,
): Promise<{ batches: number; snapshots: string[] }> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  const result = await tracker.evaluate((value) => value.finish());
  await tracker.dispose();
  return result;
}
