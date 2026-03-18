import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import type { TaskCommandControllerSnapshot } from '../domain/server-state';
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

export interface TaskCommandOwnerStatus {
  action: string;
  controllerId: string;
  isSelf: boolean;
  label: string;
}

type PeerSession = ReturnType<typeof listPeerSessions>[number];

function getTaskCommandStatusVerb(action: string): string {
  return action === 'type in the terminal' ? 'typing' : 'active';
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

function getControllerDisplayName(controllerId: string): string {
  return getPeerDisplayName(controllerId) ?? 'Another session';
}

function getPresenceBackedAction(focusedSurface: string | null, fallbackAction: string): string {
  return getTaskCommandActionForFocusedSurface(focusedSurface, fallbackAction);
}

function findMostRecentControllingSession(
  taskId: string,
  options: {
    includeSelf?: boolean;
  } = {},
): PeerSession | null {
  const runtimeClientId = getRuntimeClientId();
  let mostRecentSession: PeerSession | null = null;

  for (const session of listPeerSessions()) {
    if (!options.includeSelf && session.clientId === runtimeClientId) {
      continue;
    }

    if (!session.controllingTaskIds.includes(taskId)) {
      continue;
    }

    if (!mostRecentSession || session.lastSeenAt > mostRecentSession.lastSeenAt) {
      mostRecentSession = session;
    }
  }

  return mostRecentSession;
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
  const controllingPeer = findMostRecentControllingSession(taskId);
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

function toTaskCommandControllerSnapshot(
  taskId: string,
  controller: TaskCommandController | null,
): TaskCommandControllerSnapshot {
  return {
    action: controller?.action ?? null,
    controllerId: controller?.controllerId ?? null,
    taskId,
    version: controller?.version ?? taskCommandControllerVersionByTaskId.get(taskId) ?? 0,
  };
}

function areTaskCommandControllersEqual(
  left: TaskCommandController | null,
  right: TaskCommandController | null,
): boolean {
  return left?.action === right?.action && left?.controllerId === right?.controllerId;
}

export function applyTaskCommandControllerChanged(snapshot: TaskCommandControllerSnapshot): void {
  const currentVersion = taskCommandControllerVersionByTaskId.get(snapshot.taskId) ?? -1;
  if (snapshot.version < currentVersion) {
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
  const nextControllers: Record<string, TaskCommandController> = {};
  for (const snapshot of snapshots) {
    const currentSnapshot = nextControllers[snapshot.taskId];
    if (currentSnapshot && currentSnapshot.version > snapshot.version) {
      continue;
    }

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
  for (const taskId of changedTaskIds) {
    const previousController = previousControllers[taskId] ?? null;
    const nextController = nextControllers[taskId] ?? null;
    const nextVersion = nextController?.version ?? replaceVersion;
    if (areTaskCommandControllersEqual(previousController, nextController)) {
      taskCommandControllerVersionByTaskId.set(taskId, nextVersion);
      continue;
    }

    taskCommandControllerVersionByTaskId.set(taskId, nextVersion);
    notifyTaskCommandControllerChanged(toTaskCommandControllerSnapshot(taskId, nextController));
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

function createTaskCommandOwnerStatus(
  controllerId: string,
  action: string,
): TaskCommandOwnerStatus {
  const isSelf = controllerId === getRuntimeClientId();
  const displayName = isSelf ? 'You' : getControllerDisplayName(controllerId);

  return {
    action,
    controllerId,
    isSelf,
    label: `${displayName} ${getTaskCommandStatusVerb(action)}`,
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
  if (controller) {
    return createTaskCommandOwnerStatus(
      controller.controllerId,
      controller.action ?? 'control this task',
    );
  }

  const controllingPeer = findMostRecentControllingSession(taskId, {
    includeSelf: true,
  });
  if (!controllingPeer) {
    return null;
  }

  return createTaskCommandOwnerStatus(
    controllingPeer.clientId,
    getPresenceBackedAction(controllingPeer.focusedSurface, 'control this task'),
  );
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
