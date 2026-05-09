import type {
  AgentLifecycleEvent,
  GitStatusSyncEvent,
  PeerPresenceSnapshot,
  PauseReason,
  RemoteAgent,
  RemoteAgentStatus,
  RemotePresence,
  TaskPortsEvent,
} from '../../src/domain/server-state.js';
import type { PresencePayload } from '../../src/domain/presence.js';
import type {
  TerminalInputTraceClockSyncRequest,
  TerminalInputTraceClockSyncResponse,
  TerminalInputTraceClientUpdate,
  TerminalInputTraceKind,
  TerminalInputTraceMessage,
} from '../../src/domain/terminal-input-tracing.js';
import {
  isGitStatusSyncEvent,
  isPauseReason,
  isPeerPresenceSnapshot,
  isRemoteAgent,
  isRemoteAgentStatus,
  isRemotePresence,
  isTaskPortsEvent,
} from '../../src/domain/server-state.js';
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

export type {
  AgentLifecycleEvent,
  GitStatusSyncEvent,
  PeerPresenceSnapshot,
  PauseReason,
  RemoteAgent,
  RemoteAgentStatus,
  RemotePresence,
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
  command: 'input' | 'resize';
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

export type ServerMessage =
  | OutputMessage
  | StatusMessage
  | AgentsMessage
  | ScrollbackMessage
  | PongMessage
  | ChannelMessage
  | IpcEventMessage
  | ChannelBoundMessage
  | AgentLifecycleMessage
  | AgentControllerMessage
  | RemoteStatusMessage
  | PeerPresencesMessage
  | TaskEventMessage
  | GitStatusChangedMessage
  | TaskPortsChangedMessage
  | StateBootstrapMessage
  | PermissionRequestMessage
  | AgentErrorMessage
  | AgentCommandResultMessage
  | TerminalInputTraceClockSyncMessage
  | TaskCommandTakeoverRequestMessage
  | TaskCommandTakeoverResultMessage;

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
  resize: true,
} as const satisfies Record<AgentCommandResultMessage['command'], true>;

const TASK_COMMAND_TAKEOVER_RESULT_DECISION_VALUES = {
  approved: true,
  denied: true,
  'force-required': true,
  'owner-missing': true,
} as const satisfies Record<TaskCommandTakeoverResultMessage['decision'], true>;

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
    typeof value.data === 'string'
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
    isPositiveInteger(value.cols)
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

const SERVER_MESSAGE_GUARDS = {
  agents: isAgentsMessage,
  'agent-command-result': isAgentCommandResultMessage,
  'agent-controller': isAgentControllerMessage,
  'agent-error': isAgentErrorMessage,
  'agent-lifecycle': isAgentLifecycleMessage,
  channel: isChannelMessage,
  'channel-bound': isChannelBoundMessage,
  'git-status-changed': isGitStatusChangedMessage,
  'ipc-event': isIpcEventMessage,
  output: isOutputMessage,
  'peer-presences': isPeerPresencesMessage,
  'permission-request': isPermissionRequestMessage,
  pong: isPongMessage,
  'remote-status': isRemoteStatusMessage,
  scrollback: isScrollbackMessage,
  'state-bootstrap': isStateBootstrapMessage,
  status: isStatusMessage,
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
  requestId?: string;
  trace?: TerminalInputTraceMessage;
}

export type InputCommand = InputCommandBase & TaskControlContext;

interface ResizeCommandBase {
  type: 'resize';
  agentId: string;
  cols: number;
  requestId?: string;
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
}

export interface ResumeCommand {
  type: 'resume';
  agentId: string;
  reason?: PauseReason;
  channelId?: string;
}

export interface SubscribeCommand {
  type: 'subscribe';
  agentId: string;
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

export interface TerminalInputTraceCommand extends TerminalInputTraceClientUpdate {
  type: 'terminal-input-trace';
}

export interface TerminalInputTraceClockSyncCommand extends TerminalInputTraceClockSyncRequest {
  type: 'terminal-input-trace-clock-sync';
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

function isStringWithMaxLength(val: unknown, maxLen: number): val is string {
  return typeof val === 'string' && val.length <= maxLen;
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

  return {
    bufferedAtMs: value.bufferedAtMs,
    inputChars: value.inputChars,
    inputKind: value.inputKind,
    sendStartedAtMs: value.sendStartedAtMs,
    startedAtMs: value.startedAtMs,
  };
}

type AgentScopedCommand = KillCommand | SubscribeCommand | UnsubscribeCommand;
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

function parsePauseResumeCommand(
  type: PauseResumeCommand['type'],
  message: Record<string, unknown>,
): PauseResumeCommand | null {
  if (!isStringWithMaxLength(message.agentId, 100)) {
    return null;
  }

  const channelId = message.channelId;
  const reason = message.reason;
  if (channelId !== undefined && !isStringWithMaxLength(channelId, 200)) {
    return null;
  }
  if (reason !== undefined && !isPauseReason(reason)) {
    return null;
  }

  const commandOptions = {
    ...(channelId !== undefined ? { channelId } : {}),
    ...(reason !== undefined ? { reason } : {}),
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
          if (trace === null) {
            return null;
          }
          if (taskControlContext === null || !isOptionalStringWithMaxLength(msg.requestId, 120)) {
            return null;
          }
          return {
            type: 'input',
            agentId: msg.agentId,
            data: msg.data,
            ...taskControlContext,
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
          if (taskControlContext === null) {
            return null;
          }

          return {
            type: 'resize',
            agentId: msg.agentId,
            cols: msg.cols,
            rows: msg.rows,
            ...taskControlContext,
            ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
          };
        }

      case 'kill':
      case 'subscribe':
      case 'unsubscribe':
        return parseAgentScopedCommand(messageType, msg);

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

      case 'terminal-input-trace':
        if (
          !isStringWithMaxLength(msg.agentId, 100) ||
          !isStringWithMaxLength(msg.requestId, 120) ||
          !isFiniteTimestamp(msg.outputReceivedAtMs) ||
          !isFiniteTimestamp(msg.outputRenderedAtMs)
        ) {
          return null;
        }
        return {
          type: 'terminal-input-trace',
          agentId: msg.agentId,
          outputReceivedAtMs: msg.outputReceivedAtMs,
          outputRenderedAtMs: msg.outputRenderedAtMs,
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
