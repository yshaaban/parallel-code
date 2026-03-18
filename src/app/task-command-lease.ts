import { IPC } from '../../electron/ipc/channels';
import type {
  TaskCommandTakeoverRequestMessage,
  TaskCommandTakeoverResultMessage as ProtocolTaskCommandTakeoverResultMessage,
} from '../../electron/remote/protocol';
import type { RendererInvokeResponseMap } from '../domain/renderer-invoke';
import { isTypingTaskCommandFocusedSurface } from '../domain/task-command-focus';
import { assertNever } from '../lib/assert-never';
import { confirm } from '../lib/dialog';
import {
  invoke,
  isElectronRuntime,
  onBrowserTransportEvent,
  sendImmediateBrowserControlMessage,
} from '../lib/ipc';
import { getFallbackDisplayName } from '../lib/display-name';
import { getRuntimeClientId, getRuntimeLeaseOwnerId } from '../lib/runtime-client-id';
import { store } from '../store/core';
import { getPeerDisplayName } from '../store/peer-presence';
import {
  applyTaskCommandControllerChanged,
  subscribeTaskCommandControllerChanges,
} from '../store/task-command-controllers';
import {
  clearIncomingTaskTakeoverRequest,
  clearIncomingTaskTakeoverRequests,
  getIncomingTaskTakeoverRequest,
  hasIncomingTaskTakeoverRequests,
  upsertIncomingTaskTakeoverRequest,
} from '../store/task-command-takeovers';

const TASK_COMMAND_LEASE_RENEW_MS = 5_000;
const TASK_COMMAND_LEASE_SESSION_IDLE_MS = 5_000;

export const TASK_COMMAND_LEASE_SKIPPED = Symbol('task-command-lease-skipped');

export type TaskCommandLeaseResult<T> = T | typeof TASK_COMMAND_LEASE_SKIPPED;

interface TaskCommandLeaseOptions {
  confirmTakeover?: boolean;
  takeover?: boolean;
}

interface TaskCommandTakeoverResultMessage {
  decision: 'approved' | 'denied' | 'force-required' | 'owner-missing' | 'transport-unavailable';
  requestId: string;
  taskId: string;
}

type TaskCommandTakeoverDecision = TaskCommandTakeoverResultMessage['decision'];
type TaskCommandLeaseAcquireResult = RendererInvokeResponseMap[IPC.AcquireTaskCommandLease];

interface LocalTaskCommandLease {
  acquirePromise: Promise<boolean> | undefined;
  actionDescription: string;
  holdCount: number;
  renewTimer: ReturnType<typeof globalThis.setInterval> | undefined;
}

const localTaskCommandLeases = new Map<string, LocalTaskCommandLease>();
const pendingTaskCommandTakeovers = new Map<
  string,
  {
    resolve: (result: TaskCommandTakeoverDecision) => void;
    timer: ReturnType<typeof globalThis.setTimeout>;
  }
>();
const taskCommandLeaseSessionInvalidators = new Map<string, Set<() => void>>();
let removeTaskCommandControllerSubscription: (() => void) | null = null;
let removeTaskCommandLeaseTransportSubscription: (() => void) | null = null;
let taskCommandLeaseTransportUnavailable = false;
let taskCommandLeaseTransportGeneration = 0;

function clearTaskCommandLeaseSubscriptions(): void {
  removeTaskCommandControllerSubscription?.();
  removeTaskCommandControllerSubscription = null;
  removeTaskCommandLeaseTransportSubscription?.();
  removeTaskCommandLeaseTransportSubscription = null;
}

function clearPendingTaskCommandTakeover(requestId: string): void {
  const pendingTakeover = pendingTaskCommandTakeovers.get(requestId);
  if (!pendingTakeover) {
    return;
  }

  clearTimeout(pendingTakeover.timer);
  pendingTaskCommandTakeovers.delete(requestId);
}

function addTaskCommandLeaseSessionInvalidator(taskId: string, invalidate: () => void): () => void {
  const invalidators = taskCommandLeaseSessionInvalidators.get(taskId) ?? new Set();
  invalidators.add(invalidate);
  taskCommandLeaseSessionInvalidators.set(taskId, invalidators);
  return () => {
    invalidators.delete(invalidate);
    if (invalidators.size === 0) {
      taskCommandLeaseSessionInvalidators.delete(taskId);
      cleanupIdleTaskCommandLeaseSubscriptions();
    }
  };
}

function invalidateTaskCommandLeaseSessions(taskId: string): void {
  const invalidators = taskCommandLeaseSessionInvalidators.get(taskId);
  if (!invalidators) {
    return;
  }

  for (const invalidate of Array.from(invalidators)) {
    invalidate();
  }
}

function invalidateAllTaskCommandLeaseSessions(): void {
  for (const taskId of taskCommandLeaseSessionInvalidators.keys()) {
    invalidateTaskCommandLeaseSessions(taskId);
  }
}

function clearAllTaskCommandLeaseRenewals(): void {
  for (const taskId of localTaskCommandLeases.keys()) {
    clearTaskCommandLeaseRenewal(taskId);
  }
}

function resolvePendingTaskCommandTakeover(
  requestId: string,
  decision: TaskCommandTakeoverDecision,
): void {
  const pendingTakeover = pendingTaskCommandTakeovers.get(requestId);
  if (!pendingTakeover) {
    return;
  }

  clearPendingTaskCommandTakeover(requestId);
  pendingTakeover.resolve(decision);
}

function resolveAllPendingTaskCommandTakeovers(decision: TaskCommandTakeoverDecision): void {
  for (const requestId of Array.from(pendingTaskCommandTakeovers.keys())) {
    resolvePendingTaskCommandTakeover(requestId, decision);
  }
}

function createPendingTaskCommandTakeover(requestId: string): Promise<TaskCommandTakeoverDecision> {
  return new Promise<TaskCommandTakeoverDecision>((resolve) => {
    const timer = globalThis.setTimeout(() => {
      pendingTaskCommandTakeovers.delete(requestId);
      resolve('force-required');
    }, 10_000);
    pendingTaskCommandTakeovers.set(requestId, {
      resolve,
      timer,
    });
  });
}

function getTaskCommandTimeoutMessage(
  actionDescription: string,
  controllerId: string | null,
  currentAction: string | null,
): string {
  const controllerLabel = controllerId
    ? (getPeerDisplayName(controllerId) ?? getFallbackDisplayName(controllerId))
    : 'another session';
  if (currentAction) {
    return `${controllerLabel} did not respond while controlling this task to ${currentAction}. Force takeover to ${actionDescription}?`;
  }

  return `${controllerLabel} did not respond. Force takeover to ${actionDescription}?`;
}

export function handleIncomingTaskCommandTakeoverRequest(
  message: TaskCommandTakeoverRequestMessage,
): void {
  ensureTaskCommandLeaseTransportSubscription();
  upsertIncomingTaskTakeoverRequest({
    action: message.action,
    expiresAt: message.expiresAt,
    requestId: message.requestId,
    requesterClientId: message.requesterClientId,
    requesterDisplayName: message.requesterDisplayName,
    taskId: message.taskId,
  });
}

export function handleTaskCommandTakeoverResult(
  message: ProtocolTaskCommandTakeoverResultMessage,
): void {
  resolvePendingTaskCommandTakeover(message.requestId, message.decision);
  clearIncomingTaskTakeoverRequestAndCleanup(message.requestId);
}

export async function respondToIncomingTaskCommandTakeover(
  requestId: string,
  approved: boolean,
): Promise<boolean> {
  const request = getIncomingTaskTakeoverRequest(requestId);
  if (!request) {
    return false;
  }

  try {
    await sendImmediateBrowserControlMessage({
      type: 'respond-task-command-takeover',
      approved,
      requestId: request.requestId,
    });
    return true;
  } catch {
    return false;
  }
}

export function expireIncomingTaskCommandTakeoverRequest(requestId: string): void {
  clearIncomingTaskTakeoverRequestAndCleanup(requestId);
}

async function requestTaskCommandTakeover(
  taskId: string,
  actionDescription: string,
  targetControllerId: string,
): Promise<TaskCommandTakeoverResultMessage['decision']> {
  if (isElectronRuntime()) {
    return 'approved';
  }

  const requestId = crypto.randomUUID();
  const resultPromise = createPendingTaskCommandTakeover(requestId);

  try {
    await sendImmediateBrowserControlMessage({
      type: 'request-task-command-takeover',
      action: actionDescription,
      requestId,
      targetControllerId,
      taskId,
    });
  } catch (error) {
    clearPendingTaskCommandTakeover(requestId);
    throw error;
  }

  return resultPromise;
}

export interface TaskCommandLeaseSession {
  acquire(): Promise<boolean>;
  cleanup(): void;
  release(): Promise<void>;
  takeOver(): Promise<boolean>;
  touch(): boolean;
}

async function acquireTaskCommandLease(
  taskId: string,
  clientId: string,
  ownerId: string,
  actionDescription: string,
  takeover: boolean,
): Promise<TaskCommandLeaseAcquireResult> {
  const result = await invoke(IPC.AcquireTaskCommandLease, {
    action: actionDescription,
    clientId,
    ownerId,
    taskId,
    ...(takeover ? { takeover: true } : {}),
  });
  applyTaskCommandControllerChanged(result);
  return result;
}

function shouldSkipTaskCommandTakeover(options: TaskCommandLeaseOptions): boolean {
  return options.confirmTakeover === false && options.takeover !== true;
}

function clearIncomingTaskTakeoverRequestAndCleanup(requestId: string): void {
  clearIncomingTaskTakeoverRequest(requestId);
  cleanupIdleTaskCommandLeaseSubscriptions();
}

function clearIncomingTaskTakeoverRequestsAndCleanup(): void {
  clearIncomingTaskTakeoverRequests();
  cleanupIdleTaskCommandLeaseSubscriptions();
}

async function confirmForcedTaskCommandTakeover(
  actionDescription: string,
  lease: TaskCommandLeaseAcquireResult,
): Promise<boolean> {
  return confirm(
    getTaskCommandTimeoutMessage(actionDescription, lease.controllerId, lease.action),
    {
      cancelLabel: 'Cancel',
      kind: 'warning',
      okLabel: 'Force Take Over',
      title: 'Task In Use',
    },
  ).catch(() => false);
}

async function shouldProceedWithTaskCommandTakeover(
  actionDescription: string,
  decision: TaskCommandTakeoverDecision,
  lease: TaskCommandLeaseAcquireResult,
): Promise<boolean> {
  switch (decision) {
    case 'approved':
    case 'owner-missing':
      return true;
    case 'force-required':
      return confirmForcedTaskCommandTakeover(actionDescription, lease);
    case 'denied':
    case 'transport-unavailable':
      return false;
    default:
      return assertNever(decision, 'Unhandled task-command takeover decision');
  }
}

async function resolveTaskCommandLeaseConflict(
  taskId: string,
  clientId: string,
  ownerId: string,
  actionDescription: string,
  lease: TaskCommandLeaseAcquireResult,
  options: TaskCommandLeaseOptions,
): Promise<boolean> {
  if (!lease.controllerId) {
    return false;
  }

  if (shouldSkipTaskCommandTakeover(options)) {
    return false;
  }

  const decision = await requestTaskCommandTakeover(
    taskId,
    actionDescription,
    lease.controllerId,
  ).catch(() => 'force-required' as const);

  const shouldProceed = await shouldProceedWithTaskCommandTakeover(
    actionDescription,
    decision,
    lease,
  );
  if (!shouldProceed) {
    return false;
  }

  const takeoverLease = await acquireTaskCommandLease(
    taskId,
    clientId,
    ownerId,
    actionDescription,
    true,
  );
  if (!takeoverLease.acquired) {
    throw new Error('Task is controlled by another client');
  }

  return true;
}

async function ensureTaskCommandLease(
  taskId: string,
  clientId: string,
  ownerId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions = {},
): Promise<boolean> {
  const lease = await acquireTaskCommandLease(taskId, clientId, ownerId, actionDescription, false);
  if (lease.acquired || lease.controllerId === clientId) {
    return true;
  }

  return resolveTaskCommandLeaseConflict(
    taskId,
    clientId,
    ownerId,
    actionDescription,
    lease,
    options,
  );
}

function startTaskCommandLeaseRenewal(
  taskId: string,
  clientId: string,
  ownerId: string,
): ReturnType<typeof globalThis.setInterval> {
  return globalThis.setInterval(() => {
    void invoke(IPC.RenewTaskCommandLease, {
      clientId,
      ownerId,
      taskId,
    })
      .then((result) => {
        applyTaskCommandControllerChanged(result);
        if (!hasLocalTaskCommandLeaseOwnership(taskId, clientId)) {
          clearTaskCommandLeaseRenewal(taskId);
        }
      })
      .catch(() => {});
  }, TASK_COMMAND_LEASE_RENEW_MS);
}

function clearTaskCommandLeaseRenewal(taskId: string): void {
  const lease = localTaskCommandLeases.get(taskId);
  if (!lease?.renewTimer) {
    return;
  }

  globalThis.clearInterval(lease.renewTimer);
  lease.renewTimer = undefined;
}

function handleTaskCommandControllerChanged({
  controllerId,
  taskId,
}: {
  controllerId: string | null;
  taskId: string;
}): void {
  if (controllerId === getRuntimeClientId()) {
    return;
  }
  clearTaskCommandLeaseRenewal(taskId);
  invalidateTaskCommandLeaseSessions(taskId);
}

function ensureTaskCommandControllerSubscription(): void {
  if (removeTaskCommandControllerSubscription) {
    return;
  }

  removeTaskCommandControllerSubscription = subscribeTaskCommandControllerChanges(
    handleTaskCommandControllerChanged,
  );
}

function ensureTaskCommandLeaseSubscriptions(): void {
  ensureTaskCommandControllerSubscription();
  ensureTaskCommandLeaseTransportSubscription();
}

function handleTaskCommandLeaseTransportUnavailable(): void {
  taskCommandLeaseTransportUnavailable = true;
  taskCommandLeaseTransportGeneration += 1;
  resolveAllPendingTaskCommandTakeovers('transport-unavailable');
  clearIncomingTaskTakeoverRequestsAndCleanup();
  clearAllTaskCommandLeaseRenewals();
  invalidateAllTaskCommandLeaseSessions();
}

function isTaskCommandLeaseTransportUnavailableState(
  state: 'auth-expired' | 'connected' | 'connecting' | 'disconnected' | 'reconnecting',
): boolean {
  switch (state) {
    case 'auth-expired':
    case 'disconnected':
    case 'reconnecting':
      return true;
    case 'connected':
    case 'connecting':
      return false;
    default:
      throw new Error(`Unhandled browser transport state: ${String(state)}`);
  }
}

function getTaskCommandLeaseTransportGeneration(): number {
  if (isElectronRuntime()) {
    return 0;
  }

  return taskCommandLeaseTransportGeneration;
}

function hasTaskCommandLeaseTransportAvailability(): boolean {
  return isElectronRuntime() || !taskCommandLeaseTransportUnavailable;
}

function ensureTaskCommandLeaseTransportSubscription(): void {
  if (isElectronRuntime() || removeTaskCommandLeaseTransportSubscription) {
    return;
  }

  removeTaskCommandLeaseTransportSubscription = onBrowserTransportEvent((event) => {
    if (event.kind !== 'connection') {
      return;
    }

    if (isTaskCommandLeaseTransportUnavailableState(event.state)) {
      handleTaskCommandLeaseTransportUnavailable();
      return;
    }

    if (event.state === 'connected') {
      taskCommandLeaseTransportUnavailable = false;
    }
  });
}

function getOrCreateLocalTaskCommandLease(
  taskId: string,
  actionDescription: string,
): LocalTaskCommandLease {
  const existingLease = localTaskCommandLeases.get(taskId);
  if (existingLease) {
    return existingLease;
  }

  const nextLease: LocalTaskCommandLease = {
    actionDescription,
    acquirePromise: undefined,
    holdCount: 0,
    renewTimer: undefined,
  };
  localTaskCommandLeases.set(taskId, nextLease);
  return nextLease;
}

function cleanupReleasedTaskCommandLease(taskId: string): void {
  const lease = localTaskCommandLeases.get(taskId);
  if (!lease) {
    cleanupIdleTaskCommandLeaseSubscriptions();
    return;
  }

  if (lease.holdCount > 0 || lease.acquirePromise || lease.renewTimer) {
    return;
  }

  localTaskCommandLeases.delete(taskId);
  cleanupIdleTaskCommandLeaseSubscriptions();
}

function hasTaskCommandLeaseSubscriptionActivity(): boolean {
  return (
    localTaskCommandLeases.size > 0 ||
    taskCommandLeaseSessionInvalidators.size > 0 ||
    hasIncomingTaskTakeoverRequests()
  );
}

function cleanupIdleTaskCommandLeaseSubscriptions(): void {
  if (hasTaskCommandLeaseSubscriptionActivity()) {
    return;
  }

  clearTaskCommandLeaseSubscriptions();
}

function hasLocalTaskCommandLeaseOwnership(taskId: string, clientId: string): boolean {
  const controller = store.taskCommandControllers[taskId];
  return controller?.controllerId === clientId;
}

function isTaskCommandLeaseAttemptCurrent(
  taskId: string,
  clientId: string,
  transportGeneration: number,
): boolean {
  return (
    transportGeneration === getTaskCommandLeaseTransportGeneration() &&
    hasTaskCommandLeaseTransportAvailability() &&
    hasLocalTaskCommandLeaseOwnership(taskId, clientId)
  );
}

function decrementTaskCommandLeaseHold(lease: LocalTaskCommandLease): void {
  lease.holdCount = Math.max(lease.holdCount - 1, 0);
}

function releaseFailedTaskCommandLeaseHold(taskId: string, lease: LocalTaskCommandLease): false {
  decrementTaskCommandLeaseHold(lease);
  cleanupReleasedTaskCommandLease(taskId);
  return false;
}

function updateLocalTaskCommandLeaseAction(
  lease: LocalTaskCommandLease,
  actionDescription: string,
): void {
  lease.actionDescription = actionDescription;
}

async function releaseTaskCommandLeaseToBackend(
  taskId: string,
  clientId: string,
  ownerId: string,
): Promise<void> {
  clearTaskCommandLeaseRenewal(taskId);
  const result = await invoke(IPC.ReleaseTaskCommandLease, {
    clientId,
    ownerId,
    taskId,
  }).catch(() => {});
  if (result) {
    applyTaskCommandControllerChanged(result);
  }
  cleanupReleasedTaskCommandLease(taskId);
}

async function retainTaskCommandLease(
  taskId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions = {},
): Promise<boolean> {
  ensureTaskCommandLeaseSubscriptions();
  const clientId = getRuntimeClientId();
  const ownerId = getRuntimeLeaseOwnerId();
  const lease = getOrCreateLocalTaskCommandLease(taskId, actionDescription);
  lease.holdCount += 1;

  async function refreshHeldLease(): Promise<boolean> {
    const transportGeneration = getTaskCommandLeaseTransportGeneration();
    const ownsLease = hasLocalTaskCommandLeaseOwnership(taskId, clientId);
    if (!ownsLease) {
      clearTaskCommandLeaseRenewal(taskId);
    }

    if (ownsLease && lease.actionDescription === actionDescription) {
      return true;
    }

    const acquired = await ensureTaskCommandLease(
      taskId,
      clientId,
      ownerId,
      actionDescription,
      options,
    );
    if (!isTaskCommandLeaseAttemptCurrent(taskId, clientId, transportGeneration)) {
      return false;
    }
    if (acquired) {
      updateLocalTaskCommandLeaseAction(lease, actionDescription);
    }
    return acquired;
  }

  if (lease.renewTimer) {
    const acquired = await refreshHeldLease();
    if (!acquired) {
      return releaseFailedTaskCommandLeaseHold(taskId, lease);
    }
    return true;
  }

  if (!lease.acquirePromise) {
    const transportGeneration = getTaskCommandLeaseTransportGeneration();
    updateLocalTaskCommandLeaseAction(lease, actionDescription);
    lease.acquirePromise = ensureTaskCommandLease(
      taskId,
      clientId,
      ownerId,
      actionDescription,
      options,
    )
      .then((acquired) => {
        if (!acquired) {
          return false;
        }

        if (!isTaskCommandLeaseAttemptCurrent(taskId, clientId, transportGeneration)) {
          return false;
        }

        lease.renewTimer = startTaskCommandLeaseRenewal(taskId, clientId, ownerId);
        return true;
      })
      .finally(() => {
        lease.acquirePromise = undefined;
        cleanupReleasedTaskCommandLease(taskId);
      });
  }

  const acquired = await lease.acquirePromise;
  if (!acquired) {
    return releaseFailedTaskCommandLeaseHold(taskId, lease);
  }

  return refreshHeldLease();
}

async function releaseTaskCommandLeaseHold(
  taskId: string,
  options: {
    notifyBackend?: boolean;
  } = {},
): Promise<void> {
  const clientId = getRuntimeClientId();
  const ownerId = getRuntimeLeaseOwnerId();
  const lease = localTaskCommandLeases.get(taskId);
  if (!lease) {
    return;
  }

  decrementTaskCommandLeaseHold(lease);
  if (lease.holdCount > 0) {
    return;
  }

  if (lease.acquirePromise) {
    await lease.acquirePromise.catch(() => {});
    const refreshedLease = localTaskCommandLeases.get(taskId);
    if (!refreshedLease) {
      return;
    }
    if (refreshedLease.holdCount > 0 || refreshedLease.acquirePromise) {
      return;
    }
  }

  if (options.notifyBackend === false) {
    clearTaskCommandLeaseRenewal(taskId);
    cleanupReleasedTaskCommandLease(taskId);
    return;
  }

  await releaseTaskCommandLeaseToBackend(taskId, clientId, ownerId);
}

export function isTaskCommandLeaseSkipped<T>(
  value: TaskCommandLeaseResult<T>,
): value is typeof TASK_COMMAND_LEASE_SKIPPED {
  return value === TASK_COMMAND_LEASE_SKIPPED;
}

export async function runWithTaskCommandLease<T>(
  taskId: string,
  actionDescription: string,
  run: () => Promise<T>,
  options: TaskCommandLeaseOptions = {},
): Promise<TaskCommandLeaseResult<T>> {
  const acquired = await retainTaskCommandLease(taskId, actionDescription, options);
  if (!acquired) {
    return TASK_COMMAND_LEASE_SKIPPED;
  }

  try {
    return await run();
  } finally {
    await releaseTaskCommandLeaseHold(taskId);
  }
}

export async function runWithAgentTaskCommandLease<T>(
  agentId: string,
  actionDescription: string,
  run: () => Promise<T>,
  options: TaskCommandLeaseOptions = {},
): Promise<TaskCommandLeaseResult<T>> {
  const taskId = store.agents[agentId]?.taskId;
  if (!taskId) {
    return run();
  }

  return runWithTaskCommandLease(taskId, actionDescription, run, options);
}

export function createTaskCommandLeaseSession(
  taskId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions & {
    idleReleaseMs?: number;
  } = {},
): TaskCommandLeaseSession {
  ensureTaskCommandLeaseSubscriptions();
  const idleReleaseMs = options.idleReleaseMs ?? TASK_COMMAND_LEASE_SESSION_IDLE_MS;
  let releaseTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let disposed = false;
  let retained = false;
  const clientId = getRuntimeClientId();
  const removeSessionInvalidator = addTaskCommandLeaseSessionInvalidator(taskId, () => {
    if (!retained) {
      return;
    }

    void clearRetainedSessionLease({ notifyBackend: false });
  });

  function clearReleaseTimer(): void {
    if (releaseTimer !== undefined) {
      globalThis.clearTimeout(releaseTimer);
      releaseTimer = undefined;
    }
  }

  function hasRetainedSessionLeaseOwnership(): boolean {
    return (
      retained &&
      hasTaskCommandLeaseTransportAvailability() &&
      hasLocalTaskCommandLeaseOwnership(taskId, clientId)
    );
  }

  function scheduleRelease(): void {
    clearReleaseTimer();
    releaseTimer = globalThis.setTimeout(() => {
      void release();
    }, idleReleaseMs);
  }

  async function clearRetainedSessionLease(options: { notifyBackend: boolean }): Promise<void> {
    if (!retained) {
      return;
    }

    retained = false;
    clearReleaseTimer();
    await releaseTaskCommandLeaseHold(taskId, {
      notifyBackend: options.notifyBackend,
    });
  }

  async function release(): Promise<void> {
    await clearRetainedSessionLease({ notifyBackend: true });
  }

  async function invalidateRetainedLeaseIfStale(): Promise<void> {
    if (!retained || hasRetainedSessionLeaseOwnership()) {
      return;
    }

    await clearRetainedSessionLease({ notifyBackend: false });
  }

  async function retainSessionLease(nextOptions: TaskCommandLeaseOptions): Promise<boolean> {
    if (disposed) {
      return false;
    }

    await invalidateRetainedLeaseIfStale();

    if (retained) {
      scheduleRelease();
      return true;
    }

    const acquired = await retainTaskCommandLease(taskId, actionDescription, nextOptions);
    if (!acquired || disposed) {
      if (acquired) {
        await releaseTaskCommandLeaseHold(taskId);
      }
      return false;
    }

    retained = true;
    scheduleRelease();
    return true;
  }

  async function acquire(): Promise<boolean> {
    return retainSessionLease({
      ...options,
      confirmTakeover: false,
      takeover: false,
    });
  }

  async function takeOver(): Promise<boolean> {
    return retainSessionLease({
      ...options,
      confirmTakeover: false,
      takeover: true,
    });
  }

  function touch(): boolean {
    if (disposed || !hasRetainedSessionLeaseOwnership()) {
      return false;
    }

    scheduleRelease();
    return true;
  }

  function cleanup(): void {
    disposed = true;
    removeSessionInvalidator();
    clearReleaseTimer();
    void release();
  }

  return {
    acquire,
    cleanup,
    release,
    takeOver,
    touch,
  };
}

function isTypingTaskCommandAction(actionDescription: string): boolean {
  return actionDescription === 'type in the terminal';
}

function isTypingFocusedSurface(focusedSurface: string | null): boolean {
  return isTypingTaskCommandFocusedSurface(focusedSurface);
}

async function releaseInactiveTypingTaskCommandLeases(
  activeTaskId: string | null,
  focusedSurface: string | null,
): Promise<void> {
  const keepActiveTypingLease = activeTaskId !== null && isTypingFocusedSurface(focusedSurface);
  const releasePromises: Promise<void>[] = [];

  for (const [taskId, lease] of localTaskCommandLeases) {
    if (!isTypingTaskCommandAction(lease.actionDescription)) {
      continue;
    }

    if (keepActiveTypingLease && taskId === activeTaskId) {
      continue;
    }

    releasePromises.push(releaseTaskCommandLeaseHold(taskId));
  }

  if (releasePromises.length === 0) {
    return;
  }

  await Promise.allSettled(releasePromises);
}

export function syncFocusedTypingTaskCommandLease(
  activeTaskId: string | null,
  focusedSurface: string | null,
): void {
  void releaseInactiveTypingTaskCommandLeases(activeTaskId, focusedSurface);
}

export function resetTaskCommandLeaseStateForTests(): void {
  clearTaskCommandLeaseSubscriptions();
  for (const pendingTakeover of pendingTaskCommandTakeovers.values()) {
    clearTimeout(pendingTakeover.timer);
  }
  pendingTaskCommandTakeovers.clear();

  for (const lease of localTaskCommandLeases.values()) {
    if (lease.renewTimer) {
      clearInterval(lease.renewTimer);
    }
  }
  localTaskCommandLeases.clear();
  taskCommandLeaseSessionInvalidators.clear();
  taskCommandLeaseTransportUnavailable = false;
  taskCommandLeaseTransportGeneration = 0;
}

export function assertTaskCommandLeaseStateCleanForTests(): void {
  if (pendingTaskCommandTakeovers.size !== 0) {
    throw new Error(
      `Expected no pending task-command takeovers, found ${pendingTaskCommandTakeovers.size}`,
    );
  }

  if (localTaskCommandLeases.size !== 0) {
    throw new Error(`Expected no local task-command leases, found ${localTaskCommandLeases.size}`);
  }

  if (taskCommandLeaseSessionInvalidators.size !== 0) {
    throw new Error(
      `Expected no task-command lease invalidators, found ${taskCommandLeaseSessionInvalidators.size}`,
    );
  }

  if (removeTaskCommandControllerSubscription) {
    throw new Error('Expected no task-command-controller subscription to remain registered');
  }

  if (removeTaskCommandLeaseTransportSubscription) {
    throw new Error('Expected no task-command-lease transport subscription to remain registered');
  }
}
