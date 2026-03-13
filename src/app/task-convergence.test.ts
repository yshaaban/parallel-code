import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { TaskConvergenceSnapshot } from '../domain/task-convergence';
import { setStore, store } from '../store/core';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

import {
  applyTaskConvergenceEvent,
  clearTaskConvergence,
  fetchTaskConvergence,
  getTaskConvergenceSnapshot,
  getTaskReviewQueueEntries,
  replaceTaskConvergenceSnapshots,
} from './task-convergence';

function createSnapshot(
  taskId: string,
  overrides: Partial<TaskConvergenceSnapshot> = {},
): TaskConvergenceSnapshot {
  return {
    branchFiles: ['src/app.ts'],
    branchName: `feature/${taskId}`,
    changedFileCount: 1,
    commitCount: 1,
    conflictingFiles: [],
    hasCommittedChanges: true,
    hasUncommittedChanges: false,
    mainAheadCount: 0,
    overlapWarnings: [],
    projectId: 'project-1',
    state: 'review-ready',
    summary: '1 commit, 1 file changed',
    taskId,
    totalAdded: 4,
    totalRemoved: 1,
    updatedAt: 1_000,
    worktreePath: `/tmp/${taskId}`,
    ...overrides,
  };
}

describe('task convergence projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    setStore('projects', [createTestProject()]);
    setStore('tasks', {
      'task-1': createTestTask({ id: 'task-1', name: 'Task one' }),
      'task-2': createTestTask({ id: 'task-2', name: 'Task two' }),
      'task-3': createTestTask({ id: 'task-3', name: 'Task three' }),
    });
    setStore('taskOrder', ['task-1', 'task-2', 'task-3']);
  });

  it('fetches convergence snapshots from the backend invoke contract', async () => {
    const snapshots = [createSnapshot('task-1')];
    invokeMock.mockResolvedValueOnce(snapshots);

    await expect(fetchTaskConvergence()).resolves.toEqual(snapshots);
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetTaskConvergence);
  });

  it('replaces convergence snapshots and applies update and removal events', () => {
    replaceTaskConvergenceSnapshots([createSnapshot('task-1'), createSnapshot('task-2')]);

    expect(getTaskConvergenceSnapshot('task-1')).toMatchObject({ taskId: 'task-1' });
    expect(getTaskConvergenceSnapshot('task-2')).toMatchObject({ taskId: 'task-2' });

    applyTaskConvergenceEvent(
      createSnapshot('task-1', {
        changedFileCount: 3,
        commitCount: 2,
        summary: '2 commits, 3 files changed',
        updatedAt: 2_000,
      }),
    );
    expect(getTaskConvergenceSnapshot('task-1')).toMatchObject({
      changedFileCount: 3,
      commitCount: 2,
      summary: '2 commits, 3 files changed',
    });

    applyTaskConvergenceEvent({
      removed: true,
      taskId: 'task-2',
    });
    expect(getTaskConvergenceSnapshot('task-2')).toBeUndefined();

    clearTaskConvergence('task-1');
    expect(getTaskConvergenceSnapshot('task-1')).toBeUndefined();
  });

  it('groups and sorts the review queue from pushed snapshots', () => {
    replaceTaskConvergenceSnapshots([
      createSnapshot('task-1', {
        state: 'review-ready',
        commitCount: 2,
        changedFileCount: 4,
        summary: '2 commits, 4 files changed',
      }),
      createSnapshot('task-2', {
        overlapWarnings: [
          {
            otherTaskId: 'task-1',
            otherTaskName: 'Task one',
            sharedCount: 2,
            sharedFiles: ['src/app.ts', 'src/util.ts'],
          },
        ],
        summary: '1 commit, 1 file changed',
      }),
      createSnapshot('task-3', {
        conflictingFiles: ['src/app.ts'],
        mainAheadCount: 1,
        state: 'merge-blocked',
        summary: '1 conflict with main',
      }),
    ]);

    expect(
      getTaskReviewQueueEntries().map((entry) => [entry.taskId, entry.group, entry.label]),
    ).toEqual([
      ['task-3', 'needs-refresh', '1 conflict with main'],
      ['task-2', 'overlap-risk', '2 shared files with Task one'],
      ['task-1', 'ready-to-review', '2 commits, 4 files'],
    ]);
    expect(store.taskConvergence['task-1']?.changedFileCount).toBe(4);
  });
});
