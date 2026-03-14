import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensurePlansDirectory,
  readPlanForWorktree,
  startPlanWatcher,
  stopPlanWatcher,
} from './plans.js';

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

  it('reads the newest plan across both plan directories', () => {
    const worktreePath = createWorktree();
    worktrees.push(worktreePath);

    writePlan(worktreePath, '.claude/plans', 'older.md', '# Older plan');
    const docsPlanPath = writePlan(worktreePath, 'docs/plans', 'newer.md', '# Newer plan');
    const now = Date.now();
    fs.utimesSync(docsPlanPath, now / 1_000, (now + 5_000) / 1_000);

    expect(readPlanForWorktree(worktreePath)).toEqual({
      content: '# Newer plan',
      fileName: 'newer.md',
      relativePath: 'docs/plans/newer.md',
    });
  });

  it('reads an exact persisted plan file by name across both plan directories', () => {
    const worktreePath = createWorktree();
    worktrees.push(worktreePath);

    writePlan(worktreePath, 'docs/plans', 'restored.md', '# Restored plan');

    expect(readPlanForWorktree(worktreePath, 'docs/plans/restored.md')).toEqual({
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

    startPlanWatcher('task-1', worktreePath, onPlanContent);
    await waitForWatcherSetup();
    writePlan(worktreePath, 'docs/plans', 'new-plan.md', '# Fresh plan');

    await vi.waitFor(() => {
      expect(onPlanContent).toHaveBeenCalledWith({
        content: '# Fresh plan',
        fileName: 'new-plan.md',
        relativePath: 'docs/plans/new-plan.md',
        taskId: 'task-1',
      });
    });
  });

  it('clears the emitted plan when the generated file is deleted', async () => {
    const worktreePath = createWorktree();
    worktrees.push(worktreePath);

    fs.mkdirSync(path.join(worktreePath, '.claude', 'plans'), { recursive: true });
    const onPlanContent = vi.fn();

    startPlanWatcher('task-1', worktreePath, onPlanContent);
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
  });
});
