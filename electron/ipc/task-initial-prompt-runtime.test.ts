import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentSupervisionEvent,
  AgentSupervisionSnapshot,
} from '../../src/domain/server-state.js';
import {
  deriveManualInitialPromptSendOperationId,
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  TASK_INITIAL_PROMPT_QUIESCENCE_MS,
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  TASK_INITIAL_PROMPT_READY_DEADLINE_MS,
  TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS,
  TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS,
  TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS,
  type TaskInitialPromptDeliveryRequest,
  type TaskInitialPromptDraftSnapshot,
} from '../../src/domain/task-initial-prompt-delivery.js';
import { createMemoryTaskInitialPromptDeliveryJournal } from './task-initial-prompt-delivery.js';
import type { WorkspaceTaskInitialPromptPersistence } from './task-initial-prompt-delivery-persistence.js';
import {
  createProductionTaskInitialPromptRuntime,
  type ProductionTaskInitialPromptRuntimeAdapters,
} from './task-initial-prompt-runtime.js';
import { createTaskPromptInputAdmissionService } from './task-prompt-input-admission.js';
import {
  createOrdinaryTaskPromptInputHandler,
  readTaskPromptInputAdmissionCurrentState,
} from './task-prompt-input-handler.js';
import type { TaskStructureMutationService } from './task-structure-mutations.js';
import type { WorkspaceMutationService } from './workspace-state-mutations.js';

const FINGERPRINT = 'ab'.repeat(32);
const REQUEST: TaskInitialPromptDeliveryRequest = {
  agentId: 'agent-1',
  deliveryId: 'delivery-1',
  expectedDraftFingerprint: FINGERPRINT,
  readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
  taskId: 'task-1',
};
const MANUAL_REQUEST = {
  action: { kind: 'send' } as const,
  agentId: REQUEST.agentId,
  confirmPossiblePriorAutomaticWrite: false,
  deliveryId: REQUEST.deliveryId,
  expectedAgentGeneration: 0,
  expectedDraftFingerprint: FINGERPRINT,
  expectedEditRevision: 0,
  manualSendOperationId: deriveManualInitialPromptSendOperationId({
    acknowledgedDraftFingerprint: FINGERPRINT,
    acknowledgedEditRevision: 0,
    deliveryId: REQUEST.deliveryId,
  }),
  taskId: REQUEST.taskId,
};

function createHarness(
  options: {
    draftText?: string;
    promptAdmissionSleep?: (delayMs: number) => Promise<void>;
    removalActive?: boolean;
    runningAgent?: boolean;
  } = {},
) {
  const journal = createMemoryTaskInitialPromptDeliveryJournal();
  let draft: TaskInitialPromptDraftSnapshot | null = {
    editRevision: 0,
    fingerprint: FINGERPRINT,
    mode: 'automatic',
    text: options.draftText ?? 'Please inspect the repository',
    workspaceRevision: 7,
  };
  const persistence: WorkspaceTaskInitialPromptPersistence = {
    activatePromptProtectionAndDisableLegacyWriters: vi.fn(async (cutoverEpoch: string) => ({
      cutoverEpoch,
      hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
      legacyWritersDisabled: true as const,
      migratedLegacyDrafts: 0,
      protectedPolicyVersion: '1' as const,
    })),
    ensureDarkJournalReady: vi.fn(async () => undefined),
    journal,
    repository: {
      clearAfterAcceptedOutcome: vi.fn(
        async ({ deliveryId, expectedDraftFingerprint, expectedEditRevision }) => {
          const sealEditHighWater = async () => {
            const record = await journal.load(deliveryId);
            if (!record) return;
            record.editHighWater = {
              editSealed: true,
              highestEditRevision: expectedEditRevision,
              highestInputFingerprint: expectedDraftFingerprint,
              highestOperationId: record.editHighWater?.highestOperationId ?? 'clear',
            };
            await journal.save(record);
          };
          if (!draft) {
            await sealEditHighWater();
            return { kind: 'already-cleared' as const, workspaceRevision: 8 };
          }
          if (
            draft.fingerprint !== expectedDraftFingerprint ||
            draft.editRevision !== expectedEditRevision
          ) {
            return { kind: 'draft-changed' as const, workspaceRevision: 8 };
          }
          draft = null;
          await sealEditHighWater();
          return { kind: 'cleared' as const, workspaceRevision: 8 };
        },
      ),
      loadCurrentDraft: vi.fn(async () => (draft ? { ...draft } : null)),
      loadExactDraft: vi.fn(async ({ expectedDraftFingerprint }) => {
        if (!draft || draft.fingerprint !== expectedDraftFingerprint) {
          throw new Error('draft changed');
        }
        return { ...draft };
      }),
      reviseAfterUserEdit: vi.fn(async () => ({ current: draft, kind: 'replayed' as const })),
    },
    verifyPromptProtectionCutover: vi.fn(async () => undefined),
  };
  const current = {
    catalogVersion: 2,
    serverInstanceId: 'server-1',
    taskClosing: false,
    taskState: 'present' as const,
  };
  const gate = {
    getTaskSnapshot: vi.fn(() =>
      options.removalActive === false
        ? ({ kind: 'unavailable' as const } as const)
        : ({
            current,
            cutoverEpoch: 'epoch-1',
            hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
            kind: 'active' as const,
          } as const),
    ),
    verifyCommittedRemoval: vi.fn(() => true),
  };
  const structure = {
    createTaskRemovalParticipantGate: vi.fn(() => gate),
    getTaskRemovalOwnerCapability: vi.fn(() =>
      options.removalActive === false
        ? null
        : {
            cutoverEpoch: 'epoch-1',
            hookSetVersions: {
              'agent-session': 'agent-session-owner-hooks-v1',
              'initial-prompt': TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
              'task-runtime': 'task-runtime-owner-hooks-v1',
            },
            kind: 'active' as const,
            schemaVersion: 1 as const,
          },
    ),
  } as unknown as TaskStructureMutationService;
  let runningAgent = options.runningAgent ?? true;
  let scrollbackText = 'Parallel Code\n❯';
  let supervision: AgentSupervisionSnapshot = {
    agentId: 'agent-1',
    attentionReason: null,
    generation: 0,
    isShell: false,
    lastOutputAt: 1_000,
    preview: '❯',
    state: 'idle-at-prompt' as const,
    supervisionVersion: 1,
    taskId: 'task-1',
    updatedAt: 1_000,
  };
  let supervisionListener: ((event: AgentSupervisionEvent) => void) | null = null;
  const stopSubscription = vi.fn();
  const writeFrame = vi.fn();
  const acquireLease = vi.fn((taskId: string, clientId: string) => ({
    acquired: true,
    action: 'deliver initial prompt',
    changed: true,
    controllerId: clientId,
    leaseGeneration: 4,
    taskId,
    version: 1,
  }));
  const releaseLease = vi.fn(() => ({
    changed: true,
    snapshot: { action: null, controllerId: null, taskId: 'task-1', version: 2 },
  }));
  const getAgentGeneration = () => (runningAgent ? 0 : null);
  const getAgentMetadata = () =>
    runningAgent ? { agentId: 'agent-1', generation: 0, isShell: false, taskId: 'task-1' } : null;
  const getSupervision = () => (runningAgent ? supervision : null);
  const promptInputState = {
    getAgentGeneration,
    getAgentMetadata,
    getSupervisionSnapshot: getSupervision,
  };
  const adapters: Partial<ProductionTaskInitialPromptRuntimeAdapters> = {
    acquireLease: acquireLease as ProductionTaskInitialPromptRuntimeAdapters['acquireLease'],
    getAgentGeneration,
    getAgentMetadata,
    getAgentScrollback: () => (runningAgent ? Buffer.from(scrollbackText) : null),
    getSupervision,
    nowMs: Date.now,
    releaseLease: releaseLease as ProductionTaskInitialPromptRuntimeAdapters['releaseLease'],
    subscribeSupervision: (listener) => {
      supervisionListener = listener;
      return stopSubscription;
    },
  };
  const promptInputAdmission = createTaskPromptInputAdmissionService({
    getCurrentState: (expectation) =>
      readTaskPromptInputAdmissionCurrentState(promptInputState, expectation),
    isLeaseHeld: () => true,
    ...(options.promptAdmissionSleep ? { sleep: options.promptAdmissionSleep } : {}),
    writeFrame,
  });
  promptInputAdmission.bindTaskClosingResolver(() => current.taskClosing);
  const runtime = createProductionTaskInitialPromptRuntime({
    adapters,
    authorize: () => true,
    persistence,
    promptInputAdmission,
    removalGate: gate,
    structure,
    workspace: {} as WorkspaceMutationService,
  });
  return {
    acquireLease,
    emit(next: typeof supervision) {
      supervision = next;
      supervisionListener?.({ ...next, kind: 'snapshot', stateVersion: 3 });
    },
    gate,
    getDraft: () => draft,
    journal,
    persistence,
    promptInputAdmission,
    promptInputState,
    releaseLease,
    runtime,
    setRunningAgent(next: boolean) {
      runningAgent = next;
    },
    setScrollback(next: string) {
      scrollbackText = next;
    },
    setSupervision(next: typeof supervision) {
      supervision = next;
    },
    setTaskClosing(next: boolean) {
      current.taskClosing = next;
    },
    stopSubscription,
    structure,
    writeFrame,
  };
}

describe('production initial prompt runtime activation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays effect-free and handler-dark before the exact removal cutover', async () => {
    const harness = createHarness();
    await harness.runtime.startup();

    expect(harness.runtime.getHandlers()).toBeNull();
    await expect(harness.runtime.service.queue(REQUEST)).resolves.toEqual({
      kind: 'admission-unavailable',
      reason: 'delivery-owner-dark',
      replayed: false,
    });
    expect(harness.acquireLease).not.toHaveBeenCalled();
    expect(harness.writeFrame).not.toHaveBeenCalled();
    expect(harness.journal.recordCount()).toBe(0);
  });

  it('rejects activation when the generic owner or exact participant gate is absent', async () => {
    const harness = createHarness({ removalActive: false });

    await expect(harness.runtime.activate()).rejects.toThrow(
      'requires its exact generic-removal participant',
    );
    expect(harness.persistence.verifyPromptProtectionCutover).not.toHaveBeenCalled();
    expect(harness.runtime.getHandlers()).toBeNull();
    expect(harness.acquireLease).not.toHaveBeenCalled();
    expect(harness.writeFrame).not.toHaveBeenCalled();
  });

  it('queues after activation, observes readiness without a renderer, and clears only after evidence', async () => {
    const harness = createHarness();
    await expect(harness.runtime.activate()).resolves.toMatchObject({
      cutoverEpoch: 'epoch-1',
      hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
      kind: 'active',
    });
    expect(harness.runtime.getHandlers()?.registrationState).toBe('active');

    await expect(harness.runtime.service.queue(REQUEST)).resolves.toMatchObject({
      kind: 'accepted',
      replayed: false,
    });
    expect(harness.writeFrame).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);
    expect(harness.acquireLease).toHaveBeenCalledWith(
      'task-1',
      'backend:initial-prompt-delivery:v1',
      'backend:initial-prompt-delivery-owner:v1',
      'deliver initial prompt',
    );
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'verifying',
    );
    expect(harness.getDraft()).not.toBeNull();

    harness.emit({
      agentId: 'agent-1',
      attentionReason: null,
      generation: 0,
      isShell: false,
      lastOutputAt: 3_600,
      preview: 'Working',
      state: 'active',
      supervisionVersion: 2,
      taskId: 'task-1',
      updatedAt: 3_600,
    });
    await vi.waitFor(async () => {
      expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
        'delivered',
      );
    });
    expect(harness.getDraft()).toBeNull();
    expect(harness.releaseLease).toHaveBeenCalledWith(
      'task-1',
      'backend:initial-prompt-delivery:v1',
      'backend:initial-prompt-delivery-owner:v1',
      expect.any(Number),
      4,
    );

    await harness.runtime.close();
    expect(harness.stopSubscription).toHaveBeenCalledTimes(1);
    expect(harness.runtime.getHandlers()).toBeNull();
  });

  it('retains a queued draft across a disconnected agent and resumes from supervision', async () => {
    const harness = createHarness({ runningAgent: false });
    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);
    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'waiting-agent-session',
    );
    expect(harness.writeFrame).not.toHaveBeenCalled();

    harness.setRunningAgent(true);
    harness.emit({
      agentId: 'agent-1',
      attentionReason: null,
      generation: 0,
      isShell: false,
      lastOutputAt: 1_000,
      preview: '❯',
      state: 'idle-at-prompt',
      supervisionVersion: 1,
      taskId: 'task-1',
      updatedAt: 3_000,
    });
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);

    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'verifying',
    );
  });

  it('discovers a silently restored agent session without relying on a supervision event', async () => {
    const harness = createHarness({ runningAgent: false });
    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);

    harness.setRunningAgent(true);
    await vi.advanceTimersByTimeAsync(1_000 + TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);

    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'verifying',
    );
  });

  it('keeps discovering a silent agent session after the ready deadline would have elapsed', async () => {
    const harness = createHarness({ runningAgent: false });
    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);

    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_READY_DEADLINE_MS + 1_000);
    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'waiting-agent-session',
    );
    expect(harness.writeFrame).not.toHaveBeenCalled();

    harness.setRunningAgent(true);
    await vi.advanceTimersByTimeAsync(1_000 + TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);

    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'verifying',
    );
  });

  it('safety-observes prompt readiness when a same-preview update emits no event', async () => {
    const harness = createHarness();
    harness.setSupervision({
      agentId: 'agent-1',
      attentionReason: null,
      generation: 0,
      isShell: false,
      lastOutputAt: 3_000,
      preview: 'starting',
      state: 'active',
      supervisionVersion: 1,
      taskId: 'task-1',
      updatedAt: 3_000,
    });
    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);

    harness.setSupervision({
      agentId: 'agent-1',
      attentionReason: null,
      generation: 0,
      isShell: false,
      lastOutputAt: 3_000,
      preview: '❯',
      state: 'idle-at-prompt',
      supervisionVersion: 2,
      taskId: 'task-1',
      updatedAt: 3_001,
    });
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);
    expect(harness.writeFrame).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(
      TASK_INITIAL_PROMPT_QUIESCENCE_MS - TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS,
    );
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
  });

  it('safety-observes prompt echo evidence before the verification deadline', async () => {
    const harness = createHarness();
    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);
    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'verifying',
    );

    harness.setScrollback('Parallel Code\n❯ Please inspect the repository\n❯');
    harness.setSupervision({
      agentId: 'agent-1',
      attentionReason: null,
      generation: 0,
      isShell: false,
      lastOutputAt: 3_501,
      preview: '❯',
      state: 'idle-at-prompt',
      supervisionVersion: 2,
      taskId: 'task-1',
      updatedAt: 3_501,
    });
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);

    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'delivered',
    );
    expect(harness.getDraft()).toBeNull();
  });

  it('settles verification once when the agent runtime silently disappears', async () => {
    const harness = createHarness();
    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);
    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'verifying',
    );

    harness.setRunningAgent(false);
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS);

    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'manual-required',
    );
    expect(harness.releaseLease).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS);
    expect(harness.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('rearms safety observation after transient journal unavailability', async () => {
    const harness = createHarness();
    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);

    harness.journal.setAvailable(false);
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);
    expect(harness.writeFrame).not.toHaveBeenCalled();

    harness.journal.setAvailable(true);
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);

    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'verifying',
    );
  });

  it('rearms safety observation after a transient journal read failure', async () => {
    const harness = createHarness();
    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);
    vi.spyOn(harness.journal, 'load').mockRejectedValueOnce(new Error('temporary read failure'));

    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);
    expect(harness.writeFrame).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'verifying',
    );
  });

  it('keeps the next safety observation armed when projection loading throws', async () => {
    const harness = createHarness();
    await harness.runtime.activate();
    const observer = vi.fn();
    harness.runtime.subscribe(observer);
    await harness.runtime.service.queue(REQUEST);
    observer.mockClear();

    const originalLoad = harness.journal.load.bind(harness.journal);
    vi.spyOn(harness.journal, 'load')
      .mockImplementationOnce(originalLoad)
      .mockRejectedValueOnce(new Error('temporary projection read failure'));

    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    expect(observer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: expect.objectContaining({ status: 'verifying' }) }),
    );
  });

  it('retries a failed queued projection while the agent remains disconnected', async () => {
    const harness = createHarness({ runningAgent: false });
    await harness.runtime.activate();
    const observer = vi.fn();
    harness.runtime.subscribe(observer);
    vi.mocked(harness.persistence.repository.loadCurrentDraft).mockRejectedValueOnce(
      new Error('temporary draft projection failure'),
    );

    await expect(harness.runtime.service.queue(REQUEST)).resolves.toMatchObject({
      kind: 'accepted',
      replayed: false,
      snapshot: { status: 'waiting-agent-session' },
    });
    expect(observer).not.toHaveBeenCalled();
    expect(harness.writeFrame).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({ status: 'waiting-agent-session' }),
      }),
    );
    expect(harness.writeFrame).not.toHaveBeenCalled();

    harness.setRunningAgent(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'verifying',
    );
  });

  it('retries a null terminal projection without runtime or another status change', async () => {
    const harness = createHarness();
    await harness.runtime.activate();
    const observer = vi.fn();
    harness.runtime.subscribe(observer);
    await harness.runtime.service.queue(REQUEST);
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    expect((await harness.runtime.service.getProjection('delivery-1'))?.delivery.status).toBe(
      'verifying',
    );

    observer.mockClear();
    harness.setRunningAgent(false);
    await vi.advanceTimersByTimeAsync(
      TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS - TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS,
    );
    const durableLoad = harness.journal.load.bind(harness.journal);
    vi.spyOn(harness.journal, 'load')
      .mockImplementationOnce(durableLoad)
      .mockResolvedValueOnce(null);
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);
    expect(observer).not.toHaveBeenCalled();
    await expect(harness.journal.load(REQUEST.deliveryId)).resolves.toMatchObject({
      snapshot: { reason: 'verification-inconclusive', status: 'manual-required' },
    });

    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);
    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({
          reason: 'verification-inconclusive',
          status: 'manual-required',
        }),
      }),
    );
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
  });

  it('publishes active projections without letting a failing observer reject delivery work', async () => {
    const harness = createHarness({ runningAgent: false });
    await harness.runtime.activate();
    const healthyObserver = vi.fn();
    harness.runtime.subscribe(() => {
      throw new Error('renderer disappeared');
    });
    harness.runtime.subscribe(healthyObserver);

    await expect(harness.runtime.service.queue(REQUEST)).resolves.toMatchObject({
      kind: 'accepted',
    });

    expect(healthyObserver).toHaveBeenCalledOnce();
    expect(healthyObserver).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: expect.objectContaining({ deliveryId: 'delivery-1' }) }),
    );
  });

  it('finalizes a durably accepted manual write in the same session without admitting bytes twice', async () => {
    const harness = createHarness();
    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);
    const clear = vi.mocked(harness.persistence.repository.clearAfterAcceptedOutcome);
    clear.mockRejectedValueOnce(new Error('temporary compare-clear failure'));

    await expect(harness.runtime.service.sendManually(MANUAL_REQUEST)).resolves.toMatchObject({
      kind: 'operation',
      operation: {
        manualSendOperationId: MANUAL_REQUEST.manualSendOperationId,
        phase: 'write-accepted',
      },
      replayed: false,
    });
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(harness.getDraft()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);

    await expect(harness.runtime.service.getProjection(REQUEST.deliveryId)).resolves.toMatchObject({
      currentDraft: null,
      manualSendOperation: {
        manualSendOperationId: MANUAL_REQUEST.manualSendOperationId,
        phase: 'completed',
      },
    });
    expect(clear).toHaveBeenCalledTimes(2);
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    await expect(harness.journal.load(REQUEST.deliveryId)).resolves.toMatchObject({
      editHighWater: {
        editSealed: true,
        highestEditRevision: MANUAL_REQUEST.expectedEditRevision,
        highestInputFingerprint: MANUAL_REQUEST.expectedDraftFingerprint,
      },
      manualSendOperation: { phase: 'completed' },
    });
  });

  it('keeps accepted-write finalization armed after a stale competing send is rejected', async () => {
    const harness = createHarness();
    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);
    const clear = vi.mocked(harness.persistence.repository.clearAfterAcceptedOutcome);
    clear.mockRejectedValueOnce(new Error('temporary compare-clear failure'));

    await expect(harness.runtime.service.sendManually(MANUAL_REQUEST)).resolves.toMatchObject({
      operation: { phase: 'write-accepted' },
    });
    const competingFingerprint = 'cd'.repeat(32);
    await expect(
      harness.runtime.service.sendManually({
        ...MANUAL_REQUEST,
        expectedDraftFingerprint: competingFingerprint,
        expectedEditRevision: 1,
        manualSendOperationId: deriveManualInitialPromptSendOperationId({
          acknowledgedDraftFingerprint: competingFingerprint,
          acknowledgedEditRevision: 1,
          deliveryId: MANUAL_REQUEST.deliveryId,
        }),
      }),
    ).resolves.toMatchObject({
      issue: { code: 'draft-changed' },
      kind: 'domain-rejected',
    });

    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);

    await expect(harness.runtime.service.getProjection(REQUEST.deliveryId)).resolves.toMatchObject({
      currentDraft: null,
      manualSendOperation: {
        manualSendOperationId: MANUAL_REQUEST.manualSendOperationId,
        phase: 'completed',
      },
    });
    expect(clear).toHaveBeenCalledTimes(2);
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
  });

  it('rearms accepted-write finalization when availability changes after its durable probe', async () => {
    const harness = createHarness();
    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);
    const clear = vi.mocked(harness.persistence.repository.clearAfterAcceptedOutcome);
    clear.mockRejectedValueOnce(new Error('temporary compare-clear failure'));

    await expect(harness.runtime.service.sendManually(MANUAL_REQUEST)).resolves.toMatchObject({
      operation: { phase: 'write-accepted' },
    });
    vi.mocked(harness.persistence.repository.loadCurrentDraft).mockImplementationOnce(async () => {
      harness.journal.setAvailable(false);
      const current = harness.getDraft();
      return current ? structuredClone(current) : null;
    });

    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);
    await expect(harness.journal.load(REQUEST.deliveryId)).resolves.toMatchObject({
      manualSendOperation: { phase: 'write-accepted' },
    });
    expect(clear).toHaveBeenCalledTimes(1);

    harness.journal.setAvailable(true);
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);

    await expect(harness.runtime.service.getProjection(REQUEST.deliveryId)).resolves.toMatchObject({
      currentDraft: null,
      manualSendOperation: { phase: 'completed' },
    });
    expect(clear).toHaveBeenCalledTimes(2);
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
  });

  it('proves an exact durable write after the initiating call throws before finalizing it', async () => {
    const harness = createHarness();
    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);
    const originalSave = harness.journal.save.bind(harness.journal);
    let threwAfterAcceptedSave = false;
    vi.spyOn(harness.journal, 'save').mockImplementation(async (record) => {
      await originalSave(record);
      if (!threwAfterAcceptedSave && record.manualSendOperation?.phase === 'write-accepted') {
        threwAfterAcceptedSave = true;
        throw new Error('lost response after durable write acceptance');
      }
    });
    const clear = vi.mocked(harness.persistence.repository.clearAfterAcceptedOutcome);

    await expect(harness.runtime.service.sendManually(MANUAL_REQUEST)).rejects.toThrow(
      'lost response after durable write acceptance',
    );
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
    await expect(harness.journal.load(REQUEST.deliveryId)).resolves.toMatchObject({
      manualSendOperation: {
        manualSendOperationId: MANUAL_REQUEST.manualSendOperationId,
        phase: 'write-accepted',
      },
    });

    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);

    await expect(harness.runtime.service.getProjection(REQUEST.deliveryId)).resolves.toMatchObject({
      currentDraft: null,
      manualSendOperation: { phase: 'completed' },
    });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending manual finalization timer when the runtime closes', async () => {
    const harness = createHarness();
    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);
    const clear = vi.mocked(harness.persistence.repository.clearAfterAcceptedOutcome);
    clear.mockRejectedValueOnce(new Error('temporary compare-clear failure'));
    await expect(harness.runtime.service.sendManually(MANUAL_REQUEST)).resolves.toMatchObject({
      operation: { phase: 'write-accepted' },
    });

    await harness.runtime.close();
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS * 2);

    expect(clear).toHaveBeenCalledTimes(1);
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
  });

  it('serializes initial delivery and ordinary input on the shared per-agent admission tail', async () => {
    let releaseInitialSubmit!: () => void;
    let markInitialSubmitStarted!: () => void;
    const initialSubmitStarted = new Promise<void>((resolve) => {
      markInitialSubmitStarted = resolve;
    });
    const harness = createHarness({
      draftText: 'Inspect line one\nand line two',
      promptAdmissionSleep: () =>
        new Promise<void>((resolve) => {
          releaseInitialSubmit = resolve;
          markInitialSubmitStarted();
        }),
    });
    const sendOrdinary = createOrdinaryTaskPromptInputHandler({
      admission: harness.promptInputAdmission,
      getAgentGeneration: harness.promptInputState.getAgentGeneration,
      getAgentMetadata: harness.promptInputState.getAgentMetadata,
      getLeaseIdentity: () => ({
        clientId: 'client-1',
        leaseGeneration: 9,
        ownerId: 'owner-1',
      }),
      getSupervisionSnapshot: harness.promptInputState.getSupervisionSnapshot,
    });

    await harness.runtime.activate();
    await harness.runtime.service.queue(REQUEST);
    await vi.advanceTimersByTimeAsync(TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS);
    await initialSubmitStarted;
    expect(harness.writeFrame.mock.calls).toEqual([
      ['agent-1', '\x1b[200~Inspect line one\nand line two\x1b[201~'],
    ]);

    const ordinary = sendOrdinary({
      agentId: 'agent-1',
      controllerId: 'client-1',
      taskId: 'task-1',
      text: 'do not interleave',
    });
    await Promise.resolve();
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);

    harness.setTaskClosing(true);
    releaseInitialSubmit();

    await expect(ordinary).resolves.toEqual({
      admission: {
        kind: 'rejected-before-bytes',
        reason: 'task-closing',
      },
    });
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
    await harness.runtime.close();
  });
});
