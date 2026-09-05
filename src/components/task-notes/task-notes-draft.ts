import {
  isTaskNotesText,
  isTaskNotesTaskId,
  type AcknowledgedTaskNotesOperation,
  type CurrentTaskLifecycleProjection,
  type GetTaskNotesResult,
  type IssueTaskNotesOperationRequest,
  type IssueTaskNotesOperationResult,
  type IssuedTaskNotesOperation,
  type TaskNotesCurrentEnvelope,
  type TaskNotesOperationOutcome,
  type TaskNotesPostCommitWarning,
  type TaskNotesRequestError,
  type TaskNotesSnapshot,
  type UpdateTaskNotesRequest,
  type UpdateTaskNotesResult,
} from '../../domain/task-notes';

// Keep this module DOM-free. Drivers translate effects into IPC, timers, focus, and navigation.

export type UpdateTaskNotesAttemptGeneration = number;

export type PendingTaskNotesDurabilityProposal =
  | { semanticProposal: 'admission-only'; proposedOutcome?: never }
  | { semanticProposal: 'retry-window-only'; proposedOutcome?: never }
  | { semanticProposal: 'terminal-outcome'; proposedOutcome: TaskNotesOperationOutcome };

export type PendingTaskNotesKnownDisposition =
  | { kind: 'unsettled'; attemptGeneration: UpdateTaskNotesAttemptGeneration }
  | { kind: 'task-closing'; attemptGeneration: UpdateTaskNotesAttemptGeneration }
  | {
      kind: 'completed';
      truthGeneration: number;
      learnedFromAttemptGeneration: UpdateTaskNotesAttemptGeneration;
      originalOutcome: TaskNotesOperationOutcome;
      effectiveRetireAfter: string;
      postCommitWarning?: TaskNotesPostCommitWarning;
    };

export type PendingTaskNotesRecoveryStatus =
  | { kind: 'in-flight-or-unknown'; attemptGeneration: UpdateTaskNotesAttemptGeneration }
  | ({
      kind: 'durability-repair';
      attemptGeneration: UpdateTaskNotesAttemptGeneration;
    } & PendingTaskNotesDurabilityProposal)
  | { kind: 'host-state-recovery'; attemptGeneration: UpdateTaskNotesAttemptGeneration }
  | {
      kind: 'recovery-busy';
      attemptGeneration: UpdateTaskNotesAttemptGeneration;
      retryAfterMs: number;
      effectiveRetireAfter: string;
    }
  | {
      kind: 'task-state-unavailable';
      attemptGeneration: UpdateTaskNotesAttemptGeneration;
      retryAfterMs: number;
    }
  | {
      kind: 'operation-expired';
      attemptGeneration: UpdateTaskNotesAttemptGeneration;
      expiredAt: string;
    }
  | {
      kind: 'operation-identity-rejected';
      attemptGeneration: UpdateTaskNotesAttemptGeneration;
    }
  | {
      kind: 'awaiting-coherent-current';
      attemptGeneration: UpdateTaskNotesAttemptGeneration;
      lookup: 'replay-or-get' | 'get-only';
    };

export type IssueTaskNotesClientStatus =
  | { kind: 'requesting' }
  | {
      kind: 'durability-repair';
      reservation: 'withheld';
      acknowledgementReclamation: 'unknown';
    }
  | {
      kind: 'host-state-recovery';
      reservation: 'withheld';
      acknowledgementReclamation: 'unknown';
    };

export interface PendingTaskNotesSubmission {
  taskId: string;
  taskIncarnation: string;
  baseContentVersion: string;
  submittedText: string;
  operation: IssuedTaskNotesOperation;
  latestUpdateAttemptGeneration: UpdateTaskNotesAttemptGeneration;
  knownDisposition: PendingTaskNotesKnownDisposition;
  recovery: PendingTaskNotesRecoveryStatus;
}

export type TaskNotesErrorRecovery =
  | 'retry-load'
  | 'retry-issue'
  | 'retry-same-update'
  | 'refetch-before-new-issue'
  | 'reauthenticate'
  | 'none';

export type TaskNotesErrorReason =
  | 'operation-counter-exhausted'
  | 'editor-generation-exhausted'
  | 'notes-unavailable'
  | 'invalid-draft'
  | 'task-unavailable'
  | 'terminal-facts-conflict'
  | 'save-identity-expired'
  | 'request-failed'
  | 'transport-interrupted';

type TaskNotesErrorDetail =
  | { reason: 'request-failed'; requestCode: TaskNotesRequestError['code'] }
  | {
      reason: Exclude<TaskNotesErrorReason, 'request-failed'>;
      requestCode?: never;
    };

interface TaskNotesStateBase {
  generation: number;
  taskId: string;
}

interface TaskNotesEditableStateBase extends TaskNotesStateBase {
  base: TaskNotesSnapshot;
  draft: string;
  external?: TaskNotesSnapshot;
}

export type TaskNotesEditorState =
  | (TaskNotesStateBase & { kind: 'loading'; draft: '' })
  | (TaskNotesEditableStateBase & { kind: 'clean' })
  | (TaskNotesEditableStateBase & { kind: 'dirty' })
  | (TaskNotesEditableStateBase & {
      kind: 'issuing';
      issueRequestGeneration: number;
      issueStatus: IssueTaskNotesClientStatus;
      submittedText: string;
    })
  | (TaskNotesEditableStateBase & { kind: 'saving'; pending: PendingTaskNotesSubmission })
  | (TaskNotesEditableStateBase & { kind: 'securing'; pending: PendingTaskNotesSubmission })
  | (TaskNotesEditableStateBase & { kind: 'recovering'; pending: PendingTaskNotesSubmission })
  | (TaskNotesEditableStateBase & {
      kind: 'saved';
      savedNoticeGeneration: number;
      postCommitWarning?: TaskNotesPostCommitWarning;
    })
  | (TaskNotesEditableStateBase & {
      kind: 'conflict';
      current: TaskNotesSnapshot;
      postCommitWarning?: TaskNotesPostCommitWarning;
    })
  | (TaskNotesStateBase &
      TaskNotesErrorDetail & {
        kind: 'error';
        base?: TaskNotesSnapshot;
        draft: string;
        external?: TaskNotesSnapshot;
        pending?: PendingTaskNotesSubmission;
        issueRequestGeneration?: number;
        recovery: TaskNotesErrorRecovery;
      })
  | (TaskNotesStateBase & {
      kind: 'closing';
      base?: TaskNotesSnapshot;
      draft: string;
      external?: TaskNotesSnapshot;
      currentTask: Extract<CurrentTaskLifecycleProjection, { taskState: 'present' }>;
      outcome: 'dirty' | 'saved' | 'conflict' | 'unknown';
      pending?: PendingTaskNotesSubmission;
      postCommitWarning?: TaskNotesPostCommitWarning;
    })
  | (TaskNotesStateBase & {
      kind: 'orphaned';
      base?: TaskNotesSnapshot;
      draft: string;
      external?: TaskNotesSnapshot;
      reason: 'task-deleted' | 'task-replaced' | 'task-no-longer-visible';
      outcome: 'dirty' | 'saved' | 'conflict' | 'unknown';
      pending?: PendingTaskNotesSubmission;
      postCommitWarning?: TaskNotesPostCommitWarning;
    });

export type TaskNotesReducerEffect =
  | {
      kind: 'get';
      taskId: string;
      editorGeneration: number;
      truthGeneration?: number;
      operationId?: string;
    }
  | {
      kind: 'issue';
      editorGeneration: number;
      issueRequestGeneration: number;
      request: IssueTaskNotesOperationRequest;
    }
  | {
      kind: 'update';
      editorGeneration: number;
      updateAttemptGeneration: number;
      request: UpdateTaskNotesRequest;
    }
  | { kind: 'acknowledge'; operation: AcknowledgedTaskNotesOperation }
  | { kind: 'navigate-task-list'; taskId: string }
  | {
      kind: 'invariant-violation';
      code: 'conflicting-completed-outcome' | 'generation-exhausted';
    };

export interface TaskNotesTransition {
  state: TaskNotesEditorState;
  effects: TaskNotesReducerEffect[];
}

export interface TaskNotesIssueCompletionTag {
  editorGeneration: number;
  issueRequestGeneration: number;
  taskId: string;
}

export interface TaskNotesUpdateCompletionTag {
  editorGeneration: number;
  operationId: string;
  updateAttemptGeneration: number;
}

function unchanged(state: TaskNotesEditorState): TaskNotesTransition {
  return { state, effects: [] };
}

export function incrementTaskNotesGeneration(current: number): number | null {
  return Number.isSafeInteger(current) && current >= 0 && current < Number.MAX_SAFE_INTEGER
    ? current + 1
    : null;
}

function generationFailure(state: TaskNotesEditorState): TaskNotesTransition {
  return {
    state: {
      kind: 'error',
      generation: state.generation,
      taskId: state.taskId,
      draft: state.draft,
      ...('base' in state && state.base ? { base: state.base } : {}),
      ...('external' in state && state.external ? { external: state.external } : {}),
      ...('pending' in state && state.pending ? { pending: state.pending } : {}),
      ...(state.kind === 'error' && state.issueRequestGeneration !== undefined
        ? { issueRequestGeneration: state.issueRequestGeneration }
        : {}),
      recovery: 'none',
      reason: 'operation-counter-exhausted',
    },
    effects: [{ kind: 'invariant-violation', code: 'generation-exhausted' }],
  };
}

export function openTaskNotes(taskId: string, previousGeneration = 0): TaskNotesTransition {
  if (!isTaskNotesTaskId(taskId)) {
    throw new TypeError('Invalid task ID');
  }
  const generation = incrementTaskNotesGeneration(previousGeneration);
  if (generation === null) {
    const state: TaskNotesEditorState = {
      kind: 'error',
      generation: previousGeneration,
      taskId,
      draft: '',
      recovery: 'none',
      reason: 'editor-generation-exhausted',
    };
    return {
      state,
      effects: [{ kind: 'invariant-violation', code: 'generation-exhausted' }],
    };
  }
  return {
    state: { kind: 'loading', generation, taskId, draft: '' },
    effects: [{ kind: 'get', taskId, editorGeneration: generation }],
  };
}

function getPending(state: TaskNotesEditorState): PendingTaskNotesSubmission | undefined {
  return 'pending' in state ? state.pending : undefined;
}

function getExternal(state: TaskNotesEditorState): TaskNotesSnapshot | undefined {
  return 'external' in state ? state.external : undefined;
}

function createUpdateRequest(pending: PendingTaskNotesSubmission): UpdateTaskNotesRequest {
  return {
    taskId: pending.taskId,
    taskIncarnation: pending.taskIncarnation,
    notes: pending.submittedText,
    baseContentVersion: pending.baseContentVersion,
    operationId: pending.operation.operationId,
    operationCapability: pending.operation.operationCapability,
  };
}

function createUpdateEffect(
  state: TaskNotesEditorState,
  pending: PendingTaskNotesSubmission,
): TaskNotesReducerEffect {
  return {
    kind: 'update',
    editorGeneration: state.generation,
    updateAttemptGeneration: pending.latestUpdateAttemptGeneration,
    request: createUpdateRequest(pending),
  };
}

function setPendingPhase(
  state: TaskNotesEditorState,
  pending: PendingTaskNotesSubmission,
  phase: 'recovering' | 'saving' | 'securing',
): TaskNotesEditorState {
  if (state.kind === 'closing' || state.kind === 'orphaned') {
    return { ...state, pending };
  }
  if (state.kind === 'error' && (!state.base || phase === 'recovering')) {
    return { ...state, pending };
  }
  if (!('base' in state) || !state.base) return state;
  const external = getExternal(state);
  return {
    kind: phase,
    generation: state.generation,
    taskId: state.taskId,
    base: state.base,
    draft: state.draft,
    ...(external ? { external } : {}),
    pending,
  };
}

export function editTaskNotesDraft(
  state: TaskNotesEditorState,
  draft: string,
): TaskNotesTransition {
  if (state.kind === 'loading') return unchanged(state);
  if (state.kind === 'clean' || state.kind === 'dirty' || state.kind === 'saved') {
    return {
      state: {
        kind: draft === state.base.notes ? 'clean' : 'dirty',
        generation: state.generation,
        taskId: state.taskId,
        base: state.base,
        draft,
        ...(state.external ? { external: state.external } : {}),
      },
      effects: [],
    };
  }
  return { state: { ...state, draft }, effects: [] };
}

function orphanFromGet(
  state: TaskNotesEditorState,
  reason: 'task-deleted' | 'task-no-longer-visible' | 'task-replaced',
): TaskNotesTransition {
  const base = 'base' in state ? state.base : undefined;
  const external = getExternal(state);
  const pending = getPending(state);
  return {
    state: {
      kind: 'orphaned',
      generation: state.generation,
      taskId: state.taskId,
      ...(base ? { base } : {}),
      draft: state.draft,
      reason,
      outcome: pending ? 'unknown' : state.draft.length > 0 ? 'dirty' : 'saved',
      ...(external ? { external } : {}),
      ...(pending ? { pending } : {}),
    },
    effects: [],
  };
}

export function applyGetTaskNotesResult(
  state: TaskNotesEditorState,
  tag: {
    editorGeneration: number;
    taskId: string;
    truthGeneration?: number;
    operationId?: string;
  },
  result: GetTaskNotesResult,
): TaskNotesTransition {
  if (tag.editorGeneration !== state.generation || tag.taskId !== state.taskId) {
    return unchanged(state);
  }
  const pending = getPending(state);
  const known = pending?.knownDisposition;
  if (pending && known?.kind === 'completed') {
    if (
      tag.truthGeneration !== known.truthGeneration ||
      tag.operationId !== pending.operation.operationId
    ) {
      return unchanged(state);
    }
    if (result.kind === 'task-state-unavailable') return unchanged(state);
    return settleCompleted(state, pending, known, result.current);
  }
  if (result.kind === 'task-state-unavailable') {
    const base = 'base' in state ? state.base : undefined;
    const currentPending = getPending(state);
    return {
      state: {
        kind: 'error',
        generation: state.generation,
        taskId: state.taskId,
        ...(base ? { base } : {}),
        draft: state.draft,
        ...(currentPending ? { pending: currentPending } : {}),
        recovery: 'retry-load',
        reason: 'notes-unavailable',
      },
      effects: [],
    };
  }
  if (result.kind === 'not-found') return orphanFromGet(state, 'task-deleted');
  if (result.kind === 'not-visible') return orphanFromGet(state, 'task-no-longer-visible');

  const current = result.current.currentNotes.snapshot;
  if (result.current.currentTask.taskClosing) {
    const external = getExternal(state);
    const currentPending = getPending(state);
    return {
      state: {
        kind: 'closing',
        generation: state.generation,
        taskId: state.taskId,
        base: current,
        draft: state.kind === 'loading' ? current.notes : state.draft,
        currentTask: result.current.currentTask,
        outcome: state.kind === 'loading' ? 'unknown' : taskNotesOutcome(state),
        ...(external ? { external } : {}),
        ...(currentPending ? { pending: currentPending } : {}),
      },
      effects: [],
    };
  }
  if (pending && !(state.kind === 'error' && state.recovery === 'refetch-before-new-issue')) {
    return applyTaskNotesExternalSnapshot(state, current);
  }
  if (state.kind === 'error' && state.recovery === 'retry-load' && state.base) {
    return applyTaskNotesExternalSnapshot(
      {
        kind: state.draft === state.base.notes ? 'clean' : 'dirty',
        generation: state.generation,
        taskId: state.taskId,
        base: state.base,
        draft: state.draft,
        ...(state.external ? { external: state.external } : {}),
      },
      current,
    );
  }
  if (state.kind !== 'loading') {
    const greatestKnownRevision = Math.max(
      'base' in state && state.base ? state.base.workspaceRevision : -1,
      getExternal(state)?.workspaceRevision ?? -1,
      state.kind === 'conflict' ? state.current.workspaceRevision : -1,
    );
    if (current.workspaceRevision < greatestKnownRevision) return unchanged(state);
    if ('base' in state && state.base?.taskIncarnation !== current.taskIncarnation) {
      return orphanFromGet(state, 'task-replaced');
    }
    return editTaskNotesDraft(
      {
        kind: state.draft === current.notes ? 'clean' : 'dirty',
        generation: state.generation,
        taskId: state.taskId,
        base: current,
        draft: state.draft,
      },
      state.draft,
    );
  }
  return {
    state: {
      kind: 'clean',
      generation: state.generation,
      taskId: state.taskId,
      base: current,
      draft: current.notes,
    },
    effects: [],
  };
}

function buildIssueRequest(
  state: Extract<TaskNotesEditorState, { kind: 'dirty' | 'error' | 'issuing' }>,
  acknowledgedOperations: AcknowledgedTaskNotesOperation[],
): IssueTaskNotesOperationRequest | null {
  if (!state.base || state.base.taskId !== state.taskId) return null;
  return {
    taskId: state.taskId,
    taskIncarnation: state.base.taskIncarnation,
    ...(acknowledgedOperations.length > 0 ? { acknowledgedOperations } : {}),
  };
}

export function submitTaskNotes(
  state: TaskNotesEditorState,
  acknowledgedOperations: AcknowledgedTaskNotesOperation[] = [],
): TaskNotesTransition {
  if (state.kind !== 'dirty') return unchanged(state);
  if (!isTaskNotesText(state.draft)) {
    return {
      state: {
        kind: 'error',
        generation: state.generation,
        taskId: state.taskId,
        base: state.base,
        draft: state.draft,
        recovery: 'none',
        reason: 'invalid-draft',
      },
      effects: [],
    };
  }
  const issueRequestGeneration = incrementTaskNotesGeneration(0);
  if (issueRequestGeneration === null) return generationFailure(state);
  const request = buildIssueRequest(state, acknowledgedOperations);
  if (!request) return unchanged(state);
  return {
    state: {
      ...state,
      kind: 'issuing',
      issueRequestGeneration,
      issueStatus: { kind: 'requesting' },
      submittedText: state.draft,
    },
    effects: [
      {
        kind: 'issue',
        editorGeneration: state.generation,
        issueRequestGeneration,
        request,
      },
    ],
  };
}

export function retryTaskNotesIssue(
  state: TaskNotesEditorState,
  acknowledgedOperations: AcknowledgedTaskNotesOperation[] = [],
): TaskNotesTransition {
  if (
    state.kind !== 'issuing' &&
    !(
      state.kind === 'error' &&
      (state.recovery === 'retry-issue' ||
        (state.recovery === 'reauthenticate' && state.issueRequestGeneration !== undefined))
    )
  ) {
    return unchanged(state);
  }
  if (!state.base) return unchanged(state);
  const previousGeneration =
    state.kind === 'issuing' ? state.issueRequestGeneration : (state.issueRequestGeneration ?? 0);
  const issueRequestGeneration = incrementTaskNotesGeneration(previousGeneration);
  if (issueRequestGeneration === null) return generationFailure(state);
  const external = getExternal(state);
  const issuingState: Extract<TaskNotesEditorState, { kind: 'issuing' }> = {
    kind: 'issuing',
    generation: state.generation,
    taskId: state.taskId,
    base: state.base,
    draft: state.draft,
    ...(external ? { external } : {}),
    issueRequestGeneration,
    issueStatus: { kind: 'requesting' },
    submittedText: state.draft,
  };
  const request = buildIssueRequest(issuingState, acknowledgedOperations);
  return request
    ? {
        state: issuingState,
        effects: [
          {
            kind: 'issue',
            editorGeneration: state.generation,
            issueRequestGeneration,
            request,
          },
        ],
      }
    : unchanged(state);
}

export function retryTaskNotesGet(state: TaskNotesEditorState): TaskNotesTransition {
  if (
    state.kind !== 'error' ||
    (state.recovery !== 'retry-load' &&
      !(state.recovery === 'reauthenticate' && !state.pending && !state.issueRequestGeneration))
  ) {
    return unchanged(state);
  }
  return {
    state,
    effects: [
      {
        kind: 'get',
        taskId: state.taskId,
        editorGeneration: state.generation,
      },
    ],
  };
}

export function refetchTaskNotesBeforeNewIssue(state: TaskNotesEditorState): TaskNotesTransition {
  if (state.kind !== 'error' || state.recovery !== 'refetch-before-new-issue') {
    return unchanged(state);
  }
  const pending = state.pending;
  const known = pending?.knownDisposition;
  return {
    state,
    effects: [
      {
        kind: 'get',
        taskId: state.taskId,
        editorGeneration: state.generation,
        ...(pending && known?.kind === 'completed'
          ? {
              operationId: pending.operation.operationId,
              truthGeneration: known.truthGeneration,
            }
          : {}),
      },
    ],
  };
}

export function applyIssueTaskNotesResult(
  state: TaskNotesEditorState,
  tag: TaskNotesIssueCompletionTag,
  result: IssueTaskNotesOperationResult,
): TaskNotesTransition {
  if (
    state.kind !== 'issuing' ||
    tag.editorGeneration !== state.generation ||
    tag.taskId !== state.taskId ||
    tag.issueRequestGeneration !== state.issueRequestGeneration
  ) {
    return unchanged(state);
  }
  if (result.kind === 'issued') {
    const attemptGeneration = 1;
    const pending: PendingTaskNotesSubmission = {
      taskId: state.taskId,
      taskIncarnation: state.base.taskIncarnation,
      baseContentVersion: state.base.contentVersion,
      submittedText: state.submittedText,
      operation: result.operation,
      latestUpdateAttemptGeneration: attemptGeneration,
      knownDisposition: { kind: 'unsettled', attemptGeneration },
      recovery: { kind: 'in-flight-or-unknown', attemptGeneration },
    };
    const nextState = setPendingPhase(state, pending, 'saving');
    return { state: nextState, effects: [createUpdateEffect(nextState, pending)] };
  }
  if (result.kind === 'durability-repair-required') {
    return {
      state: {
        ...state,
        issueStatus: {
          kind: 'durability-repair',
          reservation: result.reservation,
          acknowledgementReclamation: result.acknowledgementReclamation,
        },
      },
      effects: [],
    };
  }
  if (result.kind === 'host-state-recovery-required') {
    return {
      state: {
        ...state,
        issueStatus: {
          kind: 'host-state-recovery',
          reservation: result.reservation,
          acknowledgementReclamation: result.acknowledgementReclamation,
        },
      },
      effects: [],
    };
  }
  if (result.kind === 'not-found') return orphanFromGet(state, 'task-deleted');
  if (result.kind === 'not-visible') return orphanFromGet(state, 'task-no-longer-visible');
  if (result.kind === 'task-incarnation-changed') return orphanFromGet(state, 'task-replaced');
  return {
    state: {
      kind: 'error',
      generation: state.generation,
      taskId: state.taskId,
      base: state.base,
      draft: state.draft,
      issueRequestGeneration: state.issueRequestGeneration,
      recovery: 'retry-issue',
      reason: 'task-unavailable',
    },
    effects: [],
  };
}

function outcomesEqual(left: TaskNotesOperationOutcome, right: TaskNotesOperationOutcome): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'saved':
      return (
        right.kind === 'saved' &&
        left.changed === right.changed &&
        left.committedContentVersion === right.committedContentVersion &&
        left.committedWorkspaceRevision === right.committedWorkspaceRevision
      );
    case 'conflict':
      return (
        right.kind === 'conflict' &&
        left.observedContentVersion === right.observedContentVersion &&
        left.observedWorkspaceRevision === right.observedWorkspaceRevision
      );
    case 'task-incarnation-changed':
      return (
        right.kind === 'task-incarnation-changed' &&
        left.observedWorkspaceRevision === right.observedWorkspaceRevision
      );
  }
}

function mergeCompletedTruth(
  pending: PendingTaskNotesSubmission,
  attemptGeneration: number,
  completion: {
    originalOutcome: TaskNotesOperationOutcome;
    effectiveRetireAfter: string;
    postCommitWarning?: TaskNotesPostCommitWarning;
  },
): { pending: PendingTaskNotesSubmission; conflict: boolean } | null {
  const known = pending.knownDisposition;
  if (known.kind === 'completed') {
    if (!outcomesEqual(known.originalOutcome, completion.originalOutcome)) {
      return { pending, conflict: true };
    }
    return {
      pending: {
        ...pending,
        knownDisposition: {
          ...known,
          effectiveRetireAfter:
            known.effectiveRetireAfter >= completion.effectiveRetireAfter
              ? known.effectiveRetireAfter
              : completion.effectiveRetireAfter,
          ...(known.postCommitWarning || completion.postCommitWarning
            ? {
                postCommitWarning: known.postCommitWarning ?? completion.postCommitWarning,
              }
            : {}),
        },
      },
      conflict: false,
    };
  }
  const truthGeneration = incrementTaskNotesGeneration(0);
  if (truthGeneration === null) return null;
  return {
    pending: {
      ...pending,
      knownDisposition: {
        kind: 'completed',
        truthGeneration,
        learnedFromAttemptGeneration: attemptGeneration,
        originalOutcome: completion.originalOutcome,
        effectiveRetireAfter: completion.effectiveRetireAfter,
        ...(completion.postCommitWarning
          ? { postCommitWarning: completion.postCommitWarning }
          : {}),
      },
    },
    conflict: false,
  };
}

function invariantConflict(
  state: TaskNotesEditorState,
  pending: PendingTaskNotesSubmission,
): TaskNotesTransition {
  return {
    state: {
      kind: 'error',
      generation: state.generation,
      taskId: state.taskId,
      ...('base' in state && state.base ? { base: state.base } : {}),
      draft: state.draft,
      pending,
      recovery: 'none',
      reason: 'terminal-facts-conflict',
    },
    effects: [{ kind: 'invariant-violation', code: 'conflicting-completed-outcome' }],
  };
}

function settleCompleted(
  state: TaskNotesEditorState,
  pending: PendingTaskNotesSubmission,
  known: Extract<PendingTaskNotesKnownDisposition, { kind: 'completed' }>,
  current: TaskNotesCurrentEnvelope,
): TaskNotesTransition {
  const acknowledgement: TaskNotesReducerEffect = {
    kind: 'acknowledge',
    operation: {
      operationId: pending.operation.operationId,
      operationCapability: pending.operation.operationCapability,
    },
  };
  const common = {
    generation: state.generation,
    taskId: state.taskId,
    ...('base' in state && state.base ? { base: state.base } : {}),
    draft: state.draft,
    ...(known.postCommitWarning ? { postCommitWarning: known.postCommitWarning } : {}),
  };
  if (
    known.originalOutcome.kind === 'task-incarnation-changed' ||
    current.relation === 'task-replaced'
  ) {
    return {
      state: { ...common, kind: 'orphaned', reason: 'task-replaced', outcome: 'unknown' },
      effects: [acknowledgement],
    };
  }
  if (current.relation === 'task-removed' || current.relation === 'task-not-visible') {
    return {
      state: {
        ...common,
        kind: 'orphaned',
        reason: current.relation === 'task-removed' ? 'task-deleted' : 'task-no-longer-visible',
        outcome: known.originalOutcome.kind === 'saved' ? 'saved' : 'conflict',
      },
      effects: [acknowledgement],
    };
  }

  const responseSnapshot = current.currentNotes.snapshot;
  const external = getExternal(state);
  const currentSnapshot = [
    responseSnapshot,
    ...('base' in state && state.base ? [state.base] : []),
    ...(external ? [external] : []),
  ].reduce((greatest, candidate) =>
    candidate.taskIncarnation === responseSnapshot.taskIncarnation &&
    candidate.workspaceRevision > greatest.workspaceRevision
      ? candidate
      : greatest,
  );
  if (current.currentTask.taskClosing) {
    return {
      state: {
        ...common,
        kind: 'closing',
        base: currentSnapshot,
        currentTask: current.currentTask,
        outcome: known.originalOutcome.kind === 'saved' ? 'saved' : 'conflict',
      },
      effects: [acknowledgement],
    };
  }
  if (known.originalOutcome.kind === 'conflict') {
    return {
      state: {
        kind: 'conflict',
        generation: state.generation,
        taskId: state.taskId,
        base: 'base' in state && state.base ? state.base : currentSnapshot,
        draft: state.draft,
        current: currentSnapshot,
        ...(known.postCommitWarning ? { postCommitWarning: known.postCommitWarning } : {}),
      },
      effects: [acknowledgement],
    };
  }
  return {
    state:
      state.draft === currentSnapshot.notes
        ? {
            kind: 'saved',
            generation: state.generation,
            taskId: state.taskId,
            base: currentSnapshot,
            draft: state.draft,
            savedNoticeGeneration: known.truthGeneration,
            ...(known.postCommitWarning ? { postCommitWarning: known.postCommitWarning } : {}),
          }
        : {
            kind: 'dirty',
            generation: state.generation,
            taskId: state.taskId,
            base: currentSnapshot,
            draft: state.draft,
          },
    effects: [acknowledgement],
  };
}

export function retryPendingTaskNotesUpdate(state: TaskNotesEditorState): TaskNotesTransition {
  const pending = getPending(state);
  if (!pending) return unchanged(state);
  const known = pending.knownDisposition;
  if (known.kind === 'task-closing') {
    return {
      state,
      effects: [{ kind: 'get', taskId: state.taskId, editorGeneration: state.generation }],
    };
  }
  if (
    known.kind === 'completed' &&
    pending.recovery.kind === 'awaiting-coherent-current' &&
    pending.recovery.lookup === 'get-only'
  ) {
    return {
      state,
      effects: [
        {
          kind: 'get',
          taskId: state.taskId,
          editorGeneration: state.generation,
          operationId: pending.operation.operationId,
          truthGeneration: known.truthGeneration,
        },
      ],
    };
  }
  const nextAttempt = incrementTaskNotesGeneration(pending.latestUpdateAttemptGeneration);
  if (nextAttempt === null) return generationFailure(state);
  const nextPending: PendingTaskNotesSubmission = {
    ...pending,
    latestUpdateAttemptGeneration: nextAttempt,
    ...(known.kind === 'completed'
      ? {}
      : { knownDisposition: { kind: 'unsettled', attemptGeneration: nextAttempt } as const }),
    recovery: { kind: 'in-flight-or-unknown', attemptGeneration: nextAttempt },
  };
  const nextState = setPendingPhase(state, nextPending, 'saving');
  return { state: nextState, effects: [createUpdateEffect(nextState, nextPending)] };
}

function getLatestTaskNotesSnapshot(state: TaskNotesEditorState): TaskNotesSnapshot | undefined {
  const conflict = state.kind === 'conflict' ? state.current : undefined;
  const external = getExternal(state);
  if (!conflict) return external;
  if (!external) return conflict;
  return external.workspaceRevision > conflict.workspaceRevision ? external : conflict;
}

export function useLatestTaskNotesSnapshot(state: TaskNotesEditorState): TaskNotesTransition {
  const current = getLatestTaskNotesSnapshot(state);
  if (!current) return unchanged(state);
  return {
    state: {
      kind: 'clean',
      generation: state.generation,
      taskId: state.taskId,
      base: current,
      draft: current.notes,
    },
    effects: [],
  };
}

export function overwriteTaskNotesWithLatestBase(
  state: TaskNotesEditorState,
  acknowledgedOperations: AcknowledgedTaskNotesOperation[] = [],
): TaskNotesTransition {
  const current = getLatestTaskNotesSnapshot(state);
  if (!current) return unchanged(state);
  return submitTaskNotes(
    {
      kind: 'dirty',
      generation: state.generation,
      taskId: state.taskId,
      base: current,
      draft: state.draft,
    },
    acknowledgedOperations,
  );
}

function isMatchingUpdate(
  state: TaskNotesEditorState,
  tag: TaskNotesUpdateCompletionTag,
): PendingTaskNotesSubmission | undefined {
  const pending = getPending(state);
  return pending &&
    tag.editorGeneration === state.generation &&
    tag.operationId === pending.operation.operationId
    ? pending
    : undefined;
}

export function applyUpdateTaskNotesResult(
  state: TaskNotesEditorState,
  tag: TaskNotesUpdateCompletionTag,
  result: UpdateTaskNotesResult,
): TaskNotesTransition {
  const pending = isMatchingUpdate(state, tag);
  if (!pending) return unchanged(state);
  const isLatest = tag.updateAttemptGeneration === pending.latestUpdateAttemptGeneration;

  if (result.kind === 'completed') {
    const merged = mergeCompletedTruth(pending, tag.updateAttemptGeneration, result);
    if (!merged) return generationFailure(state);
    if (merged.conflict) return invariantConflict(state, pending);
    const known = merged.pending.knownDisposition;
    return known.kind === 'completed'
      ? settleCompleted(state, merged.pending, known, result.current)
      : unchanged(state);
  }

  if (result.kind === 'task-state-unavailable' && result.knownDisposition.kind === 'completed') {
    const merged = mergeCompletedTruth(
      pending,
      tag.updateAttemptGeneration,
      result.knownDisposition,
    );
    if (!merged) return generationFailure(state);
    if (merged.conflict) return invariantConflict(state, pending);
    const nextPending: PendingTaskNotesSubmission = {
      ...merged.pending,
      recovery: {
        kind: 'awaiting-coherent-current',
        attemptGeneration: tag.updateAttemptGeneration,
        lookup: 'replay-or-get',
      },
    };
    return { state: setPendingPhase(state, nextPending, 'recovering'), effects: [] };
  }

  if (
    isLatest &&
    pending.knownDisposition.kind === 'completed' &&
    result.kind === 'operation-expired'
  ) {
    const known = pending.knownDisposition;
    const nextPending: PendingTaskNotesSubmission = {
      ...pending,
      recovery: {
        kind: 'awaiting-coherent-current',
        attemptGeneration: tag.updateAttemptGeneration,
        lookup: 'get-only',
      },
    };
    const nextState = setPendingPhase(state, nextPending, 'recovering');
    return {
      state: nextState,
      effects: [
        {
          kind: 'get',
          taskId: state.taskId,
          editorGeneration: state.generation,
          operationId: pending.operation.operationId,
          truthGeneration: known.truthGeneration,
        },
      ],
    };
  }

  if (!isLatest || pending.knownDisposition.kind === 'completed') return unchanged(state);
  if (result.kind === 'task-closing') {
    const nextPending: PendingTaskNotesSubmission = {
      ...pending,
      knownDisposition: { kind: 'task-closing', attemptGeneration: tag.updateAttemptGeneration },
      recovery: {
        kind: 'awaiting-coherent-current',
        attemptGeneration: tag.updateAttemptGeneration,
        lookup: 'get-only',
      },
    };
    if (result.current.relation === 'same-incarnation') {
      return {
        state: {
          kind: 'closing',
          generation: state.generation,
          taskId: state.taskId,
          ...('base' in state && state.base ? { base: state.base } : {}),
          draft: state.draft,
          currentTask: result.current.currentTask,
          outcome: 'unknown',
          pending: nextPending,
        },
        effects: [],
      };
    }
    return {
      ...orphanFromGet(
        { ...state, pending: nextPending } as TaskNotesEditorState,
        result.current.relation === 'task-replaced'
          ? 'task-replaced'
          : result.current.relation === 'task-removed'
            ? 'task-deleted'
            : 'task-no-longer-visible',
      ),
    };
  }
  if (result.kind === 'operation-expired') {
    const nextPending = {
      ...pending,
      recovery: {
        kind: 'operation-expired',
        attemptGeneration: tag.updateAttemptGeneration,
        expiredAt: result.expiredAt,
      } as const,
    };
    return {
      state: {
        kind: 'error',
        generation: state.generation,
        taskId: state.taskId,
        ...('base' in state && state.base ? { base: state.base } : {}),
        draft: state.draft,
        pending: nextPending,
        recovery: 'refetch-before-new-issue',
        reason: 'save-identity-expired',
      },
      effects: [],
    };
  }
  if (result.kind === 'recovery-busy') {
    const nextPending: PendingTaskNotesSubmission = {
      ...pending,
      recovery: {
        kind: 'recovery-busy',
        attemptGeneration: tag.updateAttemptGeneration,
        retryAfterMs: result.retryAfterMs,
        effectiveRetireAfter: result.effectiveRetireAfter,
      },
    };
    return { state: setPendingPhase(state, nextPending, 'recovering'), effects: [] };
  }
  if (result.kind === 'task-state-unavailable') {
    const closing = result.knownDisposition.kind === 'task-closing';
    const nextPending: PendingTaskNotesSubmission = {
      ...pending,
      knownDisposition: closing
        ? { kind: 'task-closing', attemptGeneration: tag.updateAttemptGeneration }
        : { kind: 'unsettled', attemptGeneration: tag.updateAttemptGeneration },
      recovery: {
        kind: 'task-state-unavailable',
        attemptGeneration: tag.updateAttemptGeneration,
        retryAfterMs: result.retryAfterMs,
      },
    };
    return { state: setPendingPhase(state, nextPending, 'recovering'), effects: [] };
  }
  if (result.kind === 'durability-repair-required') {
    const proposal: PendingTaskNotesDurabilityProposal =
      result.semanticProposal === 'terminal-outcome'
        ? { semanticProposal: result.semanticProposal, proposedOutcome: result.proposedOutcome }
        : { semanticProposal: result.semanticProposal };
    const nextPending: PendingTaskNotesSubmission = {
      ...pending,
      recovery: {
        kind: 'durability-repair',
        attemptGeneration: tag.updateAttemptGeneration,
        ...proposal,
      },
    };
    return { state: setPendingPhase(state, nextPending, 'securing'), effects: [] };
  }
  const nextPending: PendingTaskNotesSubmission = {
    ...pending,
    recovery: {
      kind: 'host-state-recovery',
      attemptGeneration: tag.updateAttemptGeneration,
    },
  };
  return { state: setPendingPhase(state, nextPending, 'recovering'), effects: [] };
}

function getRequestErrorRecovery(
  phase: 'get' | 'issue' | 'update',
  error: TaskNotesRequestError,
): TaskNotesErrorRecovery {
  if (error.code === 'unauthenticated') return 'reauthenticate';
  if (error.code === 'forbidden') return 'none';
  if (error.code === 'operation-identity-rejected') {
    return phase === 'update' ? 'refetch-before-new-issue' : 'none';
  }
  if (error.code === 'rate-limited' || error.code === 'capacity-exhausted') {
    return phase === 'get' ? 'retry-load' : phase === 'issue' ? 'retry-issue' : 'retry-same-update';
  }
  if (
    (error.code === 'persistence-unavailable' || error.code === 'internal-error') &&
    error.retryable
  ) {
    return phase === 'get' ? 'retry-load' : phase === 'issue' ? 'retry-issue' : 'retry-same-update';
  }
  return 'none';
}

export function applyTaskNotesRequestError(
  state: TaskNotesEditorState,
  phase: 'get' | 'issue' | 'update',
  tag: {
    editorGeneration: number;
    issueRequestGeneration?: number;
    operationId?: string;
    updateAttemptGeneration?: number;
  },
  error: TaskNotesRequestError,
): TaskNotesTransition {
  if (tag.editorGeneration !== state.generation) return unchanged(state);
  if (
    phase === 'issue' &&
    (state.kind !== 'issuing' || tag.issueRequestGeneration !== state.issueRequestGeneration)
  ) {
    return unchanged(state);
  }
  const pending = getPending(state);
  if (
    phase === 'update' &&
    (!pending ||
      tag.operationId !== pending.operation.operationId ||
      tag.updateAttemptGeneration !== pending.latestUpdateAttemptGeneration)
  ) {
    return unchanged(state);
  }
  if (phase === 'update' && pending?.knownDisposition.kind === 'completed') {
    const lookup = error.code === 'operation-identity-rejected' ? 'get-only' : 'replay-or-get';
    const nextPending: PendingTaskNotesSubmission = {
      ...pending,
      recovery: {
        kind: 'awaiting-coherent-current',
        attemptGeneration: pending.latestUpdateAttemptGeneration,
        lookup,
      },
    };
    return { state: setPendingPhase(state, nextPending, 'recovering'), effects: [] };
  }
  const recovery = getRequestErrorRecovery(phase, error);
  const nextPending =
    phase === 'update' && pending && error.code === 'operation-identity-rejected'
      ? {
          ...pending,
          recovery: {
            kind: 'operation-identity-rejected',
            attemptGeneration: pending.latestUpdateAttemptGeneration,
          } as const,
        }
      : pending;
  return {
    state: {
      kind: 'error',
      generation: state.generation,
      taskId: state.taskId,
      ...('base' in state && state.base ? { base: state.base } : {}),
      draft: state.draft,
      ...(nextPending ? { pending: nextPending } : {}),
      ...(phase === 'issue' && state.kind === 'issuing'
        ? { issueRequestGeneration: state.issueRequestGeneration }
        : {}),
      recovery,
      reason: 'request-failed',
      requestCode: error.code,
    },
    effects: [],
  };
}

export function applyTaskNotesTransportFailure(
  state: TaskNotesEditorState,
  phase: 'get' | 'issue' | 'update',
  tag: {
    editorGeneration: number;
    taskId: string;
    issueRequestGeneration?: number;
    operationId?: string;
    updateAttemptGeneration?: number;
  },
): TaskNotesTransition {
  if (tag.editorGeneration !== state.generation || tag.taskId !== state.taskId) {
    return unchanged(state);
  }
  if (
    phase === 'issue' &&
    (state.kind !== 'issuing' || tag.issueRequestGeneration !== state.issueRequestGeneration)
  ) {
    return unchanged(state);
  }
  const pending = getPending(state);
  if (
    phase === 'update' &&
    (!pending ||
      tag.operationId !== pending.operation.operationId ||
      tag.updateAttemptGeneration !== pending.latestUpdateAttemptGeneration)
  ) {
    return unchanged(state);
  }
  if (phase === 'update' && pending?.knownDisposition.kind === 'completed') {
    const nextPending: PendingTaskNotesSubmission = {
      ...pending,
      recovery: {
        kind: 'awaiting-coherent-current',
        attemptGeneration: pending.latestUpdateAttemptGeneration,
        lookup: 'replay-or-get',
      },
    };
    return { state: setPendingPhase(state, nextPending, 'recovering'), effects: [] };
  }
  return {
    state: {
      kind: 'error',
      generation: state.generation,
      taskId: state.taskId,
      ...('base' in state && state.base ? { base: state.base } : {}),
      draft: state.draft,
      ...(pending ? { pending } : {}),
      ...(phase === 'issue' && state.kind === 'issuing'
        ? { issueRequestGeneration: state.issueRequestGeneration }
        : {}),
      recovery:
        phase === 'get' ? 'retry-load' : phase === 'issue' ? 'retry-issue' : 'retry-same-update',
      reason: 'transport-interrupted',
    },
    effects: [],
  };
}

function taskNotesOutcome(state: TaskNotesEditorState): 'dirty' | 'saved' | 'conflict' | 'unknown' {
  if (getPending(state)) return 'unknown';
  if (state.kind === 'conflict') return 'conflict';
  if ((state.kind === 'clean' || state.kind === 'saved') && state.draft === state.base.notes) {
    return 'saved';
  }
  return state.kind === 'loading' ? 'unknown' : 'dirty';
}

export function applyTaskNotesLifecycleProjection(
  state: TaskNotesEditorState,
  tag: { editorGeneration: number; taskId: string },
  currentTask: CurrentTaskLifecycleProjection,
): TaskNotesTransition {
  if (tag.editorGeneration !== state.generation || tag.taskId !== state.taskId) {
    return unchanged(state);
  }
  if (state.kind === 'closing' && currentTask.catalogVersion < state.currentTask.catalogVersion) {
    return unchanged(state);
  }
  if (currentTask.taskState !== 'present') {
    const orphaned = orphanFromGet(
      state,
      currentTask.taskState === 'removed' ? 'task-deleted' : 'task-no-longer-visible',
    );
    const knownClean =
      !getPending(state) &&
      (state.kind === 'loading' ||
        ((state.kind === 'clean' || state.kind === 'saved') && state.draft === state.base.notes));
    return knownClean
      ? {
          state: orphaned.state,
          effects: [{ kind: 'navigate-task-list', taskId: state.taskId }],
        }
      : orphaned;
  }
  if ('base' in state && state.base && currentTask.taskIncarnation !== state.base.taskIncarnation) {
    return orphanFromGet(state, 'task-replaced');
  }
  if (!currentTask.taskClosing || state.kind === 'orphaned') return unchanged(state);
  const base = 'base' in state ? state.base : undefined;
  const external = getExternal(state);
  const pending = getPending(state);
  const postCommitWarning = 'postCommitWarning' in state ? state.postCommitWarning : undefined;
  return {
    state: {
      kind: 'closing',
      generation: state.generation,
      taskId: state.taskId,
      ...(base ? { base } : {}),
      draft: state.draft,
      ...(external ? { external } : {}),
      currentTask,
      outcome: taskNotesOutcome(state),
      ...(pending ? { pending } : {}),
      ...(postCommitWarning ? { postCommitWarning } : {}),
    },
    effects: [],
  };
}

export function applyTaskNotesExternalSnapshot(
  state: TaskNotesEditorState,
  external: TaskNotesSnapshot,
): TaskNotesTransition {
  if (external.taskId !== state.taskId || state.kind === 'loading') return unchanged(state);
  if ('base' in state && state.base && external.taskIncarnation !== state.base.taskIncarnation) {
    return orphanFromGet(state, 'task-replaced');
  }
  const greatestKnownRevision = Math.max(
    'base' in state && state.base ? state.base.workspaceRevision : -1,
    getExternal(state)?.workspaceRevision ?? -1,
    state.kind === 'conflict' ? state.current.workspaceRevision : -1,
  );
  if (external.workspaceRevision <= greatestKnownRevision) return unchanged(state);
  if (state.kind === 'clean' || state.kind === 'saved') {
    return {
      state: {
        kind: 'clean',
        generation: state.generation,
        taskId: state.taskId,
        base: external,
        draft: external.notes,
      },
      effects: [],
    };
  }
  return { state: { ...state, external }, effects: [] };
}
