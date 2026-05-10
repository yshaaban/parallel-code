import {
  recordTerminalInputTraceClientDisconnected,
  recordTerminalInputTraceClientUpdate,
  recordTerminalInputTraceCommandResultSent,
  recordTerminalInputTraceFailure,
  recordTerminalInputTraceServerReceived,
} from '../electron/ipc/runtime-diagnostics.js';
import type { ClientMessage, InputCommand, ServerMessage } from '../electron/remote/protocol.js';
import type { TerminalInputTraceMessage } from '../src/domain/terminal-input-tracing.js';

type TerminalInputTraceClockSyncCommand = Extract<
  ClientMessage,
  { type: 'terminal-input-trace-clock-sync' }
>;
type TerminalInputTraceClockSyncMessage = Extract<
  ServerMessage,
  { type: 'terminal-input-trace-clock-sync' }
>;
type TerminalInputTraceCommand = Extract<ClientMessage, { type: 'terminal-input-trace' }>;
type AgentCommandResultMessage = Extract<ServerMessage, { type: 'agent-command-result' }>;

interface BrowserTerminalInputTraceRequest {
  clientId: string | null;
  requestId: string;
  taskId: string | null;
  trace: TerminalInputTraceMessage;
}

type TerminalInputTraceInput = Pick<InputCommand, 'agentId' | 'data' | 'requestId' | 'trace'>;

function getTerminalTraceServerTimestampMs(): number {
  return performance.timeOrigin + performance.now();
}

export function getBrowserTerminalInputTracePreview(data: string): string {
  if (data.length > 80) {
    return `${data.slice(0, 80).replace(/\s+/gu, ' ')}…`;
  }

  return data.replace(/\s+/gu, ' ');
}

export function createBrowserTerminalInputTraceRequest(
  message: Pick<InputCommand, 'requestId' | 'trace'>,
  clientId: string | null,
  taskId: string | null,
): BrowserTerminalInputTraceRequest | undefined {
  if (!message.trace || !message.requestId) {
    return undefined;
  }

  return {
    clientId,
    requestId: message.requestId,
    taskId,
    trace: message.trace,
  };
}

export function recordBrowserTerminalInputServerReceived(
  message: TerminalInputTraceInput,
  clientId: string | null,
  taskId: string | null,
  record: typeof recordTerminalInputTraceServerReceived = recordTerminalInputTraceServerReceived,
): void {
  const traceRequest = createBrowserTerminalInputTraceRequest(message, clientId, taskId);
  if (!traceRequest) {
    return;
  }

  record({
    agentId: message.agentId,
    clientId,
    inputPreview: getBrowserTerminalInputTracePreview(message.data),
    requestId: traceRequest.requestId,
    taskId,
    trace: traceRequest.trace,
  });
}

export function recordBrowserTerminalInputFailure(
  agentId: string,
  requestId: string | undefined,
  reason: string,
  record: typeof recordTerminalInputTraceFailure = recordTerminalInputTraceFailure,
): void {
  if (!requestId) {
    return;
  }

  record(agentId, requestId, reason);
}

export function recordBrowserTerminalInputClientDisconnected(
  clientId: string | null,
  record: typeof recordTerminalInputTraceClientDisconnected = recordTerminalInputTraceClientDisconnected,
): void {
  record(clientId);
}

export function recordBrowserTerminalInputClientUpdate(
  message: TerminalInputTraceCommand,
  record: typeof recordTerminalInputTraceClientUpdate = recordTerminalInputTraceClientUpdate,
): void {
  record(message);
}

export function recordBrowserTerminalInputCommandResultSent(
  message: AgentCommandResultMessage,
  record: typeof recordTerminalInputTraceCommandResultSent = recordTerminalInputTraceCommandResultSent,
): void {
  if (message.command !== 'input') {
    return;
  }

  record(message.agentId, message.requestId);
}

export function createBrowserTerminalInputTraceClockSyncMessage(
  message: TerminalInputTraceClockSyncCommand,
  getNow: () => number = getTerminalTraceServerTimestampMs,
): TerminalInputTraceClockSyncMessage {
  const serverReceivedAtMs = getNow();
  return {
    type: 'terminal-input-trace-clock-sync',
    clientSentAtMs: message.clientSentAtMs,
    requestId: message.requestId,
    serverReceivedAtMs,
    serverSentAtMs: getNow(),
  };
}
