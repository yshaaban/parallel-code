import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { onPtyEvent } from '../electron/ipc/pty.js';
import {
  isAutomaticPauseReason,
  parseClientMessage,
  parseResyncCategoryVersions,
  type ClientMessage,
  type PauseReason,
  type ServerMessage,
} from '../electron/remote/protocol.js';
import type { BrowserControlResyncRequest } from './browser-control-plane.js';
import type { WebSocketTransport } from '../electron/remote/ws-transport.js';
import type { BrowserChannelManager } from './browser-channels.js';
import {
  hasBrowserTaskControlForMessage,
  resolveBrowserAgentTaskId,
} from './browser-websocket-task-control.js';
import {
  getBrowserAgentTerminalRecoveryEntry,
  getBrowserAgentTerminalStartupRecoveryEntry,
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
import { recordBrowserControlSimulatedDrop } from '../electron/ipc/runtime-diagnostics.js';
import type { TerminalRecoveryBatchEntry } from '../src/ipc/types.js';
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
  authenticateConnection: (
    client: WebSocket,
    clientId?: string,
    lastSeq?: number,
    resync?: BrowserControlResyncRequest,
  ) => boolean;
  sendStateBootstrap: (client: WebSocket, categories: string[]) => void;
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
  getClientMessageDelayMs?: () => number;
  shouldDropClientMessage?: () => boolean;
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
  handleTaskCommandLease: (
    client: WebSocket,
    message: Extract<ClientMessage, { type: 'task-command-lease' }>,
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
  resync?: BrowserControlResyncRequest;
}

const MAX_RESYNC_QUERY_PARAM_LENGTH = 2_048;

function parseSocketResyncRequest(url: URL): BrowserControlResyncRequest | undefined {
  const rawCategoryVersions = url.searchParams.get('categoryVersions');
  if (rawCategoryVersions === null || rawCategoryVersions.length > MAX_RESYNC_QUERY_PARAM_LENGTH) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCategoryVersions);
  } catch {
    return undefined;
  }

  const categoryVersions = parseResyncCategoryVersions(parsed);
  if (categoryVersions === null || categoryVersions === undefined) {
    return undefined;
  }

  const rawAgentsVersion = url.searchParams.get('agentsVersion');
  const agentsVersion =
    rawAgentsVersion !== null && /^\d+$/u.test(rawAgentsVersion)
      ? Number(rawAgentsVersion)
      : undefined;
  const serverInstanceId = url.searchParams.get('serverInstanceId');

  return {
    categoryVersions,
    ...(agentsVersion !== undefined && Number.isSafeInteger(agentsVersion)
      ? { agentsVersion }
      : {}),
    ...(serverInstanceId !== null && serverInstanceId.length <= 64 ? { serverInstanceId } : {}),
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
  const resync = parseSocketResyncRequest(url);

  return {
    ...(clientId ? { clientId } : {}),
    ...(lastSeq !== undefined ? { lastSeq } : {}),
    ...(resync !== undefined ? { resync } : {}),
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

function shouldIgnoreInactiveScopedAutomaticControl(
  channels: BrowserChannelManager,
  reason: PauseReason | undefined,
  channelId: string | undefined,
): boolean {
  return (
    isAutomaticPauseReason(reason) &&
    channelId !== undefined &&
    !channels.hasActiveSubscriber(channelId)
  );
}

function createInputOrderToken(
  message: Extract<AuthenticatedClientMessage, { type: 'input' }>,
): Parameters<typeof writeBrowserAgentInput>[3] {
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
): Parameters<typeof resizeBrowserAgent>[3] {
  if (message.resizeEpoch === undefined || message.resizeSeq === undefined) {
    return undefined;
  }

  return {
    resizeEpoch: message.resizeEpoch,
    resizeSeq: message.resizeSeq,
  };
}

export function registerBrowserWebSocketServer(
  options: RegisterBrowserWebSocketServerOptions,
): BrowserWebSocketServer {
  const pendingClientMessageTimers = new WeakMap<WebSocket, Set<ReturnType<typeof setTimeout>>>();
  const clientMessageDispatchState = new WeakMap<WebSocket, { lastDueAt: number }>();
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
  const unsubscribeExit = onPtyEvent('exit', (agentId, data) => {
    agentOutputSubscriptions.emitExit(
      agentId,
      (data ?? {}) as {
        exitCode?: number | null;
        lastOutput?: string[];
        signal?: unknown;
      },
    );
  });

  function cleanupClient(client: WebSocket): void {
    clearPendingClientMessageTimers(client);
    recordBrowserTerminalInputClientDisconnected(options.transport.getClientId(client));
    options.channels.cleanupClient(client);
    agentOutputSubscriptions.cleanupClient(client);
  }

  function pruneDisconnectedAgentCommandResults(): void {
    agentCommandResults.pruneExpired();
  }

  function cleanup(): void {
    for (const client of options.wss.clients) {
      clearPendingClientMessageTimers(client);
    }
    agentCommandResults.cleanup();
    unsubscribeExit();
  }

  function clearPendingClientMessageTimers(client: WebSocket): void {
    const timers = pendingClientMessageTimers.get(client);
    if (!timers) {
      return;
    }

    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
    pendingClientMessageTimers.delete(client);
    clientMessageDispatchState.delete(client);
  }

  function trackPendingClientMessageTimer(
    client: WebSocket,
    timer: ReturnType<typeof setTimeout>,
  ): void {
    let timers = pendingClientMessageTimers.get(client);
    if (!timers) {
      timers = new Set();
      pendingClientMessageTimers.set(client, timers);
    }
    timers.add(timer);
  }

  function forgetPendingClientMessageTimer(
    client: WebSocket,
    timer: ReturnType<typeof setTimeout>,
  ): void {
    const timers = pendingClientMessageTimers.get(client);
    if (!timers) {
      return;
    }

    timers.delete(timer);
    if (timers.size === 0) {
      pendingClientMessageTimers.delete(client);
    }
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

  function createOrderedAgentCommandCallbacks(
    client: WebSocket,
    request: ReturnType<typeof getAgentCommandRequest>,
    failureReason: string,
    onDropped?: () => void,
  ):
    | {
        onApplied: () => void;
        onDropped: () => void;
      }
    | undefined {
    if (!request) {
      return undefined;
    }

    return {
      onApplied: () => {
        agentCommandRunner.sendCommandResult(client, request, true);
      },
      onDropped: () => {
        onDropped?.();
        agentCommandRunner.sendCommandResult(client, request, false, failureReason);
      },
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

  function sendTerminalRecoveryResult(
    client: WebSocket,
    agentId: string,
    fallbackMessage: string,
    recoveryEntry: Promise<TerminalRecoveryBatchEntry>,
  ): void {
    void recoveryEntry
      .then((entry) => {
        const sent = options.sendMessage(client, {
          type: 'terminal-recovery-result',
          entry,
        });
        if (sent) {
          agentOutputSubscriptions.resume(client, entry.agentId);
        }
      })
      .catch((error) => {
        options.sendAgentError(client, agentId, fallbackMessage, error);
      });
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
        const request = getAgentCommandRequest(currentMessage);
        const inputOrder = createInputOrderToken(currentMessage);
        const orderedCallbacks = createOrderedAgentCommandCallbacks(
          client,
          inputOrder ? request : undefined,
          'terminal input order dropped',
          () => {
            recordBrowserTerminalInputFailure(
              currentMessage.agentId,
              traceRequestId,
              'terminal-input-order-dropped',
            );
          },
        );
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
              inputOrder,
              orderedCallbacks,
            );
          },
          mergeAgentCommandExecutionOptions(
            orderedCallbacks ? { deferSuccessResult: true } : undefined,
            traceRequestId
              ? {
                  onFailure: (reason: string) => {
                    recordBrowserTerminalInputFailure(
                      currentMessage.agentId,
                      traceRequestId,
                      reason,
                    );
                  },
                }
              : undefined,
          ),
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
        const request = getAgentCommandRequest(currentMessage);
        const resizeOrder = createResizeOrderToken(currentMessage);
        const orderedCallbacks = createOrderedAgentCommandCallbacks(
          client,
          resizeOrder ? request : undefined,
          'terminal resize order dropped',
        );
        runTaskControlledAgentCommand(
          client,
          currentMessage,
          'resize',
          () => {
            resizeBrowserAgent(
              currentMessage.agentId,
              currentMessage.cols,
              currentMessage.rows,
              resizeOrder,
              orderedCallbacks,
            );
          },
          orderedCallbacks ? { deferSuccessResult: true } : undefined,
        );
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
            if (
              shouldIgnoreInactiveScopedAutomaticControl(
                options.channels,
                currentMessage.reason,
                currentMessage.channelId,
              )
            ) {
              return;
            }
            pauseBrowserAgent(
              currentMessage.agentId,
              currentMessage.reason,
              currentMessage.channelId,
              currentMessage.restoreLeaseId,
            );
          },
          shouldRequireAgentControl(currentMessage.reason),
          agentCommandRunner.createExecutionOptions(
            getAgentCommandRequest(currentMessage),
            undefined,
          ),
        );
      },
      resume: (currentMessage) => {
        agentCommandRunner.run(
          client,
          currentMessage.agentId,
          'resume',
          () => {
            if (
              shouldIgnoreInactiveScopedAutomaticControl(
                options.channels,
                currentMessage.reason,
                currentMessage.channelId,
              )
            ) {
              return;
            }
            resumeBrowserAgent(
              currentMessage.agentId,
              currentMessage.reason,
              currentMessage.channelId,
              currentMessage.restoreLeaseId,
            );
          },
          shouldRequireAgentControl(currentMessage.reason),
          agentCommandRunner.createExecutionOptions(
            getAgentCommandRequest(currentMessage),
            undefined,
          ),
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
        agentOutputSubscriptions.subscribe(
          client,
          currentMessage.agentId,
          currentMessage.terminalProtocol,
        );
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
      'request-state-bootstrap': (currentMessage) => {
        options.sendStateBootstrap(client, currentMessage.categories);
      },
      'request-task-command-takeover': (currentMessage) => {
        options.requestTaskCommandTakeover(client, currentMessage);
      },
      'respond-task-command-takeover': (currentMessage) => {
        options.respondTaskCommandTakeover(client, currentMessage);
      },
      'task-command-lease': (currentMessage) => {
        options.handleTaskCommandLease(client, currentMessage);
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
      'terminal-recovery-request': (currentMessage) => {
        sendTerminalRecoveryResult(
          client,
          currentMessage.agentId,
          'terminal recovery failed',
          getBrowserAgentTerminalRecoveryEntry(currentMessage),
        );
      },
      'terminal-startup-recovery-request': (currentMessage) => {
        sendTerminalRecoveryResult(
          client,
          currentMessage.agentId,
          'terminal startup recovery failed',
          getBrowserAgentTerminalStartupRecoveryEntry(currentMessage),
        );
      },
    } satisfies BrowserClientMessageHandlerMap;
  }

  function handleParsedClientMessage(client: WebSocket, message: ClientMessage): void {
    if (message.type === 'auth') {
      if (!options.safeCompareToken(message.token)) {
        client.close(4001, 'Unauthorized');
        return;
      }
      options.authenticateConnection(
        client,
        message.clientId,
        message.lastSeq ?? -1,
        message.categoryVersions === undefined
          ? undefined
          : {
              categoryVersions: message.categoryVersions,
              ...(message.agentsVersion !== undefined
                ? { agentsVersion: message.agentsVersion }
                : {}),
              ...(message.serverInstanceId !== undefined
                ? { serverInstanceId: message.serverInstanceId }
                : {}),
            },
      );
      return;
    }

    if (!options.transport.isAuthenticated(client)) {
      client.close(4001, 'Unauthorized');
      return;
    }

    dispatchByType(createClientMessageHandlers(client), message);
  }

  function maybeHandleClientMessage(client: WebSocket, raw: string): void {
    const message = parseClientMessage(raw);
    if (!message) {
      return;
    }

    if (message.type === 'auth' || !options.transport.isAuthenticated(client)) {
      handleParsedClientMessage(client, message);
      return;
    }

    if (options.shouldDropClientMessage?.() === true) {
      recordBrowserControlSimulatedDrop();
      return;
    }

    const delayMs = Math.max(0, options.getClientMessageDelayMs?.() ?? 0);
    const dispatchState = clientMessageDispatchState.get(client);
    const now = Date.now();
    if (delayMs <= 0 && (!dispatchState || dispatchState.lastDueAt <= now)) {
      handleParsedClientMessage(client, message);
      return;
    }

    const nextDispatchState = dispatchState ?? { lastDueAt: 0 };
    const dueAt = Math.max(nextDispatchState.lastDueAt, now + delayMs);
    nextDispatchState.lastDueAt = dueAt;
    clientMessageDispatchState.set(client, nextDispatchState);
    const timer = setTimeout(() => {
      forgetPendingClientMessageTimer(client, timer);
      if (client.readyState !== WebSocket.OPEN) {
        return;
      }
      handleParsedClientMessage(client, message);
    }, dueAt - now);
    trackPendingClientMessageTimer(client, timer);
  }

  options.wss.on('connection', (client, req) => {
    enableSocketNoDelay(client);
    const authContext = parseSocketAuthContext(req);

    if (!options.isAllowedBrowserOrigin(req)) {
      client.close(4001, 'Unauthorized');
      return;
    }

    if (options.isAuthorizedRequest(req)) {
      if (
        !options.authenticateConnection(
          client,
          authContext.clientId,
          authContext.lastSeq,
          authContext.resync,
        )
      ) {
        return;
      }
    } else {
      options.transport.scheduleAuthTimeout(client);
    }

    agentOutputSubscriptions.registerClient(client);

    client.on('pong', () => {
      options.transport.notePong(client);
    });

    client.on('message', (raw) => {
      maybeHandleClientMessage(client, String(raw));
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
