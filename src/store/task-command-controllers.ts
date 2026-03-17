import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import type { TaskCommandControllerSnapshot } from '../domain/server-state';
import { invoke } from '../lib/ipc';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { setStore, store } from './core';
import type { TaskCommandController } from './types';

let taskCommandControllerUpdateCount = 0;

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

export function isTaskCommandControlledByPeer(taskId: string): boolean {
  const controller = getTaskCommandController(taskId);
  if (!controller) {
    return false;
  }

  return controller.controllerId !== getRuntimeClientId();
}
