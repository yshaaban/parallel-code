import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearTaskStepsRegistry,
  getTaskStepsSnapshot,
  listTaskStepsSummarySnapshots,
  registerTaskStepsTask,
  stopAllTaskStepsWatchers,
  syncTaskStepsFromSavedState,
} from './task-steps.js';

function createWorktreeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-task-steps-'));
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
  return root;
}

describe('task steps backend owner', () => {
  const createdRoots: string[] = [];

  beforeEach(() => {
    clearTaskStepsRegistry();
    stopAllTaskStepsWatchers();
  });

  afterEach(() => {
    stopAllTaskStepsWatchers();
    clearTaskStepsRegistry();
    for (const root of createdRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('normalizes the durable steps file and mirrors it into shared snapshots', () => {
    const worktreePath = createWorktreeRoot();
    createdRoots.push(worktreePath);
    const stepsDir = path.join(worktreePath, '.claude');
    const stepsFile = path.join(stepsDir, 'steps.json');
    const excludeFile = path.join(worktreePath, '.git', 'info', 'exclude');
    fs.mkdirSync(stepsDir, { recursive: true });
    fs.writeFileSync(
      stepsFile,
      JSON.stringify(
        [
          {
            detail: 'Investigating the failure',
            files_touched: ['src/app.ts', 'src/app.ts', '  '],
            agent_id: 'worker-1',
            status: 'invalid-status',
            timestamp: 'not-a-date',
          },
        ],
        null,
        2,
      ),
    );

    registerTaskStepsTask({
      taskId: 'task-1',
      worktreePath,
    });

    const snapshot = getTaskStepsSnapshot('task-1');
    const persisted = JSON.parse(fs.readFileSync(stepsFile, 'utf8')) as Array<
      Record<string, unknown>
    >;

    expect(snapshot).toMatchObject({
      errorMessage: null,
      state: 'active',
      taskId: 'task-1',
      trackingEnabled: true,
    });
    expect(snapshot?.steps[0]).toMatchObject({
      agentId: 'worker-1',
      detail: 'Investigating the failure',
      filesTouched: ['src/app.ts'],
      status: 'investigating',
      summary: 'Investigating the failure',
    });
    expect(snapshot?.steps[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(persisted[0]).toMatchObject({
      agent_id: 'worker-1',
      detail: 'Investigating the failure',
      files_touched: ['src/app.ts'],
      status: 'investigating',
      summary: 'Investigating the failure',
    });
    expect(fs.readFileSync(excludeFile, 'utf8')).toContain('.claude/steps.json');
    expect(listTaskStepsSummarySnapshots()).toHaveLength(1);
  });

  it('drops steps state for tasks removed from saved workspace metadata', () => {
    const worktreePath = createWorktreeRoot();
    createdRoots.push(worktreePath);
    const stepsDir = path.join(worktreePath, '.claude');
    fs.mkdirSync(stepsDir, { recursive: true });
    fs.writeFileSync(
      path.join(stepsDir, 'steps.json'),
      JSON.stringify([{ summary: 'Waiting', status: 'awaiting_review', timestamp: '' }], null, 2),
    );

    registerTaskStepsTask({
      taskId: 'task-1',
      worktreePath,
    });
    expect(getTaskStepsSnapshot('task-1')).not.toBeNull();

    syncTaskStepsFromSavedState(JSON.stringify({ tasks: {} }));

    expect(getTaskStepsSnapshot('task-1')).toBeNull();
    expect(listTaskStepsSummarySnapshots()).toEqual([]);
  });
});
