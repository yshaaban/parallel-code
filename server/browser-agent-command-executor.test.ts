import { describe, expect, it, vi } from 'vitest';

const ptyMocks = vi.hoisted(() => ({
  killAgent: vi.fn(),
  pauseAgent: vi.fn(),
  resizeAgent: vi.fn(),
  resumeAgent: vi.fn(),
  writeToAgent: vi.fn(),
}));

vi.mock('../electron/ipc/pty.js', () => ptyMocks);

import {
  killBrowserAgent,
  pauseBrowserAgent,
  resizeBrowserAgent,
  resumeBrowserAgent,
  writeBrowserAgentInput,
  writeBrowserAgentPermissionResponse,
} from './browser-agent-command-executor.js';

describe('browser agent command executor', () => {
  it('forwards terminal input, resize, pause, resume, and kill to the PTY owner', () => {
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
    killBrowserAgent('agent-1');

    expect(ptyMocks.writeToAgent).toHaveBeenCalledWith('agent-1', 'pwd\n', traceRequest);
    expect(ptyMocks.resizeAgent).toHaveBeenCalledWith('agent-1', 120, 32);
    expect(ptyMocks.pauseAgent).toHaveBeenCalledWith('agent-1', 'flow-control', 'channel-1');
    expect(ptyMocks.resumeAgent).toHaveBeenCalledWith('agent-1', 'restore', 'channel-2');
    expect(ptyMocks.killAgent).toHaveBeenCalledWith('agent-1');
  });

  it('maps permission responses to the existing PTY input protocol', () => {
    writeBrowserAgentPermissionResponse('agent-1', 'approve');
    writeBrowserAgentPermissionResponse('agent-2', 'deny');

    expect(ptyMocks.writeToAgent).toHaveBeenCalledWith('agent-1', 'y\n', undefined);
    expect(ptyMocks.writeToAgent).toHaveBeenCalledWith('agent-2', 'n\n', undefined);
  });
});
