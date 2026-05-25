import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import {
  getGitStatusSyncEventKind,
  isGitStatusSyncSnapshotEvent,
  type WorktreeStatus,
} from '../domain/server-state';

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
      {
        baseBranch?: string;
        id: string;
        worktreePath: string;
        branchName: string;
        projectId: string;
      }
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
  isTaskGitStatusFresh,
  refreshTaskGitStatusForTask,
  refreshGitStatusFromServerEvent,
  resetTaskGitStatusRuntimeState,
  replaceGitStatusSnapshots,
} from './task-git-status';

const INITIAL_TIME = new Date('2025-01-01T00:00:00Z');
const INITIAL_TIME_MS = INITIAL_TIME.getTime();

type BasicWorktreeStatus = Pick<
  WorktreeStatus,
  'has_committed_changes' | 'has_uncommitted_changes'
>;

function createFreshStatus(
  status: BasicWorktreeStatus,
  updatedAt = INITIAL_TIME_MS,
): WorktreeStatus {
  return {
    ...status,
    errorMessage: null,
    freshness: 'fresh',
    updatedAt,
  };
}

function getStoredTaskGitStatus(taskId: string): WorktreeStatus | undefined {
  return storeState.taskGitStatus[taskId] as WorktreeStatus | undefined;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    reject = innerReject;
    resolve = innerResolve;
  });
  return { promise, reject, resolve };
}

describe('task git status owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(INITIAL_TIME);
    resetTaskGitStatusRuntimeState();
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
        baseBranch: 'release/main',
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

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
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
      'task-1': createFreshStatus(status),
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
      'task-1': createFreshStatus(status),
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
      baseBranch: 'release/main',
      worktreePath: '/tmp/task-2',
    });
    expect(storeState.taskGitStatus).toEqual({
      'task-2': createFreshStatus(status),
    });
  });

  it('marks a successful manual refresh as fresh with an updated timestamp', async () => {
    const status = {
      has_committed_changes: true,
      has_uncommitted_changes: false,
    };
    invokeMock.mockResolvedValueOnce(status);
    vi.setSystemTime(new Date('2025-01-01T00:00:05Z'));

    await expect(refreshTaskGitStatusForTask('task-2')).resolves.toBe(true);

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetWorktreeStatus, {
      baseBranch: 'release/main',
      worktreePath: '/tmp/task-2',
    });
    expect(getStoredTaskGitStatus('task-2')).toEqual(
      createFreshStatus(status, Date.parse('2025-01-01T00:00:05Z')),
    );
    expect(isTaskGitStatusFresh(getStoredTaskGitStatus('task-2'))).toBe(true);
  });

  it('marks a failed manual refresh as stale without discarding previous booleans', async () => {
    storeState.taskGitStatus['task-1'] = {
      has_committed_changes: true,
      has_uncommitted_changes: false,
      freshness: 'fresh',
      updatedAt: INITIAL_TIME_MS,
    };
    invokeMock.mockRejectedValueOnce(new Error('git status failed'));

    await expect(refreshTaskGitStatusForTask('task-1')).resolves.toBe(false);

    expect(getStoredTaskGitStatus('task-1')).toEqual({
      has_committed_changes: true,
      has_uncommitted_changes: false,
      errorMessage: 'git status failed',
      freshness: 'stale',
      updatedAt: INITIAL_TIME_MS,
    });
    expect(isTaskGitStatusFresh(getStoredTaskGitStatus('task-1'))).toBe(false);
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

  it('classifies snapshot and refresh git status events explicitly', () => {
    expect(
      isGitStatusSyncSnapshotEvent({
        worktreePath: '/tmp/task-1',
        status: {
          has_committed_changes: true,
          has_uncommitted_changes: false,
        },
      }),
    ).toBe(true);
    expect(
      getGitStatusSyncEventKind({
        worktreePath: '/tmp/task-1',
        status: {
          has_committed_changes: true,
          has_uncommitted_changes: false,
        },
      }),
    ).toBe('snapshot');
    expect(getGitStatusSyncEventKind({ branchName: 'feature/one', projectRoot: '/repo/one' })).toBe(
      'refresh',
    );
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
      'task-1': createFreshStatus(status),
    });
  });

  it('ignores a stale async refresh result after a newer pushed status', async () => {
    const deferredStatus = createDeferred<{
      has_committed_changes: boolean;
      has_uncommitted_changes: boolean;
    }>();
    invokeMock.mockReturnValueOnce(deferredStatus.promise);

    handleGitStatusSyncEvent({
      worktreePath: '/tmp/task-1',
    });
    await Promise.resolve();

    const pushedStatus = {
      has_committed_changes: true,
      has_uncommitted_changes: false,
    };
    handleGitStatusSyncEvent({
      stateVersion: 2,
      status: pushedStatus,
      worktreePath: '/tmp/task-1',
    });

    deferredStatus.resolve({
      has_committed_changes: false,
      has_uncommitted_changes: true,
    });
    await deferredStatus.promise;
    await Promise.resolve();

    expect(storeState.taskGitStatus).toEqual({
      'task-1': createFreshStatus(pushedStatus),
    });
  });

  it('ignores a stale async refresh failure after a newer refresh succeeds', async () => {
    const firstRefresh = createDeferred<{
      has_committed_changes: boolean;
      has_uncommitted_changes: boolean;
    }>();
    const secondRefresh = createDeferred<{
      has_committed_changes: boolean;
      has_uncommitted_changes: boolean;
    }>();
    invokeMock.mockReturnValueOnce(firstRefresh.promise).mockReturnValueOnce(secondRefresh.promise);

    const firstResult = refreshTaskGitStatusForTask('task-1');
    const secondResult = refreshTaskGitStatusForTask('task-1');

    const newerStatus = {
      has_committed_changes: false,
      has_uncommitted_changes: true,
    };
    secondRefresh.resolve(newerStatus);
    await expect(secondResult).resolves.toBe(true);

    firstRefresh.reject(new Error('old refresh failed'));
    await expect(firstResult).resolves.toBe(false);

    expect(getStoredTaskGitStatus('task-1')).toEqual(createFreshStatus(newerStatus));
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
