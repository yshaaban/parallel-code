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
import { filterPeerPresenceSnapshots, isAgentSupervisionEvent } from '../domain/server-state';
import type { PeerPresenceSnapshot, TaskCommandControllerSnapshot } from '../domain/server-state';
import {
  filterServerStateBootstrapSnapshots,
  type AnyServerStateBootstrapSnapshot,
  type ServerStateBootstrapCategory,
} from '../domain/server-state-bootstrap';
import { isTaskReviewEvent } from '../domain/task-review';
import { isNonNegativeInteger } from '../lib/type-guards';
import { publishTaskNotesInvalidation } from '../runtime/task-notes-invalidation';
import {
  applyTaskCommandControllerSnapshotRecord,
  areTaskCommandControllerStatesEqual,
  getTaskCommandControllerSnapshot,
  isTaskCommandControllerSnapshot,
  normalizeTaskCommandControllerSnapshots,
  shouldApplyTaskCommandControllerVersion,
} from '../domain/task-command-controller-projection';
import {
  getPresenceBackedTaskCommandOwnerStatus,
  getTaskCommandControllerOwnerStatus,
  type TaskCommandOwnerStatus,
} from '../domain/task-command-owner-status';
import { omitRecordKey } from '../lib/record-utils';
import { getRemoteClientId } from './client-id';
import {
  applyRemoteAgentSupervisionChanged,
  applyRemoteTaskReviewChanged,
  replaceRemoteAgentSupervisionSnapshots,
  replaceRemoteTaskPortsSnapshots,
  replaceRemoteTaskReviewSnapshots,
  resetRemoteTaskStateForTests,
} from './remote-task-state';

type TaskCommandControllerChangeListener = (snapshot: TaskCommandControllerSnapshot) => void;
type TaskCommandTakeoverResultListener = (message: TaskCommandTakeoverResultMessage) => void;
type RemoteBootstrapSnapshotFor<TCategory extends ServerStateBootstrapCategory> = Extract<
  AnyServerStateBootstrapSnapshot,
  { category: TCategory }
>;
type RemoteBootstrapCategoryHandler<TCategory extends ServerStateBootstrapCategory> = (
  snapshot: RemoteBootstrapSnapshotFor<TCategory>,
) => void;
type RemoteBootstrapSnapshotHandler = (snapshot: AnyServerStateBootstrapSnapshot) => void;
type RemoteIpcEventHandler = (payload: unknown) => void;

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

function replacePeerPresenceSnapshots(snapshots: ReadonlyArray<unknown>): void {
  const nextSessions: Record<string, PeerPresenceSnapshot> = {};
  for (const snapshot of sortPeerSessions(filterPeerPresenceSnapshots(snapshots))) {
    nextSessions[snapshot.clientId] = snapshot;
  }

  setPeerSessions(nextSessions);
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
  if (!isNonNegativeInteger(version)) {
    return;
  }
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

  const previousControllers = taskCommandControllers();
  const previousController = previousControllers[snapshot.taskId] ?? null;
  const nextController = snapshot.controllerId ? snapshot : null;
  const stateChanged = !areTaskCommandControllerStatesEqual(previousController, nextController);
  if (!stateChanged && snapshot.version <= currentVersion) {
    return;
  }

  const nextControllers = applyTaskCommandControllerSnapshotRecord(previousControllers, snapshot);
  if (nextControllers !== previousControllers) {
    setTaskCommandControllers(nextControllers);
  }
  taskCommandControllerVersionByTaskId.set(snapshot.taskId, snapshot.version);
  taskCommandControllerReplaceVersion = Math.max(
    taskCommandControllerReplaceVersion,
    snapshot.version,
  );

  if (!stateChanged) {
    return;
  }

  for (const listener of taskCommandControllerChangeListeners) {
    listener(snapshot);
  }
}

function replaceRemoteAgentSupervisionBootstrap(
  snapshot: RemoteBootstrapSnapshotFor<'agent-supervision'>,
): void {
  replaceRemoteAgentSupervisionSnapshots(snapshot.payload, snapshot.version);
}

function replaceRemotePeerPresenceBootstrap(
  snapshot: RemoteBootstrapSnapshotFor<'peer-presence'>,
): void {
  replacePeerPresenceSnapshots(snapshot.payload);
}

function replaceRemoteTaskCommandControllerBootstrap(
  snapshot: RemoteBootstrapSnapshotFor<'task-command-controller'>,
): void {
  replaceTaskCommandControllerSnapshots(snapshot.payload, snapshot.version);
}

function replaceRemoteTaskReviewBootstrap(
  snapshot: RemoteBootstrapSnapshotFor<'task-review'>,
): void {
  replaceRemoteTaskReviewSnapshots(snapshot.payload, snapshot.version);
}

function replaceRemoteTaskPortsBootstrap(snapshot: RemoteBootstrapSnapshotFor<'task-ports'>): void {
  replaceRemoteTaskPortsSnapshots(snapshot.payload, snapshot.version);
}

function isRemoteBootstrapSnapshotCategory<TCategory extends ServerStateBootstrapCategory>(
  snapshot: AnyServerStateBootstrapSnapshot,
  category: TCategory,
): snapshot is Extract<AnyServerStateBootstrapSnapshot, { category: TCategory }> {
  return snapshot.category === category;
}

function createRemoteBootstrapSnapshotHandler<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
  handle: RemoteBootstrapCategoryHandler<TCategory>,
): RemoteBootstrapSnapshotHandler {
  return (snapshot) => {
    if (isRemoteBootstrapSnapshotCategory(snapshot, category)) {
      handle(snapshot);
    }
  };
}

const REMOTE_BOOTSTRAP_SNAPSHOT_HANDLERS = {
  'agent-availability': null,
  'agent-supervision': createRemoteBootstrapSnapshotHandler(
    'agent-supervision',
    replaceRemoteAgentSupervisionBootstrap,
  ),
  coordinator: null,
  'git-status': null,
  'peer-presence': createRemoteBootstrapSnapshotHandler(
    'peer-presence',
    replaceRemotePeerPresenceBootstrap,
  ),
  'remote-status': null,
  'task-command-controller': createRemoteBootstrapSnapshotHandler(
    'task-command-controller',
    replaceRemoteTaskCommandControllerBootstrap,
  ),
  'task-convergence': null,
  'task-ports': createRemoteBootstrapSnapshotHandler('task-ports', replaceRemoteTaskPortsBootstrap),
  'task-review': createRemoteBootstrapSnapshotHandler(
    'task-review',
    replaceRemoteTaskReviewBootstrap,
  ),
  'task-review-signals': null,
  'task-steps': null,
} satisfies Record<ServerStateBootstrapCategory, RemoteBootstrapSnapshotHandler | null>;

export function applyRemoteStateBootstrap(snapshots: ReadonlyArray<unknown>): void {
  for (const snapshot of filterServerStateBootstrapSnapshots(snapshots)) {
    REMOTE_BOOTSTRAP_SNAPSHOT_HANDLERS[snapshot.category]?.(snapshot);
  }
}

function handleRemoteAgentSupervisionIpcEvent(payload: unknown): void {
  if (isAgentSupervisionEvent(payload)) {
    applyRemoteAgentSupervisionChanged(payload);
  }
}

function handleRemoteTaskCommandControllerIpcEvent(payload: unknown): void {
  if (isTaskCommandControllerSnapshot(payload)) {
    applyRemoteTaskCommandControllerChanged(payload);
  }
}

function handleRemoteTaskReviewIpcEvent(payload: unknown): void {
  if (isTaskReviewEvent(payload)) {
    applyRemoteTaskReviewChanged(payload);
  }
}

function handleRemoteTaskNotesChangedIpcEvent(payload: unknown): void {
  publishTaskNotesInvalidation(payload);
}

const REMOTE_LIVE_IPC_EVENT_HANDLERS = {
  [IPC.AgentSupervisionChanged]: handleRemoteAgentSupervisionIpcEvent,
  [IPC.GitStatusChanged]: null,
  [IPC.TaskCommandControllerChanged]: handleRemoteTaskCommandControllerIpcEvent,
  [IPC.TaskConvergenceChanged]: null,
  [IPC.TaskReviewChanged]: handleRemoteTaskReviewIpcEvent,
  [IPC.TaskReviewSignalsChanged]: null,
  [IPC.TaskStepsChanged]: null,
  [IPC.TaskNotesChanged]: handleRemoteTaskNotesChangedIpcEvent,
} satisfies Record<RemoteLiveIpcEventChannel, RemoteIpcEventHandler | null>;

export function applyRemoteIpcEvent(channel: string, payload: unknown): void {
  if (!isRemoteLiveIpcEventChannel(channel)) {
    return;
  }

  REMOTE_LIVE_IPC_EVENT_HANDLERS[channel]?.(payload);
}

export function replaceRemotePeerPresences(snapshots: ReadonlyArray<unknown>): void {
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

export function getRemoteTaskPresenceOwnerStatus(taskId: string): TaskCommandOwnerStatus | null {
  return getPresenceBackedTaskCommandOwnerStatus(taskId, Object.values(peerSessions()), {
    fallbackAction: 'control this task',
    includeSelf: true,
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

  return getRemoteTaskPresenceOwnerStatus(taskId);
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
  resetRemoteTaskStateForTests();
}
