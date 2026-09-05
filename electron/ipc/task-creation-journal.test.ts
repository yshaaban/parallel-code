import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  TaskCreationOperationCapability,
  TaskCreationOperationId,
} from '../../src/domain/task-creation-ticket.js';
import { canonicalJsonStringify, type JsonValue } from './workspace-state-storage.js';
import { encodeTaskWorktreeLinkRequestV1 } from './git-worktree-symlinks.js';
import {
  SHARDED_OPERATION_STORE_INDEX_FILE_NAME,
  SHARDED_OPERATION_STORE_LAYOUT_FILE_NAME,
  SHARDED_OPERATION_STORE_SHARD_NAMES,
  deriveShardedOperationKeyDigest,
} from './sharded-operation-store.js';
import type { StorageEnv } from './storage-environment.js';
import {
  TASK_CREATION_JOURNAL_COMPONENT_HARD_SUM_BYTES,
  TASK_CREATION_JOURNAL_CORE_MAX_BYTES,
  TASK_CREATION_JOURNAL_RECORD_TIER_BYTES,
  TASK_CREATION_JOURNAL_STRUCTURAL_RECORD_MAX_BYTES,
  TASK_CREATION_JOURNAL_TOMBSTONE_RETENTION_MS,
  TASK_CREATION_JOURNAL_WORKFLOW_RECORD_MAX_BYTES,
  TASK_CREATION_WARNING_STRUCTURAL_COMPONENT_MAX_BYTES,
  TASK_CREATION_WARNING_WORKFLOW_COMPONENT_MAX_BYTES,
  TaskCreationConflictAdmissionError,
  createNormalizedTaskCreationSemanticRequestV1,
  createTaskCreationJournal,
  createTaskCreationWarningReservation,
  decodeTaskCreationJournalWarnings,
  deriveTaskCreationConflictKey,
  deriveTaskCreationSemanticFingerprint,
  encodeTaskCreationJournalWarnings,
  encodeTaskCreationSemanticFingerprintInputV1,
  getTaskCreationJournalRecordCharge,
  installTaskCreationJournalWarnings,
  taskCreationJournalCanonicalKey,
  type TaskCreationConflictKey,
  type TaskCreationJournal,
  type TaskCreationJournalRecord,
} from './task-creation-journal.js';

const roots: string[] = [];
const journals: TaskCreationJournal[] = [];
const PRINCIPAL = 'a'.repeat(64);
const CAPABILITY = Buffer.alloc(32, 0x51).toString('base64url') as TaskCreationOperationCapability;

function operationId(value: number): TaskCreationOperationId {
  return Buffer.alloc(16, value).toString('base64url') as TaskCreationOperationId;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}

function createEnv(): StorageEnv {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-task-creation-journal-'));
  roots.push(userDataPath);
  return { isPackaged: true, userDataPath };
}

function trackedJournal(
  env: StorageEnv,
  options: Parameters<typeof createTaskCreationJournal>[1] = {},
): TaskCreationJournal {
  const journal = createTaskCreationJournal(env, options);
  journals.push(journal);
  return journal;
}

function conflict(value = 'project-1'): TaskCreationConflictKey {
  return deriveTaskCreationConflictKey('project', value);
}

function record(
  args: {
    activeConflictKeys?: TaskCreationConflictKey[];
    conflictKeys?: TaskCreationConflictKey[];
    createdAtMs?: number;
    operation?: TaskCreationOperationId;
    phase?: TaskCreationJournalRecord['phase'];
    principal?: string;
    recordVersion?: number;
    retention?: TaskCreationJournalRecord['retention'];
    updatedAtMs?: number;
    warning?: TaskCreationJournalRecord['warning'];
  } = {},
): TaskCreationJournalRecord {
  const key = conflict(`project-${args.operation ?? operationId(1)}`);
  const conflictKeys = args.conflictKeys ?? [key];
  return {
    activeConflictKeys: args.activeConflictKeys ?? conflictKeys,
    capabilityHash: digest('capability'),
    commit: { kind: 'not-committed' },
    conflictKeys,
    createdAtMs: args.createdAtMs ?? 100,
    formatVersion: 1,
    identities: {
      deliveryId: null,
      launchOperationId: `launch-${args.operation ?? operationId(1)}`,
      sessionId: `session-${args.operation ?? operationId(1)}`,
      taskId: `task-${args.operation ?? operationId(1)}`,
    },
    issueCode: null,
    operationId: args.operation ?? operationId(1),
    phase: args.phase ?? 'validating',
    reconciliation: { kind: 'none' },
    recordVersion: args.recordVersion ?? 1,
    retention: args.retention ?? { kind: 'nonterminal' },
    semanticFingerprint: digest('semantic'),
    taskMode: 'terminal',
    updatedAtMs: args.updatedAtMs ?? args.createdAtMs ?? 100,
    warning: args.warning ?? { warningReservationBytes: 0 },
    workspacePrincipalHash: args.principal ?? PRINCIPAL,
  };
}

function tombstone(
  operation: TaskCreationOperationId,
  expiresAtMs: number,
): TaskCreationJournalRecord {
  return {
    ...record({ activeConflictKeys: [], operation }),
    issueCode: 'preparation-failed',
    phase: 'failed-before-commit',
    retention: { expiresAtMs, kind: 'tombstone' },
  };
}

async function activate(journal: TaskCreationJournal): Promise<void> {
  await expect(journal.activateFresh()).resolves.toMatchObject({ health: 'healthy' });
}

afterEach(async () => {
  await Promise.allSettled(journals.splice(0).map((journal) => journal.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe('task-creation warning and semantic codecs', () => {
  it('encodes the strict compact warning format in exact UTF-8 byte order', () => {
    const encoded = encodeTaskCreationJournalWarnings([
      { name: 'z/name', reason: 'destination_exists' },
      { name: '\u0000control', reason: 'invalid_name' },
      { name: 'é', reason: 'source_missing' },
    ]);

    expect(encoded).toBeDefined();
    expect(decodeTaskCreationJournalWarnings(requireDefined(encoded, 'warning encoding'))).toEqual([
      { name: '\u0000control', reason: 'invalid_name' },
      { name: 'z/name', reason: 'destination_exists' },
      { name: 'é', reason: 'source_missing' },
    ]);
    expect(() =>
      encodeTaskCreationJournalWarnings([
        { name: 'same', reason: 'source_missing' },
        { name: 'same', reason: 'link_failed' },
      ]),
    ).toThrow(/unique names/u);
    expect(() =>
      encodeTaskCreationJournalWarnings([
        { name: 'entry', reason: 'toString' as 'source_missing' },
      ]),
    ).toThrow(/Invalid task-creation warning/u);
    expect(() =>
      encodeTaskCreationJournalWarnings([{ name: 'trailing\ud800', reason: 'invalid_name' }]),
    ).toThrow(/Invalid task-creation warning/u);
    expect(() =>
      encodeTaskCreationJournalWarnings([{ name: 'lone\udc00', reason: 'invalid_name' }]),
    ).toThrow(/Invalid task-creation warning/u);
    const astral = encodeTaskCreationJournalWarnings([
      { name: 'valid-\ud83d\ude80', reason: 'invalid_name' },
    ]);
    expect(
      decodeTaskCreationJournalWarnings(requireDefined(astral, 'astral warning encoding')),
    ).toEqual([{ name: 'valid-\ud83d\ude80', reason: 'invalid_name' }]);
  });

  it('rejects unpaired surrogates from every semantic scalar field', () => {
    const base = {
      launch: { kind: 'terminal' as const },
      location: { kind: 'project-root' as const },
      name: 'Task',
      projectId: 'project-1',
      stepsTracking: false,
    };
    expect(() =>
      createNormalizedTaskCreationSemanticRequestV1({ ...base, name: 'Task\ud800' }),
    ).toThrow(/Invalid normalized task-creation semantic request/u);
    expect(() =>
      createNormalizedTaskCreationSemanticRequestV1({
        ...base,
        launch: {
          agentDefId: 'agent-1',
          initialPrompt: 'Prompt\ud800',
          kind: 'agent',
          skipPermissions: false,
        },
      }),
    ).toThrow(/Invalid normalized task-creation agent launch/u);
    expect(
      createNormalizedTaskCreationSemanticRequestV1({ ...base, name: 'Task \ud83d\ude80' }).name,
    ).toBe('Task \ud83d\ude80');
  });

  it('charges owner-returned R+n once and installs only an exact requested-name subset', () => {
    const request = encodeTaskWorktreeLinkRequestV1(['b', 'a', 'a']);
    const reservation = createTaskCreationWarningReservation(request);
    const installed = installTaskCreationJournalWarnings(
      request,
      [{ name: 'b', reason: 'source_missing' }],
      reservation,
    );

    expect(request.encodedBytes).toEqual(Uint8Array.of(1, 2, 0, 1, 97, 0, 1, 98));
    expect(reservation.warningReservationBytes).toBe(23 + 14);
    expect(installed.warningReservationBytes).toBe(0);
    expect(
      decodeTaskCreationJournalWarnings(
        requireDefined(installed.symlinkWarningsV1, 'installed warning encoding'),
      ),
    ).toEqual([{ name: 'b', reason: 'source_missing' }]);
    expect(() =>
      installTaskCreationJournalWarnings(
        request,
        [{ name: 'c', reason: 'source_missing' }],
        reservation,
      ),
    ).toThrow(/exact requested-name subset/u);
  });

  it('copies design-03 bytes once and gives terminal launch exact absent/default slots', () => {
    const ownerRequest = encodeTaskWorktreeLinkRequestV1(['b', 'a', 'a']);
    const managed = createNormalizedTaskCreationSemanticRequestV1({
      launch: { agentDefId: 'agent-1', initialPrompt: '', kind: 'agent', skipPermissions: false },
      location: { kind: 'managed-worktree', worktreeLinkRequest: ownerRequest },
      name: 'Task',
      projectId: 'project-1',
      stepsTracking: true,
    });
    const encoded = Buffer.from(encodeTaskCreationSemanticFingerprintInputV1(managed));
    const location = Buffer.from([0, 0, 0, 0, 8, 1, 2, 0, 1, 97, 0, 1, 98]);

    expect(encoded.includes(location)).toBe(true);
    expect(
      managed.location.kind === 'managed-worktree' && managed.location.worktreeLinkRequest,
    ).toBe(ownerRequest);
    const terminal = createNormalizedTaskCreationSemanticRequestV1({
      launch: { kind: 'terminal' },
      location: { kind: 'project-root' },
      name: 'Task',
      projectId: 'project-1',
      stepsTracking: false,
    });
    const terminalBytes = Buffer.from(encodeTaskCreationSemanticFingerprintInputV1(terminal));
    expect(terminalBytes.subarray(terminalBytes.length - 8)).toEqual(
      Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]),
    );
    expect(deriveTaskCreationSemanticFingerprint(CAPABILITY, managed)).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      deriveTaskCreationSemanticFingerprint(
        CAPABILITY,
        createNormalizedTaskCreationSemanticRequestV1({
          ...managed,
          launch: {
            agentDefId: 'agent-1',
            initialPrompt: 'x',
            kind: 'agent',
            skipPermissions: false,
          },
        }),
      ),
    ).not.toBe(deriveTaskCreationSemanticFingerprint(CAPABILITY, managed));
  });

  it('rejects inactive, unknown, and explicit-undefined semantic fields', () => {
    expect(() =>
      createNormalizedTaskCreationSemanticRequestV1({
        launch: { kind: 'terminal', skipPermissions: false } as never,
        location: { kind: 'project-root' },
        name: 'Task',
        projectId: 'project-1',
        stepsTracking: false,
      }),
    ).toThrow(/inactive agent fields/u);
    expect(() =>
      createNormalizedTaskCreationSemanticRequestV1({
        baseBranchRef: undefined,
        launch: { kind: 'terminal' },
        location: { kind: 'project-root' },
        name: 'Task',
        projectId: 'project-1',
        stepsTracking: false,
      }),
    ).toThrow(/semantic request shape/u);
    expect(() =>
      createNormalizedTaskCreationSemanticRequestV1({
        launch: { kind: 'terminal' },
        location: { kind: 'project-root', worktreeRef: 'forged' } as never,
        name: 'Task',
        projectId: 'project-1',
        stepsTracking: false,
      }),
    ).toThrow(/inactive location fields/u);
  });

  it('keeps the structural and workflow byte equations exact', () => {
    expect(TASK_CREATION_JOURNAL_STRUCTURAL_RECORD_MAX_BYTES).toBe(
      TASK_CREATION_JOURNAL_CORE_MAX_BYTES + TASK_CREATION_WARNING_STRUCTURAL_COMPONENT_MAX_BYTES,
    );
    expect(TASK_CREATION_JOURNAL_COMPONENT_HARD_SUM_BYTES).toBe(48_192);
    expect(TASK_CREATION_JOURNAL_RECORD_TIER_BYTES).toBe(49_152);
    expect(TASK_CREATION_JOURNAL_WORKFLOW_RECORD_MAX_BYTES).toBe(
      TASK_CREATION_JOURNAL_CORE_MAX_BYTES + TASK_CREATION_WARNING_WORKFLOW_COMPONENT_MAX_BYTES,
    );
    expect(getTaskCreationJournalRecordCharge(record())).toBe(TASK_CREATION_JOURNAL_CORE_MAX_BYTES);
  });
});

describe('sharded task-creation journal', () => {
  it('activates and restarts only with the exact root-durable 00..ff topology', async () => {
    const env = createEnv();
    const rootPath = path.join(env.userDataPath, 'journal');
    const journal = trackedJournal(env, { rootPath });
    await activate(journal);

    const entries = fs.readdirSync(rootPath).sort();
    expect(entries.filter((entry) => /^[a-f0-9]{2}$/u.test(entry))).toEqual(
      SHARDED_OPERATION_STORE_SHARD_NAMES,
    );
    expect(entries).toContain(SHARDED_OPERATION_STORE_LAYOUT_FILE_NAME);
    const topologyEpoch = journal.getTopologyEpoch();
    expect(topologyEpoch).toBeTruthy();
    await journal.close();
    journals.splice(journals.indexOf(journal), 1);

    const restarted = trackedJournal(env, { rootPath });
    await expect(restarted.startup()).resolves.toMatchObject({ health: 'healthy' });
    expect(restarted.getTopologyEpoch()).not.toBe(topologyEpoch);
  });

  it('writes one layout-versioned canonical final and retains O(1) lookup indexes', async () => {
    const env = createEnv();
    const rootPath = path.join(env.userDataPath, 'journal');
    const journal = trackedJournal(env, { rootPath });
    await activate(journal);
    const initial = record();

    await expect(journal.save(initial, null)).resolves.toEqual({ kind: 'committed' });
    await expect(journal.save(initial, null)).resolves.toEqual({ kind: 'already-current' });
    expect(journal.getByOperationId(initial.operationId)).toEqual(initial);
    expect(
      journal.findConflict(requireDefined(initial.activeConflictKeys[0], 'active conflict key')),
    ).toEqual([initial]);
    expect(journal.getCounts()).toEqual({ chargedBytes: 4_096, nonterminal: 1, records: 1 });

    const canonicalKey = taskCreationJournalCanonicalKey(PRINCIPAL, initial.operationId);
    const keyDigest = deriveShardedOperationKeyDigest('task-creation', canonicalKey);
    const finalPath = path.join(rootPath, keyDigest.slice(0, 2), keyDigest.slice(2));
    const contents = fs.readFileSync(finalPath, 'utf8');
    const envelope = JSON.parse(contents) as Record<string, unknown>;
    expect(envelope.layoutVersion).toBe(1);
    expect(contents).toBe(canonicalJsonStringify(envelope as unknown as JsonValue));
    expect(fs.readdirSync(path.dirname(finalPath))).toEqual([keyDigest.slice(2)]);
  });

  it('atomically admits one conflict owner, rebuilds the barrier on restart, and releases it only after proof', async () => {
    const env = createEnv();
    const rootPath = path.join(env.userDataPath, 'journal');
    const journal = trackedJournal(env, { rootPath });
    await activate(journal);
    const sharedConflict = conflict('shared-project');
    const retained = record({
      activeConflictKeys: [sharedConflict],
      conflictKeys: [sharedConflict],
      operation: operationId(1),
      phase: 'manual-reconciliation-required',
      retention: { kind: 'retained-artifact' },
    });
    retained.issueCode = 'manual-reconciliation-required';
    retained.reconciliation = {
      kind: 'artifact-ambiguous',
      resources: [{ conflictKey: sharedConflict, resourceId: 'shared-project-artifact' }],
    };
    const contender = record({
      activeConflictKeys: [sharedConflict],
      conflictKeys: [sharedConflict],
      operation: operationId(2),
    });
    const unrelated = record({ operation: operationId(3) });

    const concurrent = await Promise.allSettled([
      journal.save(retained, null),
      journal.save(contender, null),
      journal.save(unrelated, null),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const rejected = concurrent.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: expect.any(TaskCreationConflictAdmissionError),
      status: 'rejected',
    });
    expect(journal.getByOperationId(contender.operationId)).toBeNull();
    expect(journal.getByOperationId(unrelated.operationId)).toEqual(unrelated);

    await journal.close();
    journals.splice(journals.indexOf(journal), 1);
    const restarted = trackedJournal(env, { rootPath });
    await expect(restarted.startup()).resolves.toMatchObject({ health: 'healthy' });
    await expect(restarted.save(contender, null)).rejects.toBeInstanceOf(
      TaskCreationConflictAdmissionError,
    );

    const released: TaskCreationJournalRecord = {
      ...retained,
      activeConflictKeys: [],
      issueCode: 'preparation-failed',
      phase: 'failed-before-commit',
      reconciliation: { kind: 'none' },
      recordVersion: 2,
      retention: { expiresAtMs: 2_000, kind: 'tombstone' },
      updatedAtMs: 101,
    };
    await expect(restarted.save(released, 1)).resolves.toEqual({ kind: 'committed' });
    await expect(restarted.save(contender, null)).resolves.toEqual({ kind: 'committed' });
  });

  it('advances phases exactly once, consumes warning reservation once, and shrinks barriers only', async () => {
    const env = createEnv();
    const journal = trackedJournal(env);
    await activate(journal);
    const request = encodeTaskWorktreeLinkRequestV1(['a']);
    const firstConflict = conflict('first');
    const dormantConflict = deriveTaskCreationConflictKey('branch', 'dormant');
    const declaredConflicts = [firstConflict, dormantConflict].sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) || left.digest.localeCompare(right.digest),
    );
    const initial = record({
      activeConflictKeys: [firstConflict],
      conflictKeys: declaredConflicts,
      warning: createTaskCreationWarningReservation(request),
    });
    await journal.save(initial, null);
    const installed = installTaskCreationJournalWarnings(
      request,
      [{ name: 'a', reason: 'source_missing' }],
      initial.warning,
    );
    const preparing = {
      ...initial,
      phase: 'preparing' as const,
      recordVersion: 2,
      updatedAtMs: 101,
      warning: installed,
    };
    await expect(journal.save(preparing, 1)).resolves.toEqual({ kind: 'committed' });
    await expect(journal.save(preparing, 1)).resolves.toEqual({ kind: 'already-current' });
    await expect(
      journal.save(
        {
          ...preparing,
          activeConflictKeys: declaredConflicts,
          recordVersion: 3,
        },
        2,
      ),
    ).rejects.toThrow(/active conflict scope may only shrink/u);
  });

  it.each([
    'after-record-pending-open',
    'after-record-pending-write',
    'after-record-pending-fsync',
  ] as const)(
    'classifies %s as exact prior and leaves zero temporary files',
    async (faultPoint) => {
      const env = createEnv();
      const rootPath = path.join(env.userDataPath, 'journal');
      let injected = false;
      const journal = trackedJournal(env, {
        faultInjector: (point) => {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`Injected ${point}`);
          }
        },
        rootPath,
      });
      await activate(journal);

      await expect(journal.save(record(), null)).resolves.toMatchObject({ kind: 'not-committed' });
      expect(journal.getHealth()).toBe('healthy');
      expect(
        fs
          .readdirSync(rootPath, { recursive: true })
          .map(String)
          .filter((entry) => entry.endsWith('.pending')),
      ).toEqual([]);
    },
  );

  it('withholds success after rename until shard durability is repaired and revalidated', async () => {
    const env = createEnv();
    let injected = false;
    const journal = trackedJournal(env, {
      faultInjector: (point) => {
        if (!injected && point === 'after-record-rename') {
          injected = true;
          throw new Error('lost rename acknowledgement');
        }
      },
    });
    await activate(journal);
    const initial = record();

    await expect(journal.save(initial, null)).resolves.toMatchObject({
      kind: 'durability-repair-required',
    });
    expect(journal.getHealth()).toBe('durability-repair-required');
    expect(journal.getByOperationId(initial.operationId)).toBeNull();
    await expect(journal.repairDurability()).resolves.toBe(true);
    expect(journal.getByOperationId(initial.operationId)).toEqual(initial);
    expect(journal.getHealth()).toBe('healthy');
  });

  it('fails an activated journal closed when a shard is missing and never recreates it', async () => {
    const env = createEnv();
    const rootPath = path.join(env.userDataPath, 'journal');
    const journal = trackedJournal(env, { rootPath });
    await activate(journal);
    await journal.close();
    journals.splice(journals.indexOf(journal), 1);
    fs.rmdirSync(path.join(rootPath, '7f'));

    const restarted = trackedJournal(env, { rootPath });
    await expect(restarted.startup()).resolves.toEqual({ health: 'recovery-required' });
    expect(fs.existsSync(path.join(rootPath, '7f'))).toBe(false);
  });

  it('rebuilds a stale derived index from finals without treating it as truth', async () => {
    const env = createEnv();
    const rootPath = path.join(env.userDataPath, 'journal');
    const journal = trackedJournal(env, { rootPath });
    await activate(journal);
    await journal.save(record(), null);
    await journal.flushDerivedIndex();
    await journal.close();
    journals.splice(journals.indexOf(journal), 1);
    fs.writeFileSync(path.join(rootPath, SHARDED_OPERATION_STORE_INDEX_FILE_NAME), '{}');

    const restarted = trackedJournal(env, { rootPath });
    await expect(restarted.startup()).resolves.toMatchObject({ health: 'healthy' });
    expect(restarted.getCounts().records).toBe(1);
    await expect(restarted.flushDerivedIndex()).resolves.toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(rootPath, SHARDED_OPERATION_STORE_INDEX_FILE_NAME), 'utf8'),
      ),
    ).toMatchObject({ formatVersion: 1 });
  });

  it('migrates legacy records behind one immutable digest marker', async () => {
    const env = createEnv();
    const rootPath = path.join(env.userDataPath, 'journal');
    const journal = trackedJournal(env, { rootPath });
    const legacy = [record()];
    const legacyDigest = digest(canonicalJsonStringify(legacy as never));
    await expect(journal.activateFromLegacy(legacy, legacyDigest)).resolves.toMatchObject({
      health: 'healthy',
    });
    const legacyRecord = requireDefined(legacy[0], 'legacy record');
    expect(journal.getByOperationId(legacyRecord.operationId)).toEqual(legacyRecord);
    const marker = JSON.parse(
      fs.readFileSync(path.join(rootPath, SHARDED_OPERATION_STORE_LAYOUT_FILE_NAME), 'utf8'),
    ) as Record<string, unknown>;
    expect(marker.legacyDigest).toBe(legacyDigest);
  });

  it('counts retained manual barriers, enforces per-principal capacity, and never pressure-evicts', async () => {
    const env = createEnv();
    const journal = trackedJournal(env);
    await activate(journal);
    for (let index = 1; index <= 32; index += 1) {
      const key = conflict(`artifact-${index}`);
      const current = record({
        activeConflictKeys: [key],
        conflictKeys: [key],
        operation: operationId(index),
        phase: 'manual-reconciliation-required',
        retention: { kind: 'retained-artifact' },
      });
      current.issueCode = 'manual-reconciliation-required';
      current.reconciliation = {
        kind: 'artifact-ambiguous',
        resources: [{ conflictKey: key, resourceId: `artifact-${index}` }],
      };
      await journal.save(current, null);
    }
    expect(journal.getCounts().nonterminal).toBe(32);
    await expect(journal.save(record({ operation: operationId(33) }), null)).rejects.toThrow(
      /principal capacity exceeded/u,
    );
    expect(journal.getCounts()).toMatchObject({ nonterminal: 32, records: 32 });
  });

  it('compacts only expired safe tombstones and retains live/manual identity', async () => {
    const env = createEnv();
    const journal = trackedJournal(env);
    await activate(journal);
    const expired = tombstone(operationId(1), 1_000);
    const live = tombstone(operationId(2), 3_000);
    const active = record({ operation: operationId(3) });
    await journal.save(expired, null);
    await journal.save(live, null);
    await journal.save(active, null);

    await expect(journal.compactExpired(2_000)).resolves.toBe(1);
    expect(journal.getByOperationId(expired.operationId)).toBeNull();
    expect(journal.getByOperationId(live.operationId)).toEqual(live);
    expect(journal.getByOperationId(active.operationId)).toEqual(active);
    expect(live.retention.kind === 'tombstone' && live.retention.expiresAtMs).toBeLessThan(
      Date.now() + TASK_CREATION_JOURNAL_TOMBSTONE_RETENTION_MS,
    );
  });

  it('permits only one journal owner for a canonical state directory', async () => {
    const env = createEnv();
    const rootPath = path.join(env.userDataPath, 'journal');
    const first = trackedJournal(env, { rootPath });
    const second = trackedJournal(env, { rootPath });
    await activate(first);
    await expect(second.startup()).rejects.toThrow(/already open in this process/u);
  });
});
