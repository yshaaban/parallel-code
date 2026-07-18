import { beforeEach, describe, expect, it, vi } from 'vitest';

const ptyMocks = vi.hoisted(() => ({
  pauseAgent: vi.fn(),
  resizeAgent: vi.fn(),
  resumeAgent: vi.fn(),
  writeToAgent: vi.fn(),
}));
const stopTaskAgentWorkflowMock = vi.hoisted(() => vi.fn<(agentId: string) => Promise<void>>());

vi.mock('../electron/ipc/pty.js', () => ptyMocks);
vi.mock('../electron/ipc/task-workflows.js', () => ({
  stopTaskAgentWorkflow: stopTaskAgentWorkflowMock,
}));

import {
  killBrowserAgent,
  pauseBrowserAgent,
  resizeBrowserAgent,
  resumeBrowserAgent,
  writeBrowserAgentInput,
  writeBrowserAgentPermissionResponse,
} from './browser-agent-command-executor.js';

describe('browser agent command executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopTaskAgentWorkflowMock.mockResolvedValue(undefined);
  });

  it('forwards terminal input, resize, pause, resume, and kill to their backend owners', async () => {
    const traceRequest = {
      clientId: 'client-1',
      requestId: 'request-1',
      taskId: 'task-1',
      trace: {
        bufferedAtMs: 2,
        inputChars: 3,
        inputKind: 'interactive',
        sendStartedAtMs: 4,
        startedAtMs: 1,
      },
    } as const;

    writeBrowserAgentInput('agent-1', 'pwd\n', traceRequest);
    resizeBrowserAgent('agent-1', 120, 32);
    pauseBrowserAgent('agent-1', 'flow-control', 'channel-1');
    resumeBrowserAgent('agent-1', 'restore', 'channel-2');
    await killBrowserAgent('agent-1');

    expect(ptyMocks.writeToAgent).toHaveBeenCalledWith('agent-1', 'pwd\n', traceRequest, undefined);
    expect(ptyMocks.resizeAgent).toHaveBeenCalledWith('agent-1', 120, 32, undefined);
    expect(ptyMocks.pauseAgent).toHaveBeenCalledWith(
      'agent-1',
      'flow-control',
      'channel-1',
      undefined,
    );
    expect(ptyMocks.resumeAgent).toHaveBeenCalledWith('agent-1', 'restore', 'channel-2', undefined);
    expect(stopTaskAgentWorkflowMock).toHaveBeenCalledWith('agent-1');
  });

  it('propagates asynchronous stop failures to the websocket command runner', async () => {
    const failure = new Error('runner cleanup failed');
    stopTaskAgentWorkflowMock.mockRejectedValueOnce(failure);

    await expect(killBrowserAgent('agent-1')).rejects.toBe(failure);
  });

  it('forwards restore pause lease ids to the PTY owner', () => {
    pauseBrowserAgent('agent-1', 'restore', 'channel-1', 'restore-lease-1');
    resumeBrowserAgent('agent-1', 'restore', 'channel-1', 'restore-lease-1');

    expect(ptyMocks.pauseAgent).toHaveBeenCalledWith(
      'agent-1',
      'restore',
      'channel-1',
      'restore-lease-1',
    );
    expect(ptyMocks.resumeAgent).toHaveBeenCalledWith(
      'agent-1',
      'restore',
      'channel-1',
      'restore-lease-1',
    );
  });

  it('maps permission responses to the existing PTY input protocol', () => {
    writeBrowserAgentPermissionResponse('agent-1', 'approve');
    writeBrowserAgentPermissionResponse('agent-2', 'deny');

    expect(ptyMocks.writeToAgent).toHaveBeenCalledWith('agent-1', 'y\n', undefined, undefined);
    expect(ptyMocks.writeToAgent).toHaveBeenCalledWith('agent-2', 'n\n', undefined, undefined);
  });
});
