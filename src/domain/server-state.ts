import { assertNever } from '../lib/assert-never.js';
import { isRemovedTaskScopedKindEvent } from './removed-task-event.js';
import {
  isArrayOf,
  isNullableNonNegativeInteger,
  isNullableString,
  isNonNegativeInteger,
  isOptionalNonNegativeInteger,
  isOptionalString,
  isRecord,
  isStringArray,
  isStringKeyOf,
  isStringMember,
  isStringTupleMember,
  isTcpPortNumber,
} from '../lib/type-guards.js';

export type WorktreeStatusFreshness = 'fresh' | 'stale';

const WORKTREE_STATUS_FRESHNESS_VALUES: Record<WorktreeStatusFreshness, true> = {
  fresh: true,
  stale: true,
};

export interface WorktreeStatus {
  has_committed_changes: boolean;
  has_uncommitted_changes: boolean;
  freshness?: WorktreeStatusFreshness;
  updatedAt?: number;
  errorMessage?: string | null;
}

interface GitStatusSyncScopedEvent {
  branchName?: string;
  projectRoot?: string;
}

export type GitStatusSyncEventKind = 'refresh' | 'snapshot';

export interface GitStatusSyncSnapshotEvent extends GitStatusSyncScopedEvent {
  stateVersion?: number;
  status: WorktreeStatus;
  worktreePath: string;
}

export interface GitStatusSyncWorktreeRefreshEvent extends GitStatusSyncScopedEvent {
  stateVersion?: number;
  status?: undefined;
  worktreePath: string;
}

export interface GitStatusSyncBranchRefreshEvent {
  branchName: string;
  projectRoot: string;
  stateVersion?: number;
  status?: undefined;
  worktreePath?: undefined;
}

export interface GitStatusSyncProjectRefreshEvent {
  projectRoot: string;
  branchName?: undefined;
  stateVersion?: number;
  status?: undefined;
  worktreePath?: undefined;
}

export type GitStatusSyncRefreshEvent =
  | GitStatusSyncWorktreeRefreshEvent
  | GitStatusSyncBranchRefreshEvent
  | GitStatusSyncProjectRefreshEvent;

export type GitStatusSyncEvent = GitStatusSyncSnapshotEvent | GitStatusSyncRefreshEvent;

export type ClassifiedGitStatusSyncEvent =
  | { event: GitStatusSyncRefreshEvent; kind: 'refresh' }
  | { event: GitStatusSyncSnapshotEvent; kind: 'snapshot' };

export function isWorktreeStatus(value: unknown): value is WorktreeStatus {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.has_committed_changes === 'boolean' &&
    typeof value.has_uncommitted_changes === 'boolean' &&
    (value.freshness === undefined ||
      isStringMember(value.freshness, WORKTREE_STATUS_FRESHNESS_VALUES)) &&
    isOptionalNonNegativeInteger(value.updatedAt) &&
    (value.errorMessage === undefined || isNullableString(value.errorMessage))
  );
}

export function isGitStatusSyncSnapshotEvent(event: unknown): event is GitStatusSyncSnapshotEvent {
  if (!isRecord(event)) {
    return false;
  }

  return (
    typeof event.worktreePath === 'string' &&
    isWorktreeStatus(event.status) &&
    isOptionalString(event.branchName) &&
    isOptionalString(event.projectRoot) &&
    isOptionalNonNegativeInteger(event.stateVersion)
  );
}

export function isGitStatusSyncRefreshEvent(event: unknown): event is GitStatusSyncRefreshEvent {
  if (
    !isRecord(event) ||
    event.status !== undefined ||
    !isOptionalNonNegativeInteger(event.stateVersion)
  ) {
    return false;
  }

  if (typeof event.worktreePath === 'string') {
    return isOptionalString(event.branchName) && isOptionalString(event.projectRoot);
  }

  if (typeof event.branchName === 'string') {
    return typeof event.projectRoot === 'string' && event.worktreePath === undefined;
  }

  return typeof event.projectRoot === 'string' && event.worktreePath === undefined;
}

export function isGitStatusSyncEvent(value: unknown): value is GitStatusSyncEvent {
  return isGitStatusSyncSnapshotEvent(value) || isGitStatusSyncRefreshEvent(value);
}

export function getGitStatusSyncEventKind(event: GitStatusSyncEvent): GitStatusSyncEventKind {
  return isGitStatusSyncSnapshotEvent(event) ? 'snapshot' : 'refresh';
}

export function classifyGitStatusSyncEvent(
  event: GitStatusSyncEvent,
): ClassifiedGitStatusSyncEvent {
  if (isGitStatusSyncSnapshotEvent(event)) {
    return {
      event,
      kind: 'snapshot',
    };
  }

  return {
    event,
    kind: 'refresh',
  };
}

export function createGitStatusSyncSnapshotEvent(
  event: GitStatusSyncSnapshotEvent,
): GitStatusSyncSnapshotEvent {
  // Keep this as an identity factory so callers consume a typed, stable shape at the boundary.
  return event;
}

export function createGitStatusSyncRefreshEvent(
  event: GitStatusSyncRefreshEvent,
): GitStatusSyncRefreshEvent {
  // Keep this as an identity factory to preserve the same guard-by-type shape.
  return event;
}

function getGitStatusRefreshEventBufferKey(event: GitStatusSyncRefreshEvent): string {
  if (typeof event.worktreePath === 'string') {
    return `worktree:${event.worktreePath}`;
  }

  if (typeof event.branchName === 'string') {
    return `branch:${event.projectRoot}:${event.branchName}`;
  }

  return `project:${event.projectRoot}`;
}

export function getGitStatusSyncEventBufferKey(event: GitStatusSyncEvent): string {
  const classification = classifyGitStatusSyncEvent(event);
  switch (classification.kind) {
    case 'snapshot':
      return `worktree:${classification.event.worktreePath}`;
    case 'refresh':
      return getGitStatusRefreshEventBufferKey(classification.event);
    default:
      return assertNever(classification, 'Unhandled git status sync event kind');
  }
}

export interface TaskObservedPort {
  host: string | null;
  port: number;
  protocol: 'http' | 'https';
  source: 'output' | 'rediscovery';
  suggestion: string;
  updatedAt: number;
}

export type TaskPreviewAvailability = 'unknown' | 'available' | 'unavailable';

export interface TaskExposedPort {
  availability: TaskPreviewAvailability;
  host: string | null;
  label: string | null;
  lastVerifiedAt: number | null;
  port: number;
  protocol: 'http' | 'https';
  statusMessage: string | null;
  source: 'manual' | 'observed';
  updatedAt: number;
  verifiedHost: string | null;
}

export interface TaskPortSnapshot {
  exposed: TaskExposedPort[];
  observed: TaskObservedPort[];
  taskId: string;
  updatedAt: number;
}

export interface TaskPortExposureCandidate {
  host: string | null;
  port: number;
  source: 'task' | 'local';
  suggestion: string;
}

export type TaskPortProtocol = TaskExposedPort['protocol'] | TaskObservedPort['protocol'];
export type TaskExposedPortSource = TaskExposedPort['source'];
export type TaskObservedPortSource = TaskObservedPort['source'];

const TASK_PREVIEW_AVAILABILITY_VALUES = {
  available: true,
  unavailable: true,
  unknown: true,
} satisfies Record<TaskPreviewAvailability, true>;

const TASK_PORT_PROTOCOL_VALUES = {
  http: true,
  https: true,
} satisfies Record<TaskPortProtocol, true>;

const TASK_EXPOSED_PORT_SOURCE_VALUES = {
  manual: true,
  observed: true,
} satisfies Record<TaskExposedPortSource, true>;

const TASK_OBSERVED_PORT_SOURCE_VALUES = {
  output: true,
  rediscovery: true,
} satisfies Record<TaskObservedPortSource, true>;

const LOOPBACK_HOST_PATTERN = /^127(?:\.\d{1,3}){3}$/u;

export function isTaskPreviewAvailability(value: unknown): value is TaskPreviewAvailability {
  return isStringMember(value, TASK_PREVIEW_AVAILABILITY_VALUES);
}

export function isTaskPortProtocol(value: unknown): value is TaskPortProtocol {
  return isStringMember(value, TASK_PORT_PROTOCOL_VALUES);
}

export function isTaskExposedPortSource(value: unknown): value is TaskExposedPortSource {
  return isStringMember(value, TASK_EXPOSED_PORT_SOURCE_VALUES);
}

export function isTaskObservedPortSource(value: unknown): value is TaskObservedPortSource {
  return isStringMember(value, TASK_OBSERVED_PORT_SOURCE_VALUES);
}

export function isTaskExposedPort(value: unknown): value is TaskExposedPort {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isTaskPreviewAvailability(value.availability) &&
    isNullableString(value.host) &&
    isNullableString(value.label) &&
    isNullableNonNegativeInteger(value.lastVerifiedAt) &&
    isTcpPortNumber(value.port) &&
    isTaskPortProtocol(value.protocol) &&
    isTaskExposedPortSource(value.source) &&
    isNullableString(value.statusMessage) &&
    isNonNegativeInteger(value.updatedAt) &&
    isNullableString(value.verifiedHost)
  );
}

export function isTaskObservedPort(value: unknown): value is TaskObservedPort {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNullableString(value.host) &&
    isTcpPortNumber(value.port) &&
    isTaskPortProtocol(value.protocol) &&
    isTaskObservedPortSource(value.source) &&
    typeof value.suggestion === 'string' &&
    isNonNegativeInteger(value.updatedAt)
  );
}

export function isTaskPortSnapshot(value: unknown): value is TaskPortSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.taskId === 'string' &&
    isNonNegativeInteger(value.updatedAt) &&
    isArrayOf(value.exposed, isTaskExposedPort) &&
    isArrayOf(value.observed, isTaskObservedPort)
  );
}

export function normalizeTaskPreviewHost(host: string | null | undefined): string | null {
  switch (host) {
    case null:
    case undefined:
    case '':
      return null;
    case '0.0.0.0':
    case '::':
    case '::0':
      return '127.0.0.1';
    case '[::1]':
      return '::1';
    default:
      return host;
  }
}

export function isLoopbackTaskPreviewHost(host: string | null | undefined): boolean {
  const normalizedHost = normalizeTaskPreviewHost(host);
  if (!normalizedHost) {
    return false;
  }

  return (
    normalizedHost === 'localhost' ||
    normalizedHost === '::1' ||
    LOOPBACK_HOST_PATTERN.test(normalizedHost)
  );
}

export interface RemovedTaskPortsEvent {
  kind: 'removed';
  removed: true;
  stateVersion?: number;
  taskId: string;
}

export interface TaskPortsSnapshotEvent extends TaskPortSnapshot {
  kind: 'snapshot';
  stateVersion?: number;
}

export type TaskPortsEvent = TaskPortsSnapshotEvent | RemovedTaskPortsEvent;

export interface AgentSupervisionSnapshotEvent extends AgentSupervisionSnapshot {
  kind: 'snapshot';
  stateVersion?: number;
}

export type AgentSupervisionState =
  | 'active'
  | 'awaiting-input'
  | 'idle-at-prompt'
  | 'quiet'
  | 'paused'
  | 'flow-controlled'
  | 'restoring'
  | 'exited-clean'
  | 'exited-error';

export type TaskAttentionReason =
  | 'waiting-input'
  | 'ready-for-next-step'
  | 'failed'
  | 'paused'
  | 'flow-controlled'
  | 'restoring'
  | 'quiet-too-long';

const AGENT_SUPERVISION_STATE_VALUES = {
  active: true,
  'awaiting-input': true,
  'exited-clean': true,
  'exited-error': true,
  'flow-controlled': true,
  'idle-at-prompt': true,
  paused: true,
  quiet: true,
  restoring: true,
} satisfies Record<AgentSupervisionState, true>;

const TASK_ATTENTION_REASON_VALUES = {
  failed: true,
  'flow-controlled': true,
  paused: true,
  'quiet-too-long': true,
  'ready-for-next-step': true,
  restoring: true,
  'waiting-input': true,
} satisfies Record<TaskAttentionReason, true>;

export function isAgentSupervisionState(value: unknown): value is AgentSupervisionState {
  return isStringMember(value, AGENT_SUPERVISION_STATE_VALUES);
}

export function isTaskAttentionReason(value: unknown): value is TaskAttentionReason {
  return isStringMember(value, TASK_ATTENTION_REASON_VALUES);
}

export function isAgentSupervisionSnapshot(value: unknown): value is AgentSupervisionSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.agentId === 'string' &&
    (value.attentionReason === null || isTaskAttentionReason(value.attentionReason)) &&
    typeof value.isShell === 'boolean' &&
    isNullableNonNegativeInteger(value.lastOutputAt) &&
    typeof value.preview === 'string' &&
    isAgentSupervisionState(value.state) &&
    typeof value.taskId === 'string' &&
    isNonNegativeInteger(value.updatedAt)
  );
}

export interface AgentSupervisionSnapshot {
  agentId: string;
  attentionReason: TaskAttentionReason | null;
  isShell: boolean;
  lastOutputAt: number | null;
  preview: string;
  state: AgentSupervisionState;
  taskId: string;
  updatedAt: number;
}

export interface RemovedAgentSupervisionEvent {
  kind: 'removed';
  agentId: string;
  removed: true;
  stateVersion?: number;
  taskId: string | null;
}

export type AgentSupervisionEvent = AgentSupervisionSnapshotEvent | RemovedAgentSupervisionEvent;

export const PAUSE_REASONS = ['manual', 'flow-control', 'restore'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];
export type RemoteAgentStatus = 'running' | 'paused' | 'flow-controlled' | 'restoring' | 'exited';

const RUNNING_REMOTE_AGENT_STATUS: Record<RemoteAgentStatus, boolean> = {
  running: true,
  paused: false,
  'flow-controlled': false,
  restoring: false,
  exited: false,
};

export interface AgentStatusSnapshot {
  exitCode: number | null;
  lastLine: string;
  status: RemoteAgentStatus;
}

export interface RemoteAgentTaskMeta {
  agentDefId: string | null;
  agentDefName: string | null;
  branchName: string | null;
  directMode: boolean;
  folderName: string | null;
  gitIsolation?: 'worktree' | 'current-branch' | 'existing-worktree';
  lastPrompt: string | null;
  projectMode?: 'git' | 'non-git';
  worktreeOwnership?: 'external' | 'managed';
}

export interface RemoteAgent {
  agentId: string;
  taskId: string;
  taskName: string;
  status: RemoteAgentStatus;
  exitCode: number | null;
  lastLine: string;
  taskMeta?: RemoteAgentTaskMeta;
}

const WORKTREE_OWNERSHIP_VALUES = {
  external: true,
  managed: true,
} satisfies Record<NonNullable<RemoteAgentTaskMeta['worktreeOwnership']>, true>;

const REMOTE_TASK_GIT_ISOLATION_VALUES = {
  'current-branch': true,
  'existing-worktree': true,
  worktree: true,
} satisfies Record<NonNullable<RemoteAgentTaskMeta['gitIsolation']>, true>;

const REMOTE_TASK_PROJECT_MODE_VALUES = {
  git: true,
  'non-git': true,
} satisfies Record<NonNullable<RemoteAgentTaskMeta['projectMode']>, true>;

export function isRemoteAgentStatus(value: unknown): value is RemoteAgentStatus {
  return isStringKeyOf(value, RUNNING_REMOTE_AGENT_STATUS);
}

function isRemoteAgentTaskMeta(value: unknown): value is RemoteAgentTaskMeta {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNullableString(value.agentDefId) &&
    isNullableString(value.agentDefName) &&
    isNullableString(value.branchName) &&
    typeof value.directMode === 'boolean' &&
    isNullableString(value.folderName) &&
    (value.gitIsolation === undefined ||
      isStringMember(value.gitIsolation, REMOTE_TASK_GIT_ISOLATION_VALUES)) &&
    isNullableString(value.lastPrompt) &&
    (value.projectMode === undefined ||
      isStringMember(value.projectMode, REMOTE_TASK_PROJECT_MODE_VALUES)) &&
    (value.worktreeOwnership === undefined ||
      isStringMember(value.worktreeOwnership, WORKTREE_OWNERSHIP_VALUES))
  );
}

export function isRemoteAgent(value: unknown): value is RemoteAgent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.agentId === 'string' &&
    typeof value.taskId === 'string' &&
    typeof value.taskName === 'string' &&
    isRemoteAgentStatus(value.status) &&
    isNullableNonNegativeInteger(value.exitCode) &&
    typeof value.lastLine === 'string' &&
    (value.taskMeta === undefined || isRemoteAgentTaskMeta(value.taskMeta))
  );
}

export interface AgentLifecycleEvent {
  event: 'spawn' | 'exit' | 'pause' | 'resume';
  agentId: string;
  generation?: number;
  taskId: string | null;
  isShell: boolean | null;
  status?: RemoteAgentStatus;
  exitCode?: number | null;
  signal?: string | null;
}

export interface RemotePresence {
  connectedClients: number;
  peerClients: number;
}

export type PeerPresenceVisibility = 'visible' | 'hidden';

const PEER_PRESENCE_VISIBILITY_VALUES = {
  hidden: true,
  visible: true,
} satisfies Record<PeerPresenceVisibility, true>;

export interface PeerPresenceSnapshot {
  activeTaskId: string | null;
  clientId: string;
  controllingAgentIds: string[];
  controllingTaskIds: string[];
  displayName: string;
  focusedSurface: string | null;
  lastSeenAt: number;
  visibility: PeerPresenceVisibility;
}

function isPeerPresenceVisibility(value: unknown): value is PeerPresenceVisibility {
  return isStringMember(value, PEER_PRESENCE_VISIBILITY_VALUES);
}

export function isPeerPresenceSnapshot(value: unknown): value is PeerPresenceSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNullableString(value.activeTaskId) &&
    typeof value.clientId === 'string' &&
    isStringArray(value.controllingAgentIds) &&
    isStringArray(value.controllingTaskIds) &&
    typeof value.displayName === 'string' &&
    isNullableString(value.focusedSurface) &&
    isNonNegativeInteger(value.lastSeenAt) &&
    isPeerPresenceVisibility(value.visibility)
  );
}

export function filterPeerPresenceSnapshots(
  snapshots: ReadonlyArray<unknown>,
): PeerPresenceSnapshot[] {
  return snapshots.filter(isPeerPresenceSnapshot);
}

export interface TaskCommandControllerSnapshot {
  action: string | null;
  controllerId: string | null;
  taskId: string;
  version: number;
}

export interface DisabledRemoteAccessStatus extends RemotePresence {
  enabled: false;
  connectedClients: 0;
  peerClients: 0;
  port: number;
  tailscaleUrl: null;
  token: null;
  url: null;
  wifiUrl: null;
}

export interface EnabledRemoteAccessStatus extends RemotePresence {
  enabled: true;
  connectedClients: number;
  peerClients: number;
  port: number;
  tailscaleUrl: string | null;
  token: string;
  url: string;
  wifiUrl: string | null;
}

export type RemoteAccessStatus = DisabledRemoteAccessStatus | EnabledRemoteAccessStatus;

export function isRemotePresence(value: unknown): value is RemotePresence {
  if (!isRecord(value)) {
    return false;
  }

  return isNonNegativeInteger(value.connectedClients) && isNonNegativeInteger(value.peerClients);
}

export function isRemoteAccessStatus(value: unknown): value is RemoteAccessStatus {
  if (!isRecord(value) || !isRemotePresence(value) || !isTcpPortNumber(value.port)) {
    return false;
  }

  if (value.enabled === false) {
    return (
      value.connectedClients === 0 &&
      value.peerClients === 0 &&
      value.tailscaleUrl === null &&
      value.token === null &&
      value.url === null &&
      value.wifiUrl === null
    );
  }

  if (value.enabled === true) {
    return (
      isNullableString(value.tailscaleUrl) &&
      typeof value.token === 'string' &&
      typeof value.url === 'string' &&
      isNullableString(value.wifiUrl)
    );
  }

  return false;
}

const REMOTE_AGENT_STATUS_BY_PAUSE_REASON: Record<
  PauseReason,
  Exclude<RemoteAgentStatus, 'running' | 'exited'>
> = {
  manual: 'paused',
  'flow-control': 'flow-controlled',
  restore: 'restoring',
};

const AUTOMATIC_PAUSE_REASON_FLAGS: Record<PauseReason, boolean> = {
  manual: false,
  'flow-control': true,
  restore: true,
};

export function createDisabledRemoteAccessStatus(port: number): DisabledRemoteAccessStatus {
  return {
    enabled: false,
    connectedClients: 0,
    peerClients: 0,
    port,
    tailscaleUrl: null,
    token: null,
    url: null,
    wifiUrl: null,
  };
}

export function isRunningRemoteAgentStatus(status: RemoteAgentStatus): boolean {
  return RUNNING_REMOTE_AGENT_STATUS[status];
}

export function isExitedRemoteAgentStatus(status: RemoteAgentStatus): status is 'exited' {
  return status === 'exited';
}

export function isRemovedAgentSupervisionEvent(
  event: unknown,
): event is RemovedAgentSupervisionEvent {
  return (
    isRecord(event) &&
    event.kind === 'removed' &&
    event.removed === true &&
    typeof event.agentId === 'string' &&
    isNullableString(event.taskId) &&
    isOptionalNonNegativeInteger(event.stateVersion)
  );
}

export function isAgentSupervisionSnapshotEvent(
  event: AgentSupervisionEvent,
): event is AgentSupervisionSnapshotEvent {
  return event.kind === 'snapshot';
}

export function createAgentSupervisionSnapshotEvent(
  snapshot: AgentSupervisionSnapshot,
): AgentSupervisionSnapshotEvent {
  return {
    ...snapshot,
    kind: 'snapshot',
  };
}

export function createRemovedAgentSupervisionEvent(
  agentId: string,
  taskId: string | null,
): RemovedAgentSupervisionEvent {
  return {
    kind: 'removed',
    removed: true,
    agentId,
    taskId,
  };
}

export function isAgentSupervisionEvent(value: unknown): value is AgentSupervisionEvent {
  if (!isRecord(value)) {
    return false;
  }

  if (isRemovedAgentSupervisionEvent(value)) {
    return true;
  }

  return (
    value.kind === 'snapshot' &&
    isAgentSupervisionSnapshot(value) &&
    isOptionalNonNegativeInteger(value.stateVersion)
  );
}

export function isRemovedTaskPortsEvent(event: unknown): event is RemovedTaskPortsEvent {
  return isRemovedTaskScopedKindEvent(event);
}

export function isTaskPortsSnapshotEvent(event: TaskPortsEvent): event is TaskPortsSnapshotEvent {
  return event.kind === 'snapshot';
}

export function isTaskPortsEvent(value: unknown): value is TaskPortsEvent {
  if (!isRecord(value)) {
    return false;
  }

  if (isRemovedTaskPortsEvent(value)) {
    return true;
  }

  return (
    value.kind === 'snapshot' &&
    isTaskPortSnapshot(value) &&
    isOptionalNonNegativeInteger(value.stateVersion)
  );
}

export function createTaskPortsSnapshotEvent(snapshot: TaskPortSnapshot): TaskPortsSnapshotEvent {
  return {
    ...snapshot,
    kind: 'snapshot',
  };
}

export function createRemovedTaskPortsEvent(taskId: string): RemovedTaskPortsEvent {
  return {
    kind: 'removed',
    removed: true,
    taskId,
  };
}

export function getRemoteAgentStatus(
  pauseReason: PauseReason | null | undefined,
  fallbackStatus: RemoteAgentStatus = 'running',
): RemoteAgentStatus {
  if (pauseReason === null || pauseReason === undefined) {
    return fallbackStatus;
  }

  return REMOTE_AGENT_STATUS_BY_PAUSE_REASON[pauseReason];
}

export function resolveRemoteLifecycleStatus(
  status: RemoteAgentStatus | undefined,
  fallback: 'running' | 'paused',
): Exclude<RemoteAgentStatus, 'exited'> {
  if (!status || status === 'exited') {
    return fallback;
  }

  return status;
}

export function isAutomaticPauseReason(reason: PauseReason | undefined): boolean {
  if (reason === undefined) {
    return false;
  }

  return AUTOMATIC_PAUSE_REASON_FLAGS[reason];
}

export function isPauseReason(value: unknown): value is PauseReason {
  return isStringTupleMember(value, PAUSE_REASONS);
}
