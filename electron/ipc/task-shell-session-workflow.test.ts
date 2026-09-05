import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskShellSessionCurrentProjection } from '../../src/domain/task-shell-session-operation.js';
import { createTaskCreationOperationTicketIssuer } from './task-creation-operation-ticket.js';
import {
  TASK_SHELL_SESSION_JOURNAL_ACTIVE_PER_PRINCIPAL_LIMIT,
  TASK_SHELL_SESSION_JOURNAL_FORMAT_VERSION,
  TASK_SHELL_SESSION_RETENTION_MS,
  createTaskShellSessionJournal,
  decodeTaskShellSessionJournalRecord,
  type TaskShellSessionFullRecord,
  type TaskShellSessionJournal,
} from './task-shell-session-journal.js';
import {
  createTaskShellSessionWorkflow,
  hashTaskShellSessionOperationCapability,
  TaskShellSessionCapacityError,
  TaskShellSessionJournalUnavailableError,
  type TaskShellCreationMappingInspection,
  type TaskShellSessionTupleAuthority,
  type TaskShellTupleInspection,
  type TaskShellTupleSpawnResult,
} from './task-shell-session-workflow.js';

const directories: string[] = [];
const journals: TaskShellSessionJournal[] = [];

afterEach(async () => {
  await Promise.allSettled(journals.splice(0).map((journal) => journal.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { force: true, recursive: true })),
  );
});

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function makeJournal(
  options: Parameters<typeof createTaskShellSessionJournal>[1] = {},
): Promise<TaskShellSessionJournal> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'parallel-code-shell-'));
  directories.push(directory);
  const journal = createTaskShellSessionJournal(
    { isPackaged: true, userDataPath: directory },
    { ...options, rootPath: path.join(directory, 'journal') },
  );
  journals.push(journal);
  await journal.activateFresh();
  return journal;
}

function current(): TaskShellSessionCurrentProjection {
  return {
    catalogVersion: 0,
    serverInstanceId: 'server-1',
    session: null,
    task: null,
    taskClosing: false,
    taskState: 'not-visible',
    workspaceRevision: 1,
  };
}

function managedCurrent(): TaskShellSessionCurrentProjection {
  return {
    catalogVersion: 1,
    serverInstanceId: 'server-1',
    session: null,
    task: {
      branchLabel: 'task/task-1',
      branchLabelTruncated: false,
      creationStatus: 'ready',
      lifecycle: 'active',
      location: 'managed-worktree',
      name: 'Terminal task',
      nameTruncated: false,
      ownership: 'managed',
      primarySessionId: 'session-1',
      projectId: 'project-1',
      sessionCount: 1,
      taskId: 'task-1',
      taskMode: 'terminal',
    },
    taskClosing: false,
    taskState: 'present',
    workspaceRevision: 1,
  };
}

function record(index: number, principal = 'principal'): TaskShellSessionFullRecord {
  return {
    capabilityHash: digest(`capability-${index}`),
    committedWorkspaceRevision: null,
    createdAtMs: 100,
    creationOperationId: `creation-${index}`,
    expectedGeneration: 0,
    formatVersion: TASK_SHELL_SESSION_JOURNAL_FORMAT_VERSION,
    kind: 'full',
    operationId: `launch-${index}`,
    phase: 'reserved-for-task-commit',
    recordVersion: 1,
    sessionId: `session-${index}`,
    taskId: `task-${index}`,
    updatedAtMs: 100,
    workspacePrincipalHash: digest(principal),
  };
}

function harness(args: {
  current?: TaskShellSessionCurrentProjection;
  inspection?: TaskShellTupleInspection[];
  journal: TaskShellSessionJournal;
  mapping?: TaskShellCreationMappingInspection;
  now?: () => number;
  spawn?: TaskShellTupleSpawnResult;
}) {
  const inspections = [...(args.inspection ?? [{ kind: 'not-admitted' }])];
  const authority: TaskShellSessionTupleAuthority = {
    closeExactOperationOwnedTuple: vi.fn(async (): Promise<'closed'> => 'closed'),
    inspectExactTuple: vi.fn(
      async (): Promise<TaskShellTupleInspection> =>
        inspections.shift() ?? { kind: 'not-admitted' },
    ),
    spawnExactTuple: vi.fn(
      async (): Promise<TaskShellTupleSpawnResult> =>
        args.spawn ?? {
          kind: 'accepted',
          supervisorIdentityHash: digest('supervisor'),
        },
    ),
  };
  const workflow = createTaskShellSessionWorkflow({
    authority,
    inspectCreationMapping: vi.fn(
      async (): Promise<TaskShellCreationMappingInspection> =>
        args.mapping ?? { committedWorkspaceRevision: 1, kind: 'committed' },
    ),
    journal: args.journal,
    ...(args.now ? { now: args.now } : {}),
    readCurrent: vi.fn(async () => args.current ?? current()),
    verifyCreationReservation: vi.fn(async () => true),
    verifyRemovalCommit: vi.fn(async () => true),
    verifyTaskIdentityForRemoval: vi.fn(async () => true),
  });
  return { authority, workflow };
}

function reservationRequest(index = 1) {
  const capability = createTaskCreationOperationTicketIssuer().createOperationCapability();
  return {
    capability,
    request: {
      capabilityHash: hashTaskShellSessionOperationCapability(capability),
      creationOperationId: `creation-${index}`,
      expectedGeneration: 0,
      operationId: `launch-${index}`,
      sessionId: `session-${index}`,
      taskId: `task-${index}`,
      workspacePrincipalHash: digest('principal'),
    },
  };
}

async function reserveAndAdmit(journal: TaskShellSessionJournal, now?: () => number) {
  const test = harness({ journal, ...(now ? { now } : {}) });
  const { capability, request } = reservationRequest();
  await test.workflow.reserveForTaskCommit(request);
  await test.workflow.admitAfterTaskCommit({
    committedWorkspaceRevision: 1,
    creationOperationId: request.creationOperationId,
    operationId: request.operationId,
    taskId: request.taskId,
  });
  return { ...test, capability, request };
}

describe('task-shell-session journal', () => {
  it('activates the exact shard topology and rebuilds O(1) indexes after restart', async () => {
    const journal = await makeJournal();
    await journal.save(record(1), null);
    expect(journal.getCounts()).toMatchObject({ active: 1, records: 1, richAndReserved: 1 });
    expect(journal.getByTaskId('task-1')?.operationId).toBe('launch-1');
    const shardNames = (await fs.promises.readdir(path.join(directories[0], 'journal'))).filter(
      (name) => /^[a-f0-9]{2}$/u.test(name),
    );
    expect(shardNames).toHaveLength(256);
    await journal.close();
    journals.splice(journals.indexOf(journal), 1);

    const restarted = createTaskShellSessionJournal(
      { isPackaged: true, userDataPath: directories[0] },
      { rootPath: path.join(directories[0], 'journal') },
    );
    journals.push(restarted);
    await expect(restarted.startup()).resolves.toMatchObject({ health: 'healthy' });
    expect(restarted.getByTaskId('task-1')?.operationId).toBe('launch-1');
  });

  it('rejects unknown fields and illegal record-version transitions', async () => {
    expect(() => decodeTaskShellSessionJournalRecord({ ...record(1), path: '/secret' })).toThrow(
      'record shape',
    );
    const journal = await makeJournal();
    await journal.save(record(1), null);
    await expect(
      journal.save(
        {
          ...record(1),
          committedWorkspaceRevision: 1,
          recordVersion: 2,
          phase: 'spawning',
        },
        1,
      ),
    ).rejects.toThrow('Illegal');
  });

  it('enforces active principal capacity before an external effect can run', async () => {
    const journal = await makeJournal();
    for (let index = 0; index < TASK_SHELL_SESSION_JOURNAL_ACTIVE_PER_PRINCIPAL_LIMIT; index += 1) {
      await journal.save(record(index), null);
    }
    await expect(
      journal.save(record(TASK_SHELL_SESSION_JOURNAL_ACTIVE_PER_PRINCIPAL_LIMIT), null),
    ).rejects.toThrow('principal capacity');
    expect(journal.getCounts().records).toBe(TASK_SHELL_SESSION_JOURNAL_ACTIVE_PER_PRINCIPAL_LIMIT);
  });

  it('retains a proposed rename until directory durability is repaired', async () => {
    let fail = true;
    const journal = await makeJournal({
      faultInjector(point) {
        if (fail && point === 'after-record-rename') {
          fail = false;
          throw new Error('lost directory acknowledgement');
        }
      },
    });
    const result = await journal.save(record(1), null);
    expect(result.kind).toBe('durability-repair-required');
    expect(journal.get('launch-1')).toBeNull();
    await expect(journal.repairDurability()).resolves.toBe(true);
    expect(journal.get('launch-1')?.recordVersion).toBe(1);
  });
});

describe('task-shell-session workflow', () => {
  it('writes every phase before spawn and records only the exact acknowledged tuple', async () => {
    const journal = await makeJournal();
    const { workflow, authority, request } = await reserveAndAdmit(journal);
    vi.mocked(authority.inspectExactTuple)
      .mockResolvedValueOnce({ kind: 'not-admitted' })
      .mockResolvedValueOnce({ kind: 'running', supervisorIdentityHash: digest('supervisor') });

    const replay = await workflow.start(request);
    expect(replay).toMatchObject({ phase: 'running', recordVersion: 5, replayKind: 'full' });
    expect(authority.spawnExactTuple).toHaveBeenCalledTimes(1);
    expect(vi.mocked(authority.spawnExactTuple).mock.calls[0]?.[0]).toMatchObject({
      expectedGeneration: 0,
      operationId: request.operationId,
      sessionId: request.sessionId,
    });
  });

  it('does not present spawn when the write-ahead record lacks durability acknowledgement', async () => {
    let writeCount = 0;
    const journal = await makeJournal({
      faultInjector(point) {
        if (point === 'after-record-rename' && ++writeCount === 3) {
          throw new Error('spawning durability lost');
        }
      },
    });
    const { workflow, authority, request } = await reserveAndAdmit(journal);
    await expect(workflow.start(request)).rejects.toBeInstanceOf(
      TaskShellSessionJournalUnavailableError,
    );
    expect(authority.spawnExactTuple).not.toHaveBeenCalled();
  });

  it('offers same-tuple retry only for a proven pre-process failure and never changes generation', async () => {
    let now = 1_000;
    const journal = await makeJournal();
    const test = harness({
      journal,
      now: () => now,
      spawn: { kind: 'failed-before-process' },
    });
    const { capability, request } = reservationRequest();
    await test.workflow.reserveForTaskCommit(request);
    await test.workflow.admitAfterTaskCommit({
      committedWorkspaceRevision: 1,
      creationOperationId: request.creationOperationId,
      operationId: request.operationId,
      taskId: request.taskId,
    });
    const failed = await test.workflow.start(request);
    expect(failed).toMatchObject({
      disposition: { kind: 'same-tuple-retry' },
      phase: 'failed',
    });

    vi.mocked(test.authority.spawnExactTuple).mockResolvedValueOnce({
      kind: 'accepted',
      supervisorIdentityHash: digest('supervisor'),
    });
    vi.mocked(test.authority.inspectExactTuple)
      .mockResolvedValueOnce({ kind: 'not-admitted' })
      .mockResolvedValueOnce({ kind: 'running', supervisorIdentityHash: digest('supervisor') });
    now += 1;
    const retried = await test.workflow.retrySameTuple({
      action: 'retry-same-tuple',
      expectedRecordVersion: failed.recordVersion,
      operationCapability: capability,
      operationId: request.operationId,
    });
    expect(retried.outcome).toBe('accepted');
    expect(retried.shellLaunch.identity.expectedGeneration).toBe(0);
  });

  it('expires retry at the exact boundary and compacts it to a no-replay marker', async () => {
    let now = 2_000;
    const journal = await makeJournal();
    const test = harness({
      journal,
      now: () => now,
      spawn: { kind: 'failed-before-process' },
    });
    const { capability, request } = reservationRequest();
    await test.workflow.reserveForTaskCommit(request);
    await test.workflow.admitAfterTaskCommit({
      committedWorkspaceRevision: 1,
      creationOperationId: request.creationOperationId,
      operationId: request.operationId,
      taskId: request.taskId,
    });
    const failed = await test.workflow.start(request);
    now += TASK_SHELL_SESSION_RETENTION_MS;
    const result = await test.workflow.retrySameTuple({
      action: 'retry-same-tuple',
      expectedRecordVersion: failed.recordVersion,
      operationCapability: capability,
      operationId: request.operationId,
    });
    expect(result).toMatchObject({
      outcome: 'not-retryable',
      shellLaunch: { replayKind: 'initial-launch-marker' },
    });
  });

  it('quarantines ambiguous spawn and clears it only after exact local proof', async () => {
    const journal = await makeJournal();
    const test = harness({
      journal,
      inspection: [{ kind: 'not-admitted' }],
      spawn: { kind: 'ambiguous', supervisorIdentityHash: digest('supervisor') },
    });
    const { request } = reservationRequest();
    await test.workflow.reserveForTaskCommit(request);
    await test.workflow.admitAfterTaskCommit({
      committedWorkspaceRevision: 1,
      creationOperationId: request.creationOperationId,
      operationId: request.operationId,
      taskId: request.taskId,
    });
    const ambiguous = await test.workflow.start(request);
    expect(ambiguous).toMatchObject({ phase: 'manual-reconciliation-required' });
    expect(test.workflow.isTaskSpawnQuarantined(request.taskId)).toBe(true);

    vi.mocked(test.authority.inspectExactTuple).mockResolvedValueOnce({
      kind: 'running',
      supervisorIdentityHash: digest('supervisor'),
    });
    const resolved = await test.workflow.resolveAmbiguity({
      action: 'adopt-if-exact-running',
      expectedRecordVersion: ambiguous.recordVersion,
      operationId: request.operationId,
    });
    expect(resolved.outcome).toBe('adopted');
    expect(test.workflow.isTaskSpawnQuarantined(request.taskId)).toBe(false);
  });

  it('reconciles precommit and post-presentation restart states without spawning', async () => {
    const journal = await makeJournal();
    const absent = harness({ journal, mapping: { kind: 'absent' } });
    const first = reservationRequest(1);
    await absent.workflow.reserveForTaskCommit(first.request);
    const repaired = await absent.workflow.repairAfterRestart();
    expect(repaired.cancelledBeforeCommit).toBe(1);
    expect(absent.authority.spawnExactTuple).not.toHaveBeenCalled();
    expect((await absent.workflow.get(first.request.operationId))?.replayKind).toBe(
      'deletion-tombstone',
    );
  });

  it('persists one clean-restart generation only after exact stop proof and restores it once', async () => {
    const journal = await makeJournal();
    const first = harness({
      current: managedCurrent(),
      inspection: [
        { kind: 'not-admitted' },
        { kind: 'running', supervisorIdentityHash: digest('supervisor') },
        { kind: 'running', supervisorIdentityHash: digest('supervisor') },
        { kind: 'failed' },
      ],
      journal,
    });
    const { request } = reservationRequest();
    await first.workflow.reserveForTaskCommit(request);
    await first.workflow.admitAfterTaskCommit({
      committedWorkspaceRevision: 1,
      creationOperationId: request.creationOperationId,
      operationId: request.operationId,
      taskId: request.taskId,
    });
    await first.workflow.start(request);

    const [candidate] = await first.workflow.beginCleanRestartDrain();
    expect(candidate).toMatchObject({
      sessionId: request.sessionId,
      sourceGeneration: 0,
      targetGeneration: 1,
      taskId: request.taskId,
    });
    if (!candidate) throw new Error('Expected a clean-restart candidate');
    await expect(first.workflow.persistCleanRestartPermit(candidate)).resolves.toMatchObject({
      kind: 'prepared',
      sourceGeneration: 0,
      targetGeneration: 1,
    });
    const pending = journal.get(request.operationId);
    expect(pending).toMatchObject({
      generationHighWater: 1,
      kind: 'restart-lifecycle',
      phase: 'clean-restart-pending',
    });

    await journal.compact(Number.MAX_SAFE_INTEGER);
    expect(journal.get(request.operationId)).toEqual(pending);

    const restarted = harness({
      current: managedCurrent(),
      inspection: [
        { kind: 'not-admitted' },
        { kind: 'running', supervisorIdentityHash: digest('restart-supervisor') },
        { kind: 'running', supervisorIdentityHash: digest('restart-supervisor') },
      ],
      journal,
      spawn: { kind: 'accepted', supervisorIdentityHash: digest('restart-supervisor') },
    });
    const restored = await restarted.workflow.restoreManagedSession({
      launchOperationId: request.operationId,
      sessionId: request.sessionId,
      taskId: request.taskId,
    });
    expect(restored).toEqual({
      generation: 1,
      kind: 'restored',
      sessionId: request.sessionId,
      taskId: request.taskId,
    });
    expect(restarted.authority.spawnExactTuple).toHaveBeenCalledOnce();
    expect(vi.mocked(restarted.authority.spawnExactTuple).mock.calls[0]?.[0]).toMatchObject({
      admissionKind: 'clean-restart',
      expectedGeneration: 1,
      initialExpectedGeneration: 0,
      launchOperationId: request.operationId,
    });

    await expect(
      restarted.workflow.restoreManagedSession({
        launchOperationId: request.operationId,
        sessionId: request.sessionId,
        taskId: request.taskId,
      }),
    ).resolves.toMatchObject({ generation: 1, kind: 'existing' });
    expect(restarted.authority.spawnExactTuple).toHaveBeenCalledOnce();
  });

  it('does not persist a restart permit while the snapshotted shell is still running', async () => {
    const journal = await makeJournal();
    const test = harness({
      current: managedCurrent(),
      inspection: [
        { kind: 'not-admitted' },
        { kind: 'running', supervisorIdentityHash: digest('supervisor') },
        { kind: 'running', supervisorIdentityHash: digest('supervisor') },
        { kind: 'running', supervisorIdentityHash: digest('supervisor') },
      ],
      journal,
    });
    const { request } = reservationRequest();
    await test.workflow.reserveForTaskCommit(request);
    await test.workflow.admitAfterTaskCommit({
      committedWorkspaceRevision: 1,
      creationOperationId: request.creationOperationId,
      operationId: request.operationId,
      taskId: request.taskId,
    });
    await test.workflow.start(request);
    const [candidate] = await test.workflow.beginCleanRestartDrain();
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error('Expected a clean-restart candidate');
    await expect(test.workflow.persistCleanRestartPermit(candidate)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'session-still-running',
    });
    expect(journal.get(request.operationId)).toMatchObject({ kind: 'full', phase: 'running' });
    expect(test.workflow.abortCleanRestartDrain()).toBe(true);
  });

  it('quarantines an ambiguous clean-restart spawn and never retries it', async () => {
    const journal = await makeJournal();
    const first = harness({
      current: managedCurrent(),
      inspection: [
        { kind: 'not-admitted' },
        { kind: 'running', supervisorIdentityHash: digest('supervisor') },
        { kind: 'running', supervisorIdentityHash: digest('supervisor') },
        { kind: 'failed' },
      ],
      journal,
    });
    const { request } = reservationRequest();
    await first.workflow.reserveForTaskCommit(request);
    await first.workflow.admitAfterTaskCommit({
      committedWorkspaceRevision: 1,
      creationOperationId: request.creationOperationId,
      operationId: request.operationId,
      taskId: request.taskId,
    });
    await first.workflow.start(request);
    const [candidate] = await first.workflow.beginCleanRestartDrain();
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error('Expected a clean-restart candidate');
    await first.workflow.persistCleanRestartPermit(candidate);

    const restarted = harness({
      current: managedCurrent(),
      inspection: [{ kind: 'not-admitted' }],
      journal,
      spawn: { kind: 'ambiguous', supervisorIdentityHash: digest('ambiguous') },
    });
    await expect(
      restarted.workflow.restoreManagedSession({
        launchOperationId: request.operationId,
        sessionId: request.sessionId,
        taskId: request.taskId,
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'initial-shell-reconciliation-required',
    });
    expect(restarted.workflow.isTaskSpawnQuarantined(request.taskId)).toBe(true);
    await expect(
      restarted.workflow.restoreManagedSession({
        launchOperationId: request.operationId,
        sessionId: request.sessionId,
        taskId: request.taskId,
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'initial-shell-reconciliation-required',
    });
    expect(restarted.authority.spawnExactTuple).toHaveBeenCalledOnce();
  });

  it('coordinates shell deletion through a prior-record witness and final tombstone', async () => {
    const journal = await makeJournal();
    const { workflow, authority, request } = await reserveAndAdmit(journal);
    vi.mocked(authority.inspectExactTuple)
      .mockResolvedValueOnce({ kind: 'not-admitted' })
      .mockResolvedValueOnce({ kind: 'running', supervisorIdentityHash: digest('supervisor') });
    await workflow.start(request);
    const prepared = await workflow.prepareTaskRemoval({
      deletionOperationId: 'delete-1',
      launchOperationId: request.operationId,
      preparedWorkspaceRevision: 2,
      taskId: request.taskId,
      taskIdentityWitness: digest('task-identity'),
    });
    expect(prepared).toMatchObject({
      outcome: 'task-removal-not-committed',
      replayKind: 'deletion-pending',
    });
    await workflow.markTaskRemovalCommitted({
      deletionOperationId: 'delete-1',
      launchOperationId: request.operationId,
      removedWorkspaceRevision: 3,
      taskId: request.taskId,
    });
    const finalized = await workflow.finalizeTaskRemoval({
      deletionOperationId: 'delete-1',
      launchOperationId: request.operationId,
      removedWorkspaceRevision: 3,
      taskId: request.taskId,
    });
    expect(finalized).toMatchObject({
      outcome: 'task-removed-no-replay',
      replayKind: 'deletion-tombstone',
    });
  });

  it('maps journal capacity to the typed terminal-launch error', async () => {
    const journal = await makeJournal();
    for (let index = 0; index < TASK_SHELL_SESSION_JOURNAL_ACTIVE_PER_PRINCIPAL_LIMIT; index += 1) {
      await journal.save(record(index), null);
    }
    const test = harness({ journal });
    const { request } = reservationRequest(TASK_SHELL_SESSION_JOURNAL_ACTIVE_PER_PRINCIPAL_LIMIT);
    await expect(test.workflow.reserveForTaskCommit(request)).rejects.toBeInstanceOf(
      TaskShellSessionCapacityError,
    );
    expect(test.authority.spawnExactTuple).not.toHaveBeenCalled();
  });
});
