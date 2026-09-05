import type {
  CurrentTaskLifecycleProjection,
  GetTaskNotesResult,
  TaskNotesChangedNotification,
  TaskNotesWireResponse,
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
  openTaskNotes,
  overwriteTaskNotesWithLatestBase,
  refetchTaskNotesBeforeNewIssue,
  retryPendingTaskNotesUpdate,
  retryTaskNotesGet,
  retryTaskNotesIssue,
  submitTaskNotes,
  useLatestTaskNotesSnapshot,
  type TaskNotesEditorState,
  type TaskNotesReducerEffect,
  type TaskNotesTransition,
} from './task-notes-draft';
import type { TaskNotesTransport } from './task-notes-transport';
import type { AcknowledgedTaskNotesOperation } from '../../domain/task-notes';

const GET_TIMEOUT_MS = 15_000;
const SLOW_SAVE_MS = 10_000;
const SAVED_NOTICE_MS = 2_000;

export interface TaskNotesControllerSnapshot {
  savedNoticeVisible: boolean;
  slowSaving: boolean;
  state: TaskNotesEditorState;
}

export interface TaskNotesControllerOptions {
  confirmAcknowledgements: (operations: readonly AcknowledgedTaskNotesOperation[]) => void;
  enqueueAcknowledgement: (operation: AcknowledgedTaskNotesOperation) => void;
  getAcknowledgements: () => AcknowledgedTaskNotesOperation[];
  onInvariantViolation?: (code: string) => void;
  onNavigateTaskList?: (taskId: string) => void;
  sourceId?: string | null;
  subscribeInvalidation?: (
    taskId: string,
    listener: (notification: TaskNotesChangedNotification) => void,
  ) => () => void;
}

type Listener = (snapshot: TaskNotesControllerSnapshot) => void;
type GetEffect = Extract<TaskNotesReducerEffect, { kind: 'get' }>;

function getPending(state: TaskNotesEditorState) {
  return 'pending' in state ? state.pending : undefined;
}

function getGreatestWorkspaceRevision(state: TaskNotesEditorState): number {
  return Math.max(
    'base' in state && state.base ? state.base.workspaceRevision : -1,
    'external' in state && state.external ? state.external.workspaceRevision : -1,
    state.kind === 'conflict' ? state.current.workspaceRevision : -1,
  );
}

export function isTaskNotesStateUnsaved(state: TaskNotesEditorState): boolean {
  if (state.kind === 'loading') return false;
  const pending = getPending(state);
  if (pending) return true;
  if (state.kind === 'clean' || state.kind === 'saved') return state.draft !== state.base.notes;
  if (state.kind === 'orphaned' || state.kind === 'closing' || state.kind === 'error') {
    return state.base ? state.draft !== state.base.notes : state.draft.length > 0;
  }
  return true;
}

function isSavingState(state: TaskNotesEditorState): boolean {
  return (
    state.kind === 'issuing' ||
    state.kind === 'saving' ||
    state.kind === 'securing' ||
    state.kind === 'recovering'
  );
}

function getCurrentLifecycle(result: GetTaskNotesResult): CurrentTaskLifecycleProjection | null {
  return result.kind === 'task-state-unavailable' ? null : result.current.currentTask;
}

export class TaskNotesController {
  private stateValue: TaskNotesEditorState;
  private readonly listeners = new Set<Listener>();
  private getAbort: AbortController | null = null;
  private queuedGet: GetEffect | null = null;
  private getTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private savedTimer: ReturnType<typeof setTimeout> | null = null;
  private automaticRetryUsed = false;
  private savedNoticeVisibleValue = false;
  private slowSavingValue = false;
  private disposed = false;
  private mountCount = 0;
  private mountedBefore = false;
  private unsubscribeInvalidation: (() => void) | null = null;
  private lifecycleServerInstanceId: string | null = null;
  private lifecycleCatalogVersion = -1;

  constructor(
    readonly taskId: string,
    private readonly transport: TaskNotesTransport,
    private readonly options: TaskNotesControllerOptions,
  ) {
    const opened = openTaskNotes(taskId);
    this.stateValue = opened.state;
    this.runEffects(opened.effects);
  }

  get state(): TaskNotesEditorState {
    return this.stateValue;
  }

  get snapshot(): TaskNotesControllerSnapshot {
    return {
      savedNoticeVisible: this.savedNoticeVisibleValue,
      slowSaving: this.slowSavingValue,
      state: this.stateValue,
    };
  }

  get hasUnsavedChanges(): boolean {
    return isTaskNotesStateUnsaved(this.stateValue);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  attach(): void {
    this.mountCount += 1;
    if (this.mountCount !== 1) return;
    this.unsubscribeInvalidation =
      this.options.subscribeInvalidation?.(this.taskId, (notification) =>
        this.invalidate(notification),
      ) ?? null;
    if (this.mountedBefore) this.checkStatus();
    else this.mountedBefore = true;
  }

  detach(): void {
    this.mountCount = Math.max(0, this.mountCount - 1);
    if (this.mountCount !== 0) return;
    this.unsubscribeInvalidation?.();
    this.unsubscribeInvalidation = null;
  }

  edit(draft: string): void {
    this.automaticRetryUsed = false;
    this.apply(editTaskNotesDraft(this.stateValue, draft));
  }

  save(): void {
    this.automaticRetryUsed = false;
    this.apply(submitTaskNotes(this.stateValue, this.options.getAcknowledgements()));
  }

  retry(): void {
    this.clearRetryTimer();
    this.automaticRetryUsed = false;
    const state = this.stateValue;
    if (state.kind === 'issuing') {
      return this.apply(retryTaskNotesIssue(state, this.options.getAcknowledgements()));
    }
    if (state.kind === 'error') {
      if (state.recovery === 'retry-load') return this.apply(retryTaskNotesGet(state));
      if (state.recovery === 'retry-issue') {
        return this.apply(retryTaskNotesIssue(state, this.options.getAcknowledgements()));
      }
      if (state.recovery === 'refetch-before-new-issue') {
        return this.apply(refetchTaskNotesBeforeNewIssue(state));
      }
      if (state.recovery === 'retry-same-update') {
        return this.apply(retryPendingTaskNotesUpdate(state));
      }
      if (state.recovery === 'reauthenticate') {
        if (state.pending) return this.apply(retryPendingTaskNotesUpdate(state));
        if (state.issueRequestGeneration !== undefined) {
          return this.apply(retryTaskNotesIssue(state, this.options.getAcknowledgements()));
        }
        return this.apply(retryTaskNotesGet(state));
      }
    }
    if (getPending(state)) this.apply(retryPendingTaskNotesUpdate(state));
  }

  checkStatus(): void {
    const pending = getPending(this.stateValue);
    const known = pending?.knownDisposition;
    this.runGet({
      kind: 'get',
      taskId: this.taskId,
      editorGeneration: this.stateValue.generation,
      ...(pending && known?.kind === 'completed'
        ? { operationId: pending.operation.operationId, truthGeneration: known.truthGeneration }
        : {}),
    });
  }

  useLatest(): void {
    this.apply(useLatestTaskNotesSnapshot(this.stateValue));
  }

  overwrite(): void {
    this.apply(
      overwriteTaskNotesWithLatestBase(this.stateValue, this.options.getAcknowledgements()),
    );
  }

  applyLifecycle(currentTask: CurrentTaskLifecycleProjection): void {
    if (!this.acceptLifecycle(currentTask)) return;
    this.apply(
      applyTaskNotesLifecycleProjection(
        this.stateValue,
        { editorGeneration: this.stateValue.generation, taskId: this.taskId },
        currentTask,
      ),
    );
  }

  invalidate(notification: TaskNotesChangedNotification): void {
    if (
      notification.taskId !== this.taskId ||
      (this.options.sourceId !== null &&
        this.options.sourceId !== undefined &&
        notification.sourceId === this.options.sourceId) ||
      notification.workspaceRevision <= getGreatestWorkspaceRevision(this.stateValue)
    ) {
      return;
    }
    this.runGet({
      kind: 'get',
      taskId: this.taskId,
      editorGeneration: this.stateValue.generation,
    });
  }

  discard(): void {
    this.clearRetryTimer();
    this.apply(openTaskNotes(this.taskId, this.stateValue.generation));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeInvalidation?.();
    this.unsubscribeInvalidation = null;
    this.getAbort?.abort();
    this.getAbort = null;
    this.clearGetTimeout();
    this.clearRetryTimer();
    this.clearSlowTimer();
    if (this.savedTimer) clearTimeout(this.savedTimer);
    this.savedTimer = null;
    this.listeners.clear();
  }

  private emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private apply(transition: TaskNotesTransition): void {
    if (this.disposed) return;
    const previous = this.stateValue;
    this.stateValue = transition.state;
    this.updatePresentationTimers(previous);
    if (previous !== transition.state) this.emit();
    this.runEffects(transition.effects);
  }

  private runEffects(effects: readonly TaskNotesReducerEffect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'get':
          this.runGet(effect);
          break;
        case 'issue':
          void this.runIssue(effect);
          break;
        case 'update':
          void this.runUpdate(effect);
          break;
        case 'acknowledge':
          this.options.enqueueAcknowledgement(effect.operation);
          break;
        case 'navigate-task-list':
          this.options.onNavigateTaskList?.(effect.taskId);
          break;
        case 'invariant-violation':
          this.options.onInvariantViolation?.(effect.code);
          break;
      }
    }
  }

  private runGet(effect: GetEffect): void {
    if (this.disposed) return;
    if (this.getAbort) {
      this.queuedGet =
        effect.truthGeneration !== undefined || this.queuedGet?.truthGeneration === undefined
          ? effect
          : this.queuedGet;
      return;
    }
    const abort = new AbortController();
    this.getAbort = abort;
    this.getTimeout = setTimeout(() => abort.abort(), GET_TIMEOUT_MS);
    void Promise.resolve()
      .then(() => this.transport.get({ taskId: effect.taskId }, abort.signal))
      .then((response) => this.handleGet(effect, response))
      .catch(() => {
        if (!this.disposed) {
          const pending = getPending(this.stateValue);
          this.apply(
            effect.truthGeneration !== undefined && pending
              ? applyTaskNotesTransportFailure(this.stateValue, 'update', {
                  editorGeneration: effect.editorGeneration,
                  operationId: pending.operation.operationId,
                  taskId: effect.taskId,
                  updateAttemptGeneration: pending.latestUpdateAttemptGeneration,
                })
              : applyTaskNotesTransportFailure(this.stateValue, 'get', {
                  editorGeneration: effect.editorGeneration,
                  taskId: effect.taskId,
                }),
          );
        }
      })
      .finally(() => {
        if (this.getAbort !== abort) return;
        this.getAbort = null;
        this.clearGetTimeout();
        const queued = this.queuedGet;
        this.queuedGet = null;
        if (queued && !this.disposed) this.runGet(queued);
      });
  }

  private handleGet(effect: GetEffect, response: TaskNotesWireResponse<GetTaskNotesResult>): void {
    if (!response.ok) {
      const pending = getPending(this.stateValue);
      this.apply(
        effect.truthGeneration !== undefined && pending
          ? applyTaskNotesRequestError(
              this.stateValue,
              'update',
              {
                editorGeneration: effect.editorGeneration,
                operationId: pending.operation.operationId,
                updateAttemptGeneration: pending.latestUpdateAttemptGeneration,
              },
              response.error,
            )
          : applyTaskNotesRequestError(
              this.stateValue,
              'get',
              { editorGeneration: effect.editorGeneration },
              response.error,
            ),
      );
      this.scheduleAutomaticRetry(
        effect.truthGeneration !== undefined ? 'update' : 'get',
        'retryAfterMs' in response.error ? response.error.retryAfterMs : null,
      );
      return;
    }
    const lifecycle = getCurrentLifecycle(response.result);
    const acceptedLifecycle = lifecycle ? this.acceptLifecycle(lifecycle) : true;
    if (!acceptedLifecycle && effect.truthGeneration !== undefined) return;
    if (lifecycle && acceptedLifecycle) {
      this.apply(
        applyTaskNotesLifecycleProjection(
          this.stateValue,
          { editorGeneration: effect.editorGeneration, taskId: effect.taskId },
          lifecycle,
        ),
      );
    }
    const isRecoveryLookup = effect.truthGeneration !== undefined;
    if (
      !isRecoveryLookup &&
      response.result.kind === 'loaded' &&
      (this.stateValue.kind === 'dirty' ||
        this.stateValue.kind === 'conflict' ||
        this.stateValue.kind === 'issuing' ||
        this.stateValue.kind === 'saving' ||
        this.stateValue.kind === 'securing' ||
        this.stateValue.kind === 'recovering')
    ) {
      this.apply(
        applyTaskNotesExternalSnapshot(
          this.stateValue,
          response.result.current.currentNotes.snapshot,
        ),
      );
    } else {
      this.apply(
        applyGetTaskNotesResult(
          this.stateValue,
          {
            editorGeneration: effect.editorGeneration,
            taskId: effect.taskId,
            ...(effect.operationId ? { operationId: effect.operationId } : {}),
            ...(effect.truthGeneration !== undefined
              ? { truthGeneration: effect.truthGeneration }
              : {}),
          },
          response.result,
        ),
      );
    }
    if (response.result.kind === 'task-state-unavailable') {
      this.scheduleAutomaticRetry(
        effect.truthGeneration !== undefined ? 'update' : 'get',
        response.result.retryAfterMs,
      );
    } else {
      this.automaticRetryUsed = false;
    }
  }

  private async runIssue(
    effect: Extract<TaskNotesReducerEffect, { kind: 'issue' }>,
  ): Promise<void> {
    const offered = effect.request.acknowledgedOperations ?? [];
    try {
      const response = await this.transport.issue(effect.request);
      if (response.ok && response.result.kind === 'issued') {
        if (offered.length > 0) this.options.confirmAcknowledgements(offered);
      }
      if (response.ok) {
        this.apply(
          applyIssueTaskNotesResult(
            this.stateValue,
            {
              editorGeneration: effect.editorGeneration,
              issueRequestGeneration: effect.issueRequestGeneration,
              taskId: effect.request.taskId,
            },
            response.result,
          ),
        );
        if (response.result.kind === 'task-state-unavailable') {
          this.scheduleAutomaticRetry('issue', response.result.retryAfterMs);
        } else this.automaticRetryUsed = false;
      } else {
        this.apply(
          applyTaskNotesRequestError(
            this.stateValue,
            'issue',
            {
              editorGeneration: effect.editorGeneration,
              issueRequestGeneration: effect.issueRequestGeneration,
            },
            response.error,
          ),
        );
        this.scheduleAutomaticRetry(
          'issue',
          'retryAfterMs' in response.error ? response.error.retryAfterMs : null,
        );
      }
    } catch {
      this.apply(
        applyTaskNotesTransportFailure(this.stateValue, 'issue', {
          editorGeneration: effect.editorGeneration,
          issueRequestGeneration: effect.issueRequestGeneration,
          taskId: effect.request.taskId,
        }),
      );
    }
  }

  private async runUpdate(
    effect: Extract<TaskNotesReducerEffect, { kind: 'update' }>,
  ): Promise<void> {
    try {
      const response = await this.transport.update(effect.request);
      if (response.ok) {
        this.apply(
          applyUpdateTaskNotesResult(
            this.stateValue,
            {
              editorGeneration: effect.editorGeneration,
              operationId: effect.request.operationId,
              updateAttemptGeneration: effect.updateAttemptGeneration,
            },
            response.result,
          ),
        );
        const delay =
          response.result.kind === 'recovery-busy' ||
          response.result.kind === 'task-state-unavailable'
            ? response.result.retryAfterMs
            : null;
        this.scheduleAutomaticRetry('update', delay);
        if (delay === null) this.automaticRetryUsed = false;
      } else {
        this.apply(
          applyTaskNotesRequestError(
            this.stateValue,
            'update',
            {
              editorGeneration: effect.editorGeneration,
              operationId: effect.request.operationId,
              updateAttemptGeneration: effect.updateAttemptGeneration,
            },
            response.error,
          ),
        );
        this.scheduleAutomaticRetry(
          'update',
          'retryAfterMs' in response.error ? response.error.retryAfterMs : null,
        );
      }
    } catch {
      this.apply(
        applyTaskNotesTransportFailure(this.stateValue, 'update', {
          editorGeneration: effect.editorGeneration,
          operationId: effect.request.operationId,
          taskId: effect.request.taskId,
          updateAttemptGeneration: effect.updateAttemptGeneration,
        }),
      );
    }
  }

  private scheduleAutomaticRetry(phase: 'get' | 'issue' | 'update', delay: number | null): void {
    if (delay === null || this.automaticRetryUsed || this.disposed) return;
    this.automaticRetryUsed = true;
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (phase === 'get') this.apply(retryTaskNotesGet(this.stateValue));
      else if (phase === 'issue') {
        this.apply(retryTaskNotesIssue(this.stateValue, this.options.getAcknowledgements()));
      } else this.apply(retryPendingTaskNotesUpdate(this.stateValue));
    }, delay);
  }

  private acceptLifecycle(current: CurrentTaskLifecycleProjection): boolean {
    if (this.lifecycleServerInstanceId !== current.serverInstanceId) {
      this.lifecycleServerInstanceId = current.serverInstanceId;
      this.lifecycleCatalogVersion = current.catalogVersion;
      return true;
    }
    if (current.catalogVersion < this.lifecycleCatalogVersion) return false;
    this.lifecycleCatalogVersion = current.catalogVersion;
    return true;
  }

  private updatePresentationTimers(previous: TaskNotesEditorState): void {
    const isSaving = isSavingState(this.stateValue);
    if (!isSaving) {
      this.clearSlowTimer();
      if (this.slowSavingValue) {
        this.slowSavingValue = false;
        queueMicrotask(() => !this.disposed && this.emit());
      }
    } else if (!isSavingState(previous)) {
      this.clearSlowTimer();
      const generation = this.stateValue.generation;
      this.slowTimer = setTimeout(() => {
        if (
          !this.disposed &&
          this.stateValue.generation === generation &&
          isSavingState(this.stateValue)
        ) {
          this.slowSavingValue = true;
          this.emit();
        }
      }, SLOW_SAVE_MS);
    }

    if (this.stateValue.kind !== 'saved') {
      if (this.savedTimer) clearTimeout(this.savedTimer);
      this.savedTimer = null;
      this.savedNoticeVisibleValue = false;
      return;
    }
    if (
      previous.kind === 'saved' &&
      previous.savedNoticeGeneration === this.stateValue.savedNoticeGeneration
    )
      return;
    this.savedNoticeVisibleValue = true;
    if (this.savedTimer) clearTimeout(this.savedTimer);
    const noticeGeneration = this.stateValue.savedNoticeGeneration;
    this.savedTimer = setTimeout(() => {
      if (
        this.stateValue.kind === 'saved' &&
        this.stateValue.savedNoticeGeneration === noticeGeneration
      ) {
        this.savedNoticeVisibleValue = false;
        this.emit();
      }
    }, SAVED_NOTICE_MS);
  }

  private clearGetTimeout(): void {
    if (this.getTimeout) clearTimeout(this.getTimeout);
    this.getTimeout = null;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearSlowTimer(): void {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
  }
}
