import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { TaskCreationOperationSnapshot } from '../../src/domain/task-creation.js';
import type { TaskCreationOperationId } from '../../src/domain/task-creation-ticket.js';
import {
  createTaskCreationJournal,
  deriveTaskCreationConflictKey,
  type TaskCreationJournal,
  type TaskCreationJournalRecord,
} from './task-creation-journal.js';
import {
  createTaskCreationLocalReconciliationCommands,
  type CreateTaskCreationLocalReconciliationCommandsDependencies,
} from './task-creation-local-reconciliation.js';
import type { TaskCreationReconciliationAuditEvent } from './task-creation-reconciliation.js';

const PRINCIPAL = 'a'.repeat(64);

function operationId(value: number): TaskCreationOperationId {
  return Buffer.alloc(16, value).toString('base64url') as TaskCreationOperationId;
}

function record(value: number, updatedAtMs = 200): TaskCreationJournalRecord {
  const resourceId = `artifact-${value}`;
  const conflictKey = deriveTaskCreationConflictKey('managed-worktree', resourceId);
  return {
    activeConflictKeys: [conflictKey],
    capabilityHash: createHash('sha256').update(`capability-${value}`).digest('hex'),
    commit: { kind: 'not-committed' },
    conflictKeys: [conflictKey],
    createdAtMs: 100,
    formatVersion: 1,
    identities: {
      deliveryId: null,
      launchOperationId: `launch-${value}`,
      sessionId: `session-${value}`,
      taskId: `task-${value}`,
    },
    issueCode: 'manual-reconciliation-required',
    operationId: operationId(value),
    phase: 'manual-reconciliation-required',
    reconciliation: {
      kind: 'artifact-ambiguous',
      resources: [{ conflictKey, resourceId }],
    },
    recordVersion: 1,
    retention: { kind: 'nonterminal' },
    semanticFingerprint: createHash('sha256').update(`semantic-${value}`).digest('hex'),
    taskMode: 'terminal',
    updatedAtMs,
    warning: { warningReservationBytes: 0 },
    workspacePrincipalHash: PRINCIPAL,
  };
}

function snapshot(value: Readonly<TaskCreationJournalRecord>): TaskCreationOperationSnapshot {
  return {
    operationId: value.operationId,
    version: value.recordVersion,
  } as unknown as TaskCreationOperationSnapshot;
}

function dependencies(
  journal: TaskCreationJournal,
  audit = vi.fn<(event: Readonly<TaskCreationReconciliationAuditEvent>) => void>(),
): CreateTaskCreationLocalReconciliationCommandsDependencies {
  return {
    audit,
    buildSnapshot: vi.fn(snapshot),
    finalizeRestoredWorktreeUnlock: vi.fn(() => ({ kind: 'proof-insufficient' as const })),
    inspect: vi.fn(),
    journal,
    keepCurrentBranch: vi.fn(() => ({ kind: 'proof-insufficient' as const })),
    moveRecoveryQuarantine: vi.fn(() => ({ kind: 'proof-insufficient' as const })),
    now: () => 1_000,
    planRecoveryRestore: vi.fn(() => null),
    probeCommittedMapping: vi.fn(() => ({ kind: 'proof-insufficient' as const })),
    probeOwnedArtifactAbsence: vi.fn(() => ({ kind: 'proof-insufficient' as const })),
    probeRecoveryQuarantineAbsence: vi.fn(() => ({ kind: 'proof-insufficient' as const })),
    retryOwnedBranchDelete: vi.fn(() => ({ kind: 'proof-insufficient' as const })),
    revealRecoveryQuarantine: vi.fn(() => 'proof-insufficient' as const),
  };
}

function temporaryJournal(): { journal: TaskCreationJournal; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-creation-local-reconciliation-'));
  return { journal: createTaskCreationJournal({ isPackaged: true, userDataPath: root }), root };
}

describe('task-creation local reconciliation commands', () => {
  it('captures unforgeable actor authority and preserves record-version CAS', async () => {
    const { journal, root } = temporaryJournal();
    const audit = vi.fn<(event: Readonly<TaskCreationReconciliationAuditEvent>) => void>();
    try {
      await journal.activateFresh();
      const initial = record(1);
      await journal.save(initial, null);
      const commands = createTaskCreationLocalReconciliationCommands(dependencies(journal, audit));

      await expect(commands.electronMain.inspect(initial.operationId)).resolves.toMatchObject({
        kind: 'inspected',
        snapshot: { version: 1 },
      });
      await expect(
        commands.owningUserCli.execute({
          expectedRecordVersion: 1,
          kind: 'abandon-without-delete',
          operationId: initial.operationId,
        }),
      ).resolves.toMatchObject({ kind: 'resolved', snapshot: { version: 2 } });
      await expect(
        commands.electronMain.execute({
          expectedRecordVersion: 1,
          kind: 'abandon-without-delete',
          operationId: initial.operationId,
        }),
      ).resolves.toMatchObject({ kind: 'stale-version-or-issue', snapshot: { version: 2 } });

      expect(audit.mock.calls.map(([event]) => event.actor)).toEqual([
        'electron-main',
        'owning-user-cli',
        'electron-main',
      ]);
      expect(JSON.stringify(audit.mock.calls)).not.toContain('artifact-1');
      expect(commands).not.toHaveProperty('service');
    } finally {
      await journal.close().catch(() => undefined);
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('discovers persisted manual work after restart through the same canonical projector', async () => {
    const { journal, root } = temporaryJournal();
    let restarted: TaskCreationJournal | null = null;
    try {
      await journal.activateFresh();
      const initial = record(2);
      await journal.save(initial, null);
      await journal.close();

      restarted = createTaskCreationJournal({ isPackaged: true, userDataPath: root });
      await expect(restarted.startup()).resolves.toMatchObject({ health: 'healthy' });
      const deps = dependencies(restarted);
      const commands = createTaskCreationLocalReconciliationCommands(deps);

      await expect(commands.electronMain.list()).resolves.toEqual({
        items: [snapshot(initial)],
        kind: 'page',
        nextCursor: null,
      });
      expect(deps.buildSnapshot).toHaveBeenCalledWith(initial);
    } finally {
      await restarted?.close().catch(() => undefined);
      await journal.close().catch(() => undefined);
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('pages a stable bounded local view and rejects oversized requests', async () => {
    const records = [record(1, 300), record(2, 200), record(3, 100)];
    const journal = {
      list: () => records.map((entry) => structuredClone(entry)),
    } as TaskCreationJournal;
    const commands = createTaskCreationLocalReconciliationCommands(dependencies(journal));

    const first = await commands.electronMain.list({ limit: 1 });
    if (first.kind !== 'page') throw new Error('Expected first reconciliation page');
    expect(first.items.map((item) => item.operationId)).toEqual([records[0]?.operationId]);
    expect(first.nextCursor).not.toBeNull();
    const second = await commands.electronMain.list({ cursor: first.nextCursor ?? '', limit: 1 });
    if (second.kind !== 'page') throw new Error('Expected second reconciliation page');
    expect(second.items.map((item) => item.operationId)).toEqual([records[1]?.operationId]);
    await expect(commands.electronMain.list({ limit: 51 })).rejects.toThrow(
      'Invalid task-creation reconciliation page limit',
    );
  });

  it('returns an explicit stale page instead of splicing a mutated candidate set', async () => {
    const records = [record(1, 300), record(2, 200)];
    const journal = {
      list: () => records.map((entry) => structuredClone(entry)),
    } as TaskCreationJournal;
    const commands = createTaskCreationLocalReconciliationCommands(dependencies(journal));

    const first = await commands.electronMain.list({ limit: 1 });
    if (first.kind !== 'page' || !first.nextCursor) {
      throw new Error('Expected a paged reconciliation result');
    }
    const changed = records[1];
    if (!changed) throw new Error('Expected the second reconciliation record');
    records[1] = { ...changed, recordVersion: changed.recordVersion + 1 };

    await expect(
      commands.electronMain.list({ cursor: first.nextCursor, limit: 1 }),
    ).resolves.toEqual({ kind: 'stale' });
  });
});
