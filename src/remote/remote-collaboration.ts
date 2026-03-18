import { createSignal } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import type {
  TaskCommandTakeoverRequestMessage,
  TaskCommandTakeoverResultMessage,
} from '../../electron/remote/protocol';
import type { PeerPresenceSnapshot, TaskCommandControllerSnapshot } from '../domain/server-state';
import type { AnyServerStateBootstrapSnapshot } from '../domain/server-state-bootstrap';
import { getTaskCommandActionForFocusedSurface } from '../domain/task-command-focus';
import { getRemoteClientId } from './client-id';

export interface RemoteTaskOwnerStatus {
  action: string;
  controllerId: string;
  isSelf: boolean;
  label: string;
}

type TaskCommandControllerChangeListener = (snapshot: TaskCommandControllerSnapshot) => void;
type TaskCommandTakeoverResultListener = (message: TaskCommandTakeoverResultMessage) => void;

const [peerSessions, setPeerSessions] = createSignal<Record<string, PeerPresenceSnapshot>>({});
const [taskCommandControllers, setTaskCommandControllers] = createSignal<
  Record<string, TaskCommandControllerSnapshot>
>({});
const [incomingTakeoverRequests, setIncomingTakeoverRequests] = createSignal<
  Record<string, TaskCommandTakeoverRequestMessage>
>({});

const taskCommandControllerChangeListeners = new Set<TaskCommandControllerChangeListener>();
const taskCommandTakeoverResultListeners = new Set<TaskCommandTakeoverResultListener>();

let taskCommandControllerReplaceVersion = -1;

function sortPeerSessions(
  snapshots: ReadonlyArray<PeerPresenceSnapshot>,
): ReadonlyArray<PeerPresenceSnapshot> {
  return [...snapshots].sort((left, right) => {
    const displayNameComparison = left.displayName.localeCompare(right.displayName);
    if (displayNameComparison !== 0) {
      return displayNameComparison;
    }

    return left.clientId.localeCompare(right.clientId);
  });
}

function getTaskCommandStatusVerb(action: string): string {
  return action === 'type in the terminal' ? 'typing' : 'active';
}

function getPresenceBackedAction(focusedSurface: string | null, fallbackAction: string): string {
  return getTaskCommandActionForFocusedSurface(focusedSurface, fallbackAction);
}

function findMostRecentControllingPeer(taskId: string): PeerPresenceSnapshot | null {
  const selfClientId = getRemoteClientId();
  let mostRecentPeer: PeerPresenceSnapshot | null = null;

  for (const session of Object.values(peerSessions())) {
    if (session.clientId === selfClientId) {
      continue;
    }

    if (!session.controllingTaskIds.includes(taskId)) {
      continue;
    }

    if (!mostRecentPeer || session.lastSeenAt > mostRecentPeer.lastSeenAt) {
      mostRecentPeer = session;
    }
  }

  return mostRecentPeer;
}

function toOwnerStatus(
  controllerId: string,
  action: string,
  displayName: string | null,
): RemoteTaskOwnerStatus {
  const isSelf = controllerId === getRemoteClientId();
  const label = `${isSelf ? 'You' : (displayName ?? 'Another session')} ${getTaskCommandStatusVerb(action)}`;

  return {
    action,
    controllerId,
    isSelf,
    label,
  };
}

function hasControllerId(
  controller: TaskCommandControllerSnapshot | null,
): controller is TaskCommandControllerSnapshot & { controllerId: string } {
  return controller?.controllerId !== null && controller?.controllerId !== undefined;
}

function toControllerOwnerStatus(
  controller: TaskCommandControllerSnapshot & { controllerId: string },
): RemoteTaskOwnerStatus {
  const displayName = peerSessions()[controller.controllerId]?.displayName ?? null;
  return toOwnerStatus(
    controller.controllerId,
    controller.action ?? 'control this task',
    displayName,
  );
}

function replacePeerPresenceSnapshots(snapshots: ReadonlyArray<PeerPresenceSnapshot>): void {
  const nextSessions: Record<string, PeerPresenceSnapshot> = {};
  for (const snapshot of sortPeerSessions(snapshots)) {
    nextSessions[snapshot.clientId] = snapshot;
  }

  setPeerSessions(nextSessions);
}

function omitRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _omitted, ...next } = record;
  return next;
}

function shouldApplyTaskCommandControllerSnapshot(
  previous: TaskCommandControllerSnapshot | undefined,
  next: TaskCommandControllerSnapshot,
): boolean {
  return !previous || next.version >= previous.version;
}

function applyTaskCommandControllerSnapshotRecord(
  previous: Record<string, TaskCommandControllerSnapshot>,
  snapshot: TaskCommandControllerSnapshot,
): Record<string, TaskCommandControllerSnapshot> {
  const current = previous[snapshot.taskId];
  if (!shouldApplyTaskCommandControllerSnapshot(current, snapshot)) {
    return previous;
  }

  if (!snapshot.controllerId) {
    if (!current) {
      return previous;
    }

    return omitRecordKey(previous, snapshot.taskId);
  }

  return {
    ...previous,
    [snapshot.taskId]: snapshot,
  };
}

function normalizeTaskCommandControllers(
  snapshots: ReadonlyArray<TaskCommandControllerSnapshot>,
): Record<string, TaskCommandControllerSnapshot> {
  let nextControllers: Record<string, TaskCommandControllerSnapshot> = {};
  const sortedSnapshots = [...snapshots].sort((left, right) => left.version - right.version);

  for (const snapshot of sortedSnapshots) {
    nextControllers = applyTaskCommandControllerSnapshotRecord(nextControllers, snapshot);
  }

  return nextControllers;
}

function replaceTaskCommandControllerSnapshots(
  snapshots: ReadonlyArray<TaskCommandControllerSnapshot>,
  version: number,
): void {
  if (version < taskCommandControllerReplaceVersion) {
    return;
  }

  taskCommandControllerReplaceVersion = version;
  setTaskCommandControllers(normalizeTaskCommandControllers(snapshots));
}

export function applyRemoteTaskCommandControllerChanged(
  snapshot: TaskCommandControllerSnapshot,
): void {
  const previous = taskCommandControllers()[snapshot.taskId];
  if (!shouldApplyTaskCommandControllerSnapshot(previous, snapshot)) {
    return;
  }

  setTaskCommandControllers((current) =>
    applyTaskCommandControllerSnapshotRecord(current, snapshot),
  );

  for (const listener of taskCommandControllerChangeListeners) {
    listener(snapshot);
  }
}

export function applyRemoteStateBootstrap(
  snapshots: ReadonlyArray<AnyServerStateBootstrapSnapshot>,
): void {
  for (const snapshot of snapshots) {
    switch (snapshot.category) {
      case 'peer-presence':
        replacePeerPresenceSnapshots(snapshot.payload);
        break;
      case 'task-command-controller':
        replaceTaskCommandControllerSnapshots(snapshot.payload, snapshot.version);
        break;
      default:
        break;
    }
  }
}

export function applyRemoteIpcEvent(channel: string, payload: unknown): void {
  if (
    channel === IPC.TaskCommandControllerChanged &&
    typeof payload === 'object' &&
    payload !== null &&
    'taskId' in payload &&
    'version' in payload
  ) {
    applyRemoteTaskCommandControllerChanged(payload as TaskCommandControllerSnapshot);
  }
}

export function replaceRemotePeerPresences(snapshots: ReadonlyArray<PeerPresenceSnapshot>): void {
  replacePeerPresenceSnapshots(snapshots);
}

export function upsertIncomingRemoteTakeoverRequest(
  message: TaskCommandTakeoverRequestMessage,
): void {
  setIncomingTakeoverRequests((previous) => ({
    ...previous,
    [message.requestId]: message,
  }));
}

export function clearIncomingRemoteTakeoverRequest(requestId: string): void {
  setIncomingTakeoverRequests((previous) => omitRecordKey(previous, requestId));
}

export function clearIncomingRemoteTakeoverRequests(): void {
  setIncomingTakeoverRequests({});
}

export function handleRemoteTakeoverResult(message: TaskCommandTakeoverResultMessage): void {
  clearIncomingRemoteTakeoverRequest(message.requestId);
  for (const listener of taskCommandTakeoverResultListeners) {
    listener(message);
  }
}

export function getIncomingRemoteTakeoverRequests(): TaskCommandTakeoverRequestMessage[] {
  return Object.values(incomingTakeoverRequests()).sort(
    (left, right) => left.expiresAt - right.expiresAt,
  );
}

export function getRemoteTaskCommandController(
  taskId: string,
): TaskCommandControllerSnapshot | null {
  return taskCommandControllers()[taskId] ?? null;
}

export function getRemoteTaskControllerOwnerStatus(taskId: string): RemoteTaskOwnerStatus | null {
  const controller = getRemoteTaskCommandController(taskId);
  if (!hasControllerId(controller)) {
    return null;
  }

  return toControllerOwnerStatus(controller);
}

export function getRemoteControllingTaskIds(): string[] {
  const selfClientId = getRemoteClientId();
  return Object.values(taskCommandControllers())
    .filter((snapshot) => snapshot.controllerId === selfClientId)
    .map((snapshot) => snapshot.taskId)
    .sort();
}

export function getRemoteTaskOwnerStatus(taskId: string): RemoteTaskOwnerStatus | null {
  const controllerStatus = getRemoteTaskControllerOwnerStatus(taskId);
  if (controllerStatus) {
    return controllerStatus;
  }

  const controllingPeer = findMostRecentControllingPeer(taskId);
  if (!controllingPeer) {
    return null;
  }

  return toOwnerStatus(
    controllingPeer.clientId,
    getPresenceBackedAction(controllingPeer.focusedSurface, 'control this task'),
    controllingPeer.displayName,
  );
}

export function subscribeRemoteTaskCommandControllerChanges(
  listener: TaskCommandControllerChangeListener,
): () => void {
  taskCommandControllerChangeListeners.add(listener);
  return () => {
    taskCommandControllerChangeListeners.delete(listener);
  };
}

export function subscribeRemoteTaskCommandTakeoverResults(
  listener: TaskCommandTakeoverResultListener,
): () => void {
  taskCommandTakeoverResultListeners.add(listener);
  return () => {
    taskCommandTakeoverResultListeners.delete(listener);
  };
}

export function resetRemoteCollaborationStateForTests(): void {
  setPeerSessions({});
  setTaskCommandControllers({});
  setIncomingTakeoverRequests({});
  taskCommandControllerChangeListeners.clear();
  taskCommandTakeoverResultListeners.clear();
  taskCommandControllerReplaceVersion = -1;
}
