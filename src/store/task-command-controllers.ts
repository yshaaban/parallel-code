import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import type { TaskCommandControllerSnapshot } from '../domain/server-state';
import {
  areTaskCommandControllerStatesEqual,
  getTaskCommandControllerSnapshot,
  normalizeTaskCommandControllerSnapshots,
  shouldApplyTaskCommandControllerVersion,
} from '../domain/task-command-controller-projection';
import {
  findMostRecentControllingSession as findMostRecentControllingPeerSession,
  getPresenceBackedTaskCommandOwnerStatus,
  getTaskCommandControllerOwnerStatus,
  getTaskCommandStatusVerb,
  type TaskCommandOwnerStatus,
} from '../domain/task-command-owner-status';
import { getTaskCommandActionForFocusedSurface } from '../domain/task-command-focus';
import { invoke } from '../lib/ipc';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { setStore, store } from './core';
import { getPeerDisplayName, listPeerSessions } from './peer-presence';
import type { TaskCommandController } from './types';

let taskCommandControllerUpdateCount = 0;
const taskCommandControllerChangeListeners = new Set<
  (snapshot: TaskCommandControllerSnapshot) => void
>();
const taskCommandControllerVersionByTaskId = new Map<string, number>();
let taskCommandControllerVersion = 0;

export interface PeerTaskCommandControlStatus {
  action: string;
  controllerId: string;
  controllerKey: string;
  label: string;
  message: string;
}

type PeerSession = ReturnType<typeof listPeerSessions>[number];

function getTaskCommandControlMessage(action: string): string {
  if (action === 'type in the terminal') {
    return 'Another browser session is currently typing in this terminal.';
  }

  if (action === 'send a prompt') {
    return 'Another browser session is currently sending prompts for this task.';
  }

  return `Another browser session is controlling this task to ${action}.`;
}

function getControllerDisplayName(controllerId: string): string {
  return getPeerDisplayName(controllerId) ?? 'Another session';
}

function getPresenceBackedAction(focusedSurface: string | null, fallbackAction: string): string {
  return getTaskCommandActionForFocusedSurface(focusedSurface, fallbackAction);
}

function findMostRecentPresenceBackedSession(
  taskId: string,
  options: {
    includeSelf?: boolean;
  } = {},
): PeerSession | null {
  return findMostRecentControllingPeerSession(taskId, listPeerSessions(), {
    selfClientId: getRuntimeClientId(),
    ...(options.includeSelf !== undefined ? { includeSelf: options.includeSelf } : {}),
  });
}

function createPeerTaskCommandControlStatus(
  controllerId: string,
  action: string,
): PeerTaskCommandControlStatus {
  const displayName = getControllerDisplayName(controllerId);
  return {
    action,
    controllerId,
    controllerKey: `${controllerId}:${action}`,
    label: `${displayName} ${getTaskCommandStatusVerb(action)}`,
    message: getTaskCommandControlMessage(action).replace('Another browser session', displayName),
  };
}

function getPresenceBackedPeerTaskCommandControlStatus(
  taskId: string,
  fallbackAction: string,
): PeerTaskCommandControlStatus | null {
  const controllingPeer = findMostRecentPresenceBackedSession(taskId);
  if (!controllingPeer) {
    return null;
  }

  const action = getPresenceBackedAction(controllingPeer.focusedSurface, fallbackAction);
  return createPeerTaskCommandControlStatus(controllingPeer.clientId, action);
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
    version: snapshot.version,
  };
}

function notifyTaskCommandControllerChanged(snapshot: TaskCommandControllerSnapshot): void {
  for (const listener of taskCommandControllerChangeListeners) {
    listener(snapshot);
  }
}

function setTaskCommandControllerVersion(taskId: string, version: number): void {
  taskCommandControllerVersionByTaskId.set(taskId, version);
  taskCommandControllerVersion = Math.max(taskCommandControllerVersion, version);
}

function syncTaskCommandControllerVersions(
  taskIds: ReadonlySet<string>,
  controllers: Readonly<Record<string, TaskCommandController>>,
  fallbackVersion: number,
): void {
  for (const taskId of taskIds) {
    const nextVersion = controllers[taskId]?.version ?? fallbackVersion;
    taskCommandControllerVersionByTaskId.set(taskId, nextVersion);
  }
}

export function applyTaskCommandControllerChanged(snapshot: TaskCommandControllerSnapshot): void {
  const currentVersion = taskCommandControllerVersionByTaskId.get(snapshot.taskId) ?? -1;
  if (!shouldApplyTaskCommandControllerVersion(currentVersion, snapshot)) {
    return;
  }

  taskCommandControllerUpdateCount += 1;
  setTaskCommandControllerVersion(snapshot.taskId, snapshot.version);
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
  notifyTaskCommandControllerChanged(snapshot);
}

export function replaceTaskCommandControllers(
  snapshots: ReadonlyArray<TaskCommandControllerSnapshot>,
  options: {
    ifUnchangedSince?: number;
    replaceVersion?: number;
  } = {},
): void {
  if (
    options.ifUnchangedSince !== undefined &&
    taskCommandControllerUpdateCount !== options.ifUnchangedSince
  ) {
    return;
  }

  const replaceVersion =
    options.replaceVersion ??
    snapshots.reduce((highestVersion, snapshot) => Math.max(highestVersion, snapshot.version), 0);
  if (replaceVersion < taskCommandControllerVersion) {
    return;
  }

  const previousControllers = store.taskCommandControllers;
  const normalizedSnapshots = normalizeTaskCommandControllerSnapshots(snapshots);
  const nextControllers: Record<string, TaskCommandController> = {};
  for (const snapshot of Object.values(normalizedSnapshots)) {
    const controller = toTaskCommandController(snapshot);
    if (!controller) {
      continue;
    }

    nextControllers[snapshot.taskId] = controller;
  }

  setStore('taskCommandControllers', nextControllers);

  const changedTaskIds = new Set([
    ...Object.keys(previousControllers),
    ...Object.keys(nextControllers),
  ]);
  syncTaskCommandControllerVersions(changedTaskIds, nextControllers, replaceVersion);
  for (const taskId of changedTaskIds) {
    const previousController = previousControllers[taskId] ?? null;
    const nextController = nextControllers[taskId] ?? null;
    if (areTaskCommandControllerStatesEqual(previousController, nextController)) {
      continue;
    }

    notifyTaskCommandControllerChanged(
      getTaskCommandControllerSnapshot(
        taskId,
        nextController,
        taskCommandControllerVersionByTaskId.get(taskId) ?? 0,
      ),
    );
  }
  taskCommandControllerVersion = replaceVersion;
}

export function subscribeTaskCommandControllerChanges(
  listener: (snapshot: TaskCommandControllerSnapshot) => void,
): () => void {
  taskCommandControllerChangeListeners.add(listener);
  return () => {
    taskCommandControllerChangeListeners.delete(listener);
  };
}

export function getTaskCommandControllerUpdateCount(): number {
  return taskCommandControllerUpdateCount;
}

export async function loadTaskCommandControllers(options?: {
  ifUnchangedSince?: number;
}): Promise<void> {
  const result = await invoke(IPC.GetTaskCommandControllers).catch(() => ({
    controllers: [],
    version: taskCommandControllerVersion,
  }));
  replaceTaskCommandControllers(result.controllers, {
    ...options,
    replaceVersion: result.version,
  });
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
    return getPresenceBackedPeerTaskCommandControlStatus(taskId, fallbackAction);
  }

  const action = controller.action ?? fallbackAction;
  return createPeerTaskCommandControlStatus(controller.controllerId, action);
}

export function isTaskCommandControlledByPeer(taskId: string): boolean {
  return getPeerTaskCommandController(taskId) !== null;
}

export function getTaskCommandOwnerStatus(taskId: string): TaskCommandOwnerStatus | null {
  const controller = getTaskCommandController(taskId);
  const controllerStatus = getTaskCommandControllerOwnerStatus(controller, {
    fallbackAction: 'control this task',
    getDisplayName: getControllerDisplayName,
    selfClientId: getRuntimeClientId(),
  });
  if (controllerStatus) {
    return controllerStatus;
  }

  return getPresenceBackedTaskCommandOwnerStatus(taskId, listPeerSessions(), {
    fallbackAction: 'control this task',
    includeSelf: true,
    selfClientId: getRuntimeClientId(),
  });
}

export function resetTaskCommandControllerStateForTests(): void {
  taskCommandControllerUpdateCount = 0;
  taskCommandControllerVersion = 0;
  taskCommandControllerVersionByTaskId.clear();
  taskCommandControllerChangeListeners.clear();
}

export function assertTaskCommandControllerStateCleanForTests(): void {
  if (taskCommandControllerChangeListeners.size !== 0) {
    throw new Error(
      `Expected no task-command-controller listeners, found ${taskCommandControllerChangeListeners.size}`,
    );
  }
}
