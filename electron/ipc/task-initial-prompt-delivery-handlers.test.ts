import { describe, expect, it, vi } from 'vitest';

import { TASK_INITIAL_PROMPT_READINESS_POLICY } from '../../src/domain/task-initial-prompt-delivery.js';
import type { TaskInitialPromptDeliveryService } from './task-initial-prompt-delivery.js';
import {
  TaskInitialPromptAuthorizationError,
  TaskInitialPromptHandlerBadRequestError,
  createUnregisteredTaskInitialPromptDeliveryHandlers,
} from './task-initial-prompt-delivery-handlers.js';

function createService(): TaskInitialPromptDeliveryService {
  return {
    close: vi.fn(),
    drainTaskForRemoval: vi.fn(),
    expireDueDelivery: vi.fn(),
    finalizeRemovedTaskInitialPromptState: vi.fn(),
    getOwnerAvailability: vi.fn(() => ({
      kind: 'dark' as const,
      reason: 'delivery-owner-dark' as const,
    })),
    getProjection: vi.fn(async () => null),
    probeRemovalHooks: vi.fn(() => ({
      drainHookVersion: 'initial-prompt-owner-hooks-v1' as const,
      finalizerHookVersion: 'initial-prompt-owner-hooks-v1' as const,
    })),
    processObservation: vi.fn(),
    queue: vi.fn(async () => ({
      kind: 'admission-unavailable' as const,
      reason: 'delivery-owner-dark' as const,
      replayed: false as const,
    })),
    repairAfterRestart: vi.fn(),
    resolveManualAmbiguity: vi.fn(),
    reviseDraft: vi.fn(),
    sendManually: vi.fn(),
  };
}

describe('unregistered initial prompt delivery handlers', () => {
  it('has no transport registration and preserves typed dark rejection', async () => {
    const service = createService();
    const handlers = createUnregisteredTaskInitialPromptDeliveryHandlers({
      authorize: () => true,
      service,
    });
    expect(handlers.registrationState).toBe('unregistered');
    await expect(
      handlers.queue({
        agentId: 'agent-1',
        deliveryId: 'delivery-1',
        expectedDraftFingerprint: 'ab'.repeat(32),
        readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
        taskId: 'task-1',
      }),
    ).resolves.toEqual({
      kind: 'admission-unavailable',
      reason: 'delivery-owner-dark',
      replayed: false,
    });
  });

  it('checks authorization before forwarding', async () => {
    const service = createService();
    const handlers = createUnregisteredTaskInitialPromptDeliveryHandlers({
      authorize: () => false,
      service,
    });
    await expect(
      handlers.queue({
        agentId: 'agent-1',
        deliveryId: 'delivery-1',
        expectedDraftFingerprint: 'ab'.repeat(32),
        readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
        taskId: 'task-1',
      }),
    ).rejects.toBeInstanceOf(TaskInitialPromptAuthorizationError);
    expect(service.queue).not.toHaveBeenCalled();
  });

  it('rejects malformed edit payloads before forwarding', async () => {
    const service = createService();
    const handlers = createUnregisteredTaskInitialPromptDeliveryHandlers({
      authorize: () => true,
      service,
    });
    await expect(
      handlers.reviseDraft({
        editOperationId: '',
        expectedDraftFingerprint: 'ab'.repeat(32),
        expectedEditRevision: 0,
        revisedText: 'text',
        sourceDeliveryId: 'delivery-1',
        taskId: 'task-1',
      }),
    ).rejects.toBeInstanceOf(TaskInitialPromptHandlerBadRequestError);
    expect(service.reviseDraft).not.toHaveBeenCalled();
  });
});
