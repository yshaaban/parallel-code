import { getAgentMeta } from '../electron/ipc/pty.js';
import { isTaskCommandLeaseHeld } from '../electron/ipc/task-command-leases.js';
import type { TaskControlContext } from '../electron/remote/protocol.js';

export type BrowserAgentTaskMessage = {
  agentId: string;
} & TaskControlContext;

type GetAgentTaskId = (agentId: string) => string | undefined;
type CanControlTask = (taskId: string, controllerId: string) => boolean;

function getBackendAgentTaskId(agentId: string): string | undefined {
  return getAgentMeta(agentId)?.taskId;
}

export function resolveBrowserAgentTaskId(
  message: BrowserAgentTaskMessage,
  getAgentTaskId: GetAgentTaskId = getBackendAgentTaskId,
): string | undefined {
  return getAgentTaskId(message.agentId);
}

export function hasBrowserTaskControlForMessage(
  message: BrowserAgentTaskMessage,
  clientId: string | null,
  canControlTask: CanControlTask = isTaskCommandLeaseHeld,
  getAgentTaskId: GetAgentTaskId = getBackendAgentTaskId,
): boolean {
  if (!clientId) {
    return false;
  }

  if (message.controllerId !== undefined && message.controllerId !== clientId) {
    return false;
  }

  const taskId = getAgentTaskId(message.agentId);
  if (typeof taskId !== 'string') {
    return message.taskId === undefined && message.controllerId === undefined;
  }

  if (typeof message.taskId === 'string' && message.taskId !== taskId) {
    return false;
  }

  return canControlTask(taskId, clientId);
}

export function browserAgentControllerStillOwnsTask(
  message: BrowserAgentTaskMessage,
  controllerId: string,
  canControlTask: CanControlTask = isTaskCommandLeaseHeld,
  getAgentTaskId: GetAgentTaskId = getBackendAgentTaskId,
): boolean {
  const taskId = resolveBrowserAgentTaskId(message, getAgentTaskId);
  return typeof taskId === 'string' && canControlTask(taskId, controllerId);
}
