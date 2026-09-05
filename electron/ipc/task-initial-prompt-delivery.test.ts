import { describe, expect, it, vi } from 'vitest';

import {
  MANUAL_INITIAL_PROMPT_SEND_RATE_LIMIT,
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  TASK_INITIAL_PROMPT_READY_DEADLINE_MS,
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS,
  TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS,
  deriveManualInitialPromptSendOperationId,
  deriveTaskInitialPromptDraftFingerprint,
  reduceTaskInitialPromptDelivery,
  type ReviseTaskInitialPromptDraftRequest,
  type SendTaskInitialPromptManuallyRequest,
  type TaskInitialPromptDraftSnapshot,
  type TaskInitialPromptOwnerAvailability,
} from '../../src/domain/task-initial-prompt-delivery.js';
import type { PromptInputAdmissionResult } from '../../src/domain/task-prompt-input-admission.js';
import {
  TASK_INITIAL_PROMPT_AUTOMATIC_RICH_REPLAY_LIMIT,
  createMemoryTaskInitialPromptDeliveryJournal,
  createTaskInitialPromptDeliveryService,
  type TaskInitialPromptCommandLease,
  type TaskInitialPromptDeliveryDependencies,
} from './task-initial-prompt-delivery.js';

const CUTOVER_EPOCH = 'removal-cutover-test-v1';
const TEST_FINGERPRINT = 'ab'.repeat(32);

function createHarness(
  options: {
    admission?: PromptInputAdmissionResult;
    availability?: TaskInitialPromptOwnerAvailability;
    prompt?: string;
  } = {},
) {
  let nowMs = 1_000;
  let draft: TaskInitialPromptDraftSnapshot | null;
  const prompt = options.prompt ?? 'Ship it';
  const fingerprint = deriveTaskInitialPromptDraftFingerprint({
    agentId: 'agent-1',
    readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
    taskId: 'task-1',
    text: prompt,
  });
  draft = {
    editRevision: 0,
    fingerprint,
    mode: 'automatic',
    text: prompt,
    workspaceRevision: 1,
  };
  const availability =
    options.availability ??
    ({
      cutoverEpoch: CUTOVER_EPOCH,
      hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
      kind: 'active',
    } satisfies TaskInitialPromptOwnerAvailability);
  const journal = createMemoryTaskInitialPromptDeliveryJournal();
  const releaseCommandLease = vi.fn();
  const acquireCommandLease = vi.fn(
    async (): Promise<TaskInitialPromptCommandLease | null> => ({
      controllerId: 'client-1',
      leaseGeneration: 7,
      leaseOwnerId: 'owner-1',
      release: releaseCommandLease,
    }),
  );
  const admitPrompt = vi.fn(
    async (
      _expectation: Parameters<TaskInitialPromptDeliveryDependencies['admitPrompt']>[0],
      _dispatch: Parameters<TaskInitialPromptDeliveryDependencies['admitPrompt']>[1],
    ) =>
      options.admission ??
      ({
        admittedSupervisionVersion: 4,
        kind: 'accepted',
        lowLevelCallCount: 1,
      } satisfies PromptInputAdmissionResult),
  );
  const dependencies: TaskInitialPromptDeliveryDependencies = {
    acquireCommandLease,
    admitPrompt,
    clock: {
      nowMs: () => nowMs,
      sleep: async (delayMs) => {
        nowMs += delayMs;
      },
      toIso: (ms) => new Date(ms).toISOString(),
    },
    draftRepository: {
      async clearAfterAcceptedOutcome(args) {
        const record = await journal.load(args.deliveryId);
        if (!draft) {
          if (record) {
            record.editHighWater = {
              editSealed: true,
              highestEditRevision: args.expectedEditRevision,
              highestInputFingerprint: args.expectedDraftFingerprint,
              highestOperationId: record.editHighWater?.highestOperationId ?? 'clear',
            };
            await journal.save(record);
          }
          return { kind: 'already-cleared', workspaceRevision: 2 };
        }
        if (
          draft.fingerprint !== args.expectedDraftFingerprint ||
          draft.editRevision !== args.expectedEditRevision
        ) {
          return { kind: 'draft-changed', workspaceRevision: draft.workspaceRevision };
        }
        draft = null;
        if (record) {
          record.editHighWater = {
            editSealed: true,
            highestEditRevision: args.expectedEditRevision,
            highestInputFingerprint: args.expectedDraftFingerprint,
            highestOperationId: record.editHighWater?.highestOperationId ?? 'clear',
          };
          await journal.save(record);
        }
        return { kind: 'cleared', workspaceRevision: 2 };
      },
      async loadCurrentDraft() {
        return draft ? structuredClone(draft) : null;
      },
      async loadExactDraft(args) {
        if (
          !draft ||
          draft.fingerprint !== args.expectedDraftFingerprint ||
          (args.expectedEditRevision !== undefined &&
            draft.editRevision !== args.expectedEditRevision)
        ) {
          throw new Error('draft changed');
        }
        return structuredClone(draft);
      },
      async reviseAfterUserEdit(request: ReviseTaskInitialPromptDraftRequest) {
        const record = await journal.load(request.sourceDeliveryId);
        if (!record || record.editHighWater?.editSealed || !draft) {
          return { current: draft, kind: 'delivery-closed' };
        }
        const nextRevision = request.expectedEditRevision + 1;
        if (
          record.editHighWater?.highestOperationId === request.editOperationId &&
          record.editHighWater.highestEditRevision === nextRevision
        ) {
          return { current: structuredClone(draft), kind: 'replayed' };
        }
        if (
          record.editHighWater &&
          record.editHighWater.highestEditRevision > request.expectedEditRevision
        ) {
          return {
            current: structuredClone(draft),
            kind:
              record.editHighWater.highestEditRevision === nextRevision
                ? 'draft-conflict'
                : 'stale-edit',
          } as const;
        }
        if (
          draft.fingerprint !== request.expectedDraftFingerprint ||
          draft.editRevision !== request.expectedEditRevision
        ) {
          return { current: draft, kind: 'draft-conflict' };
        }
        const nextFingerprint = deriveTaskInitialPromptDraftFingerprint({
          agentId: 'agent-1',
          readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
          taskId: request.taskId,
          text: request.revisedText,
        });
        draft = {
          editRevision: nextRevision,
          fingerprint: nextFingerprint,
          mode: 'manual-only',
          text: request.revisedText,
          workspaceRevision: draft.workspaceRevision + 1,
        };
        record.draftEditRevision = nextRevision;
        record.expectedDraftFingerprint = nextFingerprint;
        record.editHighWater = {
          editSealed: false,
          highestEditRevision: nextRevision,
          highestInputFingerprint: nextFingerprint,
          highestOperationId: request.editOperationId,
        };
        record.snapshot = reduceTaskInitialPromptDelivery(
          record.snapshot,
          { kind: 'edit-accepted' },
          new Date(nowMs).toISOString(),
        ).snapshot;
        await journal.save(record);
        return { current: structuredClone(draft), kind: 'saved-manual-draft' };
      },
    },
    getAgentRuntime: () => ({
      generation: 3,
      lastOutputAtMs: 0,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
      taskId: 'task-1',
    }),
    getOwnerAvailability: vi.fn(() => availability),
    journal,
    removalGate: {
      getTaskSnapshot: vi.fn(() => ({
        current: {
          catalogVersion: 1,
          serverInstanceId: 'server-1',
          taskClosing: false,
          taskState: 'present' as const,
        },
        cutoverEpoch: CUTOVER_EPOCH,
        hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
        kind: 'active' as const,
      })),
      verifyCommittedRemoval: vi.fn(() => true),
    },
  };
  const service = createTaskInitialPromptDeliveryService(dependencies);
  const deliveryRequest = {
    agentId: 'agent-1',
    deliveryId: 'delivery-1',
    expectedDraftFingerprint: fingerprint,
    readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
    taskId: 'task-1',
  } as const;
  const manualRequest = (overrides: Partial<SendTaskInitialPromptManuallyRequest> = {}) => ({
    action: { kind: 'send' } as const,
    agentId: 'agent-1',
    confirmPossiblePriorAutomaticWrite: false,
    deliveryId: 'delivery-1',
    expectedAgentGeneration: 3,
    expectedDraftFingerprint: draft?.fingerprint ?? fingerprint,
    expectedEditRevision: draft?.editRevision ?? 0,
    manualSendOperationId: deriveManualInitialPromptSendOperationId({
      acknowledgedDraftFingerprint: draft?.fingerprint ?? fingerprint,
      acknowledgedEditRevision: draft?.editRevision ?? 0,
      deliveryId: 'delivery-1',
    }),
    taskId: 'task-1',
    ...overrides,
  });
  return {
    acquireCommandLease,
    admitPrompt,
    deliveryRequest,
    dependencies,
    getDraft: () => draft,
    journal,
    manualRequest,
    releaseCommandLease,
    service,
    setNowMs: (next: number) => {
      nowMs = next;
    },
  };
}

async function advanceToAutomaticVerification(
  harness: ReturnType<typeof createHarness>,
): Promise<void> {
  await harness.service.queue(harness.deliveryRequest);
  await harness.service.processObservation('delivery-1', {
    agentId: 'agent-1',
    generation: 3,
    lastOutputAtMs: 0,
    nowMs: 2_000,
    state: 'idle-at-prompt',
    supervisionVersion: 4,
    tail: '❯',
  });
  harness.setNowMs(2_600);
  await harness.service.processObservation('delivery-1', {
    agentId: 'agent-1',
    generation: 3,
    lastOutputAtMs: 0,
    nowMs: 2_600,
    state: 'idle-at-prompt',
    supervisionVersion: 4,
    tail: '❯',
  });
  await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
    snapshot: { attempts: 1, status: 'verifying' },
    writeBegan: true,
  });
}

async function completeManualSendWithRetainedLease(
  harness: ReturnType<typeof createHarness>,
  releaseFailureCount = 1,
) {
  await harness.service.queue(harness.deliveryRequest);
  const releaseManualLease = vi.fn();
  for (let index = 0; index < releaseFailureCount; index += 1) {
    releaseManualLease.mockRejectedValueOnce(new Error('manual lease release unavailable'));
  }
  harness.acquireCommandLease.mockResolvedValueOnce({
    controllerId: 'manual-client-1',
    leaseGeneration: 8,
    leaseOwnerId: 'manual-owner-1',
    release: releaseManualLease,
  });
  const request = harness.manualRequest();
  await expect(harness.service.sendManually(request)).rejects.toThrow(
    'manual lease release unavailable',
  );
  await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
    automationSealed: true,
    manualSendOperation: {
      manualSendOperationId: request.manualSendOperationId,
      phase: 'completed',
    },
  });
  return { releaseManualLease, request };
}

function setRemovalGate(harness: ReturnType<typeof createHarness>, taskClosing: boolean): void {
  vi.mocked(harness.dependencies.removalGate.getTaskSnapshot).mockReturnValue({
    current: {
      catalogVersion: taskClosing ? 2 : 3,
      serverInstanceId: 'server-1',
      taskClosing,
      taskState: 'present',
    },
    cutoverEpoch: CUTOVER_EPOCH,
    hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
    kind: 'active',
  });
}

describe('dark initial prompt delivery owner', () => {
  it('bounds acknowledged rich automatic replay while retaining compact identity and unsafe records', async () => {
    const journal = createMemoryTaskInitialPromptDeliveryJournal();
    const total = TASK_INITIAL_PROMPT_AUTOMATIC_RICH_REPLAY_LIMIT + 8;
    for (let index = 0; index < total; index += 1) {
      const deliveryId = `delivery-${String(index).padStart(4, '0')}`;
      const updatedAt = new Date(index * 1_000).toISOString();
      await journal.save({
        automationSealed: false,
        draftEditRevision: 0,
        editHighWater: {
          editSealed: true,
          highestEditRevision: 0,
          highestInputFingerprint: TEST_FINGERPRINT,
          highestOperationId: 'clear',
        },
        expectedDraftFingerprint: TEST_FINGERPRINT,
        preWriteReadyFingerprint: TEST_FINGERPRINT,
        readyCandidate: {
          generation: 0,
          normalizedFrameFingerprint: TEST_FINGERPRINT,
          observedAtMs: index,
        },
        request: {
          agentId: 'agent-1',
          deliveryId,
          expectedDraftFingerprint: TEST_FINGERPRINT,
          readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
          taskId: 'task-replay-window',
        },
        schemaVersion: 1,
        snapshot: {
          agentId: 'agent-1',
          attempts: 1,
          createdAt: updatedAt,
          deliveryId,
          status: 'delivered',
          targetGeneration: 0,
          taskId: 'task-replay-window',
          updatedAt,
          version: 4,
        },
        writeBegan: true,
      });
    }
    await journal.save({
      automationSealed: false,
      draftEditRevision: 0,
      expectedDraftFingerprint: TEST_FINGERPRINT,
      preWriteReadyFingerprint: TEST_FINGERPRINT,
      readyCandidate: {
        generation: 0,
        normalizedFrameFingerprint: TEST_FINGERPRINT,
        observedAtMs: total,
      },
      request: {
        agentId: 'agent-1',
        deliveryId: 'ambiguous-delivery',
        expectedDraftFingerprint: TEST_FINGERPRINT,
        readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
        taskId: 'task-replay-window',
      },
      schemaVersion: 1,
      snapshot: {
        agentId: 'agent-1',
        attempts: 0,
        createdAt: new Date(total * 1_000).toISOString(),
        deliveryId: 'ambiguous-delivery',
        reason: 'backend-recovered-ambiguous-write',
        status: 'manual-required',
        targetGeneration: 0,
        taskId: 'task-replay-window',
        updatedAt: new Date(total * 1_000).toISOString(),
        version: 3,
      },
      writeBegan: true,
    });

    const retained = await journal.listRecords();
    const richAcknowledged = retained.filter(
      (record) => record.snapshot.status === 'delivered' && record.readyCandidate !== undefined,
    );
    expect(richAcknowledged).toHaveLength(TASK_INITIAL_PROMPT_AUTOMATIC_RICH_REPLAY_LIMIT);
    await expect(journal.load('delivery-0000')).resolves.toMatchObject({
      editHighWater: { editSealed: true },
      snapshot: { status: 'delivered' },
    });
    expect(await journal.load('delivery-0000')).not.toHaveProperty('readyCandidate');
    expect(await journal.load(`delivery-${String(total - 1).padStart(4, '0')}`)).toHaveProperty(
      'readyCandidate',
    );
    expect(await journal.load('ambiguous-delivery')).toHaveProperty('readyCandidate');
    expect(
      new TextEncoder().encode(JSON.stringify(await journal.load('delivery-0000'))).byteLength,
    ).toBeLessThan(2_048);

    await expect(journal.deleteTaskRecords('task-replay-window')).resolves.toBe('complete');
    expect(journal.recordCount()).toBe(0);
  });

  it('rejects every public effect entrypoint before journal, draft, lease, or PTY work', async () => {
    const harness = createHarness({
      availability: { kind: 'dark', reason: 'delivery-owner-dark' },
    });
    const journalLoad = vi.spyOn(harness.journal, 'load');
    const draftLoad = vi.spyOn(harness.dependencies.draftRepository, 'loadExactDraft');

    await expect(harness.service.queue(harness.deliveryRequest)).resolves.toEqual({
      kind: 'admission-unavailable',
      reason: 'delivery-owner-dark',
      replayed: false,
    });
    await expect(harness.service.sendManually(harness.manualRequest())).resolves.toMatchObject({
      error: {
        code: 'task-removal-gate-unavailable',
        state: 'delivery-owner-dark',
      },
      kind: 'admission-rejected',
    });
    await expect(
      harness.service.reviseDraft({
        editOperationId: 'edit-1',
        expectedDraftFingerprint: harness.deliveryRequest.expectedDraftFingerprint,
        expectedEditRevision: 0,
        revisedText: 'changed',
        sourceDeliveryId: 'delivery-1',
        taskId: 'task-1',
      }),
    ).resolves.toEqual({
      kind: 'admission-unavailable',
      reason: 'delivery-owner-dark',
    });
    expect(journalLoad).not.toHaveBeenCalled();
    expect(draftLoad).not.toHaveBeenCalled();
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();
    expect(harness.journal.recordCount()).toBe(0);
  });

  it('single-flights queue identity and rejects a conflicting replay', async () => {
    const harness = createHarness();
    await expect(harness.service.queue(harness.deliveryRequest)).resolves.toMatchObject({
      kind: 'accepted',
      replayed: false,
    });
    await expect(harness.service.queue(harness.deliveryRequest)).resolves.toMatchObject({
      kind: 'accepted',
      replayed: true,
    });
    await expect(
      harness.service.queue({ ...harness.deliveryRequest, agentId: 'agent-2' }),
    ).rejects.toMatchObject({ code: 'bad-request' });
    expect(harness.journal.recordCount()).toBe(1);
  });

  it('does not create a delivery when removal begins during queue draft loading', async () => {
    const harness = createHarness();
    const exactDraft = harness.getDraft();
    if (!exactDraft) throw new Error('automatic draft is missing');
    let resolveDraft!: (draft: TaskInitialPromptDraftSnapshot) => void;
    const loadExactDraft = vi
      .spyOn(harness.dependencies.draftRepository, 'loadExactDraft')
      .mockImplementationOnce(
        () =>
          new Promise<TaskInitialPromptDraftSnapshot>((resolve) => {
            resolveDraft = resolve;
          }),
      );
    const journalSave = vi.spyOn(harness.journal, 'save');

    const queued = harness.service.queue(harness.deliveryRequest);
    await vi.waitFor(() => expect(loadExactDraft).toHaveBeenCalledTimes(1));
    vi.mocked(harness.dependencies.removalGate.getTaskSnapshot).mockReturnValue({
      current: {
        catalogVersion: 2,
        serverInstanceId: 'server-1',
        taskClosing: true,
        taskState: 'present',
      },
      cutoverEpoch: CUTOVER_EPOCH,
      hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
      kind: 'active',
    });
    resolveDraft(structuredClone(exactDraft));

    await expect(queued).resolves.toEqual({
      kind: 'admission-unavailable',
      reason: 'task-removal-gate-unavailable',
      replayed: false,
    });
    expect(journalSave).not.toHaveBeenCalled();
    expect(harness.journal.recordCount()).toBe(0);
    await expect(harness.journal.load('delivery-1')).resolves.toBeNull();
  });

  it('rejects a manual send whose serialized turn starts after removal begins', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const retained = await harness.journal.load('delivery-1');
    if (!retained) throw new Error('queued delivery record is missing');
    let resolvePredecessor!: (record: Awaited<ReturnType<typeof harness.journal.load>>) => void;
    const journalLoad = vi.spyOn(harness.journal, 'load').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePredecessor = resolve;
        }),
    );
    const predecessor = harness.service.expireDueDelivery('delivery-1', 2_000);
    await vi.waitFor(() => expect(journalLoad).toHaveBeenCalledTimes(1));
    const request = harness.manualRequest();
    const manualSend = harness.service.sendManually(request);

    setRemovalGate(harness, true);
    resolvePredecessor(structuredClone(retained));

    await expect(predecessor).resolves.toMatchObject({
      kind: 'admission-unavailable',
      reason: 'task-removal-gate-unavailable',
    });
    await expect(manualSend).resolves.toMatchObject({
      issue: { code: 'task-closing' },
      kind: 'domain-rejected',
    });
    const record = await harness.journal.load('delivery-1');
    expect(record).not.toHaveProperty('manualSendOperation');
    expect(record).toMatchObject({ automationSealed: false });
    expect(harness.getDraft()).toMatchObject({ editRevision: 0, text: 'Ship it' });
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();
    expect(harness.releaseCommandLease).not.toHaveBeenCalled();
  });

  it('rejects a manual send when removal begins during exact-draft loading without charging rate', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const exactDraft = harness.getDraft();
    if (!exactDraft) throw new Error('automatic draft is missing');
    let resolveDraft!: (draft: TaskInitialPromptDraftSnapshot) => void;
    const loadExactDraft = vi
      .spyOn(harness.dependencies.draftRepository, 'loadExactDraft')
      .mockImplementationOnce(
        () =>
          new Promise<TaskInitialPromptDraftSnapshot>((resolve) => {
            resolveDraft = resolve;
          }),
      );
    const request = harness.manualRequest();
    const manualSend = harness.service.sendManually(request);
    await vi.waitFor(() => expect(loadExactDraft).toHaveBeenCalledTimes(1));

    setRemovalGate(harness, true);
    resolveDraft(structuredClone(exactDraft));

    await expect(manualSend).resolves.toMatchObject({
      issue: { code: 'task-closing' },
      kind: 'domain-rejected',
    });
    let record = await harness.journal.load('delivery-1');
    expect(record).not.toHaveProperty('manualSendOperation');
    expect(record).toMatchObject({ automationSealed: false });
    expect(harness.getDraft()).toMatchObject({ editRevision: 0, text: 'Ship it' });
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();

    setRemovalGate(harness, false);
    harness.dependencies.getAgentRuntime = () => ({
      generation: 3,
      lastOutputAtMs: 0,
      state: 'active',
      supervisionVersion: 4,
      tail: 'working',
      taskId: 'task-1',
    });
    await expect(harness.service.sendManually(request)).resolves.toMatchObject({
      operation: { attempt: 1, phase: 'failed-before-write' },
    });
    await expect(
      harness.service.sendManually(
        harness.manualRequest({ action: { failedAttempt: 1, kind: 'retry-proven-not-sent' } }),
      ),
    ).resolves.toMatchObject({
      operation: { attempt: 2, phase: 'failed-before-write' },
    });
    await expect(
      harness.service.sendManually(
        harness.manualRequest({ action: { failedAttempt: 2, kind: 'retry-proven-not-sent' } }),
      ),
    ).resolves.toMatchObject({
      operation: { attempt: 3, phase: 'failed-before-write' },
    });
    record = await harness.journal.load('delivery-1');
    expect(record).toMatchObject({ manualSendOperation: { attempt: 3 } });
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();
  });

  it('does not mutate a draft whose serialized edit turn starts after removal begins', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const retained = await harness.journal.load('delivery-1');
    if (!retained) throw new Error('queued delivery record is missing');
    let resolvePredecessor!: (record: Awaited<ReturnType<typeof harness.journal.load>>) => void;
    const journalLoad = vi.spyOn(harness.journal, 'load').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePredecessor = resolve;
        }),
    );
    const predecessor = harness.service.expireDueDelivery('delivery-1', 2_000);
    await vi.waitFor(() => expect(journalLoad).toHaveBeenCalledTimes(1));
    const reviseAfterUserEdit = vi.spyOn(
      harness.dependencies.draftRepository,
      'reviseAfterUserEdit',
    );
    const edit = harness.service.reviseDraft({
      editOperationId: 'edit-during-removal-race',
      expectedDraftFingerprint: harness.deliveryRequest.expectedDraftFingerprint,
      expectedEditRevision: 0,
      revisedText: 'must not persist',
      sourceDeliveryId: 'delivery-1',
      taskId: 'task-1',
    });

    setRemovalGate(harness, true);
    resolvePredecessor(structuredClone(retained));

    await expect(predecessor).resolves.toMatchObject({
      kind: 'admission-unavailable',
      reason: 'task-removal-gate-unavailable',
    });
    await expect(edit).resolves.toEqual({
      kind: 'admission-unavailable',
      reason: 'task-removal-gate-unavailable',
    });
    expect(reviseAfterUserEdit).not.toHaveBeenCalled();
    expect(harness.getDraft()).toMatchObject({ editRevision: 0, text: 'Ship it' });
    const record = await harness.journal.load('delivery-1');
    expect(record).not.toHaveProperty('editHighWater');
    expect(record).toMatchObject({ draftEditRevision: 0 });
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();
    expect(harness.releaseCommandLease).not.toHaveBeenCalled();
  });

  it('does not start or expire the readiness deadline while no agent session exists', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);

    const farBeyondAnyReadinessWindow = 1_000 + TASK_INITIAL_PROMPT_READY_DEADLINE_MS * 10;
    await expect(
      harness.service.expireDueDelivery('delivery-1', farBeyondAnyReadinessWindow),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { status: 'waiting-agent-session' },
    });
    const record = await harness.journal.load('delivery-1');
    expect(record).not.toHaveProperty('automaticReadyDeadlineAtMs');
    expect(record).not.toHaveProperty('automaticReadyDeadlineExtensionUsed');
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();
  });

  it('gives a late first admitted agent generation its complete readiness window', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const admittedAtMs = 1_000 + TASK_INITIAL_PROMPT_READY_DEADLINE_MS * 10;

    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: admittedAtMs,
      nowMs: admittedAtMs,
      state: 'active',
      supervisionVersion: 4,
      tail: 'starting',
    });
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      automaticReadyDeadlineAtMs: admittedAtMs + TASK_INITIAL_PROMPT_READY_DEADLINE_MS,
      automaticReadyDeadlineExtensionUsed: false,
      snapshot: { status: 'waiting-ready', targetGeneration: 3 },
    });

    await expect(
      harness.service.expireDueDelivery(
        'delivery-1',
        admittedAtMs + TASK_INITIAL_PROMPT_READY_DEADLINE_MS - 1,
      ),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { status: 'waiting-ready' },
    });
    await expect(
      harness.service.expireDueDelivery(
        'delivery-1',
        admittedAtMs + TASK_INITIAL_PROMPT_READY_DEADLINE_MS,
      ),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { reason: 'verification-inconclusive', status: 'manual-required' },
    });
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();
  });

  it('extends the pre-write readiness deadline for only the first generation change', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const firstGenerationAtMs = 2_000;
    const firstChangeAtMs = 20_000;
    const secondChangeAtMs = 30_000;

    for (const [generation, nowMs] of [
      [3, firstGenerationAtMs],
      [4, firstChangeAtMs],
      [5, secondChangeAtMs],
    ] as const) {
      await harness.service.processObservation('delivery-1', {
        agentId: 'agent-1',
        generation,
        lastOutputAtMs: nowMs,
        nowMs,
        state: 'active',
        supervisionVersion: generation + 1,
        tail: 'starting',
      });
    }

    const extendedDeadlineAtMs = firstChangeAtMs + TASK_INITIAL_PROMPT_READY_DEADLINE_MS;
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      automaticReadyDeadlineAtMs: extendedDeadlineAtMs,
      automaticReadyDeadlineExtensionUsed: true,
      snapshot: { status: 'waiting-ready', targetGeneration: 5 },
      writeBegan: false,
    });
    await expect(
      harness.service.expireDueDelivery('delivery-1', extendedDeadlineAtMs - 1),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { status: 'waiting-ready', targetGeneration: 5 },
    });
    await expect(
      harness.service.expireDueDelivery('delivery-1', extendedDeadlineAtMs),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { reason: 'verification-inconclusive', status: 'manual-required' },
    });
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();
  });

  it('drops generation-scoped readiness evidence before persisting a generation change', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_000,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      readyCandidate: { generation: 3 },
      snapshot: { targetGeneration: 3 },
    });

    await expect(
      harness.service.processObservation('delivery-1', {
        agentId: 'agent-1',
        generation: 4,
        lastOutputAtMs: 0,
        nowMs: 2_100,
        state: 'idle-at-prompt',
        supervisionVersion: 5,
        tail: '❯',
      }),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { status: 'waiting-ready', targetGeneration: 4 },
    });
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      automaticReadyDeadlineExtensionUsed: true,
      readyCandidate: { generation: 4 },
      snapshot: { targetGeneration: 4 },
    });
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();
  });

  it('expires verification without a runtime and releases its command lease exactly once', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_000,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    const writeAcceptedAtMs = 2_600;
    harness.setNowMs(writeAcceptedAtMs);
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: writeAcceptedAtMs,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: { attempts: 1, status: 'verifying' },
      writeBegan: true,
    });
    expect(harness.releaseCommandLease).not.toHaveBeenCalled();

    await expect(
      harness.service.expireDueDelivery(
        'delivery-1',
        writeAcceptedAtMs + TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS - 1,
      ),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { status: 'verifying' },
    });
    await expect(
      harness.service.expireDueDelivery(
        'delivery-1',
        writeAcceptedAtMs + TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS,
      ),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { reason: 'verification-inconclusive', status: 'manual-required' },
    });
    await harness.service.expireDueDelivery(
      'delivery-1',
      writeAcceptedAtMs + TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS * 2,
    );
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(1);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it('retries a failed lease release after durably expiring verification', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_000,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    const acceptedAtMs = 2_600;
    harness.setNowMs(acceptedAtMs);
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: acceptedAtMs,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    harness.releaseCommandLease
      .mockRejectedValueOnce(new Error('lease release unavailable'))
      .mockResolvedValueOnce(undefined);
    const expiredAtMs = acceptedAtMs + TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS;

    await expect(harness.service.expireDueDelivery('delivery-1', expiredAtMs)).rejects.toThrow(
      'lease release unavailable',
    );
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: {
        attempts: 1,
        reason: 'verification-inconclusive',
        status: 'manual-required',
      },
    });
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(1);

    await expect(
      harness.service.expireDueDelivery('delivery-1', expiredAtMs + 1),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { status: 'manual-required' },
    });
    await harness.service.expireDueDelivery('delivery-1', expiredAtMs + 2);
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(2);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it('starts the verification window when asynchronous admission is actually accepted', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const readyObservedAtMs = 2_000;
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: readyObservedAtMs,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });

    let resolveAdmission!: (result: PromptInputAdmissionResult) => void;
    harness.admitPrompt.mockImplementationOnce(
      () =>
        new Promise<PromptInputAdmissionResult>((resolve) => {
          resolveAdmission = resolve;
        }),
    );
    harness.setNowMs(readyObservedAtMs + 600);
    const delivery = harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: readyObservedAtMs + 600,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    await vi.waitFor(() => expect(harness.admitPrompt).toHaveBeenCalledTimes(1));

    const acceptedAtMs = 30_000;
    harness.setNowMs(acceptedAtMs);
    resolveAdmission({
      admittedSupervisionVersion: 4,
      kind: 'accepted',
      lowLevelCallCount: 1,
    });

    await expect(delivery).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: {
        attempts: 1,
        status: 'verifying',
        updatedAt: new Date(acceptedAtMs).toISOString(),
      },
    });
    await expect(
      harness.service.expireDueDelivery(
        'delivery-1',
        acceptedAtMs + TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS - 1,
      ),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { status: 'verifying' },
    });
    await expect(
      harness.service.expireDueDelivery(
        'delivery-1',
        acceptedAtMs + TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS,
      ),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { reason: 'verification-inconclusive', status: 'manual-required' },
    });
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(1);
  });

  it('does not retry late absence evidence after the verification deadline', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const readyObservedAtMs = 2_000;
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: readyObservedAtMs,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    const acceptedAtMs = readyObservedAtMs + 600;
    harness.setNowMs(acceptedAtMs);
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: acceptedAtMs,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: {
        attempts: 1,
        status: 'verifying',
        updatedAt: new Date(acceptedAtMs).toISOString(),
      },
    });

    const verificationDeadlineAtMs = acceptedAtMs + TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS;
    await expect(
      harness.service.processObservation('delivery-1', {
        activityTransitionObserved: false,
        agentId: 'agent-1',
        generation: 3,
        lastOutputAtMs: 0,
        nowMs: verificationDeadlineAtMs,
        returnedToReadySnapshot: true,
        state: 'idle-at-prompt',
        supervisionVersion: 5,
        tail: '❯',
      }),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: {
        attempts: 1,
        reason: 'verification-inconclusive',
        status: 'manual-required',
      },
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(1);
  });

  it('does not retry absence evidence when draft loading crosses the verification deadline', async () => {
    const harness = createHarness();
    await advanceToAutomaticVerification(harness);
    const exactDraft = harness.getDraft();
    if (!exactDraft) throw new Error('automatic draft is missing');
    let resolveDraft!: (draft: TaskInitialPromptDraftSnapshot) => void;
    const loadExactDraft = vi
      .spyOn(harness.dependencies.draftRepository, 'loadExactDraft')
      .mockImplementationOnce(
        () =>
          new Promise<TaskInitialPromptDraftSnapshot>((resolve) => {
            resolveDraft = resolve;
          }),
      );
    const absenceObservationAtMs = 3_200;
    const observation = harness.service.processObservation('delivery-1', {
      activityTransitionObserved: false,
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: absenceObservationAtMs,
      returnedToReadySnapshot: true,
      state: 'idle-at-prompt',
      supervisionVersion: 5,
      tail: '❯',
    });
    await vi.waitFor(() => expect(loadExactDraft).toHaveBeenCalledTimes(1));

    harness.setNowMs(2_600 + TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS);
    resolveDraft(structuredClone(exactDraft));

    await expect(observation).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: {
        attempts: 1,
        reason: 'verification-inconclusive',
        status: 'manual-required',
      },
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(1);
  });

  it('honors timely absence evidence when the required retry backoff crosses the old deadline', async () => {
    const harness = createHarness();
    await advanceToAutomaticVerification(harness);
    const firstWriteAcceptedAtMs = 2_600;
    const absenceProvenAtMs =
      firstWriteAcceptedAtMs + TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS - 1;
    harness.setNowMs(absenceProvenAtMs);

    await expect(
      harness.service.processObservation('delivery-1', {
        activityTransitionObserved: false,
        agentId: 'agent-1',
        generation: 3,
        lastOutputAtMs: 0,
        nowMs: absenceProvenAtMs,
        returnedToReadySnapshot: true,
        state: 'idle-at-prompt',
        supervisionVersion: 5,
        tail: '❯',
      }),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: {
        attempts: 2,
        status: 'verifying',
        updatedAt: new Date(absenceProvenAtMs + TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS).toISOString(),
      },
    });

    // The verification window bounds acquisition of positive absence
    // evidence. Once retry-wait is durable, its mandatory backoff may cross
    // the old deadline without invalidating the single authorized retry.
    expect(absenceProvenAtMs + TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS).toBeGreaterThan(
      firstWriteAcceptedAtMs + TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS,
    );
    expect(harness.admitPrompt).toHaveBeenCalledTimes(2);
    expect(harness.releaseCommandLease).not.toHaveBeenCalled();
  });

  it.each(['busy runtime observation', 'no-runtime expiry'] as const)(
    'settles a stranded automatic retry through %s',
    async (recoveryPath) => {
      const harness = createHarness();
      await harness.service.queue(harness.deliveryRequest);
      await harness.service.processObservation('delivery-1', {
        agentId: 'agent-1',
        generation: 3,
        lastOutputAtMs: 0,
        nowMs: 2_000,
        state: 'idle-at-prompt',
        supervisionVersion: 4,
        tail: '❯',
      });
      const acceptedAtMs = 2_600;
      harness.setNowMs(acceptedAtMs);
      await harness.service.processObservation('delivery-1', {
        agentId: 'agent-1',
        generation: 3,
        lastOutputAtMs: 0,
        nowMs: acceptedAtMs,
        state: 'idle-at-prompt',
        supervisionVersion: 4,
        tail: '❯',
      });

      const loadExactDraftDurably = harness.dependencies.draftRepository.loadExactDraft.bind(
        harness.dependencies.draftRepository,
      );
      let postWriteDraftLoads = 0;
      vi.spyOn(harness.dependencies.draftRepository, 'loadExactDraft').mockImplementation(
        async (args) => {
          postWriteDraftLoads += 1;
          if (postWriteDraftLoads === 2) {
            throw new Error('retry draft temporarily unavailable');
          }
          return loadExactDraftDurably(args);
        },
      );
      const absenceObservedAtMs = 3_200;
      harness.setNowMs(absenceObservedAtMs);
      await expect(
        harness.service.processObservation('delivery-1', {
          activityTransitionObserved: false,
          agentId: 'agent-1',
          generation: 3,
          lastOutputAtMs: 0,
          nowMs: absenceObservedAtMs,
          returnedToReadySnapshot: true,
          state: 'idle-at-prompt',
          supervisionVersion: 5,
          tail: '❯',
        }),
      ).rejects.toThrow('retry draft temporarily unavailable');
      expect(postWriteDraftLoads).toBe(2);
      await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
        snapshot: { attempts: 1, status: 'retry-wait' },
        writeBegan: true,
      });

      const recoveredAtMs = 4_000;
      harness.setNowMs(recoveredAtMs);
      const recovered =
        recoveryPath === 'busy runtime observation'
          ? await harness.service.processObservation('delivery-1', {
              agentId: 'agent-1',
              generation: 3,
              lastOutputAtMs: recoveredAtMs,
              nowMs: recoveredAtMs,
              state: 'active',
              supervisionVersion: 6,
              tail: 'working',
            })
          : await harness.service.expireDueDelivery('delivery-1', recoveredAtMs);
      expect(recovered).toMatchObject({
        kind: 'snapshot',
        snapshot: {
          attempts: 1,
          reason: 'retry-not-safe',
          status: 'manual-required',
        },
      });
      expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
      expect(harness.releaseCommandLease).toHaveBeenCalledTimes(1);
    },
  );

  it('does not expose a private projection through a direct call while the owner is dark', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    vi.mocked(harness.dependencies.getOwnerAvailability).mockReturnValue({
      kind: 'dark',
      reason: 'delivery-owner-dark',
    });
    const journalLoad = vi.spyOn(harness.journal, 'load');

    await expect(harness.service.getProjection('delivery-1')).resolves.toBeNull();
    expect(journalLoad).not.toHaveBeenCalled();
  });

  it('keeps lease contention in a proven-prewrite state across restart repair', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    harness.acquireCommandLease.mockImplementationOnce(async () => null);
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_000,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_600,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });

    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: { attempts: 0, status: 'waiting-lease' },
      writeBegan: false,
    });
    await expect(harness.service.repairAfterRestart()).resolves.toMatchObject({
      automaticManualRequired: 0,
    });
    expect(harness.admitPrompt).not.toHaveBeenCalled();
  });

  it('defensively repairs an attempted record when its write-intent flag is corrupt', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const record = await harness.journal.load('delivery-1');
    if (!record) throw new Error('delivery record is missing');
    record.snapshot = {
      ...record.snapshot,
      attempts: 1,
      status: 'waiting-ready',
      targetGeneration: 3,
      version: record.snapshot.version + 1,
    };
    record.writeBegan = false;
    await harness.journal.save(record);

    await expect(harness.service.repairAfterRestart()).resolves.toMatchObject({
      automaticManualRequired: 1,
    });
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: {
        reason: 'backend-recovered-ambiguous-write',
        status: 'manual-required',
      },
    });
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();
  });

  it('rechecks the durable readiness deadline after asynchronous exact-draft loading', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const readyObservedAtMs = 2_000;
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: readyObservedAtMs,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });

    const exactDraft = harness.getDraft();
    if (!exactDraft) throw new Error('automatic draft is missing');
    let resolveDraft!: (draft: TaskInitialPromptDraftSnapshot) => void;
    const loadExactDraft = vi
      .spyOn(harness.dependencies.draftRepository, 'loadExactDraft')
      .mockImplementationOnce(
        () =>
          new Promise<TaskInitialPromptDraftSnapshot>((resolve) => {
            resolveDraft = resolve;
          }),
      );
    const delivery = harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: readyObservedAtMs + 600,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    await vi.waitFor(() => expect(loadExactDraft).toHaveBeenCalledTimes(1));

    harness.setNowMs(readyObservedAtMs + TASK_INITIAL_PROMPT_READY_DEADLINE_MS);
    resolveDraft(structuredClone(exactDraft));

    await expect(delivery).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { reason: 'verification-inconclusive', status: 'manual-required' },
    });
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: {
        attempts: 0,
        reason: 'verification-inconclusive',
        status: 'manual-required',
      },
      writeBegan: false,
    });
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();
    expect(harness.releaseCommandLease).not.toHaveBeenCalled();
  });

  it('rechecks the durable readiness deadline after asynchronous lease acquisition', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const readyObservedAtMs = 2_000;
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: readyObservedAtMs,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });

    let resolveLease!: (lease: TaskInitialPromptCommandLease | null) => void;
    harness.acquireCommandLease.mockImplementationOnce(
      () =>
        new Promise<TaskInitialPromptCommandLease | null>((resolve) => {
          resolveLease = resolve;
        }),
    );
    const delivery = harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: readyObservedAtMs + 600,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    await vi.waitFor(() => expect(harness.acquireCommandLease).toHaveBeenCalledTimes(1));

    harness.setNowMs(readyObservedAtMs + TASK_INITIAL_PROMPT_READY_DEADLINE_MS);
    resolveLease({
      controllerId: 'client-1',
      leaseGeneration: 7,
      leaseOwnerId: 'owner-1',
      release: harness.releaseCommandLease,
    });

    await expect(delivery).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { reason: 'verification-inconclusive', status: 'manual-required' },
    });
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: {
        attempts: 0,
        reason: 'verification-inconclusive',
        status: 'manual-required',
      },
      writeBegan: false,
    });
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(1);
    expect(harness.admitPrompt).not.toHaveBeenCalled();
  });

  it('records a closing rejection proven before bytes as clean cancellation', async () => {
    const harness = createHarness({
      admission: { kind: 'rejected-before-bytes', reason: 'task-closing' },
    });
    await harness.service.queue(harness.deliveryRequest);
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_000,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_600,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });

    const record = await harness.journal.load('delivery-1');
    expect(record).toMatchObject({
      snapshot: { attempts: 0, reason: 'task-closing', status: 'cancelled' },
      writeBegan: false,
    });
    expect(record).not.toHaveProperty('preWriteReadyFingerprint');
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it('settles an exited delivery as manual-required without acquiring control or writing', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);

    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 1_100,
      nowMs: 1_200,
      state: 'exited-error',
      supervisionVersion: 5,
      tail: 'process exited',
    });

    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: { attempts: 0, reason: 'agent-exited', status: 'manual-required' },
      writeBegan: false,
    });
    expect(harness.acquireCommandLease).not.toHaveBeenCalled();
    expect(harness.admitPrompt).not.toHaveBeenCalled();
  });

  it('settles exact lease loss before bytes as manual recovery instead of looping readiness', async () => {
    const harness = createHarness({
      admission: { kind: 'rejected-before-bytes', reason: 'control-or-lease-lost' },
    });
    await harness.service.queue(harness.deliveryRequest);
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_000,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_600,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });

    const record = await harness.journal.load('delivery-1');
    expect(record).toMatchObject({
      snapshot: { attempts: 0, reason: 'lease-taken-over', status: 'manual-required' },
      writeBegan: false,
    });
    expect(record).not.toHaveProperty('preWriteReadyFingerprint');
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it('writes automatically only after stable readiness and clears only after positive evidence', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_000,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    expect(harness.admitPrompt).not.toHaveBeenCalled();
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_600,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.admitPrompt.mock.calls[0]?.[0]).toMatchObject({
      purpose: 'initial-delivery',
      supervisionVersion: 4,
    });
    expect(harness.getDraft()).not.toBeNull();
    await harness.service.processObservation('delivery-1', {
      activityTransitionObserved: true,
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 2_700,
      nowMs: 2_800,
      state: 'active',
      supervisionVersion: 5,
      tail: 'working',
    });
    expect(harness.getDraft()).toBeNull();
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: { attempts: 1, status: 'delivered' },
    });
  });

  it('turns a thrown automatic admission into terminal ambiguity without retrying bytes', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    harness.admitPrompt.mockRejectedValueOnce(new Error('response lost after invocation'));
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_000,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_600,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: {
        attempts: 0,
        reason: 'backend-recovered-ambiguous-write',
        status: 'manual-required',
      },
      writeBegan: true,
    });
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 3_000,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.getDraft()).not.toBeNull();
  });

  it('recovers a durable writing state when accepted-result persistence fails', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_000,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    const saveDurably = harness.journal.save.bind(harness.journal);
    let rejectedAcceptedTransition = false;
    vi.spyOn(harness.journal, 'save').mockImplementation(async (record) => {
      if (!rejectedAcceptedTransition && record.snapshot.status === 'verifying') {
        rejectedAcceptedTransition = true;
        throw new Error('accepted transition persistence unavailable');
      }
      await saveDurably(record);
    });
    harness.setNowMs(2_600);

    await expect(
      harness.service.processObservation('delivery-1', {
        agentId: 'agent-1',
        generation: 3,
        lastOutputAtMs: 0,
        nowMs: 2_600,
        state: 'idle-at-prompt',
        supervisionVersion: 4,
        tail: '❯',
      }),
    ).rejects.toThrow('accepted transition persistence unavailable');
    expect(rejectedAcceptedTransition).toBe(true);
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: { attempts: 0, status: 'writing' },
      writeBegan: true,
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);

    await expect(
      harness.service.processObservation('delivery-1', {
        agentId: 'agent-1',
        generation: 3,
        lastOutputAtMs: 3_000,
        nowMs: 3_000,
        state: 'active',
        supervisionVersion: 5,
        tail: 'working',
      }),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: {
        attempts: 0,
        reason: 'backend-recovered-ambiguous-write',
        status: 'manual-required',
      },
    });
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(1);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it('recovers a durable writing state through no-runtime expiry reconciliation', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_000,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    const saveDurably = harness.journal.save.bind(harness.journal);
    let rejectedAcceptedTransition = false;
    vi.spyOn(harness.journal, 'save').mockImplementation(async (record) => {
      if (!rejectedAcceptedTransition && record.snapshot.status === 'verifying') {
        rejectedAcceptedTransition = true;
        throw new Error('accepted transition persistence unavailable');
      }
      await saveDurably(record);
    });
    harness.setNowMs(2_600);
    await expect(
      harness.service.processObservation('delivery-1', {
        agentId: 'agent-1',
        generation: 3,
        lastOutputAtMs: 0,
        nowMs: 2_600,
        state: 'idle-at-prompt',
        supervisionVersion: 4,
        tail: '❯',
      }),
    ).rejects.toThrow('accepted transition persistence unavailable');
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: { attempts: 0, status: 'writing' },
      writeBegan: true,
    });

    const reconciledAtMs = 3_000;
    harness.setNowMs(reconciledAtMs);
    await expect(
      harness.service.expireDueDelivery('delivery-1', reconciledAtMs),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: {
        attempts: 0,
        reason: 'backend-recovered-ambiguous-write',
        status: 'manual-required',
      },
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(1);

    await harness.service.expireDueDelivery('delivery-1', reconciledAtMs + 1);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(1);
  });

  it('repairs an automatic accepted clear without dispatching a second time', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const clear = vi.spyOn(harness.dependencies.draftRepository, 'clearAfterAcceptedOutcome');
    clear.mockRejectedValueOnce(new Error('clear persistence unavailable'));
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_000,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_600,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    await expect(
      harness.service.processObservation('delivery-1', {
        activityTransitionObserved: true,
        agentId: 'agent-1',
        generation: 3,
        lastOutputAtMs: 2_700,
        nowMs: 2_800,
        state: 'active',
        supervisionVersion: 5,
        tail: 'working',
      }),
    ).rejects.toThrow('clear persistence unavailable');
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: { status: 'delivered' },
    });

    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 2_700,
      nowMs: 2_900,
      state: 'active',
      supervisionVersion: 5,
      tail: 'working',
    });
    expect(harness.getDraft()).toBeNull();
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it('supersedes a pre-intent confirmation only with a newer derived draft operation', async () => {
    const harness = createHarness();
    await advanceToAutomaticVerification(harness);
    const oldRequest = harness.manualRequest();
    await expect(harness.service.sendManually(oldRequest)).resolves.toMatchObject({
      operation: {
        manualSendOperationId: oldRequest.manualSendOperationId,
        phase: 'confirmation-required',
      },
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);

    await expect(
      harness.service.reviseDraft({
        editOperationId: 'edit-after-confirmation-required',
        expectedDraftFingerprint: oldRequest.expectedDraftFingerprint,
        expectedEditRevision: oldRequest.expectedEditRevision,
        revisedText: 'Ship the revised draft',
        sourceDeliveryId: 'delivery-1',
        taskId: 'task-1',
      }),
    ).resolves.toMatchObject({
      current: { editRevision: 1, mode: 'manual-only', text: 'Ship the revised draft' },
      kind: 'saved-manual-draft',
    });
    const newRequest = harness.manualRequest();
    expect(newRequest.manualSendOperationId).not.toBe(oldRequest.manualSendOperationId);

    await expect(
      harness.service.sendManually({
        ...oldRequest,
        confirmPossiblePriorAutomaticWrite: true,
      }),
    ).resolves.toMatchObject({
      issue: { code: 'draft-changed' },
      kind: 'domain-rejected',
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);

    await expect(harness.service.sendManually(newRequest)).resolves.toMatchObject({
      operation: {
        manualSendOperationId: newRequest.manualSendOperationId,
        phase: 'confirmation-required',
      },
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    await expect(
      harness.service.sendManually({
        ...newRequest,
        confirmPossiblePriorAutomaticWrite: true,
      }),
    ).resolves.toMatchObject({
      operation: {
        manualSendOperationId: newRequest.manualSendOperationId,
        phase: 'completed',
      },
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(2);
    expect(harness.getDraft()).toBeNull();

    await harness.service.sendManually({
      ...oldRequest,
      confirmPossiblePriorAutomaticWrite: true,
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(2);
  });

  it('resumes the same sealed manual operation after automatic lease release recovers', async () => {
    const harness = createHarness();
    await advanceToAutomaticVerification(harness);
    const request = harness.manualRequest({ confirmPossiblePriorAutomaticWrite: true });
    harness.releaseCommandLease.mockRejectedValueOnce(
      new Error('automatic lease release unavailable'),
    );

    await expect(harness.service.sendManually(request)).rejects.toThrow(
      'automatic lease release unavailable',
    );
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      automationSealed: true,
      manualSendOperation: {
        manualSendOperationId: request.manualSendOperationId,
        phase: 'automation-sealed',
      },
      snapshot: { status: 'manual-required' },
    });
    expect(harness.acquireCommandLease).toHaveBeenCalledTimes(1);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(1);

    await harness.service.processObservation('delivery-1', {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 3_000,
      nowMs: 3_000,
      state: 'active',
      supervisionVersion: 5,
      tail: 'working',
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(2);

    await expect(harness.service.sendManually(request)).resolves.toMatchObject({
      kind: 'operation',
      operation: {
        manualSendOperationId: request.manualSendOperationId,
        phase: 'completed',
      },
      replayed: false,
    });
    expect(harness.acquireCommandLease).toHaveBeenCalledTimes(2);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(2);
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(3);

    await harness.service.sendManually(request);
    expect(harness.acquireCommandLease).toHaveBeenCalledTimes(2);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(2);
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(3);
  });

  it('does not release or send when the atomic automation seal cannot persist', async () => {
    const harness = createHarness();
    await advanceToAutomaticVerification(harness);
    const request = harness.manualRequest({ confirmPossiblePriorAutomaticWrite: true });
    const saveDurably = harness.journal.save.bind(harness.journal);
    let rejectedSeal = false;
    vi.spyOn(harness.journal, 'save').mockImplementation(async (record) => {
      if (
        !rejectedSeal &&
        record.automationSealed &&
        record.manualSendOperation?.phase === 'automation-sealed'
      ) {
        rejectedSeal = true;
        throw new Error('automation seal persistence unavailable');
      }
      await saveDurably(record);
    });

    await expect(harness.service.sendManually(request)).rejects.toThrow(
      'automation seal persistence unavailable',
    );
    expect(rejectedSeal).toBe(true);
    const retained = await harness.journal.load('delivery-1');
    expect(retained).toMatchObject({
      automationSealed: false,
      snapshot: { attempts: 1, status: 'verifying' },
    });
    expect(retained).not.toHaveProperty('manualSendOperation');
    expect(harness.releaseCommandLease).not.toHaveBeenCalled();
    expect(harness.acquireCommandLease).toHaveBeenCalledTimes(1);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);

    await expect(harness.service.sendManually(request)).resolves.toMatchObject({
      kind: 'operation',
      operation: { phase: 'completed' },
    });
    expect(harness.acquireCommandLease).toHaveBeenCalledTimes(2);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(2);
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(2);
  });

  it('retries a retained manual lease release before replaying its durable result', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const releaseManualLease = vi
      .fn()
      .mockRejectedValueOnce(new Error('manual lease release unavailable'));
    harness.acquireCommandLease.mockResolvedValueOnce({
      controllerId: 'manual-client-1',
      leaseGeneration: 8,
      leaseOwnerId: 'manual-owner-1',
      release: releaseManualLease,
    });
    const request = harness.manualRequest();

    await expect(harness.service.sendManually(request)).rejects.toThrow(
      'manual lease release unavailable',
    );
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      automationSealed: true,
      manualSendOperation: {
        manualSendOperationId: request.manualSendOperationId,
        phase: 'completed',
      },
    });
    expect(harness.getDraft()).toBeNull();
    expect(releaseManualLease).toHaveBeenCalledTimes(1);
    expect(harness.acquireCommandLease).toHaveBeenCalledTimes(1);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);

    await expect(harness.service.sendManually(request)).resolves.toMatchObject({
      kind: 'operation',
      operation: { phase: 'completed' },
      replayed: true,
    });
    expect(releaseManualLease).toHaveBeenCalledTimes(2);
    expect(harness.acquireCommandLease).toHaveBeenCalledTimes(1);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);

    await harness.service.sendManually(request);
    expect(releaseManualLease).toHaveBeenCalledTimes(2);
    expect(harness.acquireCommandLease).toHaveBeenCalledTimes(1);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it('does not release an in-flight manual lease from a concurrent replay', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const releaseManualLease = vi.fn();
    harness.acquireCommandLease.mockResolvedValueOnce({
      controllerId: 'manual-client-1',
      leaseGeneration: 8,
      leaseOwnerId: 'manual-owner-1',
      release: releaseManualLease,
    });
    let resolveAdmission!: (result: PromptInputAdmissionResult) => void;
    harness.admitPrompt.mockImplementationOnce(
      () =>
        new Promise<PromptInputAdmissionResult>((resolve) => {
          resolveAdmission = resolve;
        }),
    );
    const request = harness.manualRequest();

    const firstSend = harness.service.sendManually(request);
    await vi.waitFor(() => expect(harness.admitPrompt).toHaveBeenCalledTimes(1));
    const concurrentReplay = harness.service.sendManually(request);
    await Promise.resolve();

    expect(releaseManualLease).not.toHaveBeenCalled();
    expect(harness.acquireCommandLease).toHaveBeenCalledTimes(1);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);

    resolveAdmission({
      admittedSupervisionVersion: 4,
      kind: 'accepted',
      lowLevelCallCount: 1,
    });
    await expect(firstSend).resolves.toMatchObject({
      kind: 'operation',
      operation: { phase: 'completed' },
      replayed: false,
    });
    await expect(concurrentReplay).resolves.toMatchObject({
      kind: 'operation',
      operation: { phase: 'completed' },
      replayed: true,
    });
    expect(releaseManualLease).toHaveBeenCalledTimes(1);
    expect(harness.acquireCommandLease).toHaveBeenCalledTimes(1);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it.each(['terminal observation', 'terminal expiry'] as const)(
    'retries a retained manual lease through background %s',
    async (recoveryPath) => {
      const harness = createHarness();
      const { releaseManualLease } = await completeManualSendWithRetainedLease(harness);
      expect(releaseManualLease).toHaveBeenCalledTimes(1);
      expect(harness.acquireCommandLease).toHaveBeenCalledTimes(1);
      expect(harness.admitPrompt).toHaveBeenCalledTimes(1);

      const recovered =
        recoveryPath === 'terminal observation'
          ? await harness.service.processObservation('delivery-1', {
              agentId: 'agent-1',
              generation: 3,
              lastOutputAtMs: 3_000,
              nowMs: 3_000,
              state: 'active',
              supervisionVersion: 5,
              tail: 'working',
            })
          : await harness.service.expireDueDelivery('delivery-1', 3_000);
      expect(recovered).toMatchObject({
        kind: 'snapshot',
        snapshot: { status: 'cancelled' },
      });
      expect(releaseManualLease).toHaveBeenCalledTimes(2);
      expect(harness.acquireCommandLease).toHaveBeenCalledTimes(1);
      expect(harness.admitPrompt).toHaveBeenCalledTimes(1);

      await harness.service.expireDueDelivery('delivery-1', 3_001);
      expect(releaseManualLease).toHaveBeenCalledTimes(2);
      expect(harness.acquireCommandLease).toHaveBeenCalledTimes(1);
      expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    },
  );

  it('does not complete removal drain until a retained manual lease release recovers', async () => {
    const harness = createHarness();
    const { releaseManualLease } = await completeManualSendWithRetainedLease(harness, 2);
    const drain = {
      deletionOperationId: 'delete-after-manual-send',
      taskId: 'task-1',
    };

    await expect(harness.service.drainTaskForRemoval(drain)).rejects.toThrow(
      'manual lease release unavailable',
    );
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      automationSealed: true,
      manualSendOperation: { phase: 'completed' },
      snapshot: { status: 'cancelled' },
    });
    expect(releaseManualLease).toHaveBeenCalledTimes(2);
    expect(harness.acquireCommandLease).toHaveBeenCalledTimes(1);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);

    await expect(harness.service.drainTaskForRemoval(drain)).resolves.toEqual({
      kind: 'already-complete',
      retainedRecordCount: 1,
    });
    await harness.service.drainTaskForRemoval(drain);
    expect(releaseManualLease).toHaveBeenCalledTimes(3);
    expect(harness.acquireCommandLease).toHaveBeenCalledTimes(1);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it('persists manual intent before one byte-admitting call and replays without another call', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    harness.admitPrompt.mockImplementationOnce(async () => {
      await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
        manualSendOperation: { phase: 'write-intent-persisted' },
      });
      return {
        admittedSupervisionVersion: 4,
        kind: 'accepted',
        lowLevelCallCount: 1,
      };
    });
    const request = harness.manualRequest();
    await expect(harness.service.sendManually(request)).resolves.toMatchObject({
      kind: 'operation',
      operation: { phase: 'completed' },
      replayed: false,
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.getDraft()).toBeNull();
    const retainedRecord = await harness.journal.load('delivery-1');
    expect(retainedRecord?.manualSendOperation).not.toHaveProperty('latestAttemptReceipt');
    expect(retainedRecord?.manualSendOperation).toHaveProperty('terminalReceipt');
    expect(retainedRecord?.editHighWater).toMatchObject({ editSealed: true });
    expect(new TextEncoder().encode(JSON.stringify(retainedRecord)).byteLength).toBeLessThan(2_304);
    await expect(harness.service.sendManually(request)).resolves.toMatchObject({
      kind: 'operation',
      operation: { phase: 'completed' },
      replayed: true,
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it('turns a thrown manual admission into reconciliation and never retries it', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    harness.admitPrompt.mockRejectedValueOnce(new Error('adapter outcome unknown'));
    const request = harness.manualRequest();

    await expect(harness.service.sendManually(request)).resolves.toMatchObject({
      operation: { phase: 'manual-reconciliation-required' },
      recovery: { automaticRetryAllowed: false, kind: 'inspect-terminal-and-copy-exact-draft' },
    });
    await harness.service.sendManually(request);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.getDraft()).not.toBeNull();
  });

  it('retries only compare-clear after an accepted manual write', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const clear = vi.spyOn(harness.dependencies.draftRepository, 'clearAfterAcceptedOutcome');
    clear.mockRejectedValueOnce(new Error('clear commit unavailable'));
    const request = harness.manualRequest();

    await expect(harness.service.sendManually(request)).resolves.toMatchObject({
      operation: { phase: 'write-accepted' },
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.getDraft()).not.toBeNull();
    await expect(harness.service.sendManually(request)).resolves.toMatchObject({
      operation: { phase: 'completed' },
      replayed: true,
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(harness.getDraft()).toBeNull();
  });

  it('settles an accepted manual write during removal without another admission', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    const clear = vi.spyOn(harness.dependencies.draftRepository, 'clearAfterAcceptedOutcome');
    clear.mockRejectedValueOnce(new Error('clear commit unavailable'));
    const request = harness.manualRequest();

    await expect(harness.service.sendManually(request)).resolves.toMatchObject({
      operation: { phase: 'write-accepted' },
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.getDraft()).not.toBeNull();

    await expect(
      harness.service.drainTaskForRemoval({
        deletionOperationId: 'delete-after-accepted-manual-write',
        taskId: 'task-1',
      }),
    ).resolves.toEqual({ kind: 'complete', retainedRecordCount: 1 });
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      manualSendOperation: {
        phase: 'completed',
        terminalReceipt: {
          outcome: { clear: 'cleared', kind: 'sent' },
          terminal: true,
        },
      },
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(harness.getDraft()).toBeNull();
  });

  it('drains a pre-intent confirmation once and replays byte-identical terminal state', async () => {
    const harness = createHarness();
    await advanceToAutomaticVerification(harness);
    const request = harness.manualRequest();
    await expect(harness.service.sendManually(request)).resolves.toMatchObject({
      operation: { phase: 'confirmation-required' },
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    const drain = {
      deletionOperationId: 'delete-pre-intent-confirmation',
      taskId: 'task-1',
    };

    await expect(harness.service.drainTaskForRemoval(drain)).resolves.toEqual({
      kind: 'complete',
      retainedRecordCount: 1,
    });
    const first = await harness.journal.load('delivery-1');
    expect(first).toMatchObject({
      manualSendOperation: {
        phase: 'failed-before-write',
        terminalReceipt: {
          outcome: { issue: { code: 'task-closing' }, kind: 'not-sent' },
          terminal: true,
        },
      },
    });
    const terminalOperationBytes = JSON.stringify(first?.manualSendOperation);
    const terminalOperationVersion = first?.manualSendOperation?.version;

    await expect(harness.service.drainTaskForRemoval(drain)).resolves.toEqual({
      kind: 'already-complete',
      retainedRecordCount: 1,
    });
    const replayed = await harness.journal.load('delivery-1');
    expect(replayed?.manualSendOperation?.version).toBe(terminalOperationVersion);
    expect(JSON.stringify(replayed?.manualSendOperation)).toBe(terminalOperationBytes);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it('advances a proven-before-byte failure only through the exact failed-attempt CAS', async () => {
    const harness = createHarness({
      admission: { kind: 'rejected-before-bytes', reason: 'agent-not-ready' },
    });
    await harness.service.queue(harness.deliveryRequest);
    const initial = harness.manualRequest();
    await expect(harness.service.sendManually(initial)).resolves.toMatchObject({
      operation: { attempt: 1, phase: 'failed-before-write' },
      recovery: { failedAttempt: 1, kind: 'retry-proven-not-sent' },
    });
    harness.admitPrompt.mockResolvedValue({
      admittedSupervisionVersion: 4,
      kind: 'accepted',
      lowLevelCallCount: 1,
    });
    const retry = harness.manualRequest({
      action: { failedAttempt: 1, kind: 'retry-proven-not-sent' },
    });
    await expect(harness.service.sendManually(retry)).resolves.toMatchObject({
      operation: { attempt: 2, phase: 'completed' },
    });
    await harness.service.sendManually(retry);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(2);
  });

  it('makes ambiguous writes permanently no-retry until explicit no-write reconciliation', async () => {
    const harness = createHarness({
      admission: {
        admittedSupervisionVersion: 4,
        bytesMayHaveBeenAccepted: true,
        kind: 'outcome-ambiguous',
      },
    });
    await harness.service.queue(harness.deliveryRequest);
    const request = harness.manualRequest();
    const first = await harness.service.sendManually(request);
    expect(first).toMatchObject({
      operation: { phase: 'manual-reconciliation-required' },
      recovery: { automaticRetryAllowed: false, kind: 'inspect-terminal-and-copy-exact-draft' },
    });
    const operation = first.kind === 'operation' ? first.operation : null;
    expect(operation).not.toBeNull();
    await harness.service.sendManually(request);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    const resolutionRequest = {
      expectedOperationVersion: operation?.version ?? -1,
      manualSendOperationId: request.manualSendOperationId,
      resolution: 'abandon-to-terminal' as const,
    };
    const resolved = await harness.service.resolveManualAmbiguity(resolutionRequest);
    expect(resolved).toMatchObject({
      kind: 'resolved',
      projection: {
        manualSendOperation: {
          manualSendOperationId: request.manualSendOperationId,
          phase: 'reconciled',
        },
      },
      replayed: false,
    });
    await expect(harness.service.resolveManualAmbiguity(resolutionRequest)).resolves.toMatchObject({
      kind: 'resolved',
      projection: {
        manualSendOperation: { manualSendOperationId: request.manualSendOperationId },
      },
      replayed: true,
    });
    expect(harness.getDraft()).not.toBeNull();
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it('preserves reconciled high-water when a newer draft starts an explicit send', async () => {
    const harness = createHarness({
      admission: {
        admittedSupervisionVersion: 4,
        bytesMayHaveBeenAccepted: true,
        kind: 'outcome-ambiguous',
      },
    });
    await harness.service.queue(harness.deliveryRequest);
    const abandonedRequest = harness.manualRequest();
    const ambiguous = await harness.service.sendManually(abandonedRequest);
    expect(ambiguous).toMatchObject({
      operation: { phase: 'manual-reconciliation-required' },
    });
    const ambiguousOperation = ambiguous.kind === 'operation' ? ambiguous.operation : null;
    if (!ambiguousOperation) throw new Error('ambiguous manual operation is missing');

    await expect(
      harness.service.resolveManualAmbiguity({
        expectedOperationVersion: ambiguousOperation.version,
        manualSendOperationId: ambiguousOperation.manualSendOperationId,
        resolution: 'abandon-to-terminal',
      }),
    ).resolves.toMatchObject({
      kind: 'resolved',
      projection: {
        manualSendHighWater: {
          disposition: 'reconciled',
          operationId: ambiguousOperation.manualSendOperationId,
        },
        manualSendOperation: { phase: 'reconciled' },
      },
    });
    await harness.service.reviseDraft({
      editOperationId: 'edit-after-abandoned-operation',
      expectedDraftFingerprint: abandonedRequest.expectedDraftFingerprint,
      expectedEditRevision: abandonedRequest.expectedEditRevision,
      revisedText: 'Send this newer draft',
      sourceDeliveryId: 'delivery-1',
      taskId: 'task-1',
    });
    const newerRequest = harness.manualRequest();
    expect(newerRequest.manualSendOperationId).not.toBe(ambiguousOperation.manualSendOperationId);
    harness.dependencies.getAgentRuntime = () => ({
      generation: 3,
      lastOutputAtMs: 0,
      state: 'active',
      supervisionVersion: 5,
      tail: 'working',
      taskId: 'task-1',
    });

    await expect(harness.service.sendManually(newerRequest)).resolves.toMatchObject({
      operation: {
        manualSendOperationId: newerRequest.manualSendOperationId,
        phase: 'failed-before-write',
      },
    });
    await expect(harness.journal.load('delivery-1')).resolves.toMatchObject({
      manualSendHighWater: {
        disposition: 'reconciled',
        operationId: ambiguousOperation.manualSendOperationId,
      },
      manualSendOperation: {
        manualSendOperationId: newerRequest.manualSendOperationId,
      },
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it('drains without deleting records and finalizes exact-task state only with a committed witness', async () => {
    const harness = createHarness();
    await harness.service.queue(harness.deliveryRequest);
    await expect(
      harness.service.drainTaskForRemoval({ deletionOperationId: 'delete-1', taskId: 'task-1' }),
    ).resolves.toEqual({ kind: 'complete', retainedRecordCount: 1 });
    expect(harness.journal.recordCount()).toBe(1);
    await expect(
      harness.service.finalizeRemovedTaskInitialPromptState({
        deletionOperationId: 'delete-1',
        taskId: 'task-1',
      }),
    ).resolves.toEqual({ kind: 'complete' });
    expect(harness.journal.recordCount()).toBe(0);
    await expect(
      harness.service.finalizeRemovedTaskInitialPromptState({
        deletionOperationId: 'delete-1',
        taskId: 'task-1',
      }),
    ).resolves.toEqual({ kind: 'already-complete' });
  });

  it('reclaims rate buckets and retained leases across repeated delivery churn', async () => {
    const harness = createHarness();
    vi.spyOn(harness.dependencies.draftRepository, 'clearAfterAcceptedOutcome').mockResolvedValue({
      kind: 'draft-changed',
      workspaceRevision: 1,
    });
    const deliveryCount = 8;

    for (let index = 0; index < deliveryCount; index += 1) {
      const deliveryId = `delivery-churn-${index}`;
      await harness.service.queue({ ...harness.deliveryRequest, deliveryId });
      const manualSendOperationId = deriveManualInitialPromptSendOperationId({
        acknowledgedDraftFingerprint: harness.deliveryRequest.expectedDraftFingerprint,
        acknowledgedEditRevision: 0,
        deliveryId,
      });
      await expect(
        harness.service.sendManually(harness.manualRequest({ deliveryId, manualSendOperationId })),
      ).resolves.toMatchObject({ operation: { phase: 'completed' } });
      expect(harness.service.getResourceDiagnostics()).toEqual({
        automaticLeaseCount: 0,
        manualLeaseCount: 0,
        rateBucketCount: 1,
      });

      await expect(
        harness.service.drainTaskForRemoval({
          deletionOperationId: `delete-churn-${index}`,
          taskId: 'task-1',
        }),
      ).resolves.toMatchObject({ retainedRecordCount: index + 1 });
      expect(harness.service.getResourceDiagnostics()).toEqual({
        automaticLeaseCount: 0,
        manualLeaseCount: 0,
        rateBucketCount: 0,
      });
    }

    expect(harness.acquireCommandLease).toHaveBeenCalledTimes(deliveryCount);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(deliveryCount);
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(deliveryCount);
  });

  it('keeps one fixed-size rate bucket rather than scheduling retry timers', () => {
    expect(MANUAL_INITIAL_PROMPT_SEND_RATE_LIMIT).toEqual({ burst: 3, refillIntervalMs: 5_000 });
  });
});
