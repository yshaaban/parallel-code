import { WebSocketServer, WebSocket } from 'ws';
import {
  getAgentCols,
  getAgentScrollback,
  killAgent,
  onPtyEvent,
  pauseAgent,
  resizeAgent,
  resumeAgent,
  subscribeToAgent,
  unsubscribeFromAgent,
  writeToAgent,
} from '../ipc/pty.js';
import {
  isAutomaticPauseReason,
  parseClientMessage,
  type PauseReason,
  type RemoteAgent,
  type ServerMessage,
} from './protocol.js';
import type { WebSocketTransport } from './ws-transport.js';

export interface RegisterRemoteWebSocketServerOptions {
  authenticateConnection: (client: WebSocket, clientId?: string, lastSeq?: number) => boolean;
  getAgentList: () => RemoteAgent[];
  safeCompareToken: (token: string | null) => boolean;
  transport: WebSocketTransport<WebSocket>;
  wss: WebSocketServer;
}

export interface RemoteWebSocketServer {
  cleanup: () => void;
}

function shouldRequireAgentControl(reason?: PauseReason): boolean {
  return !isAutomaticPauseReason(reason);
}

export function registerRemoteWebSocketServer(
  options: RegisterRemoteWebSocketServerOptions,
): RemoteWebSocketServer {
  const clientSubscriptions = new WeakMap<WebSocket, Map<string, (data: string) => void>>();
  const exitBroadcastTimers = new Set<ReturnType<typeof setTimeout>>();
  let cleanedUp = false;

  function cleanupClient(client: WebSocket): void {
    options.transport.cleanupClient(client);

    const subscriptions = clientSubscriptions.get(client);
    if (!subscriptions) return;

    for (const [agentId, callback] of subscriptions) {
      unsubscribeFromAgent(agentId, callback);
    }
    subscriptions.clear();
  }

  function broadcastAgentList(): void {
    options.transport.broadcast({
      type: 'agents',
      list: options.getAgentList(),
    });
  }

  function sendAgentError(
    client: WebSocket,
    agentId: string,
    fallbackMessage: string,
    error: unknown,
  ): void {
    options.transport.sendMessage(client, {
      type: 'agent-error',
      agentId,
      message: error instanceof Error ? error.message : fallbackMessage,
    } satisfies ServerMessage);
  }

  function claimAgentControlOrSendError(
    client: WebSocket,
    agentId: string,
    action: string,
  ): boolean {
    if (options.transport.claimAgentControl(client, agentId)) return true;

    sendAgentError(
      client,
      agentId,
      `${action} failed`,
      new Error('Agent is controlled by another client.'),
    );
    return false;
  }

  function executeAgentCommand(
    client: WebSocket,
    agentId: string,
    action: string,
    execute: () => void,
  ): void {
    try {
      execute();
    } catch (error) {
      sendAgentError(client, agentId, `${action} failed`, error);
    }
  }

  function runAgentCommand(
    client: WebSocket,
    agentId: string,
    action: string,
    execute: () => void,
    requireControl = true,
  ): void {
    if (requireControl && !claimAgentControlOrSendError(client, agentId, action)) {
      return;
    }

    executeAgentCommand(client, agentId, action, execute);
  }

  const unsubscribeSpawn = onPtyEvent('spawn', () => {
    broadcastAgentList();
  });

  const unsubscribeListChanged = onPtyEvent('list-changed', () => {
    broadcastAgentList();
  });

  const unsubscribePause = onPtyEvent('pause', () => {
    broadcastAgentList();
  });

  const unsubscribeResume = onPtyEvent('resume', () => {
    broadcastAgentList();
  });

  const unsubscribeExit = onPtyEvent('exit', (agentId, data) => {
    const { exitCode } = (data ?? {}) as { exitCode?: number };
    options.transport.releaseAgentControl(agentId);
    options.transport.broadcastControl({
      type: 'status',
      agentId,
      status: 'exited',
      exitCode: exitCode ?? null,
    });

    for (const client of options.wss.clients) {
      clientSubscriptions.get(client)?.delete(agentId);
    }

    const timer = setTimeout(() => {
      exitBroadcastTimers.delete(timer);
      broadcastAgentList();
    }, 100);
    exitBroadcastTimers.add(timer);
  });

  options.wss.on('connection', (client, req) => {
    clientSubscriptions.set(client, new Map());

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
          options.transport.sendMessage(client, { type: 'pong' } satisfies ServerMessage);
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
        case 'subscribe': {
          const subscriptions = clientSubscriptions.get(client);
          if (!subscriptions || subscriptions.has(message.agentId)) break;

          const scrollback = getAgentScrollback(message.agentId);
          if (scrollback) {
            options.transport.sendMessage(client, {
              type: 'scrollback',
              agentId: message.agentId,
              data: scrollback,
              cols: getAgentCols(message.agentId),
            } satisfies ServerMessage);
          }

          const callback = (data: string) => {
            if (client.readyState !== WebSocket.OPEN) return;
            options.transport.sendMessage(client, {
              type: 'output',
              agentId: message.agentId,
              data,
            } satisfies ServerMessage);
          };

          if (subscribeToAgent(message.agentId, callback)) {
            subscriptions.set(message.agentId, callback);
          }
          break;
        }
        case 'unsubscribe': {
          const subscriptions = clientSubscriptions.get(client);
          const callback = subscriptions?.get(message.agentId);
          if (!callback) break;

          unsubscribeFromAgent(message.agentId, callback);
          subscriptions?.delete(message.agentId);
          break;
        }
      }
    });

    client.on('close', () => {
      cleanupClient(client);
    });
  });

  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;

    for (const timer of exitBroadcastTimers) {
      clearTimeout(timer);
    }
    exitBroadcastTimers.clear();

    for (const client of options.wss.clients) {
      cleanupClient(client);
    }

    unsubscribeSpawn();
    unsubscribeListChanged();
    unsubscribePause();
    unsubscribeResume();
    unsubscribeExit();
  }

  return {
    cleanup,
  };
}
