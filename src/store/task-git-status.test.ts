import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { getProjectPathMock, invokeMock, setStoreMock, storeState } = vi.hoisted(() => ({
  getProjectPathMock: vi.fn(),
  invokeMock: vi.fn(),
  setStoreMock: vi.fn((key: string, ...args: unknown[]) => {
    if (key !== 'taskGitStatus') {
      return;
    }

    if (args.length === 1 && typeof args[0] === 'function') {
      storeState.taskGitStatus = args[0]();
      return;
    }

    if (args.length === 2 && typeof args[0] === 'string') {
      storeState.taskGitStatus[args[0]] = args[1];
    }
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

vi.mock('./projects', () => ({
  getProjectPath: getProjectPathMock,
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    storeState.taskGitStatus = {};
    storeState.tasks = {
      'task-1': {
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
      'task-2': {
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
    invokeMock.mockResolvedValue({
      has_committed_changes: false,
      has_uncommitted_changes: true,
    });
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

    expect(invokeMock).not.toHaveBeenCalled();
    expect(storeState.taskGitStatus).toEqual({
      'task-1': status,
    });
  });

  it('refreshes matching tasks once for branch or project invalidation events', async () => {
    const status = {
      has_committed_changes: false,
      has_uncommitted_changes: true,
    };
    invokeMock.mockResolvedValue(status);

    refreshGitStatusFromServerEvent({
      branchName: 'feature/one',
      projectRoot: '/repo/one',
    });

    await vi.runAllTicks();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetWorktreeStatus, {
      worktreePath: '/tmp/task-1',
    });
    expect(storeState.taskGitStatus).toEqual({
      'task-1': status,
    });
  });

  it('refreshes the matching task when a worktree event arrives without status payload', async () => {
    const status = {
      has_committed_changes: false,
      has_uncommitted_changes: true,
    };
    invokeMock.mockResolvedValue(status);

    handleGitStatusSyncEvent({
      worktreePath: '/tmp/task-2',
    });

    await vi.runAllTicks();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetWorktreeStatus, {
      worktreePath: '/tmp/task-2',
    });
    expect(storeState.taskGitStatus).toEqual({
      'task-2': status,
    });
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
    handleGitStatusSyncEvent({
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });
    vi.advanceTimersByTime(250);

    expect(getRecentTaskGitStatusPollAge('/tmp/task-1')).toBe(250);
  });

  it('clears git-status freshness for a removed worktree path', () => {
    handleGitStatusSyncEvent({
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });

    clearRecentTaskGitStatusPollAge('/tmp/task-1');

    expect(getRecentTaskGitStatusPollAge('/tmp/task-1')).toBeNull();
  });

  it('resets git-status runtime freshness state', () => {
    handleGitStatusSyncEvent({
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });

    resetTaskGitStatusRuntimeState();

    expect(getRecentTaskGitStatusPollAge('/tmp/task-1')).toBeNull();
  });
});
