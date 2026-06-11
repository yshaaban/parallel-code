import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  checkMergeStatusMock,
  getBranchLogMock,
  getProjectDiffMock,
  getWorktreeStatusMock,
  startGitWatcherMock,
  stopGitWatcherMock,
} = vi.hoisted(() => ({
  checkMergeStatusMock: vi.fn(),
  getBranchLogMock: vi.fn(),
  getProjectDiffMock: vi.fn(),
  getWorktreeStatusMock: vi.fn(),
  startGitWatcherMock: vi.fn(),
  stopGitWatcherMock: vi.fn(),
}));

vi.mock('./git.js', () => ({
  checkMergeStatus: checkMergeStatusMock,
  commitAll: vi.fn(),
  discardUncommitted: vi.fn(),
  getBranchLog: getBranchLogMock,
  getChangedFilesFromBranchWithRevision: vi.fn(),
  getProjectDiff: getProjectDiffMock,
  getWorktreeStatus: getWorktreeStatusMock,
  invalidateGitQueryCacheForPath: vi.fn(),
  invalidateWorktreeStatusCache: vi.fn(),
  rebaseTask: vi.fn(),
}));

vi.mock('./git-watcher.js', () => ({
  startGitWatcher: startGitWatcherMock,
  stopGitWatcher: stopGitWatcherMock,
}));

import type { TaskConvergenceSnapshot } from '../../src/domain/task-convergence.js';
import { resetBackendWorkQueueForTests } from './backend-work-queue.js';
import type { PersistedDerivedStateFile } from './derived-state-persistence.js';
import { clearGitStatusSnapshots, listGitStatusSnapshots } from './git-status-state.js';
import {
  resetGitStatusWorkflowRegistryForTests,
  scheduleGitStatusRefresh,
} from './git-status-workflows.js';
import { createSavedStateDocument } from './saved-state-document.js';
import { restoreBackendDerivedState } from './saved-state-restore.js';
import {
  clearTaskConvergenceRegistry,
  getTaskConvergenceSnapshot,
} from './task-convergence-state.js';
import { clearTaskReviewRegistry } from './task-review-state.js';
import { clearTaskReviewSignalsRegistry } from './task-review-signals.js';
import { clearTaskStepsRegistry } from './task-steps.js';

const SAVED_STATE_JSON = JSON.stringify({
  projects: [{ id: 'project-1', path: '/tmp/project' }],
  tasks: {
    'task-1': {
      branchName: 'feature/one',
      id: 'task-1',
      name: 'Task One',
      projectId: 'project-1',
      worktreePath: '/tmp/project/.worktrees/one',
    },
    'task-2': {
      branchName: 'feature/two',
      id: 'task-2',
      name: 'Task Two',
      projectId: 'project-1',
      worktreePath: '/tmp/project/.worktrees/two',
    },
    'task-legacy': { name: 'legacy fragment without id or worktree' },
  },
});

function createConvergenceSnapshot(
  overrides: Partial<TaskConvergenceSnapshot>,
): TaskConvergenceSnapshot {
  return {
    branchFiles: ['src/a.ts'],
    branchName: 'feature/one',
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
    taskId: 'task-1',
    totalAdded: 3,
    totalRemoved: 1,
    updatedAt: 1_000,
    worktreePath: '/tmp/project/.worktrees/one',
    ...overrides,
  };
}

function createDerivedState(
  overrides: Partial<PersistedDerivedStateFile> = {},
): PersistedDerivedStateFile {
  return {
    formatVersion: 1,
    gitStatus: [],
    savedAt: 1_000,
    taskConvergence: [],
    taskReview: [],
    taskReviewSignals: [],
    taskSteps: [],
    ...overrides,
  };
}

async function flushResolvedPromises(iterations = 8): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function resetAllRegistries(): void {
  resetBackendWorkQueueForTests();
  resetGitStatusWorkflowRegistryForTests();
  clearGitStatusSnapshots();
  clearTaskConvergenceRegistry();
  clearTaskReviewRegistry();
  clearTaskReviewSignalsRegistry();
  clearTaskStepsRegistry();
}

describe('restoreBackendDerivedState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllRegistries();
    startGitWatcherMock.mockResolvedValue(undefined);
    getWorktreeStatusMock.mockResolvedValue({
      has_committed_changes: true,
      has_uncommitted_changes: false,
    });
    getProjectDiffMock.mockResolvedValue({ files: [], totalAdded: 0, totalRemoved: 0 });
    checkMergeStatusMock.mockResolvedValue({
      conflicting_files: [],
      current_branch: 'feature/one',
      main_ahead_count: 0,
    });
    getBranchLogMock.mockResolvedValue('');
  });

  afterEach(() => {
    resetAllRegistries();
  });

  it('starts watchers without spawning any git work during restore', async () => {
    restoreBackendDerivedState({
      context: { emitGitStatusChanged: vi.fn() },
      derivedState: createDerivedState(),
      document: createSavedStateDocument(SAVED_STATE_JSON),
    });
    await flushResolvedPromises();

    expect(startGitWatcherMock).toHaveBeenCalledTimes(2);
    expect(startGitWatcherMock).toHaveBeenCalledWith(
      'task-1',
      '/tmp/project/.worktrees/one',
      expect.any(Function),
    );
    expect(getWorktreeStatusMock).not.toHaveBeenCalled();
    expect(getProjectDiffMock).not.toHaveBeenCalled();
    expect(checkMergeStatusMock).not.toHaveBeenCalled();
    expect(getBranchLogMock).not.toHaveBeenCalled();
  });

  it('hydrates derived snapshots behind exact identity filters', () => {
    const derivedState = createDerivedState({
      gitStatus: [
        {
          status: { has_committed_changes: true, has_uncommitted_changes: true },
          worktreePath: '/tmp/project/.worktrees/one',
        },
        {
          status: { has_committed_changes: false, has_uncommitted_changes: false },
          worktreePath: '/tmp/unregistered-worktree',
        },
      ],
      taskConvergence: [
        createConvergenceSnapshot({}),
        createConvergenceSnapshot({ taskId: 'task-stale' }),
        createConvergenceSnapshot({ taskId: 'task-2', worktreePath: '/tmp/wrong-worktree' }),
        createConvergenceSnapshot({
          branchName: 'feature/renamed',
          taskId: 'task-2',
          worktreePath: '/tmp/project/.worktrees/two',
        }),
      ],
    });

    restoreBackendDerivedState({
      context: { emitGitStatusChanged: vi.fn() },
      derivedState,
      document: createSavedStateDocument(SAVED_STATE_JSON),
    });

    expect(listGitStatusSnapshots().map((snapshot) => snapshot.worktreePath)).toEqual([
      '/tmp/project/.worktrees/one',
    ]);
    expect(getTaskConvergenceSnapshot('task-1')).toMatchObject({
      state: 'review-ready',
      taskId: 'task-1',
    });
    expect(getTaskConvergenceSnapshot('task-stale')).toBeUndefined();
    expect(getTaskConvergenceSnapshot('task-2')).toBeUndefined();
  });

  it('boots cleanly without a derived-state file and tolerates legacy fragments', async () => {
    restoreBackendDerivedState({
      context: { emitGitStatusChanged: vi.fn() },
      derivedState: null,
      document: createSavedStateDocument(SAVED_STATE_JSON),
    });
    await flushResolvedPromises();

    expect(startGitWatcherMock).toHaveBeenCalledTimes(2);
    expect(listGitStatusSnapshots()).toEqual([]);
    expect(getTaskConvergenceSnapshot('task-1')).toBeUndefined();
  });

  it('schedules no refresh at restore and exactly one chain after a focus-driven refresh', async () => {
    const emitGitStatusChanged = vi.fn();
    const context = { emitGitStatusChanged };

    restoreBackendDerivedState({
      context,
      derivedState: createDerivedState(),
      document: createSavedStateDocument(SAVED_STATE_JSON),
    });
    await flushResolvedPromises();
    expect(getWorktreeStatusMock).not.toHaveBeenCalled();

    scheduleGitStatusRefresh(context, '/tmp/project/.worktrees/one', undefined, 'selected');
    await flushResolvedPromises(16);

    expect(getWorktreeStatusMock).toHaveBeenCalledTimes(2);
    expect(getWorktreeStatusMock).toHaveBeenCalledWith('/tmp/project/.worktrees/one');
    expect(getProjectDiffMock).toHaveBeenCalled();
    expect(emitGitStatusChanged).toHaveBeenCalledTimes(1);
  });
});
