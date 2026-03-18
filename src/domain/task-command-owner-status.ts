import type { PeerPresenceSnapshot } from './server-state.js';
import { getTaskCommandActionForFocusedSurface } from './task-command-focus.js';

export interface TaskCommandOwnerStatus {
  action: string;
  controllerId: string;
  isSelf: boolean;
  label: string;
}

interface TaskCommandControllerLike {
  action: string | null | undefined;
  controllerId: string | null | undefined;
}

interface TaskCommandOwnerStatusOptions {
  action: string;
  controllerId: string;
  displayName: string | null;
  selfClientId: string;
}

interface PresenceBackedTaskCommandOwnerStatusOptions {
  fallbackAction: string;
  includeSelf?: boolean;
  selfClientId: string;
}

interface TaskCommandControllerOwnerStatusOptions {
  fallbackAction: string;
  getDisplayName: (controllerId: string) => string | null;
  selfClientId: string;
}

function isControllerLikeWithControllerId(
  controller: TaskCommandControllerLike | null | undefined,
): controller is TaskCommandControllerLike & { controllerId: string } {
  return controller?.controllerId !== null && controller?.controllerId !== undefined;
}

export function getTaskCommandStatusVerb(action: string): string {
  return action === 'type in the terminal' ? 'typing' : 'active';
}

export function createTaskCommandOwnerStatus(
  options: TaskCommandOwnerStatusOptions,
): TaskCommandOwnerStatus {
  const isSelf = options.controllerId === options.selfClientId;
  const displayName = isSelf ? 'You' : (options.displayName ?? 'Another session');

  return {
    action: options.action,
    controllerId: options.controllerId,
    isSelf,
    label: `${displayName} ${getTaskCommandStatusVerb(options.action)}`,
  };
}

export function findMostRecentControllingSession(
  taskId: string,
  sessions: ReadonlyArray<PeerPresenceSnapshot>,
  options: {
    includeSelf?: boolean;
    selfClientId: string;
  },
): PeerPresenceSnapshot | null {
  let mostRecentSession: PeerPresenceSnapshot | null = null;

  for (const session of sessions) {
    if (!options.includeSelf && session.clientId === options.selfClientId) {
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

export function getPresenceBackedTaskCommandOwnerStatus(
  taskId: string,
  sessions: ReadonlyArray<PeerPresenceSnapshot>,
  options: PresenceBackedTaskCommandOwnerStatusOptions,
): TaskCommandOwnerStatus | null {
  const controllingSession = findMostRecentControllingSession(taskId, sessions, {
    selfClientId: options.selfClientId,
    ...(options.includeSelf !== undefined ? { includeSelf: options.includeSelf } : {}),
  });
  if (!controllingSession) {
    return null;
  }

  return createTaskCommandOwnerStatus({
    action: getTaskCommandActionForFocusedSurface(
      controllingSession.focusedSurface,
      options.fallbackAction,
    ),
    controllerId: controllingSession.clientId,
    displayName: controllingSession.displayName,
    selfClientId: options.selfClientId,
  });
}

export function getTaskCommandControllerOwnerStatus(
  controller: TaskCommandControllerLike | null | undefined,
  options: TaskCommandControllerOwnerStatusOptions,
): TaskCommandOwnerStatus | null {
  if (!isControllerLikeWithControllerId(controller)) {
    return null;
  }

  return createTaskCommandOwnerStatus({
    action: controller.action ?? options.fallbackAction,
    controllerId: controller.controllerId,
    displayName: options.getDisplayName(controller.controllerId),
    selfClientId: options.selfClientId,
  });
}
