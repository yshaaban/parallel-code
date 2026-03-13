import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import {
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
import {
  getClaimAgentControlErrorMessage,
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
  transport: WebSocketTransport<WebSocket>;
  wss: WebSocketServer;
}

export interface BrowserWebSocketServer {
  cleanupClient: (client: WebSocket) => void;
}

type AuthenticatedClientMessage = Exclude<ClientMessage, { type: 'auth' }>;
type BrowserClientMessageHandlerMap = DispatchByTypeHandlerMap<AuthenticatedClientMessage>;

function shouldRequireAgentControl(reason?: PauseReason): boolean {
  return !isAutomaticPauseReason(reason);
}

export function registerBrowserWebSocketServer(
  options: RegisterBrowserWebSocketServerOptions,
): BrowserWebSocketServer {
  const outputSubscriptions = new WeakMap<WebSocket, Map<string, (data: string) => void>>();

  function cleanupClient(client: WebSocket): void {
    options.transport.cleanupClient(client);
    options.channels.cleanupClient(client);

    const subscriptions = outputSubscriptions.get(client);
    if (!subscriptions) return;

    for (const [agentId, callback] of subscriptions) {
      unsubscribeFromAgent(agentId, callback);
    }
    subscriptions.clear();
  }

  function claimAgentControlOrSendError(
    client: WebSocket,
    agentId: string,
    action: string,
  ): boolean {
    const claimResult = options.transport.claimAgentControl(client, agentId);
    if (claimResult.ok) return true;

    options.sendAgentError(
      client,
      agentId,
      `${action} failed`,
      new Error(getClaimAgentControlErrorMessage(claimResult)),
    );
    return false;
  }

  function runAgentCommand(
    client: WebSocket,
    agentId: string,
    action: string,
    execute: () => void,
    requireControl = true,
  ): void {
    try {
      if (requireControl && !claimAgentControlOrSendError(client, agentId, action)) {
        return;
      }
      execute();
    } catch (error) {
      options.sendAgentError(client, agentId, `${action} failed`, error);
    }
  }

  function createClientMessageHandlers(client: WebSocket): BrowserClientMessageHandlerMap {
    return {
      ping: () => {
        options.sendMessage(client, { type: 'pong' });
      },
      input: (currentMessage) => {
        runAgentCommand(client, currentMessage.agentId, 'write', () => {
          writeToAgent(currentMessage.agentId, currentMessage.data);
        });
      },
      resize: (currentMessage) => {
        runAgentCommand(client, currentMessage.agentId, 'resize', () => {
          resizeAgent(currentMessage.agentId, currentMessage.cols, currentMessage.rows);
        });
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
    } satisfies BrowserClientMessageHandlerMap;
  }

  options.wss.on('connection', (client, req) => {
    outputSubscriptions.set(client, new Map());
    const clientMessageHandlers = createClientMessageHandlers(client);

    if (!options.isAllowedBrowserOrigin(req)) {
      client.close(4001, 'Unauthorized');
      return;
    }

    if (options.isAuthorizedRequest(req)) {
      if (!options.authenticateConnection(client)) return;
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
      cleanupClient(client);
    });
  });

  return {
    cleanupClient,
  };
}
