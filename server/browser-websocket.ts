import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import {
  isAutomaticPauseReason,
  parseClientMessage,
  type ClientMessage,
  type PauseReason,
  type ServerMessage,
} from '../electron/remote/protocol.js';
import type { WebSocketTransport } from '../electron/remote/ws-transport.js';
import type { BrowserChannelManager } from './browser-channels.js';
import {
  hasBrowserTaskControlForMessage,
  resolveBrowserAgentTaskId,
} from './browser-websocket-task-control.js';
import {
  killBrowserAgent,
  pauseBrowserAgent,
  resizeBrowserAgent,
  resumeBrowserAgent,
  writeBrowserAgentInput,
  writeBrowserAgentPermissionResponse,
} from './browser-agent-command-executor.js';
import {
  createBrowserAgentCommandResultCache,
  getAgentCommandRequest,
} from './browser-agent-command-results.js';
import {
  createBrowserAgentCommandRunner,
  type AgentCommandExecutionOptions,
} from './browser-agent-command-runner.js';
import { createBrowserAgentOutputSubscriptions } from './browser-agent-output-subscriptions.js';
import {
  createBrowserTerminalInputTraceClockSyncMessage,
  createBrowserTerminalInputTraceRequest,
  recordBrowserTerminalInputClientDisconnected,
  recordBrowserTerminalInputClientUpdate,
  recordBrowserTerminalInputCommandResultSent,
  recordBrowserTerminalInputFailure,
  recordBrowserTerminalInputServerReceived,
} from './browser-terminal-input-tracing.js';
import { dispatchByType, type DispatchByTypeHandlerMap } from '../src/lib/dispatch-by-type.js';

// Browser websocket control plane. This handles authenticated websocket
// sessions, control commands, and sequenced control-event delivery.

export interface RegisterBrowserWebSocketServerOptions {
  authenticateConnection: (client: WebSocket, clientId?: string, lastSeq?: number) => boolean;
  broadcastRemoteStatus: () => void;
  channels: BrowserChannelManager;
  cleanupClientState: (client: WebSocket) => void;
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
  cleanup: () => void;
  cleanupClient: (client: WebSocket) => void;
  pruneDisconnectedAgentCommandResults: () => void;
}

type AuthenticatedClientMessage = Exclude<ClientMessage, { type: 'auth' }>;
type BrowserClientMessageHandlerMap = DispatchByTypeHandlerMap<AuthenticatedClientMessage>;

interface BrowserSocketAuthContext {
  clientId?: string;
  lastSeq?: number;
}

function enableSocketNoDelay(client: WebSocket): void {
  const socket = (
    client as WebSocket & {
      _socket?: {
        setNoDelay?: (noDelay?: boolean) => void;
      };
    }
  )._socket;
  socket?.setNoDelay?.(true);
}

function parseSocketAuthContext(request: Pick<IncomingMessage, 'url'>): BrowserSocketAuthContext {
  if (!request.url) {
    return {};
  }

  if (!URL.canParse(request.url, 'http://localhost')) {
    return {};
  }

  const url = new URL(request.url, 'http://localhost');
  const clientId = url.searchParams.get('clientId');
  const lastSeq = parseSocketAuthLastSeq(url.searchParams.get('lastSeq'));

  return {
    ...(clientId ? { clientId } : {}),
    ...(lastSeq !== undefined ? { lastSeq } : {}),
  };
}

function parseSocketAuthLastSeq(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/u.test(value)) {
    return undefined;
  }

  const lastSeq = Number(value);
  return Number.isSafeInteger(lastSeq) && lastSeq >= -1 ? lastSeq : undefined;
}

function shouldRequireAgentControl(reason?: PauseReason): boolean {
  return !isAutomaticPauseReason(reason);
}

export function registerBrowserWebSocketServer(
  options: RegisterBrowserWebSocketServerOptions,
): BrowserWebSocketServer {
  const agentCommandResults = createBrowserAgentCommandResultCache<WebSocket>({
    getClientId: (client) => options.transport.getClientId(client),
  });
  const agentCommandRunner = createBrowserAgentCommandRunner<WebSocket>({
    agentCommandResults,
    claimAgentControl: (client, agentId) => options.transport.claimAgentControl(client, agentId),
    releaseAgentControl: (agentId, controllerId) =>
      options.transport.releaseAgentControl(agentId, controllerId),
    onAgentCommandResultSent: recordBrowserTerminalInputCommandResultSent,
    sendAgentError: options.sendAgentError,
    sendMessage: options.sendMessage,
  });
  const agentOutputSubscriptions = createBrowserAgentOutputSubscriptions<WebSocket>({
    isClientOpen: (client) => client.readyState === WebSocket.OPEN,
    sendMessage: options.sendMessage,
  });

  function cleanupClient(client: WebSocket): void {
    recordBrowserTerminalInputClientDisconnected(options.transport.getClientId(client));
    options.channels.cleanupClient(client);
    agentOutputSubscriptions.cleanupClient(client);
  }

  function pruneDisconnectedAgentCommandResults(): void {
    agentCommandResults.pruneExpired();
  }

  function cleanup(): void {
    agentCommandResults.cleanup();
  }

  function mergeAgentCommandExecutionOptions(
    base: AgentCommandExecutionOptions | undefined,
    overrides: AgentCommandExecutionOptions | undefined,
  ): AgentCommandExecutionOptions | undefined {
    if (!base && !overrides) {
      return undefined;
    }

    return {
      ...(base ?? {}),
      ...(overrides ?? {}),
    };
  }

  function runTaskControlledAgentCommand(
    client: WebSocket,
    currentMessage: Extract<AuthenticatedClientMessage, { type: 'input' | 'resize' }>,
    action: 'resize' | 'write',
    execute: () => void,
    optionsOverride?: AgentCommandExecutionOptions,
    onTaskControlDenied?: () => void,
  ): void {
    const clientId = options.transport.getClientId(client);
    if (!hasBrowserTaskControlForMessage(currentMessage, clientId)) {
      onTaskControlDenied?.();
      agentCommandRunner.sendTaskControlFailure(client, currentMessage, action);
      return;
    }

    agentCommandRunner.run(
      client,
      currentMessage.agentId,
      action,
      execute,
      true,
      mergeAgentCommandExecutionOptions(
        agentCommandRunner.createExecutionOptions(
          getAgentCommandRequest(currentMessage),
          currentMessage.taskId,
        ),
        optionsOverride,
      ),
    );
  }

  function createClientMessageHandlers(client: WebSocket): BrowserClientMessageHandlerMap {
    return {
      ping: () => {
        options.sendMessage(client, { type: 'pong' });
      },
      input: (currentMessage) => {
        const clientId = options.transport.getClientId(client);
        const traceRequestId = currentMessage.requestId;
        const traceTaskId = resolveBrowserAgentTaskId(currentMessage) ?? null;
        recordBrowserTerminalInputServerReceived(currentMessage, clientId, traceTaskId);
        runTaskControlledAgentCommand(
          client,
          currentMessage,
          'write',
          () => {
            writeBrowserAgentInput(
              currentMessage.agentId,
              currentMessage.data,
              createBrowserTerminalInputTraceRequest(currentMessage, clientId, traceTaskId),
            );
          },
          traceRequestId
            ? {
                onFailure: (reason: string) => {
                  recordBrowserTerminalInputFailure(currentMessage.agentId, traceRequestId, reason);
                },
              }
            : undefined,
          () => {
            recordBrowserTerminalInputFailure(
              currentMessage.agentId,
              traceRequestId,
              'task-control-denied',
            );
          },
        );
      },
      resize: (currentMessage) => {
        runTaskControlledAgentCommand(client, currentMessage, 'resize', () => {
          resizeBrowserAgent(currentMessage.agentId, currentMessage.cols, currentMessage.rows);
        });
      },
      kill: (currentMessage) => {
        agentCommandRunner.run(client, currentMessage.agentId, 'kill', () => {
          killBrowserAgent(currentMessage.agentId);
        });
      },
      pause: (currentMessage) => {
        agentCommandRunner.run(
          client,
          currentMessage.agentId,
          'pause',
          () => {
            pauseBrowserAgent(
              currentMessage.agentId,
              currentMessage.reason,
              currentMessage.channelId,
            );
          },
          shouldRequireAgentControl(currentMessage.reason),
        );
      },
      resume: (currentMessage) => {
        agentCommandRunner.run(
          client,
          currentMessage.agentId,
          'resume',
          () => {
            resumeBrowserAgent(
              currentMessage.agentId,
              currentMessage.reason,
              currentMessage.channelId,
            );
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
        agentOutputSubscriptions.subscribe(client, currentMessage.agentId);
      },
      unsubscribe: (currentMessage) => {
        agentOutputSubscriptions.unsubscribe(client, currentMessage.agentId);
      },
      'permission-response': (currentMessage) => {
        if (
          !agentCommandRunner.claimControlOrSendError(
            client,
            currentMessage.agentId,
            'permission response',
          )
        ) {
          return;
        }
        try {
          writeBrowserAgentPermissionResponse(currentMessage.agentId, currentMessage.action);
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
        recordBrowserTerminalInputClientUpdate(currentMessage);
      },
      'terminal-input-trace-clock-sync': (currentMessage) => {
        options.sendMessage(
          client,
          createBrowserTerminalInputTraceClockSyncMessage(currentMessage),
        );
      },
    } satisfies BrowserClientMessageHandlerMap;
  }

  options.wss.on('connection', (client, req) => {
    enableSocketNoDelay(client);
    agentOutputSubscriptions.registerClient(client);
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
      options.cleanupClientState(client);
    });
  });

  return {
    cleanup,
    cleanupClient,
    pruneDisconnectedAgentCommandResults,
  };
}
