import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../electron/ipc/channels';
import { setStore, store } from '../store/core';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

import {
  getTaskConvergenceSnapshot,
  getTaskReviewQueueEntries,
  refreshProjectTaskConvergence,
  refreshTaskConvergence,
} from './task-convergence';

function mockConvergenceData(): void {
  invokeMock.mockImplementation((channel: IPC, args?: { worktreePath?: string; mode?: string }) => {
    const worktreePath = args?.worktreePath ?? '';
    if (channel === IPC.GetProjectDiff) {
      if (worktreePath.endsWith('task-1')) {
        return Promise.resolve({
          files: [
            {
              committed: true,
              lines_added: 10,
              lines_removed: 2,
              path: 'src/shared.ts',
              status: 'modified',
            },
            {
              committed: true,
              lines_added: 3,
              lines_removed: 0,
              path: 'src/feature.ts',
              status: 'added',
            },
          ],
          totalAdded: 13,
          totalRemoved: 2,
        });
      }

      if (worktreePath.endsWith('task-2')) {
        return Promise.resolve({
          files: [
            {
              committed: true,
              lines_added: 4,
              lines_removed: 1,
              path: 'src/shared.ts',
              status: 'modified',
            },
          ],
          totalAdded: 4,
          totalRemoved: 1,
        });
      }

      return Promise.resolve({
        files: [],
        totalAdded: 0,
        totalRemoved: 0,
      });
    }

    if (channel === IPC.GetWorktreeStatus) {
      if (worktreePath.endsWith('task-3')) {
        return Promise.resolve({
          has_committed_changes: false,
          has_uncommitted_changes: true,
        });
      }

      return Promise.resolve({
        has_committed_changes: true,
        has_uncommitted_changes: false,
      });
    }

    if (channel === IPC.CheckMergeStatus) {
      if (worktreePath.endsWith('task-3')) {
        return Promise.resolve({
          main_ahead_count: 2,
          conflicting_files: [],
        });
      }

      return Promise.resolve({
        main_ahead_count: 0,
        conflicting_files: [],
      });
    }

    if (channel === IPC.GetBranchLog) {
      if (worktreePath.endsWith('task-1')) {
        return Promise.resolve('- commit one\n- commit two\n');
      }

      if (worktreePath.endsWith('task-2')) {
        return Promise.resolve('- overlap commit\n');
      }

      return Promise.resolve('');
    }

    throw new Error(`Unexpected invoke: ${channel}`);
  });
}

describe('task convergence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    setStore('projects', [createTestProject()]);
    setStore('tasks', {
      'task-1': createTestTask({
        id: 'task-1',
        name: 'Ready task',
        worktreePath: '/tmp/project/task-1',
      }),
      'task-2': createTestTask({
        id: 'task-2',
        name: 'Overlap task',
        branchName: 'feature/task-2',
        worktreePath: '/tmp/project/task-2',
      }),
      'task-3': createTestTask({
        id: 'task-3',
        name: 'Needs refresh task',
        branchName: 'feature/task-3',
        worktreePath: '/tmp/project/task-3',
      }),
    });
    setStore('taskOrder', ['task-1', 'task-2', 'task-3']);
    mockConvergenceData();
  });

  it('derives readiness state from git and merge inputs', async () => {
    await refreshTaskConvergence('task-3');

    expect(getTaskConvergenceSnapshot('task-3')).toMatchObject({
      mainAheadCount: 2,
      state: 'needs-refresh',
      summary: 'Main is ahead by 2 commits',
      worktreePath: '/tmp/project/task-3',
    });
  });

  it('computes overlap warnings and groups the review queue', async () => {
    await refreshProjectTaskConvergence('project-1');

    expect(getTaskConvergenceSnapshot('task-1')).toMatchObject({
      commitCount: 2,
      overlapWarnings: [
        {
          otherTaskId: 'task-2',
          otherTaskName: 'Overlap task',
          sharedCount: 1,
          sharedFiles: ['src/shared.ts'],
        },
      ],
      state: 'review-ready',
      worktreePath: '/tmp/project/task-1',
    });

    expect(getTaskConvergenceSnapshot('task-2')).toMatchObject({
      overlapWarnings: [
        {
          otherTaskId: 'task-1',
          otherTaskName: 'Ready task',
          sharedCount: 1,
          sharedFiles: ['src/shared.ts'],
        },
      ],
      state: 'review-ready',
    });

    expect(getTaskReviewQueueEntries().map((entry) => [entry.taskId, entry.group])).toEqual([
      ['task-3', 'needs-refresh'],
      ['task-1', 'overlap-risk'],
      ['task-2', 'overlap-risk'],
    ]);
    expect(store.taskConvergence['task-1']?.changedFileCount).toBe(2);
  });
});
