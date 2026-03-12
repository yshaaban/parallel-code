import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  applyGitStatusFromPushMock,
  getProjectPathMock,
  refreshTaskConvergenceFromGitStatusSyncMock,
  refreshTaskStatusMock,
  storeState,
} = vi.hoisted(() => ({
  applyGitStatusFromPushMock: vi.fn(),
  getProjectPathMock: vi.fn(),
  refreshTaskConvergenceFromGitStatusSyncMock: vi.fn(),
  refreshTaskStatusMock: vi.fn(),
  storeState: {
    tasks: {} as Record<
      string,
      { id: string; worktreePath: string; branchName: string; projectId: string }
    >,
  },
}));

vi.mock('../store/taskStatus', () => ({
  applyGitStatusFromPush: applyGitStatusFromPushMock,
}));

vi.mock('./task-convergence', () => ({
  refreshTaskConvergenceFromGitStatusSync: refreshTaskConvergenceFromGitStatusSyncMock,
}));

vi.mock('../store/store', () => ({
  getProjectPath: getProjectPathMock,
  refreshTaskStatus: refreshTaskStatusMock,
  store: storeState,
}));

import {
  gitStatusEventMatchesTarget,
  handleGitStatusSyncEvent,
  refreshGitStatusFromServerEvent,
} from './git-status-sync';

describe('git status sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(refreshTaskConvergenceFromGitStatusSyncMock).toHaveBeenCalledWith(expect.any(Set));
  });

  it('refreshes matching tasks once for branch or project invalidation events', () => {
    refreshGitStatusFromServerEvent({
      branchName: 'feature/one',
      projectRoot: '/repo/one',
    });

    expect(refreshTaskStatusMock).toHaveBeenCalledTimes(1);
    expect(refreshTaskStatusMock).toHaveBeenCalledWith('task-1');
    expect(refreshTaskConvergenceFromGitStatusSyncMock).toHaveBeenCalledWith(new Set(['task-1']));
  });

  it('refreshes the matching task when a worktree event arrives without status payload', () => {
    handleGitStatusSyncEvent({
      worktreePath: '/tmp/task-2',
    });

    expect(applyGitStatusFromPushMock).not.toHaveBeenCalled();
    expect(refreshTaskStatusMock).toHaveBeenCalledTimes(1);
    expect(refreshTaskStatusMock).toHaveBeenCalledWith('task-2');
    expect(refreshTaskConvergenceFromGitStatusSyncMock).toHaveBeenCalledWith(new Set(['task-2']));
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
});
