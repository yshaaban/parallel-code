import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import type { TaskCommandControllerSnapshot } from '../domain/server-state';
import { invoke } from '../lib/ipc';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { setStore, store } from './core';
import { getPeerDisplayName, listPeerSessions } from './peer-presence';
import type { TaskCommandController } from './types';

let taskCommandControllerUpdateCount = 0;

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
  switch (focusedSurface) {
    case 'prompt':
      return 'send a prompt';
    case 'ai-terminal':
      return 'type in the terminal';
  }

  if (focusedSurface?.startsWith('shell:') === true) {
    return 'type in the terminal';
  }

  return fallbackAction;
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
