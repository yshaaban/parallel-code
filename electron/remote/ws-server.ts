import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { IPC } from '../ipc/channels.js';
import {
  getAgentCols,
  getAgentMeta,
  getAgentScrollback,
  getAgentTerminalRecovery,
  getAgentTerminalStartupRecovery,
  onPtyEvent,
  pauseAgent,
  resizeAgent,
  resumeAgent,
  subscribeToAgent,
  unsubscribeFromAgent,
  writeToAgent,
  type PtyExitEventData,
} from '../ipc/pty.js';
import { stopTaskAgentWorkflow } from '../ipc/task-workflows.js';
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
import type {
  RemoteCommandAuthentication,
  RemoteCommandGateway,
  RemoteCommandName,
} from '../ipc/remote-command-gateway.js';
import type { TaskCatalogDeltaBatch } from '../../src/domain/task-catalog.js';
import type { TaskNotesChangedNotification } from '../../src/domain/task-notes.js';
import type { TaskCreationOperationId } from '../../src/domain/task-creation-ticket.js';
import type { RemoteTaskCreationOperationSource } from '../ipc/task-creation-remote-commands.js';

const MAX_TASK_CREATION_OPERATION_SUBSCRIPTIONS_PER_CLIENT = 8;
const MAX_TASK_CREATION_OPERATION_REFRESHES_PER_CATALOG_BATCH = 256;

export interface RegisterRemoteWebSocketServerOptions {
  authenticateConnection: (
    client: WebSocket,
    clientId?: string,
    lastSeq?: number,
    access?: { terminalRead: boolean },
  ) => boolean;
  authenticateScopedConnection?: (request: IncomingMessage) => RemoteCommandAuthentication | null;
  getCurrentScopedAuthentication?: (
    authentication: RemoteCommandAuthentication,
  ) => RemoteCommandAuthentication | null;
  getAgentList: () => RemoteAgent[];
  safeCompareToken: (token: string | null) => boolean;
  remoteCommandGateway?: RemoteCommandGateway;
  refreshScopedAuthentication?: (
    authentication: RemoteCommandAuthentication,
  ) => RemoteCommandAuthentication | null;
  subscribeScopedAuthenticationInvalidation?: (listener: () => void) => () => void;
  subscribeTaskCatalog?: (listener: (batch: TaskCatalogDeltaBatch) => void) => () => void;
  subscribeTaskNotesChanged?: (
    listener: (notification: TaskNotesChangedNotification) => void,
  ) => () => void;
  taskCreationOperations?: RemoteTaskCreationOperationSource;
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

interface RemoteTaskCreationOperationSubscription {
  active: boolean;
  authentication: RemoteCommandAuthentication;
  backendUnsubscribe: (() => Promise<void>) | null;
  operationId: TaskCreationOperationId;
  ready: boolean;
}

function hasSameTaskCreationAuthentication(
  left: RemoteCommandAuthentication,
  right: RemoteCommandAuthentication,
): boolean {
  return (
    left.authEpoch === right.authEpoch &&
    left.authenticationSessionGeneration === right.authenticationSessionGeneration &&
    left.principalId === right.principalId
  );
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

function createPtyExitData(
  data: Pick<PtyExitEventData, 'exitCode' | 'lastOutput' | 'signal'>,
): PtyExitData {
  return {
    exit_code: data.exitCode,
    last_output: [...data.lastOutput],
    signal: data.signal,
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

function isScopedSocketAuthenticationUsable(
  authentication: RemoteCommandAuthentication | null,
): authentication is RemoteCommandAuthentication {
  return (
    authentication?.kind === 'browser-session' &&
    authentication.transportSecure === true &&
    authentication.directPeerValidated === true &&
    authentication.originValidated === true &&
    authentication.expiresAt > Date.now()
  );
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
  const taskCreationOperationSubscriptions = new WeakMap<
    WebSocket,
    Map<string, RemoteTaskCreationOperationSubscription>
  >();
  const scopedAuthentication = new WeakMap<WebSocket, RemoteCommandAuthentication>();
  const scopedAuthenticationExpiryTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  const exitBroadcastTimers = new Set<ReturnType<typeof setTimeout>>();
  let cleanedUp = false;

  function releaseTaskCreationOperationSubscription(
    client: WebSocket,
    subscription: RemoteTaskCreationOperationSubscription,
  ): void {
    if (!subscription.active) return;
    subscription.active = false;
    const subscriptions = taskCreationOperationSubscriptions.get(client);
    if (subscriptions?.get(subscription.operationId) === subscription) {
      subscriptions.delete(subscription.operationId);
    }
    const backendUnsubscribe = subscription.backendUnsubscribe;
    subscription.backendUnsubscribe = null;
    if (backendUnsubscribe) void backendUnsubscribe().catch(() => undefined);
  }

  function releaseTaskCreationOperationSubscriptions(client: WebSocket): void {
    const subscriptions = taskCreationOperationSubscriptions.get(client);
    if (!subscriptions) return;
    for (const subscription of subscriptions.values()) {
      releaseTaskCreationOperationSubscription(client, subscription);
    }
    subscriptions.clear();
    taskCreationOperationSubscriptions.delete(client);
  }

  function taskCreationAuthenticationTransitionIsSafe(
    client: WebSocket,
    previous: RemoteCommandAuthentication,
    current: RemoteCommandAuthentication,
  ): boolean {
    const hasSubscriptions = (taskCreationOperationSubscriptions.get(client)?.size ?? 0) > 0;
    return (
      !hasSubscriptions ||
      (current.grants.has('task:create') && hasSameTaskCreationAuthentication(previous, current))
    );
  }

  function cleanupClient(client: WebSocket): void {
    options.transport.cleanupClient(client);
    releaseTaskCreationOperationSubscriptions(client);
    scopedAuthentication.delete(client);
    const expiryTimer = scopedAuthenticationExpiryTimers.get(client);
    if (expiryTimer) clearTimeout(expiryTimer);
    scopedAuthenticationExpiryTimers.delete(client);

    const subscriptions = clientSubscriptions.get(client);
    if (!subscriptions) return;

    for (const [agentId, callback] of subscriptions) {
      unsubscribeFromAgent(agentId, callback.callback);
    }
    subscriptions.clear();
    clientSubscriptions.delete(client);
  }

  function closeScopedClient(client: WebSocket): void {
    cleanupClient(client);
    client.close(4001, 'Secure session required');
  }

  function armScopedAuthenticationExpiry(
    client: WebSocket,
    authentication: RemoteCommandAuthentication,
  ): void {
    const previous = scopedAuthenticationExpiryTimers.get(client);
    if (previous) clearTimeout(previous);
    if (!options.getCurrentScopedAuthentication) return;
    const delay = Math.max(1, Math.min(authentication.expiresAt - Date.now(), 2_147_483_647));
    const timer = setTimeout(() => {
      scopedAuthenticationExpiryTimers.delete(client);
      const stored = scopedAuthentication.get(client);
      const current = stored ? options.getCurrentScopedAuthentication?.(stored) : null;
      if (!stored || !current) {
        closeScopedClient(client);
        return;
      }
      if (!taskCreationAuthenticationTransitionIsSafe(client, stored, current)) {
        closeScopedClient(client);
        return;
      }
      scopedAuthentication.set(client, current);
      armScopedAuthenticationExpiry(client, current);
    }, delay);
    timer.unref?.();
    scopedAuthenticationExpiryTimers.set(client, timer);
  }

  function hasScopedGrant(
    client: WebSocket,
    grant: 'catalog:read' | 'notes:read' | 'task:create' | 'terminal:read',
  ): boolean {
    return (
      !options.authenticateScopedConnection ||
      scopedAuthentication.get(client)?.grants.has(grant) === true
    );
  }

  function getCurrentTaskCreationAuthentication(
    client: WebSocket,
  ): RemoteCommandAuthentication | null {
    const stored = scopedAuthentication.get(client);
    if (!stored || !options.authenticateScopedConnection) return null;
    const current = options.getCurrentScopedAuthentication
      ? options.getCurrentScopedAuthentication(stored)
      : isScopedSocketAuthenticationUsable(stored)
        ? stored
        : null;
    if (!current || !current.grants.has('task:create')) return null;
    return current;
  }

  function subscribeTaskCreationOperation(
    client: WebSocket,
    message: Extract<AuthenticatedClientMessage, { type: 'subscribe-task-creation-operation' }>,
  ): void {
    const source = options.taskCreationOperations;
    const authentication = getCurrentTaskCreationAuthentication(client);
    const subscriptions = taskCreationOperationSubscriptions.get(client);
    if (!authentication || !subscriptions) return;

    const operationId = message.operationId;
    const sendSubscriptionState = (state: 'degraded' | 'ready'): void => {
      const currentAuthentication = getCurrentTaskCreationAuthentication(client);
      if (
        client.readyState !== WebSocket.OPEN ||
        !currentAuthentication ||
        !hasSameTaskCreationAuthentication(authentication, currentAuthentication)
      ) {
        return;
      }
      options.transport.sendMessage(client, {
        type: 'task-creation-operation-subscription-state',
        operationId,
        state,
      } satisfies ServerMessage);
    };

    if (!source) {
      sendSubscriptionState('degraded');
      return;
    }

    const existing = subscriptions.get(operationId);
    if (existing) {
      if (existing.ready) sendSubscriptionState('ready');
      return;
    }
    if (subscriptions.size >= MAX_TASK_CREATION_OPERATION_SUBSCRIPTIONS_PER_CLIENT) {
      sendSubscriptionState('degraded');
      return;
    }

    const subscription: RemoteTaskCreationOperationSubscription = {
      active: true,
      authentication,
      backendUnsubscribe: null,
      operationId,
      ready: false,
    };
    subscriptions.set(operationId, subscription);

    void source
      .subscribe(
        authentication,
        {
          operationCapability: message.operationCapability,
          operationId,
        },
        (snapshot) => {
          const currentAuthentication = getCurrentTaskCreationAuthentication(client);
          if (
            !subscription.active ||
            taskCreationOperationSubscriptions.get(client)?.get(operationId) !== subscription ||
            client.readyState !== WebSocket.OPEN ||
            !currentAuthentication ||
            !hasSameTaskCreationAuthentication(
              subscription.authentication,
              currentAuthentication,
            ) ||
            snapshot.operationId !== operationId
          ) {
            return;
          }
          options.transport.sendMessage(client, {
            type: 'task-creation-operation-snapshot',
            snapshot,
          } satisfies ServerMessage);
        },
      )
      .then(async (result) => {
        if (result.kind !== 'subscribed') {
          releaseTaskCreationOperationSubscription(client, subscription);
          sendSubscriptionState('degraded');
          return;
        }
        if (
          !subscription.active ||
          taskCreationOperationSubscriptions.get(client)?.get(operationId) !== subscription
        ) {
          await result.unsubscribe().catch(() => undefined);
          return;
        }
        subscription.backendUnsubscribe = result.unsubscribe;
        subscription.ready = true;
        sendSubscriptionState('ready');
      })
      .catch(() => {
        releaseTaskCreationOperationSubscription(client, subscription);
        sendSubscriptionState('degraded');
      });
  }

  function refreshSubscribedTaskCreationOperations(): void {
    const source = options.taskCreationOperations;
    if (!source) return;
    const operationIds = new Set<TaskCreationOperationId>();
    for (const client of options.wss.clients) {
      for (const subscription of taskCreationOperationSubscriptions.get(client)?.values() ?? []) {
        if (!subscription.active) continue;
        operationIds.add(subscription.operationId);
        if (operationIds.size >= MAX_TASK_CREATION_OPERATION_REFRESHES_PER_CATALOG_BATCH) break;
      }
      if (operationIds.size >= MAX_TASK_CREATION_OPERATION_REFRESHES_PER_CATALOG_BATCH) break;
    }
    for (const operationId of operationIds) {
      void source.refreshOperation(operationId).catch(() => undefined);
    }
  }

  function broadcastForGrant(
    grant: 'catalog:read' | 'notes:read' | 'terminal:read',
    message: ServerMessage,
    sequenced = false,
  ): void {
    if (sequenced) {
      // This transport's scoped control stream is terminal-read-only. Access
      // is fixed when the socket authenticates, so the transport can preserve
      // one contiguous sequence and apply the same boundary during replay.
      if (grant === 'terminal:read') options.transport.broadcastControl(message);
      return;
    }
    if (!options.authenticateScopedConnection) {
      options.transport.broadcast(message);
      return;
    }
    for (const client of options.wss.clients) {
      if (hasScopedGrant(client, grant)) options.transport.sendMessage(client, message);
    }
  }

  function broadcastAgentList(): void {
    broadcastForGrant('terminal:read', {
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
    execute: () => Promise<void> | void,
  ): void {
    try {
      const result = execute();
      if (result) {
        void result.catch((error: unknown) => {
          sendAgentError(client, agentId, `${action} failed`, error);
        });
      }
    } catch (error) {
      sendAgentError(client, agentId, `${action} failed`, error);
    }
  }

  function runAgentCommand(
    client: WebSocket,
    agentId: string,
    action: string,
    execute: () => Promise<void> | void,
    requireControl = true,
  ): void {
    if (requireControl && !claimAgentControlOrSendError(client, agentId, action)) {
      return;
    }

    executeAgentCommand(client, agentId, action, execute);
  }

  function runScopedAgentCommand(
    client: WebSocket,
    command: RemoteCommandName,
    message: AuthenticatedClientMessage,
    action: string,
    requireControl = true,
  ): void {
    const gateway = options.remoteCommandGateway;
    const authentication = scopedAuthentication.get(client) ?? null;
    if (!gateway || !authentication) {
      sendAgentError(
        client,
        'agentId' in message ? message.agentId : '',
        `${action} failed`,
        new Error('Secure remote terminal session required'),
      );
      return;
    }
    if (
      requireControl &&
      'agentId' in message &&
      !claimAgentControlOrSendError(client, message.agentId, action)
    ) {
      return;
    }
    void gateway.dispatch(command, authentication, message).then((result) => {
      if (result.ok) return;
      sendAgentError(
        client,
        'agentId' in message ? message.agentId : '',
        `${action} failed`,
        new Error(`Remote terminal is read-only (${result.error.code})`),
      );
    });
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
    broadcastForGrant(
      'terminal:read',
      {
        type: 'ipc-event',
        channel: IPC.TaskCommandControllerChanged,
        payload,
      },
      true,
    );
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
        if (options.remoteCommandGateway) {
          runScopedAgentCommand(client, 'terminal.input', currentMessage, 'write');
          return;
        }
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
        if (options.remoteCommandGateway) {
          runScopedAgentCommand(client, 'terminal.resize', currentMessage, 'resize');
          return;
        }
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
        if (options.remoteCommandGateway) {
          runScopedAgentCommand(client, 'terminal.kill', currentMessage, 'kill');
          return;
        }
        runAgentCommand(client, currentMessage.agentId, 'kill', () =>
          stopTaskAgentWorkflow(currentMessage.agentId),
        );
      },
      pause: (currentMessage) => {
        if (options.remoteCommandGateway) {
          runScopedAgentCommand(
            client,
            'terminal.pause',
            currentMessage,
            'pause',
            shouldRequireAgentControl(currentMessage.reason),
          );
          return;
        }
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
        if (options.remoteCommandGateway) {
          runScopedAgentCommand(
            client,
            'terminal.resume',
            currentMessage,
            'resume',
            shouldRequireAgentControl(currentMessage.reason),
          );
          return;
        }
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
        if (!hasScopedGrant(client, 'terminal:read')) {
          sendAgentError(
            client,
            currentMessage.agentId,
            'subscribe failed',
            new Error('Secure terminal read access is not available'),
          );
          return;
        }
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
      'subscribe-task-creation-operation': (currentMessage) => {
        subscribeTaskCreationOperation(client, currentMessage);
      },
      'unsubscribe-task-creation-operation': (currentMessage) => {
        const subscription = taskCreationOperationSubscriptions
          .get(client)
          ?.get(currentMessage.operationId);
        if (!subscription) return;
        releaseTaskCreationOperationSubscription(client, subscription);
      },
      'bind-channel': () => {},
      'unbind-channel': () => {},
      'permission-response': () => {},
      'request-task-command-takeover': () => {},
      'respond-task-command-takeover': () => {},
      'task-command-lease': (currentMessage) => {
        if (
          options.remoteCommandGateway &&
          scopedAuthentication.get(client)?.grants.has('terminal:control') !== true
        ) {
          options.transport.sendMessage(client, {
            type: 'task-command-lease-result',
            error: 'Secure terminal control is not available',
            operation: currentMessage.operation,
            requestId: currentMessage.requestId,
          });
          return;
        }
        handleTaskCommandLease(client, currentMessage);
      },
      'terminal-input-trace': (currentMessage) => {
        if (
          options.authenticateScopedConnection &&
          scopedAuthentication.get(client)?.grants.has('terminal:control') !== true
        ) {
          return;
        }
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
        if (!hasScopedGrant(client, 'terminal:read')) {
          sendAgentError(
            client,
            currentMessage.agentId,
            'terminal recovery failed',
            new Error('Secure terminal read access is not available'),
          );
          return;
        }
        void runWithTerminalRestorePause(currentMessage.agentId, () => {
          let recovery = getAgentTerminalRecovery(
            currentMessage.agentId,
            decodeTerminalRenderedTail(currentMessage.renderedTail),
            currentMessage.outputCursor,
            currentMessage.snapshotByteLimit,
          );
          if (recovery.kind === 'tail-needed') {
            // The remote protocol has no phase-two tail flow and its payload
            // guard rejects 'tail-needed'; resolve a cursor miss to the
            // capped snapshot here so remote recovery cannot wedge if remote
            // clients ever start sending a snapshotByteLimit.
            recovery = getAgentTerminalRecovery(
              currentMessage.agentId,
              null,
              null,
              currentMessage.snapshotByteLimit,
            );
          }
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
        if (!hasScopedGrant(client, 'terminal:read')) {
          sendAgentError(
            client,
            currentMessage.agentId,
            'terminal startup recovery failed',
            new Error('Secure terminal read access is not available'),
          );
          return;
        }
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
      // Targeted degraded-category retry is a browser control-plane concern;
      // the remote shell replays through its full bootstrap path instead.
      'request-state-bootstrap': () => {},
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
    options.transport.releaseAgentControl(agentId);
    broadcastForGrant(
      'terminal:read',
      {
        type: 'status',
        agentId,
        status: 'exited',
        exitCode: data.exitCode,
      },
      true,
    );

    for (const client of options.wss.clients) {
      const subscriptions = clientSubscriptions.get(client);
      const subscription = subscriptions?.get(agentId);
      if (subscription?.terminalProtocol === 'structured') {
        options.transport.sendMessage(client, {
          type: 'terminal-stream',
          agentId,
          event: {
            type: 'Exit',
            data: createPtyExitData(data),
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

  const unsubscribeTaskCatalog = options.subscribeTaskCatalog?.((batch) => {
    broadcastForGrant('catalog:read', {
      type: 'task-catalog-delta',
      batch,
    } satisfies ServerMessage);
    refreshSubscribedTaskCreationOperations();
  });

  const unsubscribeTaskNotesChanged = options.subscribeTaskNotesChanged?.((payload) => {
    broadcastForGrant('notes:read', {
      type: 'ipc-event',
      channel: IPC.TaskNotesChanged,
      payload,
    } satisfies ServerMessage);
  });

  const unsubscribeScopedAuthenticationInvalidation =
    options.subscribeScopedAuthenticationInvalidation?.(() => {
      for (const client of options.wss.clients) {
        const authentication = scopedAuthentication.get(client);
        if (!authentication) continue;
        const current = options.getCurrentScopedAuthentication?.(authentication) ?? null;
        if (
          !current ||
          !taskCreationAuthenticationTransitionIsSafe(client, authentication, current)
        ) {
          closeScopedClient(client);
        } else {
          scopedAuthentication.set(client, current);
        }
      }
    });

  options.wss.on('connection', (client, req) => {
    enableSocketNoDelay(client);
    clientSubscriptions.set(client, new Map());
    taskCreationOperationSubscriptions.set(client, new Map());
    const clientMessageHandlers = createClientMessageHandlers(client);

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const scoped = options.authenticateScopedConnection?.(req) ?? null;
    if (options.authenticateScopedConnection) {
      if (!isScopedSocketAuthenticationUsable(scoped) || url.searchParams.has('token')) {
        client.close(4001, 'Secure session required');
        return;
      }
      const clientIdValue = url.searchParams.get('clientId');
      const clientId =
        clientIdValue && /^[A-Za-z0-9._:@-]{1,100}$/u.test(clientIdValue)
          ? clientIdValue
          : undefined;
      const lastSeqValue = url.searchParams.get('lastSeq');
      const lastSeq = lastSeqValue === null ? undefined : Number(lastSeqValue);
      const safeLastSeq =
        lastSeq !== undefined && Number.isSafeInteger(lastSeq) && lastSeq >= -1
          ? lastSeq
          : undefined;
      scopedAuthentication.set(client, {
        ...scoped,
        sourceId: clientId ?? scoped.sourceId ?? null,
      });
      const attributedAuthentication = scopedAuthentication.get(client);
      if (!attributedAuthentication) {
        closeScopedClient(client);
        return;
      }
      armScopedAuthenticationExpiry(client, attributedAuthentication);
      if (
        !options.authenticateConnection(client, clientId, safeLastSeq, {
          terminalRead: attributedAuthentication.grants.has('terminal:read'),
        })
      ) {
        cleanupClient(client);
        return;
      }
    } else if (options.safeCompareToken(url.searchParams.get('token'))) {
      if (!options.authenticateConnection(client)) return;
    } else {
      options.transport.scheduleAuthTimeout(client);
    }

    client.on('pong', () => {
      options.transport.notePong(client);
    });

    client.on('message', (raw) => {
      if (options.authenticateScopedConnection) {
        const authentication = scopedAuthentication.get(client);
        const current = authentication
          ? options.refreshScopedAuthentication
            ? options.refreshScopedAuthentication(authentication)
            : isScopedSocketAuthenticationUsable(authentication)
              ? authentication
              : null
          : null;
        if (!authentication || !current) {
          closeScopedClient(client);
          return;
        }
        if (!taskCreationAuthenticationTransitionIsSafe(client, authentication, current)) {
          closeScopedClient(client);
          return;
        }
        scopedAuthentication.set(client, current);
        armScopedAuthenticationExpiry(client, current);
      }
      const message = parseClientMessage(String(raw));
      if (!message) return;

      if (message.type === 'auth') {
        if (options.authenticateScopedConnection) {
          client.close(4001, 'Secure session required');
          return;
        }
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
    unsubscribeTaskCatalog?.();
    unsubscribeTaskNotesChanged?.();
    unsubscribeScopedAuthenticationInvalidation?.();
  }

  return {
    cleanup,
  };
}
