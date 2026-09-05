import { describe, expect, it } from 'vitest';

import type { UpdateTaskNotesRequest } from '../../src/domain/task-notes.js';
import {
  TASK_NOTES_ADMISSION_WINDOW_MS,
  TASK_NOTES_MAX_OPERATIONS_PER_PRINCIPAL,
  TASK_NOTES_REPLAY_WINDOW_MS,
  assertTaskNotesOperationRecord,
  assertTaskNotesOperationSegment,
  classifyTaskNotesOperation,
  compactExpiredTaskNotesOperations,
  createEmptyTaskNotesOperationSegment,
  createTaskNotesContentVersion,
  createTaskNotesOperationFingerprint,
  deriveTaskNotesIncarnation,
  findTaskNotesOperationRecord,
  getTaskNotesOperationRecordBytes,
  getTaskNotesOperationSegmentBytes,
  hashTaskNotesCapability,
  hashTaskNotesPrincipal,
  materializeTaskNotesRecoveryWindow,
  readTaskNotesOperationSegment,
  replaceTaskNotesOperationRecord,
  reserveTaskNotesOperation,
  terminalizeTaskNotesOperation,
  withTaskNotesOperationSegment,
  type TaskNotesOperationRecord,
  type TaskNotesOperationSegment,
} from './task-notes-operations.js';
import { canonicalJsonStringify, type JsonObject } from './workspace-state-storage.js';

const NOW = Date.parse('2026-08-03T10:00:00.000Z');
const WITNESS = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
const CAPABILITY = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI';
const OPERATION_ID = 'AwMDAwMDAwMDAwMDAwMDAw';
const PRINCIPAL_HASH = '48jcaSun3qv7ZYy8jPgUosv8Y7xFWZSG-vmX_XxkhgQ';

function operationId(index: number): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32BE(index >>> 0, 12);
  return bytes.toString('base64url');
}

function deterministicRandom(operationIndex = 0) {
  let call = 0;
  return (size: number): Uint8Array => {
    call += 1;
    if (size === 16) return Buffer.from(operationId(operationIndex), 'base64url');
    if (size === 32) return Buffer.alloc(32, (operationIndex % 253) + 2);
    throw new Error(`Unexpected random request ${size} at call ${call}`);
  };
}

function reserve(
  segment = createEmptyTaskNotesOperationSegment(),
  operationIndex = 0,
  principalHash = PRINCIPAL_HASH,
) {
  const result = reserveTaskNotesOperation(segment, {
    now: NOW,
    principalHash,
    randomBytes: deterministicRandom(operationIndex),
    taskId: 'task-1',
    taskIdentityWitness: WITNESS,
  });
  if (result.kind !== 'reserved') throw new Error(`Expected reservation, received ${result.kind}`);
  return result;
}

function updateRequest(
  operation = reserve().operation,
  overrides: Partial<UpdateTaskNotesRequest> = {},
): UpdateTaskNotesRequest {
  return {
    baseContentVersion: createTaskNotesContentVersion('base'),
    notes: 'hello',
    operationCapability: operation.operationCapability,
    operationId: operation.operationId,
    taskId: 'task-1',
    taskIncarnation: deriveTaskNotesIncarnation(WITNESS),
    ...overrides,
  };
}

function terminalReservation() {
  const reserved = reserve();
  const request = updateRequest(reserved.operation);
  const admitted = classifyTaskNotesOperation(reserved.record, {
    now: NOW + 1,
    principalHash: PRINCIPAL_HASH,
    request,
  });
  if (admitted.kind !== 'admit') throw new Error('Expected admission');
  const terminal = terminalizeTaskNotesOperation(
    admitted.record,
    {
      changed: true,
      committedContentVersion: createTaskNotesContentVersion('hello'),
      committedWorkspaceRevision: 2,
      kind: 'saved',
    },
    NOW + 2,
  );
  return { request, reserved, terminal };
}

describe('task notes operation cryptography', () => {
  it('binds stable domain-separated vectors and never exposes backend witness bytes', () => {
    expect(hashTaskNotesPrincipal('principal-1')).toBe(PRINCIPAL_HASH);
    expect(deriveTaskNotesIncarnation(WITNESS)).toBe('frl00bFjTrsFLRgZXghnDSZcBM5EcAB2nxH3_R5Mfu8');
    expect(createTaskNotesContentVersion('hello')).toBe(
      'LC2FyKp1sBCdvPlICIwo1pyPne2nipCLltmaIZkn4p8',
    );
    expect(hashTaskNotesCapability(CAPABILITY)).toBe('z40kHE5-5W4JnEspiwebkUUl_8zxTC9E2gc7YaMV6Ks');
    expect(
      createTaskNotesOperationFingerprint(
        updateRequest({
          admitUntil: '2026-08-03T10:10:00.000Z',
          operationCapability: CAPABILITY,
          operationId: OPERATION_ID,
          replayUntil: '2026-08-04T10:00:00.000Z',
        }),
      ),
    ).toBe('WEMTtFMX7qsqrRnQg7XpbazR7doODl2KKciw8P-aNb0');
  });
});

describe('task notes operation lifecycle', () => {
  it('reserves identity and capability atomically with exact backend deadlines', () => {
    const reserved = reserve(createEmptyTaskNotesOperationSegment(), 0);
    expect(reserved.operation).toEqual({
      admitUntil: '2026-08-03T10:10:00.000Z',
      operationCapability: CAPABILITY,
      operationId: operationId(0),
      replayUntil: '2026-08-04T10:00:00.000Z',
    });
    expect(reserved.record).toMatchObject({
      state: 'issued',
      retireAfter: reserved.operation.replayUntil,
      taskIdentityWitness: WITNESS,
    });
    const serialized = JSON.stringify(reserved.record);
    expect(serialized).not.toContain(reserved.operation.operationCapability);
    expect(getTaskNotesOperationRecordBytes(reserved.record)).toBeLessThanOrEqual(2_048);
    expect(getTaskNotesOperationSegmentBytes(reserved.segment)).toBe(
      Buffer.byteLength(canonicalJsonStringify(reserved.segment as unknown as JsonObject)),
    );
  });

  it('admits one immutable fingerprint, resumes it, terminalizes, and replays it', () => {
    const reserved = reserve();
    const request = updateRequest(reserved.operation);
    const admitted = classifyTaskNotesOperation(reserved.record, {
      now: NOW + 1,
      principalHash: PRINCIPAL_HASH,
      request,
    });
    expect(admitted.kind).toBe('admit');
    if (admitted.kind !== 'admit') return;

    expect(
      classifyTaskNotesOperation(admitted.record, {
        now: NOW + 2,
        principalHash: PRINCIPAL_HASH,
        request,
      }),
    ).toMatchObject({ kind: 'resume' });
    expect(
      classifyTaskNotesOperation(admitted.record, {
        now: NOW + 2,
        principalHash: PRINCIPAL_HASH,
        request: { ...request, notes: 'different' },
      }),
    ).toEqual({ kind: 'operation-identity-rejected' });

    const terminal = terminalizeTaskNotesOperation(
      admitted.record,
      {
        changed: true,
        committedContentVersion: createTaskNotesContentVersion('hello'),
        committedWorkspaceRevision: 2,
        kind: 'saved',
      },
      NOW + 2,
    );
    expect(terminal.retireAfter).toBe('2026-08-04T10:00:00.002Z');
    expect(
      classifyTaskNotesOperation(terminal, {
        now: NOW + 3,
        principalHash: PRINCIPAL_HASH,
        request,
      }),
    ).toMatchObject({ kind: 'replay', record: { outcome: { kind: 'saved' } } });
    expect(
      classifyTaskNotesOperation(terminal, {
        now: NOW + TASK_NOTES_REPLAY_WINDOW_MS + 2,
        principalHash: PRINCIPAL_HASH,
        request,
      }),
    ).toEqual({
      kind: 'operation-expired',
      expiredAt: '2026-08-04T10:00:00.002Z',
    });
  });

  it('distinguishes authenticated expiry from every wrong or unknown identity', () => {
    const reserved = reserve();
    const request = updateRequest(reserved.operation);
    expect(
      classifyTaskNotesOperation(reserved.record, {
        now: NOW + TASK_NOTES_ADMISSION_WINDOW_MS,
        principalHash: PRINCIPAL_HASH,
        request,
      }),
    ).toEqual({
      kind: 'operation-expired',
      expiredAt: '2026-08-03T10:10:00.000Z',
    });
    for (const classified of [
      classifyTaskNotesOperation(undefined, {
        now: NOW,
        principalHash: PRINCIPAL_HASH,
        request,
      }),
      classifyTaskNotesOperation(reserved.record, {
        now: NOW,
        principalHash: hashTaskNotesPrincipal('other'),
        request,
      }),
      classifyTaskNotesOperation(reserved.record, {
        now: NOW,
        principalHash: PRINCIPAL_HASH,
        request: { ...request, operationCapability: Buffer.alloc(32, 9).toString('base64url') },
      }),
    ]) {
      expect(classified).toEqual({ kind: 'operation-identity-rejected' });
    }
  });

  it('materializes a fresh recovery window without changing semantic truth', () => {
    const { terminal } = terminalReservation();
    const repaired = materializeTaskNotesRecoveryWindow(
      terminal,
      NOW + 2 * TASK_NOTES_REPLAY_WINDOW_MS,
    );
    expect(repaired).toEqual({
      ...terminal,
      retireAfter: '2026-08-06T10:00:00.000Z',
    });
  });
});

describe('task notes operation reclamation and capacity', () => {
  it('reclaims only a capability-proven unheld terminal record in the reservation proposal', () => {
    const { reserved, terminal } = terminalReservation();
    const terminalSegment = replaceTaskNotesOperationRecord(reserved.segment, terminal);
    const reclaimed = reserveTaskNotesOperation(terminalSegment, {
      acknowledgedOperations: [
        {
          operationCapability: reserved.operation.operationCapability,
          operationId: reserved.operation.operationId,
        },
      ],
      now: NOW + 3,
      principalHash: PRINCIPAL_HASH,
      randomBytes: deterministicRandom(1),
      taskId: 'task-1',
      taskIdentityWitness: WITNESS,
    });
    expect(reclaimed.kind).toBe('reserved');
    if (reclaimed.kind !== 'reserved') return;
    expect(reclaimed.reclaimedCount).toBe(1);
    expect(
      findTaskNotesOperationRecord(
        reclaimed.segment,
        PRINCIPAL_HASH,
        reserved.operation.operationId,
      ),
    ).toBeUndefined();

    const heldKey = `${PRINCIPAL_HASH}.${reserved.operation.operationId}`;
    const held = reserveTaskNotesOperation(
      terminalSegment,
      {
        acknowledgedOperations: [
          {
            operationCapability: reserved.operation.operationCapability,
            operationId: reserved.operation.operationId,
          },
        ],
        now: NOW + 3,
        principalHash: PRINCIPAL_HASH,
        randomBytes: deterministicRandom(1),
        taskId: 'task-1',
        taskIdentityWitness: WITNESS,
      },
      new Set([heldKey]),
    );
    expect(held).toMatchObject({ kind: 'reserved', reclaimedCount: 0 });
  });

  it('enforces the principal capacity and lets atomic reclamation make room', () => {
    const { reserved, terminal } = terminalReservation();
    const operations: Record<string, TaskNotesOperationRecord> = {};
    for (let index = 0; index < TASK_NOTES_MAX_OPERATIONS_PER_PRINCIPAL; index += 1) {
      const id = operationId(index);
      const record: TaskNotesOperationRecord =
        index === 0
          ? terminal
          : {
              ...reserved.record,
              operationId: id,
            };
      operations[`${PRINCIPAL_HASH}.${id}`] = record;
    }
    const full: TaskNotesOperationSegment = { formatVersion: 1, operations };
    assertTaskNotesOperationSegment(full);

    expect(
      reserveTaskNotesOperation(full, {
        now: NOW + 3,
        principalHash: PRINCIPAL_HASH,
        randomBytes: deterministicRandom(300),
        taskId: 'task-1',
        taskIdentityWitness: WITNESS,
      }),
    ).toEqual({ kind: 'capacity-exhausted', reclaimedCount: 0 });

    const reclaimed = reserveTaskNotesOperation(full, {
      acknowledgedOperations: [
        {
          operationCapability: reserved.operation.operationCapability,
          operationId: terminal.operationId,
        },
      ],
      now: NOW + 3,
      principalHash: PRINCIPAL_HASH,
      randomBytes: deterministicRandom(300),
      taskId: 'task-1',
      taskIdentityWitness: WITNESS,
    });
    expect(reclaimed).toMatchObject({ kind: 'reserved', reclaimedCount: 1 });
    if (reclaimed.kind === 'reserved') {
      expect(Object.keys(reclaimed.segment.operations)).toHaveLength(
        TASK_NOTES_MAX_OPERATIONS_PER_PRINCIPAL,
      );
    }
  });

  it('collision-checks operation IDs across principals and fails after four samples', () => {
    const first = reserve();
    const otherPrincipal = hashTaskNotesPrincipal('other-principal');
    const collisionRandom = (size: number): Uint8Array => {
      if (size !== 16) throw new Error('Capability allocation must not occur after collisions');
      return Buffer.from(first.operation.operationId, 'base64url');
    };
    expect(
      reserveTaskNotesOperation(first.segment, {
        now: NOW,
        principalHash: otherPrincipal,
        randomBytes: collisionRandom,
        taskId: 'task-1',
        taskIdentityWitness: WITNESS,
      }),
    ).toEqual({ kind: 'identity-collision', reclaimedCount: 0 });
  });

  it('compacts only expired, unheld records', () => {
    const issued = reserve();
    const key = `${PRINCIPAL_HASH}.${issued.operation.operationId}`;
    expect(
      Object.keys(
        compactExpiredTaskNotesOperations(issued.segment, NOW + TASK_NOTES_ADMISSION_WINDOW_MS)
          .operations,
      ),
    ).toEqual([]);
    expect(
      Object.keys(
        compactExpiredTaskNotesOperations(
          issued.segment,
          NOW + TASK_NOTES_ADMISSION_WINDOW_MS,
          new Set([key]),
        ).operations,
      ),
    ).toEqual([key]);
  });
});

describe('task notes operation codecs', () => {
  it('rejects accessor maps, mismatched keys, malformed deadlines, and oversized task IDs', () => {
    const reserved = reserve();
    expect(() => assertTaskNotesOperationRecord({ ...reserved.record, extra: true })).toThrow();
    expect(() =>
      assertTaskNotesOperationRecord({
        ...reserved.record,
        admitUntil: reserved.record.replayUntil,
      }),
    ).toThrow();
    expect(() =>
      assertTaskNotesOperationSegment({
        formatVersion: 1,
        operations: { wrong: reserved.record },
      }),
    ).toThrow();

    const accessorMap = {};
    Object.defineProperty(accessorMap, `${PRINCIPAL_HASH}.${reserved.record.operationId}`, {
      enumerable: true,
      get: () => reserved.record,
    });
    expect(() =>
      assertTaskNotesOperationSegment({ formatVersion: 1, operations: accessorMap }),
    ).toThrow(/own data properties/u);
  });

  it('keeps the versioned segment in backend-private state and fails closed when active state is missing', () => {
    const reserved = reserve();
    const privateState = withTaskNotesOperationSegment({ other: true }, reserved.segment);
    expect(readTaskNotesOperationSegment(privateState)).toEqual(reserved.segment);
    expect(privateState).toMatchObject({ other: true });
    expect(() => readTaskNotesOperationSegment({})).toThrow();
    expect(readTaskNotesOperationSegment({}, { allowMissing: true })).toEqual(
      createEmptyTaskNotesOperationSegment(),
    );
  });
});
