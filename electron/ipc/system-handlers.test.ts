import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import type { HandlerContext } from './handler-context.js';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from './runtime-diagnostics.js';

const { getActiveAgentIdsMock, loadAppStateForEnvMock } = vi.hoisted(() => ({
  getActiveAgentIdsMock: vi.fn(),
  loadAppStateForEnvMock: vi.fn(),
}));

vi.mock('./pty.js', async () => {
  const actual = await vi.importActual<typeof import('./pty.js')>('./pty.js');
  return {
    ...actual,
    getActiveAgentIds: getActiveAgentIdsMock,
  };
});

vi.mock('./storage.js', async () => {
  const actual = await vi.importActual<typeof import('./storage.js')>('./storage.js');
  return {
    ...actual,
    loadAppStateForEnv: loadAppStateForEnvMock,
  };
});

import { createSystemIpcHandlers } from './system-handlers.js';

let contextCounter = 0;

function buildContext(): HandlerContext {
  contextCounter += 1;
  return {
    userDataPath: `/tmp/parallel-code-tests-${contextCounter}`,
    isPackaged: false,
    sendToChannel: vi.fn(),
  };
}

function buildOptions(): {
  getTaskName: (taskId: string) => string;
  syncProjectBaseBranchesFromJson: (json: string) => void;
  syncTaskConvergenceFromJson: (json: string) => void;
  syncTaskNamesFromJson: (json: string) => void;
} {
  return {
    getTaskName: (taskId: string) => taskId,
    syncProjectBaseBranchesFromJson: vi.fn(),
    syncTaskConvergenceFromJson: vi.fn(),
    syncTaskNamesFromJson: vi.fn(),
  };
}

describe('system handlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-16T00:00:00Z'));
    vi.clearAllMocks();
    resetBackendRuntimeDiagnostics();
    loadAppStateForEnvMock.mockReturnValue(null);
    getActiveAgentIdsMock.mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('marks invalid paths false instead of failing the entire batch', () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    const validPath = process.cwd();

    const result = handlers[IPC.CheckPathsExist]?.({
      paths: [validPath, 'relative/path', '/tmp/../bad'],
    }) as Record<string, boolean>;

    expect(result).toEqual({
      [validPath]: true,
      'relative/path': false,
      '/tmp/../bad': false,
    });
  });

  it('dedupes reconnect snapshots within a short cache window', async () => {
    const options = buildOptions();
    const handlers = createSystemIpcHandlers(buildContext(), options);
    loadAppStateForEnvMock
      .mockReturnValueOnce('{"version":1}')
      .mockReturnValueOnce('{"version":2}');
    getActiveAgentIdsMock.mockReturnValueOnce(['agent-1']).mockReturnValueOnce(['agent-2']);

    const firstSnapshot = await handlers[IPC.GetBrowserReconnectSnapshot]?.();
    const secondSnapshot = await handlers[IPC.GetBrowserReconnectSnapshot]?.();

    expect(firstSnapshot).toEqual({
      appStateJson: '{"version":1}',
      runningAgentIds: ['agent-1'],
      taskCommandControllerVersion: 0,
      taskCommandControllers: [],
      workspaceRevision: 0,
      workspaceStateJson: '{"version":1}',
    });
    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(loadAppStateForEnvMock).toHaveBeenCalledTimes(1);
    expect(getActiveAgentIdsMock).toHaveBeenCalledTimes(1);
    expect(options.syncTaskNamesFromJson).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(201);

    const thirdSnapshot = await handlers[IPC.GetBrowserReconnectSnapshot]?.();

    expect(thirdSnapshot).toEqual({
      appStateJson: '{"version":2}',
      runningAgentIds: ['agent-2'],
      taskCommandControllerVersion: 0,
      taskCommandControllers: [],
      workspaceRevision: 0,
      workspaceStateJson: '{"version":2}',
    });
    expect(loadAppStateForEnvMock).toHaveBeenCalledTimes(2);
    expect(getActiveAgentIdsMock).toHaveBeenCalledTimes(2);
    expect(getBackendRuntimeDiagnosticsSnapshot().reconnectSnapshots).toMatchObject({
      cacheHits: 1,
      cacheMisses: 2,
    });
  });

  it('invalidates a cached reconnect snapshot when app state is saved', async () => {
    const options = buildOptions();
    const handlers = createSystemIpcHandlers(buildContext(), options);
    loadAppStateForEnvMock
      .mockReturnValueOnce('{"version":1}')
      .mockReturnValueOnce('{"version":2}');
    getActiveAgentIdsMock.mockReturnValueOnce(['agent-1']).mockReturnValueOnce(['agent-1']);

    const firstSnapshot = await handlers[IPC.GetBrowserReconnectSnapshot]?.();
    handlers[IPC.SaveAppState]?.({
      json: '{"version":2}',
      sourceId: 'tab-1',
    });
    const secondSnapshot = await handlers[IPC.GetBrowserReconnectSnapshot]?.();

    expect(firstSnapshot).toEqual({
      appStateJson: '{"version":1}',
      runningAgentIds: ['agent-1'],
      taskCommandControllerVersion: 0,
      taskCommandControllers: [],
      workspaceRevision: 0,
      workspaceStateJson: '{"version":1}',
    });
    expect(secondSnapshot).toEqual({
      appStateJson: '{"version":2}',
      runningAgentIds: ['agent-1'],
      taskCommandControllerVersion: 0,
      taskCommandControllers: [],
      workspaceRevision: 0,
      workspaceStateJson: '{"version":2}',
    });
    expect(loadAppStateForEnvMock).toHaveBeenCalledTimes(2);
    expect(options.syncTaskNamesFromJson).toHaveBeenNthCalledWith(1, '{"version":1}');
    expect(options.syncTaskNamesFromJson).toHaveBeenNthCalledWith(2, '{"version":2}');
    expect(options.syncTaskNamesFromJson).toHaveBeenNthCalledWith(3, '{"version":2}');
    expect(getBackendRuntimeDiagnosticsSnapshot().reconnectSnapshots).toMatchObject({
      cacheHits: 0,
      cacheInvalidations: 1,
      cacheMisses: 2,
    });
  });
});
