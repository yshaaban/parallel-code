import { describe, expect, it } from 'vitest';

import {
  TASK_NOTES_CHANGED_MAX_BYTES,
  TASK_NOTES_MAX_ACKNOWLEDGEMENTS,
  TASK_NOTES_MAX_BODY_BYTES,
  TASK_NOTES_MAX_BYTES,
  getTaskNotesRemainingBytes,
  getTaskNotesRequestErrorHttpStatus,
  getWellFormedUtf8ByteLength,
  isGetTaskNotesRequest,
  isGetTaskNotesResult,
  isGetTaskNotesWireResponse,
  isIssueTaskNotesOperationRequest,
  isIssueTaskNotesOperationResult,
  isTaskNotesChangedNotification,
  isTaskNotesCapability,
  isTaskNotesCurrentEnvelope,
  isTaskNotesDeadline,
  isTaskNotesOperationId,
  isTaskNotesOperationOutcome,
  isTaskNotesOpaque32ByteToken,
  isTaskNotesRequestError,
  isTaskNotesRetryAfterMs,
  isTaskNotesRevision,
  isTaskNotesSnapshot,
  isTaskNotesSourceId,
  isTaskNotesTaskId,
  isTaskNotesText,
  isUpdateTaskNotesRequest,
  isUpdateTaskNotesResult,
  isUpdateTaskNotesWireResponse,
  normalizeTaskNotesSourceId,
  serializeTaskNotesChangedNotification,
  type TaskNotesCurrentEnvelope,
  type TaskNotesRequestError,
  type TaskNotesSnapshot,
} from './task-notes.js';

const OPERATION_ID = 'A'.repeat(22);
const TOKEN = 'A'.repeat(43);
const SERVER_INSTANCE_ID = '00000000-0000-0000-0000-000000000000';
const ADMIT_UNTIL = '2026-08-03T10:10:00.000Z';
const REPLAY_UNTIL = '2026-08-04T10:00:00.000Z';
const MAX_DEADLINE = '9999-12-31T23:59:59.999Z';

describe('task notes capability', () => {
  it('accepts only the exact read/write boolean projection', () => {
    expect(isTaskNotesCapability({ read: true, write: false })).toBe(true);
    expect(isTaskNotesCapability({ read: false, write: true })).toBe(false);
    expect(isTaskNotesCapability({ read: true, write: false, extra: true })).toBe(false);
    expect(isTaskNotesCapability({ read: true, write: 'yes' })).toBe(false);
  });
});

function snapshot(overrides: Partial<TaskNotesSnapshot> = {}): TaskNotesSnapshot {
  return {
    taskId: 'task-1',
    taskIncarnation: TOKEN,
    notes: 'notes',
    contentVersion: TOKEN,
    workspaceRevision: 1,
    ...overrides,
  };
}

function sameIncarnationCurrent(
  currentSnapshot: TaskNotesSnapshot = snapshot(),
): Extract<TaskNotesCurrentEnvelope, { relation: 'same-incarnation' }> {
  return {
    relation: 'same-incarnation',
    currentNotes: { kind: 'present', snapshot: currentSnapshot },
    currentTask: {
      serverInstanceId: SERVER_INSTANCE_ID,
      catalogVersion: 2,
      taskState: 'present',
      taskClosing: false,
      taskIncarnation: currentSnapshot.taskIncarnation,
    },
  };
}

function unavailableCurrent(
  relation: 'task-not-visible' | 'task-removed' | 'task-replaced',
): TaskNotesCurrentEnvelope {
  if (relation === 'task-replaced') {
    return {
      relation,
      currentNotes: { kind: 'unavailable', reason: relation, workspaceRevision: 3 },
      currentTask: {
        serverInstanceId: SERVER_INSTANCE_ID,
        catalogVersion: 4,
        taskState: 'present',
        taskClosing: true,
        taskIncarnation: TOKEN,
      },
    };
  }
  const taskState = relation === 'task-removed' ? 'removed' : 'not-visible';
  return {
    relation,
    currentNotes: { kind: 'unavailable', reason: relation, workspaceRevision: 3 },
    currentTask: {
      serverInstanceId: SERVER_INSTANCE_ID,
      catalogVersion: 4,
      taskState,
      taskClosing: false,
    },
  } as TaskNotesCurrentEnvelope;
}

function withExtra(value: object): object {
  return { ...value, unexpected: true };
}

describe('task notes Unicode and fixed fields', () => {
  it('counts exact well-formed UTF-8 bytes without normalizing content', () => {
    expect(getWellFormedUtf8ByteLength('a\u0000é界🚀')).toBe(1 + 1 + 2 + 3 + 4);
    expect(getWellFormedUtf8ByteLength('Cafe\u0301')).toBe(6);
    expect(getWellFormedUtf8ByteLength('Café')).toBe(5);
    expect(getWellFormedUtf8ByteLength('\ud800')).toBeNull();
    expect(getWellFormedUtf8ByteLength('\udc00')).toBeNull();
    expect(getWellFormedUtf8ByteLength('\ud800x')).toBeNull();
  });

  it('accepts the exact decoded note ceiling and rejects one byte over', () => {
    const exactAscii = 'a'.repeat(TASK_NOTES_MAX_BYTES);
    const exactAstral = '🚀'.repeat(TASK_NOTES_MAX_BYTES / 4);
    expect(isTaskNotesText(exactAscii)).toBe(true);
    expect(isTaskNotesText(exactAstral)).toBe(true);
    expect(getTaskNotesRemainingBytes(exactAstral)).toBe(0);
    expect(isTaskNotesText(`${exactAscii}a`)).toBe(false);
    expect(isTaskNotesText(`${exactAstral}a`)).toBe(false);
    expect(getTaskNotesRemainingBytes('\ud800')).toBeNull();
  });

  it('enforces task/source/token/deadline/revision/retry canonical forms', () => {
    expect(isTaskNotesTaskId('\u0000'.repeat(128))).toBe(true);
    expect(isTaskNotesTaskId('🚀'.repeat(32))).toBe(true);
    expect(isTaskNotesTaskId('🚀'.repeat(33))).toBe(false);
    for (const value of ['', '__proto__', 'prototype', 'constructor', '\ud800']) {
      expect(isTaskNotesTaskId(value)).toBe(false);
    }

    expect(isTaskNotesSourceId('source_1-A')).toBe(true);
    expect(isTaskNotesSourceId('a'.repeat(64))).toBe(true);
    expect(isTaskNotesSourceId('a'.repeat(65))).toBe(false);
    expect(isTaskNotesSourceId('not canonical')).toBe(false);
    expect(normalizeTaskNotesSourceId('a'.repeat(65))).toBeNull();

    expect(isTaskNotesOperationId(OPERATION_ID)).toBe(true);
    expect(isTaskNotesOperationId(`${'A'.repeat(21)}B`)).toBe(false);
    expect(isTaskNotesOpaque32ByteToken(TOKEN)).toBe(true);
    expect(isTaskNotesOpaque32ByteToken(`${'A'.repeat(42)}B`)).toBe(false);
    expect(isTaskNotesDeadline(REPLAY_UNTIL)).toBe(true);
    expect(isTaskNotesDeadline('2026-8-03T10:00:00.000Z')).toBe(false);
    expect(isTaskNotesDeadline('2026-02-30T10:00:00.000Z')).toBe(false);
    expect(isTaskNotesRevision(0)).toBe(true);
    expect(isTaskNotesRevision(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isTaskNotesRevision(-1)).toBe(false);
    expect(isTaskNotesRevision(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isTaskNotesRetryAfterMs(250)).toBe(true);
    expect(isTaskNotesRetryAfterMs(60_000)).toBe(true);
    expect(isTaskNotesRetryAfterMs(249)).toBe(false);
    expect(isTaskNotesRetryAfterMs(60_001)).toBe(false);
    expect(isTaskNotesRetryAfterMs(250.5)).toBe(false);
  });
});

describe('task notes request guards', () => {
  it('requires exact own data keys for Get', () => {
    expect(isGetTaskNotesRequest({ taskId: 'task-1' })).toBe(true);
    expect(isGetTaskNotesRequest({ taskId: 'task-1', extra: true })).toBe(false);
    expect(isGetTaskNotesRequest(Object.create({ taskId: 'task-1' }))).toBe(false);

    const accessor = {};
    Object.defineProperty(accessor, 'taskId', {
      enumerable: true,
      get: () => 'task-1',
    });
    expect(isGetTaskNotesRequest(accessor)).toBe(false);
  });

  it('bounds unique acknowledgement proofs and forbids partial Issue recovery fields', () => {
    const acknowledgedOperations = Array.from(
      { length: TASK_NOTES_MAX_ACKNOWLEDGEMENTS },
      (_, index) => ({
        operationId: `${'A'.repeat(21)}${['A', 'Q', 'g', 'w'][index % 4]}`,
        operationCapability: TOKEN,
      }),
    );
    // Operation IDs must be unique, so vary a canonical leading byte as well.
    acknowledgedOperations.forEach((entry, index) => {
      entry.operationId = `${String.fromCharCode(65 + index)}${entry.operationId.slice(1)}`;
    });
    const request = { taskId: 'task-1', taskIncarnation: TOKEN, acknowledgedOperations };
    expect(isIssueTaskNotesOperationRequest(request)).toBe(true);
    expect(
      isIssueTaskNotesOperationRequest({
        ...request,
        acknowledgedOperations: [...acknowledgedOperations, acknowledgedOperations[0]],
      }),
    ).toBe(false);
    expect(
      isIssueTaskNotesOperationRequest({
        ...request,
        acknowledgedOperations: [acknowledgedOperations[0], acknowledgedOperations[0]],
      }),
    ).toBe(false);
    expect(isIssueTaskNotesOperationRequest(withExtra(request))).toBe(false);
  });

  it('accepts exact Update control content and rejects malformed or over-limit content', () => {
    const request = {
      taskId: '\u0000'.repeat(128),
      taskIncarnation: TOKEN,
      notes: '\u0000'.repeat(TASK_NOTES_MAX_BYTES),
      baseContentVersion: TOKEN,
      operationId: OPERATION_ID,
      operationCapability: TOKEN,
    };
    expect(isUpdateTaskNotesRequest(request)).toBe(true);
    expect(isUpdateTaskNotesRequest({ ...request, notes: `${request.notes}\u0000` })).toBe(false);
    expect(isUpdateTaskNotesRequest({ ...request, taskIncarnation: `${TOKEN}A` })).toBe(false);
    expect(isUpdateTaskNotesRequest(withExtra(request))).toBe(false);
  });
});

describe('task notes coherent current and result algebras', () => {
  it('accepts only legal coherent envelope relations and matching present tokens', () => {
    const same = sameIncarnationCurrent();
    expect(isTaskNotesSnapshot(same.currentNotes.snapshot)).toBe(true);
    expect(isTaskNotesCurrentEnvelope(same)).toBe(true);
    expect(isTaskNotesCurrentEnvelope(unavailableCurrent('task-replaced'))).toBe(true);
    expect(isTaskNotesCurrentEnvelope(unavailableCurrent('task-removed'))).toBe(true);
    expect(isTaskNotesCurrentEnvelope(unavailableCurrent('task-not-visible'))).toBe(true);

    expect(
      isTaskNotesCurrentEnvelope({
        ...same,
        currentTask: { ...same.currentTask, taskIncarnation: `${'E'.repeat(42)}A` },
      }),
    ).toBe(false);
    expect(
      isTaskNotesCurrentEnvelope({
        ...unavailableCurrent('task-removed'),
        currentTask: {
          serverInstanceId: SERVER_INSTANCE_ID,
          catalogVersion: 1,
          taskState: 'removed',
          taskClosing: true,
        },
      }),
    ).toBe(false);
    expect(isTaskNotesCurrentEnvelope(withExtra(same))).toBe(false);
  });

  it('guards every operation outcome and Get/Issue discriminator with exact keys', () => {
    const outcomes = [
      {
        kind: 'saved',
        changed: true,
        committedContentVersion: TOKEN,
        committedWorkspaceRevision: 2,
      },
      { kind: 'conflict', observedContentVersion: TOKEN, observedWorkspaceRevision: 2 },
      { kind: 'task-incarnation-changed', observedWorkspaceRevision: 2 },
    ];
    outcomes.forEach((outcome) => {
      expect(isTaskNotesOperationOutcome(outcome)).toBe(true);
      expect(isTaskNotesOperationOutcome(withExtra(outcome))).toBe(false);
    });

    const getResults = [
      { kind: 'loaded', current: sameIncarnationCurrent() },
      { kind: 'not-found', current: unavailableCurrent('task-removed') },
      { kind: 'not-visible', current: unavailableCurrent('task-not-visible') },
      { kind: 'task-state-unavailable', retryAfterMs: 250 },
    ];
    getResults.forEach((result) => expect(isGetTaskNotesResult(result)).toBe(true));
    expect(
      isGetTaskNotesResult({ kind: 'not-found', current: unavailableCurrent('task-not-visible') }),
    ).toBe(false);

    const issueResults = [
      {
        kind: 'issued',
        operation: {
          operationId: OPERATION_ID,
          operationCapability: TOKEN,
          admitUntil: ADMIT_UNTIL,
          replayUntil: REPLAY_UNTIL,
        },
      },
      { kind: 'not-found' },
      { kind: 'not-visible' },
      { kind: 'task-incarnation-changed' },
      { kind: 'task-state-unavailable', retryAfterMs: 500 },
      {
        kind: 'durability-repair-required',
        reservation: 'withheld',
        acknowledgementReclamation: 'unknown',
      },
      {
        kind: 'host-state-recovery-required',
        reservation: 'withheld',
        acknowledgementReclamation: 'unknown',
      },
    ];
    issueResults.forEach((result) => expect(isIssueTaskNotesOperationResult(result)).toBe(true));
    expect(
      isIssueTaskNotesOperationResult({
        ...issueResults.at(-1),
        operation: { operationId: OPERATION_ID },
      }),
    ).toBe(false);
  });

  it('keeps completed, closing, busy, state, durability, and host results disjoint', () => {
    const outcome = {
      kind: 'saved' as const,
      changed: false,
      committedContentVersion: TOKEN,
      committedWorkspaceRevision: 5,
    };
    const results = [
      {
        kind: 'completed',
        originalOutcome: outcome,
        current: sameIncarnationCurrent(),
        replayed: false,
        effectiveRetireAfter: REPLAY_UNTIL,
        postCommitWarning: 'projection-repair-required',
      },
      { kind: 'task-closing', current: unavailableCurrent('task-removed'), replayed: false },
      { kind: 'operation-expired', expiredAt: REPLAY_UNTIL },
      { kind: 'recovery-busy', retryAfterMs: 500, effectiveRetireAfter: REPLAY_UNTIL },
      {
        kind: 'task-state-unavailable',
        retryAfterMs: 500,
        knownDisposition: { kind: 'unsettled' },
      },
      {
        kind: 'task-state-unavailable',
        retryAfterMs: 500,
        knownDisposition: {
          kind: 'completed',
          originalOutcome: outcome,
          replayed: true,
          effectiveRetireAfter: REPLAY_UNTIL,
        },
      },
      {
        kind: 'durability-repair-required',
        replayed: false,
        retention: 'held',
        semanticProposal: 'admission-only',
      },
      {
        kind: 'durability-repair-required',
        replayed: true,
        retention: 'held',
        semanticProposal: 'retry-window-only',
      },
      {
        kind: 'durability-repair-required',
        replayed: false,
        retention: 'held',
        semanticProposal: 'terminal-outcome',
        proposedOutcome: outcome,
      },
      { kind: 'host-state-recovery-required', replayed: false, retention: 'held' },
    ];
    results.forEach((result) => expect(isUpdateTaskNotesResult(result)).toBe(true));
    expect(
      isUpdateTaskNotesResult({
        kind: 'durability-repair-required',
        replayed: false,
        retention: 'held',
        semanticProposal: 'admission-only',
        proposedOutcome: outcome,
      }),
    ).toBe(false);
    expect(
      isUpdateTaskNotesResult({
        kind: 'host-state-recovery-required',
        replayed: false,
        retention: 'held',
        current: sameIncarnationCurrent(),
      }),
    ).toBe(false);
    expect(
      isUpdateTaskNotesResult({
        kind: 'task-closing',
        current: sameIncarnationCurrent(),
        replayed: true,
      }),
    ).toBe(false);
  });
});

describe('task notes wire errors and size contracts', () => {
  it('guards exact request errors and maps every public HTTP status', () => {
    const cases: Array<[TaskNotesRequestError, number]> = [
      [{ code: 'bad-request' }, 400],
      [{ code: 'unauthenticated' }, 401],
      [{ code: 'forbidden' }, 403],
      [{ code: 'operation-identity-rejected' }, 409],
      [{ code: 'payload-too-large' }, 413],
      [{ code: 'unsupported-media-type' }, 415],
      [{ code: 'rate-limited', retryAfterMs: 250 }, 429],
      [{ code: 'capacity-exhausted', retryAfterMs: 60_000 }, 503],
      [{ code: 'persistence-unavailable', retryable: true }, 503],
      [{ code: 'internal-error', retryable: false }, 500],
    ];
    cases.forEach(([error, status]) => {
      expect(isTaskNotesRequestError(error)).toBe(true);
      expect(getTaskNotesRequestErrorHttpStatus(error)).toBe(status);
      expect(isTaskNotesRequestError(withExtra(error))).toBe(false);
    });
  });

  it('keeps success/error envelopes exact and method-specific', () => {
    expect(
      isGetTaskNotesWireResponse({
        ok: true,
        result: { kind: 'loaded', current: sameIncarnationCurrent() },
      }),
    ).toBe(true);
    expect(
      isUpdateTaskNotesWireResponse({
        ok: false,
        error: { code: 'operation-identity-rejected' },
      }),
    ).toBe(true);
    expect(
      isUpdateTaskNotesWireResponse({
        ok: true,
        result: { kind: 'not-found', current: unavailableCurrent('task-removed') },
      }),
    ).toBe(false);
    expect(
      isGetTaskNotesWireResponse({ ok: false, error: { code: 'bad-request' }, extra: true }),
    ).toBe(false);
  });

  it('serializes exact escaped and unescaped notification ceilings', () => {
    const escaped = serializeTaskNotesChangedNotification({
      taskId: '\u0000'.repeat(128),
      workspaceRevision: Number.MAX_SAFE_INTEGER,
      sourceId: 'a'.repeat(64),
    });
    const unescaped = serializeTaskNotesChangedNotification({
      taskId: 'a'.repeat(128),
      workspaceRevision: Number.MAX_SAFE_INTEGER,
      sourceId: 'a'.repeat(64),
    });
    expect(Buffer.byteLength(escaped)).toBe(TASK_NOTES_CHANGED_MAX_BYTES);
    expect(Buffer.byteLength(unescaped)).toBe(256);
    expect(isTaskNotesChangedNotification(JSON.parse(escaped))).toBe(true);
    expect(() =>
      serializeTaskNotesChangedNotification({
        taskId: 'a'.repeat(129),
        workspaceRevision: 1,
        sourceId: null,
      }),
    ).toThrow('Invalid task notes notification');
  });

  it('locks maximum request/result/wrapper JSON equations below the shared body cap', () => {
    const maximumRequest = {
      taskId: '\u0000'.repeat(128),
      taskIncarnation: TOKEN,
      notes: '\u0000'.repeat(TASK_NOTES_MAX_BYTES),
      baseContentVersion: TOKEN,
      operationId: OPERATION_ID,
      operationCapability: TOKEN,
    };
    const unescapedRequest = {
      ...maximumRequest,
      taskId: 'a'.repeat(128),
      notes: 'a'.repeat(TASK_NOTES_MAX_BYTES),
    };
    expect(Buffer.byteLength(JSON.stringify(maximumRequest))).toBe(615_430);
    expect(Buffer.byteLength(JSON.stringify(unescapedRequest))).toBe(102_790);

    const maximumSnapshot = snapshot({
      taskId: maximumRequest.taskId,
      notes: maximumRequest.notes,
      workspaceRevision: Number.MAX_SAFE_INTEGER,
    });
    const maximumCurrent = sameIncarnationCurrent(maximumSnapshot);
    maximumCurrent.currentTask.catalogVersion = Number.MAX_SAFE_INTEGER;
    const loadedResult = { kind: 'loaded', current: maximumCurrent };
    const loadedWire = { ok: true, result: loadedResult };
    expect(Buffer.byteLength(JSON.stringify(loadedResult))).toBe(615_675);
    expect(Buffer.byteLength(JSON.stringify(loadedWire))).toBe(615_696);

    const completedWire = {
      ok: true,
      result: {
        kind: 'completed',
        originalOutcome: {
          kind: 'saved',
          changed: false,
          committedContentVersion: TOKEN,
          committedWorkspaceRevision: Number.MAX_SAFE_INTEGER,
        },
        current: maximumCurrent,
        replayed: false,
        effectiveRetireAfter: MAX_DEADLINE,
        postCommitWarning: 'projection-repair-required',
      },
    };
    expect(Buffer.byteLength(JSON.stringify(completedWire))).toBe(615_984);

    const unescapedSnapshot = snapshot({
      taskId: 'a'.repeat(128),
      notes: 'a'.repeat(TASK_NOTES_MAX_BYTES),
      workspaceRevision: Number.MAX_SAFE_INTEGER,
    });
    const unescapedCurrent = sameIncarnationCurrent(unescapedSnapshot);
    unescapedCurrent.currentTask.catalogVersion = Number.MAX_SAFE_INTEGER;
    const unescapedLoaded = { kind: 'loaded', current: unescapedCurrent };
    expect(Buffer.byteLength(JSON.stringify(unescapedLoaded))).toBe(103_035);
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result: unescapedLoaded }))).toBe(103_056);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          ...completedWire,
          result: { ...completedWire.result, current: unescapedCurrent },
        }),
      ),
    ).toBe(103_344);
    expect(Buffer.byteLength(JSON.stringify(completedWire))).toBeLessThan(
      TASK_NOTES_MAX_BODY_BYTES,
    );
  });
});
