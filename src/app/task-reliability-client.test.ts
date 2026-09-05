import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_SESSION_OWNER_HOOK_SET_VERSION,
  type RendererAgentSessionOperationRequest,
} from '../domain/agent-session-operation.js';
import {
  deriveManualInitialPromptSendOperationId,
  deriveTaskInitialPromptDraftFingerprint,
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  type SendTaskInitialPromptManuallyRequest,
  type TaskInitialPromptDeliveryProjection,
} from '../domain/task-initial-prompt-delivery.js';
import { TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION } from '../domain/task-reliability-runtime.js';
import {
  createTaskReliabilityClient,
  TaskReliabilityCapabilityError,
  type TaskReliabilityRawTransport,
} from './task-reliability-client.js';

const promptText = 'Ship it';
const fingerprint = deriveTaskInitialPromptDraftFingerprint({
  agentId: 'agent-1',
  readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
  taskId: 'task-1',
  text: promptText,
});

function capabilities(promptEnabled = true) {
  return {
    agentSessions: {
      automaticResumeFallback: false,
      hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
      initialLaunch: true,
      manualReplacement: true,
    },
    contractVersion: TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION,
    cutoverEpoch: 'cutover-1',
    initialPromptDelivery: promptEnabled
      ? { enabled: true as const, hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION }
      : { enabled: false as const },
    kind: 'active' as const,
    serverInstanceId: 'server-1',
  };
}

function current() {
  return {
    catalogVersion: 2,
    serverInstanceId: 'server-1',
    taskClosing: false,
    taskState: 'present' as const,
  };
}

function sessionRequest(): RendererAgentSessionOperationRequest {
  return {
    admission: { kind: 'task-command' },
    agentId: 'agent-1',
    controllerId: 'controller-1',
    expectedLeaseGeneration: 3,
    expectedSourceGeneration: 7,
    launchReason: 'manual-restart',
    mode: 'fresh',
    operationId: 'operation-1',
    taskId: 'task-1',
  };
}

function sessionProjection() {
  return {
    current: current(),
    operation: {
      agentId: 'agent-1',
      launchReason: 'manual-restart' as const,
      operationId: 'operation-1',
      phase: 'running' as const,
      resumed: false,
      sourceGeneration: 7,
      targetGeneration: 8,
      taskId: 'task-1',
      version: 4,
    },
  };
}

function promptProjection(): TaskInitialPromptDeliveryProjection {
  return {
    current: current(),
    currentDraft: {
      editRevision: 0,
      fingerprint,
      mode: 'automatic',
      text: promptText,
      workspaceRevision: 5,
    },
    delivery: {
      agentId: 'agent-1',
      attempts: 0,
      createdAt: '2026-08-04T00:00:00.000Z',
      deliveryId: 'delivery-1',
      status: 'waiting-ready',
      taskId: 'task-1',
      targetGeneration: 7,
      updatedAt: '2026-08-04T00:00:01.000Z',
      version: 2,
    },
  };
}

function manualSendRequest(): SendTaskInitialPromptManuallyRequest {
  return {
    action: { kind: 'send' },
    agentId: 'agent-1',
    confirmPossiblePriorAutomaticWrite: false,
    deliveryId: 'delivery-1',
    expectedAgentGeneration: 7,
    expectedDraftFingerprint: fingerprint,
    expectedEditRevision: 0,
    manualSendOperationId: deriveManualInitialPromptSendOperationId({
      acknowledgedDraftFingerprint: fingerprint,
      acknowledgedEditRevision: 0,
      deliveryId: 'delivery-1',
    }),
    taskId: 'task-1',
  };
}

function createRawTransport() {
  let liveListener: ((event: unknown) => void) | null = null;
  const transport = {
    agentSessions: {
      execute: vi.fn(),
      getProjection: vi.fn(),
    },
    capabilities: {
      read: vi.fn(),
    },
    initialPromptDelivery: {
      getProjection: vi.fn(),
      resolveAmbiguity: vi.fn(),
      reviseDraft: vi.fn(),
      sendManually: vi.fn(),
    },
    liveEvents: {
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        liveListener = listener;
        return vi.fn(() => {
          liveListener = null;
        });
      }),
    },
  } satisfies TaskReliabilityRawTransport;
  return {
    emit(event: unknown) {
      liveListener?.(event);
    },
    transport,
  };
}

describe('task reliability renderer client', () => {
  it('keeps caller-local capability cancellation from darkening shared consumers', async () => {
    const raw = createRawTransport();
    const protocolErrors: Error[] = [];
    const client = createTaskReliabilityClient(raw.transport, {
      onProtocolError: (error) => protocolErrors.push(error),
    });
    raw.transport.capabilities.read.mockResolvedValueOnce(capabilities());
    await client.refreshCapabilities();

    let resolveFirst!: (value: unknown) => void;
    raw.transport.capabilities.read
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      );

    const stillMountedRefresh = client.refreshCapabilities();
    const unmounted = new AbortController();
    const unmountedRefresh = client.refreshCapabilities(unmounted.signal);
    unmounted.abort();

    await expect(unmountedRefresh).resolves.toMatchObject({ kind: 'active' });
    expect(client.getCapabilities()).toMatchObject({
      cutoverEpoch: 'cutover-1',
      kind: 'active',
    });
    expect(protocolErrors).toEqual([]);

    resolveFirst(capabilities());
    await expect(stillMountedRefresh).resolves.toMatchObject({ kind: 'active' });
    expect(client.getCapabilities()).toMatchObject({ kind: 'active' });
  });

  it('does not commit a transport response that resolved after caller cancellation', async () => {
    const raw = createRawTransport();
    const client = createTaskReliabilityClient(raw.transport);
    raw.transport.capabilities.read.mockResolvedValueOnce(capabilities());
    await client.refreshCapabilities();

    const cancelled = new AbortController();
    raw.transport.capabilities.read.mockImplementationOnce(async () => ({
      ...capabilities(),
      cutoverEpoch: 'cancelled-cutover',
    }));
    cancelled.abort();
    await expect(client.refreshCapabilities(cancelled.signal)).resolves.toMatchObject({
      cutoverEpoch: 'cutover-1',
      kind: 'active',
    });
    expect(client.getCapabilities()).toMatchObject({ cutoverEpoch: 'cutover-1' });
  });

  it('fences an in-flight capability response after live invalidation', async () => {
    const raw = createRawTransport();
    const client = createTaskReliabilityClient(raw.transport);
    raw.transport.capabilities.read.mockResolvedValueOnce(capabilities());
    await client.refreshCapabilities();

    let resolveStale!: (value: unknown) => void;
    raw.transport.capabilities.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    );
    const staleRefresh = client.refreshCapabilities();
    raw.emit({
      kind: 'task-reliability-capabilities-invalidated',
      serverInstanceId: 'server-1',
    });
    expect(client.getCapabilities()).toMatchObject({ kind: 'dark' });

    resolveStale(capabilities());
    await expect(staleRefresh).resolves.toMatchObject({ kind: 'dark' });
    expect(client.getCapabilities()).toMatchObject({ kind: 'dark' });
  });

  it('starts dark without subscribing or invoking any effect transport', async () => {
    const raw = createRawTransport();
    const client = createTaskReliabilityClient(raw.transport);

    expect(client.getCapabilities()).toEqual({
      contractVersion: TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION,
      kind: 'dark',
    });
    await expect(client.agentSessions.execute(sessionRequest())).rejects.toBeInstanceOf(
      TaskReliabilityCapabilityError,
    );
    await expect(
      client.initialPromptDelivery.getProjection({ deliveryId: 'delivery-1' }),
    ).rejects.toBeInstanceOf(TaskReliabilityCapabilityError);
    expect(raw.transport.agentSessions.execute).not.toHaveBeenCalled();
    expect(raw.transport.initialPromptDelivery.getProjection).not.toHaveBeenCalled();
    expect(raw.transport.liveEvents.subscribe).not.toHaveBeenCalled();
  });

  it('requires an exact active backend bundle and keeps dark responses unadvertised', async () => {
    const raw = createRawTransport();
    const protocolErrors: Error[] = [];
    const client = createTaskReliabilityClient(raw.transport, {
      onProtocolError: (error) => protocolErrors.push(error),
    });

    raw.transport.capabilities.read.mockResolvedValueOnce(null);
    await expect(client.refreshCapabilities()).resolves.toMatchObject({ kind: 'dark' });
    raw.transport.capabilities.read.mockResolvedValueOnce({
      ...capabilities(),
      extraAuthority: true,
    });
    await expect(client.refreshCapabilities()).resolves.toMatchObject({ kind: 'dark' });
    expect(raw.transport.liveEvents.subscribe).not.toHaveBeenCalled();
    expect(protocolErrors.at(-1)?.message).toContain('Invalid task-reliability capability bundle');
  });

  it('enables only the slices named by a matching bundle and guards every response', async () => {
    const raw = createRawTransport();
    const client = createTaskReliabilityClient(raw.transport);
    raw.transport.capabilities.read.mockResolvedValue(capabilities(false));
    raw.transport.agentSessions.execute.mockResolvedValue({
      kind: 'operation',
      projection: sessionProjection(),
      replayed: false,
    });

    await expect(client.refreshCapabilities()).resolves.toMatchObject({ kind: 'active' });
    expect(Object.isFrozen(client.getCapabilities())).toBe(true);
    await expect(client.agentSessions.execute(sessionRequest())).resolves.toMatchObject({
      kind: 'operation',
      replayed: false,
    });
    await expect(
      client.initialPromptDelivery.sendManually(manualSendRequest()),
    ).rejects.toBeInstanceOf(TaskReliabilityCapabilityError);
    expect(raw.transport.initialPromptDelivery.sendManually).not.toHaveBeenCalled();

    raw.transport.agentSessions.getProjection.mockResolvedValue({
      ...sessionProjection(),
      privateJournalHealth: 'healthy',
    });
    await expect(
      client.agentSessions.getProjection({ agentId: 'agent-1', taskId: 'task-1' }),
    ).rejects.toThrow('Invalid agent-session projection response');
  });

  it('rejects backend-only initial and fallback admissions before transport dispatch', async () => {
    const raw = createRawTransport();
    const client = createTaskReliabilityClient(raw.transport);
    raw.transport.capabilities.read.mockResolvedValue(capabilities());
    await client.refreshCapabilities();

    const fallback = {
      ...sessionRequest(),
      admission: { kind: 'resume-fallback-system' },
      launchReason: 'resume-fallback',
    } as unknown as RendererAgentSessionOperationRequest;
    await expect(client.agentSessions.execute(fallback)).rejects.toThrow(
      'Invalid renderer agent-session operation request',
    );
    expect(raw.transport.agentSessions.execute).not.toHaveBeenCalled();
  });

  it('validates active initial-prompt reads and manual actions at the facade boundary', async () => {
    const raw = createRawTransport();
    const client = createTaskReliabilityClient(raw.transport);
    raw.transport.capabilities.read.mockResolvedValue(capabilities());
    raw.transport.initialPromptDelivery.getProjection.mockResolvedValue(promptProjection());
    raw.transport.initialPromptDelivery.sendManually.mockResolvedValue({
      current: current(),
      currentDraft: promptProjection().currentDraft,
      delivery: promptProjection().delivery,
      issue: { code: 'agent-not-ready' },
      kind: 'domain-rejected',
      recovery: {
        failedAttempt: 1,
        kind: 'retry-proven-not-sent',
        manualSendOperationId: manualSendRequest().manualSendOperationId,
      },
      replayed: false,
    });
    await client.refreshCapabilities();

    await expect(
      client.initialPromptDelivery.getProjection({ deliveryId: 'delivery-1' }),
    ).resolves.toMatchObject({ delivery: { deliveryId: 'delivery-1' } });
    await expect(
      client.initialPromptDelivery.sendManually(manualSendRequest()),
    ).resolves.toMatchObject({ kind: 'domain-rejected', replayed: false });

    raw.transport.initialPromptDelivery.getProjection.mockResolvedValue({
      ...promptProjection(),
      deletionOperationId: 'private',
    });
    await expect(
      client.initialPromptDelivery.getProjection({ deliveryId: 'delivery-1' }),
    ).rejects.toThrow('Invalid initial-prompt projection response');
  });

  it('rejects validly shaped responses correlated to another request', async () => {
    const raw = createRawTransport();
    const client = createTaskReliabilityClient(raw.transport);
    raw.transport.capabilities.read.mockResolvedValue(capabilities());
    await client.refreshCapabilities();

    raw.transport.agentSessions.execute.mockResolvedValue({
      kind: 'operation',
      projection: {
        ...sessionProjection(),
        operation: { ...sessionProjection().operation, operationId: 'other-operation' },
      },
      replayed: false,
    });
    await expect(client.agentSessions.execute(sessionRequest())).rejects.toThrow(
      'Invalid agent-session operation identity response',
    );

    raw.transport.agentSessions.getProjection.mockResolvedValue({
      ...sessionProjection(),
      operation: { ...sessionProjection().operation, taskId: 'task-2' },
    });
    await expect(
      client.agentSessions.getProjection({ agentId: 'agent-1', taskId: 'task-1' }),
    ).rejects.toThrow('Invalid agent-session projection identity response');

    raw.transport.initialPromptDelivery.getProjection.mockResolvedValue({
      ...promptProjection(),
      delivery: { ...promptProjection().delivery, deliveryId: 'delivery-2' },
    });
    await expect(
      client.initialPromptDelivery.getProjection({ deliveryId: 'delivery-1' }),
    ).rejects.toThrow('Invalid initial-prompt projection identity response');

    raw.transport.initialPromptDelivery.resolveAmbiguity.mockResolvedValue({
      kind: 'resolved',
      projection: promptProjection(),
      replayed: false,
    });
    await expect(
      client.initialPromptDelivery.resolveAmbiguity({
        expectedOperationVersion: 2,
        manualSendOperationId: manualSendRequest().manualSendOperationId,
        resolution: 'observed-sent',
      }),
    ).rejects.toThrow('Invalid initial-prompt ambiguity resolution response');

    const manualOperation = {
      acknowledgedDraftFingerprint: fingerprint,
      acknowledgedEditRevision: 0,
      agentId: 'agent-1',
      attempt: 1,
      createdAt: '2026-08-04T00:00:00.000Z',
      deliveryId: 'delivery-1',
      expectedAgentGeneration: 7,
      manualSendOperationId: manualSendRequest().manualSendOperationId,
      phase: 'manual-reconciliation-required',
      possiblePriorAutomaticWrite: false,
      taskId: 'task-1',
      updatedAt: '2026-08-04T00:00:01.000Z',
      version: 2,
    };
    raw.transport.initialPromptDelivery.resolveAmbiguity.mockResolvedValue({
      kind: 'resolved',
      projection: { ...promptProjection(), manualSendOperation: manualOperation },
      replayed: false,
    });
    await expect(
      client.initialPromptDelivery.resolveAmbiguity({
        expectedOperationVersion: 2,
        manualSendOperationId: 'other-operation',
        resolution: 'observed-sent',
      }),
    ).rejects.toThrow('Invalid initial-prompt ambiguity resolution identity response');

    raw.transport.initialPromptDelivery.sendManually.mockResolvedValue({
      current: current(),
      currentDraft: {
        ...promptProjection().currentDraft,
        fingerprint: deriveTaskInitialPromptDraftFingerprint({
          agentId: 'agent-2',
          readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
          taskId: 'task-1',
          text: promptText,
        }),
      },
      delivery: { ...promptProjection().delivery, agentId: 'agent-2' },
      issue: { code: 'agent-not-ready' },
      kind: 'domain-rejected',
      recovery: {
        failedAttempt: 1,
        kind: 'retry-proven-not-sent',
        manualSendOperationId: manualSendRequest().manualSendOperationId,
      },
      replayed: false,
    });
    await expect(client.initialPromptDelivery.sendManually(manualSendRequest())).rejects.toThrow(
      'Invalid initial-prompt manual-send delivery identity response',
    );
  });

  it('forwards matched live projections and fails closed on an epoch or server mismatch', async () => {
    const raw = createRawTransport();
    const protocolErrors: Error[] = [];
    const client = createTaskReliabilityClient(raw.transport, {
      onProtocolError: (error) => protocolErrors.push(error),
    });
    const events = vi.fn();
    client.subscribe(events);
    raw.transport.capabilities.read.mockResolvedValue(capabilities());
    await client.refreshCapabilities();

    raw.emit({
      cutoverEpoch: 'cutover-1',
      kind: 'initial-prompt-delivery-changed',
      projection: promptProjection(),
      serverInstanceId: 'server-1',
    });
    expect(events).toHaveBeenCalledOnce();

    raw.emit({
      cutoverEpoch: 'forged-epoch',
      kind: 'agent-session-operation-changed',
      projection: sessionProjection(),
      serverInstanceId: 'server-1',
    });
    expect(client.getCapabilities()).toMatchObject({ kind: 'dark' });
    expect(protocolErrors.at(-1)?.message).toContain('did not match the active bundle');
    await expect(client.agentSessions.execute(sessionRequest())).rejects.toBeInstanceOf(
      TaskReliabilityCapabilityError,
    );
  });

  it('invalidates active capabilities on the explicit live event and disposes idempotently', async () => {
    const raw = createRawTransport();
    const client = createTaskReliabilityClient(raw.transport);
    raw.transport.capabilities.read.mockResolvedValue(capabilities());
    await client.refreshCapabilities();
    raw.emit({
      kind: 'task-reliability-capabilities-invalidated',
      serverInstanceId: 'server-1',
    });
    expect(client.getCapabilities()).toMatchObject({ kind: 'dark' });
    client.dispose();
    client.dispose();
    await expect(client.refreshCapabilities()).resolves.toMatchObject({ kind: 'dark' });
  });

  it('does not apply a response after its capability epoch is invalidated', async () => {
    const raw = createRawTransport();
    const client = createTaskReliabilityClient(raw.transport);
    raw.transport.capabilities.read.mockResolvedValue(capabilities());
    let resolveOperation: ((value: unknown) => void) | undefined;
    raw.transport.agentSessions.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOperation = resolve;
        }),
    );
    await client.refreshCapabilities();

    const pending = client.agentSessions.execute(sessionRequest());
    raw.emit({
      kind: 'task-reliability-capabilities-invalidated',
      serverInstanceId: 'server-1',
    });
    resolveOperation?.({
      kind: 'operation',
      projection: sessionProjection(),
      replayed: false,
    });
    await expect(pending).rejects.toBeInstanceOf(TaskReliabilityCapabilityError);
  });
});
