import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';

const { saveAppStateForEnvMock, loadAppStateForEnvMock, syncTaskGitWatchersMock } = vi.hoisted(
  () => ({
    saveAppStateForEnvMock: vi.fn(),
    loadAppStateForEnvMock: vi.fn(),
    syncTaskGitWatchersMock: vi.fn(),
  }),
);

vi.mock('./storage.js', async () => {
  const actual = await vi.importActual<typeof import('./storage.js')>('./storage.js');
  return {
    ...actual,
    saveAppStateForEnv: saveAppStateForEnvMock,
    loadAppStateForEnv: loadAppStateForEnvMock,
  };
});

vi.mock('./git-watcher.js', async () => {
  const actual = await vi.importActual<typeof import('./git-watcher.js')>('./git-watcher.js');
  return {
    ...actual,
    syncTaskGitWatchers: syncTaskGitWatchersMock,
    startGitWatcher: vi.fn(),
    stopGitWatcher: vi.fn(),
  };
});

import { createIpcHandlers, type HandlerContext } from './handlers.js';

function buildContext(): HandlerContext {
  return {
    userDataPath: '/tmp/parallel-code-tests',
    isPackaged: false,
    sendToChannel: vi.fn(),
    onGitChange: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  saveAppStateForEnvMock.mockReturnValue(undefined);
  loadAppStateForEnvMock.mockReturnValue(null);
});

describe('persisted git watcher sync', () => {
  it('syncs task watchers from saved app state', () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);
    const json = JSON.stringify({
      tasks: {
        'task-1': { id: 'task-1', name: 'One', worktreePath: '/tmp/worktree-one' },
        'task-2': { id: 'task-2', name: 'Two', worktreePath: 'relative/path' },
      },
    });

    handlers[IPC.SaveAppState]?.({ json, sourceId: 'source-1' });

    expect(syncTaskGitWatchersMock).toHaveBeenCalledWith(
      [{ taskId: 'task-1', worktreePath: '/tmp/worktree-one' }],
      context.onGitChange,
    );
    expect(saveAppStateForEnvMock).toHaveBeenCalledWith(context, json);
  });

  it('rebuilds watcher coverage when loading state', () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);
    const json = JSON.stringify({
      tasks: {
        'task-1': { id: 'task-1', name: 'One', worktreePath: '/tmp/worktree-one' },
        'task-2': { id: 'task-2', name: 'Two', worktreePath: '/tmp/worktree-two' },
      },
    });
    loadAppStateForEnvMock.mockReturnValue(json);

    const result = handlers[IPC.LoadAppState]?.();

    expect(result).toBe(json);
    expect(syncTaskGitWatchersMock).toHaveBeenCalledWith(
      [
        { taskId: 'task-1', worktreePath: '/tmp/worktree-one' },
        { taskId: 'task-2', worktreePath: '/tmp/worktree-two' },
      ],
      context.onGitChange,
    );
  });

  it('clears task watchers when no saved state exists', () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    handlers[IPC.LoadAppState]?.();

    expect(syncTaskGitWatchersMock).toHaveBeenCalledWith([], context.onGitChange);
  });
});
