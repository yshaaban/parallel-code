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
import { recordTerminalInputTraceClientUpdate } from '../ipc/runtime-diagnostics.js';
import {
  isAutomaticPauseReason,
  parseClientMessage,
  type PauseReason,
  type ClientMessage,
  type RemoteAgent,
  type ServerMessage,
} from './protocol.js';
import { getClaimAgentControlErrorMessage, type WebSocketTransport } from './ws-transport.js';
import { dispatchByType, type DispatchByTypeHandlerMap } from '../../src/lib/dispatch-by-type.js';

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

type AuthenticatedClientMessage = Exclude<ClientMessage, { type: 'auth' }>;
type RemoteClientMessageHandlerMap = DispatchByTypeHandlerMap<AuthenticatedClientMessage>;

function shouldRequireAgentControl(reason?: PauseReason): boolean {
  return !isAutomaticPauseReason(reason);
}

function getTraceNowMs(): number {
  return performance.timeOrigin + performance.now();
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
    const claimResult = options.transport.claimAgentControl(client, agentId);
    if (claimResult.ok) return true;

    sendAgentError(
      client,
      agentId,
      `${action} failed`,
      new Error(getClaimAgentControlErrorMessage(claimResult)),
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

  function createClientMessageHandlers(client: WebSocket): RemoteClientMessageHandlerMap {
    return {
      ping: () => {
        options.transport.sendMessage(client, { type: 'pong' } satisfies ServerMessage);
      },
      input: (currentMessage) => {
        runAgentCommand(client, currentMessage.agentId, 'write', () => {
          writeToAgent(
            currentMessage.agentId,
            currentMessage.data,
            currentMessage.trace && currentMessage.requestId
              ? {
                  clientId: options.transport.getClientId(client),
                  requestId: currentMessage.requestId,
                  taskId: currentMessage.taskId ?? null,
                  trace: currentMessage.trace,
                }
              : undefined,
          );
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
      subscribe: (currentMessage) => {
        const subscriptions = clientSubscriptions.get(client);
        if (!subscriptions || subscriptions.has(currentMessage.agentId)) return;

        const scrollback = getAgentScrollback(currentMessage.agentId);
        if (scrollback) {
          options.transport.sendMessage(client, {
            type: 'scrollback',
            agentId: currentMessage.agentId,
            data: scrollback,
            cols: getAgentCols(currentMessage.agentId),
          } satisfies ServerMessage);
        }

        const callback = (data: string) => {
          if (client.readyState !== WebSocket.OPEN) return;
          options.transport.sendMessage(client, {
            type: 'output',
            agentId: currentMessage.agentId,
            data,
          } satisfies ServerMessage);
        };

        if (subscribeToAgent(currentMessage.agentId, callback)) {
          subscriptions.set(currentMessage.agentId, callback);
        }
      },
      unsubscribe: (currentMessage) => {
        const subscriptions = clientSubscriptions.get(client);
        const callback = subscriptions?.get(currentMessage.agentId);
        if (!callback) return;

        unsubscribeFromAgent(currentMessage.agentId, callback);
        subscriptions?.delete(currentMessage.agentId);
      },
      'bind-channel': () => {},
      'unbind-channel': () => {},
      'permission-response': () => {},
      'request-task-command-takeover': () => {},
      'respond-task-command-takeover': () => {},
      'terminal-input-trace': (currentMessage) => {
        recordTerminalInputTraceClientUpdate(currentMessage);
      },
      'terminal-input-trace-clock-sync': (currentMessage) => {
        const serverReceivedAtMs = getTraceNowMs();
        options.transport.sendMessage(client, {
          type: 'terminal-input-trace-clock-sync',
          clientSentAtMs: currentMessage.clientSentAtMs,
          requestId: currentMessage.requestId,
          serverReceivedAtMs,
          serverSentAtMs: getTraceNowMs(),
        } satisfies ServerMessage);
      },
      'update-presence': () => {},
    } satisfies RemoteClientMessageHandlerMap;
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
    const clientMessageHandlers = createClientMessageHandlers(client);

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

      dispatchByType(clientMessageHandlers, message);
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
