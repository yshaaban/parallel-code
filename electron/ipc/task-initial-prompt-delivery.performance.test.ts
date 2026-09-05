import { describe, expect, it } from 'vitest';

import {
  MANUAL_INITIAL_PROMPT_SEND_RATE_LIMIT,
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  deriveManualInitialPromptSendOperationId,
  deriveTaskInitialPromptDraftFingerprint,
  type SendTaskInitialPromptManuallyRequest,
  type TaskInitialPromptDraftSnapshot,
} from '../../src/domain/task-initial-prompt-delivery.js';
import type { PromptInputAdmissionResult } from '../../src/domain/task-prompt-input-admission.js';
import {
  TASK_INITIAL_PROMPT_AUTOMATIC_RICH_REPLAY_LIMIT,
  createMemoryTaskInitialPromptDeliveryJournal,
  createTaskInitialPromptDeliveryService,
  type TaskInitialPromptDeliveryDependencies,
} from './task-initial-prompt-delivery.js';

const STATE_BUDGET_BYTES = 2 * 1_024;
const HISTORY_OPERATION_COUNT = 1_000;
const PROVEN_PREWRITE_FAILURE_COUNT = 10_000;
const HISTORY_BUDGET_MS = 4_000;
const FAILURE_WORKLOAD_BUDGET_MS = 20_000;
const FINGERPRINT = 'ab'.repeat(32);
const CUTOVER_EPOCH = 'performance-cutover-1';

type Admission = (
  dispatch: Parameters<TaskInitialPromptDeliveryDependencies['admitPrompt']>[1],
) => PromptInputAdmissionResult | Promise<PromptInputAdmissionResult>;

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function createHarness(prompt: string, admission: Admission) {
  let nowMs = 1_000;
  let draft: TaskInitialPromptDraftSnapshot | null;
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
  const counters = {
    admissions: 0,
    leasesAcquired: 0,
    leasesReleased: 0,
    sleeps: 0,
  };
  const journal = createMemoryTaskInitialPromptDeliveryJournal();
  const dependencies: TaskInitialPromptDeliveryDependencies = {
    async acquireCommandLease() {
      counters.leasesAcquired += 1;
      let released = false;
      return {
        controllerId: 'performance-client',
        leaseGeneration: counters.leasesAcquired,
        leaseOwnerId: 'performance-owner',
        release() {
          if (released) return;
          released = true;
          counters.leasesReleased += 1;
        },
      };
    },
    async admitPrompt(_expectation, dispatch) {
      counters.admissions += 1;
      return admission(dispatch);
    },
    clock: {
      nowMs: () => nowMs,
      async sleep(delayMs) {
        counters.sleeps += 1;
        nowMs += delayMs;
      },
      toIso: (value) => new Date(value).toISOString(),
    },
    draftRepository: {
      async clearAfterAcceptedOutcome(args) {
        if (
          !draft ||
          draft.fingerprint !== args.expectedDraftFingerprint ||
          draft.editRevision !== args.expectedEditRevision
        ) {
          return { kind: 'draft-changed', workspaceRevision: draft?.workspaceRevision ?? 1 };
        }
        draft = null;
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
          throw new Error('Draft changed');
        }
        return structuredClone(draft);
      },
      async reviseAfterUserEdit() {
        return { current: draft, kind: 'replayed' };
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
    getOwnerAvailability: () => ({
      cutoverEpoch: CUTOVER_EPOCH,
      hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
      kind: 'active',
    }),
    journal,
    removalGate: {
      getTaskSnapshot: () => ({
        current: {
          catalogVersion: 1,
          serverInstanceId: 'performance-server-1',
          taskClosing: false,
          taskState: 'present',
        },
        cutoverEpoch: CUTOVER_EPOCH,
        hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
        kind: 'active',
      }),
      verifyCommittedRemoval: () => true,
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
  const operationId = deriveManualInitialPromptSendOperationId({
    acknowledgedDraftFingerprint: fingerprint,
    acknowledgedEditRevision: 0,
    deliveryId: deliveryRequest.deliveryId,
  });
  const manualRequest = (
    action: SendTaskInitialPromptManuallyRequest['action'] = { kind: 'send' },
  ): SendTaskInitialPromptManuallyRequest => ({
    action,
    agentId: 'agent-1',
    confirmPossiblePriorAutomaticWrite: false,
    deliveryId: deliveryRequest.deliveryId,
    expectedAgentGeneration: 3,
    expectedDraftFingerprint: fingerprint,
    expectedEditRevision: 0,
    manualSendOperationId: operationId,
    taskId: 'task-1',
  });
  return {
    advanceBy: (delayMs: number) => {
      nowMs += delayMs;
    },
    counters,
    deliveryRequest,
    journal,
    manualRequest,
    service,
  };
}

describe('initial prompt delivery resource budgets', () => {
  it('bounds 1,000-operation automatic history, rich replay, and exact-task finalization', async () => {
    const journal = createMemoryTaskInitialPromptDeliveryJournal();
    const startedAt = performance.now();
    for (let index = 0; index < HISTORY_OPERATION_COUNT; index += 1) {
      const deliveryId = `delivery-${String(index).padStart(4, '0')}`;
      const updatedAt = new Date(index * 1_000).toISOString();
      await journal.save({
        automationSealed: false,
        draftEditRevision: 0,
        editHighWater: {
          editSealed: true,
          highestEditRevision: 0,
          highestInputFingerprint: FINGERPRINT,
          highestOperationId: 'clear-1',
        },
        expectedDraftFingerprint: FINGERPRINT,
        preWriteReadyFingerprint: FINGERPRINT,
        readyCandidate: {
          generation: 1,
          normalizedFrameFingerprint: FINGERPRINT,
          observedAtMs: index,
        },
        request: {
          agentId: 'agent-1',
          deliveryId,
          expectedDraftFingerprint: FINGERPRINT,
          readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
          taskId: 'history-task',
        },
        schemaVersion: 1,
        snapshot: {
          agentId: 'agent-1',
          attempts: 1,
          createdAt: updatedAt,
          deliveryId,
          status: 'delivered',
          targetGeneration: 1,
          taskId: 'history-task',
          updatedAt,
          version: 4,
        },
        writeBegan: true,
      });
    }
    const elapsedMs = performance.now() - startedAt;
    const records = await journal.listRecords();
    const richCount = records.filter((record) => record.readyCandidate !== undefined).length;
    const maximumBytes = Math.max(...records.map(byteLength));

    process.stdout.write(
      `initial-prompt-history operations=${HISTORY_OPERATION_COUNT} elapsed=${elapsedMs.toFixed(2)}ms records=${records.length} rich=${richCount} maxRecord=${maximumBytes}B\n`,
    );
    expect(records).toHaveLength(HISTORY_OPERATION_COUNT);
    expect(richCount).toBe(TASK_INITIAL_PROMPT_AUTOMATIC_RICH_REPLAY_LIMIT);
    expect(maximumBytes).toBeLessThan(STATE_BUDGET_BYTES);
    expect(elapsedMs).toBeLessThan(HISTORY_BUDGET_MS);
    await expect(journal.deleteTaskRecords('history-task')).resolves.toBe('complete');
    expect(journal.recordCount()).toBe(0);
    await expect(journal.deleteTaskRecords('history-task')).resolves.toBe('already-complete');
  });

  it('advances 10,000 proven-prewrite failures in place with exact CAS and replay-zero dispatch', async () => {
    const harness = createHarness('Ship it', () => ({
      kind: 'rejected-before-bytes',
      reason: 'agent-not-ready',
    }));
    await harness.service.queue(harness.deliveryRequest);
    let request = harness.manualRequest();
    let latestAttempt = 0;
    const startedAt = performance.now();

    for (let index = 0; index < PROVEN_PREWRITE_FAILURE_COUNT; index += 1) {
      const result = await harness.service.sendManually(request);
      if (
        result.kind !== 'operation' ||
        result.operation.phase !== 'failed-before-write' ||
        result.operation.manualSendOperationId !== request.manualSendOperationId
      ) {
        throw new Error(`Proven-prewrite workload diverged at operation ${index}`);
      }
      latestAttempt = result.operation.attempt;
      const dispatchCount = harness.counters.admissions;
      const replay = await harness.service.sendManually(request);
      if (
        replay.kind !== 'operation' ||
        !replay.replayed ||
        replay.operation.attempt !== latestAttempt ||
        harness.counters.admissions !== dispatchCount
      ) {
        throw new Error(`Replay admitted a second dispatch at operation ${index}`);
      }
      harness.advanceBy(MANUAL_INITIAL_PROMPT_SEND_RATE_LIMIT.refillIntervalMs);
      request = harness.manualRequest({
        failedAttempt: latestAttempt,
        kind: 'retry-proven-not-sent',
      });
    }

    const elapsedMs = performance.now() - startedAt;
    const record = await harness.journal.load('delivery-1');
    const retainedBytes = byteLength(record);
    process.stdout.write(
      `initial-prompt-proven-prewrite attempts=${latestAttempt} dispatches=${harness.counters.admissions} replays=${PROVEN_PREWRITE_FAILURE_COUNT} records=${harness.journal.recordCount()} retained=${retainedBytes}B elapsed=${elapsedMs.toFixed(2)}ms\n`,
    );

    expect(latestAttempt).toBe(PROVEN_PREWRITE_FAILURE_COUNT);
    expect(harness.counters.admissions).toBe(PROVEN_PREWRITE_FAILURE_COUNT);
    expect(harness.counters.leasesAcquired).toBe(PROVEN_PREWRITE_FAILURE_COUNT);
    expect(harness.counters.leasesReleased).toBe(PROVEN_PREWRITE_FAILURE_COUNT);
    expect(harness.journal.recordCount()).toBe(1);
    expect(retainedBytes).toBeLessThan(STATE_BUDGET_BYTES);
    expect(elapsedMs).toBeLessThan(FAILURE_WORKLOAD_BUDGET_MS);
  }, 35_000);

  it('caps automatic dispatch and manual byte-admission/materialization across every replay', async () => {
    const automaticFrames: Array<{ firstFrame: string; submitFrame?: string }> = [];
    const automatic = createHarness('Ship it', (dispatch) => {
      automaticFrames.push(dispatch);
      return { admittedSupervisionVersion: 4, kind: 'accepted', lowLevelCallCount: 1 };
    });
    await automatic.service.queue(automatic.deliveryRequest);
    const readyObservation = {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      state: 'idle-at-prompt' as const,
      supervisionVersion: 4,
      tail: '❯',
    };
    await automatic.service.processObservation('delivery-1', {
      ...readyObservation,
      nowMs: 2_000,
    });
    expect(automatic.counters.admissions).toBe(0);
    await automatic.service.processObservation('delivery-1', {
      ...readyObservation,
      nowMs: 2_600,
    });
    await automatic.service.processObservation('delivery-1', {
      ...readyObservation,
      nowMs: 3_200,
      returnedToReadySnapshot: true,
    });
    await automatic.service.processObservation('delivery-1', {
      ...readyObservation,
      nowMs: 3_800,
      returnedToReadySnapshot: true,
    });
    await automatic.service.processObservation('delivery-1', {
      ...readyObservation,
      nowMs: 4_400,
      returnedToReadySnapshot: true,
    });

    expect(automatic.counters.admissions).toBe(2);
    expect(automatic.counters.sleeps).toBe(1);
    expect(automatic.counters.leasesAcquired).toBe(1);
    expect(automatic.counters.leasesReleased).toBe(1);
    expect(automaticFrames.every((dispatch) => dispatch.submitFrame === undefined)).toBe(true);
    await expect(automatic.journal.load('delivery-1')).resolves.toMatchObject({
      snapshot: { attempts: 2, status: 'manual-required' },
    });

    const manualFrames: Array<{ firstFrame: string; submitFrame?: string }> = [];
    const multiline = createHarness('first line\nsecond line', (dispatch) => {
      manualFrames.push(dispatch);
      return { admittedSupervisionVersion: 4, kind: 'accepted', lowLevelCallCount: 2 };
    });
    await multiline.service.queue(multiline.deliveryRequest);
    const manual = multiline.manualRequest();
    await expect(multiline.service.sendManually(manual)).resolves.toMatchObject({
      operation: { phase: 'completed' },
    });
    await multiline.service.sendManually(manual);
    await multiline.service.sendManually(manual);
    expect(multiline.counters.admissions).toBe(1);
    expect(multiline.counters.leasesAcquired).toBe(1);
    expect(multiline.counters.leasesReleased).toBe(1);
    expect(manualFrames).toHaveLength(1);
    expect(manualFrames[0]?.submitFrame).toBeDefined();

    const ambiguous = createHarness('Ship it', () => ({
      admittedSupervisionVersion: 4,
      bytesMayHaveBeenAccepted: true,
      kind: 'outcome-ambiguous',
    }));
    await ambiguous.service.queue(ambiguous.deliveryRequest);
    const ambiguousRequest = ambiguous.manualRequest();
    const ambiguousResult = await ambiguous.service.sendManually(ambiguousRequest);
    await ambiguous.service.sendManually(ambiguousRequest);
    if (ambiguousResult.kind !== 'operation') throw new Error('Expected ambiguous operation');
    await ambiguous.service.resolveManualAmbiguity({
      expectedOperationVersion: ambiguousResult.operation.version,
      manualSendOperationId: ambiguousRequest.manualSendOperationId,
      resolution: 'abandon-to-terminal',
    });
    await ambiguous.service.sendManually(ambiguousRequest);
    expect(ambiguous.counters.admissions).toBe(1);
    expect(ambiguous.counters.leasesReleased).toBe(1);

    process.stdout.write(
      `initial-prompt-dispatch automatic=${automatic.counters.admissions} automaticSleeps=${automatic.counters.sleeps} manual=${multiline.counters.admissions} ambiguous=${ambiguous.counters.admissions} singleLineCalls=1 multilineCalls=2\n`,
    );
  });
});
