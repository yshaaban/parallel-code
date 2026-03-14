export interface WorktreeStatus {
  has_committed_changes: boolean;
  has_uncommitted_changes: boolean;
}

export interface GitStatusSyncEvent {
  branchName?: string;
  projectRoot?: string;
  status?: WorktreeStatus;
  worktreePath?: string;
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
  removed: true;
  taskId: string;
}

export type TaskPortsEvent = TaskPortSnapshot | RemovedTaskPortsEvent;

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
  agentId: string;
  removed: true;
  taskId: string | null;
}

export type AgentSupervisionEvent = AgentSupervisionSnapshot | RemovedAgentSupervisionEvent;

export type PauseReason = 'manual' | 'flow-control' | 'restore';

export type RemoteAgentStatus = 'running' | 'paused' | 'flow-controlled' | 'restoring' | 'exited';

export interface AgentStatusSnapshot {
  exitCode: number | null;
  lastLine: string;
  status: RemoteAgentStatus;
}

export interface RemoteAgent {
  agentId: string;
  taskId: string;
  taskName: string;
  status: RemoteAgentStatus;
  exitCode: number | null;
  lastLine: string;
}

export interface AgentLifecycleEvent {
  event: 'spawn' | 'exit' | 'pause' | 'resume';
  agentId: string;
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

export function isRemovedAgentSupervisionEvent(
  event: AgentSupervisionEvent,
): event is RemovedAgentSupervisionEvent {
  return 'removed' in event;
}

export function isRemovedTaskPortsEvent(event: TaskPortsEvent): event is RemovedTaskPortsEvent {
  return 'removed' in event;
}

export function getRemoteAgentStatus(
  pauseReason: PauseReason | null | undefined,
  fallbackStatus: RemoteAgentStatus = 'running',
): RemoteAgentStatus {
  switch (pauseReason) {
    case 'manual':
      return 'paused';
    case 'flow-control':
      return 'flow-controlled';
    case 'restore':
      return 'restoring';
    default:
      return fallbackStatus;
  }
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
  return reason === 'flow-control' || reason === 'restore';
}
