import { describe, expect, it, vi } from 'vitest';

import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import {
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  deriveManualInitialPromptSendOperationId,
  deriveTaskInitialPromptDraftFingerprint,
  isResolveManualInitialPromptSendAmbiguityResult,
  isReviseTaskInitialPromptDraftResult,
  isSendTaskInitialPromptManuallyResult,
  isTaskInitialPromptDeliveryProjection,
  type ResolveManualInitialPromptSendAmbiguityRequest,
  type ReviseTaskInitialPromptDraftRequest,
  type SendTaskInitialPromptManuallyRequest,
  type TaskInitialPromptDeliveryProjection,
  type TaskInitialPromptDeliveryProjectionWithManualOperation,
} from '../../src/domain/task-initial-prompt-delivery.js';
import { TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION } from '../../src/domain/task-reliability-runtime.js';
import {
  createTaskReliabilityClient,
  type TaskReliabilityRawTransport,
} from '../../src/app/task-reliability-client.js';
import {
  createActiveTaskInitialPromptDeliveryHandlers,
  TaskInitialPromptAuthorizationError,
} from '../../electron/ipc/task-initial-prompt-delivery-handlers.js';
import type { TaskInitialPromptDeliveryService } from '../../electron/ipc/task-initial-prompt-delivery.js';

const SERVER_INSTANCE_ID = 'server-contract-1';
const CUTOVER_EPOCH = 'cutover-contract-1';
const PROMPT = 'Review the exact transport contract';
const REVISED_PROMPT = 'Review the exact transport contract carefully';
const FINGERPRINT = deriveTaskInitialPromptDraftFingerprint({
  agentId: 'agent-1',
  readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
  taskId: 'task-1',
  text: PROMPT,
});
const MANUAL_OPERATION_ID = deriveManualInitialPromptSendOperationId({
  acknowledgedDraftFingerprint: FINGERPRINT,
  acknowledgedEditRevision: 2,
  deliveryId: 'delivery-1',
});

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function projection(): TaskInitialPromptDeliveryProjection {
  return {
    current: {
      catalogVersion: 7,
      serverInstanceId: SERVER_INSTANCE_ID,
      taskClosing: false,
      taskState: 'present',
    },
    currentDraft: {
      editRevision: 2,
      fingerprint: FINGERPRINT,
      mode: 'manual-only',
      text: PROMPT,
      workspaceRevision: 11,
    },
    delivery: {
      agentId: 'agent-1',
      attempts: 1,
      createdAt: '2026-08-04T00:00:00.000Z',
      deliveryId: 'delivery-1',
      reason: 'verification-inconclusive',
      status: 'manual-required',
      targetGeneration: 4,
      taskId: 'task-1',
      updatedAt: '2026-08-04T00:00:05.000Z',
      version: 6,
    },
  };
}

function manualRequest(): SendTaskInitialPromptManuallyRequest {
  return {
    action: { kind: 'send' },
    agentId: 'agent-1',
    confirmPossiblePriorAutomaticWrite: true,
    deliveryId: 'delivery-1',
    expectedAgentGeneration: 4,
    expectedDraftFingerprint: FINGERPRINT,
    expectedEditRevision: 2,
    manualSendOperationId: MANUAL_OPERATION_ID,
    taskId: 'task-1',
  };
}

function resolvedProjection(): TaskInitialPromptDeliveryProjectionWithManualOperation {
  const current = projection();
  return {
    ...current,
    manualSendHighWater: {
      acknowledgedDraftFingerprint: FINGERPRINT,
      disposition: 'reconciled',
      highestAcknowledgedEditRevision: 2,
      operationId: MANUAL_OPERATION_ID,
    },
    manualSendOperation: {
      acknowledgedDraftFingerprint: FINGERPRINT,
      acknowledgedEditRevision: 2,
      agentId: 'agent-1',
      attempt: 1,
      createdAt: '2026-08-04T00:00:01.000Z',
      deliveryId: 'delivery-1',
      expectedAgentGeneration: 4,
      manualSendOperationId: MANUAL_OPERATION_ID,
      phase: 'reconciled',
      possiblePriorAutomaticWrite: true,
      taskId: 'task-1',
      terminalReceipt: {
        acknowledgedDraftFingerprint: FINGERPRINT,
        acknowledgedEditRevision: 2,
        agentId: 'agent-1',
        attempt: 1,
        completedAt: '2026-08-04T00:00:06.000Z',
        deliveryId: 'delivery-1',
        expectedAgentGeneration: 4,
        manualSendOperationId: MANUAL_OPERATION_ID,
        outcome: { kind: 'reconciled', resolution: 'abandon-to-terminal' },
        recovery: { kind: 'none' },
        taskId: 'task-1',
        terminal: true,
      },
      updatedAt: '2026-08-04T00:00:06.000Z',
      version: 5,
    },
  };
}

function createContractHarness() {
  const authorizedActions: string[] = [];
  const current = projection();
  const revisedFingerprint = deriveTaskInitialPromptDraftFingerprint({
    agentId: 'agent-1',
    readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
    taskId: 'task-1',
    text: REVISED_PROMPT,
  });
  const service = {
    close: vi.fn(),
    drainTaskForRemoval: vi.fn(),
    expireDueDelivery: vi.fn(),
    finalizeRemovedTaskInitialPromptState: vi.fn(),
    getOwnerAvailability: vi.fn(() => ({
      cutoverEpoch: CUTOVER_EPOCH,
      hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
      kind: 'active' as const,
    })),
    getProjection: vi.fn(async () => current),
    probeRemovalHooks: vi.fn(() => ({
      drainHookVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
      finalizerHookVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
    })),
    processObservation: vi.fn(),
    queue: vi.fn(),
    repairAfterRestart: vi.fn(),
    resolveManualAmbiguity: vi.fn(async () => ({
      kind: 'resolved' as const,
      projection: resolvedProjection(),
      replayed: true,
    })),
    reviseDraft: vi.fn(async () => ({
      current: {
        editRevision: 3,
        fingerprint: revisedFingerprint,
        mode: 'manual-only' as const,
        text: REVISED_PROMPT,
        workspaceRevision: 12,
      },
      kind: 'saved-manual-draft' as const,
    })),
    sendManually: vi.fn(async () => ({
      current: current.current,
      currentDraft: current.currentDraft,
      delivery: current.delivery,
      issue: { code: 'agent-not-ready' as const },
      kind: 'domain-rejected' as const,
      recovery: {
        failedAttempt: 1,
        kind: 'retry-proven-not-sent' as const,
        manualSendOperationId: MANUAL_OPERATION_ID,
      },
      replayed: false,
    })),
  } satisfies TaskInitialPromptDeliveryService;
  const handlers = createActiveTaskInitialPromptDeliveryHandlers({
    authorize: (action) => {
      authorizedActions.push(action);
      return true;
    },
    service,
  });
  const transport = {
    agentSessions: {
      execute: async () => null,
      getProjection: async () => null,
    },
    capabilities: {
      read: async () =>
        jsonRoundTrip({
          agentSessions: {
            automaticResumeFallback: false,
            hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
            initialLaunch: true,
            manualReplacement: true,
          },
          contractVersion: TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION,
          cutoverEpoch: CUTOVER_EPOCH,
          initialPromptDelivery: {
            enabled: true,
            hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
          },
          kind: 'active',
          serverInstanceId: SERVER_INSTANCE_ID,
        }),
    },
    initialPromptDelivery: {
      getProjection: async (request) =>
        jsonRoundTrip(await handlers.getProjection(jsonRoundTrip(request).deliveryId)),
      resolveAmbiguity: async (request) =>
        jsonRoundTrip(await handlers.resolveManualAmbiguity(jsonRoundTrip(request))),
      reviseDraft: async (request) =>
        jsonRoundTrip(await handlers.reviseDraft(jsonRoundTrip(request))),
      sendManually: async (request) =>
        jsonRoundTrip(await handlers.sendManually(jsonRoundTrip(request))),
    },
    liveEvents: { subscribe: () => () => undefined },
  } satisfies TaskReliabilityRawTransport;
  return {
    authorizedActions,
    client: createTaskReliabilityClient(transport),
    current,
    handlers,
    service,
  };
}

describe('initial-prompt delivery transport contract', () => {
  it('preserves exact typed requests and results through the shared JSON wire boundary', async () => {
    const harness = createContractHarness();
    await expect(harness.client.refreshCapabilities()).resolves.toMatchObject({ kind: 'active' });

    const revision: ReviseTaskInitialPromptDraftRequest = {
      editOperationId: 'edit-3',
      expectedDraftFingerprint: FINGERPRINT,
      expectedEditRevision: 2,
      revisedText: REVISED_PROMPT,
      sourceDeliveryId: 'delivery-1',
      taskId: 'task-1',
    };
    const resolution: ResolveManualInitialPromptSendAmbiguityRequest = {
      expectedOperationVersion: 4,
      manualSendOperationId: MANUAL_OPERATION_ID,
      resolution: 'abandon-to-terminal',
    };

    await expect(
      harness.client.initialPromptDelivery.getProjection({ deliveryId: 'delivery-1' }),
    ).resolves.toEqual(harness.current);
    const revised = await harness.client.initialPromptDelivery.reviseDraft(revision);
    const sent = await harness.client.initialPromptDelivery.sendManually(manualRequest());
    const resolved = await harness.client.initialPromptDelivery.resolveAmbiguity(resolution);

    expect(isReviseTaskInitialPromptDraftResult(jsonRoundTrip(revised))).toBe(true);
    expect(isSendTaskInitialPromptManuallyResult(jsonRoundTrip(sent))).toBe(true);
    expect(isResolveManualInitialPromptSendAmbiguityResult(jsonRoundTrip(resolved))).toBe(true);
    expect(resolved).toMatchObject({
      kind: 'resolved',
      projection: {
        manualSendOperation: { manualSendOperationId: resolution.manualSendOperationId },
      },
    });
    expect(harness.service.reviseDraft).toHaveBeenCalledWith(revision);
    expect(harness.service.sendManually).toHaveBeenCalledWith(manualRequest());
    expect(harness.service.resolveManualAmbiguity).toHaveBeenCalledWith(resolution);
    expect(harness.authorizedActions).toEqual(['observe', 'edit', 'manual-send', 'resolve']);
  });

  it('rejects private owner/removal fields and omits task state only on preauthorization failure', async () => {
    const current = projection();
    for (const forged of [
      { ...current, cleanupEvidence: { removed: true } },
      { ...current, deletionOperationId: 'delete-private-1' },
      { ...current, recordVersion: 8 },
      { ...current, repairDetail: 'private journal path' },
      { ...current, current: { ...current.current, removalPhase: 'cleanup-pending' } },
    ]) {
      expect(isTaskInitialPromptDeliveryProjection(jsonRoundTrip(forged))).toBe(false);
    }

    const privateSendResult = {
      current: current.current,
      currentDraft: current.currentDraft,
      delivery: current.delivery,
      issue: { code: 'agent-not-ready' },
      kind: 'domain-rejected',
      recovery: { kind: 'none' },
      replayed: false,
      removalWitness: 'private',
    };
    expect(isSendTaskInitialPromptManuallyResult(jsonRoundTrip(privateSendResult))).toBe(false);

    const service = createContractHarness().service;
    const denied = createActiveTaskInitialPromptDeliveryHandlers({
      authorize: () => false,
      service,
    });
    await expect(denied.sendManually(manualRequest())).rejects.toBeInstanceOf(
      TaskInitialPromptAuthorizationError,
    );
    expect(service.sendManually).not.toHaveBeenCalled();
  });
});
