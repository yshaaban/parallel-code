import { assertNever } from '../lib/assert-never.js';

export interface WorktreeStatus {
  has_committed_changes: boolean;
  has_uncommitted_changes: boolean;
}

interface GitStatusSyncScopedEvent {
  branchName?: string;
  projectRoot?: string;
}

export type GitStatusSyncEventKind = 'refresh' | 'snapshot';

export interface GitStatusSyncSnapshotEvent extends GitStatusSyncScopedEvent {
  status: WorktreeStatus;
  worktreePath: string;
}

export interface GitStatusSyncWorktreeRefreshEvent extends GitStatusSyncScopedEvent {
  status?: undefined;
  worktreePath: string;
}

export interface GitStatusSyncBranchRefreshEvent {
  branchName: string;
  projectRoot: string;
  status?: undefined;
  worktreePath?: undefined;
}

export interface GitStatusSyncProjectRefreshEvent {
  projectRoot: string;
  branchName?: undefined;
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

export function isGitStatusSyncSnapshotEvent(
  event: GitStatusSyncEvent,
): event is GitStatusSyncSnapshotEvent {
  return (
    typeof event.worktreePath === 'string' &&
    typeof event.status === 'object' &&
    event.status !== null
  );
}

export function isGitStatusSyncRefreshEvent(
  event: GitStatusSyncEvent,
): event is GitStatusSyncRefreshEvent {
  return !isGitStatusSyncSnapshotEvent(event);
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

const LOOPBACK_HOST_PATTERN = /^127(?:\.\d{1,3}){3}$/u;

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
  taskId: string;
}

export interface TaskPortsSnapshotEvent extends TaskPortSnapshot {
  kind: 'snapshot';
}

export type TaskPortsEvent = TaskPortsSnapshotEvent | RemovedTaskPortsEvent;

export interface AgentSupervisionSnapshotEvent extends AgentSupervisionSnapshot {
  kind: 'snapshot';
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
  taskId: string | null;
}

export type AgentSupervisionEvent = AgentSupervisionSnapshotEvent | RemovedAgentSupervisionEvent;

export const PAUSE_REASONS = ['manual', 'flow-control', 'restore'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];
const PAUSE_REASON_SET: ReadonlySet<string> = new Set(PAUSE_REASONS);

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
  lastPrompt: string | null;
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
  event: AgentSupervisionEvent,
): event is RemovedAgentSupervisionEvent {
  return event.kind === 'removed';
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

export function isRemovedTaskPortsEvent(event: TaskPortsEvent): event is RemovedTaskPortsEvent {
  return event.kind === 'removed';
}

export function isTaskPortsSnapshotEvent(event: TaskPortsEvent): event is TaskPortsSnapshotEvent {
  return event.kind === 'snapshot';
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
  return typeof value === 'string' && PAUSE_REASON_SET.has(value);
}
