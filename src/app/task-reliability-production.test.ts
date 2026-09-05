import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../electron/ipc/channels.js';
import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../domain/agent-session-operation.js';
import {
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  deriveTaskInitialPromptDraftFingerprint,
} from '../domain/task-initial-prompt-delivery.js';
import { TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION } from '../domain/task-reliability-runtime.js';

const { invokeMock, invokeWithAbortSignalMock, listenRendererEventMock, stopListeningMock } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    invokeWithAbortSignalMock: vi.fn(),
    listenRendererEventMock: vi.fn(),
    stopListeningMock: vi.fn(),
  }));

vi.mock('../lib/ipc.js', () => ({
  invoke: invokeMock,
  invokeWithAbortSignal: invokeWithAbortSignalMock,
}));
vi.mock('../lib/ipc-events.js', () => ({
  listenRendererEvent: listenRendererEventMock,
}));

import { createProductionTaskReliabilityClient } from './task-reliability-production.js';

const capabilities = {
  agentSessions: {
    automaticResumeFallback: false,
    hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
    initialLaunch: true,
    manualReplacement: true,
  },
  contractVersion: TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION,
  cutoverEpoch: 'cutover-1',
  initialPromptDelivery: {
    enabled: true as const,
    hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  },
  kind: 'active' as const,
  serverInstanceId: 'server-1',
};

const draftText = 'Ship it';
const projection = {
  current: {
    catalogVersion: 1,
    serverInstanceId: 'server-1',
    taskClosing: false,
    taskState: 'present' as const,
  },
  currentDraft: {
    editRevision: 0,
    fingerprint: deriveTaskInitialPromptDraftFingerprint({
      agentId: 'agent-1',
      readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
      taskId: 'task-1',
      text: draftText,
    }),
    mode: 'automatic' as const,
    text: draftText,
    workspaceRevision: 1,
  },
  delivery: {
    agentId: 'agent-1',
    attempts: 0 as const,
    createdAt: '2026-08-04T00:00:00.000Z',
    deliveryId: 'delivery-1',
    status: 'waiting-ready' as const,
    targetGeneration: 1,
    taskId: 'task-1',
    updatedAt: '2026-08-04T00:00:01.000Z',
    version: 2,
  },
};

describe('production task reliability facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenRendererEventMock.mockReturnValue(stopListeningMock);
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.GetTaskReliabilityCapabilities) return capabilities;
      throw new Error(`Unexpected unabortable channel ${channel}`);
    });
    invokeWithAbortSignalMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.GetTaskReliabilityCapabilities) return capabilities;
      if (channel === IPC.GetInitialPromptDeliveryProjection) return projection;
      throw new Error(`Unexpected abortable channel ${channel}`);
    });
  });

  it('uses the shared host-selecting invoke and event facades', async () => {
    const client = createProductionTaskReliabilityClient();
    await expect(client.refreshCapabilities()).resolves.toEqual(capabilities);
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetTaskReliabilityCapabilities);
    expect(listenRendererEventMock).toHaveBeenCalledWith(
      IPC.TaskReliabilityChanged,
      expect.any(Function),
    );

    const abort = new AbortController();
    await expect(
      client.initialPromptDelivery.getProjection({ deliveryId: 'delivery-1' }, abort.signal),
    ).resolves.toEqual(projection);
    expect(invokeWithAbortSignalMock).toHaveBeenCalledWith(
      IPC.GetInitialPromptDeliveryProjection,
      abort.signal,
      { deliveryId: 'delivery-1' },
    );

    client.dispose();
    expect(stopListeningMock).toHaveBeenCalledOnce();
  });

  it('does not miss an abort that races retry-listener installation', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const signal = {
      addEventListener: vi.fn(() => {
        aborted = true;
      }),
      get aborted() {
        return aborted;
      },
      get reason() {
        return new DOMException('Aborted', 'AbortError');
      },
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    invokeWithAbortSignalMock.mockRejectedValue(new Error('No handler registered for channel'));
    const client = createProductionTaskReliabilityClient();

    await expect(client.refreshCapabilities(signal)).resolves.toMatchObject({ kind: 'dark' });
    expect(signal.addEventListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    client.dispose();
    vi.useRealTimers();
  });
});
