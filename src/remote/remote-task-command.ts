import type { TaskCommandTakeoverResultMessage } from '../../electron/remote/protocol';
import type { TaskCommandControllerSnapshot } from '../domain/server-state';
import { isTypingTaskCommandFocusedSurface } from '../domain/task-command-focus';
import { assertNever } from '../lib/assert-never';
import type { ConnectionStatus } from './ws';
import {
  acquireRemoteTaskCommandLease,
  releaseRemoteTaskCommandLease,
  renewRemoteTaskCommandLease,
  resizeRemoteAgent,
  writeRemoteAgent,
} from './remote-ipc';
import { getRemoteClientId } from './client-id';
import {
  applyRemoteTaskCommandControllerChanged,
  clearIncomingRemoteTakeoverRequests,
  getRemoteTaskCommandController,
  getRemoteTaskControllerOwnerStatus,
  subscribeRemoteTaskCommandControllerChanges,
  subscribeRemoteTaskCommandTakeoverResults,
} from './remote-collaboration';
import { sendWhenConnected, subscribeRemoteConnectionStatus } from './ws';

const REMOTE_LEASE_OWNER_ID_KEY = 'parallel-code-remote-lease-owner-id';
const TASK_COMMAND_ACTION = 'type in the terminal';
const TASK_COMMAND_LEASE_RENEW_MS = 5_000;
const TASK_COMMAND_LEASE_IDLE_MS = 5_000;
const TASK_COMMAND_TAKEOVER_TIMEOUT_MS = 10_000;

interface RemoteTaskCommandLeaseState {
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  releaseRequested: boolean;
  renewTimer: ReturnType<typeof setInterval> | undefined;
  retainingPromise: Promise<boolean> | undefined;
  retained: boolean;
}

interface RemoteTaskCommandAttempt {
  taskGeneration: number;
  transportGeneration: number;
}

type RemoteAcquireTaskCommandResult = Awaited<ReturnType<typeof acquireRemoteTaskCommandLease>>;
type RemoteRenewTaskCommandResult = Awaited<ReturnType<typeof renewRemoteTaskCommandLease>>;
type RemoteReleaseTaskCommandResult = Awaited<ReturnType<typeof releaseRemoteTaskCommandLease>>;
type RemoteTakeoverDecision =
  | TaskCommandTakeoverResultMessage['decision']
  | 'transport-unavailable';

interface PendingTakeoverRequest {
  resolve: (decision: RemoteTakeoverDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const localTaskCommandLeases = new Map<string, RemoteTaskCommandLeaseState>();
const sendQueues = new Map<string, Promise<boolean>>();
const taskCommandGenerations = new Map<string, number>();
const pendingTakeovers = new Map<string, PendingTakeoverRequest>();

let removeTaskCommandControllerSubscription: (() => void) | null = null;
let removeTaskCommandTakeoverResultSubscription: (() => void) | null = null;
let removeRemoteConnectionStatusSubscription: (() => void) | null = null;
let remoteTaskCommandTransportUnavailable = true;
let remoteTaskCommandTransportGeneration = 0;

function getRemoteLeaseOwnerId(): string {
  if (typeof sessionStorage === 'undefined') {
    return 'remote-lease-owner';
  }

  const existingOwnerId = sessionStorage.getItem(REMOTE_LEASE_OWNER_ID_KEY);
  if (existingOwnerId) {
    return existingOwnerId;
  }

  const nextOwnerId = crypto.randomUUID();
  sessionStorage.setItem(REMOTE_LEASE_OWNER_ID_KEY, nextOwnerId);
  return nextOwnerId;
}

function getOrCreateLocalTaskCommandLease(taskId: string): RemoteTaskCommandLeaseState {
  const existingLease = localTaskCommandLeases.get(taskId);
  if (existingLease) {
    return existingLease;
  }

  const nextLease: RemoteTaskCommandLeaseState = {
    idleTimer: undefined,
    releaseRequested: false,
    renewTimer: undefined,
    retainingPromise: undefined,
    retained: false,
  };
  localTaskCommandLeases.set(taskId, nextLease);
  return nextLease;
}

function clearIdleTimer(lease: RemoteTaskCommandLeaseState): void {
  if (!lease.idleTimer) {
    return;
  }

  clearTimeout(lease.idleTimer);
  lease.idleTimer = undefined;
}

function clearRenewTimer(lease: RemoteTaskCommandLeaseState): void {
  if (!lease.renewTimer) {
    return;
  }

  clearInterval(lease.renewTimer);
  lease.renewTimer = undefined;
}

function clearTaskCommandLeaseTimers(lease: RemoteTaskCommandLeaseState): void {
  clearIdleTimer(lease);
  clearRenewTimer(lease);
}

function hasTaskCommandSubscriptionActivity(): boolean {
  return localTaskCommandLeases.size > 0 || pendingTakeovers.size > 0;
}

function clearTaskCommandSubscriptions(): void {
  removeTaskCommandControllerSubscription?.();
  removeTaskCommandControllerSubscription = null;
  removeTaskCommandTakeoverResultSubscription?.();
  removeTaskCommandTakeoverResultSubscription = null;
  removeRemoteConnectionStatusSubscription?.();
  removeRemoteConnectionStatusSubscription = null;
}

function cleanupIdleTaskCommandSubscriptions(): void {
  if (hasTaskCommandSubscriptionActivity()) {
    return;
  }

  clearTaskCommandSubscriptions();
}

function cleanupReleasedTaskCommandLease(taskId: string): void {
  const lease = localTaskCommandLeases.get(taskId);
  if (!lease || lease.retainingPromise || lease.retained) {
    return;
  }

  clearTaskCommandLeaseTimers(lease);
  localTaskCommandLeases.delete(taskId);
  cleanupIdleTaskCommandSubscriptions();
}

function getTaskCommandGeneration(taskId: string): number {
  return taskCommandGenerations.get(taskId) ?? 0;
}

function bumpTaskCommandGeneration(taskId: string): number {
  const nextGeneration = getTaskCommandGeneration(taskId) + 1;
  taskCommandGenerations.set(taskId, nextGeneration);
  return nextGeneration;
}

function getTaskCommandTransportGeneration(): number {
  return remoteTaskCommandTransportGeneration;
}

function hasRemoteTaskCommandTransportAvailability(): boolean {
  return !remoteTaskCommandTransportUnavailable;
}

function createRemoteTaskCommandAttempt(taskId: string): RemoteTaskCommandAttempt | null {
  if (!hasRemoteTaskCommandTransportAvailability()) {
    return null;
  }

  return {
    taskGeneration: getTaskCommandGeneration(taskId),
    transportGeneration: getTaskCommandTransportGeneration(),
  };
}

function isRemoteTaskCommandAttemptCurrent(
  taskId: string,
  attempt: RemoteTaskCommandAttempt,
): boolean {
  return (
    hasRemoteTaskCommandTransportAvailability() &&
    attempt.taskGeneration === getTaskCommandGeneration(taskId) &&
    attempt.transportGeneration === getTaskCommandTransportGeneration()
  );
}

function invalidateReleasedTaskCommandLease(taskId: string): void {
  bumpTaskCommandGeneration(taskId);
  cleanupReleasedTaskCommandLease(taskId);
}

function invalidateLocalTaskCommandLease(taskId: string, lease: RemoteTaskCommandLeaseState): void {
  lease.retained = false;
  lease.releaseRequested = false;
  clearTaskCommandLeaseTimers(lease);
  invalidateReleasedTaskCommandLease(taskId);
}

function hasRetainedTaskCommandOwnership(taskId: string): boolean {
  const controller = getRemoteTaskCommandController(taskId);
  return (
    hasRemoteTaskCommandTransportAvailability() && controller?.controllerId === getRemoteClientId()
  );
}

function didAcquireRemoteTaskCommand(result: RemoteAcquireTaskCommandResult): boolean {
  return result.acquired || result.controllerId === getRemoteClientId();
}

function scheduleIdleRelease(taskId: string, lease: RemoteTaskCommandLeaseState): void {
  clearIdleTimer(lease);
  lease.idleTimer = setTimeout(() => {
    void releaseRemoteTaskCommand(taskId);
  }, TASK_COMMAND_LEASE_IDLE_MS);
}

function markLeaseRetained(taskId: string, lease: RemoteTaskCommandLeaseState): void {
  if (!hasRemoteTaskCommandTransportAvailability()) {
    return;
  }

  lease.releaseRequested = false;
  lease.retained = true;
  startRenewal(taskId, lease);
  releaseCompetingTypingLeases(taskId);
  scheduleIdleRelease(taskId, lease);
}

function startRenewal(taskId: string, lease: RemoteTaskCommandLeaseState): void {
  clearRenewTimer(lease);
  lease.renewTimer = setInterval(() => {
    if (!lease.retained || lease.releaseRequested || !hasRetainedTaskCommandOwnership(taskId)) {
      clearRenewTimer(lease);
      return;
    }

    void renewRemoteTaskCommandLease({
      clientId: getRemoteClientId(),
      ownerId: getRemoteLeaseOwnerId(),
      taskId,
    })
      .then((result: RemoteRenewTaskCommandResult) => {
        applyRemoteTaskCommandControllerChanged(result);
        if (!result.renewed || !hasRetainedTaskCommandOwnership(taskId)) {
          clearRenewTimer(lease);
        }
      })
      .catch(() => {
        clearRenewTimer(lease);
      });
  }, TASK_COMMAND_LEASE_RENEW_MS);
}

function releaseCompetingTypingLeases(activeTaskId: string): void {
  for (const taskId of localTaskCommandLeases.keys()) {
    if (taskId === activeTaskId) {
      continue;
    }

    void releaseRemoteTaskCommand(taskId);
  }
}

function resolvePendingTakeoverRequest(requestId: string, decision: RemoteTakeoverDecision): void {
  const pendingTakeover = pendingTakeovers.get(requestId);
  if (!pendingTakeover) {
    return;
  }

  clearTimeout(pendingTakeover.timer);
  pendingTakeovers.delete(requestId);
  pendingTakeover.resolve(decision);
  cleanupIdleTaskCommandSubscriptions();
}

function resolveAllPendingTakeovers(decision: RemoteTakeoverDecision): void {
  for (const requestId of Array.from(pendingTakeovers.keys())) {
    resolvePendingTakeoverRequest(requestId, decision);
  }
}

function invalidateAllTaskCommandLeases(): void {
  for (const [taskId, lease] of localTaskCommandLeases) {
    invalidateLocalTaskCommandLease(taskId, lease);
  }
}

function handleRemoteTaskCommandTransportUnavailable(): void {
  if (remoteTaskCommandTransportUnavailable) {
    return;
  }

  remoteTaskCommandTransportUnavailable = true;
  remoteTaskCommandTransportGeneration += 1;
  resolveAllPendingTakeovers('transport-unavailable');
  clearIncomingRemoteTakeoverRequests();
  invalidateAllTaskCommandLeases();
  cleanupIdleTaskCommandSubscriptions();
}

function handleRemoteTaskCommandTransportConnected(): void {
  remoteTaskCommandTransportUnavailable = false;
}

function isRemoteTaskCommandTransportUnavailableState(nextStatus: ConnectionStatus): boolean {
  switch (nextStatus) {
    case 'connected':
    case 'connecting':
      return false;
    case 'disconnected':
    case 'reconnecting':
      return true;
  }

  return assertNever(nextStatus, 'Unhandled remote task-command connection status');
}

function handleTaskCommandControllerChanged(snapshot: TaskCommandControllerSnapshot): void {
  if (snapshot.controllerId === getRemoteClientId()) {
    return;
  }

  const lease = localTaskCommandLeases.get(snapshot.taskId);
  if (!lease) {
    return;
  }

  invalidateLocalTaskCommandLease(snapshot.taskId, lease);
}

function handleRemoteConnectionStatusChanged(nextStatus: ConnectionStatus): void {
  if (isRemoteTaskCommandTransportUnavailableState(nextStatus)) {
    handleRemoteTaskCommandTransportUnavailable();
    return;
  }

  handleRemoteTaskCommandTransportConnected();
}

function ensureSubscriptions(): void {
  if (!removeTaskCommandControllerSubscription) {
    removeTaskCommandControllerSubscription = subscribeRemoteTaskCommandControllerChanges(
      handleTaskCommandControllerChanged,
    );
  }

  if (!removeTaskCommandTakeoverResultSubscription) {
    removeTaskCommandTakeoverResultSubscription = subscribeRemoteTaskCommandTakeoverResults(
      (message) => {
        resolvePendingTakeoverRequest(message.requestId, message.decision);
      },
    );
  }

  if (!removeRemoteConnectionStatusSubscription) {
    removeRemoteConnectionStatusSubscription = subscribeRemoteConnectionStatus(
      handleRemoteConnectionStatusChanged,
    );
  }
}

function createPendingTakeover(requestId: string): Promise<RemoteTakeoverDecision> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingTakeovers.delete(requestId);
      cleanupIdleTaskCommandSubscriptions();
      resolve('force-required');
    }, TASK_COMMAND_TAKEOVER_TIMEOUT_MS);
    pendingTakeovers.set(requestId, { resolve, timer });
  });
}

async function requestTaskTakeover(
  taskId: string,
  targetControllerId: string,
): Promise<RemoteTakeoverDecision> {
  const requestId = crypto.randomUUID();
  const resultPromise = createPendingTakeover(requestId);
  const sent = await sendWhenConnected({
    type: 'request-task-command-takeover',
    action: TASK_COMMAND_ACTION,
    requestId,
    targetControllerId,
    taskId,
  });
  if (!sent) {
    resolvePendingTakeoverRequest(requestId, 'transport-unavailable');
    return 'transport-unavailable';
  }
  return resultPromise;
}

async function acquireRemoteTaskCommand(
  taskId: string,
  takeover: boolean,
): Promise<RemoteAcquireTaskCommandResult> {
  ensureSubscriptions();
  const result = await acquireRemoteTaskCommandLease({
    action: TASK_COMMAND_ACTION,
    clientId: getRemoteClientId(),
    ownerId: getRemoteLeaseOwnerId(),
    ...(takeover ? { takeover: true } : {}),
    taskId,
  });
  applyRemoteTaskCommandControllerChanged(result);
  return result;
}

async function retainRemoteTaskCommandLease(taskId: string): Promise<boolean> {
  ensureSubscriptions();
  const attempt = createRemoteTaskCommandAttempt(taskId);
  if (!attempt) {
    return false;
  }

  const lease = getOrCreateLocalTaskCommandLease(taskId);

  if (lease.retained && !lease.releaseRequested && hasRetainedTaskCommandOwnership(taskId)) {
    scheduleIdleRelease(taskId, lease);
    return true;
  }

  if (!lease.retainingPromise) {
    lease.releaseRequested = false;
    lease.retainingPromise = acquireRemoteTaskCommand(taskId, false)
      .then((result) => {
        if (
          !didAcquireRemoteTaskCommand(result) ||
          lease.releaseRequested ||
          !isRemoteTaskCommandAttemptCurrent(taskId, attempt)
        ) {
          return false;
        }

        markLeaseRetained(taskId, lease);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        lease.retainingPromise = undefined;
        cleanupReleasedTaskCommandLease(taskId);
      });
  }

  const acquired = await lease.retainingPromise;
  if (!acquired || lease.releaseRequested || !lease.retained) {
    return false;
  }

  scheduleIdleRelease(taskId, lease);
  return true;
}

function enqueueAgentWrite(agentId: string, write: () => Promise<boolean>): Promise<boolean> {
  const previous = sendQueues.get(agentId) ?? Promise.resolve(true);
  const next = previous.catch(() => false).then(write);
  sendQueues.set(
    agentId,
    next.finally(() => {
      if (sendQueues.get(agentId) === next) {
        sendQueues.delete(agentId);
      }
    }),
  );
  return next;
}

export async function sendRemoteAgentInput(
  agentId: string,
  taskId: string,
  data: string,
): Promise<boolean> {
  ensureSubscriptions();
  const attempt = createRemoteTaskCommandAttempt(taskId);
  if (!attempt) {
    return false;
  }

  const ownerStatus = getRemoteTaskControllerOwnerStatus(taskId);
  if (ownerStatus && !ownerStatus.isSelf) {
    return false;
  }

  return enqueueAgentWrite(agentId, async () => {
    if (!isRemoteTaskCommandAttemptCurrent(taskId, attempt)) {
      return false;
    }

    const acquired = await retainRemoteTaskCommandLease(taskId);
    if (!acquired || !isRemoteTaskCommandAttemptCurrent(taskId, attempt)) {
      return false;
    }

    try {
      await writeRemoteAgent({
        agentId,
        data,
        taskId,
      });
    } catch {
      return false;
    }

    return isRemoteTaskCommandAttemptCurrent(taskId, attempt);
  });
}

export function sendRemoteAgentResize(
  agentId: string,
  taskId: string,
  cols: number,
  rows: number,
): void {
  if (!hasRetainedTaskCommandOwnership(taskId)) {
    return;
  }

  void resizeRemoteAgent({
    agentId,
    cols,
    rows,
    taskId,
  }).catch(() => {});
}

export async function requestRemoteTaskTakeover(
  taskId: string,
  force = false,
): Promise<'acquired' | 'denied' | 'force-required' | 'transport-unavailable'> {
  ensureSubscriptions();
  if (!hasRemoteTaskCommandTransportAvailability()) {
    return 'transport-unavailable';
  }

  const ownerStatus = getRemoteTaskControllerOwnerStatus(taskId);
  if (!ownerStatus || ownerStatus.isSelf) {
    const acquired = await retainRemoteTaskCommandLease(taskId).catch(() => false);
    return acquired ? 'acquired' : 'transport-unavailable';
  }

  if (force) {
    const acquired = await acquireRemoteTaskCommand(taskId, true)
      .then((result) => didAcquireRemoteTaskCommand(result))
      .catch(() => false);
    if (!acquired) {
      return 'transport-unavailable';
    }

    markLeaseRetained(taskId, getOrCreateLocalTaskCommandLease(taskId));
    return 'acquired';
  }

  const decision = await requestTaskTakeover(taskId, ownerStatus.controllerId).catch(
    () => 'transport-unavailable' as const,
  );
  switch (decision) {
    case 'approved':
    case 'owner-missing': {
      const acquired = await acquireRemoteTaskCommand(taskId, true)
        .then((result) => didAcquireRemoteTaskCommand(result))
        .catch(() => false);
      if (!acquired) {
        return 'transport-unavailable';
      }

      markLeaseRetained(taskId, getOrCreateLocalTaskCommandLease(taskId));
      return 'acquired';
    }
    case 'force-required':
      return 'force-required';
    case 'denied':
      return 'denied';
    case 'transport-unavailable':
      return 'transport-unavailable';
  }

  return assertNever(decision, 'Unhandled remote task-command takeover decision');
}

export async function releaseRemoteTaskCommand(taskId: string): Promise<void> {
  bumpTaskCommandGeneration(taskId);
  const lease = localTaskCommandLeases.get(taskId);
  if (!lease) {
    cleanupIdleTaskCommandSubscriptions();
    return;
  }

  lease.releaseRequested = true;
  clearTaskCommandLeaseTimers(lease);

  if (lease.retainingPromise) {
    await lease.retainingPromise.catch(() => false);
  }

  const refreshedLease = localTaskCommandLeases.get(taskId);
  if (!refreshedLease) {
    cleanupIdleTaskCommandSubscriptions();
    return;
  }

  if (!refreshedLease.retained) {
    cleanupReleasedTaskCommandLease(taskId);
    return;
  }

  refreshedLease.retained = false;
  if (!hasRemoteTaskCommandTransportAvailability()) {
    cleanupReleasedTaskCommandLease(taskId);
    return;
  }

  await releaseRemoteTaskCommandLease({
    clientId: getRemoteClientId(),
    ownerId: getRemoteLeaseOwnerId(),
    taskId,
  })
    .then((result: RemoteReleaseTaskCommandResult) => {
      applyRemoteTaskCommandControllerChanged(result);
    })
    .catch(() => {});
  cleanupReleasedTaskCommandLease(taskId);
}

export async function respondToRemoteTaskCommandTakeover(
  requestId: string,
  approved: boolean,
): Promise<boolean> {
  return sendWhenConnected({
    type: 'respond-task-command-takeover',
    approved,
    requestId,
  });
}

async function releaseInactiveTypingRemoteTaskCommandLeases(
  activeTaskId: string | null,
  focusedSurface: string | null,
): Promise<void> {
  const keepActiveTypingLease =
    activeTaskId !== null && isTypingTaskCommandFocusedSurface(focusedSurface);
  const releasePromises: Promise<void>[] = [];

  for (const taskId of localTaskCommandLeases.keys()) {
    if (keepActiveTypingLease && taskId === activeTaskId) {
      continue;
    }

    releasePromises.push(releaseRemoteTaskCommand(taskId));
  }

  if (releasePromises.length === 0) {
    return;
  }

  await Promise.allSettled(releasePromises);
}

export function syncFocusedTypingRemoteTaskCommandLease(
  activeTaskId: string | null,
  focusedSurface: string | null,
): void {
  void releaseInactiveTypingRemoteTaskCommandLeases(activeTaskId, focusedSurface);
}

export function resetRemoteTaskCommandStateForTests(): void {
  for (const lease of localTaskCommandLeases.values()) {
    clearTaskCommandLeaseTimers(lease);
  }

  localTaskCommandLeases.clear();
  sendQueues.clear();
  taskCommandGenerations.clear();
  resolveAllPendingTakeovers('transport-unavailable');
  clearTaskCommandSubscriptions();
  remoteTaskCommandTransportUnavailable = true;
  remoteTaskCommandTransportGeneration = 0;
}
