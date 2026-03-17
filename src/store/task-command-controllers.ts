import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import type { TaskCommandControllerSnapshot } from '../domain/server-state';
import { invoke } from '../lib/ipc';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { setStore, store } from './core';
import type { TaskCommandController } from './types';

let taskCommandControllerUpdateCount = 0;

export interface PeerTaskCommandControlStatus {
  action: string;
  controllerId: string;
  controllerKey: string;
  label: string;
  message: string;
}

function getTaskCommandControlLabel(action: string): string {
  if (action === 'type in the terminal') {
    return 'Terminal in use';
  }

  if (action === 'send a prompt') {
    return 'Prompt in use';
  }

  return 'Read-only';
}

function getTaskCommandControlMessage(action: string): string {
  if (action === 'type in the terminal') {
    return 'Another browser session is currently typing in this terminal.';
  }

  if (action === 'send a prompt') {
    return 'Another browser session is currently sending prompts for this task.';
  }

  return `Another browser session is controlling this task to ${action}.`;
}

function toTaskCommandController(
  snapshot: TaskCommandControllerSnapshot,
): TaskCommandController | null {
  if (!snapshot.controllerId) {
    return null;
  }

  return {
    action: snapshot.action,
    controllerId: snapshot.controllerId,
  };
}

export function applyTaskCommandControllerChanged(snapshot: TaskCommandControllerSnapshot): void {
  taskCommandControllerUpdateCount += 1;
  const controller = toTaskCommandController(snapshot);
  setStore(
    produce((state) => {
      if (!controller) {
        delete state.taskCommandControllers[snapshot.taskId];
        return;
      }

      state.taskCommandControllers[snapshot.taskId] = controller;
    }),
  );
}

export function replaceTaskCommandControllers(
  snapshots: ReadonlyArray<TaskCommandControllerSnapshot>,
  options: {
    ifUnchangedSince?: number;
  } = {},
): void {
  if (
    options.ifUnchangedSince !== undefined &&
    taskCommandControllerUpdateCount !== options.ifUnchangedSince
  ) {
    return;
  }

  const nextControllers: Record<string, TaskCommandController> = {};
  for (const snapshot of snapshots) {
    const controller = toTaskCommandController(snapshot);
    if (!controller) {
      continue;
    }

    nextControllers[snapshot.taskId] = controller;
  }

  setStore('taskCommandControllers', nextControllers);
}

export function getTaskCommandControllerUpdateCount(): number {
  return taskCommandControllerUpdateCount;
}

export async function loadTaskCommandControllers(options?: {
  ifUnchangedSince?: number;
}): Promise<void> {
  const snapshots = await invoke(IPC.GetTaskCommandControllers).catch(() => []);
  replaceTaskCommandControllers(snapshots, options);
}

export function getTaskCommandController(taskId: string): TaskCommandController | null {
  return store.taskCommandControllers[taskId] ?? null;
}

export function getPeerTaskCommandController(taskId: string): TaskCommandController | null {
  const controller = getTaskCommandController(taskId);
  if (!controller) {
    return null;
  }

  if (controller.controllerId === getRuntimeClientId()) {
    return null;
  }

  return controller;
}

export function getPeerTaskCommandControlMessage(
  taskId: string,
  fallbackAction: string,
): string | null {
  return getPeerTaskCommandControlStatus(taskId, fallbackAction)?.message ?? null;
}

export function getPeerTaskCommandControlStatus(
  taskId: string,
  fallbackAction: string,
): PeerTaskCommandControlStatus | null {
  const controller = getPeerTaskCommandController(taskId);
  if (!controller) {
    return null;
  }

  const action = controller.action ?? fallbackAction;
  return {
    action,
    controllerId: controller.controllerId,
    controllerKey: `${controller.controllerId}:${action}`,
    label: getTaskCommandControlLabel(action),
    message: getTaskCommandControlMessage(action),
  };
}

export function isTaskCommandControlledByPeer(taskId: string): boolean {
  return getPeerTaskCommandController(taskId) !== null;
}
