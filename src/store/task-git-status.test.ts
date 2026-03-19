import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  applyGitStatusFromPushMock,
  clearAllRecentTaskGitStatusPollAgesMock,
  clearRecentTaskGitStatusPollAgeMock,
  getProjectPathMock,
  getRecentTaskGitStatusPollAgeMock,
  refreshTaskStatusMock,
  setStoreMock,
  storeState,
} = vi.hoisted(() => ({
  applyGitStatusFromPushMock: vi.fn(),
  clearAllRecentTaskGitStatusPollAgesMock: vi.fn(),
  clearRecentTaskGitStatusPollAgeMock: vi.fn(),
  getProjectPathMock: vi.fn(),
  getRecentTaskGitStatusPollAgeMock: vi.fn().mockReturnValue(null),
  refreshTaskStatusMock: vi.fn(),
  setStoreMock: vi.fn((key: string, value: unknown) => {
    if (key !== 'taskGitStatus' || typeof value !== 'function') {
      return;
    }

    storeState.taskGitStatus = value();
  }),
  storeState: {
    taskGitStatus: {} as Record<string, unknown>,
    tasks: {} as Record<
      string,
      { id: string; worktreePath: string; branchName: string; projectId: string }
    >,
    agentActive: {} as Record<string, boolean>,
  },
}));

vi.mock('./git-status-polling', () => ({
  createGitStatusPollingController: vi.fn(() => ({
    applyGitStatusFromPush: applyGitStatusFromPushMock,
    clearAllRecentTaskGitStatusPollAges: clearAllRecentTaskGitStatusPollAgesMock,
    clearRecentTaskGitStatusPollAge: clearRecentTaskGitStatusPollAgeMock,
    getRecentTaskGitStatusPollAge: getRecentTaskGitStatusPollAgeMock,
    refreshAllTaskGitStatus: vi.fn(),
    refreshTaskStatus: refreshTaskStatusMock,
    rescheduleTaskStatusPolling: vi.fn(),
    startTaskStatusPolling: vi.fn(),
    stopTaskStatusPolling: vi.fn(),
  })),
}));

vi.mock('./projects', () => ({
  getProjectPath: getProjectPathMock,
}));

vi.mock('./state', () => ({
  setStore: setStoreMock,
  store: storeState,
}));

import {
  clearRecentTaskGitStatusPollAge,
  getRecentTaskGitStatusPollAge,
  gitStatusEventMatchesTarget,
  handleGitStatusSyncEvent,
  refreshGitStatusFromServerEvent,
  resetTaskGitStatusRuntimeState,
  replaceGitStatusSnapshots,
} from './task-git-status';

describe('task git status owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.taskGitStatus = {};
    storeState.tasks = {
      one: {
        id: 'task-1',
        worktreePath: '/tmp/task-1',
        branchName: 'feature/one',
        projectId: 'project-1',
      },
      duplicate: {
        id: 'task-1',
        worktreePath: '/tmp/task-1-copy',
        branchName: 'feature/one',
        projectId: 'project-1',
      },
      two: {
        id: 'task-2',
        worktreePath: '/tmp/task-2',
        branchName: 'feature/two',
        projectId: 'project-2',
      },
    };
    getProjectPathMock.mockImplementation((projectId: string) => {
      if (projectId === 'project-1') {
        return '/repo/one';
      }
      if (projectId === 'project-2') {
        return '/repo/two';
      }
      return null;
    });
    getRecentTaskGitStatusPollAgeMock.mockReturnValue(null);
  });

  it('applies pushed status directly when the server includes worktree status', () => {
    const status = {
      has_committed_changes: true,
      has_uncommitted_changes: false,
    };

    handleGitStatusSyncEvent({
      worktreePath: '/tmp/task-1',
      status,
    });

    expect(applyGitStatusFromPushMock).toHaveBeenCalledWith('/tmp/task-1', status);
    expect(refreshTaskStatusMock).not.toHaveBeenCalled();
  });

  it('refreshes matching tasks once for branch or project invalidation events', () => {
    refreshGitStatusFromServerEvent({
      branchName: 'feature/one',
      projectRoot: '/repo/one',
    });

    expect(refreshTaskStatusMock).toHaveBeenCalledTimes(1);
    expect(refreshTaskStatusMock).toHaveBeenCalledWith('task-1');
  });

  it('refreshes the matching task when a worktree event arrives without status payload', () => {
    handleGitStatusSyncEvent({
      worktreePath: '/tmp/task-2',
    });

    expect(applyGitStatusFromPushMock).not.toHaveBeenCalled();
    expect(refreshTaskStatusMock).toHaveBeenCalledTimes(1);
    expect(refreshTaskStatusMock).toHaveBeenCalledWith('task-2');
  });

  it('matches worktree, branch, and project invalidations through one shared helper', () => {
    expect(
      gitStatusEventMatchesTarget(
        { worktreePath: '/tmp/task-1' },
        {
          worktreePath: '/tmp/task-1',
          branchName: 'feature/one',
          projectRoot: '/repo/one',
        },
      ),
    ).toBe(true);

    expect(
      gitStatusEventMatchesTarget(
        { branchName: 'feature/one', projectRoot: '/repo/one' },
        {
          worktreePath: '/tmp/task-1',
          branchName: 'feature/one',
          projectRoot: '/repo/one',
        },
      ),
    ).toBe(true);

    expect(
      gitStatusEventMatchesTarget(
        { projectRoot: '/repo/one' },
        {
          worktreePath: '/tmp/task-1',
          branchName: 'feature/one',
          projectRoot: '/repo/one',
        },
      ),
    ).toBe(true);

    expect(
      gitStatusEventMatchesTarget(
        { branchName: 'feature/two', projectRoot: '/repo/two' },
        {
          worktreePath: '/tmp/task-1',
          branchName: 'feature/one',
          projectRoot: '/repo/one',
        },
      ),
    ).toBe(false);
  });

  it('replaces task git status snapshots from matching worktree paths', () => {
    const status = {
      has_committed_changes: true,
      has_uncommitted_changes: false,
    };

    replaceGitStatusSnapshots([
      {
        worktreePath: '/tmp/task-1',
        status,
      },
      {
        worktreePath: '/tmp/missing',
        status: {
          has_committed_changes: false,
          has_uncommitted_changes: true,
        },
      },
    ]);

    expect(setStoreMock).toHaveBeenCalledWith('taskGitStatus', expect.any(Function));
    expect(storeState.taskGitStatus).toEqual({
      'task-1': status,
    });
  });

  it('exposes git-status freshness through the polling controller', () => {
    getRecentTaskGitStatusPollAgeMock.mockReturnValue(250);

    expect(getRecentTaskGitStatusPollAge('/tmp/task-1')).toBe(250);
    expect(getRecentTaskGitStatusPollAgeMock).toHaveBeenCalledWith('/tmp/task-1');
  });

  it('clears git-status freshness for a removed worktree path', () => {
    clearRecentTaskGitStatusPollAge('/tmp/task-1');

    expect(clearRecentTaskGitStatusPollAgeMock).toHaveBeenCalledWith('/tmp/task-1');
  });

  it('resets git-status runtime freshness state', () => {
    resetTaskGitStatusRuntimeState();

    expect(clearAllRecentTaskGitStatusPollAgesMock).toHaveBeenCalledTimes(1);
  });
});
