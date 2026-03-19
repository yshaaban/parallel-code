import type { TaskCommandTakeoverResultMessage as ProtocolTaskCommandTakeoverResultMessage } from '../../electron/remote/protocol';
import { assertNever } from '../lib/assert-never';
import { confirm } from '../lib/dialog';
import { isElectronRuntime, sendImmediateBrowserControlMessage } from '../lib/ipc';
import { getFallbackDisplayName } from '../lib/display-name';
import { getPeerDisplayName } from '../store/peer-presence';
import {
  clearIncomingTaskTakeoverRequest,
  clearIncomingTaskTakeoverRequests,
  getIncomingTaskTakeoverRequest,
  hasIncomingTaskTakeoverRequests,
} from '../store/task-command-takeovers';

export type TaskCommandTakeoverDecision =
  | 'approved'
  | 'denied'
  | 'force-required'
  | 'owner-missing'
  | 'transport-unavailable';

export interface TaskCommandTakeoverLease {
  action: string | null;
  controllerId: string | null;
}

const pendingTaskCommandTakeovers = new Map<
  string,
  {
    resolve: (result: TaskCommandTakeoverDecision) => void;
    timer: ReturnType<typeof globalThis.setTimeout>;
  }
>();

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
  decision: TaskCommandTakeoverDecision,
): void {
  const pendingTakeover = pendingTaskCommandTakeovers.get(requestId);
  if (!pendingTakeover) {
    return;
  }

  clearPendingTaskCommandTakeover(requestId);
  pendingTakeover.resolve(decision);
}

export function resolveTaskCommandTakeoverDecision(
  requestId: string,
  decision: TaskCommandTakeoverDecision,
): void {
  resolvePendingTaskCommandTakeover(requestId, decision);
}

export function resolveAllPendingTaskCommandTakeovers(decision: TaskCommandTakeoverDecision): void {
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

async function confirmForcedTaskCommandTakeover(
  actionDescription: string,
  lease: TaskCommandTakeoverLease,
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

export async function shouldProceedWithTaskCommandTakeover(
  actionDescription: string,
  decision: TaskCommandTakeoverDecision,
  lease: TaskCommandTakeoverLease,
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

async function requestTaskCommandTakeover(
  taskId: string,
  actionDescription: string,
  targetControllerId: string,
): Promise<TaskCommandTakeoverDecision> {
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

export async function requestTaskCommandTakeoverDecision(
  taskId: string,
  actionDescription: string,
  targetControllerId: string,
): Promise<TaskCommandTakeoverDecision> {
  return requestTaskCommandTakeover(taskId, actionDescription, targetControllerId);
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

export function resetTaskCommandTakeoverStateForTests(): void {
  for (const pendingTakeover of pendingTaskCommandTakeovers.values()) {
    clearTimeout(pendingTakeover.timer);
  }

  pendingTaskCommandTakeovers.clear();
  clearIncomingTaskTakeoverRequests();
}

export function assertTaskCommandTakeoverStateCleanForTests(): void {
  if (pendingTaskCommandTakeovers.size !== 0) {
    throw new Error(
      `Expected no pending task-command takeovers, found ${pendingTaskCommandTakeovers.size}`,
    );
  }

  if (hasIncomingTaskTakeoverRequests()) {
    throw new Error('Expected no incoming task-command takeovers to remain registered');
  }
}

export function clearIncomingTaskCommandTakeoverRequestState(requestId: string): void {
  clearIncomingTaskTakeoverRequest(requestId);
}

export function clearIncomingTaskCommandTakeoverRequestStateForAll(): void {
  clearIncomingTaskTakeoverRequests();
}

export type TaskCommandTakeoverResultMessage = ProtocolTaskCommandTakeoverResultMessage;
