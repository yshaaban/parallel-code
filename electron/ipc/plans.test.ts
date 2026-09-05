import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskNameRegistry } from '../../server/task-names.js';
import { createTerminalContentRootAuthority } from './terminal-root-authority.js';

import {
  ensurePlansDirectory,
  PLAN_FILE_MAX_BYTES,
  readPlan,
  startPlanWatcher,
  stopPlanWatcher,
} from './plans.js';

function createBeginAdmission(worktreePath: string) {
  const registry = createTaskNameRegistry();
  registry.registerCreatedTask('task-1', { worktreePath });
  const authority = createTerminalContentRootAuthority(registry);
  return () => authority.beginCanonicalTaskAdmission('task-1');
}

function createWorktree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-plans-'));
}

function writePlan(
  worktreePath: string,
  relativeDir: string,
  fileName: string,
  content: string,
): string {
  const directoryPath = path.join(worktreePath, relativeDir);
  fs.mkdirSync(directoryPath, { recursive: true });
  const filePath = path.join(directoryPath, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function waitForWatcherSetup(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('plans', () => {
  const worktrees: string[] = [];

  afterEach(() => {
    stopPlanWatcher('task-1');
    for (const worktreePath of worktrees.splice(0)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('ensures the Claude plans directory exists', () => {
    const worktreePath = createWorktree();
    worktrees.push(worktreePath);

    ensurePlansDirectory(worktreePath);

    expect(fs.existsSync(path.join(worktreePath, '.claude', 'plans'))).toBe(true);
  });

  it('excludes the app-managed settings file from git status in git worktrees', () => {
    const worktreePath = createWorktree();
    worktrees.push(worktreePath);
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: worktreePath });

    ensurePlansDirectory(worktreePath);
    // Idempotent: a second ensure must not duplicate the exclude entry.
    ensurePlansDirectory(worktreePath);

    const excludeContent = fs.readFileSync(
      path.join(worktreePath, '.git', 'info', 'exclude'),
      'utf-8',
    );
    const excludeEntries = excludeContent
      .split('\n')
      .filter((line) => line === '.claude/settings.local.json');
    expect(excludeEntries).toHaveLength(1);

    // The app-managed write must not surface as an untracked user change.
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    });
    expect(status).not.toContain('.claude');
  });

  it('still writes plan settings for non-git worktrees without an exclude', () => {
    const worktreePath = createWorktree();
    worktrees.push(worktreePath);

    ensurePlansDirectory(worktreePath);

    expect(fs.existsSync(path.join(worktreePath, '.claude', 'settings.local.json'))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, '.git'))).toBe(false);
  });

  it('reads the newest plan across both plan directories', () => {
    const worktreePath = createWorktree();
    worktrees.push(worktreePath);

    writePlan(worktreePath, '.claude/plans', 'older.md', '# Older plan');
    const docsPlanPath = writePlan(worktreePath, 'docs/plans', 'newer.md', '# Newer plan');
    const now = Date.now();
    fs.utimesSync(docsPlanPath, now / 1_000, (now + 5_000) / 1_000);

    expect(readPlan(createBeginAdmission(worktreePath))).toEqual({
      content: '# Newer plan',
      fileName: 'newer.md',
      relativePath: 'docs/plans/newer.md',
    });
  });

  it('reads an exact persisted plan file by name across both plan directories', () => {
    const worktreePath = createWorktree();
    worktrees.push(worktreePath);

    writePlan(worktreePath, 'docs/plans', 'restored.md', '# Restored plan');

    expect(readPlan(createBeginAdmission(worktreePath), 'docs/plans/restored.md')).toEqual({
      content: '# Restored plan',
      fileName: 'restored.md',
      relativePath: 'docs/plans/restored.md',
    });
  });

  it('ignores pre-existing plans and emits newly created plans', async () => {
    const worktreePath = createWorktree();
    worktrees.push(worktreePath);

    writePlan(worktreePath, '.claude/plans', 'existing.md', '# Existing plan');
    fs.mkdirSync(path.join(worktreePath, 'docs', 'plans'), { recursive: true });
    const onPlanContent = vi.fn();

    startPlanWatcher('task-1', worktreePath, createBeginAdmission(worktreePath), onPlanContent);
    await waitForWatcherSetup();
    writePlan(worktreePath, 'docs/plans', 'new-plan.md', '# Fresh plan');

    await vi.waitFor(
      () => {
        expect(onPlanContent).toHaveBeenCalledWith({
          content: '# Fresh plan',
          fileName: 'new-plan.md',
          relativePath: 'docs/plans/new-plan.md',
          taskId: 'task-1',
        });
      },
      { timeout: 10_000 },
    );
  }, 15_000);

  it('keeps pending plan detection intact when the same task watcher is reattached', async () => {
    const worktreePath = createWorktree();
    worktrees.push(worktreePath);

    fs.mkdirSync(path.join(worktreePath, '.claude', 'plans'), { recursive: true });
    const firstListener = vi.fn();
    const reattachedListener = vi.fn();

    const beginAdmission = createBeginAdmission(worktreePath);
    startPlanWatcher('task-1', worktreePath, beginAdmission, firstListener);
    await waitForWatcherSetup();
    writePlan(worktreePath, '.claude/plans', 'reattached.md', '# Reattached plan');
    startPlanWatcher('task-1', worktreePath, beginAdmission, reattachedListener);

    await vi.waitFor(
      () => {
        expect(reattachedListener).toHaveBeenCalledWith({
          content: '# Reattached plan',
          fileName: 'reattached.md',
          relativePath: '.claude/plans/reattached.md',
          taskId: 'task-1',
        });
      },
      { timeout: 10_000 },
    );
    expect(firstListener).not.toHaveBeenCalled();
  }, 15_000);

  it('clears the emitted plan when the generated file is deleted', async () => {
    const worktreePath = createWorktree();
    worktrees.push(worktreePath);

    fs.mkdirSync(path.join(worktreePath, '.claude', 'plans'), { recursive: true });
    const onPlanContent = vi.fn();

    startPlanWatcher('task-1', worktreePath, createBeginAdmission(worktreePath), onPlanContent);
    await waitForWatcherSetup();
    const filePath = writePlan(worktreePath, '.claude/plans', 'generated.md', '# Generated plan');

    await vi.waitFor(
      () => {
        expect(onPlanContent).toHaveBeenCalledWith({
          content: '# Generated plan',
          fileName: 'generated.md',
          relativePath: '.claude/plans/generated.md',
          taskId: 'task-1',
        });
      },
      { timeout: 10_000 },
    );

    fs.unlinkSync(filePath);
    await vi.waitFor(
      () => {
        expect(onPlanContent).toHaveBeenLastCalledWith({
          content: null,
          fileName: null,
          relativePath: null,
          taskId: 'task-1',
        });
      },
      { timeout: 10_000 },
    );
  }, 15_000);

  it('rejects plan symlink escapes and non-plan paths', () => {
    const worktreePath = createWorktree();
    const outsidePath = createWorktree();
    worktrees.push(worktreePath, outsidePath);
    fs.mkdirSync(path.join(worktreePath, 'docs', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(outsidePath, 'secret.md'), 'secret');
    fs.symlinkSync(
      path.join(outsidePath, 'secret.md'),
      path.join(worktreePath, 'docs', 'plans', 'escape.md'),
    );
    fs.writeFileSync(path.join(worktreePath, 'outside.md'), 'outside');

    const beginAdmission = createBeginAdmission(worktreePath);
    expect(readPlan(beginAdmission, 'docs/plans/escape.md')).toBeNull();
    expect(readPlan(beginAdmission, 'outside.md')).toBeNull();
  });

  it('rejects exact plans above the plan byte cap', () => {
    const worktreePath = createWorktree();
    worktrees.push(worktreePath);
    writePlan(
      worktreePath,
      '.claude/plans',
      'large.md',
      Buffer.alloc(PLAN_FILE_MAX_BYTES + 1).toString(),
    );

    expect(readPlan(createBeginAdmission(worktreePath), '.claude/plans/large.md')).toBeNull();
  });
});
