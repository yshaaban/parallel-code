import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import {
  recordTerminalInputTraceClientDisconnected,
  recordTerminalInputTraceClientUpdate,
  recordTerminalInputTraceFailure,
  recordTerminalInputTraceServerReceived,
} from '../electron/ipc/runtime-diagnostics.js';
import {
  getAgentMeta,
  getAgentCols,
  getAgentScrollback,
  killAgent,
  pauseAgent,
  resizeAgent,
  resumeAgent,
  subscribeToAgent,
  unsubscribeFromAgent,
  writeToAgent,
} from '../electron/ipc/pty.js';
import {
  isAutomaticPauseReason,
  parseClientMessage,
  type ClientMessage,
  type PauseReason,
  type ServerMessage,
} from '../electron/remote/protocol.js';
import { canResizeTaskTerminal } from '../electron/ipc/task-command-leases.js';
import {
  getClaimAgentControlErrorMessage,
  type ClaimAgentControlFailure,
  type ClaimAgentControlResult,
  type WebSocketTransport,
} from '../electron/remote/ws-transport.js';
import { dispatchByType, type DispatchByTypeHandlerMap } from '../src/lib/dispatch-by-type.js';
import type { BrowserChannelManager } from './browser-channels.js';

// Browser websocket control plane. This handles authenticated websocket
// sessions, control commands, and sequenced control-event delivery.

export interface RegisterBrowserWebSocketServerOptions {
  authenticateConnection: (client: WebSocket, clientId?: string, lastSeq?: number) => boolean;
  broadcastRemoteStatus: () => void;
  channels: BrowserChannelManager;
  isAllowedBrowserOrigin: (request: {
    headers: IncomingMessage['headers'];
    url?: string | undefined;
  }) => boolean;
  isAuthorizedRequest: (request: {
    headers: IncomingMessage['headers'];
    url?: string | undefined;
  }) => boolean;
  sendAgentError: (
    client: WebSocket,
    agentId: string,
    fallbackMessage: string,
    error: unknown,
  ) => void;
  sendMessage: (client: WebSocket, message: ServerMessage) => boolean;
  safeCompareToken: (token: string | null) => boolean;
  respondTaskCommandTakeover: (
    client: WebSocket,
    message: Extract<ClientMessage, { type: 'respond-task-command-takeover' }>,
  ) => void;
  requestTaskCommandTakeover: (
    client: WebSocket,
    message: Extract<ClientMessage, { type: 'request-task-command-takeover' }>,
  ) => void;
  transport: WebSocketTransport<WebSocket>;
  updatePeerPresence: (
    client: WebSocket,
    message: Extract<ClientMessage, { type: 'update-presence' }>,
  ) => void;
  wss: WebSocketServer;
}

export interface BrowserWebSocketServer {
  cleanupClient: (client: WebSocket) => void;
}

type AuthenticatedClientMessage = Exclude<ClientMessage, { type: 'auth' }>;
type BrowserClientMessageHandlerMap = DispatchByTypeHandlerMap<AuthenticatedClientMessage>;

interface BrowserSocketAuthContext {
  clientId?: string;
  lastSeq?: number;
}

interface CachedAgentCommandResult {
  expiresAt: number;
  result: Extract<ServerMessage, { type: 'agent-command-result' }>;
}

interface AgentCommandRequest {
  agentId: string;
  requestId: string;
  type: 'input' | 'resize';
}

interface AgentCommandExecutionOptions {
  onFailure?: (reason: string) => void;
  request?: AgentCommandRequest;
  taskId?: string;
}

const AGENT_COMMAND_RESULT_CACHE_TTL_MS = 15_000;
const MAX_CACHED_AGENT_COMMAND_RESULTS_PER_CLIENT = 256;
const TASK_CONTROLLED_BY_ANOTHER_CLIENT_MESSAGE = 'Task is controlled by another client';

function parseSocketAuthContext(request: Pick<IncomingMessage, 'url'>): BrowserSocketAuthContext {
  if (!request.url) {
    return {};
  }

  const url = new URL(request.url, 'http://localhost');
  const clientId = url.searchParams.get('clientId');
  const lastSeqParam = url.searchParams.get('lastSeq');
  const lastSeq =
    lastSeqParam !== null && /^-?\d+$/.test(lastSeqParam) ? Number(lastSeqParam) : undefined;

  return {
    ...(clientId ? { clientId } : {}),
    ...(lastSeq !== undefined ? { lastSeq } : {}),
  };
}

function getTerminalTraceServerTimestampMs(): number {
  return performance.timeOrigin + performance.now();
}

function shouldRequireAgentControl(reason?: PauseReason): boolean {
  return !isAutomaticPauseReason(reason);
}

function hasTaskControlForMessage(
  message: {
    agentId: string;
    controllerId?: string;
    taskId?: string;
  },
  clientId: string | null,
  check: (taskId: string, controllerId: string) => boolean,
): boolean {
  if (!clientId) {
    return false;
  }

  if (message.controllerId !== undefined && message.controllerId !== clientId) {
    return false;
  }

  const taskId =
    typeof message.taskId === 'string' ? message.taskId : getAgentMeta(message.agentId)?.taskId;
  if (typeof taskId !== 'string') {
    return true;
  }

  return check(taskId, clientId);
}

function createTaskControlError(): Error {
  return new Error(TASK_CONTROLLED_BY_ANOTHER_CLIENT_MESSAGE);
}

export function registerBrowserWebSocketServer(
  options: RegisterBrowserWebSocketServerOptions,
): BrowserWebSocketServer {
  const outputSubscriptions = new WeakMap<WebSocket, Map<string, (data: string) => void>>();
  const cachedAgentCommandResults = new Map<string, Map<string, CachedAgentCommandResult>>();

  function getAgentCommandResultCacheKey(result: {
    agentId: string;
    command: 'input' | 'resize';
    requestId: string;
  }): string {
    return `${result.command}:${result.agentId}:${result.requestId}`;
  }

  function pruneExpiredAgentCommandResults(now: number): void {
    for (const [clientId, entries] of cachedAgentCommandResults) {
      for (const [cacheKey, entry] of entries) {
        if (entry.expiresAt > now) {
          continue;
        }

        entries.delete(cacheKey);
      }

      if (entries.size === 0) {
        cachedAgentCommandResults.delete(clientId);
      }
    }
  }

  function getCachedAgentCommandResult(
    clientId: string | null,
    request: AgentCommandRequest | undefined,
  ): Extract<ServerMessage, { type: 'agent-command-result' }> | null {
    if (!clientId || !request) {
      return null;
    }

    pruneExpiredAgentCommandResults(Date.now());
    const entry = cachedAgentCommandResults.get(clientId)?.get(
      getAgentCommandResultCacheKey({
        agentId: request.agentId,
        command: request.type,
        requestId: request.requestId,
      }),
    );
    return entry?.result ?? null;
  }

  function cacheAgentCommandResult(
    clientId: string | null,
    result: Extract<ServerMessage, { type: 'agent-command-result' }>,
  ): void {
    if (!clientId) {
      return;
    }

    pruneExpiredAgentCommandResults(Date.now());
    const entries = cachedAgentCommandResults.get(clientId) ?? new Map();
    entries.set(getAgentCommandResultCacheKey(result), {
      expiresAt: Date.now() + AGENT_COMMAND_RESULT_CACHE_TTL_MS,
      result,
    });

    while (entries.size > MAX_CACHED_AGENT_COMMAND_RESULTS_PER_CLIENT) {
      const oldestCacheKey = entries.keys().next().value;
      if (typeof oldestCacheKey !== 'string') {
        break;
      }
      entries.delete(oldestCacheKey);
    }

    cachedAgentCommandResults.set(clientId, entries);
  }

  function createAgentCommandResult(
    request: AgentCommandRequest,
    accepted: boolean,
    reason?: string,
  ): Extract<ServerMessage, { type: 'agent-command-result' }> {
    return {
      accepted,
      agentId: request.agentId,
      command: request.type,
      ...(reason ? { message: reason } : {}),
      requestId: request.requestId,
      type: 'agent-command-result',
    };
  }

  function getAgentCommandRequest(message: {
    agentId: string;
    requestId?: string;
    type?: 'input' | 'resize';
  }): AgentCommandRequest | undefined {
    if (!message.requestId || !message.type) {
      return undefined;
    }

    return {
      agentId: message.agentId,
      requestId: message.requestId,
      type: message.type,
    };
  }

  function createAgentCommandExecutionOptions(
    request: AgentCommandRequest | undefined,
    taskId: string | undefined,
  ): AgentCommandExecutionOptions | undefined {
    const nextOptions: AgentCommandExecutionOptions = {};
    if (request) {
      nextOptions.request = request;
    }
    if (typeof taskId === 'string') {
      nextOptions.taskId = taskId;
    }

    return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
  }

  function sendAgentCommandResult(
    client: WebSocket,
    result: Extract<ServerMessage, { type: 'agent-command-result' }>,
  ): void {
    const clientId = options.transport.getClientId(client);
    cacheAgentCommandResult(clientId, result);
    options.sendMessage(client, result);
  }

  function sendRequestedAgentCommandResult(
    client: WebSocket,
    request: AgentCommandRequest | undefined,
    accepted: boolean,
    reason?: string,
  ): boolean {
    if (!request) {
      return false;
    }

    sendAgentCommandResult(client, createAgentCommandResult(request, accepted, reason));
    return true;
  }

  function cleanupClient(client: WebSocket): void {
    const clientId = options.transport.getClientId(client);
    options.channels.cleanupClient(client);

    const subscriptions = outputSubscriptions.get(client);
    if (subscriptions) {
      for (const [agentId, callback] of subscriptions) {
        unsubscribeFromAgent(agentId, callback);
      }
      subscriptions.clear();
    }

    if (clientId && !options.transport.hasClientId(clientId)) {
      cachedAgentCommandResults.delete(clientId);
    }
  }

  function claimAgentControlWithStaleControllerRecovery(
    client: WebSocket,
    agentId: string,
    taskId?: string,
  ): ClaimAgentControlResult {
    let claimResult = options.transport.claimAgentControl(client, agentId);
    if (!claimResult.ok && claimResult.reason === 'controlled-by-peer') {
      const resolvedTaskId = taskId ?? getAgentMeta(agentId)?.taskId;
      const staleControllerStillOwnsTask =
        typeof resolvedTaskId === 'string' &&
        canResizeTaskTerminal(resolvedTaskId, claimResult.controllerId);

      if (!staleControllerStillOwnsTask) {
        options.transport.releaseAgentControl(agentId, claimResult.controllerId);
        claimResult = options.transport.claimAgentControl(client, agentId);
      }
    }

    return claimResult;
  }

  function sendClaimAgentControlFailure(
    client: WebSocket,
    agentId: string,
    action: string,
    claimResult: ClaimAgentControlFailure,
    request?: AgentCommandRequest,
  ): void {
    const errorMessage = getClaimAgentControlErrorMessage(claimResult);
    if (sendRequestedAgentCommandResult(client, request, false, errorMessage)) {
      return;
    }

    options.sendAgentError(client, agentId, `${action} failed`, new Error(errorMessage));
  }

  function claimAgentControlOrSendError(
    client: WebSocket,
    agentId: string,
    action: string,
    taskId?: string,
  ): boolean {
    const claimResult = claimAgentControlWithStaleControllerRecovery(client, agentId, taskId);
    if (claimResult.ok) {
      return true;
    }

    sendClaimAgentControlFailure(client, agentId, action, claimResult);
    return false;
  }

  function sendTaskControlFailure(
    client: WebSocket,
    message: {
      agentId: string;
      requestId?: string;
      type?: 'input' | 'resize';
    },
    action: 'resize' | 'write',
  ): void {
    const request = getAgentCommandRequest(message);
    if (
      sendRequestedAgentCommandResult(
        client,
        request,
        false,
        TASK_CONTROLLED_BY_ANOTHER_CLIENT_MESSAGE,
      )
    ) {
      return;
    }

    options.sendAgentError(client, message.agentId, `${action} failed`, createTaskControlError());
  }

  function runAgentCommand(
    client: WebSocket,
    agentId: string,
    action: string,
    execute: () => void,
    requireControl = true,
    commandOptions?: AgentCommandExecutionOptions,
  ): void {
    const clientId = options.transport.getClientId(client);
    const request = commandOptions?.request;
    if (request) {
      const cachedResult = getCachedAgentCommandResult(clientId, request);
      if (cachedResult) {
        sendAgentCommandResult(client, cachedResult);
        return;
      }
    }

    try {
      if (requireControl) {
        const claimResult = claimAgentControlWithStaleControllerRecovery(
          client,
          agentId,
          commandOptions?.taskId,
        );
        if (!claimResult.ok) {
          commandOptions?.onFailure?.(getClaimAgentControlErrorMessage(claimResult));
          sendClaimAgentControlFailure(client, agentId, action, claimResult, request);
          return;
        }
      }

      execute();
      sendRequestedAgentCommandResult(client, request, true);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : `${action} failed`;
      commandOptions?.onFailure?.(errorMessage);
      if (sendRequestedAgentCommandResult(client, request, false, errorMessage)) {
        return;
      }

      options.sendAgentError(client, agentId, `${action} failed`, error);
    }
  }

  function createClientMessageHandlers(client: WebSocket): BrowserClientMessageHandlerMap {
    return {
      ping: () => {
        options.sendMessage(client, { type: 'pong' });
      },
      input: (currentMessage) => {
        const clientId = options.transport.getClientId(client);
        const traceRequestId = currentMessage.requestId;
        if (currentMessage.trace && traceRequestId) {
          recordTerminalInputTraceServerReceived({
            agentId: currentMessage.agentId,
            clientId,
            requestId: traceRequestId,
            taskId:
              typeof currentMessage.taskId === 'string'
                ? currentMessage.taskId
                : (getAgentMeta(currentMessage.agentId)?.taskId ?? null),
            trace: currentMessage.trace,
            inputPreview:
              currentMessage.data.length > 80
                ? `${currentMessage.data.slice(0, 80).replace(/\s+/g, ' ')}…`
                : currentMessage.data.replace(/\s+/g, ' '),
          });
        }
        if (!hasTaskControlForMessage(currentMessage, clientId, canResizeTaskTerminal)) {
          if (traceRequestId) {
            recordTerminalInputTraceFailure(
              currentMessage.agentId,
              traceRequestId,
              'task-control-denied',
            );
          }
          sendTaskControlFailure(client, currentMessage, 'write');
          return;
        }
        runAgentCommand(
          client,
          currentMessage.agentId,
          'write',
          () => {
            writeToAgent(
              currentMessage.agentId,
              currentMessage.data,
              currentMessage.trace && currentMessage.requestId
                ? {
                    clientId,
                    requestId: currentMessage.requestId,
                    taskId:
                      typeof currentMessage.taskId === 'string'
                        ? currentMessage.taskId
                        : (getAgentMeta(currentMessage.agentId)?.taskId ?? null),
                    trace: currentMessage.trace,
                  }
                : undefined,
            );
          },
          true,
          {
            ...createAgentCommandExecutionOptions(
              getAgentCommandRequest(currentMessage),
              currentMessage.taskId,
            ),
            ...(traceRequestId
              ? {
                  onFailure: (reason: string) => {
                    recordTerminalInputTraceFailure(currentMessage.agentId, traceRequestId, reason);
                  },
                }
              : {}),
          },
        );
      },
      resize: (currentMessage) => {
        const clientId = options.transport.getClientId(client);
        if (!hasTaskControlForMessage(currentMessage, clientId, canResizeTaskTerminal)) {
          sendTaskControlFailure(client, currentMessage, 'resize');
          return;
        }
        runAgentCommand(
          client,
          currentMessage.agentId,
          'resize',
          () => {
            resizeAgent(currentMessage.agentId, currentMessage.cols, currentMessage.rows);
          },
          true,
          createAgentCommandExecutionOptions(
            getAgentCommandRequest(currentMessage),
            currentMessage.taskId,
          ),
        );
      },
      kill: (currentMessage) => {
        runAgentCommand(client, currentMessage.agentId, 'kill', () => {
          killAgent(currentMessage.agentId);
        });
      },
      pause: (currentMessage) => {
        runAgentCommand(
          client,
          currentMessage.agentId,
          'pause',
          () => {
            pauseAgent(currentMessage.agentId, currentMessage.reason, currentMessage.channelId);
          },
          shouldRequireAgentControl(currentMessage.reason),
        );
      },
      resume: (currentMessage) => {
        runAgentCommand(
          client,
          currentMessage.agentId,
          'resume',
          () => {
            resumeAgent(currentMessage.agentId, currentMessage.reason, currentMessage.channelId);
          },
          shouldRequireAgentControl(currentMessage.reason),
        );
      },
      'bind-channel': (currentMessage) => {
        options.channels.bindChannel(client, currentMessage.channelId);
        options.sendMessage(client, {
          type: 'channel-bound',
          channelId: currentMessage.channelId,
        });
      },
      'unbind-channel': (currentMessage) => {
        options.channels.unbindChannel(client, currentMessage.channelId);
      },
      subscribe: (currentMessage) => {
        const subscriptions = outputSubscriptions.get(client);
        if (!subscriptions || subscriptions.has(currentMessage.agentId)) return;

        const scrollback = getAgentScrollback(currentMessage.agentId);
        if (scrollback) {
          options.sendMessage(client, {
            type: 'scrollback',
            agentId: currentMessage.agentId,
            data: scrollback,
            cols: getAgentCols(currentMessage.agentId),
          });
        }

        const callback = (data: string) => {
          if (client.readyState !== WebSocket.OPEN) return;
          options.sendMessage(client, {
            type: 'output',
            agentId: currentMessage.agentId,
            data,
          });
        };

        if (subscribeToAgent(currentMessage.agentId, callback)) {
          subscriptions.set(currentMessage.agentId, callback);
        }
      },
      unsubscribe: (currentMessage) => {
        const subscriptions = outputSubscriptions.get(client);
        const callback = subscriptions?.get(currentMessage.agentId);
        if (!callback) return;
        unsubscribeFromAgent(currentMessage.agentId, callback);
        subscriptions?.delete(currentMessage.agentId);
      },
      'permission-response': (currentMessage) => {
        const response = currentMessage.action === 'approve' ? 'y\n' : 'n\n';
        if (!claimAgentControlOrSendError(client, currentMessage.agentId, 'permission response')) {
          return;
        }
        try {
          writeToAgent(currentMessage.agentId, response);
        } catch {
          /* agent already gone */
        }
      },
      'update-presence': (currentMessage) => {
        options.updatePeerPresence(client, currentMessage);
      },
      'request-task-command-takeover': (currentMessage) => {
        options.requestTaskCommandTakeover(client, currentMessage);
      },
      'respond-task-command-takeover': (currentMessage) => {
        options.respondTaskCommandTakeover(client, currentMessage);
      },
      'terminal-input-trace': (currentMessage) => {
        recordTerminalInputTraceClientUpdate(currentMessage);
      },
      'terminal-input-trace-clock-sync': (currentMessage) => {
        const serverReceivedAtMs = getTerminalTraceServerTimestampMs();
        options.sendMessage(client, {
          type: 'terminal-input-trace-clock-sync',
          clientSentAtMs: currentMessage.clientSentAtMs,
          requestId: currentMessage.requestId,
          serverReceivedAtMs,
          serverSentAtMs: getTerminalTraceServerTimestampMs(),
        });
      },
    } satisfies BrowserClientMessageHandlerMap;
  }

  options.wss.on('connection', (client, req) => {
    outputSubscriptions.set(client, new Map());
    const clientMessageHandlers = createClientMessageHandlers(client);
    const authContext = parseSocketAuthContext(req);

    if (!options.isAllowedBrowserOrigin(req)) {
      client.close(4001, 'Unauthorized');
      return;
    }

    if (options.isAuthorizedRequest(req)) {
      if (!options.authenticateConnection(client, authContext.clientId, authContext.lastSeq)) {
        return;
      }
    } else {
      options.transport.scheduleAuthTimeout(client);
    }

    client.on('pong', () => {
      options.transport.notePong(client);
    });

    client.on('message', (raw) => {
      const message = parseClientMessage(String(raw));
      if (!message) return;

      if (message.type === 'auth') {
        if (!options.safeCompareToken(message.token)) {
          client.close(4001, 'Unauthorized');
          return;
        }
        options.authenticateConnection(client, message.clientId, message.lastSeq ?? -1);
        return;
      }

      if (!options.transport.isAuthenticated(client)) {
        client.close(4001, 'Unauthorized');
        return;
      }

      dispatchByType(clientMessageHandlers, message);
    });

    client.on('close', () => {
      recordTerminalInputTraceClientDisconnected(options.transport.getClientId(client));
      cleanupClient(client);
    });
  });

  return {
    cleanupClient,
  };
}
