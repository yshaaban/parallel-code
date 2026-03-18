import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientMessage,
  TaskCommandTakeoverResultMessage,
} from '../../electron/remote/protocol';

const mockState = vi.hoisted(() => {
  const controllerListeners = new Set<
    (payload: { controllerId: string | null; taskId: string }) => void
  >();
  const connectionListeners = new Set<
    (status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting') => void
  >();
  const takeoverListeners = new Set<(message: TaskCommandTakeoverResultMessage) => void>();
  return {
    acquireRemoteTaskCommandLeaseMock: vi.fn(),
    applyRemoteTaskCommandControllerChangedMock: vi.fn(
      (snapshot: { controllerId: string | null; taskId: string }) => {
        mockState.currentControllerId = snapshot.controllerId;
        mockState.currentControllerOwnerStatus =
          snapshot.controllerId === 'remote-client-1234'
            ? {
                action: 'type in the terminal',
                controllerId: 'remote-client-1234',
                isSelf: true,
                label: 'You typing',
              }
            : snapshot.controllerId
              ? {
                  action: 'type in the terminal',
                  controllerId: snapshot.controllerId,
                  isSelf: false,
                  label: 'Ivan typing',
                }
              : null;
        for (const listener of controllerListeners) {
          listener({ controllerId: snapshot.controllerId, taskId: snapshot.taskId });
        }
      },
    ),
    clearIncomingRemoteTakeoverRequestsMock: vi.fn(),
    connectionListeners,
    connectionStatus: 'connected' as 'connected' | 'connecting' | 'disconnected' | 'reconnecting',
    controllerListeners,
    currentControllerId: null as string | null,
    currentControllerOwnerStatus: null as {
      action: string;
      controllerId: string;
      isSelf: boolean;
      label: string;
    } | null,
    releaseRemoteTaskCommandLeaseMock: vi.fn(),
    renewRemoteTaskCommandLeaseMock: vi.fn(),
    resizeRemoteAgentMock: vi.fn(),
    sendMock: vi.fn((message: ClientMessage) => {
      if (message.type === 'request-task-command-takeover') {
        queueMicrotask(() => {
          for (const listener of takeoverListeners) {
            listener({
              type: 'task-command-takeover-result',
              decision: 'approved',
              requestId: message.requestId,
              taskId: message.taskId,
            });
          }
        });
      }
      return true;
    }),
    sendWhenConnectedMock: vi.fn(async (message: ClientMessage) => mockState.sendMock(message)),
    takeoverListeners,
    writeRemoteAgentMock: vi.fn(),
  };
});

vi.mock('./client-id', () => ({
  getRemoteClientId: vi.fn(() => 'remote-client-1234'),
}));

vi.mock('./remote-ipc', () => ({
  acquireRemoteTaskCommandLease: mockState.acquireRemoteTaskCommandLeaseMock,
  releaseRemoteTaskCommandLease: mockState.releaseRemoteTaskCommandLeaseMock,
  renewRemoteTaskCommandLease: mockState.renewRemoteTaskCommandLeaseMock,
  resizeRemoteAgent: mockState.resizeRemoteAgentMock,
  writeRemoteAgent: mockState.writeRemoteAgentMock,
}));

vi.mock('./remote-collaboration', () => ({
  applyRemoteTaskCommandControllerChanged: mockState.applyRemoteTaskCommandControllerChangedMock,
  clearIncomingRemoteTakeoverRequests: mockState.clearIncomingRemoteTakeoverRequestsMock,
  getRemoteTaskCommandController: vi.fn(() => {
    if (!mockState.currentControllerId) {
      return null;
    }

    return {
      action: 'type in the terminal',
      controllerId: mockState.currentControllerId,
      taskId: 'task-1',
      version: 1,
    };
  }),
  getRemoteTaskControllerOwnerStatus: vi.fn(() => mockState.currentControllerOwnerStatus),
  subscribeRemoteTaskCommandControllerChanges: vi.fn((listener) => {
    mockState.controllerListeners.add(listener);
    return () => {
      mockState.controllerListeners.delete(listener);
    };
  }),
  subscribeRemoteTaskCommandTakeoverResults: vi.fn((listener) => {
    mockState.takeoverListeners.add(listener);
    return () => {
      mockState.takeoverListeners.delete(listener);
    };
  }),
}));

vi.mock('./ws', () => ({
  sendWhenConnected: mockState.sendWhenConnectedMock,
  subscribeRemoteConnectionStatus: vi.fn(
    (listener: (status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting') => void) => {
      mockState.connectionListeners.add(listener);
      listener(mockState.connectionStatus);
      return () => {
        mockState.connectionListeners.delete(listener);
      };
    },
  ),
}));

import {
  releaseRemoteTaskCommand,
  requestRemoteTaskTakeover,
  resetRemoteTaskCommandStateForTests,
  respondToRemoteTaskCommandTakeover,
  sendRemoteAgentInput,
} from './remote-task-command';

function emitConnectionStatus(
  nextStatus: 'connected' | 'connecting' | 'disconnected' | 'reconnecting',
): void {
  mockState.connectionStatus = nextStatus;
  for (const listener of mockState.connectionListeners) {
    listener(nextStatus);
  }
}

describe('remote task command control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRemoteTaskCommandStateForTests();
    mockState.connectionStatus = 'connected';
    mockState.currentControllerId = null;
    mockState.currentControllerOwnerStatus = null;
    mockState.acquireRemoteTaskCommandLeaseMock.mockResolvedValue({
      acquired: true,
      action: 'type in the terminal',
      controllerId: 'remote-client-1234',
      taskId: 'task-1',
      version: 2,
    });
    mockState.releaseRemoteTaskCommandLeaseMock.mockResolvedValue({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: 3,
    });
    mockState.renewRemoteTaskCommandLeaseMock.mockResolvedValue({
      renewed: true,
      action: 'type in the terminal',
      controllerId: 'remote-client-1234',
      taskId: 'task-1',
      version: 3,
    });
    mockState.writeRemoteAgentMock.mockResolvedValue(undefined);
    mockState.sendWhenConnectedMock.mockImplementation(async (message: ClientMessage) =>
      mockState.sendMock(message),
    );
  });

  afterEach(() => {
    resetRemoteTaskCommandStateForTests();
  });

  it('acquires a lease before sending remote terminal input', async () => {
    const sent = await sendRemoteAgentInput('agent-1', 'task-1', 'pwd\r');

    expect(sent).toBe(true);
    expect(mockState.acquireRemoteTaskCommandLeaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'type in the terminal',
        taskId: 'task-1',
      }),
    );
    expect(mockState.applyRemoteTaskCommandControllerChangedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        controllerId: 'remote-client-1234',
        taskId: 'task-1',
        version: 2,
      }),
    );
    expect(mockState.writeRemoteAgentMock).toHaveBeenCalledWith({
      agentId: 'agent-1',
      data: 'pwd\r',
      taskId: 'task-1',
    });
  });

  it('allows terminal input while the remote transport is still connecting', async () => {
    emitConnectionStatus('connecting');

    await expect(sendRemoteAgentInput('agent-1', 'task-1', 'pwd\r')).resolves.toBe(true);
    expect(mockState.acquireRemoteTaskCommandLeaseMock).toHaveBeenCalledTimes(1);
    expect(mockState.writeRemoteAgentMock).toHaveBeenCalledTimes(1);
  });

  it('blocks writes while another session controls the task', async () => {
    mockState.currentControllerOwnerStatus = {
      action: 'type in the terminal',
      controllerId: 'peer-1',
      isSelf: false,
      label: 'Ivan typing',
    };

    await expect(sendRemoteAgentInput('agent-1', 'task-1', 'pwd\r')).resolves.toBe(false);
    expect(mockState.acquireRemoteTaskCommandLeaseMock).not.toHaveBeenCalled();
    expect(mockState.writeRemoteAgentMock).not.toHaveBeenCalled();
  });

  it('does not block writes when only presence-backed ownership cues exist', async () => {
    const sent = await sendRemoteAgentInput('agent-1', 'task-1', 'pwd\r');

    expect(sent).toBe(true);
    expect(mockState.acquireRemoteTaskCommandLeaseMock).toHaveBeenCalledTimes(1);
  });

  it('supports remote takeover approval through the websocket control plane', async () => {
    mockState.currentControllerOwnerStatus = {
      action: 'type in the terminal',
      controllerId: 'peer-1',
      isSelf: false,
      label: 'Ivan typing',
    };

    await expect(requestRemoteTaskTakeover('task-1')).resolves.toBe('acquired');
    expect(mockState.sendWhenConnectedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'request-task-command-takeover',
        taskId: 'task-1',
        targetControllerId: 'peer-1',
      }),
    );
    expect(mockState.acquireRemoteTaskCommandLeaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        takeover: true,
        taskId: 'task-1',
      }),
    );
  });

  it('waits for reconnect before sending takeover responses', async () => {
    await expect(respondToRemoteTaskCommandTakeover('request-1', true)).resolves.toBe(true);
    expect(mockState.sendWhenConnectedMock).toHaveBeenCalledWith({
      approved: true,
      requestId: 'request-1',
      type: 'respond-task-command-takeover',
    });
  });

  it('returns false when the remote write fails instead of rejecting the detail view caller', async () => {
    mockState.writeRemoteAgentMock.mockRejectedValueOnce(new Error('write failed'));

    await expect(sendRemoteAgentInput('agent-1', 'task-1', 'pwd\r')).resolves.toBe(false);
  });

  it('invalidates retained leases and pending takeovers on transport loss', async () => {
    const firstSend = await sendRemoteAgentInput('agent-1', 'task-1', 'pwd\r');
    expect(firstSend).toBe(true);

    mockState.currentControllerOwnerStatus = {
      action: 'type in the terminal',
      controllerId: 'peer-1',
      isSelf: false,
      label: 'Ivan typing',
    };
    mockState.sendWhenConnectedMock.mockResolvedValueOnce(true);
    const takeoverPromise = requestRemoteTaskTakeover('task-1');

    emitConnectionStatus('reconnecting');

    await expect(takeoverPromise).resolves.toBe('transport-unavailable');
    await expect(sendRemoteAgentInput('agent-1', 'task-1', 'next\r')).resolves.toBe(false);
    expect(mockState.clearIncomingRemoteTakeoverRequestsMock).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued send before lease acquisition starts', async () => {
    const sendPromise = sendRemoteAgentInput('agent-1', 'task-1', 'pwd\r');
    await releaseRemoteTaskCommand('task-1');

    await expect(sendPromise).resolves.toBe(false);
    expect(mockState.acquireRemoteTaskCommandLeaseMock).not.toHaveBeenCalled();
    expect(mockState.writeRemoteAgentMock).not.toHaveBeenCalled();
  });
});
