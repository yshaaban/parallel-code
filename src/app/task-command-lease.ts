import { IPC } from '../../electron/ipc/channels';
import type {
  TaskCommandTakeoverRequestMessage,
  TaskCommandTakeoverResultMessage as ProtocolTaskCommandTakeoverResultMessage,
} from '../../electron/remote/protocol';
import { confirm } from '../lib/dialog';
import { invoke, isElectronRuntime, sendBrowserControlMessage } from '../lib/ipc';
import { getFallbackDisplayName } from '../lib/display-name';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { store } from '../store/core';
import { getPeerDisplayName } from '../store/peer-presence';
import { applyTaskCommandControllerChanged } from '../store/task-command-controllers';
import {
  clearIncomingTaskTakeoverRequest,
  getIncomingTaskTakeoverRequest,
  upsertIncomingTaskTakeoverRequest,
} from '../store/task-command-takeovers';

const TASK_COMMAND_LEASE_RENEW_MS = 5_000;
const TASK_COMMAND_LEASE_SESSION_IDLE_MS = 2_500;

export const TASK_COMMAND_LEASE_SKIPPED = Symbol('task-command-lease-skipped');

export type TaskCommandLeaseResult<T> = T | typeof TASK_COMMAND_LEASE_SKIPPED;

interface TaskCommandLeaseOptions {
  confirmTakeover?: boolean;
  takeover?: boolean;
}

interface TaskCommandLeaseAcquireResult {
  action: string | null;
  acquired: boolean;
  controllerId: string | null;
  taskId: string;
}

interface TaskCommandTakeoverResultMessage {
  decision: 'approved' | 'denied' | 'force-required' | 'owner-missing';
  requestId: string;
  taskId: string;
}

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
    resolve: (result: TaskCommandTakeoverResultMessage['decision']) => void;
    timer: ReturnType<typeof globalThis.setTimeout>;
  }
>();

function clearPendingTaskCommandTakeover(requestId: string): void {
  const pendingTakeover = pendingTaskCommandTakeovers.get(requestId);
  if (!pendingTakeover) {
    return;
  }

  clearTimeout(pendingTakeover.timer);
  pendingTaskCommandTakeovers.delete(requestId);
}

function resolvePendingTaskCommandTakeover(
  requestId: string,
  decision: TaskCommandTakeoverResultMessage['decision'],
): void {
  const pendingTakeover = pendingTaskCommandTakeovers.get(requestId);
  if (!pendingTakeover) {
    return;
  }

  clearPendingTaskCommandTakeover(requestId);
  pendingTakeover.resolve(decision);
}

function createPendingTaskCommandTakeover(
  requestId: string,
): Promise<TaskCommandTakeoverResultMessage['decision']> {
  return new Promise<TaskCommandTakeoverResultMessage['decision']>((resolve) => {
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
  clearIncomingTaskTakeoverRequest(message.requestId);
}

export async function respondToIncomingTaskCommandTakeover(
  requestId: string,
  approved: boolean,
): Promise<void> {
  const request = getIncomingTaskTakeoverRequest(requestId);
  if (!request) {
    return;
  }

  clearIncomingTaskTakeoverRequest(requestId);
  await sendBrowserControlMessage({
    type: 'respond-task-command-takeover',
    approved,
    requestId: request.requestId,
  });
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
    await sendBrowserControlMessage({
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
}

async function acquireTaskCommandLease(
  taskId: string,
  clientId: string,
  actionDescription: string,
  takeover: boolean,
): Promise<TaskCommandLeaseAcquireResult> {
  const result = await invoke(IPC.AcquireTaskCommandLease, {
    action: actionDescription,
    clientId,
    taskId,
    ...(takeover ? { takeover: true } : {}),
  });
  applyTaskCommandControllerChanged(result);
  return result;
}

function shouldSkipTaskCommandTakeover(options: TaskCommandLeaseOptions): boolean {
  return options.confirmTakeover === false && options.takeover !== true;
}

function isAcceptedTaskCommandTakeoverDecision(
  decision: TaskCommandTakeoverResultMessage['decision'],
): boolean {
  return decision === 'approved' || decision === 'owner-missing' || decision === 'force-required';
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

async function resolveTaskCommandLeaseConflict(
  taskId: string,
  clientId: string,
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

  if (decision === 'denied') {
    return false;
  }

  if (decision === 'force-required') {
    const shouldTakeOver = await confirmForcedTaskCommandTakeover(actionDescription, lease);
    if (!shouldTakeOver) {
      return false;
    }
  }

  if (!isAcceptedTaskCommandTakeoverDecision(decision)) {
    return false;
  }

  const takeoverLease = await acquireTaskCommandLease(taskId, clientId, actionDescription, true);
  if (!takeoverLease.acquired) {
    throw new Error('Task is controlled by another client');
  }

  return true;
}

async function ensureTaskCommandLease(
  taskId: string,
  clientId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions = {},
): Promise<boolean> {
  const lease = await acquireTaskCommandLease(taskId, clientId, actionDescription, false);
  if (lease.acquired || lease.controllerId === clientId) {
    return true;
  }

  return resolveTaskCommandLeaseConflict(taskId, clientId, actionDescription, lease, options);
}

function startTaskCommandLeaseRenewal(
  taskId: string,
  clientId: string,
): ReturnType<typeof globalThis.setInterval> {
  return globalThis.setInterval(() => {
    void invoke(IPC.RenewTaskCommandLease, {
      clientId,
      taskId,
    })
      .then((result) => {
        applyTaskCommandControllerChanged(result);
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
    return;
  }

  if (lease.holdCount > 0 || lease.acquirePromise || lease.renewTimer) {
    return;
  }

  localTaskCommandLeases.delete(taskId);
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

async function releaseTaskCommandLeaseToBackend(taskId: string, clientId: string): Promise<void> {
  clearTaskCommandLeaseRenewal(taskId);
  const result = await invoke(IPC.ReleaseTaskCommandLease, {
    clientId,
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
  const clientId = getRuntimeClientId();
  const lease = getOrCreateLocalTaskCommandLease(taskId, actionDescription);
  lease.holdCount += 1;

  async function refreshHeldLease(): Promise<boolean> {
    if (lease.actionDescription === actionDescription) {
      return true;
    }

    const acquired = await ensureTaskCommandLease(taskId, clientId, actionDescription, options);
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
    updateLocalTaskCommandLeaseAction(lease, actionDescription);
    lease.acquirePromise = ensureTaskCommandLease(taskId, clientId, actionDescription, options)
      .then((acquired) => {
        if (!acquired) {
          return false;
        }

        lease.renewTimer = startTaskCommandLeaseRenewal(taskId, clientId);
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

async function releaseTaskCommandLeaseHold(taskId: string): Promise<void> {
  const clientId = getRuntimeClientId();
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

  await releaseTaskCommandLeaseToBackend(taskId, clientId);
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
  const idleReleaseMs = options.idleReleaseMs ?? TASK_COMMAND_LEASE_SESSION_IDLE_MS;
  let releaseTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let disposed = false;
  let retained = false;

  function clearReleaseTimer(): void {
    if (releaseTimer !== undefined) {
      globalThis.clearTimeout(releaseTimer);
      releaseTimer = undefined;
    }
  }

  function scheduleRelease(): void {
    clearReleaseTimer();
    releaseTimer = globalThis.setTimeout(() => {
      void release();
    }, idleReleaseMs);
  }

  async function release(): Promise<void> {
    clearReleaseTimer();
    if (!retained) {
      return;
    }

    retained = false;
    await releaseTaskCommandLeaseHold(taskId);
  }

  async function retainSessionLease(nextOptions: TaskCommandLeaseOptions): Promise<boolean> {
    if (disposed) {
      return false;
    }

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
    return retainSessionLease(options);
  }

  async function takeOver(): Promise<boolean> {
    return retainSessionLease({
      ...options,
      confirmTakeover: false,
      takeover: true,
    });
  }

  function cleanup(): void {
    disposed = true;
    clearReleaseTimer();
    void release();
  }

  return {
    acquire,
    cleanup,
    release,
    takeOver,
  };
}
