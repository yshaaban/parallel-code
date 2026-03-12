import { IPC } from '../../electron/ipc/channels';
import {
  isRemovedTaskPortsEvent,
  type TaskPortSnapshot,
  type TaskPortsEvent,
} from '../domain/server-state';
import { getBrowserToken, isElectronRuntime } from '../lib/browser-auth';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';

function deleteRecordEntry<T>(record: Record<string, T>, key: string): void {
  Reflect.deleteProperty(record, key);
}

export function applyTaskPortsEvent(event: TaskPortsEvent): void {
  if (isRemovedTaskPortsEvent(event)) {
    setStore('taskPorts', (snapshots) => {
      const next = { ...snapshots };
      deleteRecordEntry(next, event.taskId);
      return next;
    });
    return;
  }

  setStore('taskPorts', event.taskId, event);
}

export function replaceTaskPortSnapshots(snapshots: ReadonlyArray<TaskPortSnapshot>): void {
  setStore('taskPorts', () =>
    Object.fromEntries(snapshots.map((snapshot) => [snapshot.taskId, snapshot])),
  );
}

export function getTaskPortSnapshot(taskId: string): TaskPortSnapshot | undefined {
  return store.taskPorts[taskId];
}

export function getTaskPreviewCandidatePorts(taskId: string): number[] {
  const snapshot = store.taskPorts[taskId];
  if (!snapshot) {
    return [];
  }

  const exposedPorts = snapshot.exposed.map((port) => port.port);
  const exposedPortSet = new Set(exposedPorts);
  const observedPorts = snapshot.observed
    .map((port) => port.port)
    .filter((port) => !exposedPortSet.has(port));
  return [...exposedPorts, ...observedPorts];
}

export function buildTaskPreviewUrl(taskId: string, port: number): string | null {
  if (isElectronRuntime()) {
    return `http://127.0.0.1:${port}/`;
  }

  const token = getBrowserToken();
  if (!token) {
    return null;
  }

  const encodedTaskId = encodeURIComponent(taskId);
  const encodedToken = encodeURIComponent(token);
  return `${window.location.origin}/_preview/${encodedTaskId}/${port}/?token=${encodedToken}`;
}

export async function fetchTaskPorts(): Promise<TaskPortSnapshot[]> {
  return invoke(IPC.GetTaskPorts);
}

export async function exposeTaskPortForTask(
  taskId: string,
  port: number,
  label?: string,
): Promise<TaskPortSnapshot> {
  return invoke(IPC.ExposePort, {
    taskId,
    port,
    ...(typeof label === 'string' ? { label } : {}),
  });
}

export async function unexposeTaskPortForTask(
  taskId: string,
  port: number,
): Promise<TaskPortSnapshot | undefined> {
  return invoke(IPC.UnexposePort, {
    taskId,
    port,
  });
}
