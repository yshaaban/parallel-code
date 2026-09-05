import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { TaskCreationOperationSnapshot } from '../../src/domain/task-creation.js';
import type { TaskCreationOperationId } from '../../src/domain/task-creation-ticket.js';
import {
  deriveTaskCreationConflictKey,
  createTaskCreationJournal,
  type TaskCreationConflictKey,
  type TaskCreationJournalRecord,
  type TaskCreationReconciliationResource,
} from './task-creation-journal.js';
import {
  TaskCreationLocalAdminRequiredError,
  createTaskCreationReconciliationService,
  isTaskCreationReconciliationAction,
  type TaskCreationReconciliationAuditEvent,
  type TaskCreationReconciliationDependencies,
} from './task-creation-reconciliation.js';

const PRINCIPAL = 'a'.repeat(64);

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function witness(value: number): string {
  return Buffer.alloc(32, value).toString('base64url');
}

function operationId(value = 1): TaskCreationOperationId {
  return Buffer.alloc(16, value).toString('base64url') as TaskCreationOperationId;
}

function sortKeys(keys: readonly TaskCreationConflictKey[]): TaskCreationConflictKey[] {
  return [...keys].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.digest.localeCompare(right.digest),
  );
}

function resource(value: string, kind: 'managed-worktree' | 'branch' = 'managed-worktree') {
  const conflictKey = deriveTaskCreationConflictKey(kind, value);
  return { conflictKey, resourceId: value } satisfies TaskCreationReconciliationResource;
}

function baseRecord(
  reconciliation: TaskCreationJournalRecord['reconciliation'],
  resources: readonly TaskCreationReconciliationResource[],
  args: {
    operation?: TaskCreationOperationId;
    phase?: TaskCreationJournalRecord['phase'];
    recordVersion?: number;
    retention?: TaskCreationJournalRecord['retention'];
    taskMode?: TaskCreationJournalRecord['taskMode'];
  } = {},
): TaskCreationJournalRecord {
  const conflictKeys = sortKeys(resources.map((entry) => entry.conflictKey));
  return {
    activeConflictKeys: conflictKeys,
    capabilityHash: digest('capability'),
    commit: { kind: 'not-committed' },
    conflictKeys,
    createdAtMs: 100,
    formatVersion: 1,
    identities: {
      deliveryId: null,
      launchOperationId: 'launch-1',
      sessionId: 'session-1',
      taskId: 'task-1',
    },
    issueCode:
      args.phase === 'failed-before-commit'
        ? 'preparation-failed'
        : 'manual-reconciliation-required',
    operationId: args.operation ?? operationId(),
    phase: args.phase ?? 'manual-reconciliation-required',
    reconciliation,
    recordVersion: args.recordVersion ?? 4,
    retention: args.retention ?? { kind: 'nonterminal' },
    semanticFingerprint: digest('semantic'),
    taskMode: args.taskMode ?? 'terminal',
    updatedAtMs: 200,
    warning: { warningReservationBytes: 0 },
    workspacePrincipalHash: PRINCIPAL,
  };
}

function mappingRecord(
  taskMode: TaskCreationJournalRecord['taskMode'] = 'terminal',
): TaskCreationJournalRecord {
  const mapping = resource('task-1', 'managed-worktree');
  return baseRecord(
    { expectedTaskId: 'task-1', kind: 'mapping-ambiguous', resource: mapping },
    [mapping],
    { taskMode },
  );
}

function artifactRecord(values = ['artifact-1']): TaskCreationJournalRecord {
  const resources = values
    .map((value) => resource(value))
    .sort(
      (left, right) =>
        left.conflictKey.kind.localeCompare(right.conflictKey.kind) ||
        left.conflictKey.digest.localeCompare(right.conflictKey.digest),
    );
  return baseRecord({ kind: 'artifact-ambiguous', resources }, resources);
}

function recoveryRecord(
  args: {
    phase?: 'failed-before-commit' | 'manual-reconciliation-required';
    restore?:
      | { kind: 'released' | 'retained' }
      | {
          destinationFilesystemWitness: string;
          destinationLocator: string;
          destinationParentWitness: string;
          kind: 'restore-pending';
        }
      | {
          destinationFilesystemWitness: string;
          destinationLocator: string;
          destinationParentWitness: string;
          kind: 'unlock-pending';
          restoredResourceWitness: string;
        };
  } = {},
): TaskCreationJournalRecord {
  const item = resource('quarantine-1');
  return baseRecord(
    {
      branchDelete: {
        challengeId: 'challenge-1',
        confirmationVersion: 2,
        observedRefFrontierWitness: witness(2),
        state: 'confirmation-required',
      },
      conflictKey: item.conflictKey,
      kind: 'retained-quarantine',
      operationLockOwnershipWitness: witness(3),
      operationLockResourceId: 'operation-lock-1',
      quarantineLocator: '/private/quarantine/opaque-1',
      recoveryId: 'recovery-1',
      resourceId: item.resourceId,
      restore: args.restore ?? { kind: 'retained' },
    },
    [item],
    {
      phase: args.phase ?? 'manual-reconciliation-required',
      retention: { kind: 'retained-artifact' },
    },
  );
}

interface MemoryJournal {
  current: TaskCreationJournalRecord | null;
  getByOperationId: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
}

function memoryJournal(initial: TaskCreationJournalRecord | null): MemoryJournal {
  const journal: MemoryJournal = {
    current: initial ? structuredClone(initial) : null,
    getByOperationId: vi.fn((id: TaskCreationOperationId) =>
      journal.current?.operationId === id ? structuredClone(journal.current) : null,
    ),
    save: vi.fn(async (proposed: TaskCreationJournalRecord, expectedVersion: number | null) => {
      if (!journal.current || journal.current.recordVersion !== expectedVersion) {
        return { cause: new Error('version conflict'), kind: 'not-committed' as const };
      }
      journal.current = structuredClone(proposed);
      return { kind: 'committed' as const };
    }),
  };
  return journal;
}

function snapshot(record: Readonly<TaskCreationJournalRecord>): TaskCreationOperationSnapshot {
  return {
    operationId: record.operationId,
    version: record.recordVersion,
  } as unknown as TaskCreationOperationSnapshot;
}

function dependencies(
  journal: MemoryJournal | TaskCreationReconciliationDependencies['journal'],
  overrides: Partial<TaskCreationReconciliationDependencies> = {},
): TaskCreationReconciliationDependencies {
  return {
    audit: vi.fn(),
    authorizeLocalAdmin: vi.fn(() => 'electron-main' as const),
    buildSnapshot: vi.fn(snapshot),
    finalizeRestoredWorktreeUnlock: vi.fn(() => ({ kind: 'exact-absent' as const })),
    inspect: vi.fn(),
    journal: journal as unknown as TaskCreationReconciliationDependencies['journal'],
    keepCurrentBranch: vi.fn(() => ({ kind: 'unchanged-present' as const })),
    moveRecoveryQuarantine: vi.fn(() => ({
      kind: 'moved-or-already-moved' as const,
      restoredResourceWitness: witness(8),
    })),
    now: () => 1_000,
    planRecoveryRestore: vi.fn(() => ({
      destinationFilesystemWitness: witness(5),
      destinationLocator: '/private/destination/opaque-1',
      destinationParentWitness: witness(6),
    })),
    probeCommittedMapping: vi.fn(() => ({
      kind: 'exact' as const,
      taskId: 'task-1',
      workspaceRevision: 9,
    })),
    probeOwnedArtifactAbsence: vi.fn(() => ({ kind: 'exact-absent' as const })),
    probeRecoveryQuarantineAbsence: vi.fn(() => ({ kind: 'exact-absent' as const })),
    retryOwnedBranchDelete: vi.fn(() => ({ kind: 'complete' as const })),
    revealRecoveryQuarantine: vi.fn(() => 'revealed' as const),
    ...overrides,
  };
}

const admin = Object.freeze({ source: 'trusted-test' });

describe('task-creation reconciliation action boundary', () => {
  it('requires exact action shapes and record versions for every non-inspect action', () => {
    expect(
      isTaskCreationReconciliationAction({ kind: 'inspect', operationId: operationId() }),
    ).toBe(true);
    expect(
      isTaskCreationReconciliationAction({
        kind: 'abandon-without-delete',
        operationId: operationId(),
      }),
    ).toBe(false);
    expect(
      isTaskCreationReconciliationAction({
        expectedRecordVersion: 4,
        kind: 'reveal-recovery-quarantine',
        operationId: operationId(),
        path: '/forged',
        recoveryId: 'recovery-1',
      }),
    ).toBe(false);
    expect(
      isTaskCreationReconciliationAction({
        destinationRef: '/caller/path',
        expectedRecordVersion: 4,
        kind: 'restore-recovery-quarantine',
        operationId: operationId(),
        recoveryId: 'recovery-1',
      }),
    ).toBe(false);
  });

  it('rejects untrusted authority before journal lookup and audits no resource identity', async () => {
    const journal = memoryJournal(mappingRecord());
    const audit = vi.fn<(event: TaskCreationReconciliationAuditEvent) => void>();
    const service = createTaskCreationReconciliationService(
      dependencies(journal, { audit, authorizeLocalAdmin: () => null }),
    );

    await expect(
      service.execute({}, { kind: 'inspect', operationId: operationId() }),
    ).rejects.toBeInstanceOf(TaskCreationLocalAdminRequiredError);
    expect(journal.getByOperationId).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({
      action: 'inspect',
      actor: 'untrusted',
      occurredAtMs: 1_000,
      outcome: 'authorization-denied',
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('task-1');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('/private');
  });

  it('keeps inspect read-only and missing/superseded lookup noncommittal', async () => {
    const current = mappingRecord();
    const journal = memoryJournal(current);
    const deps = dependencies(journal);
    const service = createTaskCreationReconciliationService(deps);

    await expect(
      service.execute(admin, { kind: 'inspect', operationId: current.operationId }),
    ).resolves.toMatchObject({ kind: 'inspected', snapshot: { version: 4 } });
    expect(deps.inspect).toHaveBeenCalledOnce();
    expect(journal.save).not.toHaveBeenCalled();

    journal.current = null;
    await expect(
      service.execute(admin, { kind: 'inspect', operationId: current.operationId }),
    ).resolves.toEqual({ kind: 'absent-or-superseded' });
  });

  it.each([
    { kind: 'adopt-committed-mapping', expectedTaskId: 'task-1' },
    { kind: 'confirm-owned-artifact-absent', resourceId: 'artifact-1' },
    { kind: 'abandon-without-delete' },
    { kind: 'reveal-recovery-quarantine', recoveryId: 'recovery-1' },
    {
      destinationRef: 'destination-1',
      kind: 'restore-recovery-quarantine',
      recoveryId: 'recovery-1',
    },
    {
      destinationRef: 'destination-1',
      kind: 'retarget-recovery-quarantine-restore',
      recoveryId: 'recovery-1',
    },
    { kind: 'finalize-restored-worktree-unlock', recoveryId: 'recovery-1' },
    { kind: 'confirm-recovery-quarantine-absent', recoveryId: 'recovery-1' },
    {
      challengeId: 'challenge-1',
      confirmationVersion: 2,
      kind: 'confirm-retry-owned-branch-delete',
      recoveryId: 'recovery-1',
    },
    {
      challengeId: 'challenge-1',
      confirmationVersion: 2,
      kind: 'keep-current-branch-and-abandon-owned-delete',
      recoveryId: 'recovery-1',
    },
  ] as const)('rejects stale record version for $kind before owner effects', async (action) => {
    const current = recoveryRecord({ phase: 'failed-before-commit' });
    const journal = memoryJournal(current);
    const deps = dependencies(journal);
    const service = createTaskCreationReconciliationService(deps);

    await expect(
      service.execute(admin, {
        ...action,
        expectedRecordVersion: 3,
        operationId: current.operationId,
      }),
    ).resolves.toMatchObject({ kind: 'stale-version-or-issue', snapshot: { version: 4 } });
    expect(journal.save).not.toHaveBeenCalled();
    expect(deps.probeCommittedMapping).not.toHaveBeenCalled();
    expect(deps.moveRecoveryQuarantine).not.toHaveBeenCalled();
    expect(deps.retryOwnedBranchDelete).not.toHaveBeenCalled();
  });
});

describe('task-creation reconciliation state machine', () => {
  it('persists multi-write recovery ordering through the real sharded journal codec', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-reconciliation-journal-'));
    const journal = createTaskCreationJournal({ isPackaged: true, userDataPath });
    try {
      await journal.activateFresh();
      const current = { ...recoveryRecord(), recordVersion: 1 };
      await expect(journal.save(current, null)).resolves.toEqual({ kind: 'committed' });
      const service = createTaskCreationReconciliationService(dependencies(journal));

      await expect(
        service.execute(admin, {
          destinationRef: 'destination-1',
          expectedRecordVersion: 1,
          kind: 'restore-recovery-quarantine',
          operationId: current.operationId,
          recoveryId: 'recovery-1',
        }),
      ).resolves.toMatchObject({ kind: 'restore-started', snapshot: { version: 3 } });
      expect(journal.getByOperationId(current.operationId)?.reconciliation).toMatchObject({
        kind: 'retained-quarantine',
        restore: { kind: 'unlock-pending' },
      });
    } finally {
      await journal.close().catch(() => {});
      fs.rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it.each([
    { issueCode: 'launch-failed', taskMode: 'agent' },
    { issueCode: 'projection-repair-required', taskMode: 'terminal' },
  ] as const)(
    'adopts an exact $taskMode mapping into actionable launch recovery and clears every scoped barrier',
    async ({ issueCode, taskMode }) => {
      const current = mappingRecord(taskMode);
      const journal = memoryJournal(current);
      const service = createTaskCreationReconciliationService(dependencies(journal));

      await expect(
        service.execute(admin, {
          expectedRecordVersion: 4,
          expectedTaskId: 'task-1',
          kind: 'adopt-committed-mapping',
          operationId: current.operationId,
        }),
      ).resolves.toMatchObject({ kind: 'resolved', snapshot: { version: 5 } });
      expect(journal.current).toMatchObject({
        activeConflictKeys: [],
        commit: { kind: 'committed', taskId: 'task-1', workspaceRevision: 9 },
        issueCode,
        phase: 'created-needs-attention',
        reconciliation: { kind: 'none' },
        retention: { kind: 'live-task' },
      });
    },
  );

  it('releases only the independently proven absent resource and terminalizes after the last', async () => {
    const current = artifactRecord(['artifact-1', 'artifact-2']);
    const journal = memoryJournal(current);
    const probe = vi.fn(() => ({ kind: 'exact-absent' as const }));
    const service = createTaskCreationReconciliationService(
      dependencies(journal, { probeOwnedArtifactAbsence: probe }),
    );

    await expect(
      service.execute(admin, {
        expectedRecordVersion: 4,
        kind: 'confirm-owned-artifact-absent',
        operationId: current.operationId,
        resourceId: 'artifact-1',
      }),
    ).resolves.toMatchObject({ kind: 'resolved', snapshot: { version: 5 } });
    expect(journal.current?.activeConflictKeys).toHaveLength(1);
    expect(journal.current?.reconciliation).toMatchObject({
      kind: 'artifact-ambiguous',
      resources: [{ resourceId: 'artifact-2' }],
    });

    await expect(
      service.execute(admin, {
        expectedRecordVersion: 5,
        kind: 'confirm-owned-artifact-absent',
        operationId: current.operationId,
        resourceId: 'artifact-2',
      }),
    ).resolves.toMatchObject({ kind: 'resolved', snapshot: { version: 6 } });
    expect(journal.current).toMatchObject({
      activeConflictKeys: [],
      phase: 'failed-before-commit',
      reconciliation: { kind: 'none' },
      retention: { expiresAtMs: 1_000 + 30 * 24 * 60 * 60 * 1_000, kind: 'tombstone' },
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('abandons without any external delete and retains unresolved collision quarantine', async () => {
    const current = artifactRecord();
    const journal = memoryJournal(current);
    const deps = dependencies(journal);
    const service = createTaskCreationReconciliationService(deps);

    await expect(
      service.execute(admin, {
        expectedRecordVersion: 4,
        kind: 'abandon-without-delete',
        operationId: current.operationId,
      }),
    ).resolves.toMatchObject({ kind: 'resolved', snapshot: { version: 5 } });
    expect(journal.current).toMatchObject({
      phase: 'failed-before-commit',
      reconciliation: { kind: 'abandoned-conflicts' },
      retention: { kind: 'retained-artifact' },
    });
    expect(deps.probeOwnedArtifactAbsence).not.toHaveBeenCalled();
    expect(deps.moveRecoveryQuarantine).not.toHaveBeenCalled();
    expect(deps.retryOwnedBranchDelete).not.toHaveBeenCalled();
  });

  it('persists restore intent before move and unlock intent after exact move classification', async () => {
    const current = recoveryRecord();
    const journal = memoryJournal(current);
    const order: string[] = [];
    journal.save.mockImplementation(
      async (proposed: TaskCreationJournalRecord, expectedVersion: number | null) => {
        order.push(
          `save:${proposed.reconciliation.kind === 'retained-quarantine' ? proposed.reconciliation.restore.kind : 'none'}`,
        );
        if (!journal.current || journal.current.recordVersion !== expectedVersion) {
          return { cause: new Error('conflict'), kind: 'not-committed' as const };
        }
        journal.current = structuredClone(proposed);
        return { kind: 'committed' as const };
      },
    );
    const move = vi.fn(() => {
      order.push('move');
      return { kind: 'moved-or-already-moved' as const, restoredResourceWitness: witness(8) };
    });
    const service = createTaskCreationReconciliationService(
      dependencies(journal, { moveRecoveryQuarantine: move }),
    );

    await expect(
      service.execute(admin, {
        destinationRef: 'destination-1',
        expectedRecordVersion: 4,
        kind: 'restore-recovery-quarantine',
        operationId: current.operationId,
        recoveryId: 'recovery-1',
      }),
    ).resolves.toMatchObject({ kind: 'restore-started', snapshot: { version: 6 } });
    expect(order).toEqual(['save:restore-pending', 'move', 'save:unlock-pending']);
    expect(journal.current?.reconciliation).toMatchObject({
      kind: 'retained-quarantine',
      restore: { kind: 'unlock-pending', restoredResourceWitness: witness(8) },
    });
  });

  it('never moves quarantine when the durable restore intent is not acknowledged', async () => {
    const current = recoveryRecord();
    const journal = memoryJournal(current);
    journal.save.mockResolvedValue({
      cause: new Error('fsync pending'),
      kind: 'durability-repair-required',
    });
    const move = vi.fn();
    const service = createTaskCreationReconciliationService(
      dependencies(journal, { moveRecoveryQuarantine: move }),
    );

    await expect(
      service.execute(admin, {
        destinationRef: 'destination-1',
        expectedRecordVersion: 4,
        kind: 'restore-recovery-quarantine',
        operationId: current.operationId,
        recoveryId: 'recovery-1',
      }),
    ).resolves.toMatchObject({ kind: 'proof-insufficient', snapshot: { version: 4 } });
    expect(move).not.toHaveBeenCalled();
  });

  it('finalizes unlock only after exact owner proof and retains a pending branch barrier', async () => {
    const current = recoveryRecord({
      restore: {
        destinationFilesystemWitness: witness(5),
        destinationLocator: '/private/destination/opaque-1',
        destinationParentWitness: witness(6),
        kind: 'unlock-pending',
        restoredResourceWitness: witness(8),
      },
    });
    const journal = memoryJournal(current);
    const service = createTaskCreationReconciliationService(dependencies(journal));

    await expect(
      service.execute(admin, {
        expectedRecordVersion: 4,
        kind: 'finalize-restored-worktree-unlock',
        operationId: current.operationId,
        recoveryId: 'recovery-1',
      }),
    ).resolves.toMatchObject({ kind: 'unlock-finalized', snapshot: { version: 5 } });
    expect(journal.current).toMatchObject({
      activeConflictKeys: current.activeConflictKeys,
      reconciliation: {
        branchDelete: { state: 'confirmation-required' },
        restore: { kind: 'released' },
      },
      retention: { kind: 'retained-artifact' },
    });
  });

  it('terminalizes failed-creation quarantine after exact absence when branch cleanup is not applicable', async () => {
    const initial = recoveryRecord({ phase: 'failed-before-commit' });
    if (initial.reconciliation.kind !== 'retained-quarantine') {
      throw new Error('Expected retained recovery fixture');
    }
    const recoveryId = initial.reconciliation.recoveryId;
    const current: TaskCreationJournalRecord = {
      ...initial,
      reconciliation: {
        ...initial.reconciliation,
        branchDelete: { state: 'not-applicable' },
      },
    };
    const journal = memoryJournal(current);
    const service = createTaskCreationReconciliationService(dependencies(journal));

    await expect(
      service.execute(admin, {
        expectedRecordVersion: current.recordVersion,
        kind: 'confirm-recovery-quarantine-absent',
        operationId: current.operationId,
        recoveryId,
      }),
    ).resolves.toMatchObject({ kind: 'resolved', snapshot: { version: 5 } });
    expect(journal.current).toMatchObject({
      activeConflictKeys: [],
      phase: 'failed-before-commit',
      reconciliation: { kind: 'none' },
      retention: { kind: 'tombstone' },
    });
  });

  it('persists branch-only intent before retry and rotates an ambiguous challenge', async () => {
    const current = recoveryRecord({ restore: { kind: 'released' } });
    const journal = memoryJournal(current);
    const order: string[] = [];
    journal.save.mockImplementation(
      async (proposed: TaskCreationJournalRecord, expectedVersion: number | null) => {
        const branch =
          proposed.reconciliation.kind === 'retained-quarantine'
            ? proposed.reconciliation.branchDelete.state
            : 'terminal';
        order.push(`save:${branch}`);
        if (!journal.current || journal.current.recordVersion !== expectedVersion) {
          return { cause: new Error('conflict'), kind: 'not-committed' as const };
        }
        journal.current = structuredClone(proposed);
        return { kind: 'committed' as const };
      },
    );
    const retry = vi.fn(() => {
      order.push('branch-owner');
      return {
        challengeId: 'challenge-2',
        confirmationVersion: 3,
        kind: 'outcome-ambiguous' as const,
        observedRefFrontierWitness: witness(9),
      };
    });
    const service = createTaskCreationReconciliationService(
      dependencies(journal, { retryOwnedBranchDelete: retry }),
    );

    await expect(
      service.execute(admin, {
        challengeId: 'challenge-1',
        confirmationVersion: 2,
        expectedRecordVersion: 4,
        kind: 'confirm-retry-owned-branch-delete',
        operationId: current.operationId,
        recoveryId: 'recovery-1',
      }),
    ).resolves.toMatchObject({ kind: 'branch-delete-retry-started', snapshot: { version: 6 } });
    expect(order).toEqual(['save:in-progress', 'branch-owner', 'save:confirmation-required']);
    expect(journal.current?.reconciliation).toMatchObject({
      branchDelete: { challengeId: 'challenge-2', confirmationVersion: 3 },
    });
  });

  it('keeps a current branch without ref mutation only for a failed-creation recovery', async () => {
    const current = recoveryRecord({
      phase: 'failed-before-commit',
      restore: { kind: 'released' },
    });
    const journal = memoryJournal(current);
    const keep = vi.fn(() => ({ kind: 'unchanged-present' as const }));
    const service = createTaskCreationReconciliationService(
      dependencies(journal, { keepCurrentBranch: keep }),
    );

    await expect(
      service.execute(admin, {
        challengeId: 'challenge-1',
        confirmationVersion: 2,
        expectedRecordVersion: 4,
        kind: 'keep-current-branch-and-abandon-owned-delete',
        operationId: current.operationId,
        recoveryId: 'recovery-1',
      }),
    ).resolves.toMatchObject({
      kind: 'branch-delete-abandoned-preserved',
      snapshot: { version: 5 },
    });
    expect(keep).toHaveBeenCalledOnce();
    expect(journal.current).toMatchObject({
      activeConflictKeys: [],
      reconciliation: { kind: 'none' },
      retention: { kind: 'tombstone' },
    });
  });

  it('serializes concurrent repairs so one exact record version wins', async () => {
    const current = artifactRecord();
    const journal = memoryJournal(current);
    let releaseProbe!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const probe = vi.fn(async () => {
      await gate;
      return { kind: 'exact-absent' as const };
    });
    const service = createTaskCreationReconciliationService(
      dependencies(journal, { probeOwnedArtifactAbsence: probe }),
    );
    const action = {
      expectedRecordVersion: 4,
      kind: 'confirm-owned-artifact-absent' as const,
      operationId: current.operationId,
      resourceId: 'artifact-1',
    };

    const first = service.execute(admin, action);
    const second = service.execute(admin, action);
    releaseProbe();

    await expect(first).resolves.toMatchObject({ kind: 'resolved' });
    await expect(second).resolves.toMatchObject({ kind: 'stale-version-or-issue' });
    expect(probe).toHaveBeenCalledOnce();
    expect(journal.save).toHaveBeenCalledOnce();
  });
});
