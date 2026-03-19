import { createSignal } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import type {
  TaskCommandTakeoverRequestMessage,
  TaskCommandTakeoverResultMessage,
} from '../../electron/remote/protocol';
import {
  isRemoteLiveIpcEventChannel,
  type RemoteLiveIpcEventChannel,
} from '../domain/remote-live-ipc-events';
import type { PeerPresenceSnapshot, TaskCommandControllerSnapshot } from '../domain/server-state';
import type { AnyServerStateBootstrapSnapshot } from '../domain/server-state-bootstrap';
import { assertNever } from '../lib/assert-never';
import {
  applyTaskCommandControllerSnapshotRecord,
  areTaskCommandControllerStatesEqual,
  getTaskCommandControllerSnapshot,
  normalizeTaskCommandControllerSnapshots,
  shouldApplyTaskCommandControllerVersion,
} from '../domain/task-command-controller-projection';
import {
  getPresenceBackedTaskCommandOwnerStatus,
  getTaskCommandControllerOwnerStatus,
  type TaskCommandOwnerStatus,
} from '../domain/task-command-owner-status';
import { getRemoteClientId } from './client-id';

type RemoteIpcEventHandling = 'handle-task-command-controller' | 'ignore';

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
const taskCommandControllerVersionByTaskId = new Map<string, number>();

const REMOTE_LIVE_IPC_EVENT_HANDLING = {
  [IPC.AgentSupervisionChanged]: 'ignore',
  [IPC.GitStatusChanged]: 'ignore',
  [IPC.TaskCommandControllerChanged]: 'handle-task-command-controller',
  [IPC.TaskConvergenceChanged]: 'ignore',
  [IPC.TaskReviewChanged]: 'ignore',
} as const satisfies Record<RemoteLiveIpcEventChannel, RemoteIpcEventHandling>;

function isTaskCommandControllerSnapshotPayload(
  payload: unknown,
): payload is TaskCommandControllerSnapshot {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  return (
    'action' in payload &&
    (typeof payload.action === 'string' || payload.action === null) &&
    'controllerId' in payload &&
    (typeof payload.controllerId === 'string' || payload.controllerId === null) &&
    'taskId' in payload &&
    typeof payload.taskId === 'string' &&
    'version' in payload &&
    typeof payload.version === 'number'
  );
}

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

function syncRemoteTaskCommandControllerVersions(
  taskIds: ReadonlySet<string>,
  snapshots: Readonly<Record<string, TaskCommandControllerSnapshot>>,
  fallbackVersion: number,
): void {
  for (const taskId of taskIds) {
    taskCommandControllerVersionByTaskId.set(taskId, snapshots[taskId]?.version ?? fallbackVersion);
  }
}

function notifyRemoteTaskCommandControllerReplaced(
  previousControllers: Readonly<Record<string, TaskCommandControllerSnapshot>>,
  nextControllers: Readonly<Record<string, TaskCommandControllerSnapshot>>,
  replaceVersion: number,
): void {
  const changedTaskIds = new Set([
    ...Object.keys(previousControllers),
    ...Object.keys(nextControllers),
  ]);

  for (const taskId of changedTaskIds) {
    const previousController = previousControllers[taskId];
    const nextController = nextControllers[taskId];
    if (areTaskCommandControllerStatesEqual(previousController, nextController)) {
      continue;
    }

    const snapshot = getTaskCommandControllerSnapshot(
      taskId,
      nextController,
      taskCommandControllerVersionByTaskId.get(taskId) ?? replaceVersion,
    );
    for (const listener of taskCommandControllerChangeListeners) {
      listener(snapshot);
    }
  }
}

function replaceTaskCommandControllerSnapshots(
  snapshots: ReadonlyArray<TaskCommandControllerSnapshot>,
  version: number,
): void {
  if (version < taskCommandControllerReplaceVersion) {
    return;
  }

  taskCommandControllerReplaceVersion = version;
  const previousControllers = taskCommandControllers();
  const nextControllers = normalizeTaskCommandControllerSnapshots(snapshots);
  const changedTaskIds = new Set([
    ...Object.keys(previousControllers),
    ...Object.keys(nextControllers),
  ]);
  syncRemoteTaskCommandControllerVersions(changedTaskIds, nextControllers, version);

  setTaskCommandControllers(nextControllers);
  notifyRemoteTaskCommandControllerReplaced(previousControllers, nextControllers, version);
}

export function applyRemoteTaskCommandControllerChanged(
  snapshot: TaskCommandControllerSnapshot,
): void {
  const currentVersion = taskCommandControllerVersionByTaskId.get(snapshot.taskId) ?? -1;
  if (!shouldApplyTaskCommandControllerVersion(currentVersion, snapshot)) {
    return;
  }

  setTaskCommandControllers((current) =>
    applyTaskCommandControllerSnapshotRecord(current, snapshot),
  );
  taskCommandControllerVersionByTaskId.set(snapshot.taskId, snapshot.version);

  for (const listener of taskCommandControllerChangeListeners) {
    listener(snapshot);
  }
}

export function applyRemoteStateBootstrap(
  snapshots: ReadonlyArray<AnyServerStateBootstrapSnapshot>,
): void {
  for (const snapshot of snapshots) {
    switch (snapshot.category) {
      case 'git-status':
      case 'remote-status':
      case 'agent-supervision':
      case 'task-convergence':
      case 'task-review':
      case 'task-ports':
        break;
      case 'peer-presence':
        replacePeerPresenceSnapshots(snapshot.payload);
        break;
      case 'task-command-controller':
        replaceTaskCommandControllerSnapshots(snapshot.payload, snapshot.version);
        break;
      default:
        assertNever(snapshot, 'Unhandled remote bootstrap snapshot category');
    }
  }
}

export function applyRemoteIpcEvent(channel: string, payload: unknown): void {
  if (!isRemoteLiveIpcEventChannel(channel)) {
    return;
  }

  const handling = REMOTE_LIVE_IPC_EVENT_HANDLING[channel];
  switch (handling) {
    case 'ignore':
      return;
    case 'handle-task-command-controller':
      if (isTaskCommandControllerSnapshotPayload(payload)) {
        applyRemoteTaskCommandControllerChanged(payload);
      }
      return;
  }

  return assertNever(handling, 'Unhandled remote IPC event handling mode');
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

export function getRemoteTaskControllerOwnerStatus(taskId: string): TaskCommandOwnerStatus | null {
  return getTaskCommandControllerOwnerStatus(getRemoteTaskCommandController(taskId), {
    fallbackAction: 'control this task',
    getDisplayName: (controllerId) => peerSessions()[controllerId]?.displayName ?? null,
    selfClientId: getRemoteClientId(),
  });
}

export function getRemoteControllingTaskIds(): string[] {
  const selfClientId = getRemoteClientId();
  return Object.values(taskCommandControllers())
    .filter((snapshot) => snapshot.controllerId === selfClientId)
    .map((snapshot) => snapshot.taskId)
    .sort();
}

export function getRemoteTaskOwnerStatus(taskId: string): TaskCommandOwnerStatus | null {
  const controllerStatus = getRemoteTaskControllerOwnerStatus(taskId);
  if (controllerStatus) {
    return controllerStatus;
  }

  return getPresenceBackedTaskCommandOwnerStatus(taskId, Object.values(peerSessions()), {
    fallbackAction: 'control this task',
    includeSelf: true,
    selfClientId: getRemoteClientId(),
  });
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
  taskCommandControllerVersionByTaskId.clear();
}
