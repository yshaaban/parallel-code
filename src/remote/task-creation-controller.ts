import {
  canCancelTaskCreation,
  createEmptyTaskCreationClientOperationState,
  isIssueTaskCreationOperationTicketResult,
  isTaskCreationRequest,
  isTaskCreationTerminalPhase,
  reduceCreateTaskCreationOperationResult,
  reduceTaskCreationLookupResult,
  reduceTaskCreationOperationSnapshot,
  type TaskCreationClientFacade,
  type TaskCreationClientOperationState,
  type TaskCreationIntent,
  type TaskCreationOperationLiveEventSource,
  type TaskCreationOperationLiveMessage,
  type TaskCreationOperationSnapshot,
  type TaskCreationRequest,
} from '../domain/task-creation';
import {
  TASK_CREATION_TICKET_TTL_MS,
  type TaskCreationOperationId,
} from '../domain/task-creation-ticket';
import {
  clearRemoteTaskCreationCredential,
  createTaskCreationOperationCapability,
  loadRemoteTaskCreationCredential,
  saveRemoteTaskCreationCredential,
  type RemoteTaskCreationCredential,
} from './task-creation-credentials';

export type TaskCreationSubmission = TaskCreationRequest;

export type RemoteTaskCreationActivity =
  | 'editing'
  | 'issuing-ticket'
  | 'submitting'
  | 'tracking'
  | 'checking-status'
  | 'cancelling'
  | 'retrying-shell';

export interface RemoteTaskCreationControllerSnapshot {
  activity: RemoteTaskCreationActivity;
  canRetryIdentical: boolean;
  credential: RemoteTaskCreationCredential | null;
  elapsedMs: number;
  message: string | null;
  operation: TaskCreationClientOperationState;
  transportOutcomeUnknown: boolean;
}

export interface TaskCreationControllerOptions {
  facade: TaskCreationClientFacade;
  liveEvents?: TaskCreationOperationLiveEventSource;
  monotonicNow?: () => number;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

const TASK_CREATION_STATUS_POLL_INTERVAL_MS = 250;
const TASK_CREATION_STATUS_POLL_MAX_DELAY_MS = 5_000;
const TASK_CREATION_LIVE_SUBSCRIPTION_ACK_TIMEOUT_MS = 1_000;

function isBusyActivity(activity: RemoteTaskCreationActivity): boolean {
  return (
    activity === 'issuing-ticket' ||
    activity === 'submitting' ||
    activity === 'checking-status' ||
    activity === 'cancelling' ||
    activity === 'retrying-shell'
  );
}

export class TaskCreationController {
  private activity: RemoteTaskCreationActivity = 'editing';
  private credential: RemoteTaskCreationCredential | null = null;
  private disposed = false;
  private elapsedMs = 0;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private lastIntent: TaskCreationIntent | null = null;
  private listeners = new Set<(snapshot: RemoteTaskCreationControllerSnapshot) => void>();
  private message: string | null = null;
  private operation = createEmptyTaskCreationClientOperationState();
  private readonly facade: TaskCreationClientFacade;
  private readonly liveEvents: TaskCreationOperationLiveEventSource | null;
  private absentDeadlineProofTimer: ReturnType<typeof setTimeout> | null = null;
  private liveAckTimer: ReturnType<typeof setTimeout> | null = null;
  private liveConnectionState: 'connected' | 'disconnected' = 'disconnected';
  private liveGeneration = 0;
  private liveSubscriptionState: 'degraded' | 'pending' | 'ready' = 'degraded';
  private liveUnsubscribe: (() => void) | null = null;
  private readonly monotonicNow: () => number;
  private readonly now: () => number;
  private safeAbsentReleaseAt: number | null = null;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private readonly clearTimeoutFn: typeof globalThis.clearTimeout;
  private readonly setTimeoutFn: typeof globalThis.setTimeout;
  private statusPollActive = false;
  private statusPollDeadline = 0;
  private statusPollGeneration = 0;
  private statusPollTimer: ReturnType<typeof setTimeout> | null = null;
  private statusRequest: {
    abortController: AbortController;
    operationId: string;
    owner: 'poll' | 'probe';
    promise: ReturnType<TaskCreationClientFacade['get']>;
  } | null = null;
  private submittedAt: number | null = null;
  private transportOutcomeUnknown = false;

  constructor(options: TaskCreationControllerOptions) {
    this.facade = options.facade;
    this.liveEvents = options.liveEvents ?? null;
    this.monotonicNow = options.monotonicNow ?? (() => globalThis.performance.now());
    this.now = options.now ?? Date.now;
    this.setIntervalFn = options.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval.bind(globalThis);
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  }

  getSnapshot(): RemoteTaskCreationControllerSnapshot {
    return {
      activity: this.activity,
      canRetryIdentical:
        this.transportOutcomeUnknown && this.lastIntent !== null && this.credential !== null,
      credential: this.credential,
      elapsedMs: this.elapsedMs,
      message: this.message,
      operation: this.operation,
      transportOutcomeUnknown: this.transportOutcomeUnknown,
    };
  }

  subscribe(listener: (snapshot: RemoteTaskCreationControllerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLiveTracking();
    this.stopStatusPolling(true, true);
    this.cancelAbsentDeadlineProof();
    this.abortStatusRequest();
    this.stopElapsedTimer();
    this.listeners.clear();
  }

  async recoverStoredOperation(): Promise<void> {
    if (this.disposed || this.credential || isBusyActivity(this.activity)) return;
    const credential = loadRemoteTaskCreationCredential();
    if (!credential) return;
    this.credential = credential;
    this.armConservativeAbsentRelease();
    this.activity = 'checking-status';
    this.message = 'Checking an unfinished task creation…';
    this.notify();
    this.startLiveTracking();
    // Channel readiness proves subscription admission, not durable operation existence.
    // Recovery therefore always performs one canonical status proof before settling.
    await this.refreshStatus();
    if (
      this.credential &&
      (!this.operation.snapshot || !isTaskCreationTerminalPhase(this.operation.snapshot))
    ) {
      this.startTrackingUpdates();
    }
  }

  async submit(submission: TaskCreationSubmission): Promise<void> {
    if (
      this.disposed ||
      this.credential ||
      isBusyActivity(this.activity) ||
      this.operation.snapshot
    ) {
      return;
    }
    if (!isTaskCreationRequest(submission)) {
      this.message = 'Review the task details before creating.';
      this.notify();
      return;
    }
    this.activity = 'issuing-ticket';
    this.message = 'Securing this request…';
    this.transportOutcomeUnknown = false;
    this.notify();

    try {
      const issued = await this.facade.issue();
      if (this.disposed) return;
      if (!isIssueTaskCreationOperationTicketResult(issued)) {
        throw new Error('Invalid task-creation ticket');
      }
      if (issued.expiresAt - issued.issuedAt !== TASK_CREATION_TICKET_TTL_MS) {
        throw new Error('Invalid task-creation ticket lifetime');
      }
      const credential: RemoteTaskCreationCredential = {
        operationCapability: createTaskCreationOperationCapability(),
        operationId: issued.operationId,
      };
      const intent: TaskCreationIntent = {
        ...submission,
        ...credential,
        operationTicket: issued.operationTicket,
      };
      this.credential = credential;
      this.lastIntent = intent;
      this.armConservativeAbsentRelease();
      if (!saveRemoteTaskCreationCredential(credential)) {
        this.clearCredential();
        this.activity = 'editing';
        this.message =
          'Secure recovery storage is unavailable. Task creation was not started; free browser storage and try again.';
        this.notify();
        return;
      }
      this.startLiveTracking();
      this.activity = 'submitting';
      this.message = 'Creating task…';
      this.startElapsedTimer();
      this.notify();

      const createPromise = this.facade.create(intent);
      this.startTrackingUpdates();
      const result = await createPromise;
      if (this.disposed) return;
      this.operation = reduceCreateTaskCreationOperationResult(this.operation, result);
      this.transportOutcomeUnknown = false;
      if (result.kind === 'create-rejected-without-snapshot') {
        this.stopStatusPolling(true, true);
        this.activity = 'editing';
        this.message = getCreateRejectionMessage(result.code);
        this.clearCredential();
      } else if (result.kind === 'snapshot') {
        this.stopStatusPolling(true, false);
        const current = this.operation.snapshot;
        if (current) this.updateActivityFromSnapshot(current);
      } else {
        this.activity = 'tracking';
        this.message = 'The canonical host is recovering. Your operation remains protected.';
      }
      this.notify();
    } catch {
      if (this.disposed) return;
      if (this.operation.snapshot) {
        this.activity = 'tracking';
        this.message = null;
        this.transportOutcomeUnknown = false;
        this.notify();
      } else if (this.credential) {
        const credential = this.credential;
        await this.probeAfterAmbiguousResponse(
          credential,
          'The response was lost. Check status before trying anything else.',
        );
      } else {
        this.activity = 'editing';
        this.message = 'Could not secure task creation. Check the connection and try again.';
        this.notify();
      }
    }
  }

  async refreshStatus(): Promise<void> {
    const credential = this.credential;
    if (!credential) return;
    this.activity = 'checking-status';
    this.message = 'Checking task creation status…';
    this.notify();
    try {
      const result = await this.requestStatus(credential, 'probe');
      if (this.disposed || this.credential?.operationId !== credential.operationId) return;
      this.operation = reduceTaskCreationLookupResult(this.operation, result);
      if (result.kind === 'snapshot') {
        this.transportOutcomeUnknown = false;
        const current = this.operation.snapshot;
        if (current) this.updateActivityFromSnapshot(current);
      } else if (result.kind === 'operation-state-unavailable') {
        if (this.releaseSafelyTimedOutAbsentOperation()) {
          this.message =
            'The unused secure ticket expired with no operation state. You can submit again.';
        } else {
          this.activity = 'tracking';
          this.transportOutcomeUnknown = true;
          this.message =
            'No canonical operation state is available yet. This does not prove the request failed.';
        }
      } else {
        this.activity = 'tracking';
        this.message = getPassiveLookupMessage(result.kind);
      }
    } catch {
      if (this.disposed || this.credential?.operationId !== credential.operationId) return;
      this.activity = 'tracking';
      this.transportOutcomeUnknown = true;
      this.message = 'Status is temporarily unavailable. The operation has not been marked failed.';
    }
    this.notify();
  }

  async cancel(): Promise<void> {
    const credential = this.credential;
    const snapshot = this.operation.snapshot;
    if (!credential || !snapshot || !canCancelTaskCreation(snapshot)) return;
    this.activity = 'cancelling';
    this.message = 'Cancelling before preparation…';
    this.stopStatusPolling(true, false);
    this.notify();
    try {
      const result = await this.facade.cancel({ ...credential, expectedVersion: snapshot.version });
      if (this.disposed || this.credential?.operationId !== credential.operationId) return;
      this.operation = reduceTaskCreationLookupResult(this.operation, result);
      if (result.kind === 'snapshot') {
        const current = this.operation.snapshot;
        if (current) this.updateActivityFromSnapshot(current);
      } else {
        this.activity = 'tracking';
        this.message = getPassiveLookupMessage(result.kind);
        this.startTrackingUpdates();
      }
    } catch {
      if (this.disposed || this.credential?.operationId !== credential.operationId) return;
      await this.probeAfterAmbiguousResponse(
        credential,
        'The cancel response was lost. Check status to learn the canonical outcome.',
      );
      return;
    }
    this.notify();
  }

  async retryIdenticalSubmission(): Promise<void> {
    const credential = this.credential;
    const intent = this.lastIntent;
    if (!credential || !intent || !this.transportOutcomeUnknown || isBusyActivity(this.activity)) {
      return;
    }
    this.activity = 'checking-status';
    this.message = 'Checking canonical status before retrying…';
    this.notify();
    try {
      const status = await this.requestStatus(credential, 'probe');
      if (this.disposed || this.credential?.operationId !== credential.operationId) return;
      this.operation = reduceTaskCreationLookupResult(this.operation, status);
      if (status.kind !== 'operation-state-unavailable') {
        if (status.kind === 'snapshot') {
          this.transportOutcomeUnknown = false;
          const current = this.operation.snapshot;
          if (current) this.updateActivityFromSnapshot(current);
        } else {
          this.activity = 'tracking';
          this.message = getPassiveLookupMessage(status.kind);
        }
        this.notify();
        return;
      }

      if (this.releaseSafelyTimedOutAbsentOperation()) {
        this.message =
          'The unused secure ticket expired with no operation state. You can submit again.';
        this.notify();
        return;
      }

      this.activity = 'submitting';
      this.message = 'Retrying the identical protected request…';
      this.notify();
      const createPromise = this.facade.create(intent);
      this.startTrackingUpdates();
      const result = await createPromise;
      if (this.disposed || this.credential?.operationId !== credential.operationId) return;
      this.operation = reduceCreateTaskCreationOperationResult(this.operation, result);
      if (result.kind === 'snapshot') {
        this.transportOutcomeUnknown = false;
        this.stopStatusPolling(true, false);
        const current = this.operation.snapshot;
        if (current) this.updateActivityFromSnapshot(current);
      } else if (result.kind === 'create-rejected-without-snapshot') {
        this.stopStatusPolling(true, true);
        this.activity = 'editing';
        this.message = getCreateRejectionMessage(result.code);
        this.clearCredential();
      } else {
        this.activity = 'tracking';
        this.message = 'The canonical host is recovering. Your operation remains protected.';
      }
    } catch {
      if (this.disposed || this.credential?.operationId !== credential.operationId) return;
      await this.probeAfterAmbiguousResponse(
        credential,
        'The retry response was lost. Continue checking the same operation status.',
      );
      return;
    }
    this.notify();
  }

  async retryShell(): Promise<void> {
    const credential = this.credential;
    const snapshot = this.operation.snapshot;
    if (
      !credential ||
      snapshot?.taskMode !== 'terminal' ||
      !snapshot.shellLaunch ||
      snapshot.shellLaunch.disposition.kind !== 'same-tuple-retry' ||
      snapshot.current.taskState !== 'present' ||
      snapshot.current.taskClosing
    ) {
      return;
    }
    this.activity = 'retrying-shell';
    this.message = 'Retrying the exact terminal launch…';
    this.notify();
    try {
      const result = await this.facade.retryShell({
        action: 'retry-same-tuple',
        expectedRecordVersion: snapshot.shellLaunch.recordVersion,
        operationCapability: credential.operationCapability,
        operationId: snapshot.shellLaunch.identity.operationId,
      });
      if (this.disposed || this.credential?.operationId !== credential.operationId) return;
      const current = this.operation.snapshot;
      if (!current) return;
      this.operation = {
        overlay: null,
        snapshot: reduceTaskCreationOperationSnapshot(current, {
          ...snapshot,
          shellLaunch: result.shellLaunch,
        }),
      };
      this.activity = 'tracking';
      this.message =
        result.outcome === 'accepted'
          ? 'Terminal launch retry accepted.'
          : 'Terminal launch status refreshed.';
      this.startLiveTracking();
      this.startTrackingUpdates();
    } catch {
      if (this.disposed || this.credential?.operationId !== credential.operationId) return;
      await this.probeAfterAmbiguousResponse(
        credential,
        'Terminal launch retry is temporarily unavailable. Refresh status first.',
      );
      return;
    }
    this.notify();
  }

  applySnapshot(snapshot: TaskCreationOperationSnapshot): void {
    if (this.disposed || !this.credential || snapshot.operationId !== this.credential.operationId) {
      return;
    }
    const reduced = reduceTaskCreationOperationSnapshot(this.operation.snapshot, snapshot);
    this.operation = {
      overlay: null,
      snapshot: reduced,
    };
    this.transportOutcomeUnknown = false;
    this.updateActivityFromSnapshot(reduced);
    this.notify();
  }

  startOver(): void {
    if (isBusyActivity(this.activity)) return;
    if (this.credential && !this.operation.snapshot) {
      this.message =
        this.safeAbsentReleaseAt !== null && this.monotonicNow() >= this.safeAbsentReleaseAt
          ? 'Refresh status once more to prove the protected operation is absent before starting another.'
          : 'This protected request may still be admitted. Keep checking status before starting another.';
      this.notify();
      return;
    }
    if (this.operation.snapshot && !isTaskCreationTerminalPhase(this.operation.snapshot)) return;
    this.clearCredential();
    this.stopStatusPolling(true, true);
    this.operation = createEmptyTaskCreationClientOperationState();
    this.activity = 'editing';
    this.elapsedMs = 0;
    this.message = null;
    this.transportOutcomeUnknown = false;
    this.stopElapsedTimer();
    this.notify();
  }

  private clearCredential(): void {
    this.stopLiveTracking();
    this.credential = null;
    this.lastIntent = null;
    this.safeAbsentReleaseAt = null;
    this.cancelAbsentDeadlineProof();
    clearRemoteTaskCreationCredential();
    this.stopStatusPolling(true, false);
    this.abortStatusRequest();
    this.stopElapsedTimer();
  }

  private armConservativeAbsentRelease(): void {
    const observedAt = this.monotonicNow();
    if (!Number.isFinite(observedAt) || observedAt < 0) {
      throw new Error('Monotonic task-creation recovery clock is unavailable');
    }
    this.safeAbsentReleaseAt = observedAt + TASK_CREATION_TICKET_TTL_MS;
    this.scheduleAbsentDeadlineProof();
  }

  private releaseSafelyTimedOutAbsentOperation(): boolean {
    if (this.safeAbsentReleaseAt === null || this.monotonicNow() < this.safeAbsentReleaseAt) {
      return false;
    }
    this.clearCredential();
    this.operation = createEmptyTaskCreationClientOperationState();
    this.activity = 'editing';
    this.elapsedMs = 0;
    this.transportOutcomeUnknown = false;
    return true;
  }

  private notify(): void {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private startElapsedTimer(): void {
    this.stopElapsedTimer();
    this.submittedAt = this.now();
    this.elapsedMs = 0;
    this.elapsedTimer = this.setIntervalFn(() => {
      if (this.disposed) return;
      this.elapsedMs = Math.max(0, this.now() - (this.submittedAt ?? this.now()));
      this.notify();
    }, 1_000);
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer !== null) this.clearIntervalFn(this.elapsedTimer);
    this.elapsedTimer = null;
    this.submittedAt = null;
  }

  private updateActivityFromSnapshot(snapshot: TaskCreationOperationSnapshot): void {
    this.cancelAbsentDeadlineProof();
    if (isTaskCreationTerminalPhase(snapshot)) {
      this.activity = 'tracking';
      this.stopLiveTracking();
      this.stopStatusPolling(true, true);
      this.stopElapsedTimer();
    } else {
      this.activity = 'tracking';
    }
    this.message = null;
    if (snapshot.phase === 'active') this.clearCredential();
  }

  private startLiveTracking(): void {
    const credential = this.credential;
    if (!this.liveEvents || !credential || this.disposed) return;
    this.stopLiveTracking();
    this.liveSubscriptionState = 'pending';
    const generation = this.liveGeneration;
    let unsubscribe: () => void;
    try {
      unsubscribe = this.liveEvents.subscribe(credential, (message) => {
        this.handleLiveMessage(generation, credential.operationId, message);
      });
    } catch {
      if (this.liveGeneration === generation) {
        this.liveConnectionState = 'disconnected';
        this.liveSubscriptionState = 'degraded';
      }
      return;
    }
    if (
      this.disposed ||
      this.liveGeneration !== generation ||
      this.credential?.operationId !== credential.operationId
    ) {
      this.releaseLiveSubscription(unsubscribe);
      return;
    }
    this.liveUnsubscribe = unsubscribe;
  }

  private stopLiveTracking(): void {
    this.liveGeneration += 1;
    this.cancelLiveAckTimer();
    this.releaseLiveSubscription(this.liveUnsubscribe);
    this.liveUnsubscribe = null;
    this.liveConnectionState = 'disconnected';
    this.liveSubscriptionState = 'degraded';
  }

  private releaseLiveSubscription(unsubscribe: (() => void) | null): void {
    try {
      unsubscribe?.();
    } catch {
      // A transport cleanup failure must not retain controller credentials or timers.
    }
  }

  private handleLiveMessage(
    generation: number,
    operationId: TaskCreationOperationId,
    message: TaskCreationOperationLiveMessage,
  ): void {
    if (
      this.disposed ||
      generation !== this.liveGeneration ||
      this.credential?.operationId !== operationId
    ) {
      return;
    }
    switch (message.kind) {
      case 'connection-state':
        this.liveConnectionState = message.state;
        if (message.state === 'connected') {
          this.liveSubscriptionState = 'pending';
          this.armLiveAckTimeout(generation, operationId);
        } else {
          this.cancelLiveAckTimer();
          this.liveSubscriptionState = 'degraded';
          this.ensureStatusPolling();
        }
        return;
      case 'subscription-state':
        this.cancelLiveAckTimer();
        this.liveSubscriptionState = message.state;
        if (message.state === 'ready' && this.liveConnectionState === 'connected') {
          this.stopStatusPolling(true, true);
        } else {
          this.ensureStatusPolling();
        }
        return;
      case 'snapshot':
        if (message.snapshot.operationId !== operationId) return;
        this.cancelLiveAckTimer();
        if (this.liveConnectionState === 'connected') {
          this.liveSubscriptionState = 'ready';
          this.stopStatusPolling(true, true);
        }
        this.applySnapshot(message.snapshot);
        if (
          this.liveConnectionState === 'disconnected' &&
          this.credential &&
          !isTaskCreationTerminalPhase(message.snapshot)
        ) {
          this.ensureStatusPolling();
        }
        return;
    }
  }

  private armLiveAckTimeout(generation: number, operationId: TaskCreationOperationId): void {
    this.cancelLiveAckTimer();
    this.liveAckTimer = this.setTimeoutFn(() => {
      this.liveAckTimer = null;
      if (
        this.disposed ||
        this.liveGeneration !== generation ||
        this.credential?.operationId !== operationId ||
        this.liveConnectionState !== 'connected' ||
        this.liveSubscriptionState !== 'pending'
      ) {
        return;
      }
      this.liveSubscriptionState = 'degraded';
      this.ensureStatusPolling();
    }, TASK_CREATION_LIVE_SUBSCRIPTION_ACK_TIMEOUT_MS);
  }

  private cancelLiveAckTimer(): void {
    if (this.liveAckTimer !== null) this.clearTimeoutFn(this.liveAckTimer);
    this.liveAckTimer = null;
  }

  private startTrackingUpdates(): void {
    if (
      this.liveEvents &&
      this.liveConnectionState === 'connected' &&
      (this.liveSubscriptionState === 'pending' || this.liveSubscriptionState === 'ready')
    ) {
      if (this.liveSubscriptionState === 'pending') {
        const operationId = this.credential?.operationId;
        if (operationId) this.armLiveAckTimeout(this.liveGeneration, operationId);
      } else {
        this.stopStatusPolling(true, true);
      }
      return;
    }
    this.startStatusPolling();
  }

  private ensureStatusPolling(): void {
    if (this.statusPollActive) return;
    this.startStatusPolling();
  }

  private startStatusPolling(): void {
    if (this.disposed || !this.credential) return;
    this.stopStatusPolling(true, true);
    this.statusPollActive = true;
    this.statusPollDeadline =
      this.safeAbsentReleaseAt ?? this.monotonicNow() + TASK_CREATION_TICKET_TTL_MS;
    this.scheduleStatusPoll(this.statusPollGeneration, 0);
  }

  private stopStatusPolling(abortInFlight: boolean, invalidateGeneration: boolean): void {
    this.statusPollActive = false;
    if (this.statusPollTimer !== null) {
      this.clearTimeoutFn(this.statusPollTimer);
      this.statusPollTimer = null;
    }
    if (abortInFlight && this.statusRequest?.owner === 'poll') {
      this.statusRequest.abortController.abort();
    }
    if (invalidateGeneration) this.statusPollGeneration += 1;
  }

  private scheduleStatusPoll(generation: number, delayMs: number): void {
    if (
      this.disposed ||
      !this.statusPollActive ||
      this.statusPollGeneration !== generation ||
      this.statusPollTimer !== null
    ) {
      return;
    }
    if (this.monotonicNow() >= this.statusPollDeadline) {
      this.stopStatusPolling(false, false);
      this.message = 'Automatic status updates paused. Refresh status to continue.';
      this.notify();
      return;
    }
    this.statusPollTimer = this.setTimeoutFn(() => {
      this.statusPollTimer = null;
      void this.runStatusPoll(generation);
    }, delayMs);
  }

  private async runStatusPoll(generation: number): Promise<void> {
    const credential = this.credential;
    if (
      !credential ||
      this.disposed ||
      !this.statusPollActive ||
      this.statusPollGeneration !== generation
    ) {
      return;
    }
    let nextDelayMs = TASK_CREATION_STATUS_POLL_INTERVAL_MS;
    try {
      const result = await this.requestStatus(credential, 'poll');
      if (
        this.disposed ||
        !this.statusPollActive ||
        this.statusPollGeneration !== generation ||
        this.credential?.operationId !== credential.operationId
      ) {
        return;
      }
      this.operation = reduceTaskCreationLookupResult(this.operation, result);
      if (result.kind === 'snapshot') {
        this.transportOutcomeUnknown = false;
        const current = this.operation.snapshot;
        if (current && (this.activity !== 'cancelling' || isTaskCreationTerminalPhase(current))) {
          this.updateActivityFromSnapshot(current);
        }
        if (current && isTaskCreationTerminalPhase(current)) {
          this.stopStatusPolling(false, false);
        }
      } else if (result.kind === 'canonical-host-durability-pending') {
        nextDelayMs = Math.min(
          TASK_CREATION_STATUS_POLL_MAX_DELAY_MS,
          Math.max(TASK_CREATION_STATUS_POLL_INTERVAL_MS, result.pollAfterMs),
        );
      }
      this.notify();
    } catch {
      // A transient/aborted status probe never changes canonical state. The active generation
      // either schedules one later probe or has already been stopped by Create/Cancel/dispose.
    }
    this.scheduleStatusPoll(generation, nextDelayMs);
  }

  private requestStatus(
    credential: RemoteTaskCreationCredential,
    owner: 'poll' | 'probe',
  ): ReturnType<TaskCreationClientFacade['get']> {
    const existing = this.statusRequest;
    if (existing?.operationId === credential.operationId) {
      // A required/user probe may share a poll's request, but must then own it so a later
      // healthy-channel acknowledgement cannot abort the proof it is waiting for.
      if (owner === 'probe') existing.owner = 'probe';
      return existing.promise;
    }
    existing?.abortController.abort();
    const abortController = new AbortController();
    const promise = this.facade.get(credential, abortController.signal);
    const request = { abortController, operationId: credential.operationId, owner, promise };
    this.statusRequest = request;
    const clear = (): void => {
      if (this.statusRequest === request) this.statusRequest = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  private abortStatusRequest(): void {
    this.statusRequest?.abortController.abort();
    this.statusRequest = null;
  }

  private async probeAfterAmbiguousResponse(
    credential: RemoteTaskCreationCredential,
    message: string,
  ): Promise<void> {
    this.activity = 'tracking';
    this.message = message;
    this.transportOutcomeUnknown = true;
    this.notify();
    await this.refreshStatus();
    if (
      this.disposed ||
      this.credential?.operationId !== credential.operationId ||
      (this.operation.snapshot && isTaskCreationTerminalPhase(this.operation.snapshot))
    ) {
      return;
    }
    this.startTrackingUpdates();
  }

  private cancelAbsentDeadlineProof(): void {
    if (this.absentDeadlineProofTimer !== null) {
      this.clearTimeoutFn(this.absentDeadlineProofTimer);
      this.absentDeadlineProofTimer = null;
    }
  }

  private scheduleAbsentDeadlineProof(): void {
    this.cancelAbsentDeadlineProof();
    const credential = this.credential;
    const releaseAt = this.safeAbsentReleaseAt;
    if (!credential || releaseAt === null || this.operation.snapshot || this.disposed) return;
    this.absentDeadlineProofTimer = this.setTimeoutFn(
      () => {
        this.absentDeadlineProofTimer = null;
        if (
          this.disposed ||
          this.credential?.operationId !== credential.operationId ||
          this.operation.snapshot ||
          this.safeAbsentReleaseAt !== releaseAt
        ) {
          return;
        }
        if (this.monotonicNow() < releaseAt) {
          this.scheduleAbsentDeadlineProof();
          return;
        }
        // Exactly one post-deadline canonical proof decides whether an unused credential is safe
        // to release. Live readiness alone is deliberately insufficient.
        void this.refreshStatus();
      },
      Math.max(0, releaseAt - this.monotonicNow()),
    );
  }
}

function getCreateRejectionMessage(code: string): string {
  switch (code) {
    case 'invalid-request':
      return 'Review the highlighted fields and submit again.';
    case 'capability-denied':
      return 'This session is not allowed to create that task.';
    case 'operation-ticket-invalid':
    case 'operation-ticket-expired':
      return 'The secure creation ticket expired. Submit again to request a new one.';
    case 'operation-conflict':
      return 'This operation no longer matches the original request.';
    case 'operation-expired':
      return 'This operation expired. Start a new task creation request.';
    case 'rate-limited':
      return 'Too many creation requests. Wait a moment and submit again.';
    case 'creation-capacity':
      return 'Task creation is at capacity. Try again after another operation finishes.';
    default:
      return 'Task creation was rejected before any task was recorded.';
  }
}

function getPassiveLookupMessage(kind: string): string {
  switch (kind) {
    case 'lookup-rejected-without-snapshot':
      return 'Status lookup is temporarily restricted. The last trusted state is preserved.';
    case 'canonical-host-durability-pending':
    case 'canonical-host-unavailable':
    case 'operation-journal-unavailable':
      return 'The canonical host is recovering. The last trusted state is preserved.';
    default:
      return 'Task creation status is temporarily unavailable.';
  }
}
