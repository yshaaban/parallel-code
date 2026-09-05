import { describe, expect, it } from 'vitest';

import type {
  GetTaskNotesResult,
  IssueTaskNotesOperationResult,
  TaskNotesCurrentEnvelope,
  TaskNotesSnapshot,
  UpdateTaskNotesResult,
} from '../../domain/task-notes';
import {
  applyGetTaskNotesResult,
  applyIssueTaskNotesResult,
  applyTaskNotesExternalSnapshot,
  applyTaskNotesLifecycleProjection,
  applyTaskNotesRequestError,
  applyTaskNotesTransportFailure,
  applyUpdateTaskNotesResult,
  editTaskNotesDraft,
  incrementTaskNotesGeneration,
  openTaskNotes,
  overwriteTaskNotesWithLatestBase,
  retryPendingTaskNotesUpdate,
  retryTaskNotesGet,
  retryTaskNotesIssue,
  submitTaskNotes,
  useLatestTaskNotesSnapshot,
  type TaskNotesEditorState,
  type TaskNotesTransition,
} from './task-notes-draft';

const TOKEN = 'A'.repeat(43);
const OTHER_TOKEN = `${'E'.repeat(42)}A`;
const OPERATION_ID = 'A'.repeat(22);
const ADMIT_UNTIL = '2026-08-03T10:10:00.000Z';
const REPLAY_UNTIL = '2026-08-04T10:00:00.000Z';
const SERVER_INSTANCE_ID = '00000000-0000-0000-0000-000000000000';

function snapshot(overrides: Partial<TaskNotesSnapshot> = {}): TaskNotesSnapshot {
  return {
    taskId: 'task-1',
    taskIncarnation: TOKEN,
    notes: 'base',
    contentVersion: TOKEN,
    workspaceRevision: 1,
    ...overrides,
  };
}

function current(
  currentSnapshot: TaskNotesSnapshot = snapshot(),
  taskClosing = false,
): Extract<TaskNotesCurrentEnvelope, { relation: 'same-incarnation' }> {
  return {
    relation: 'same-incarnation',
    currentNotes: { kind: 'present', snapshot: currentSnapshot },
    currentTask: {
      serverInstanceId: SERVER_INSTANCE_ID,
      catalogVersion: 1,
      taskState: 'present',
      taskClosing,
      taskIncarnation: currentSnapshot.taskIncarnation,
    },
  };
}

function loaded(currentSnapshot = snapshot()): GetTaskNotesResult {
  return { kind: 'loaded', current: current(currentSnapshot) };
}

function issued(): Extract<IssueTaskNotesOperationResult, { kind: 'issued' }> {
  return {
    kind: 'issued',
    operation: {
      operationId: OPERATION_ID,
      operationCapability: TOKEN,
      admitUntil: ADMIT_UNTIL,
      replayUntil: REPLAY_UNTIL,
    },
  };
}

function transitionToSaving(): TaskNotesTransition {
  const opened = openTaskNotes('task-1');
  const clean = applyGetTaskNotesResult(
    opened.state,
    { editorGeneration: opened.state.generation, taskId: 'task-1' },
    loaded(),
  );
  const dirty = editTaskNotesDraft(clean.state, 'submitted');
  const requesting = submitTaskNotes(dirty.state);
  if (requesting.state.kind !== 'issuing') throw new Error('Expected issuing state');
  return applyIssueTaskNotesResult(
    requesting.state,
    {
      editorGeneration: requesting.state.generation,
      issueRequestGeneration: requesting.state.issueRequestGeneration,
      taskId: 'task-1',
    },
    issued(),
  );
}

function updateTag(state: TaskNotesEditorState, attempt?: number) {
  if (!('pending' in state) || !state.pending) throw new Error('Expected pending notes state');
  return {
    editorGeneration: state.generation,
    operationId: state.pending.operation.operationId,
    updateAttemptGeneration: attempt ?? state.pending.latestUpdateAttemptGeneration,
  };
}

function savedResult(
  currentSnapshot = snapshot({
    notes: 'submitted',
    contentVersion: OTHER_TOKEN,
    workspaceRevision: 2,
  }),
): Extract<UpdateTaskNotesResult, { kind: 'completed' }> {
  return {
    kind: 'completed',
    originalOutcome: {
      kind: 'saved',
      changed: true,
      committedContentVersion: currentSnapshot.contentVersion,
      committedWorkspaceRevision: currentSnapshot.workspaceRevision,
    },
    current: current(currentSnapshot),
    replayed: false,
    effectiveRetireAfter: REPLAY_UNTIL,
  };
}

describe('task notes draft reducer', () => {
  it('resolves conflicts explicitly without mutating the retained draft prematurely', () => {
    const saving = transitionToSaving();
    const conflicting = applyUpdateTaskNotesResult(saving.state, updateTag(saving.state), {
      kind: 'completed',
      originalOutcome: {
        kind: 'conflict',
        observedContentVersion: OTHER_TOKEN,
        observedWorkspaceRevision: 2,
      },
      current: current(
        snapshot({ notes: 'latest', contentVersion: OTHER_TOKEN, workspaceRevision: 2 }),
      ),
      replayed: false,
      effectiveRetireAfter: REPLAY_UNTIL,
    });
    expect(conflicting.state).toMatchObject({
      kind: 'conflict',
      draft: 'submitted',
      current: { notes: 'latest' },
    });

    expect(useLatestTaskNotesSnapshot(conflicting.state).state).toMatchObject({
      kind: 'clean',
      draft: 'latest',
      base: { notes: 'latest' },
    });
    const overwrite = overwriteTaskNotesWithLatestBase(conflicting.state);
    expect(overwrite.state).toMatchObject({
      kind: 'issuing',
      draft: 'submitted',
      base: { notes: 'latest' },
      submittedText: 'submitted',
    });
  });

  it('enters closing on the initial loaded lifecycle projection', () => {
    const opened = openTaskNotes('task-1');
    const result = applyGetTaskNotesResult(
      opened.state,
      { editorGeneration: opened.state.generation, taskId: 'task-1' },
      { kind: 'loaded', current: current(snapshot(), true) },
    );
    expect(result.state).toMatchObject({ kind: 'closing', draft: 'base', outcome: 'unknown' });
  });

  it('never regresses the greatest observed revision when completion returns older current notes', () => {
    const saving = transitionToSaving();
    const withExternal = applyTaskNotesExternalSnapshot(
      saving.state,
      snapshot({ notes: 'newest remote', contentVersion: OTHER_TOKEN, workspaceRevision: 3 }),
    );
    const completed = applyUpdateTaskNotesResult(
      withExternal.state,
      updateTag(withExternal.state),
      savedResult(snapshot({ notes: 'submitted', contentVersion: TOKEN, workspaceRevision: 2 })),
    );
    expect(completed.state).toMatchObject({
      kind: 'dirty',
      base: { notes: 'newest remote', workspaceRevision: 3 },
      draft: 'submitted',
    });
  });

  it('never drops an unsettled pending submission when an ordinary Get returns newer notes', () => {
    const saving = transitionToSaving();
    const refreshed = applyGetTaskNotesResult(
      saving.state,
      { editorGeneration: saving.state.generation, taskId: 'task-1' },
      loaded(snapshot({ notes: 'remote', contentVersion: OTHER_TOKEN, workspaceRevision: 2 })),
    );
    expect(refreshed.state).toMatchObject({
      kind: 'saving',
      draft: 'submitted',
      pending: { operation: { operationId: OPERATION_ID } },
      external: { notes: 'remote', workspaceRevision: 2 },
    });
  });
  it('opens through a generation-bound Get and loads one acknowledged base', () => {
    const opened = openTaskNotes('task-1', 4);
    expect(opened.state).toMatchObject({ kind: 'loading', generation: 5, taskId: 'task-1' });
    expect(opened.effects).toEqual([{ kind: 'get', taskId: 'task-1', editorGeneration: 5 }]);

    const clean = applyGetTaskNotesResult(
      opened.state,
      { editorGeneration: 5, taskId: 'task-1' },
      loaded(),
    );
    expect(clean.state).toMatchObject({ kind: 'clean', draft: 'base', base: { notes: 'base' } });
    expect(
      applyGetTaskNotesResult(
        clean.state,
        { editorGeneration: 4, taskId: 'task-1' },
        loaded(snapshot({ notes: 'stale' })),
      ),
    ).toEqual({ state: clean.state, effects: [] });
  });

  it('never wraps generation counters', () => {
    expect(incrementTaskNotesGeneration(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(incrementTaskNotesGeneration(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(incrementTaskNotesGeneration(-1)).toBeNull();
    expect(incrementTaskNotesGeneration(0.5)).toBeNull();
    const exhausted = openTaskNotes('task-1', Number.MAX_SAFE_INTEGER);
    expect(exhausted.state).toMatchObject({ kind: 'error', recovery: 'none' });
    expect(exhausted.effects).toEqual([
      { kind: 'invariant-violation', code: 'generation-exhausted' },
    ]);
  });

  it('snapshots submitted text once and derives Update only from immutable pending fields', () => {
    const saving = transitionToSaving();
    expect(saving.state).toMatchObject({
      kind: 'saving',
      draft: 'submitted',
      pending: {
        submittedText: 'submitted',
        baseContentVersion: TOKEN,
        latestUpdateAttemptGeneration: 1,
      },
    });
    expect(saving.effects).toEqual([
      {
        kind: 'update',
        editorGeneration: saving.state.generation,
        updateAttemptGeneration: 1,
        request: {
          taskId: 'task-1',
          taskIncarnation: TOKEN,
          notes: 'submitted',
          baseContentVersion: TOKEN,
          operationId: OPERATION_ID,
          operationCapability: TOKEN,
        },
      },
    ]);

    const typed = editTaskNotesDraft(saving.state, 'newer visible draft');
    const retried = retryPendingTaskNotesUpdate(typed.state);
    expect(retried.state).toMatchObject({
      kind: 'saving',
      draft: 'newer visible draft',
      pending: { submittedText: 'submitted', latestUpdateAttemptGeneration: 2 },
    });
    expect(retried.effects[0]).toMatchObject({
      kind: 'update',
      updateAttemptGeneration: 2,
      request: { notes: 'submitted', operationId: OPERATION_ID },
    });
  });

  it('ignores every late Issue completion after a greater request generation', () => {
    const opened = openTaskNotes('task-1').state;
    const clean = applyGetTaskNotesResult(
      opened,
      { editorGeneration: opened.generation, taskId: 'task-1' },
      loaded(),
    ).state;
    const first = submitTaskNotes(editTaskNotesDraft(clean, 'first').state);
    if (first.state.kind !== 'issuing') throw new Error('Expected issuing state');
    const second = retryTaskNotesIssue(first.state);
    if (second.state.kind !== 'issuing') throw new Error('Expected issuing state');

    const late = applyIssueTaskNotesResult(
      second.state,
      {
        editorGeneration: second.state.generation,
        issueRequestGeneration: first.state.issueRequestGeneration,
        taskId: 'task-1',
      },
      issued(),
    );
    expect(late).toEqual({ state: second.state, effects: [] });
  });

  it('advances Issue generation across request errors and rejects the orphaned tuple', () => {
    const opened = openTaskNotes('task-1').state;
    const clean = applyGetTaskNotesResult(
      opened,
      { editorGeneration: opened.generation, taskId: 'task-1' },
      loaded(),
    ).state;
    const first = submitTaskNotes(editTaskNotesDraft(clean, 'first').state);
    if (first.state.kind !== 'issuing') throw new Error('Expected issuing state');
    const failed = applyTaskNotesRequestError(
      first.state,
      'issue',
      {
        editorGeneration: first.state.generation,
        issueRequestGeneration: first.state.issueRequestGeneration,
      },
      { code: 'rate-limited', retryAfterMs: 250 },
    );
    expect(failed.state).toMatchObject({
      kind: 'error',
      recovery: 'retry-issue',
      issueRequestGeneration: first.state.issueRequestGeneration,
    });
    const second = retryTaskNotesIssue(failed.state);
    if (second.state.kind !== 'issuing') throw new Error('Expected retried issuing state');
    expect(second.state.issueRequestGeneration).toBe(first.state.issueRequestGeneration + 1);

    const late = applyIssueTaskNotesResult(
      second.state,
      {
        editorGeneration: second.state.generation,
        issueRequestGeneration: first.state.issueRequestGeneration,
        taskId: second.state.taskId,
      },
      issued(),
    );
    expect(late).toEqual({ state: second.state, effects: [] });
  });

  it('accepts matching completed truth from an older attempt but ignores stale task-closing', () => {
    const first = transitionToSaving();
    const second = retryPendingTaskNotesUpdate(first.state);
    const staleClosing = applyUpdateTaskNotesResult(second.state, updateTag(second.state, 1), {
      kind: 'task-closing',
      current: current(snapshot(), true),
      replayed: false,
    });
    expect(staleClosing).toEqual({ state: second.state, effects: [] });

    const completed = applyUpdateTaskNotesResult(
      second.state,
      updateTag(second.state, 1),
      savedResult(),
    );
    expect(completed.state).toMatchObject({ kind: 'saved', base: { notes: 'submitted' } });
    expect(completed.effects).toEqual([
      {
        kind: 'acknowledge',
        operation: { operationId: OPERATION_ID, operationCapability: TOKEN },
      },
    ]);
  });

  it('preserves a newer visible draft when an older immutable submission commits', () => {
    const saving = transitionToSaving();
    const typed = editTaskNotesDraft(saving.state, 'typed while saving');
    const completed = applyUpdateTaskNotesResult(
      typed.state,
      updateTag(typed.state),
      savedResult(),
    );
    expect(completed.state).toMatchObject({
      kind: 'dirty',
      draft: 'typed while saving',
      base: { notes: 'submitted', workspaceRevision: 2 },
    });
  });

  it('installs completed truth without current as absorbing and performs no acknowledgement', () => {
    const saving = transitionToSaving();
    const completedWithoutCurrent = applyUpdateTaskNotesResult(
      saving.state,
      updateTag(saving.state),
      {
        kind: 'task-state-unavailable',
        retryAfterMs: 500,
        knownDisposition: {
          kind: 'completed',
          originalOutcome: savedResult().originalOutcome,
          replayed: true,
          effectiveRetireAfter: REPLAY_UNTIL,
        },
      },
    );
    expect(completedWithoutCurrent.state).toMatchObject({
      kind: 'recovering',
      pending: {
        knownDisposition: { kind: 'completed' },
        recovery: { kind: 'awaiting-coherent-current', lookup: 'replay-or-get' },
      },
    });
    expect(completedWithoutCurrent.effects).toEqual([]);

    const ignoredBusy = applyUpdateTaskNotesResult(
      completedWithoutCurrent.state,
      updateTag(completedWithoutCurrent.state),
      { kind: 'recovery-busy', retryAfterMs: 500, effectiveRetireAfter: REPLAY_UNTIL },
    );
    expect(ignoredBusy).toEqual({ state: completedWithoutCurrent.state, effects: [] });
  });

  it('fails closed on conflicting completed facts and acknowledges neither', () => {
    const saving = transitionToSaving();
    const known = applyUpdateTaskNotesResult(saving.state, updateTag(saving.state), {
      kind: 'task-state-unavailable',
      retryAfterMs: 500,
      knownDisposition: {
        kind: 'completed',
        originalOutcome: savedResult().originalOutcome,
        replayed: true,
        effectiveRetireAfter: REPLAY_UNTIL,
      },
    });
    const conflict = applyUpdateTaskNotesResult(known.state, updateTag(known.state), {
      ...savedResult(),
      originalOutcome: {
        kind: 'conflict',
        observedContentVersion: OTHER_TOKEN,
        observedWorkspaceRevision: 2,
      },
    });
    expect(conflict.state).toMatchObject({ kind: 'error', recovery: 'none', pending: {} });
    expect(conflict.effects).toEqual([
      { kind: 'invariant-violation', code: 'conflicting-completed-outcome' },
    ]);
  });

  it('makes expiry loss-preserving and never starts a new Issue automatically', () => {
    const saving = transitionToSaving();
    const expired = applyUpdateTaskNotesResult(saving.state, updateTag(saving.state), {
      kind: 'operation-expired',
      expiredAt: REPLAY_UNTIL,
    });
    expect(expired.state).toMatchObject({
      kind: 'error',
      draft: 'submitted',
      recovery: 'refetch-before-new-issue',
      pending: { recovery: { kind: 'operation-expired' } },
    });
    expect(expired.effects).toEqual([]);
  });

  it('turns expiry after completed truth into a tagged Get-only reconciliation', () => {
    const saving = transitionToSaving();
    const known = applyUpdateTaskNotesResult(saving.state, updateTag(saving.state), {
      kind: 'task-state-unavailable',
      retryAfterMs: 500,
      knownDisposition: {
        kind: 'completed',
        originalOutcome: savedResult().originalOutcome,
        replayed: true,
        effectiveRetireAfter: REPLAY_UNTIL,
      },
    });
    if (!('pending' in known.state) || known.state.pending?.knownDisposition.kind !== 'completed') {
      throw new Error('Expected completed pending truth');
    }
    const truthGeneration = known.state.pending.knownDisposition.truthGeneration;
    const expired = applyUpdateTaskNotesResult(known.state, updateTag(known.state), {
      kind: 'operation-expired',
      expiredAt: REPLAY_UNTIL,
    });
    expect(expired.state).toMatchObject({
      pending: {
        knownDisposition: { kind: 'completed', truthGeneration },
        recovery: { kind: 'awaiting-coherent-current', lookup: 'get-only' },
      },
    });
    expect(expired.effects).toEqual([
      {
        kind: 'get',
        taskId: 'task-1',
        editorGeneration: known.state.generation,
        operationId: OPERATION_ID,
        truthGeneration,
      },
    ]);
  });

  it('retains exact durability and host recovery proposals without changing draft/base', () => {
    const saving = editTaskNotesDraft(transitionToSaving().state, 'newer draft');
    const terminalProposal = applyUpdateTaskNotesResult(saving.state, updateTag(saving.state), {
      kind: 'durability-repair-required',
      replayed: false,
      retention: 'held',
      semanticProposal: 'terminal-outcome',
      proposedOutcome: savedResult().originalOutcome,
    });
    expect(terminalProposal.state).toMatchObject({
      kind: 'securing',
      draft: 'newer draft',
      base: { notes: 'base' },
      pending: {
        submittedText: 'submitted',
        recovery: { kind: 'durability-repair', semanticProposal: 'terminal-outcome' },
      },
    });

    const host = applyUpdateTaskNotesResult(
      terminalProposal.state,
      updateTag(terminalProposal.state),
      { kind: 'host-state-recovery-required', replayed: false, retention: 'held' },
    );
    expect(host.state).toMatchObject({
      kind: 'recovering',
      draft: 'newer draft',
      pending: { recovery: { kind: 'host-state-recovery' } },
    });
  });

  it('preserves dirty/pending state on external changes and orphans on incarnation replacement', () => {
    const saving = editTaskNotesDraft(transitionToSaving().state, 'local draft');
    const external = snapshot({
      notes: 'remote',
      contentVersion: OTHER_TOKEN,
      workspaceRevision: 2,
    });
    const updated = applyTaskNotesExternalSnapshot(saving.state, external);
    expect(updated.state).toMatchObject({
      kind: 'saving',
      draft: 'local draft',
      base: { notes: 'base' },
      external: { notes: 'remote' },
      pending: { submittedText: 'submitted' },
    });

    const replaced = applyTaskNotesExternalSnapshot(
      updated.state,
      snapshot({ taskIncarnation: OTHER_TOKEN }),
    );
    expect(replaced.state).toMatchObject({
      kind: 'orphaned',
      reason: 'task-replaced',
      draft: 'local draft',
      pending: { submittedText: 'submitted' },
    });

    const stale = applyTaskNotesExternalSnapshot(
      updated.state,
      snapshot({ notes: 'older', workspaceRevision: 1 }),
    );
    expect(stale).toEqual({ state: updated.state, effects: [] });
  });

  it('rejects an oversized draft without allocating an Issue identity', () => {
    const opened = openTaskNotes('task-1').state;
    const clean = applyGetTaskNotesResult(
      opened,
      { editorGeneration: opened.generation, taskId: 'task-1' },
      loaded(),
    ).state;
    const overLimit = editTaskNotesDraft(clean, 'x'.repeat(102_401));
    const submitted = submitTaskNotes(overLimit.state);
    expect(submitted.state).toMatchObject({ kind: 'error', recovery: 'none' });
    expect(submitted.effects).toEqual([]);
  });

  it('maps transport loss by phase and ignores stale transport completions', () => {
    const saving = transitionToSaving();
    const stale = applyTaskNotesTransportFailure(saving.state, 'update', {
      editorGeneration: saving.state.generation,
      taskId: saving.state.taskId,
      operationId: OPERATION_ID,
      updateAttemptGeneration: 0,
    });
    expect(stale).toEqual({ state: saving.state, effects: [] });

    const interrupted = applyTaskNotesTransportFailure(saving.state, 'update', {
      ...updateTag(saving.state),
      taskId: saving.state.taskId,
    });
    expect(interrupted.state).toMatchObject({
      kind: 'error',
      recovery: 'retry-same-update',
      pending: { submittedText: 'submitted' },
    });

    const opened = openTaskNotes('task-1').state;
    const loadInterrupted = applyTaskNotesTransportFailure(opened, 'get', {
      editorGeneration: opened.generation,
      taskId: opened.taskId,
    });
    expect(retryTaskNotesGet(loadInterrupted.state).effects).toEqual([
      { kind: 'get', taskId: 'task-1', editorGeneration: opened.generation },
    ]);
  });

  it('makes catalog closing and tombstones loss-preserving and generation-bound', () => {
    const saving = editTaskNotesDraft(transitionToSaving().state, 'newer local draft');
    const closingTask = {
      serverInstanceId: SERVER_INSTANCE_ID,
      catalogVersion: 2,
      taskState: 'present' as const,
      taskClosing: true,
      taskIncarnation: TOKEN,
    };
    const stale = applyTaskNotesLifecycleProjection(
      saving.state,
      { editorGeneration: saving.state.generation - 1, taskId: 'task-1' },
      closingTask,
    );
    expect(stale).toEqual({ state: saving.state, effects: [] });

    const closing = applyTaskNotesLifecycleProjection(
      saving.state,
      { editorGeneration: saving.state.generation, taskId: 'task-1' },
      closingTask,
    );
    expect(closing.state).toMatchObject({
      kind: 'closing',
      draft: 'newer local draft',
      outcome: 'unknown',
      pending: { submittedText: 'submitted' },
    });

    const removed = applyTaskNotesLifecycleProjection(
      closing.state,
      { editorGeneration: closing.state.generation, taskId: 'task-1' },
      {
        serverInstanceId: SERVER_INSTANCE_ID,
        catalogVersion: 3,
        taskState: 'removed',
        taskClosing: false,
      },
    );
    expect(removed.state).toMatchObject({
      kind: 'orphaned',
      reason: 'task-deleted',
      draft: 'newer local draft',
      pending: { submittedText: 'submitted' },
    });
    expect(removed.effects).toEqual([]);

    const opened = openTaskNotes('task-1').state;
    const clean = applyGetTaskNotesResult(
      opened,
      { editorGeneration: opened.generation, taskId: opened.taskId },
      loaded(),
    ).state;
    const cleanRemoved = applyTaskNotesLifecycleProjection(
      clean,
      { editorGeneration: clean.generation, taskId: clean.taskId },
      {
        serverInstanceId: SERVER_INSTANCE_ID,
        catalogVersion: 3,
        taskState: 'removed',
        taskClosing: false,
      },
    );
    expect(cleanRemoved.effects).toEqual([{ kind: 'navigate-task-list', taskId: 'task-1' }]);
  });

  it('applies request errors only to the matching latest phase identity', () => {
    const saving = transitionToSaving();
    const stale = applyTaskNotesRequestError(
      saving.state,
      'update',
      { ...updateTag(saving.state), updateAttemptGeneration: 0 },
      { code: 'operation-identity-rejected' },
    );
    expect(stale).toEqual({ state: saving.state, effects: [] });

    const rejected = applyTaskNotesRequestError(saving.state, 'update', updateTag(saving.state), {
      code: 'operation-identity-rejected',
    });
    expect(rejected.state).toMatchObject({
      kind: 'error',
      recovery: 'refetch-before-new-issue',
      pending: { recovery: { kind: 'operation-identity-rejected' } },
    });
    expect(rejected.effects).toEqual([]);
  });

  it('settles post-truth Get only for the matching truth generation', () => {
    const saving = transitionToSaving();
    const known = applyUpdateTaskNotesResult(saving.state, updateTag(saving.state), {
      kind: 'task-state-unavailable',
      retryAfterMs: 500,
      knownDisposition: {
        kind: 'completed',
        originalOutcome: savedResult().originalOutcome,
        replayed: true,
        effectiveRetireAfter: REPLAY_UNTIL,
      },
    });
    if (!('pending' in known.state) || known.state.pending?.knownDisposition.kind !== 'completed') {
      throw new Error('Expected completed pending truth');
    }
    const truth = known.state.pending.knownDisposition;
    const stale = applyGetTaskNotesResult(
      known.state,
      {
        editorGeneration: known.state.generation,
        taskId: known.state.taskId,
        operationId: OPERATION_ID,
        truthGeneration: truth.truthGeneration + 1,
      },
      loaded(snapshot({ notes: 'submitted', contentVersion: OTHER_TOKEN, workspaceRevision: 2 })),
    );
    expect(stale).toEqual({ state: known.state, effects: [] });

    const settled = applyGetTaskNotesResult(
      known.state,
      {
        editorGeneration: known.state.generation,
        taskId: known.state.taskId,
        operationId: OPERATION_ID,
        truthGeneration: truth.truthGeneration,
      },
      loaded(snapshot({ notes: 'submitted', contentVersion: OTHER_TOKEN, workspaceRevision: 2 })),
    );
    expect(settled.state).toMatchObject({ kind: 'saved', draft: 'submitted' });
    expect(settled.effects[0]).toMatchObject({ kind: 'acknowledge' });
  });

  it('settles post-truth not-found through orphan recovery and acknowledgement', () => {
    const saving = transitionToSaving();
    const known = applyUpdateTaskNotesResult(saving.state, updateTag(saving.state), {
      kind: 'task-state-unavailable',
      retryAfterMs: 500,
      knownDisposition: {
        kind: 'completed',
        originalOutcome: savedResult().originalOutcome,
        replayed: true,
        effectiveRetireAfter: REPLAY_UNTIL,
      },
    });
    if (!('pending' in known.state) || known.state.pending?.knownDisposition.kind !== 'completed') {
      throw new Error('Expected completed pending truth');
    }
    const truth = known.state.pending.knownDisposition;
    const settled = applyGetTaskNotesResult(
      known.state,
      {
        editorGeneration: known.state.generation,
        taskId: known.state.taskId,
        operationId: OPERATION_ID,
        truthGeneration: truth.truthGeneration,
      },
      {
        kind: 'not-found',
        current: {
          relation: 'task-removed',
          currentNotes: { kind: 'unavailable', reason: 'task-removed', workspaceRevision: 3 },
          currentTask: {
            serverInstanceId: SERVER_INSTANCE_ID,
            catalogVersion: 3,
            taskState: 'removed',
            taskClosing: false,
          },
        },
      },
    );
    expect(settled.state).toMatchObject({ kind: 'orphaned', reason: 'task-deleted' });
    expect(settled.effects).toEqual([
      {
        kind: 'acknowledge',
        operation: { operationId: OPERATION_ID, operationCapability: TOKEN },
      },
    ]);
  });
});
