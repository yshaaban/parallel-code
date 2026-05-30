import { WebSocketServer, WebSocket } from 'ws';
import { IPC } from '../ipc/channels.js';
import {
  getAgentCols,
  getAgentMeta,
  getAgentScrollback,
  getAgentTerminalRecovery,
  getAgentTerminalStartupRecovery,
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
  getTaskCommandControllerSnapshot,
  isTaskCommandLeaseHeld,
} from '../ipc/task-command-leases.js';
import { handleTaskCommandLeaseControlMessage } from '../ipc/task-command-lease-control.js';
import {
  decodeTerminalRenderedTail,
  runWithTerminalRestorePause,
  serializeTerminalRecoveryEntry,
} from '../ipc/terminal-recovery.js';
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
import type { PtyExitData, TerminalRecoveryBatchEntry } from '../../src/ipc/types.js';

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
type TerminalSubscriptionProtocol = 'legacy' | 'structured';

interface RemoteAgentSubscription {
  callback: (data: string) => void;
  degraded: boolean;
  terminalProtocol: TerminalSubscriptionProtocol;
}

function createInputOrderToken(
  message: Extract<AuthenticatedClientMessage, { type: 'input' }>,
): Parameters<typeof writeToAgent>[3] {
  if (message.inputEpoch === undefined || message.inputSeq === undefined) {
    return undefined;
  }

  return {
    inputEpoch: message.inputEpoch,
    inputSeq: message.inputSeq,
  };
}

function createResizeOrderToken(
  message: Extract<AuthenticatedClientMessage, { type: 'resize' }>,
): Parameters<typeof resizeAgent>[3] {
  if (message.resizeEpoch === undefined || message.resizeSeq === undefined) {
    return undefined;
  }

  return {
    resizeEpoch: message.resizeEpoch,
    resizeSeq: message.resizeSeq,
  };
}

function createPtyExitData(data: {
  exitCode?: number | null | undefined;
  lastOutput?: string[] | undefined;
  signal?: unknown;
}): PtyExitData {
  return {
    exit_code: data.exitCode ?? null,
    last_output: Array.isArray(data.lastOutput) ? data.lastOutput : [],
    signal: data.signal === null || data.signal === undefined ? null : String(data.signal),
  };
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

function shouldRequireAgentControl(reason?: PauseReason): boolean {
  return !isAutomaticPauseReason(reason);
}

function getTaskCommandMutationErrorMessage(taskId: string): string {
  const snapshot = getTaskCommandControllerSnapshot(taskId);
  if (snapshot.controllerId) {
    return `Task is controlled by another client (${snapshot.controllerId})`;
  }

  return 'Task is controlled by another client';
}

function assertRemoteTaskCommandMutation(
  message: Extract<AuthenticatedClientMessage, { type: 'input' | 'resize' }>,
): void {
  const agentTaskId = getAgentMeta(message.agentId)?.taskId ?? null;
  if (!agentTaskId) {
    if (message.taskId !== undefined || message.controllerId !== undefined) {
      throw new Error('taskId and controllerId require a task agent');
    }
    return;
  }

  if (message.taskId !== agentTaskId) {
    throw new Error('taskId must match the agent task');
  }
  if (message.controllerId === undefined) {
    throw new Error('controllerId is required for task terminal mutations');
  }
  if (!isTaskCommandLeaseHeld(agentTaskId, message.controllerId)) {
    throw new Error(getTaskCommandMutationErrorMessage(agentTaskId));
  }
}

function getTraceNowMs(): number {
  return performance.timeOrigin + performance.now();
}

export function registerRemoteWebSocketServer(
  options: RegisterRemoteWebSocketServerOptions,
): RemoteWebSocketServer {
  const clientSubscriptions = new WeakMap<WebSocket, Map<string, RemoteAgentSubscription>>();
  const exitBroadcastTimers = new Set<ReturnType<typeof setTimeout>>();
  let cleanedUp = false;

  function cleanupClient(client: WebSocket): void {
    options.transport.cleanupClient(client);

    const subscriptions = clientSubscriptions.get(client);
    if (!subscriptions) return;

    for (const [agentId, callback] of subscriptions) {
      unsubscribeFromAgent(agentId, callback.callback);
    }
    subscriptions.clear();
    clientSubscriptions.delete(client);
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

  function resumeStructuredSubscription(client: WebSocket, agentId: string): void {
    const subscription = clientSubscriptions.get(client)?.get(agentId);
    if (subscription) {
      subscription.degraded = false;
    }
  }

  function sendTerminalRecoveryEntry(client: WebSocket, entry: TerminalRecoveryBatchEntry): void {
    const result = options.transport.sendMessage(client, {
      type: 'terminal-recovery-result',
      entry,
    } satisfies ServerMessage);
    if (result.ok) {
      resumeStructuredSubscription(client, entry.agentId);
    }
  }

  function sendStructuredRecoveryRequired(client: WebSocket, agentId: string): void {
    options.transport.sendMessage(client, {
      type: 'terminal-stream',
      agentId,
      event: {
        type: 'RecoveryRequired',
        reason: 'backpressure',
      },
    } satisfies ServerMessage);
  }

  function sendStructuredData(
    client: WebSocket,
    agentId: string,
    subscription: RemoteAgentSubscription,
    data: string,
  ): void {
    if (subscription.degraded) {
      return;
    }

    const result = options.transport.sendMessage(client, {
      type: 'terminal-stream',
      agentId,
      event: {
        type: 'Data',
        data,
      },
    } satisfies ServerMessage);
    if (result.ok) {
      return;
    }

    subscription.degraded = true;
    sendStructuredRecoveryRequired(client, agentId);
  }

  function emitTaskCommandControllerChanged(payload: {
    action: string | null;
    controllerId: string | null;
    taskId: string;
    version: number;
  }): void {
    options.transport.broadcastControl({
      type: 'ipc-event',
      channel: IPC.TaskCommandControllerChanged,
      payload,
    });
  }

  function handleTaskCommandLease(
    client: WebSocket,
    message: Extract<AuthenticatedClientMessage, { type: 'task-command-lease' }>,
  ): void {
    const result = handleTaskCommandLeaseControlMessage(
      message,
      options.transport.getClientId(client),
      emitTaskCommandControllerChanged,
    );
    options.transport.sendMessage(client, result);
  }

  function createClientMessageHandlers(client: WebSocket): RemoteClientMessageHandlerMap {
    return {
      ping: () => {
        options.transport.sendMessage(client, { type: 'pong' } satisfies ServerMessage);
      },
      input: (currentMessage) => {
        runAgentCommand(client, currentMessage.agentId, 'write', () => {
          assertRemoteTaskCommandMutation(currentMessage);
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
            createInputOrderToken(currentMessage),
          );
        });
      },
      resize: (currentMessage) => {
        runAgentCommand(client, currentMessage.agentId, 'resize', () => {
          assertRemoteTaskCommandMutation(currentMessage);
          resizeAgent(
            currentMessage.agentId,
            currentMessage.cols,
            currentMessage.rows,
            createResizeOrderToken(currentMessage),
          );
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
            pauseAgent(
              currentMessage.agentId,
              currentMessage.reason,
              currentMessage.channelId,
              currentMessage.restoreLeaseId,
            );
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
            resumeAgent(
              currentMessage.agentId,
              currentMessage.reason,
              currentMessage.channelId,
              currentMessage.restoreLeaseId,
            );
          },
          shouldRequireAgentControl(currentMessage.reason),
        );
      },
      subscribe: (currentMessage) => {
        const subscriptions = clientSubscriptions.get(client);
        if (!subscriptions || subscriptions.has(currentMessage.agentId)) return;
        const terminalProtocol = currentMessage.terminalProtocol ?? 'legacy';

        if (terminalProtocol === 'legacy') {
          const scrollback = getAgentScrollback(currentMessage.agentId);
          if (scrollback) {
            options.transport.sendMessage(client, {
              type: 'scrollback',
              agentId: currentMessage.agentId,
              data: scrollback,
              cols: getAgentCols(currentMessage.agentId),
            } satisfies ServerMessage);
          }
        }

        const callback = (data: string) => {
          const subscription = clientSubscriptions.get(client)?.get(currentMessage.agentId);
          if (!subscription || subscription.callback !== callback) {
            return;
          }

          if (client.readyState !== WebSocket.OPEN) return;
          if (subscription.terminalProtocol === 'structured') {
            sendStructuredData(client, currentMessage.agentId, subscription, data);
            return;
          }

          options.transport.sendMessage(client, {
            type: 'output',
            agentId: currentMessage.agentId,
            data,
          } satisfies ServerMessage);
        };

        if (subscribeToAgent(currentMessage.agentId, callback)) {
          subscriptions.set(currentMessage.agentId, {
            callback,
            degraded: false,
            terminalProtocol,
          });
        }
      },
      unsubscribe: (currentMessage) => {
        const subscriptions = clientSubscriptions.get(client);
        const subscription = subscriptions?.get(currentMessage.agentId);
        if (!subscription) return;

        unsubscribeFromAgent(currentMessage.agentId, subscription.callback);
        subscriptions?.delete(currentMessage.agentId);
      },
      'bind-channel': () => {},
      'unbind-channel': () => {},
      'permission-response': () => {},
      'request-task-command-takeover': () => {},
      'respond-task-command-takeover': () => {},
      'task-command-lease': (currentMessage) => {
        handleTaskCommandLease(client, currentMessage);
      },
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
      'terminal-recovery-request': (currentMessage) => {
        void runWithTerminalRestorePause(currentMessage.agentId, () => {
          const recovery = getAgentTerminalRecovery(
            currentMessage.agentId,
            decodeTerminalRenderedTail(currentMessage.renderedTail),
            currentMessage.outputCursor,
            currentMessage.snapshotByteLimit,
          );
          sendTerminalRecoveryEntry(
            client,
            serializeTerminalRecoveryEntry(
              currentMessage.agentId,
              currentMessage.requestId,
              recovery,
            ),
          );
        }).catch((error) => {
          sendAgentError(client, currentMessage.agentId, 'terminal recovery failed', error);
        });
      },
      'terminal-startup-recovery-request': (currentMessage) => {
        void runWithTerminalRestorePause(currentMessage.agentId, async () => {
          const recovery = await getAgentTerminalStartupRecovery(
            currentMessage.agentId,
            null,
            null,
            currentMessage.role,
            currentMessage.visibleTerminalCount,
          );
          sendTerminalRecoveryEntry(
            client,
            serializeTerminalRecoveryEntry(
              currentMessage.agentId,
              currentMessage.requestId,
              recovery,
            ),
          );
        }).catch((error) => {
          sendAgentError(client, currentMessage.agentId, 'terminal startup recovery failed', error);
        });
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
    const { exitCode, lastOutput, signal } = (data ?? {}) as {
      exitCode?: number;
      lastOutput?: string[];
      signal?: unknown;
    };
    options.transport.releaseAgentControl(agentId);
    options.transport.broadcastControl({
      type: 'status',
      agentId,
      status: 'exited',
      exitCode: exitCode ?? null,
    });

    for (const client of options.wss.clients) {
      const subscriptions = clientSubscriptions.get(client);
      const subscription = subscriptions?.get(agentId);
      if (subscription?.terminalProtocol === 'structured') {
        options.transport.sendMessage(client, {
          type: 'terminal-stream',
          agentId,
          event: {
            type: 'Exit',
            data: createPtyExitData({ exitCode, lastOutput, signal }),
          },
        } satisfies ServerMessage);
      }
      subscriptions?.delete(agentId);
    }

    const timer = setTimeout(() => {
      exitBroadcastTimers.delete(timer);
      broadcastAgentList();
    }, 100);
    exitBroadcastTimers.add(timer);
  });

  options.wss.on('connection', (client, req) => {
    enableSocketNoDelay(client);
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
