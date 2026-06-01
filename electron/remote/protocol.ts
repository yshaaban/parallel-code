import type {
  AgentLifecycleEvent,
  GitStatusSyncEvent,
  PeerPresenceSnapshot,
  PauseReason,
  RemoteAgent,
  RemoteAgentStatus,
  RemotePresence,
  TaskCommandControllerSnapshot,
  TaskPortsEvent,
} from '../../src/domain/server-state.js';
import type { CoordinatorEventEnvelope } from '../../src/domain/coordinator.js';
import type { PresencePayload } from '../../src/domain/presence.js';
import type {
  TerminalInputTraceClockSyncRequest,
  TerminalInputTraceClockSyncResponse,
  TerminalInputTraceClientUpdate,
  TerminalInputTraceKind,
  TerminalInputTraceMessage,
} from '../../src/domain/terminal-input-tracing.js';
import type {
  PtyExitData,
  TerminalRecoveryBatchEntry,
  TerminalRecoveryPayload,
  TerminalStartupRecoveryRole,
} from '../../src/ipc/types.js';
import {
  isGitStatusSyncEvent,
  isPauseReason,
  isPeerPresenceSnapshot,
  isRemoteAgent,
  isRemoteAgentStatus,
  isRemotePresence,
  isTaskPortsEvent,
} from '../../src/domain/server-state.js';
import { isCoordinatorEventEnvelope } from '../../src/domain/coordinator.js';
import {
  isArrayOf,
  isFiniteNumber,
  isInteger,
  isNullableNonNegativeInteger,
  isNullableString,
  isNonNegativeInteger,
  isOptionalFiniteNumber,
  isPositiveInteger,
  isRecord,
  isStringKeyOf,
  isStringMember,
} from '../../src/lib/type-guards.js';
import { assertNever } from '../../src/lib/assert-never.js';
import { isValidBase64 } from '../../src/lib/base64.js';

export type {
  AgentLifecycleEvent,
  GitStatusSyncEvent,
  PeerPresenceSnapshot,
  PauseReason,
  RemoteAgent,
  RemoteAgentStatus,
  RemotePresence,
  TaskCommandControllerSnapshot,
  TaskPortsEvent,
} from '../../src/domain/server-state.js';
export {
  getRemoteAgentStatus,
  isAutomaticPauseReason,
  isPauseReason,
  resolveRemoteLifecycleStatus,
} from '../../src/domain/server-state.js';

// --- Server -> Client messages ---

export interface OutputMessage {
  type: 'output';
  agentId: string;
  data: string; // base64
}

export interface StatusMessage {
  type: 'status';
  agentId: string;
  status: RemoteAgentStatus;
  exitCode: number | null;
  seq?: number;
}

export interface AgentsMessage {
  type: 'agents';
  list: RemoteAgent[];
}

export interface ScrollbackMessage {
  type: 'scrollback';
  agentId: string;
  data: string; // base64
  cols: number;
}

export type RemoteTerminalStreamEvent =
  | {
      type: 'Data';
      data: string; // base64
    }
  | {
      type: 'Exit';
      data: PtyExitData;
    }
  | {
      type: 'RecoveryRequired';
      reason: 'attach' | 'backpressure';
    };

export interface TerminalStreamMessage {
  type: 'terminal-stream';
  agentId: string;
  event: RemoteTerminalStreamEvent;
}

export interface TerminalRecoveryResultMessage {
  type: 'terminal-recovery-result';
  entry: TerminalRecoveryBatchEntry;
}

export interface PongMessage {
  type: 'pong';
}

export interface ChannelMessage {
  type: 'channel';
  channelId: string;
  payload: unknown;
}

export interface IpcEventMessage {
  type: 'ipc-event';
  channel: string;
  payload: unknown;
  seq?: number;
}

export interface CoordinatorEventMessage {
  type: 'coordinator-event';
  event: CoordinatorEventEnvelope;
}

export interface ChannelBoundMessage {
  type: 'channel-bound';
  channelId: string;
}

export interface AgentLifecycleMessage extends AgentLifecycleEvent {
  type: 'agent-lifecycle';
  seq?: number;
}

export interface AgentControllerMessage {
  type: 'agent-controller';
  agentId: string;
  controllerId: string | null;
  seq?: number;
}

export interface RemoteStatusMessage extends RemotePresence {
  type: 'remote-status';
  seq?: number;
}

export interface PeerPresencesMessage {
  type: 'peer-presences';
  list: PeerPresenceSnapshot[];
  seq?: number;
}

export interface TaskEventMessage {
  type: 'task-event';
  event: 'created' | 'deleted';
  taskId: string;
  name?: string;
  branchName?: string;
  worktreePath?: string;
  seq?: number;
}

export type GitStatusChangedMessage = GitStatusSyncEvent & {
  type: 'git-status-changed';
  seq?: number;
};

export type TaskPortsChangedMessage = TaskPortsEvent & {
  type: 'task-ports-changed';
  seq?: number;
};

export interface StateBootstrapMessage {
  type: 'state-bootstrap';
  snapshots: unknown[];
}

export interface PermissionRequestMessage {
  type: 'permission-request';
  agentId: string;
  requestId: string;
  tool: string;
  description: string;
  arguments: string;
}

export interface AgentErrorMessage {
  type: 'agent-error';
  agentId: string;
  message: string;
}

export interface AgentCommandResultMessage {
  type: 'agent-command-result';
  accepted: boolean;
  agentId: string;
  command: 'input' | 'pause' | 'resize' | 'resume';
  message?: string;
  requestId: string;
}

export interface TerminalInputTraceClockSyncMessage extends TerminalInputTraceClockSyncResponse {
  type: 'terminal-input-trace-clock-sync';
}

export interface TaskCommandTakeoverRequestMessage {
  type: 'task-command-takeover-request';
  action: string;
  expiresAt: number;
  requestId: string;
  requesterClientId: string;
  requesterDisplayName: string;
  taskId: string;
}

export interface TaskCommandTakeoverResultMessage {
  type: 'task-command-takeover-result';
  decision: 'approved' | 'denied' | 'force-required' | 'owner-missing';
  requestId: string;
  taskId: string;
}

export type TaskCommandLeaseOperation = 'acquire' | 'renew' | 'release';

export type TaskCommandLeaseAcquireResult = TaskCommandControllerSnapshot & {
  acquired: boolean;
  leaseGeneration: number;
};

export type TaskCommandLeaseRenewResult = TaskCommandControllerSnapshot & {
  leaseGeneration: number;
  renewed: boolean;
};

export type TaskCommandLeaseReleaseResult = TaskCommandControllerSnapshot;

export type TaskCommandLeaseResultMessage =
  | {
      type: 'task-command-lease-result';
      operation: 'acquire';
      requestId: string;
      result: TaskCommandLeaseAcquireResult;
    }
  | {
      type: 'task-command-lease-result';
      operation: 'renew';
      requestId: string;
      result: TaskCommandLeaseRenewResult;
    }
  | {
      type: 'task-command-lease-result';
      operation: 'release';
      requestId: string;
      result: TaskCommandLeaseReleaseResult;
    }
  | {
      type: 'task-command-lease-result';
      error: string;
      operation: TaskCommandLeaseOperation;
      requestId: string;
    };

export interface ReplayTruncatedMessage {
  type: 'replay-truncated';
  lastSeq: number;
  latestSeq: number;
  oldestAvailableSeq: number;
}

export type ServerMessage =
  | OutputMessage
  | StatusMessage
  | AgentsMessage
  | ScrollbackMessage
  | TerminalStreamMessage
  | TerminalRecoveryResultMessage
  | PongMessage
  | ChannelMessage
  | IpcEventMessage
  | CoordinatorEventMessage
  | ChannelBoundMessage
  | AgentLifecycleMessage
  | AgentControllerMessage
  | RemoteStatusMessage
  | PeerPresencesMessage
  | TaskEventMessage
  | GitStatusChangedMessage
  | TaskPortsChangedMessage
  | StateBootstrapMessage
  | ReplayTruncatedMessage
  | PermissionRequestMessage
  | AgentErrorMessage
  | AgentCommandResultMessage
  | TerminalInputTraceClockSyncMessage
  | TaskCommandTakeoverRequestMessage
  | TaskCommandTakeoverResultMessage
  | TaskCommandLeaseResultMessage;

const AGENT_LIFECYCLE_EVENT_VALUES = {
  exit: true,
  pause: true,
  resume: true,
  spawn: true,
} as const satisfies Record<AgentLifecycleEvent['event'], true>;

const TASK_EVENT_VALUES = {
  created: true,
  deleted: true,
} as const satisfies Record<TaskEventMessage['event'], true>;

const AGENT_COMMAND_RESULT_COMMAND_VALUES = {
  input: true,
  pause: true,
  resize: true,
  resume: true,
} as const satisfies Record<AgentCommandResultMessage['command'], true>;

const TASK_COMMAND_TAKEOVER_RESULT_DECISION_VALUES = {
  approved: true,
  denied: true,
  'force-required': true,
  'owner-missing': true,
} as const satisfies Record<TaskCommandTakeoverResultMessage['decision'], true>;

const TASK_COMMAND_LEASE_OPERATION_VALUES = {
  acquire: true,
  release: true,
  renew: true,
} as const satisfies Record<TaskCommandLeaseOperation, true>;

const TERMINAL_STREAM_RECOVERY_REASON_VALUES = {
  attach: true,
  backpressure: true,
} as const satisfies Record<
  Extract<RemoteTerminalStreamEvent, { type: 'RecoveryRequired' }>['reason'],
  true
>;

const TERMINAL_RECOVERY_SOURCE_VALUES = {
  cursor: true,
  tail: true,
} as const satisfies Record<Extract<TerminalRecoveryPayload, { kind: 'delta' }>['source'], true>;

const TERMINAL_STARTUP_RECOVERY_ROLE_VALUES = {
  selected: true,
  'visible-sibling': true,
} as const satisfies Record<TerminalStartupRecoveryRole, true>;

type ServerMessageGuard<TType extends ServerMessage['type']> = (
  value: unknown,
) => value is Extract<ServerMessage, { type: TType }>;

function hasServerMessageType<TType extends ServerMessage['type']>(
  value: unknown,
  type: TType,
): value is Record<string, unknown> & { type: TType } {
  return isRecord(value) && value.type === type;
}

function hasOptionalSeq(message: Record<string, unknown>): boolean {
  return message.seq === undefined || isNonNegativeInteger(message.seq);
}

function isOutputMessage(value: unknown): value is OutputMessage {
  return (
    hasServerMessageType(value, 'output') &&
    typeof value.agentId === 'string' &&
    typeof value.data === 'string' &&
    isValidBase64(value.data)
  );
}

function isStatusMessage(value: unknown): value is StatusMessage {
  return (
    hasServerMessageType(value, 'status') &&
    typeof value.agentId === 'string' &&
    isRemoteAgentStatus(value.status) &&
    isNullableNonNegativeInteger(value.exitCode) &&
    hasOptionalSeq(value)
  );
}

function isAgentsMessage(value: unknown): value is AgentsMessage {
  return hasServerMessageType(value, 'agents') && isArrayOf(value.list, isRemoteAgent);
}

function isScrollbackMessage(value: unknown): value is ScrollbackMessage {
  return (
    hasServerMessageType(value, 'scrollback') &&
    typeof value.agentId === 'string' &&
    typeof value.data === 'string' &&
    isValidBase64(value.data) &&
    isPositiveInteger(value.cols)
  );
}

function isPtyExitData(value: unknown): value is PtyExitData {
  return (
    isRecord(value) &&
    isNullableNonNegativeInteger(value.exit_code) &&
    isNullableString(value.signal) &&
    isArrayOf(value.last_output, (entry): entry is string => typeof entry === 'string')
  );
}

function isRemoteTerminalStreamEvent(value: unknown): value is RemoteTerminalStreamEvent {
  if (!isRecord(value)) {
    return false;
  }

  switch (value.type) {
    case 'Data':
      return typeof value.data === 'string' && isValidBase64(value.data);
    case 'Exit':
      return isPtyExitData(value.data);
    case 'RecoveryRequired':
      return isStringMember(value.reason, TERMINAL_STREAM_RECOVERY_REASON_VALUES);
    default:
      return false;
  }
}

function isTerminalStreamMessage(value: unknown): value is TerminalStreamMessage {
  return (
    hasServerMessageType(value, 'terminal-stream') &&
    typeof value.agentId === 'string' &&
    isRemoteTerminalStreamEvent(value.event)
  );
}

function isTerminalRecoveryPayload(value: unknown): value is TerminalRecoveryPayload {
  if (!isRecord(value)) {
    return false;
  }

  switch (value.kind) {
    case 'delta':
      return (
        typeof value.data === 'string' &&
        isValidBase64(value.data) &&
        isNonNegativeInteger(value.overlapBytes) &&
        isStringMember(value.source, TERMINAL_RECOVERY_SOURCE_VALUES)
      );
    case 'noop':
      return true;
    case 'snapshot':
      return value.data === null || (typeof value.data === 'string' && isValidBase64(value.data));
    case 'terminal-state':
      return typeof value.data === 'string' && isValidBase64(value.data);
    default:
      return false;
  }
}

function isTerminalRecoveryBatchEntry(value: unknown): value is TerminalRecoveryBatchEntry {
  return (
    isRecord(value) &&
    typeof value.agentId === 'string' &&
    isPositiveInteger(value.cols) &&
    isNonNegativeInteger(value.outputCursor) &&
    typeof value.requestId === 'string' &&
    isPositiveInteger(value.rows) &&
    isTerminalRecoveryPayload(value.recovery)
  );
}

function isTerminalRecoveryResultMessage(value: unknown): value is TerminalRecoveryResultMessage {
  return (
    hasServerMessageType(value, 'terminal-recovery-result') &&
    isTerminalRecoveryBatchEntry(value.entry)
  );
}

function isPongMessage(value: unknown): value is PongMessage {
  return hasServerMessageType(value, 'pong');
}

function isChannelMessage(value: unknown): value is ChannelMessage {
  return hasServerMessageType(value, 'channel') && typeof value.channelId === 'string';
}

function isIpcEventMessage(value: unknown): value is IpcEventMessage {
  return (
    hasServerMessageType(value, 'ipc-event') &&
    typeof value.channel === 'string' &&
    hasOptionalSeq(value)
  );
}

function isCoordinatorEventMessage(value: unknown): value is CoordinatorEventMessage {
  return (
    hasServerMessageType(value, 'coordinator-event') && isCoordinatorEventEnvelope(value.event)
  );
}

function isChannelBoundMessage(value: unknown): value is ChannelBoundMessage {
  return hasServerMessageType(value, 'channel-bound') && typeof value.channelId === 'string';
}

function isAgentLifecycleMessage(value: unknown): value is AgentLifecycleMessage {
  return (
    hasServerMessageType(value, 'agent-lifecycle') &&
    isStringMember(value.event, AGENT_LIFECYCLE_EVENT_VALUES) &&
    typeof value.agentId === 'string' &&
    isNullableString(value.taskId) &&
    (value.isShell === null || typeof value.isShell === 'boolean') &&
    isOptionalFiniteNumber(value.generation) &&
    (value.status === undefined || isRemoteAgentStatus(value.status)) &&
    (value.exitCode === undefined || isNullableNonNegativeInteger(value.exitCode)) &&
    (value.signal === undefined || isNullableString(value.signal)) &&
    hasOptionalSeq(value)
  );
}

function isAgentControllerMessage(value: unknown): value is AgentControllerMessage {
  return (
    hasServerMessageType(value, 'agent-controller') &&
    typeof value.agentId === 'string' &&
    isNullableString(value.controllerId) &&
    hasOptionalSeq(value)
  );
}

function isRemoteStatusMessage(value: unknown): value is RemoteStatusMessage {
  return (
    hasServerMessageType(value, 'remote-status') && isRemotePresence(value) && hasOptionalSeq(value)
  );
}

function isPeerPresencesMessage(value: unknown): value is PeerPresencesMessage {
  return (
    hasServerMessageType(value, 'peer-presences') &&
    isArrayOf(value.list, isPeerPresenceSnapshot) &&
    hasOptionalSeq(value)
  );
}

function isTaskEventMessage(value: unknown): value is TaskEventMessage {
  return (
    hasServerMessageType(value, 'task-event') &&
    isStringMember(value.event, TASK_EVENT_VALUES) &&
    typeof value.taskId === 'string' &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.branchName === undefined || typeof value.branchName === 'string') &&
    (value.worktreePath === undefined || typeof value.worktreePath === 'string') &&
    hasOptionalSeq(value)
  );
}

function isGitStatusChangedMessage(value: unknown): value is GitStatusChangedMessage {
  return (
    hasServerMessageType(value, 'git-status-changed') &&
    isGitStatusSyncEvent(value) &&
    hasOptionalSeq(value)
  );
}

function isTaskPortsChangedMessage(value: unknown): value is TaskPortsChangedMessage {
  return (
    hasServerMessageType(value, 'task-ports-changed') &&
    isTaskPortsEvent(value) &&
    hasOptionalSeq(value)
  );
}

function isStateBootstrapMessage(value: unknown): value is StateBootstrapMessage {
  return hasServerMessageType(value, 'state-bootstrap') && Array.isArray(value.snapshots);
}

function isPermissionRequestMessage(value: unknown): value is PermissionRequestMessage {
  return (
    hasServerMessageType(value, 'permission-request') &&
    typeof value.agentId === 'string' &&
    typeof value.requestId === 'string' &&
    typeof value.tool === 'string' &&
    typeof value.description === 'string' &&
    typeof value.arguments === 'string'
  );
}

function isAgentErrorMessage(value: unknown): value is AgentErrorMessage {
  return (
    hasServerMessageType(value, 'agent-error') &&
    typeof value.agentId === 'string' &&
    typeof value.message === 'string'
  );
}

function isAgentCommandResultMessage(value: unknown): value is AgentCommandResultMessage {
  return (
    hasServerMessageType(value, 'agent-command-result') &&
    typeof value.accepted === 'boolean' &&
    typeof value.agentId === 'string' &&
    isStringMember(value.command, AGENT_COMMAND_RESULT_COMMAND_VALUES) &&
    (value.message === undefined || typeof value.message === 'string') &&
    typeof value.requestId === 'string'
  );
}

function isTerminalInputTraceClockSyncMessage(
  value: unknown,
): value is TerminalInputTraceClockSyncMessage {
  return (
    hasServerMessageType(value, 'terminal-input-trace-clock-sync') &&
    isFiniteNumber(value.clientSentAtMs) &&
    typeof value.requestId === 'string' &&
    isFiniteNumber(value.serverReceivedAtMs) &&
    isFiniteNumber(value.serverSentAtMs)
  );
}

function isTaskCommandTakeoverRequestMessage(
  value: unknown,
): value is TaskCommandTakeoverRequestMessage {
  return (
    hasServerMessageType(value, 'task-command-takeover-request') &&
    typeof value.action === 'string' &&
    isNonNegativeInteger(value.expiresAt) &&
    typeof value.requestId === 'string' &&
    typeof value.requesterClientId === 'string' &&
    typeof value.requesterDisplayName === 'string' &&
    typeof value.taskId === 'string'
  );
}

function isTaskCommandTakeoverResultMessage(
  value: unknown,
): value is TaskCommandTakeoverResultMessage {
  return (
    hasServerMessageType(value, 'task-command-takeover-result') &&
    isStringMember(value.decision, TASK_COMMAND_TAKEOVER_RESULT_DECISION_VALUES) &&
    typeof value.requestId === 'string' &&
    typeof value.taskId === 'string'
  );
}

function isTaskCommandControllerSnapshot(value: unknown): value is TaskCommandControllerSnapshot {
  return (
    isRecord(value) &&
    (value.action === null || typeof value.action === 'string') &&
    (value.controllerId === null || typeof value.controllerId === 'string') &&
    typeof value.taskId === 'string' &&
    isNonNegativeInteger(value.version)
  );
}

function isTaskCommandLeaseAcquireResult(value: unknown): value is TaskCommandLeaseAcquireResult {
  return (
    isRecord(value) &&
    isTaskCommandControllerSnapshot(value) &&
    typeof value.acquired === 'boolean' &&
    isNonNegativeInteger(value.leaseGeneration)
  );
}

function isTaskCommandLeaseRenewResult(value: unknown): value is TaskCommandLeaseRenewResult {
  return (
    isRecord(value) &&
    isTaskCommandControllerSnapshot(value) &&
    typeof value.renewed === 'boolean' &&
    isNonNegativeInteger(value.leaseGeneration)
  );
}

function isTaskCommandLeaseResultMessage(value: unknown): value is TaskCommandLeaseResultMessage {
  if (
    !hasServerMessageType(value, 'task-command-lease-result') ||
    !isStringMember(value.operation, TASK_COMMAND_LEASE_OPERATION_VALUES) ||
    typeof value.requestId !== 'string'
  ) {
    return false;
  }

  if (value.error !== undefined) {
    return typeof value.error === 'string';
  }

  switch (value.operation) {
    case 'acquire':
      return isTaskCommandLeaseAcquireResult(value.result);
    case 'renew':
      return isTaskCommandLeaseRenewResult(value.result);
    case 'release':
      return isTaskCommandControllerSnapshot(value.result);
  }

  return assertNever(value.operation, 'Unhandled task-command lease result operation');
}

function isReplaySeqCursor(value: unknown): value is number {
  return isInteger(value) && value >= -1;
}

export function isReplayTruncatedMessage(value: unknown): value is ReplayTruncatedMessage {
  if (
    !isRecord(value) ||
    value.type !== 'replay-truncated' ||
    !isReplaySeqCursor(value.lastSeq) ||
    !isNonNegativeInteger(value.oldestAvailableSeq) ||
    !isReplaySeqCursor(value.latestSeq) ||
    value.oldestAvailableSeq > value.latestSeq
  ) {
    return false;
  }

  return value.lastSeq < value.oldestAvailableSeq - 1;
}

const SERVER_MESSAGE_GUARDS = {
  agents: isAgentsMessage,
  'agent-command-result': isAgentCommandResultMessage,
  'agent-controller': isAgentControllerMessage,
  'agent-error': isAgentErrorMessage,
  'agent-lifecycle': isAgentLifecycleMessage,
  channel: isChannelMessage,
  'channel-bound': isChannelBoundMessage,
  'coordinator-event': isCoordinatorEventMessage,
  'git-status-changed': isGitStatusChangedMessage,
  'ipc-event': isIpcEventMessage,
  output: isOutputMessage,
  'peer-presences': isPeerPresencesMessage,
  'permission-request': isPermissionRequestMessage,
  pong: isPongMessage,
  'replay-truncated': isReplayTruncatedMessage,
  'remote-status': isRemoteStatusMessage,
  scrollback: isScrollbackMessage,
  'state-bootstrap': isStateBootstrapMessage,
  status: isStatusMessage,
  'terminal-recovery-result': isTerminalRecoveryResultMessage,
  'terminal-stream': isTerminalStreamMessage,
  'task-command-lease-result': isTaskCommandLeaseResultMessage,
  'task-command-takeover-request': isTaskCommandTakeoverRequestMessage,
  'task-command-takeover-result': isTaskCommandTakeoverResultMessage,
  'task-event': isTaskEventMessage,
  'task-ports-changed': isTaskPortsChangedMessage,
  'terminal-input-trace-clock-sync': isTerminalInputTraceClockSyncMessage,
} as const satisfies {
  [TType in ServerMessage['type']]: ServerMessageGuard<TType>;
};

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!isRecord(value) || !isStringKeyOf(value.type, SERVER_MESSAGE_GUARDS)) {
    return false;
  }

  return SERVER_MESSAGE_GUARDS[value.type](value);
}

// --- Client -> Server messages ---

export type TaskControlContext =
  | {
      controllerId: string;
      taskId: string;
    }
  | {
      controllerId?: undefined;
      taskId?: undefined;
    };

interface InputCommandBase {
  type: 'input';
  agentId: string;
  data: string;
  inputEpoch?: string;
  inputSeq?: number;
  requestId?: string;
  trace?: TerminalInputTraceMessage;
}

export type InputCommand = InputCommandBase & TaskControlContext;

interface ResizeCommandBase {
  type: 'resize';
  agentId: string;
  cols: number;
  requestId?: string;
  resizeEpoch?: string;
  resizeSeq?: number;
  rows: number;
}

export type ResizeCommand = ResizeCommandBase & TaskControlContext;

export interface KillCommand {
  type: 'kill';
  agentId: string;
}

export interface PauseCommand {
  type: 'pause';
  agentId: string;
  reason?: PauseReason;
  channelId?: string;
  requestId?: string;
  restoreLeaseId?: string;
}

export interface ResumeCommand {
  type: 'resume';
  agentId: string;
  reason?: PauseReason;
  channelId?: string;
  requestId?: string;
  restoreLeaseId?: string;
}

export interface SubscribeCommand {
  type: 'subscribe';
  agentId: string;
  terminalProtocol?: 'legacy' | 'structured';
}

export interface UnsubscribeCommand {
  type: 'unsubscribe';
  agentId: string;
}

export interface BindChannelCommand {
  type: 'bind-channel';
  channelId: string;
}

export interface UnbindChannelCommand {
  type: 'unbind-channel';
  channelId: string;
}

export interface AuthCommand {
  type: 'auth';
  token: string;
  lastSeq?: number;
  clientId?: string;
}

export interface PingCommand {
  type: 'ping';
}

export interface PermissionResponseCommand {
  type: 'permission-response';
  agentId: string;
  requestId: string;
  action: 'approve' | 'deny';
}

export type UpdatePresenceCommand = PresencePayload;

export interface RequestTaskCommandTakeoverCommand {
  type: 'request-task-command-takeover';
  action: string;
  requestId: string;
  requesterOwnerId?: string;
  targetControllerId: string;
  taskId: string;
}

export interface RespondTaskCommandTakeoverCommand {
  type: 'respond-task-command-takeover';
  approved: boolean;
  requestId: string;
}

export type TaskCommandLeaseCommand =
  | {
      type: 'task-command-lease';
      action: string;
      operation: 'acquire';
      ownerId: string;
      requestId: string;
      takeover?: boolean;
      taskId: string;
    }
  | {
      type: 'task-command-lease';
      leaseGeneration?: number;
      operation: 'renew';
      ownerId: string;
      requestId: string;
      taskId: string;
    }
  | {
      type: 'task-command-lease';
      leaseGeneration?: number;
      operation: 'release';
      ownerId: string;
      requestId: string;
      taskId: string;
    };

export interface TerminalInputTraceCommand extends TerminalInputTraceClientUpdate {
  type: 'terminal-input-trace';
}

export interface TerminalInputTraceClockSyncCommand extends TerminalInputTraceClockSyncRequest {
  type: 'terminal-input-trace-clock-sync';
}

export interface TerminalRecoveryRequestCommand {
  type: 'terminal-recovery-request';
  agentId: string;
  outputCursor: number | null;
  renderedTail: string | null;
  requestId: string;
  snapshotByteLimit: number | null;
}

export interface TerminalStartupRecoveryRequestCommand {
  type: 'terminal-startup-recovery-request';
  agentId: string;
  requestId: string;
  role: TerminalStartupRecoveryRole;
  visibleTerminalCount: number;
}

export type ClientMessage =
  | AuthCommand
  | PingCommand
  | InputCommand
  | ResizeCommand
  | KillCommand
  | PauseCommand
  | ResumeCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | BindChannelCommand
  | UnbindChannelCommand
  | PermissionResponseCommand
  | UpdatePresenceCommand
  | RequestTaskCommandTakeoverCommand
  | RespondTaskCommandTakeoverCommand
  | TaskCommandLeaseCommand
  | TerminalRecoveryRequestCommand
  | TerminalStartupRecoveryRequestCommand
  | TerminalInputTraceCommand
  | TerminalInputTraceClockSyncCommand;

export const MAX_CLIENT_INPUT_DATA_LENGTH = 64 * 1024;

const CLIENT_MESSAGE_TYPE_VALUES = {
  auth: true,
  'bind-channel': true,
  input: true,
  kill: true,
  pause: true,
  'permission-response': true,
  ping: true,
  'request-task-command-takeover': true,
  resize: true,
  'respond-task-command-takeover': true,
  resume: true,
  subscribe: true,
  'task-command-lease': true,
  'terminal-recovery-request': true,
  'terminal-startup-recovery-request': true,
  'terminal-input-trace': true,
  'terminal-input-trace-clock-sync': true,
  'unbind-channel': true,
  unsubscribe: true,
  'update-presence': true,
} as const satisfies Record<ClientMessage['type'], true>;

const TERMINAL_INPUT_TRACE_KIND_VALUES = {
  burst: true,
  control: true,
  interactive: true,
  paste: true,
} as const satisfies Record<TerminalInputTraceKind, true>;

const PERMISSION_RESPONSE_ACTION_VALUES = {
  approve: true,
  deny: true,
} as const satisfies Record<PermissionResponseCommand['action'], true>;

const PEER_PRESENCE_VISIBILITY_VALUES = {
  hidden: true,
  visible: true,
} as const satisfies Record<PresencePayload['visibility'], true>;

const TERMINAL_SUBSCRIBE_PROTOCOL_VALUES = {
  legacy: true,
  structured: true,
} as const satisfies Record<NonNullable<SubscribeCommand['terminalProtocol']>, true>;

const MAX_ORDER_EPOCH_LENGTH = 100;

function isStringWithMaxLength(val: unknown, maxLen: number): val is string {
  return typeof val === 'string' && val.length <= maxLen;
}

function isNonEmptyStringWithMaxLength(val: unknown, maxLen: number): val is string {
  return isStringWithMaxLength(val, maxLen) && val.length > 0;
}

function parseClientMessageType(value: unknown): ClientMessage['type'] | null {
  if (!isStringWithMaxLength(value, 50) || !isStringMember(value, CLIENT_MESSAGE_TYPE_VALUES)) {
    return null;
  }

  return value;
}

function isOptionalStringWithMaxLength(
  value: unknown,
  maxLen: number,
): value is string | undefined {
  return value === undefined || isStringWithMaxLength(value, maxLen);
}

function isNullableStringWithMaxLength(value: unknown, maxLen: number): value is string | null {
  return value === null || isStringWithMaxLength(value, maxLen);
}

function isFiniteTimestamp(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isAuthLastSeq(value: unknown): value is number | undefined {
  return value === undefined || (isInteger(value) && value >= -1);
}

function hasValidTaskControlContext(message: Record<string, unknown>): boolean {
  if (
    !isOptionalStringWithMaxLength(message.controllerId, 100) ||
    !isOptionalStringWithMaxLength(message.taskId, 100)
  ) {
    return false;
  }

  return (message.controllerId === undefined) === (message.taskId === undefined);
}

function parseTaskControlCommandContext(
  message: Record<string, unknown>,
): TaskControlContext | null {
  if (!hasValidTaskControlContext(message)) {
    return null;
  }

  if (typeof message.controllerId === 'string' && typeof message.taskId === 'string') {
    return {
      controllerId: message.controllerId,
      taskId: message.taskId,
    };
  }

  return {};
}

function isTerminalSize(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 500;
}

function parseInputOrderToken(
  message: Record<string, unknown>,
): Pick<InputCommandBase, 'inputEpoch' | 'inputSeq'> | null {
  if (message.inputEpoch === undefined && message.inputSeq === undefined) {
    return {};
  }

  if (
    !isNonEmptyStringWithMaxLength(message.inputEpoch, MAX_ORDER_EPOCH_LENGTH) ||
    !isNonNegativeInteger(message.inputSeq)
  ) {
    return null;
  }

  return {
    inputEpoch: message.inputEpoch,
    inputSeq: message.inputSeq,
  };
}

function parseResizeOrderToken(
  message: Record<string, unknown>,
): Pick<ResizeCommandBase, 'resizeEpoch' | 'resizeSeq'> | null {
  if (message.resizeEpoch === undefined && message.resizeSeq === undefined) {
    return {};
  }

  if (
    !isNonEmptyStringWithMaxLength(message.resizeEpoch, MAX_ORDER_EPOCH_LENGTH) ||
    !isNonNegativeInteger(message.resizeSeq)
  ) {
    return null;
  }

  return {
    resizeEpoch: message.resizeEpoch,
    resizeSeq: message.resizeSeq,
  };
}

function parsePresenceStringArray(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || !value.every((entry) => isStringWithMaxLength(entry, 100))) {
    return null;
  }

  return value;
}

function parseTerminalInputTraceMessage(
  value: unknown,
): TerminalInputTraceMessage | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (
    !isFiniteTimestamp(value.startedAtMs) ||
    !isFiniteTimestamp(value.bufferedAtMs) ||
    !isFiniteTimestamp(value.sendStartedAtMs) ||
    !isNonNegativeInteger(value.inputChars) ||
    !isStringMember(value.inputKind, TERMINAL_INPUT_TRACE_KIND_VALUES)
  ) {
    return null;
  }

  const echoText = value.echoText;
  if (echoText !== undefined && !isStringWithMaxLength(echoText, 512)) {
    return null;
  }

  return {
    bufferedAtMs: value.bufferedAtMs,
    ...(echoText !== undefined ? { echoText } : {}),
    inputChars: value.inputChars,
    inputKind: value.inputKind,
    sendStartedAtMs: value.sendStartedAtMs,
    startedAtMs: value.startedAtMs,
  };
}

type AgentScopedCommand = KillCommand | UnsubscribeCommand;
type PauseResumeCommand = PauseCommand | ResumeCommand;

function parseAgentScopedCommand(
  type: AgentScopedCommand['type'],
  message: Record<string, unknown>,
): AgentScopedCommand | null {
  if (!isStringWithMaxLength(message.agentId, 100)) {
    return null;
  }

  return {
    type,
    agentId: message.agentId,
  };
}

function parseSubscribeCommand(message: Record<string, unknown>): SubscribeCommand | null {
  if (!isStringWithMaxLength(message.agentId, 100)) {
    return null;
  }

  if (
    message.terminalProtocol !== undefined &&
    !isStringMember(message.terminalProtocol, TERMINAL_SUBSCRIBE_PROTOCOL_VALUES)
  ) {
    return null;
  }

  return {
    type: 'subscribe',
    agentId: message.agentId,
    ...(message.terminalProtocol !== undefined
      ? { terminalProtocol: message.terminalProtocol }
      : {}),
  };
}

function parsePauseResumeCommand(
  type: PauseResumeCommand['type'],
  message: Record<string, unknown>,
): PauseResumeCommand | null {
  if (!isStringWithMaxLength(message.agentId, 100)) {
    return null;
  }

  const channelId = message.channelId;
  const reason = message.reason;
  const requestId = message.requestId;
  const restoreLeaseId = message.restoreLeaseId;
  if (channelId !== undefined && !isStringWithMaxLength(channelId, 200)) {
    return null;
  }
  if (reason !== undefined && !isPauseReason(reason)) {
    return null;
  }
  if (requestId !== undefined && !isStringWithMaxLength(requestId, 120)) {
    return null;
  }
  if (restoreLeaseId !== undefined && !isNonEmptyStringWithMaxLength(restoreLeaseId, 120)) {
    return null;
  }
  if (restoreLeaseId !== undefined && reason !== 'restore') {
    return null;
  }

  const commandOptions = {
    ...(channelId !== undefined ? { channelId } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(restoreLeaseId !== undefined ? { restoreLeaseId } : {}),
  };

  if (type === 'pause') {
    return {
      type: 'pause',
      agentId: message.agentId,
      ...commandOptions,
    };
  }

  return {
    type: 'resume',
    agentId: message.agentId,
    ...commandOptions,
  };
}

function parseTaskCommandLeaseCommand(
  message: Record<string, unknown>,
): TaskCommandLeaseCommand | null {
  if (
    !isStringMember(message.operation, TASK_COMMAND_LEASE_OPERATION_VALUES) ||
    !isStringWithMaxLength(message.ownerId, 100) ||
    !isStringWithMaxLength(message.requestId, 120) ||
    !isStringWithMaxLength(message.taskId, 100)
  ) {
    return null;
  }

  switch (message.operation) {
    case 'acquire': {
      if (
        !isStringWithMaxLength(message.action, 100) ||
        (message.takeover !== undefined && typeof message.takeover !== 'boolean')
      ) {
        return null;
      }

      const acquireCommand: Extract<TaskCommandLeaseCommand, { operation: 'acquire' }> = {
        type: 'task-command-lease',
        action: message.action,
        operation: 'acquire',
        ownerId: message.ownerId,
        requestId: message.requestId,
        taskId: message.taskId,
      };
      if (message.takeover !== undefined) {
        acquireCommand.takeover = message.takeover;
      }
      return acquireCommand;
    }
    case 'renew':
    case 'release': {
      if (message.leaseGeneration !== undefined && !isNonNegativeInteger(message.leaseGeneration)) {
        return null;
      }

      const leaseCommand: Extract<TaskCommandLeaseCommand, { operation: 'renew' | 'release' }> = {
        type: 'task-command-lease',
        operation: message.operation,
        ownerId: message.ownerId,
        requestId: message.requestId,
        taskId: message.taskId,
      };
      if (message.leaseGeneration !== undefined) {
        leaseCommand.leaseGeneration = message.leaseGeneration;
      }
      return leaseCommand;
    }
  }

  return assertNever(message.operation, 'Unhandled task-command lease operation');
}

/** Minimal validation for incoming client messages. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }

    const messageType = parseClientMessageType(parsed.type);
    if (messageType === null) {
      return null;
    }
    const msg = parsed;
    if (msg.reason !== undefined && !isPauseReason(msg.reason)) {
      return null;
    }

    // Auth message doesn't require agentId
    if (messageType === 'auth') {
      if (!isStringWithMaxLength(msg.token, 200)) return null;
      if (!isAuthLastSeq(msg.lastSeq) || !isOptionalStringWithMaxLength(msg.clientId, 100)) {
        return null;
      }
      const authMessage: AuthCommand = {
        type: 'auth',
        token: msg.token,
      };
      if (msg.lastSeq !== undefined) {
        authMessage.lastSeq = msg.lastSeq;
      }
      if (msg.clientId !== undefined) {
        authMessage.clientId = msg.clientId;
      }
      return authMessage;
    }

    if (messageType === 'ping') {
      return { type: 'ping' };
    }

    switch (messageType) {
      case 'input':
        if (
          !isStringWithMaxLength(msg.agentId, 100) ||
          !isStringWithMaxLength(msg.data, MAX_CLIENT_INPUT_DATA_LENGTH)
        ) {
          return null;
        }
        {
          const trace = parseTerminalInputTraceMessage(msg.trace);
          const taskControlContext = parseTaskControlCommandContext(msg);
          const inputOrderToken = parseInputOrderToken(msg);
          if (trace === null) {
            return null;
          }
          if (
            taskControlContext === null ||
            inputOrderToken === null ||
            !isOptionalStringWithMaxLength(msg.requestId, 120)
          ) {
            return null;
          }
          return {
            type: 'input',
            agentId: msg.agentId,
            data: msg.data,
            ...taskControlContext,
            ...inputOrderToken,
            ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
            ...(trace !== undefined ? { trace } : {}),
          };
        }

      case 'resize':
        if (!isStringWithMaxLength(msg.agentId, 100)) return null;
        if (
          !isTerminalSize(msg.cols) ||
          !isTerminalSize(msg.rows) ||
          !isOptionalStringWithMaxLength(msg.requestId, 120)
        ) {
          return null;
        }
        {
          const taskControlContext = parseTaskControlCommandContext(msg);
          const resizeOrderToken = parseResizeOrderToken(msg);
          if (taskControlContext === null || resizeOrderToken === null) {
            return null;
          }

          return {
            type: 'resize',
            agentId: msg.agentId,
            cols: msg.cols,
            rows: msg.rows,
            ...taskControlContext,
            ...resizeOrderToken,
            ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
          };
        }

      case 'kill':
      case 'unsubscribe':
        return parseAgentScopedCommand(messageType, msg);

      case 'subscribe':
        return parseSubscribeCommand(msg);

      case 'pause':
      case 'resume':
        return parsePauseResumeCommand(messageType, msg);

      case 'bind-channel':
        if (!isStringWithMaxLength(msg.channelId, 200)) return null;
        return { type: 'bind-channel', channelId: msg.channelId };

      case 'unbind-channel':
        if (!isStringWithMaxLength(msg.channelId, 200)) return null;
        return { type: 'unbind-channel', channelId: msg.channelId };

      case 'permission-response':
        if (!isStringWithMaxLength(msg.agentId, 100) || !isStringWithMaxLength(msg.requestId, 100))
          return null;
        if (!isStringMember(msg.action, PERMISSION_RESPONSE_ACTION_VALUES)) return null;
        return {
          type: 'permission-response',
          agentId: msg.agentId,
          requestId: msg.requestId,
          action: msg.action,
        };

      case 'update-presence': {
        if (!isStringWithMaxLength(msg.displayName, 80)) return null;
        if (!isNullableStringWithMaxLength(msg.activeTaskId ?? null, 100)) return null;
        if (!isNullableStringWithMaxLength(msg.focusedSurface ?? null, 100)) return null;
        if (!isStringMember(msg.visibility, PEER_PRESENCE_VISIBILITY_VALUES)) return null;
        const controllingTaskIds = parsePresenceStringArray(msg.controllingTaskIds);
        if (controllingTaskIds === null) return null;
        const controllingAgentIds = parsePresenceStringArray(msg.controllingAgentIds);
        if (controllingAgentIds === null) return null;
        const activeTaskId = typeof msg.activeTaskId === 'string' ? msg.activeTaskId : null;
        const focusedSurface = typeof msg.focusedSurface === 'string' ? msg.focusedSurface : null;
        return {
          type: 'update-presence',
          displayName: msg.displayName,
          activeTaskId,
          controllingAgentIds,
          controllingTaskIds,
          focusedSurface,
          visibility: msg.visibility,
        };
      }

      case 'request-task-command-takeover':
        if (
          !isStringWithMaxLength(msg.action, 100) ||
          !isStringWithMaxLength(msg.requestId, 100) ||
          (msg.requesterOwnerId !== undefined &&
            !isStringWithMaxLength(msg.requesterOwnerId, 100)) ||
          !isStringWithMaxLength(msg.targetControllerId, 100) ||
          !isStringWithMaxLength(msg.taskId, 100)
        ) {
          return null;
        }
        return {
          type: 'request-task-command-takeover',
          action: msg.action,
          requestId: msg.requestId,
          ...(msg.requesterOwnerId !== undefined ? { requesterOwnerId: msg.requesterOwnerId } : {}),
          targetControllerId: msg.targetControllerId,
          taskId: msg.taskId,
        };

      case 'respond-task-command-takeover':
        if (!isStringWithMaxLength(msg.requestId, 100) || typeof msg.approved !== 'boolean') {
          return null;
        }
        return {
          type: 'respond-task-command-takeover',
          approved: msg.approved,
          requestId: msg.requestId,
        };

      case 'task-command-lease':
        return parseTaskCommandLeaseCommand(msg);

      case 'terminal-recovery-request':
        if (
          !isStringWithMaxLength(msg.agentId, 100) ||
          !isStringWithMaxLength(msg.requestId, 120) ||
          (msg.outputCursor !== undefined && !isNullableNonNegativeInteger(msg.outputCursor)) ||
          (msg.renderedTail !== undefined &&
            !(
              msg.renderedTail === null ||
              (typeof msg.renderedTail === 'string' && isValidBase64(msg.renderedTail))
            )) ||
          (msg.snapshotByteLimit !== undefined &&
            !isNullableNonNegativeInteger(msg.snapshotByteLimit))
        ) {
          return null;
        }
        return {
          type: 'terminal-recovery-request',
          agentId: msg.agentId,
          outputCursor: typeof msg.outputCursor === 'number' ? msg.outputCursor : null,
          renderedTail: typeof msg.renderedTail === 'string' ? msg.renderedTail : null,
          requestId: msg.requestId,
          snapshotByteLimit:
            typeof msg.snapshotByteLimit === 'number' ? msg.snapshotByteLimit : null,
        };

      case 'terminal-startup-recovery-request':
        if (
          !isStringWithMaxLength(msg.agentId, 100) ||
          !isStringWithMaxLength(msg.requestId, 120) ||
          !isStringMember(msg.role, TERMINAL_STARTUP_RECOVERY_ROLE_VALUES) ||
          (msg.visibleTerminalCount !== undefined && !isPositiveInteger(msg.visibleTerminalCount))
        ) {
          return null;
        }
        return {
          type: 'terminal-startup-recovery-request',
          agentId: msg.agentId,
          requestId: msg.requestId,
          role: msg.role,
          visibleTerminalCount:
            typeof msg.visibleTerminalCount === 'number' ? msg.visibleTerminalCount : 1,
        };

      case 'terminal-input-trace':
        if (
          !isStringWithMaxLength(msg.agentId, 100) ||
          !isStringWithMaxLength(msg.requestId, 120) ||
          !isFiniteTimestamp(msg.outputReceivedAtMs) ||
          !isFiniteTimestamp(msg.outputRenderedAtMs) ||
          (msg.outputTransportReceivedAtMs !== undefined &&
            !isFiniteTimestamp(msg.outputTransportReceivedAtMs))
        ) {
          return null;
        }
        return {
          type: 'terminal-input-trace',
          agentId: msg.agentId,
          outputReceivedAtMs: msg.outputReceivedAtMs,
          outputRenderedAtMs: msg.outputRenderedAtMs,
          ...(msg.outputTransportReceivedAtMs !== undefined
            ? { outputTransportReceivedAtMs: msg.outputTransportReceivedAtMs }
            : {}),
          requestId: msg.requestId,
        };

      case 'terminal-input-trace-clock-sync':
        if (!isStringWithMaxLength(msg.requestId, 120) || !isFiniteTimestamp(msg.clientSentAtMs)) {
          return null;
        }
        return {
          type: 'terminal-input-trace-clock-sync',
          clientSentAtMs: msg.clientSentAtMs,
          requestId: msg.requestId,
        };

      default:
        return assertNever(messageType, 'Unhandled client message type');
    }
  } catch {
    return null;
  }
}
