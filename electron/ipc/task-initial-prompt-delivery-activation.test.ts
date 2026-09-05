import { describe, expect, it, vi } from 'vitest';

import {
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  type TaskInitialPromptOwnerAvailability,
} from '../../src/domain/task-initial-prompt-delivery.js';
import {
  createTaskInitialPromptDeliveryService,
  type TaskInitialPromptDeliveryDependencies,
} from './task-initial-prompt-delivery.js';
import { createUnregisteredTaskInitialPromptDeliveryHandlers } from './task-initial-prompt-delivery-handlers.js';

const FINGERPRINT = 'ab'.repeat(32);

function createSentinelHarness(args: {
  availability: TaskInitialPromptOwnerAvailability;
  gateEpoch?: string;
  gateHookVersion?: string;
}) {
  const journal = {
    deleteTaskRecords: vi.fn(async () => 'already-complete' as const),
    findManualOperation: vi.fn(async () => null),
    isAvailable: vi.fn(() => true),
    listRecords: vi.fn(async () => []),
    listTaskRecords: vi.fn(async () => []),
    load: vi.fn(async () => null),
    save: vi.fn(async () => undefined),
  };
  const draftRepository = {
    clearAfterAcceptedOutcome: vi.fn(async () => ({
      kind: 'already-cleared' as const,
      workspaceRevision: 1,
    })),
    loadCurrentDraft: vi.fn(async () => null),
    loadExactDraft: vi.fn(async () => {
      throw new Error('dark owner must not load a draft');
    }),
    reviseAfterUserEdit: vi.fn(async () => ({ current: null, kind: 'task-missing' as const })),
  };
  const acquireCommandLease = vi.fn(async () => {
    throw new Error('dark owner must not acquire a lease');
  });
  const admitPrompt = vi.fn(async () => {
    throw new Error('dark owner must not dispatch bytes');
  });
  const sleep = vi.fn(async () => undefined);
  const dependencies: TaskInitialPromptDeliveryDependencies = {
    acquireCommandLease,
    admitPrompt,
    clock: { nowMs: () => 1, sleep, toIso: (ms) => new Date(ms).toISOString() },
    draftRepository,
    getAgentRuntime: vi.fn(() => null),
    getOwnerAvailability: vi.fn(() => args.availability),
    journal,
    removalGate: {
      getTaskSnapshot: vi.fn(() => ({
        current: {
          catalogVersion: 1,
          serverInstanceId: 'server-1',
          taskClosing: false,
          taskState: 'present' as const,
        },
        cutoverEpoch: args.gateEpoch ?? 'epoch-1',
        hookSetVersion: (args.gateHookVersion ??
          TASK_INITIAL_PROMPT_HOOK_SET_VERSION) as typeof TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
        kind: 'active' as const,
      })),
      verifyCommittedRemoval: vi.fn(() => false),
    },
  };
  return {
    acquireCommandLease,
    admitPrompt,
    draftRepository,
    handlers: createUnregisteredTaskInitialPromptDeliveryHandlers({
      authorize: () => true,
      service: createTaskInitialPromptDeliveryService(dependencies),
    }),
    journal,
    service: createTaskInitialPromptDeliveryService(dependencies),
    sleep,
  };
}

const queueRequest = {
  agentId: 'agent-1',
  deliveryId: 'delivery-1',
  expectedDraftFingerprint: FINGERPRINT,
  readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
  taskId: 'task-1',
} as const;

describe('initial prompt owner activation barrier', () => {
  it('keeps every prospective public entrypoint effect-free while dark', async () => {
    const harness = createSentinelHarness({
      availability: { kind: 'dark', reason: 'delivery-owner-dark' },
    });

    await expect(harness.service.queue(queueRequest)).resolves.toMatchObject({
      kind: 'admission-unavailable',
      reason: 'delivery-owner-dark',
    });
    await expect(
      harness.service.processObservation('delivery-1', {
        agentId: 'agent-1',
        generation: 1,
        lastOutputAtMs: 0,
        nowMs: 2_000,
        state: 'idle-at-prompt',
        supervisionVersion: 1,
        tail: '❯',
      }),
    ).resolves.toEqual({ kind: 'admission-unavailable', reason: 'delivery-owner-dark' });
    await expect(
      harness.service.reviseDraft({
        editOperationId: 'edit-1',
        expectedDraftFingerprint: FINGERPRINT,
        expectedEditRevision: 0,
        revisedText: 'changed',
        sourceDeliveryId: 'delivery-1',
        taskId: 'task-1',
      }),
    ).resolves.toMatchObject({ kind: 'admission-unavailable' });
    await expect(
      harness.service.sendManually({
        action: { kind: 'send' },
        agentId: 'agent-1',
        confirmPossiblePriorAutomaticWrite: false,
        deliveryId: 'delivery-1',
        expectedAgentGeneration: 1,
        expectedDraftFingerprint: FINGERPRINT,
        expectedEditRevision: 0,
        manualSendOperationId: 'manual:v1:forged',
        taskId: 'task-1',
      }),
    ).resolves.toMatchObject({ kind: 'admission-rejected' });
    await expect(
      harness.service.resolveManualAmbiguity({
        expectedOperationVersion: 1,
        manualSendOperationId: 'manual:v1:forged',
        resolution: 'abandon-to-terminal',
      }),
    ).resolves.toMatchObject({ kind: 'rejected' });
    await expect(harness.service.getProjection('delivery-1')).resolves.toBeNull();

    expect(harness.journal.load).not.toHaveBeenCalled();
    expect(harness.journal.save).not.toHaveBeenCalled();
    expect(harness.journal.findManualOperation).not.toHaveBeenCalled();
    expect(harness.draftRepository.loadExactDraft).not.toHaveBeenCalled();
    expect(harness.draftRepository.reviseAfterUserEdit).not.toHaveBeenCalled();
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();
    expect(harness.sleep).not.toHaveBeenCalled();
    expect(harness.handlers.registrationState).toBe('unregistered');
  });

  it.each([
    ['cutover epoch', 'epoch-2', TASK_INITIAL_PROMPT_HOOK_SET_VERSION],
    ['hook version', 'epoch-1', 'wrong-hook-version'],
  ])('rejects a mismatched %s before allocating an operation', async (_label, gateEpoch, hook) => {
    const harness = createSentinelHarness({
      availability: {
        cutoverEpoch: 'epoch-1',
        hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
        kind: 'active',
      },
      gateEpoch,
      gateHookVersion: hook,
    });

    await expect(harness.service.queue(queueRequest)).resolves.toMatchObject({
      kind: 'admission-unavailable',
      reason: 'task-removal-gate-unavailable',
    });
    expect(harness.journal.load).not.toHaveBeenCalled();
    expect(harness.journal.save).not.toHaveBeenCalled();
    expect(harness.draftRepository.loadExactDraft).not.toHaveBeenCalled();
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();
    expect(harness.sleep).not.toHaveBeenCalled();
  });
});
