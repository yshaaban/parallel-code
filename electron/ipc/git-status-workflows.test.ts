import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';

const {
  commitAllMock,
  discardUncommittedMock,
  getWorktreeStatusMock,
  invalidateWorktreeStatusCacheMock,
  rebaseTaskMock,
  startGitWatcherMock,
  stopGitWatcherMock,
} = vi.hoisted(() => ({
  commitAllMock: vi.fn(),
  discardUncommittedMock: vi.fn(),
  getWorktreeStatusMock: vi.fn(),
  invalidateWorktreeStatusCacheMock: vi.fn(),
  rebaseTaskMock: vi.fn(),
  startGitWatcherMock: vi.fn(),
  stopGitWatcherMock: vi.fn(),
}));

vi.mock('./git.js', () => ({
  commitAll: commitAllMock,
  discardUncommitted: discardUncommittedMock,
  getWorktreeStatus: getWorktreeStatusMock,
  invalidateWorktreeStatusCache: invalidateWorktreeStatusCacheMock,
  rebaseTask: rebaseTaskMock,
}));

vi.mock('./git-watcher.js', () => ({
  startGitWatcher: startGitWatcherMock,
  stopGitWatcher: stopGitWatcherMock,
}));

import {
  commitAllWorkflow,
  discardUncommittedWorkflow,
  loadGitStatusChangedPayload,
  rebaseTaskWorkflow,
  refreshGitStatusWorkflow,
  restoreSavedTaskGitStatusMonitoring,
  startTaskGitStatusMonitoring,
  startTaskGitStatusWatcher,
  stopTaskGitStatusWatcher,
  type GitStatusWorkflowContext,
} from './git-status-workflows.js';

function createContext(): GitStatusWorkflowContext {
  return {
    emitIpcEvent: vi.fn(),
  };
}

describe('git status workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commitAllMock.mockReset();
    discardUncommittedMock.mockReset();
    getWorktreeStatusMock.mockReset();
    invalidateWorktreeStatusCacheMock.mockReset();
    rebaseTaskMock.mockReset();
    startGitWatcherMock.mockReset();
    stopGitWatcherMock.mockReset();
    getWorktreeStatusMock.mockResolvedValue({ dirty: true });
    commitAllMock.mockResolvedValue({ commitHash: 'abc123' });
    discardUncommittedMock.mockResolvedValue(undefined);
    rebaseTaskMock.mockResolvedValue({ ok: true });
    startGitWatcherMock.mockResolvedValue(undefined);
  });

  it('refreshes git status and emits the updated payload', async () => {
    const context = createContext();

    await refreshGitStatusWorkflow(context, '/tmp/task-1');

    expect(invalidateWorktreeStatusCacheMock).toHaveBeenCalledWith('/tmp/task-1');
    expect(getWorktreeStatusMock).toHaveBeenCalledWith('/tmp/task-1');
    expect(context.emitIpcEvent).toHaveBeenCalledWith(IPC.GitStatusChanged, {
      worktreePath: '/tmp/task-1',
      status: { dirty: true },
    });
  });

  it('builds a reusable git status payload for server-driven updates', async () => {
    await expect(loadGitStatusChangedPayload('/tmp/task-1')).resolves.toEqual({
      worktreePath: '/tmp/task-1',
      status: { dirty: true },
    });
  });

  it('emits a fallback payload when git status refresh fails', async () => {
    const context = createContext();
    getWorktreeStatusMock.mockRejectedValue(new Error('git failed'));

    await refreshGitStatusWorkflow(context, '/tmp/task-1');

    expect(context.emitIpcEvent).toHaveBeenCalledWith(IPC.GitStatusChanged, {
      worktreePath: '/tmp/task-1',
    });
  });

  it('builds a fallback payload when git status lookup fails', async () => {
    getWorktreeStatusMock.mockRejectedValue(new Error('git failed'));

    await expect(loadGitStatusChangedPayload('/tmp/task-1')).resolves.toEqual({
      worktreePath: '/tmp/task-1',
    });
  });

  it('wires task git watchers to async refreshes', async () => {
    const context = createContext();
    let onChanged: (() => void) | undefined;
    startGitWatcherMock.mockImplementation(
      async (_taskId: string, _worktreePath: string, callback: () => void) => {
        onChanged = callback;
      },
    );

    await startTaskGitStatusWatcher(context, {
      taskId: 'task-1',
      worktreePath: '/tmp/task-1',
    });

    expect(startGitWatcherMock).toHaveBeenCalledWith('task-1', '/tmp/task-1', expect.any(Function));

    onChanged?.();

    await vi.waitFor(() => {
      expect(invalidateWorktreeStatusCacheMock).toHaveBeenCalledWith('/tmp/task-1');
      expect(context.emitIpcEvent).toHaveBeenCalledWith(IPC.GitStatusChanged, {
        worktreePath: '/tmp/task-1',
        status: { dirty: true },
      });
    });
  });

  it('starts task monitoring with an initial refresh', async () => {
    const context = createContext();

    await startTaskGitStatusMonitoring(context, {
      taskId: 'task-1',
      worktreePath: '/tmp/task-1',
    });

    expect(startGitWatcherMock).toHaveBeenCalledWith('task-1', '/tmp/task-1', expect.any(Function));

    await vi.waitFor(() => {
      expect(invalidateWorktreeStatusCacheMock).toHaveBeenCalledWith('/tmp/task-1');
      expect(context.emitIpcEvent).toHaveBeenCalledWith(IPC.GitStatusChanged, {
        worktreePath: '/tmp/task-1',
        status: { dirty: true },
      });
    });
  });

  it('restores saved-task monitoring with an initial refresh and watcher setup', async () => {
    const emitGitStatusChanged = vi.fn();

    restoreSavedTaskGitStatusMonitoring(
      {
        emitGitStatusChanged,
      },
      JSON.stringify({
        tasks: {
          one: { id: 'task-1', worktreePath: '/tmp/task-1' },
          two: { id: 'task-2', worktreePath: '/tmp/task-2' },
        },
      }),
    );

    await vi.waitFor(() => {
      expect(startGitWatcherMock).toHaveBeenCalledWith(
        'task-1',
        '/tmp/task-1',
        expect.any(Function),
      );
      expect(startGitWatcherMock).toHaveBeenCalledWith(
        'task-2',
        '/tmp/task-2',
        expect.any(Function),
      );
      expect(emitGitStatusChanged).toHaveBeenCalledWith({
        worktreePath: '/tmp/task-1',
        status: { dirty: true },
      });
      expect(emitGitStatusChanged).toHaveBeenCalledWith({
        worktreePath: '/tmp/task-2',
        status: { dirty: true },
      });
    });
  });

  it('ignores malformed saved-task monitoring state', async () => {
    restoreSavedTaskGitStatusMonitoring(createContext(), '{not-json');
    await Promise.resolve();

    expect(startGitWatcherMock).not.toHaveBeenCalled();
    expect(getWorktreeStatusMock).not.toHaveBeenCalled();
  });

  it('schedules refresh after commit, discard, and rebase workflows', async () => {
    const context = createContext();

    await commitAllWorkflow(context, { worktreePath: '/tmp/task-1', message: 'save' });
    await discardUncommittedWorkflow(context, { worktreePath: '/tmp/task-2' });
    await rebaseTaskWorkflow(context, { worktreePath: '/tmp/task-3' });

    expect(commitAllMock).toHaveBeenCalledWith('/tmp/task-1', 'save');
    expect(discardUncommittedMock).toHaveBeenCalledWith('/tmp/task-2');
    expect(rebaseTaskMock).toHaveBeenCalledWith('/tmp/task-3');

    await vi.waitFor(() => {
      expect(getWorktreeStatusMock).toHaveBeenCalledWith('/tmp/task-1');
      expect(getWorktreeStatusMock).toHaveBeenCalledWith('/tmp/task-2');
      expect(getWorktreeStatusMock).toHaveBeenCalledWith('/tmp/task-3');
    });
  });

  it('stops task git watchers by task id', () => {
    stopTaskGitStatusWatcher('task-1');

    expect(stopGitWatcherMock).toHaveBeenCalledWith('task-1');
  });
});
