import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import type { HandlerContext } from './handler-context.js';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from './runtime-diagnostics.js';

const {
  inspectArenaCompetitorMock,
  getActiveAgentIdsMock,
  getAgentMetaMock,
  loadAppStateForEnvMock,
} = vi.hoisted(() => ({
  inspectArenaCompetitorMock: vi.fn(),
  getActiveAgentIdsMock: vi.fn(),
  getAgentMetaMock: vi.fn(),
  loadAppStateForEnvMock: vi.fn(),
}));

vi.mock('./pty.js', async () => {
  const actual = await vi.importActual<typeof import('./pty.js')>('./pty.js');
  return {
    ...actual,
    getActiveAgentIds: getActiveAgentIdsMock,
    getAgentMeta: getAgentMetaMock,
  };
});

vi.mock('./storage.js', async () => {
  const actual = await vi.importActual<typeof import('./storage.js')>('./storage.js');
  return {
    ...actual,
    loadAppStateForEnv: loadAppStateForEnvMock,
  };
});

vi.mock('./arena-competitors.js', () => ({
  inspectArenaCompetitor: inspectArenaCompetitorMock,
}));

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
    inspectArenaCompetitorMock.mockReset();
    getActiveAgentIdsMock.mockReturnValue([]);
    getAgentMetaMock.mockReturnValue({ generation: 0 });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('returns null for clipboard-image paste when clipboard runtime support is unavailable', async () => {
    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());

    await expect(handlers[IPC.SaveClipboardImage]?.()).resolves.toBeNull();
  });

  it('returns a saved clipboard-image path when clipboard runtime support is available', async () => {
    const saveClipboardImage = vi.fn(async () => '/tmp/parallel-code-clipboard.png');
    const handlers = createSystemIpcHandlers(
      {
        ...buildContext(),
        clipboard: { saveClipboardImage },
      },
      buildOptions(),
    );

    await expect(handlers[IPC.SaveClipboardImage]?.()).resolves.toBe(
      '/tmp/parallel-code-clipboard.png',
    );
    expect(saveClipboardImage).toHaveBeenCalledTimes(1);
  });

  it('reads markdown files through the worktree-scoped handler', () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-md-'));
    const markdownPath = path.join(worktreePath, 'docs', 'guide.md');
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(markdownPath, '# Guide\n');

    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    const result = handlers[IPC.ReadMarkdownFile]?.({
      relativePath: 'docs/guide.md',
      worktreePath,
    });

    expect(result).toEqual({
      content: '# Guide\n',
      fileName: 'guide.md',
      relativePath: 'docs/guide.md',
    });
  });

  it('forwards arena competitor inspection through the typed backend seam', async () => {
    inspectArenaCompetitorMock.mockResolvedValue({
      executable: 'claude',
      issues: [],
      status: 'ready',
    });

    const handlers = createSystemIpcHandlers(buildContext(), buildOptions());
    const result = await handlers[IPC.InspectArenaCompetitor]?.({
      commandTemplate: 'claude -p "{prompt}" --dangerously-skip-permissions',
    });

    expect(inspectArenaCompetitorMock).toHaveBeenCalledWith(
      'claude -p "{prompt}" --dangerously-skip-permissions',
    );
    expect(result).toEqual({
      executable: 'claude',
      issues: [],
      status: 'ready',
    });
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
      agentGenerations: { 'agent-1': 0 },
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
      agentGenerations: { 'agent-2': 0 },
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

  it('returns a lightweight cold bootstrap snapshot with server-state categories', async () => {
    loadAppStateForEnvMock.mockReturnValue('{"version":1,"projects":[],"taskOrder":[],"tasks":{}}');
    const handlers = createSystemIpcHandlers(
      {
        ...buildContext(),
        remoteAccess: {
          status: () => ({
            connectedClients: 0,
            enabled: false,
            peerClients: 0,
            port: 7777,
            tailscaleUrl: null,
            token: null,
            url: null,
            wifiUrl: null,
          }),
        } as HandlerContext['remoteAccess'],
      },
      buildOptions(),
    );

    const snapshot = await handlers[IPC.GetBrowserColdBootstrap]?.();

    expect(snapshot).toMatchObject({
      workspaceRevision: 0,
      workspaceStateJson: '{"version":1,"projects":[],"taskOrder":[],"tasks":{}}',
    });
    expect(snapshot).toEqual(
      expect.objectContaining({
        serverStateBootstrap: expect.arrayContaining([
          expect.objectContaining({
            category: 'remote-status',
            payload: expect.objectContaining({
              enabled: false,
            }),
          }),
          expect.objectContaining({
            category: 'task-command-controller',
            payload: [],
          }),
        ]),
      }),
    );
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
      agentGenerations: { 'agent-1': 0 },
      appStateJson: '{"version":1}',
      runningAgentIds: ['agent-1'],
      taskCommandControllerVersion: 0,
      taskCommandControllers: [],
      workspaceRevision: 0,
      workspaceStateJson: '{"version":1}',
    });
    expect(secondSnapshot).toEqual({
      agentGenerations: { 'agent-1': 0 },
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
