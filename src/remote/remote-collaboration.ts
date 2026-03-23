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
import { isChangedFileStatus } from '../domain/git-status';
import type {
  AgentSupervisionEvent,
  AgentSupervisionSnapshot,
  AgentSupervisionState,
  PeerPresenceSnapshot,
  TaskCommandControllerSnapshot,
  TaskAttentionReason,
  TaskPortSnapshot,
} from '../domain/server-state';
import type { AnyServerStateBootstrapSnapshot } from '../domain/server-state-bootstrap';
import type { TaskReviewEvent, TaskReviewSnapshot, TaskReviewSource } from '../domain/task-review';
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

type RemoteIpcEventHandling =
  | 'handle-agent-supervision'
  | 'handle-task-command-controller'
  | 'handle-task-review'
  | 'ignore';

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
  [IPC.AgentSupervisionChanged]: 'handle-agent-supervision',
  [IPC.GitStatusChanged]: 'ignore',
  [IPC.TaskCommandControllerChanged]: 'handle-task-command-controller',
  [IPC.TaskConvergenceChanged]: 'ignore',
  [IPC.TaskReviewChanged]: 'handle-task-review',
} as const satisfies Record<RemoteLiveIpcEventChannel, RemoteIpcEventHandling>;

const AGENT_SUPERVISION_STATE_SET: ReadonlySet<AgentSupervisionState> = new Set([
  'active',
  'awaiting-input',
  'idle-at-prompt',
  'quiet',
  'paused',
  'flow-controlled',
  'restoring',
  'exited-clean',
  'exited-error',
]);

const TASK_ATTENTION_REASON_SET: ReadonlySet<TaskAttentionReason> = new Set([
  'waiting-input',
  'ready-for-next-step',
  'failed',
  'paused',
  'flow-controlled',
  'restoring',
  'quiet-too-long',
]);

const TASK_REVIEW_SOURCE_SET: ReadonlySet<TaskReviewSource> = new Set([
  'worktree',
  'branch-fallback',
  'unavailable',
]);
const TASK_PREVIEW_AVAILABILITY_SET: ReadonlySet<string> = new Set([
  'unknown',
  'available',
  'unavailable',
]);
const TASK_PORT_PROTOCOL_SET: ReadonlySet<string> = new Set(['http', 'https']);
const TASK_EXPOSED_PORT_SOURCE_SET: ReadonlySet<string> = new Set(['manual', 'observed']);
const TASK_OBSERVED_PORT_SOURCE_SET: ReadonlySet<string> = new Set(['output', 'rediscovery']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringMember<T extends string>(value: unknown, members: ReadonlySet<T>): value is T {
  return typeof value === 'string' && members.has(value as T);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isAgentSupervisionState(value: unknown): value is AgentSupervisionState {
  return isStringMember(value, AGENT_SUPERVISION_STATE_SET);
}

function isTaskAttentionReason(value: unknown): value is TaskAttentionReason {
  return isStringMember(value, TASK_ATTENTION_REASON_SET);
}

function isNullableTaskAttentionReason(value: unknown): value is TaskAttentionReason | null {
  return value === null || isTaskAttentionReason(value);
}

function isTaskReviewSource(value: unknown): value is TaskReviewSource {
  return isStringMember(value, TASK_REVIEW_SOURCE_SET);
}

function isTaskPreviewAvailability(value: unknown): boolean {
  return isStringMember(value, TASK_PREVIEW_AVAILABILITY_SET);
}

function isTaskPortProtocol(value: unknown): boolean {
  return isStringMember(value, TASK_PORT_PROTOCOL_SET);
}

function isTaskExposedPortSource(value: unknown): boolean {
  return isStringMember(value, TASK_EXPOSED_PORT_SOURCE_SET);
}

function isTaskObservedPortSource(value: unknown): boolean {
  return isStringMember(value, TASK_OBSERVED_PORT_SOURCE_SET);
}

function isTaskReviewFilePayload(value: unknown): value is TaskReviewSnapshot['files'][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.path === 'string' &&
    typeof value.status === 'string' &&
    isChangedFileStatus(value.status) &&
    typeof value.committed === 'boolean' &&
    isFiniteNumber(value.lines_added) &&
    isFiniteNumber(value.lines_removed)
  );
}

function isTaskExposedPortSnapshotPayload(
  value: unknown,
): value is TaskPortSnapshot['exposed'][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isTaskPreviewAvailability(value.availability) &&
    isNullableString(value.host) &&
    isNullableString(value.label) &&
    isNullableFiniteNumber(value.lastVerifiedAt) &&
    isFiniteNumber(value.port) &&
    isTaskPortProtocol(value.protocol) &&
    isTaskExposedPortSource(value.source) &&
    isNullableString(value.statusMessage) &&
    isFiniteNumber(value.updatedAt) &&
    isNullableString(value.verifiedHost)
  );
}

function isTaskObservedPortSnapshotPayload(
  value: unknown,
): value is TaskPortSnapshot['observed'][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNullableString(value.host) &&
    isFiniteNumber(value.port) &&
    isTaskPortProtocol(value.protocol) &&
    isTaskObservedPortSource(value.source) &&
    typeof value.suggestion === 'string' &&
    isFiniteNumber(value.updatedAt)
  );
}

function isRemovedPayload(
  payload: unknown,
): payload is Record<string, unknown> & { removed: true } {
  return isRecord(payload) && 'removed' in payload && payload.removed === true;
}

function isAgentSupervisionSnapshotPayload(payload: unknown): payload is AgentSupervisionSnapshot {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    typeof payload.agentId === 'string' &&
    isNullableTaskAttentionReason(payload.attentionReason) &&
    typeof payload.isShell === 'boolean' &&
    isNullableFiniteNumber(payload.lastOutputAt) &&
    typeof payload.preview === 'string' &&
    isAgentSupervisionState(payload.state) &&
    typeof payload.taskId === 'string' &&
    isFiniteNumber(payload.updatedAt)
  );
}

function isAgentSupervisionPayload(payload: unknown): payload is AgentSupervisionEvent {
  if (!isRecord(payload)) {
    return false;
  }

  if (isRemovedPayload(payload)) {
    return (
      payload.kind === 'removed' &&
      typeof payload.agentId === 'string' &&
      isNullableString(payload.taskId)
    );
  }

  return payload.kind === 'snapshot' && isAgentSupervisionSnapshotPayload(payload);
}

function isTaskReviewSnapshotPayload(payload: unknown): payload is TaskReviewSnapshot {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    typeof payload.taskId === 'string' &&
    typeof payload.branchName === 'string' &&
    typeof payload.projectId === 'string' &&
    typeof payload.revisionId === 'string' &&
    Array.isArray(payload.files) &&
    payload.files.every(isTaskReviewFilePayload) &&
    isTaskReviewSource(payload.source) &&
    isFiniteNumber(payload.totalAdded) &&
    isFiniteNumber(payload.totalRemoved) &&
    isFiniteNumber(payload.updatedAt) &&
    typeof payload.worktreePath === 'string'
  );
}

function isTaskReviewPayload(payload: unknown): payload is TaskReviewEvent {
  if (!isRecord(payload)) {
    return false;
  }

  if (isRemovedPayload(payload)) {
    return typeof payload.taskId === 'string';
  }

  return isTaskReviewSnapshotPayload(payload);
}

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
    isFiniteNumber(payload.version)
  );
}

function isTaskPortsSnapshotPayload(payload: unknown): payload is TaskPortSnapshot {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    typeof payload.taskId === 'string' &&
    isFiniteNumber(payload.updatedAt) &&
    Array.isArray(payload.exposed) &&
    payload.exposed.every(isTaskExposedPortSnapshotPayload) &&
    Array.isArray(payload.observed) &&
    payload.observed.every(isTaskObservedPortSnapshotPayload)
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
  if (!Number.isFinite(version)) {
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
      case 'task-convergence':
        break;
      case 'agent-supervision':
        replaceRemoteAgentSupervisionSnapshots(
          snapshot.payload.filter(isAgentSupervisionSnapshotPayload),
          snapshot.version,
        );
        break;
      case 'peer-presence':
        replacePeerPresenceSnapshots(snapshot.payload);
        break;
      case 'task-command-controller':
        replaceTaskCommandControllerSnapshots(
          snapshot.payload.filter(isTaskCommandControllerSnapshotPayload),
          snapshot.version,
        );
        break;
      case 'task-review':
        replaceRemoteTaskReviewSnapshots(
          snapshot.payload.filter(isTaskReviewSnapshotPayload),
          snapshot.version,
        );
        break;
      case 'task-ports':
        replaceRemoteTaskPortsSnapshots(
          snapshot.payload.filter(isTaskPortsSnapshotPayload),
          snapshot.version,
        );
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
    case 'handle-agent-supervision':
      if (isAgentSupervisionPayload(payload)) {
        applyRemoteAgentSupervisionChanged(payload);
      }
      return;
    case 'handle-task-command-controller':
      if (isTaskCommandControllerSnapshotPayload(payload)) {
        applyRemoteTaskCommandControllerChanged(payload);
      }
      return;
    case 'handle-task-review':
      if (isTaskReviewPayload(payload)) {
        applyRemoteTaskReviewChanged(payload);
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
