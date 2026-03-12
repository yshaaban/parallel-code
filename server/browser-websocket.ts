import { WebSocketServer, WebSocket } from 'ws';
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
  type PauseReason,
  type ServerMessage,
} from '../electron/remote/protocol.js';
import type { WebSocketTransport } from '../electron/remote/ws-transport.js';
import type { BrowserChannelManager } from './browser-channels.js';

export interface RegisterBrowserWebSocketServerOptions {
  authenticateConnection: (client: WebSocket, clientId?: string, lastSeq?: number) => boolean;
  broadcastRemoteStatus: () => void;
  channels: BrowserChannelManager;
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
    if (options.transport.claimAgentControl(client, agentId)) return true;
    options.sendAgentError(
      client,
      agentId,
      `${action} failed`,
      new Error('Agent is controlled by another client.'),
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

  options.wss.on('connection', (client, req) => {
    outputSubscriptions.set(client, new Map());

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (options.safeCompareToken(url.searchParams.get('token'))) {
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

      switch (message.type) {
        case 'ping':
          options.sendMessage(client, { type: 'pong' });
          break;
        case 'input':
          runAgentCommand(client, message.agentId, 'write', () => {
            writeToAgent(message.agentId, message.data);
          });
          break;
        case 'resize':
          runAgentCommand(client, message.agentId, 'resize', () => {
            resizeAgent(message.agentId, message.cols, message.rows);
          });
          break;
        case 'kill':
          runAgentCommand(client, message.agentId, 'kill', () => {
            killAgent(message.agentId);
          });
          break;
        case 'pause':
          runAgentCommand(
            client,
            message.agentId,
            'pause',
            () => {
              pauseAgent(message.agentId, message.reason, message.channelId);
            },
            shouldRequireAgentControl(message.reason),
          );
          break;
        case 'resume':
          runAgentCommand(
            client,
            message.agentId,
            'resume',
            () => {
              resumeAgent(message.agentId, message.reason, message.channelId);
            },
            shouldRequireAgentControl(message.reason),
          );
          break;
        case 'bind-channel':
          options.channels.bindChannel(client, message.channelId);
          options.sendMessage(client, {
            type: 'channel-bound',
            channelId: message.channelId,
          });
          break;
        case 'unbind-channel':
          options.channels.unbindChannel(client, message.channelId);
          break;
        case 'subscribe': {
          const subscriptions = outputSubscriptions.get(client);
          if (!subscriptions || subscriptions.has(message.agentId)) break;

          const scrollback = getAgentScrollback(message.agentId);
          if (scrollback) {
            options.sendMessage(client, {
              type: 'scrollback',
              agentId: message.agentId,
              data: scrollback,
              cols: getAgentCols(message.agentId),
            });
          }

          const callback = (data: string) => {
            if (client.readyState !== WebSocket.OPEN) return;
            options.sendMessage(client, {
              type: 'output',
              agentId: message.agentId,
              data,
            });
          };

          if (subscribeToAgent(message.agentId, callback)) {
            subscriptions.set(message.agentId, callback);
          }
          break;
        }
        case 'unsubscribe': {
          const subscriptions = outputSubscriptions.get(client);
          const callback = subscriptions?.get(message.agentId);
          if (!callback) break;
          unsubscribeFromAgent(message.agentId, callback);
          subscriptions?.delete(message.agentId);
          break;
        }
        case 'permission-response': {
          const response = message.action === 'approve' ? 'y\n' : 'n\n';
          if (!claimAgentControlOrSendError(client, message.agentId, 'permission response')) {
            break;
          }
          try {
            writeToAgent(message.agentId, response);
          } catch {
            /* agent already gone */
          }
          break;
        }
      }
    });

    client.on('close', () => {
      const wasAuthenticated = options.transport.isAuthenticated(client);
      cleanupClient(client);
      if (wasAuthenticated) {
        options.broadcastRemoteStatus();
      }
    });
  });

  return {
    cleanupClient,
  };
}
