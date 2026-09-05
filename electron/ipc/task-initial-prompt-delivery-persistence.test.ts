import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  deriveManualInitialPromptSendOperationId,
  deriveTaskInitialPromptDraftFingerprint,
  reduceTaskInitialPromptDelivery,
  type ManualInitialPromptSendAttemptReceipt,
  type ManualInitialPromptSendOperationSnapshot,
  type TaskInitialPromptOwnerAvailability,
} from '../../src/domain/task-initial-prompt-delivery.js';
import type { PromptInputAdmissionResult } from '../../src/domain/task-prompt-input-admission.js';
import type { StorageEnv } from './storage.js';
import {
  createWorkspaceTaskInitialPromptPersistence,
  TaskInitialPromptPersistenceRecoveryError,
  type WorkspaceTaskInitialPromptPersistence,
} from './task-initial-prompt-delivery-persistence.js';
import {
  createTaskInitialPromptDeliveryService,
  type TaskInitialPromptAgentRuntimeSnapshot,
  type TaskInitialPromptCommandLease,
  type TaskInitialPromptDeliveryDependencies,
  type TaskInitialPromptDeliveryJournalRecord,
} from './task-initial-prompt-delivery.js';
import {
  WorkspaceMutationService,
  WorkspaceProtectedFieldConflictError,
  changed,
} from './workspace-state-mutations.js';
import {
  cloneJsonObject,
  createStandaloneWorkspaceStateStorage,
  type JsonObject,
  type WorkspaceStateStorage,
} from './workspace-state-storage.js';

let root = '';
let storage: WorkspaceStateStorage;
let workspace: WorkspaceMutationService;
let persistence: WorkspaceTaskInitialPromptPersistence;

function env(): StorageEnv {
  return { isPackaged: true, userDataPath: root };
}

function getTask(sharedState: JsonObject, taskId: string): JsonObject | null {
  const tasks = sharedState.tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return null;
  const task = tasks[taskId];
  return task && typeof task === 'object' && !Array.isArray(task) ? task : null;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-initial-prompt-persistence-'));
  storage = await createStandaloneWorkspaceStateStorage(env());
  workspace = new WorkspaceMutationService(storage);
  await workspace.replaceSharedState(
    { operation: 'seed' },
    {
      collapsedTaskOrder: [],
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          agentId: 'agent-1',
          branchName: 'task/one',
          id: 'task-1',
          lastPrompt: '',
          name: 'Task one',
          notes: '',
          projectId: 'project-1',
          savedInitialPrompt: 'Ship it',
          shellAgentIds: [],
          shellCount: 0,
          taskMode: 'agent',
          worktreePath: '/repo/.worktrees/task-1',
        },
      },
    },
    undefined,
  );
  persistence = createWorkspaceTaskInitialPromptPersistence(workspace, { now: () => 2_000 });
});

afterEach(async () => {
  await storage.close();
  fs.rmSync(root, { force: true, recursive: true });
});

function createRecord(
  deliveryId: string,
  fingerprint: string,
): TaskInitialPromptDeliveryJournalRecord {
  return {
    automationSealed: false,
    draftEditRevision: 0,
    expectedDraftFingerprint: fingerprint,
    request: {
      agentId: 'agent-1',
      deliveryId,
      expectedDraftFingerprint: fingerprint,
      readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
      taskId: 'task-1',
    },
    schemaVersion: 1,
    snapshot: {
      agentId: 'agent-1',
      attempts: 0,
      createdAt: '2026-08-04T00:00:00.000Z',
      deliveryId,
      status: 'waiting-agent-session',
      taskId: 'task-1',
      updatedAt: '2026-08-04T00:00:00.000Z',
      version: 1,
    },
    writeBegan: false,
  };
}

function createManualOperation(
  record: TaskInitialPromptDeliveryJournalRecord,
): ManualInitialPromptSendOperationSnapshot {
  const timestamp = record.snapshot.updatedAt;
  return {
    acknowledgedDraftFingerprint: record.expectedDraftFingerprint,
    acknowledgedEditRevision: record.draftEditRevision,
    agentId: record.request.agentId,
    attempt: 1,
    createdAt: timestamp,
    deliveryId: record.request.deliveryId,
    expectedAgentGeneration: 3,
    manualSendOperationId: deriveManualInitialPromptSendOperationId({
      acknowledgedDraftFingerprint: record.expectedDraftFingerprint,
      acknowledgedEditRevision: record.draftEditRevision,
      deliveryId: record.request.deliveryId,
    }),
    phase: 'automation-sealed',
    possiblePriorAutomaticWrite: false,
    taskId: record.request.taskId,
    updatedAt: timestamp,
    version: 1,
  };
}

function createTerminalReceipt(
  operation: ManualInitialPromptSendOperationSnapshot,
  outcome: ManualInitialPromptSendAttemptReceipt['outcome'],
  recovery: ManualInitialPromptSendAttemptReceipt['recovery'],
): ManualInitialPromptSendAttemptReceipt & { terminal: true } {
  return {
    acknowledgedDraftFingerprint: operation.acknowledgedDraftFingerprint,
    acknowledgedEditRevision: operation.acknowledgedEditRevision,
    agentId: operation.agentId,
    attempt: operation.attempt,
    completedAt: operation.updatedAt,
    deliveryId: operation.deliveryId,
    expectedAgentGeneration: operation.expectedAgentGeneration,
    manualSendOperationId: operation.manualSendOperationId,
    outcome,
    recovery,
    taskId: operation.taskId,
    terminal: true,
  };
}

async function activatePromptOwner() {
  await persistence.ensureDarkJournalReady();
  const cutover =
    await persistence.activatePromptProtectionAndDisableLegacyWriters('removal-cutover-v1');
  const task = getTask((await storage.loadCurrent()).record.sharedState, 'task-1');
  if (!task) {
    throw new Error('cutover task is missing');
  }
  const deliveryId = String(task.initialPromptDeliveryId);
  const fingerprint = deriveTaskInitialPromptDraftFingerprint({
    agentId: 'agent-1',
    readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
    taskId: 'task-1',
    text: 'Ship it',
  });
  return { cutover, deliveryId, fingerprint };
}

async function activateAndSeedJournal() {
  const activated = await activatePromptOwner();
  const { deliveryId, fingerprint } = activated;
  await persistence.journal.save(createRecord(deliveryId, fingerprint));
  return activated;
}

async function corruptJournal(corrupt: (journal: JsonObject) => void): Promise<void> {
  const authority = workspace.createPrivateMutationAuthority();
  await authority.mutate({ operation: 'corrupt-initial-prompt-journal-for-test' }, (slices) => {
    const privateState = cloneJsonObject(slices.privateState);
    const journal = privateState.initialPromptDeliveryJournal;
    if (!journal || typeof journal !== 'object' || Array.isArray(journal)) {
      throw new Error('initial prompt journal is missing');
    }
    corrupt(journal);
    return changed({ nextPrivateState: privateState }, undefined);
  });
}

async function corruptJournalRecord(
  deliveryId: string,
  corrupt: (record: JsonObject) => void,
): Promise<void> {
  await corruptJournal((journal) => {
    const records = journal.recordsByDeliveryId;
    if (!records || typeof records !== 'object' || Array.isArray(records)) {
      throw new Error('initial prompt delivery records are missing');
    }
    const record = records[deliveryId];
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('initial prompt delivery record is missing');
    }
    corrupt(record);
  });
}

async function createDurableServiceHarness(
  options: { admission?: PromptInputAdmissionResult } = {},
) {
  const { cutover, deliveryId, fingerprint } = await activatePromptOwner();
  let nowMs = 2_000;
  let runtime: TaskInitialPromptAgentRuntimeSnapshot = {
    generation: 3,
    lastOutputAtMs: 0,
    state: 'idle-at-prompt',
    supervisionVersion: 4,
    tail: '❯',
    taskId: 'task-1',
  };
  const releaseCommandLease = vi.fn();
  const acquireCommandLease = vi.fn(
    async (): Promise<TaskInitialPromptCommandLease | null> => ({
      controllerId: 'durable-client-1',
      leaseGeneration: 7,
      leaseOwnerId: 'durable-owner-1',
      release: releaseCommandLease,
    }),
  );
  const admitPrompt = vi.fn(
    async () =>
      options.admission ??
      ({
        admittedSupervisionVersion: 4,
        kind: 'accepted',
        lowLevelCallCount: 1,
      } satisfies PromptInputAdmissionResult),
  );
  const availability = {
    cutoverEpoch: cutover.cutoverEpoch,
    hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
    kind: 'active',
  } satisfies TaskInitialPromptOwnerAvailability;
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
    draftRepository: persistence.repository,
    getAgentRuntime: () => structuredClone(runtime),
    getOwnerAvailability: () => availability,
    journal: persistence.journal,
    removalGate: {
      getTaskSnapshot: () => ({
        current: {
          catalogVersion: 1,
          serverInstanceId: 'server-1',
          taskClosing: false,
          taskState: 'present',
        },
        cutoverEpoch: cutover.cutoverEpoch,
        hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
        kind: 'active',
      }),
      verifyCommittedRemoval: () => true,
    },
  };
  const service = createTaskInitialPromptDeliveryService(dependencies);
  const deliveryRequest = {
    agentId: 'agent-1',
    deliveryId,
    expectedDraftFingerprint: fingerprint,
    readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
    taskId: 'task-1',
  } as const;
  const manualRequest = (
    draftSnapshot: { editRevision: number; fingerprint: string } = {
      editRevision: 0,
      fingerprint,
    },
  ) => ({
    action: { kind: 'send' } as const,
    agentId: 'agent-1',
    confirmPossiblePriorAutomaticWrite: false,
    deliveryId,
    expectedAgentGeneration: 3,
    expectedDraftFingerprint: draftSnapshot.fingerprint,
    expectedEditRevision: draftSnapshot.editRevision,
    manualSendOperationId: deriveManualInitialPromptSendOperationId({
      acknowledgedDraftFingerprint: draftSnapshot.fingerprint,
      acknowledgedEditRevision: draftSnapshot.editRevision,
      deliveryId,
    }),
    taskId: 'task-1',
  });
  return {
    acquireCommandLease,
    admitPrompt,
    deliveryId,
    deliveryRequest,
    dependencies,
    manualRequest,
    releaseCommandLease,
    service,
    setNowMs: (next: number) => {
      nowMs = next;
    },
    setRuntime: (next: TaskInitialPromptAgentRuntimeSnapshot) => {
      runtime = structuredClone(next);
    },
  };
}

describe('durable initial prompt persistence', () => {
  it('prepares a dark empty journal without changing shared revision', async () => {
    await persistence.ensureDarkJournalReady();
    const first = await storage.loadCurrent();
    expect(first.record.sharedRevision).toBe(1);
    expect(first.record.privateState).toMatchObject({
      initialPromptDeliveryJournal: {
        deliveryIdByManualOperationId: {},
        deliveryIdsByTaskId: {},
        recordsByDeliveryId: {},
        schemaVersion: 1,
      },
    });
    const generation = first.record.storageGeneration;
    await persistence.ensureDarkJournalReady();
    expect((await storage.loadCurrent()).record.storageGeneration).toBe(generation);
  });

  it('round-trips valid automatic deadlines and rejects malformed deadline metadata', async () => {
    const { deliveryId } = await activateAndSeedJournal();
    const record = await persistence.journal.load(deliveryId);
    if (!record) throw new Error('seeded delivery record is missing');
    const validRecord: TaskInitialPromptDeliveryJournalRecord = {
      ...record,
      automaticReadyDeadlineAtMs: 47_000,
      automaticReadyDeadlineExtensionUsed: false,
      snapshot: {
        ...record.snapshot,
        status: 'waiting-ready',
        targetGeneration: 0,
        version: record.snapshot.version + 1,
      },
    };

    await persistence.journal.save(validRecord);
    await expect(persistence.journal.load(deliveryId)).resolves.toMatchObject({
      automaticReadyDeadlineAtMs: 47_000,
      automaticReadyDeadlineExtensionUsed: false,
    });

    const malformedRecords = [
      { ...validRecord, automaticReadyDeadlineAtMs: -1 },
      { ...validRecord, automaticReadyDeadlineAtMs: 47_000.5 },
      { ...validRecord, automaticReadyDeadlineAtMs: Number.MAX_SAFE_INTEGER + 1 },
      { ...validRecord, automaticReadyDeadlineAtMs: '47000' },
      { ...validRecord, automaticReadyDeadlineExtensionUsed: 'false' },
    ] as unknown as TaskInitialPromptDeliveryJournalRecord[];
    for (const malformedRecord of malformedRecords) {
      await expect(persistence.journal.save(malformedRecord)).rejects.toBeInstanceOf(
        TaskInitialPromptPersistenceRecoveryError,
      );
    }

    await expect(persistence.journal.load(deliveryId)).resolves.toMatchObject({
      automaticReadyDeadlineAtMs: 47_000,
      automaticReadyDeadlineExtensionUsed: false,
    });
  });

  it.each<readonly [string, (record: JsonObject) => void]>([
    [
      'unknown snapshot status',
      (record) => {
        const snapshot = record.snapshot as JsonObject;
        snapshot.status = 'unknown-status';
      },
    ],
    [
      'unparseable verifying timestamp',
      (record) => {
        const snapshot = record.snapshot as JsonObject;
        snapshot.status = 'verifying';
        snapshot.updatedAt = 'not-a-timestamp';
      },
    ],
    [
      'ready deadline without its extension marker',
      (record) => {
        record.automaticReadyDeadlineAtMs = 47_000;
      },
    ],
    [
      'ready deadline extension marker without its deadline',
      (record) => {
        record.automaticReadyDeadlineExtensionUsed = false;
      },
    ],
    [
      'negative draft revision',
      (record) => {
        record.draftEditRevision = -1;
      },
    ],
    [
      'malformed expected draft fingerprint',
      (record) => {
        record.expectedDraftFingerprint = 'not-a-fingerprint';
      },
    ],
    [
      'malformed readiness candidate',
      (record) => {
        record.readyCandidate = {
          generation: 0,
          normalizedFrameFingerprint: 'not-a-fingerprint',
          observedAtMs: 1_000,
        };
      },
    ],
    [
      'attempted delivery without a write-intent witness',
      (record) => {
        const snapshot = record.snapshot as JsonObject;
        snapshot.attempts = 1;
        snapshot.status = 'waiting-ready';
        snapshot.targetGeneration = 0;
      },
    ],
    [
      'pre-write readiness state with a write-intent witness',
      (record) => {
        const snapshot = record.snapshot as JsonObject;
        snapshot.status = 'waiting-ready';
        snapshot.targetGeneration = 0;
        record.automaticReadyDeadlineAtMs = 47_000;
        record.automaticReadyDeadlineExtensionUsed = false;
        record.writeBegan = true;
      },
    ],
    [
      'third-write-capable waiting lease',
      (record) => {
        const snapshot = record.snapshot as JsonObject;
        snapshot.attempts = 2;
        snapshot.status = 'waiting-lease';
        snapshot.targetGeneration = 0;
        record.writeBegan = true;
      },
    ],
    [
      'third-write-capable retry wait',
      (record) => {
        const snapshot = record.snapshot as JsonObject;
        snapshot.attempts = 2;
        snapshot.status = 'retry-wait';
        snapshot.targetGeneration = 0;
        record.writeBegan = true;
      },
    ],
    [
      'sealed automation with nonterminal delivery',
      (record) => {
        record.automationSealed = true;
      },
    ],
    [
      'unknown record field',
      (record) => {
        record.unownedPolicy = true;
      },
    ],
  ])('fails closed on corrupt journal metadata: %s', async (_label, corrupt) => {
    const { deliveryId } = await activateAndSeedJournal();
    await corruptJournalRecord(deliveryId, corrupt);

    await expect(persistence.journal.load(deliveryId)).rejects.toBeInstanceOf(
      TaskInitialPromptPersistenceRecoveryError,
    );
  });

  it('fails closed when a valid record is omitted from its task index', async () => {
    const { deliveryId } = await activateAndSeedJournal();
    await corruptJournal((journal) => {
      const deliveryIdsByTaskId = journal.deliveryIdsByTaskId as JsonObject;
      deliveryIdsByTaskId['task-1'] = [];
    });

    await expect(persistence.journal.load(deliveryId)).rejects.toBeInstanceOf(
      TaskInitialPromptPersistenceRecoveryError,
    );
  });

  it('rejects terminal receipts that contradict the manual operation phase', async () => {
    const { deliveryId } = await activateAndSeedJournal();
    const record = await persistence.journal.load(deliveryId);
    if (!record) throw new Error('seeded delivery record is missing');
    const operation = createManualOperation(record);
    const notSentReceipt = createTerminalReceipt(
      operation,
      { issue: { code: 'task-closing' }, kind: 'not-sent' },
      { kind: 'none' },
    );
    const sentReceipt = createTerminalReceipt(
      operation,
      {
        acknowledgedDraftFingerprint: operation.acknowledgedDraftFingerprint,
        acknowledgedEditRevision: operation.acknowledgedEditRevision,
        agentGeneration: operation.expectedAgentGeneration,
        clear: 'cleared',
        kind: 'sent',
      },
      {
        failedAttempt: operation.attempt,
        kind: 'retry-proven-not-sent',
        manualSendOperationId: operation.manualSendOperationId,
      },
    );
    const contradictoryOperations: ManualInitialPromptSendOperationSnapshot[] = [
      { ...operation, phase: 'write-intent-persisted', terminalReceipt: notSentReceipt },
      { ...operation, phase: 'failed-before-write', terminalReceipt: sentReceipt },
      { ...operation, phase: 'completed', terminalReceipt: notSentReceipt },
    ];
    const sealedSnapshot = reduceTaskInitialPromptDelivery(
      record.snapshot,
      { kind: 'automation-sealed', possiblePriorWrite: false },
      record.snapshot.updatedAt,
    ).snapshot;

    for (const manualSendOperation of contradictoryOperations) {
      await expect(
        persistence.journal.save({
          ...record,
          automationSealed: true,
          manualSendOperation,
          snapshot: sealedSnapshot,
        }),
      ).rejects.toBeInstanceOf(TaskInitialPromptPersistenceRecoveryError);
    }
  });

  it('fails closed when a current manual operation is omitted from its reverse index', async () => {
    const { deliveryId } = await activateAndSeedJournal();
    const record = await persistence.journal.load(deliveryId);
    if (!record) throw new Error('seeded delivery record is missing');
    const manualSendOperation = createManualOperation(record);
    const manualSendOperationId = manualSendOperation.manualSendOperationId;
    await persistence.journal.save({
      ...record,
      automationSealed: true,
      manualSendOperation,
      snapshot: reduceTaskInitialPromptDelivery(
        record.snapshot,
        { kind: 'automation-sealed', possiblePriorWrite: false },
        record.snapshot.updatedAt,
      ).snapshot,
    });
    await corruptJournal((journal) => {
      const deliveryIdByManualOperationId = journal.deliveryIdByManualOperationId as JsonObject;
      Reflect.deleteProperty(deliveryIdByManualOperationId, manualSendOperationId);
    });

    await expect(persistence.journal.load(deliveryId)).rejects.toBeInstanceOf(
      TaskInitialPromptPersistenceRecoveryError,
    );
  });

  it('migrates the one legacy draft, disables its duplicate, and activates protection atomically', async () => {
    await persistence.ensureDarkJournalReady();
    const result =
      await persistence.activatePromptProtectionAndDisableLegacyWriters('removal-cutover-v1');
    expect(result).toEqual({
      cutoverEpoch: 'removal-cutover-v1',
      hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
      legacyWritersDisabled: true,
      migratedLegacyDrafts: 1,
      protectedPolicyVersion: '1',
    });
    const snapshot = await storage.loadCurrent();
    expect(getTask(snapshot.record.sharedState, 'task-1')).toMatchObject({
      initialPrompt: 'Ship it',
      initialPromptDeliveryId: expect.stringMatching(/^legacy:task-1:agent-1:/u),
      initialPromptDeliveryMode: 'automatic',
    });
    expect(getTask(snapshot.record.sharedState, 'task-1')).not.toHaveProperty('savedInitialPrompt');
    expect(snapshot.record.privateState).toMatchObject({
      initialPromptDeliveryOwnerSchema: {
        cutoverEpoch: 'removal-cutover-v1',
        hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
        legacyWritersDisabled: true,
      },
      protectedWorkspacePolicyVersions: { 'initial-prompt': '1' },
    });

    const generation = snapshot.record.storageGeneration;
    await persistence.activatePromptProtectionAndDisableLegacyWriters('removal-cutover-v1');
    expect((await storage.loadCurrent()).record.storageGeneration).toBe(generation);
  });

  it('rejects stale full saves that alter or omit canonical prompt ownership fields', async () => {
    await activateAndSeedJournal();
    const current = await storage.loadCurrent();
    const proposal = cloneJsonObject(current.record.sharedState);
    const task = getTask(proposal, 'task-1');
    if (!task) throw new Error('task missing');
    task.initialPrompt = 'stale overwrite';
    await expect(
      workspace.replaceSharedState({ operation: 'stale-save' }, proposal, undefined),
    ).rejects.toBeInstanceOf(WorkspaceProtectedFieldConflictError);
  });

  it('serializes edit CAS, conflict, replay, exact clear, and sealed stale replay', async () => {
    const { deliveryId, fingerprint } = await activateAndSeedJournal();
    const beforeEditRecord = await persistence.journal.load(deliveryId);
    if (!beforeEditRecord) throw new Error('seeded delivery record is missing');
    const edit = {
      editOperationId: 'edit-1',
      expectedDraftFingerprint: fingerprint,
      expectedEditRevision: 0,
      revisedText: 'Ship it safely',
      sourceDeliveryId: deliveryId,
      taskId: 'task-1',
    };
    const saved = await persistence.repository.reviseAfterUserEdit(edit);
    expect(saved).toMatchObject({
      current: { editRevision: 1, mode: 'manual-only', text: 'Ship it safely' },
      kind: 'saved-manual-draft',
    });
    const afterEditRecord = await persistence.journal.load(deliveryId);
    expect(afterEditRecord?.snapshot.version).toBe(beforeEditRecord.snapshot.version + 1);
    const afterEditBytes = JSON.stringify(afterEditRecord);
    const afterEditStorageGeneration = (await storage.loadCurrent()).record.storageGeneration;
    await expect(persistence.repository.reviseAfterUserEdit(edit)).resolves.toMatchObject({
      current: { editRevision: 1, text: 'Ship it safely' },
      kind: 'replayed',
    });
    expect((await storage.loadCurrent()).record.storageGeneration).toBe(afterEditStorageGeneration);
    expect(JSON.stringify(await persistence.journal.load(deliveryId))).toBe(afterEditBytes);
    await expect(
      persistence.repository.reviseAfterUserEdit({
        ...edit,
        editOperationId: 'competing-edit',
        revisedText: 'Overwrite silently',
      }),
    ).resolves.toMatchObject({ kind: 'draft-conflict' });

    await expect(
      persistence.repository.clearAfterAcceptedOutcome({
        deliveryId,
        expectedDraftFingerprint: fingerprint,
        expectedEditRevision: 0,
        reason: 'automatic-delivered',
        taskId: 'task-1',
      }),
    ).resolves.toMatchObject({ kind: 'draft-changed' });
    const current = saved.current;
    if (!current) throw new Error('current draft is missing');
    await expect(
      persistence.repository.clearAfterAcceptedOutcome({
        deliveryId,
        expectedDraftFingerprint: current.fingerprint,
        expectedEditRevision: current.editRevision,
        reason: 'manual-send-accepted',
        taskId: 'task-1',
      }),
    ).resolves.toMatchObject({ kind: 'cleared' });
    await expect(persistence.repository.reviseAfterUserEdit(edit)).resolves.toMatchObject({
      current: null,
      kind: 'delivery-closed',
    });
  });

  it('persists no prompt content and atomically deletes the exact task index', async () => {
    const { deliveryId, fingerprint } = await activateAndSeedJournal();
    const serialized = JSON.stringify((await storage.loadCurrent()).record.privateState);
    expect(serialized).not.toContain('Ship it');
    expect(await persistence.journal.listTaskRecords('task-1')).toHaveLength(1);
    await expect(persistence.journal.deleteTaskRecords('task-1')).resolves.toBe('complete');
    await expect(persistence.journal.load(deliveryId)).resolves.toBeNull();
    await expect(persistence.journal.deleteTaskRecords('task-1')).resolves.toBe('already-complete');

    await expect(
      persistence.journal.save({
        ...createRecord('delivery-forbidden', fingerprint),
        text: 'must never persist',
      } as TaskInitialPromptDeliveryJournalRecord),
    ).rejects.toBeInstanceOf(TaskInitialPromptPersistenceRecoveryError);
  });
});

describe('delivery service compatibility with durable persistence', () => {
  it('persists automatic deadline, generation, write, and terminal transitions', async () => {
    const harness = await createDurableServiceHarness();
    await harness.service.queue(harness.deliveryRequest);
    await harness.service.processObservation(harness.deliveryId, {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 2_100,
      nowMs: 2_100,
      state: 'active',
      supervisionVersion: 4,
      tail: 'starting',
    });
    await harness.service.processObservation(harness.deliveryId, {
      agentId: 'agent-1',
      generation: 4,
      lastOutputAtMs: 2_200,
      nowMs: 2_200,
      state: 'active',
      supervisionVersion: 5,
      tail: 'restarting',
    });
    await harness.service.processObservation(harness.deliveryId, {
      agentId: 'agent-1',
      generation: 4,
      lastOutputAtMs: 2_300,
      nowMs: 3_000,
      state: 'idle-at-prompt',
      supervisionVersion: 5,
      tail: '❯',
    });
    harness.setNowMs(4_000);
    await harness.service.processObservation(harness.deliveryId, {
      agentId: 'agent-1',
      generation: 4,
      lastOutputAtMs: 2_300,
      nowMs: 4_000,
      state: 'idle-at-prompt',
      supervisionVersion: 5,
      tail: '❯',
    });
    await expect(persistence.journal.load(harness.deliveryId)).resolves.toMatchObject({
      automaticReadyDeadlineExtensionUsed: true,
      snapshot: { attempts: 1, status: 'verifying', targetGeneration: 4 },
      writeBegan: true,
    });

    await harness.service.processObservation(harness.deliveryId, {
      activityTransitionObserved: true,
      agentId: 'agent-1',
      generation: 4,
      lastOutputAtMs: 4_100,
      nowMs: 4_200,
      state: 'active',
      supervisionVersion: 6,
      tail: 'working',
    });
    await expect(persistence.journal.load(harness.deliveryId)).resolves.toMatchObject({
      snapshot: { attempts: 1, status: 'delivered' },
    });
    expect(await persistence.journal.listTaskRecords('task-1')).toHaveLength(1);
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.releaseCommandLease).toHaveBeenCalledTimes(1);
  });

  it.each(['accepted', 'failure', 'reconciliation'] as const)(
    'persists the representative manual %s path and its reverse index',
    async (path) => {
      const harness = await createDurableServiceHarness(
        path === 'reconciliation'
          ? {
              admission: {
                admittedSupervisionVersion: 4,
                bytesMayHaveBeenAccepted: true,
                kind: 'outcome-ambiguous',
              },
            }
          : {},
      );
      if (path === 'failure') {
        harness.setRuntime({
          generation: 3,
          lastOutputAtMs: 2_000,
          state: 'active',
          supervisionVersion: 4,
          tail: 'working',
          taskId: 'task-1',
        });
      }
      await harness.service.queue(harness.deliveryRequest);
      const request = harness.manualRequest();
      const result = await harness.service.sendManually(request);

      if (path === 'accepted') {
        expect(result).toMatchObject({ operation: { phase: 'completed' } });
      } else if (path === 'failure') {
        expect(result).toMatchObject({ operation: { phase: 'failed-before-write' } });
      } else {
        expect(result).toMatchObject({
          operation: { phase: 'manual-reconciliation-required' },
        });
        const operation = result.kind === 'operation' ? result.operation : null;
        if (!operation) throw new Error('manual reconciliation operation is missing');
        await harness.service.resolveManualAmbiguity({
          expectedOperationVersion: operation.version,
          manualSendOperationId: operation.manualSendOperationId,
          resolution: 'abandon-to-terminal',
        });
      }

      const indexed = await persistence.journal.findManualOperation(request.manualSendOperationId);
      expect(indexed?.manualSendOperation?.manualSendOperationId).toBe(
        request.manualSendOperationId,
      );
      await expect(persistence.journal.load(harness.deliveryId)).resolves.not.toBeNull();
    },
  );

  it('persists confirmation, edit, and removal-drain transitions together', async () => {
    const harness = await createDurableServiceHarness();
    await harness.service.queue(harness.deliveryRequest);
    await harness.service.processObservation(harness.deliveryId, {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_000,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    harness.setNowMs(2_600);
    await harness.service.processObservation(harness.deliveryId, {
      agentId: 'agent-1',
      generation: 3,
      lastOutputAtMs: 0,
      nowMs: 2_600,
      state: 'idle-at-prompt',
      supervisionVersion: 4,
      tail: '❯',
    });
    const request = harness.manualRequest();
    await expect(harness.service.sendManually(request)).resolves.toMatchObject({
      operation: { phase: 'confirmation-required' },
    });
    await expect(
      harness.service.reviseDraft({
        editOperationId: 'durable-edit-1',
        expectedDraftFingerprint: request.expectedDraftFingerprint,
        expectedEditRevision: request.expectedEditRevision,
        revisedText: 'Ship the durable revision',
        sourceDeliveryId: harness.deliveryId,
        taskId: 'task-1',
      }),
    ).resolves.toMatchObject({ kind: 'saved-manual-draft' });
    await expect(
      harness.service.drainTaskForRemoval({
        deletionOperationId: 'durable-delete-1',
        taskId: 'task-1',
      }),
    ).resolves.toMatchObject({ kind: 'complete' });
    await expect(persistence.journal.load(harness.deliveryId)).resolves.toMatchObject({
      manualSendOperation: {
        phase: 'failed-before-write',
        terminalReceipt: { terminal: true },
      },
    });
  });

  it.each(['accepted', 'observed-sent reconciliation'] as const)(
    'preserves the sealed edit high-water through manual %s',
    async (path) => {
      const harness = await createDurableServiceHarness(
        path === 'observed-sent reconciliation'
          ? {
              admission: {
                admittedSupervisionVersion: 4,
                bytesMayHaveBeenAccepted: true,
                kind: 'outcome-ambiguous',
              },
            }
          : {},
      );
      await harness.service.queue(harness.deliveryRequest);
      const editOperationId = `edit-before-${path}`;
      const revised = await harness.service.reviseDraft({
        editOperationId,
        expectedDraftFingerprint: harness.deliveryRequest.expectedDraftFingerprint,
        expectedEditRevision: 0,
        revisedText: `Durable ${path}`,
        sourceDeliveryId: harness.deliveryId,
        taskId: 'task-1',
      });
      const revisedDraft = revised.kind === 'saved-manual-draft' ? revised.current : null;
      if (!revisedDraft) throw new Error('revised durable draft is missing');
      const request = harness.manualRequest(revisedDraft);
      const sent = await harness.service.sendManually(request);

      if (path === 'observed-sent reconciliation') {
        const operation = sent.kind === 'operation' ? sent.operation : null;
        if (!operation) throw new Error('ambiguous durable operation is missing');
        await harness.service.resolveManualAmbiguity({
          expectedOperationVersion: operation.version,
          manualSendOperationId: operation.manualSendOperationId,
          resolution: 'observed-sent',
        });
      } else {
        expect(sent).toMatchObject({ operation: { phase: 'completed' } });
      }

      await expect(persistence.journal.load(harness.deliveryId)).resolves.toMatchObject({
        editHighWater: {
          editSealed: true,
          highestEditRevision: revisedDraft.editRevision,
          highestInputFingerprint: revisedDraft.fingerprint,
          highestOperationId: editOperationId,
        },
      });
    },
  );

  it('repairs an accepted manual operation through the durable journal after restart', async () => {
    const harness = await createDurableServiceHarness();
    await harness.service.queue(harness.deliveryRequest);
    const editOperationId = 'edit-before-restart-repair';
    const revised = await harness.service.reviseDraft({
      editOperationId,
      expectedDraftFingerprint: harness.deliveryRequest.expectedDraftFingerprint,
      expectedEditRevision: 0,
      revisedText: 'Repair this revised draft',
      sourceDeliveryId: harness.deliveryId,
      taskId: 'task-1',
    });
    const revisedDraft = revised.kind === 'saved-manual-draft' ? revised.current : null;
    if (!revisedDraft) throw new Error('revised restart draft is missing');
    vi.spyOn(persistence.repository, 'clearAfterAcceptedOutcome').mockRejectedValueOnce(
      new Error('clear unavailable before restart'),
    );
    await expect(
      harness.service.sendManually(harness.manualRequest(revisedDraft)),
    ).resolves.toMatchObject({ operation: { phase: 'write-accepted' } });
    await harness.service.close();

    const restarted = createTaskInitialPromptDeliveryService(harness.dependencies);
    await expect(restarted.repairAfterRestart()).resolves.toMatchObject({
      completedAcceptedManualOperations: 1,
    });
    await expect(persistence.journal.load(harness.deliveryId)).resolves.toMatchObject({
      editHighWater: {
        editSealed: true,
        highestEditRevision: revisedDraft.editRevision,
        highestInputFingerprint: revisedDraft.fingerprint,
        highestOperationId: editOperationId,
      },
      manualSendOperation: { phase: 'completed' },
    });
    expect(harness.admitPrompt).toHaveBeenCalledTimes(1);
  });
});
