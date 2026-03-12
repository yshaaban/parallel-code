import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../electron/ipc/channels.js';

const watcherCallbacks = vi.hoisted(() => [] as Array<() => void>);
const startGitWatcherMock = vi.hoisted(() =>
  vi.fn((_taskId: string, _worktreePath: string, callback: () => void) => {
    watcherCallbacks.push(callback);
  }),
);
const loadGitStatusChangedPayloadMock = vi.hoisted(() => vi.fn());

vi.mock('../electron/ipc/git-watcher.js', () => ({
  startGitWatcher: startGitWatcherMock,
}));

vi.mock('../electron/ipc/git-status-workflows.js', () => ({
  loadGitStatusChangedPayload: loadGitStatusChangedPayloadMock,
}));

import { startSavedTaskGitWatchers } from './browser-ipc.js';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('startSavedTaskGitWatchers', () => {
  beforeEach(() => {
    watcherCallbacks.length = 0;
    startGitWatcherMock.mockReset();
    loadGitStatusChangedPayloadMock.mockReset();
  });

  it('uses emitIpcEvent without duplicating typed git-status broadcasts', async () => {
    const status = {
      has_committed_changes: false,
      has_uncommitted_changes: true,
    };
    const broadcastControl = vi.fn();
    const emitIpcEvent = vi.fn();
    loadGitStatusChangedPayloadMock.mockResolvedValue({
      worktreePath: '/tmp/task-1',
      status,
    });

    startSavedTaskGitWatchers({
      broadcastControl,
      emitIpcEvent,
      savedJson: JSON.stringify({
        tasks: {
          one: { id: 'task-1', worktreePath: '/tmp/task-1' },
        },
      }),
    });

    expect(startGitWatcherMock).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(emitIpcEvent).toHaveBeenCalledWith(IPC.GitStatusChanged, {
      worktreePath: '/tmp/task-1',
      status,
    });

    emitIpcEvent.mockClear();
    watcherCallbacks[0]?.();
    await flushMicrotasks();

    expect(emitIpcEvent).toHaveBeenCalledWith(IPC.GitStatusChanged, {
      worktreePath: '/tmp/task-1',
      status,
    });
    expect(broadcastControl).not.toHaveBeenCalled();
  });

  it('falls back to typed broadcasts when no IPC event emitter is provided', async () => {
    const status = {
      has_committed_changes: true,
      has_uncommitted_changes: false,
    };
    const broadcastControl = vi.fn();
    loadGitStatusChangedPayloadMock.mockResolvedValue({
      worktreePath: '/tmp/task-2',
      status,
    });

    startSavedTaskGitWatchers({
      broadcastControl,
      savedJson: JSON.stringify({
        tasks: {
          two: { id: 'task-2', worktreePath: '/tmp/task-2' },
        },
      }),
    });

    await flushMicrotasks();
    expect(broadcastControl).toHaveBeenCalledWith({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-2',
      status,
    });

    broadcastControl.mockClear();
    watcherCallbacks[0]?.();
    await flushMicrotasks();

    expect(broadcastControl).toHaveBeenCalledWith({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-2',
      status,
    });
  });
});
