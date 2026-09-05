import type {
  AgentSupervisionEvent,
  AgentSupervisionSnapshot,
  AgentSupervisionState,
} from '../../src/domain/server-state.js';
import {
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  TASK_INITIAL_PROMPT_QUIESCENCE_MS,
  TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS,
  TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS,
  type QueueTaskInitialPromptDeliveryResult,
  type SendTaskInitialPromptManuallyRequest,
  type TaskInitialPromptDeliveryProjection,
  type TaskInitialPromptDeliveryRequest,
  type TaskInitialPromptDeliverySnapshot,
  type TaskInitialPromptOwnerAvailability,
} from '../../src/domain/task-initial-prompt-delivery.js';
import type { TaskRemovalParticipantGate } from '../../src/domain/task-removal-owner.js';
import { getAgentSupervisionSnapshot, subscribeAgentSupervision } from './agent-supervision.js';
import {
  createActiveTaskInitialPromptDeliveryHandlers,
  type ActiveTaskInitialPromptDeliveryHandlers,
  type TaskInitialPromptDeliveryAction,
} from './task-initial-prompt-delivery-handlers.js';
import {
  createWorkspaceTaskInitialPromptPersistence,
  type WorkspaceTaskInitialPromptPersistence,
} from './task-initial-prompt-delivery-persistence.js';
import { createTaskInitialPromptRemovalParticipant } from './task-initial-prompt-removal-participant.js';
import {
  createTaskInitialPromptDeliveryService,
  type TaskInitialPromptAgentObservation,
  type TaskInitialPromptAgentRuntimeSnapshot,
  type TaskInitialPromptDeliveryClock,
  type TaskInitialPromptDeliveryService,
} from './task-initial-prompt-delivery.js';
import { acquireTaskCommandLease, releaseTaskCommandLease } from './task-command-leases.js';
import type { TaskPromptInputAdmissionService } from './task-prompt-input-admission.js';
import type { TaskRemovalOwnerParticipant } from './task-removal-owner.js';
import type { TaskStructureMutationService } from './task-structure-mutations.js';
import { getAgentLifecycleGeneration, getAgentMeta, getAgentScrollbackBuffer } from './pty.js';
import type {
  WorkspaceMutationService,
  WorkspacePrivateMutationAuthority,
} from './workspace-state-mutations.js';

const INITIAL_PROMPT_CONTROLLER_ID = 'backend:initial-prompt-delivery:v1';
const INITIAL_PROMPT_LEASE_OWNER_ID = 'backend:initial-prompt-delivery-owner:v1';
const MAX_OBSERVATION_TAIL_BYTES = 65_536;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TASK_INITIAL_PROMPT_RUNTIME_DISCOVERY_MS = 1_000;

type ObservationTimerHandle = ReturnType<typeof setTimeout>;

export interface ProductionTaskInitialPromptRuntimeAdapters {
  acquireLease: typeof acquireTaskCommandLease;
  clearTimer(handle: ObservationTimerHandle): void;
  getAgentGeneration: typeof getAgentLifecycleGeneration;
  getAgentMetadata: typeof getAgentMeta;
  getAgentScrollback: typeof getAgentScrollbackBuffer;
  getSupervision: typeof getAgentSupervisionSnapshot;
  nowMs(): number;
  releaseLease: typeof releaseTaskCommandLease;
  scheduleTimer(callback: () => void, delayMs: number): ObservationTimerHandle;
  subscribeSupervision(listener: (event: AgentSupervisionEvent) => void): () => void;
}

export interface CreateProductionTaskInitialPromptRuntimeDependencies {
  adapters?: Partial<ProductionTaskInitialPromptRuntimeAdapters>;
  authorize?: (action: TaskInitialPromptDeliveryAction, taskId: string | null) => boolean;
  clock?: TaskInitialPromptDeliveryClock;
  persistence?: WorkspaceTaskInitialPromptPersistence;
  privateAuthority?: WorkspacePrivateMutationAuthority;
  promptInputAdmission: TaskPromptInputAdmissionService;
  removalGate: TaskRemovalParticipantGate<typeof TASK_INITIAL_PROMPT_HOOK_SET_VERSION>;
  structure: TaskStructureMutationService;
  workspace: WorkspaceMutationService;
}

export interface ProductionTaskInitialPromptRuntime {
  activate(): Promise<Extract<TaskInitialPromptOwnerAvailability, { kind: 'active' }>>;
  close(): Promise<void>;
  getHandlers(): ActiveTaskInitialPromptDeliveryHandlers | null;
  persistence: WorkspaceTaskInitialPromptPersistence;
  removalParticipant: TaskRemovalOwnerParticipant;
  service: TaskInitialPromptDeliveryService;
  startup(): Promise<void>;
  subscribe(listener: (projection: TaskInitialPromptDeliveryProjection) => void): () => void;
}

interface TrackedDelivery {
  activityObservedWhileVerifying: boolean;
  agentId: string;
  generation?: number;
  lastOutputAtMs?: number;
  state?: AgentSupervisionState;
  status: TaskInitialPromptDeliverySnapshot['status'];
  taskId: string;
}

interface ScheduledObservation {
  dueAtMs: number;
  handle: ObservationTimerHandle;
}

interface PendingManualFinalization {
  handle?: ObservationTimerHandle;
  request: SendTaskInitialPromptManuallyRequest;
  running?: Promise<void>;
}

const DEFAULT_ADAPTERS: ProductionTaskInitialPromptRuntimeAdapters = {
  acquireLease: acquireTaskCommandLease,
  clearTimer: (handle) => clearTimeout(handle),
  getAgentGeneration: getAgentLifecycleGeneration,
  getAgentMetadata: getAgentMeta,
  getAgentScrollback: getAgentScrollbackBuffer,
  getSupervision: getAgentSupervisionSnapshot,
  nowMs: Date.now,
  releaseLease: releaseTaskCommandLease,
  scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  subscribeSupervision: subscribeAgentSupervision,
};

function isTerminalDelivery(snapshot: TaskInitialPromptDeliverySnapshot): boolean {
  return (
    snapshot.status === 'cancelled' ||
    snapshot.status === 'delivered' ||
    snapshot.status === 'manual-required'
  );
}

function tailFromBuffer(buffer: Buffer | null): string {
  if (!buffer || buffer.byteLength === 0) return '';
  return buffer.subarray(Math.max(0, buffer.byteLength - MAX_OBSERVATION_TAIL_BYTES)).toString();
}

function isUsableSupervisionSnapshot(
  snapshot: AgentSupervisionSnapshot | null,
): snapshot is AgentSupervisionSnapshot & { generation: number; supervisionVersion: number } {
  return (
    snapshot !== null &&
    !snapshot.isShell &&
    snapshot.generation !== undefined &&
    snapshot.supervisionVersion !== undefined
  );
}

/**
 * Owns D01's production effects and observation loop. Persistence/removal
 * hooks may start dark, while public handlers and PTY admission become
 * reachable only after one exact generic-removal epoch is re-read.
 */
export function createProductionTaskInitialPromptRuntime(
  dependencies: CreateProductionTaskInitialPromptRuntimeDependencies,
): ProductionTaskInitialPromptRuntime {
  const adapters = { ...DEFAULT_ADAPTERS, ...dependencies.adapters };
  const clock: TaskInitialPromptDeliveryClock =
    dependencies.clock ??
    ({
      nowMs: () => adapters.nowMs(),
      sleep: (delayMs) =>
        new Promise<void>((resolve) => {
          adapters.scheduleTimer(resolve, delayMs);
        }),
      toIso: (ms) => new Date(ms).toISOString(),
    } satisfies TaskInitialPromptDeliveryClock);
  const persistence =
    dependencies.persistence ??
    createWorkspaceTaskInitialPromptPersistence(dependencies.workspace, {
      ...(dependencies.privateAuthority ? { privateAuthority: dependencies.privateAuthority } : {}),
      now: clock.nowMs,
    });
  const removalGate = dependencies.removalGate;
  const trackedByDeliveryId = new Map<string, TrackedDelivery>();
  const deliveryIdsByAgentId = new Map<string, Set<string>>();
  const observationTailByDeliveryId = new Map<string, Promise<void>>();
  const timersByDeliveryId = new Map<string, ScheduledObservation>();
  const pendingManualFinalizations = new Map<string, PendingManualFinalization>();
  const pendingProjectionPublications = new Set<string>();
  const projectionListeners = new Set<(projection: TaskInitialPromptDeliveryProjection) => void>();
  let activeEpoch: string | null = null;
  let activeHandlers: ActiveTaskInitialPromptDeliveryHandlers | null = null;
  let activationPromise: Promise<
    Extract<TaskInitialPromptOwnerAvailability, { kind: 'active' }>
  > | null = null;
  let startupPromise: Promise<void> | null = null;
  let stopSupervisionSubscription: (() => void) | null = null;
  let closed = false;

  async function publishPendingProjection(deliveryId: string): Promise<boolean> {
    if (!pendingProjectionPublications.has(deliveryId)) return true;
    if (closed) return false;
    if (projectionListeners.size === 0) {
      // Subscribers bootstrap with an explicit getProjection call, so there
      // is no historical event to retain when nobody is listening.
      pendingProjectionPublications.delete(deliveryId);
      return true;
    }
    if (getOwnerAvailability().kind !== 'active') return false;
    const projection = await coreService.getProjection(deliveryId);
    if (!projection) return false;
    for (const listener of projectionListeners) {
      try {
        listener(structuredClone(projection));
      } catch {
        // A renderer event sink must not change delivery state or make a
        // successfully committed operation appear to have failed.
      }
    }
    pendingProjectionPublications.delete(deliveryId);
    return true;
  }

  function publishProjection(deliveryId: string): Promise<boolean> {
    pendingProjectionPublications.add(deliveryId);
    return publishPendingProjection(deliveryId);
  }

  function getOwnerAvailability(): TaskInitialPromptOwnerAvailability {
    if (closed || activeEpoch === null) {
      return { kind: 'dark', reason: 'delivery-owner-dark' };
    }
    if (!persistence.journal.isAvailable()) {
      return { kind: 'unavailable', reason: 'journal-unavailable' };
    }
    const capability = dependencies.structure.getTaskRemovalOwnerCapability();
    const probe = removalGate.getTaskSnapshot('initial-prompt-owner-availability-probe');
    if (
      !capability ||
      capability.cutoverEpoch !== activeEpoch ||
      capability.hookSetVersions['initial-prompt'] !== TASK_INITIAL_PROMPT_HOOK_SET_VERSION ||
      probe.kind !== 'active' ||
      probe.cutoverEpoch !== activeEpoch ||
      probe.hookSetVersion !== TASK_INITIAL_PROMPT_HOOK_SET_VERSION
    ) {
      return { kind: 'unavailable', reason: 'task-removal-gate-unavailable' };
    }
    return {
      cutoverEpoch: activeEpoch,
      hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
      kind: 'active',
    };
  }

  function isTaskClosing(taskId: string): boolean {
    const availability = getOwnerAvailability();
    const gate = removalGate.getTaskSnapshot(taskId);
    return (
      availability.kind !== 'active' ||
      gate.kind !== 'active' ||
      gate.cutoverEpoch !== availability.cutoverEpoch ||
      gate.current.taskState !== 'present' ||
      gate.current.taskClosing
    );
  }

  function getAgentRuntime(agentId: string): TaskInitialPromptAgentRuntimeSnapshot | null {
    const generation = adapters.getAgentGeneration(agentId);
    const metadata = adapters.getAgentMetadata(agentId);
    const supervision = adapters.getSupervision(agentId);
    if (
      generation === null ||
      !metadata ||
      metadata.isShell ||
      metadata.generation !== generation ||
      !isUsableSupervisionSnapshot(supervision) ||
      supervision.generation !== generation ||
      supervision.taskId !== metadata.taskId
    ) {
      return null;
    }
    return {
      generation,
      lastOutputAtMs: supervision.lastOutputAt ?? 0,
      state: supervision.state,
      supervisionVersion: supervision.supervisionVersion,
      tail: tailFromBuffer(adapters.getAgentScrollback(agentId)),
      taskId: metadata.taskId,
    };
  }

  const coreService = createTaskInitialPromptDeliveryService({
    async acquireCommandLease({ taskId }) {
      if (getOwnerAvailability().kind !== 'active' || isTaskClosing(taskId)) return null;
      const lease = adapters.acquireLease(
        taskId,
        INITIAL_PROMPT_CONTROLLER_ID,
        INITIAL_PROMPT_LEASE_OWNER_ID,
        'deliver initial prompt',
      );
      if (!lease.acquired) return null;
      const leaseGeneration = lease.leaseGeneration;
      return {
        controllerId: INITIAL_PROMPT_CONTROLLER_ID,
        leaseGeneration,
        leaseOwnerId: INITIAL_PROMPT_LEASE_OWNER_ID,
        release: () => {
          adapters.releaseLease(
            taskId,
            INITIAL_PROMPT_CONTROLLER_ID,
            INITIAL_PROMPT_LEASE_OWNER_ID,
            clock.nowMs(),
            leaseGeneration,
          );
        },
      };
    },
    admitPrompt: (expectation, dispatch) =>
      dependencies.promptInputAdmission.admit(expectation, dispatch),
    clock,
    draftRepository: persistence.repository,
    getAgentRuntime,
    getOwnerAvailability,
    journal: persistence.journal,
    removalGate,
  });

  function clearObservationTimer(deliveryId: string): void {
    const timer = timersByDeliveryId.get(deliveryId);
    if (!timer) return;
    timersByDeliveryId.delete(deliveryId);
    adapters.clearTimer(timer.handle);
  }

  function untrackDelivery(deliveryId: string): void {
    clearObservationTimer(deliveryId);
    pendingProjectionPublications.delete(deliveryId);
    const tracked = trackedByDeliveryId.get(deliveryId);
    trackedByDeliveryId.delete(deliveryId);
    observationTailByDeliveryId.delete(deliveryId);
    if (!tracked) return;
    const deliveryIds = deliveryIdsByAgentId.get(tracked.agentId);
    deliveryIds?.delete(deliveryId);
    if (deliveryIds?.size === 0) deliveryIdsByAgentId.delete(tracked.agentId);
  }

  function clearManualFinalization(deliveryId: string): void {
    const pending = pendingManualFinalizations.get(deliveryId);
    if (pending?.handle) adapters.clearTimer(pending.handle);
    pendingManualFinalizations.delete(deliveryId);
  }

  function clearExactManualFinalization(deliveryId: string, manualSendOperationId: string): void {
    if (
      pendingManualFinalizations.get(deliveryId)?.request.manualSendOperationId !==
      manualSendOperationId
    ) {
      return;
    }
    clearManualFinalization(deliveryId);
  }

  function scheduleManualFinalization(
    request: SendTaskInitialPromptManuallyRequest,
    delayMs = TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS,
  ): void {
    if (closed) return;
    const existing = pendingManualFinalizations.get(request.deliveryId);
    if (existing?.handle || existing?.running) return;
    const pending: PendingManualFinalization = existing ?? { request: structuredClone(request) };
    pending.request = structuredClone(request);
    const handle = adapters.scheduleTimer(() => {
      if (pendingManualFinalizations.get(request.deliveryId)?.handle !== handle) return;
      Reflect.deleteProperty(pending, 'handle');
      let shouldRetry = false;
      const running = (async () => {
        try {
          const projection = await coreService.getProjection(request.deliveryId);
          if (!projection) {
            shouldRetry = true;
            return;
          }
          if (
            projection.manualSendOperation?.manualSendOperationId !==
              request.manualSendOperationId ||
            projection.manualSendOperation.phase !== 'write-accepted'
          ) {
            clearExactManualFinalization(request.deliveryId, request.manualSendOperationId);
            return;
          }
          const result = await coreService.sendManually(request);
          await publishProjection(request.deliveryId);
          if (
            result.kind === 'operation' &&
            result.operation.manualSendOperationId === request.manualSendOperationId &&
            result.operation.phase !== 'write-accepted'
          ) {
            clearExactManualFinalization(request.deliveryId, request.manualSendOperationId);
            return;
          }
          // A rejection proves nothing about the accepted operation observed
          // immediately above. Preserve its finalizer across a competing
          // request or a transient gate/owner transition.
          shouldRetry = true;
        } catch {
          shouldRetry = true;
        }
      })().finally(() => {
        if (pending.running === running) Reflect.deleteProperty(pending, 'running');
        if (shouldRetry && pendingManualFinalizations.get(request.deliveryId) === pending) {
          scheduleManualFinalization(request);
        }
      });
      pending.running = running;
    }, delayMs);
    pending.handle = handle;
    pendingManualFinalizations.set(request.deliveryId, pending);
  }

  function trackDelivery(
    request: TaskInitialPromptDeliveryRequest,
    snapshot: TaskInitialPromptDeliverySnapshot,
  ) {
    if (isTerminalDelivery(snapshot)) {
      untrackDelivery(request.deliveryId);
      return;
    }
    const prior = trackedByDeliveryId.get(request.deliveryId);
    if (prior && prior.agentId !== request.agentId) untrackDelivery(request.deliveryId);
    trackedByDeliveryId.set(request.deliveryId, {
      activityObservedWhileVerifying: prior?.activityObservedWhileVerifying ?? false,
      agentId: request.agentId,
      ...(prior?.generation !== undefined ? { generation: prior.generation } : {}),
      ...(prior?.lastOutputAtMs !== undefined ? { lastOutputAtMs: prior.lastOutputAtMs } : {}),
      ...(prior?.state !== undefined ? { state: prior.state } : {}),
      status: snapshot.status,
      taskId: request.taskId,
    });
    const deliveryIds = deliveryIdsByAgentId.get(request.agentId) ?? new Set<string>();
    deliveryIds.add(request.deliveryId);
    deliveryIdsByAgentId.set(request.agentId, deliveryIds);
  }

  function observationDelay(
    snapshot: TaskInitialPromptDeliverySnapshot,
    runtime: TaskInitialPromptAgentRuntimeSnapshot,
  ): number | null {
    const nowMs = clock.nowMs();
    if (snapshot.status === 'waiting-ready') {
      if (runtime.state !== 'idle-at-prompt') {
        return TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS;
      }
      return Math.max(
        1,
        TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS,
        TASK_INITIAL_PROMPT_QUIESCENCE_MS - (nowMs - runtime.lastOutputAtMs),
      );
    }
    if (snapshot.status === 'waiting-lease') return TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS;
    if (snapshot.status === 'verifying') return TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS;
    return null;
  }

  function scheduleObservationAfter(deliveryId: string, delay: number | null): void {
    if (delay === null || closed) {
      clearObservationTimer(deliveryId);
      return;
    }
    const boundedDelay = Math.min(MAX_TIMER_DELAY_MS, Math.ceil(delay));
    const dueAtMs = clock.nowMs() + boundedDelay;
    const existing = timersByDeliveryId.get(deliveryId);
    if (existing && existing.dueAtMs <= dueAtMs) return;
    clearObservationTimer(deliveryId);
    const handle = adapters.scheduleTimer(() => {
      if (timersByDeliveryId.get(deliveryId)?.handle !== handle) return;
      timersByDeliveryId.delete(deliveryId);
      void enqueueCurrentObservation(deliveryId);
    }, boundedDelay);
    timersByDeliveryId.set(deliveryId, { dueAtMs, handle });
  }

  function scheduleObservation(
    deliveryId: string,
    snapshot: TaskInitialPromptDeliverySnapshot,
    runtime: TaskInitialPromptAgentRuntimeSnapshot,
  ): void {
    scheduleObservationAfter(deliveryId, observationDelay(snapshot, runtime));
  }

  function scheduleRuntimeDiscovery(deliveryId: string, tracked: TrackedDelivery): void {
    scheduleObservationAfter(
      deliveryId,
      tracked.status === 'verifying'
        ? TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS
        : TASK_INITIAL_PROMPT_RUNTIME_DISCOVERY_MS,
    );
  }

  function serializeTrackedDeliveryTurn(
    deliveryId: string,
    operation: (tracked: TrackedDelivery) => Promise<void>,
  ): Promise<void> {
    const predecessor = observationTailByDeliveryId.get(deliveryId) ?? Promise.resolve();
    const turn = predecessor
      .catch(() => undefined)
      .then(async () => {
        const latest = trackedByDeliveryId.get(deliveryId);
        if (!latest || closed) return;
        try {
          await operation(latest);
        } catch {
          // Timer and supervision callbacks have no request caller to retry
          // them. Keep the nonterminal delivery observable after transient
          // journal, admission, or projection failures.
          if (!closed && trackedByDeliveryId.has(deliveryId)) {
            scheduleObservationAfter(deliveryId, TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);
          }
        }
      })
      .finally(() => {
        if (observationTailByDeliveryId.get(deliveryId) === turn) {
          observationTailByDeliveryId.delete(deliveryId);
        }
      });
    observationTailByDeliveryId.set(deliveryId, turn);
    return turn;
  }

  function processObservation(
    deliveryId: string,
    runtime: TaskInitialPromptAgentRuntimeSnapshot,
  ): Promise<void> {
    const tracked = trackedByDeliveryId.get(deliveryId);
    if (!tracked) return Promise.resolve();
    if (runtime.taskId !== tracked.taskId) return processDeadlineWithoutRuntime(deliveryId);
    return serializeTrackedDeliveryTurn(deliveryId, async (latest) => {
      const sameGeneration = latest.generation === runtime.generation;
      const outputAdvanced =
        sameGeneration &&
        latest.lastOutputAtMs !== undefined &&
        runtime.lastOutputAtMs > latest.lastOutputAtMs;
      const stateBecameActive =
        sameGeneration &&
        latest.state === 'idle-at-prompt' &&
        runtime.state !== 'idle-at-prompt' &&
        runtime.state !== 'exited-clean' &&
        runtime.state !== 'exited-error';
      const activityTransitionObserved =
        latest.status === 'verifying' && (outputAdvanced || stateBecameActive);
      const activityObservedWhileVerifying =
        latest.status === 'verifying' &&
        (latest.activityObservedWhileVerifying || activityTransitionObserved);
      const observation: TaskInitialPromptAgentObservation = {
        ...(activityTransitionObserved ? { activityTransitionObserved: true } : {}),
        agentId: latest.agentId,
        generation: runtime.generation,
        lastOutputAtMs: runtime.lastOutputAtMs,
        nowMs: clock.nowMs(),
        ...(activityObservedWhileVerifying && runtime.state === 'idle-at-prompt'
          ? { returnedToReadySnapshot: true }
          : {}),
        state: runtime.state,
        supervisionVersion: runtime.supervisionVersion,
        tail: runtime.tail,
      };
      const result = await coreService.processObservation(deliveryId, observation);
      if (result.kind === 'missing') {
        untrackDelivery(deliveryId);
        return;
      }
      if (result.kind !== 'snapshot') {
        scheduleObservationAfter(deliveryId, TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);
        return;
      }
      const enteredVerifying =
        latest.status !== 'verifying' && result.snapshot.status === 'verifying';
      latest.status = result.snapshot.status;
      latest.generation = runtime.generation;
      latest.lastOutputAtMs = runtime.lastOutputAtMs;
      latest.state = runtime.state;
      latest.activityObservedWhileVerifying = enteredVerifying
        ? false
        : result.snapshot.status === 'verifying' && activityObservedWhileVerifying;
      if (isTerminalDelivery(result.snapshot)) {
        if (await publishProjection(deliveryId)) untrackDelivery(deliveryId);
        else scheduleObservationAfter(deliveryId, TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);
        return;
      }
      scheduleObservation(deliveryId, result.snapshot, runtime);
      await publishProjection(deliveryId);
    });
  }

  function processDeadlineWithoutRuntime(deliveryId: string): Promise<void> {
    return serializeTrackedDeliveryTurn(deliveryId, async (latest) => {
      const result = await coreService.expireDueDelivery(deliveryId, clock.nowMs());
      if (result.kind === 'missing') {
        untrackDelivery(deliveryId);
        return;
      }
      if (result.kind !== 'snapshot') {
        scheduleObservationAfter(deliveryId, TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);
        return;
      }
      const statusChanged = latest.status !== result.snapshot.status;
      latest.status = result.snapshot.status;
      if (statusChanged) pendingProjectionPublications.add(deliveryId);
      if (isTerminalDelivery(result.snapshot)) {
        if (await publishPendingProjection(deliveryId)) untrackDelivery(deliveryId);
        else scheduleObservationAfter(deliveryId, TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);
        return;
      }
      scheduleRuntimeDiscovery(deliveryId, latest);
      await publishPendingProjection(deliveryId);
    });
  }

  function enqueueCurrentObservation(deliveryId: string): Promise<void> {
    const tracked = trackedByDeliveryId.get(deliveryId);
    if (!tracked) return Promise.resolve();
    const runtime = getAgentRuntime(tracked.agentId);
    if (runtime?.taskId === tracked.taskId) return processObservation(deliveryId, runtime);
    return processDeadlineWithoutRuntime(deliveryId);
  }

  function runtimeFromEvent(
    tracked: TrackedDelivery,
    snapshot: AgentSupervisionSnapshot,
  ): TaskInitialPromptAgentRuntimeSnapshot | null {
    if (
      !isUsableSupervisionSnapshot(snapshot) ||
      snapshot.agentId !== tracked.agentId ||
      snapshot.taskId !== tracked.taskId
    ) {
      return null;
    }
    const metadata = adapters.getAgentMetadata(snapshot.agentId);
    const exited = snapshot.state === 'exited-clean' || snapshot.state === 'exited-error';
    if (
      !exited &&
      (!metadata ||
        metadata.isShell ||
        metadata.taskId !== snapshot.taskId ||
        metadata.generation !== snapshot.generation)
    ) {
      return null;
    }
    if (
      metadata &&
      (metadata.isShell ||
        metadata.taskId !== snapshot.taskId ||
        metadata.generation !== snapshot.generation)
    ) {
      return null;
    }
    return {
      generation: snapshot.generation,
      lastOutputAtMs: snapshot.lastOutputAt ?? tracked.lastOutputAtMs ?? 0,
      state: snapshot.state,
      supervisionVersion: snapshot.supervisionVersion,
      tail: tailFromBuffer(adapters.getAgentScrollback(snapshot.agentId)),
      taskId: snapshot.taskId,
    };
  }

  function handleSupervisionEvent(event: AgentSupervisionEvent): void {
    if (closed || getOwnerAvailability().kind !== 'active') return;
    const deliveryIds = deliveryIdsByAgentId.get(event.agentId);
    if (!deliveryIds) return;
    for (const deliveryId of [...deliveryIds]) {
      const tracked = trackedByDeliveryId.get(deliveryId);
      if (!tracked) continue;
      if (event.kind === 'removed') {
        if (tracked.generation === undefined) continue;
        void processObservation(deliveryId, {
          generation: tracked.generation,
          lastOutputAtMs: tracked.lastOutputAtMs ?? clock.nowMs(),
          state: 'exited-error',
          supervisionVersion: 0,
          tail: '',
          taskId: tracked.taskId,
        });
        continue;
      }
      const runtime = runtimeFromEvent(tracked, event);
      if (runtime) void processObservation(deliveryId, runtime);
    }
  }

  async function queue(
    request: TaskInitialPromptDeliveryRequest,
  ): Promise<QueueTaskInitialPromptDeliveryResult> {
    const result = await coreService.queue(request);
    if (result.kind !== 'accepted') return result;
    trackDelivery(request, result.snapshot);
    try {
      await enqueueCurrentObservation(request.deliveryId);
    } catch {
      scheduleObservationAfter(request.deliveryId, TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);
    }
    try {
      await publishProjection(request.deliveryId);
    } catch {
      scheduleObservationAfter(request.deliveryId, TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);
    }
    return result;
  }

  function untrackTask(taskId: string): void {
    for (const [deliveryId, tracked] of trackedByDeliveryId) {
      if (tracked.taskId === taskId) untrackDelivery(deliveryId);
    }
    for (const [deliveryId, pending] of pendingManualFinalizations) {
      if (pending.request.taskId === taskId) clearManualFinalization(deliveryId);
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    activeEpoch = null;
    activeHandlers = null;
    stopSupervisionSubscription?.();
    stopSupervisionSubscription = null;
    for (const deliveryId of [...timersByDeliveryId.keys()]) clearObservationTimer(deliveryId);
    for (const deliveryId of [...pendingManualFinalizations.keys()]) {
      const pending = pendingManualFinalizations.get(deliveryId);
      if (pending?.handle) adapters.clearTimer(pending.handle);
      Reflect.deleteProperty(pending ?? {}, 'handle');
    }
    await Promise.allSettled([...observationTailByDeliveryId.values()]);
    await Promise.allSettled(
      [...pendingManualFinalizations.values()]
        .map((pending) => pending.running)
        .filter((running): running is Promise<void> => running !== undefined),
    );
    observationTailByDeliveryId.clear();
    trackedByDeliveryId.clear();
    deliveryIdsByAgentId.clear();
    pendingManualFinalizations.clear();
    pendingProjectionPublications.clear();
    projectionListeners.clear();
    await coreService.close();
  }

  const service: TaskInitialPromptDeliveryService = {
    close,
    async drainTaskForRemoval(request) {
      const result = await coreService.drainTaskForRemoval(request);
      if (result.kind !== 'retry-required') untrackTask(request.taskId);
      return result;
    },
    async finalizeRemovedTaskInitialPromptState(request) {
      const result = await coreService.finalizeRemovedTaskInitialPromptState(request);
      if (result.kind !== 'retry-required') untrackTask(request.taskId);
      return result;
    },
    getOwnerAvailability,
    getProjection: (deliveryId) => coreService.getProjection(deliveryId),
    async expireDueDelivery(deliveryId, nowMs) {
      const result = await coreService.expireDueDelivery(deliveryId, nowMs);
      if (result.kind === 'snapshot') {
        const tracked = trackedByDeliveryId.get(deliveryId);
        if (tracked) tracked.status = result.snapshot.status;
        const published = await publishProjection(deliveryId);
        if (isTerminalDelivery(result.snapshot) && published) untrackDelivery(deliveryId);
      }
      return result;
    },
    probeRemovalHooks: () => coreService.probeRemovalHooks(),
    async processObservation(deliveryId, observation) {
      const result = await coreService.processObservation(deliveryId, observation);
      if (result.kind === 'snapshot') await publishProjection(deliveryId);
      return result;
    },
    queue,
    repairAfterRestart: () => coreService.repairAfterRestart(),
    async resolveManualAmbiguity(request) {
      const result = await coreService.resolveManualAmbiguity(request);
      const projection = result.kind === 'resolved' ? result.projection : result.current;
      if (projection) await publishProjection(projection.delivery.deliveryId);
      return result;
    },
    async reviseDraft(request) {
      const result = await coreService.reviseDraft(request);
      await publishProjection(request.sourceDeliveryId);
      return result;
    },
    async sendManually(request) {
      try {
        const result = await coreService.sendManually(request);
        if (result.kind === 'operation' && result.operation.phase === 'write-accepted') {
          scheduleManualFinalization(request);
        } else if (
          result.kind === 'operation' &&
          result.operation.manualSendOperationId === request.manualSendOperationId
        ) {
          clearExactManualFinalization(request.deliveryId, request.manualSendOperationId);
        }
        await publishProjection(request.deliveryId);
        return result;
      } catch (error) {
        // Probe durable state before any automatic replay. The scheduled turn
        // only replays when it can prove this exact operation is write-accepted.
        scheduleManualFinalization(request);
        throw error;
      }
    },
  };
  const removalParticipant = createTaskInitialPromptRemovalParticipant({
    persistence,
    service,
  });

  async function startup(): Promise<void> {
    if (closed) throw new Error('Initial prompt runtime is closed');
    startupPromise ??= persistence.ensureDarkJournalReady().catch((error: unknown) => {
      startupPromise = null;
      throw error;
    });
    return startupPromise;
  }

  async function runActivation(): Promise<
    Extract<TaskInitialPromptOwnerAvailability, { kind: 'active' }>
  > {
    await startup();
    const capability = dependencies.structure.getTaskRemovalOwnerCapability();
    if (
      !capability ||
      capability.hookSetVersions['initial-prompt'] !== TASK_INITIAL_PROMPT_HOOK_SET_VERSION
    ) {
      throw new Error('Initial prompt activation requires its exact generic-removal participant');
    }
    await persistence.verifyPromptProtectionCutover(capability.cutoverEpoch);
    const probe = removalGate.getTaskSnapshot('initial-prompt-owner-activation-probe');
    if (
      probe.kind !== 'active' ||
      probe.cutoverEpoch !== capability.cutoverEpoch ||
      probe.hookSetVersion !== TASK_INITIAL_PROMPT_HOOK_SET_VERSION
    ) {
      throw new Error('Initial prompt activation gate is unavailable or mismatched');
    }

    await coreService.repairAfterRestart();
    const records = await persistence.journal.listRecords();
    for (const record of records) trackDelivery(record.request, record.snapshot);

    activeEpoch = capability.cutoverEpoch;
    stopSupervisionSubscription = adapters.subscribeSupervision(handleSupervisionEvent);
    const active = getOwnerAvailability();
    if (active.kind !== 'active') {
      stopSupervisionSubscription();
      stopSupervisionSubscription = null;
      activeEpoch = null;
      throw new Error('Initial prompt owner capability changed during activation');
    }
    activeHandlers = createActiveTaskInitialPromptDeliveryHandlers({
      authorize: dependencies.authorize ?? (() => false),
      service,
    });
    await Promise.all([...trackedByDeliveryId.keys()].map(enqueueCurrentObservation));
    return active;
  }

  function activate(): Promise<Extract<TaskInitialPromptOwnerAvailability, { kind: 'active' }>> {
    if (closed) return Promise.reject(new Error('Initial prompt runtime is closed'));
    const current = getOwnerAvailability();
    if (current.kind === 'active') return Promise.resolve(current);
    activationPromise ??= runActivation().catch((error: unknown) => {
      activeHandlers = null;
      activeEpoch = null;
      stopSupervisionSubscription?.();
      stopSupervisionSubscription = null;
      activationPromise = null;
      throw error;
    });
    return activationPromise;
  }

  return {
    activate,
    close,
    getHandlers: () => (getOwnerAvailability().kind === 'active' ? activeHandlers : null),
    persistence,
    removalParticipant,
    service,
    startup,
    subscribe(listener) {
      if (getOwnerAvailability().kind !== 'active') {
        throw new Error('Initial prompt subscriptions require the active delivery owner');
      }
      projectionListeners.add(listener);
      return () => projectionListeners.delete(listener);
    },
  };
}
