import {
  isReplayTruncatedMessage,
  isCoreServerMessage,
  type ClientMessage,
  type CoreServerMessage,
} from '../../electron/remote/protocol';
import { dispatchByType, type DispatchByTypeHandlerMap } from './dispatch-by-type';
import {
  createWebSocketClientCore,
  type WebSocketDisconnectReason,
  type WebSocketReconnectDelayContext,
} from './websocket-client';
import {
  getWeakConnectivityReconnectDelayMs,
  WAKE_LIVENESS_PROBE,
  WEAK_CONNECTIVITY_CLIENT_HEARTBEAT,
} from './weak-connectivity-policy';

export type BrowserServerMessage = Exclude<
  CoreServerMessage,
  | { type: 'channel' }
  | { type: 'ipc-event' }
  | { type: 'replay-truncated' }
  | { type: 'control-replay-batch' }
>;
export type BrowserServerMessageType = BrowserServerMessage['type'];
export type BrowserServerMessageListener<T extends BrowserServerMessageType> = (
  message: Extract<BrowserServerMessage, { type: T }>,
) => void;

export type BrowserTransportEvent =
  | {
      kind: 'connection';
      state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'auth-expired';
    }
  | {
      kind: 'error';
      message: string;
    }
  | {
      kind: 'metrics';
      payload:
        | {
            connectedDurationMs: number | null;
            reason: WebSocketDisconnectReason;
            type: 'disconnect';
          }
        | {
            attempt: number;
            delayMs: number;
            lastDisconnectReason: WebSocketDisconnectReason | null;
            type: 'reconnect-scheduled';
          }
        | {
            rttMs: number | null;
            type: 'pong';
          }
        | {
            actualSeq: number;
            expectedSeq: number;
            type: 'sequence-gap';
          };
    };

type BrowserEventListener = (payload: unknown) => void;
type BrowserMessageListener = (message: BrowserServerMessage) => void;
type BrowserTransportListener = (event: BrowserTransportEvent) => void;
type ChannelBoundHandler = (channelId: string) => void;
type ChannelPayloadHandler = (channelId: string, payload: unknown) => void;
type ChannelBinaryHandler = (buffer: ArrayBuffer) => void;
interface BrowserControlListenerOptions {
  preserveOnReset?: boolean;
}
export type BrowserControlConnectionState = Extract<
  BrowserTransportEvent,
  { kind: 'connection' }
>['state'];
// 'control-replay-batch' frames are unwrapped inside the websocket client
// core (per-event dispatch with wholesale toSeq adoption), so they never reach
// the dispatch map.
type BrowserServerDispatchMessage = Exclude<
  CoreServerMessage,
  { type: 'replay-truncated' } | { type: 'control-replay-batch' }
>;
type BrowserServerMessageHandlerMap = DispatchByTypeHandlerMap<BrowserServerDispatchMessage>;
type BrowserControlIncomingMessage = CoreServerMessage;

export interface BrowserControlClient {
  bindLifecycle: () => void;
  disconnect: (nextState?: BrowserControlConnectionState) => void;
  expireSession: () => void;
  getBufferedAmount: () => number;
  getConnectionState: () => BrowserControlConnectionState;
  hasReplayTruncatedSinceDisconnect: () => boolean;
  hasSequenceGapSinceDisconnect: () => boolean;
  hasSequencedMessageSinceDisconnect: () => boolean;
  getLastDisconnectDurationMs: () => number | null;
  emitError: (message: string) => void;
  ensureConnected: () => Promise<WebSocket>;
  isAuthenticated: () => boolean;
  isOpen: () => boolean;
  getLastRttMs: () => number | null;
  listenEvent: (channel: string, listener: BrowserEventListener) => () => void;
  listenMessage: <T extends BrowserServerMessageType>(
    type: T,
    listener: BrowserServerMessageListener<T>,
    options?: BrowserControlListenerOptions,
  ) => () => void;
  onAuthenticated: (listener: () => void, options?: BrowserControlListenerOptions) => () => void;
  onTransportEvent: (
    listener: BrowserTransportListener,
    options?: BrowserControlListenerOptions,
  ) => () => void;
  resetForTests: () => void;
  send: (message: ClientMessage) => Promise<void>;
  sendIfOpen: (message: ClientMessage) => boolean;
  setAuthExpired: (message: string) => void;
  setResyncStateProvider: (provider: BrowserResyncStateProvider | null) => void;
  setChannelHandlers: (handlers: {
    onBinaryMessage: ChannelBinaryHandler;
    onChannelBound: ChannelBoundHandler;
    onChannelPayload: ChannelPayloadHandler;
  }) => void;
}

export interface CreateBrowserControlClientOptions {
  getClientId: () => string;
  hasChannelBindings: () => boolean;
  onAuthExpired: (error: Error) => void;
}

export interface BrowserResyncState {
  categoryVersions: Record<string, number>;
}

export type BrowserResyncStateProvider = () => BrowserResyncState | null;

const MAX_RESYNC_CATEGORY_VERSIONS_PARAM_LENGTH = 2_048;

function getBrowserSocketUrl(context: {
  clientId: string;
  lastSeq: number;
  resync: {
    agentsVersion: number | null;
    categoryVersions: Record<string, number>;
    serverInstanceId: string;
  } | null;
}): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${protocol}//${window.location.host}/ws`);
  url.searchParams.set('clientId', context.clientId);
  url.searchParams.set('lastSeq', String(context.lastSeq));
  if (context.resync !== null) {
    const categoryVersionsJson = JSON.stringify(context.resync.categoryVersions);
    if (categoryVersionsJson.length <= MAX_RESYNC_CATEGORY_VERSIONS_PARAM_LENGTH) {
      url.searchParams.set('categoryVersions', categoryVersionsJson);
      url.searchParams.set('serverInstanceId', context.resync.serverInstanceId);
      if (context.resync.agentsVersion !== null) {
        url.searchParams.set('agentsVersion', String(context.resync.agentsVersion));
      }
    }
  }
  return url.toString();
}

function ignoreErrorAsync<T>(promise: Promise<T>): void {
  void promise.catch(() => {});
}

function getOrCreateListenerSet<T>(map: Map<unknown, Set<T>>, key: unknown): Set<T> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

export function createBrowserControlClient(
  options: CreateBrowserControlClientOptions,
): BrowserControlClient {
  const browserEventListeners = new Map<string, Set<BrowserEventListener>>();
  const browserMessageListeners = new Map<BrowserServerMessageType, Set<BrowserMessageListener>>();
  const persistentBrowserMessageListeners = new Map<
    BrowserServerMessageType,
    Set<BrowserMessageListener>
  >();
  const browserTransportListeners = new Set<BrowserTransportListener>();
  const persistentBrowserTransportListeners = new Set<BrowserTransportListener>();
  const authenticatedListeners = new Set<() => void>();
  const persistentAuthenticatedListeners = new Set<() => void>();

  let browserSocketLifecycleBound = false;
  let cleanupBrowserSocketLifecycle: (() => void) | null = null;
  let browserConnectionState: BrowserControlConnectionState = 'disconnected';
  let lastBrowserErrorMessage: string | null = null;
  let lastBrowserErrorAt = 0;
  let activeDisconnectStartedAt: number | null = null;
  let lastDisconnectDurationMs: number | null = null;
  let replayTruncatedSinceDisconnect = false;
  let sequenceGapSinceDisconnect = false;
  let sequencedMessageSinceDisconnect = false;
  let hasConfirmedAuthenticatedSession = false;
  let resyncStateProvider: BrowserResyncStateProvider | null = null;
  // Per-boot category versions and lastSeq are only comparable within one
  // server instance: the id is learned from each state-bootstrap message, and
  // cached versions are only presented back to the same instance.
  let knownServerInstanceId: string | null = null;
  let lastKnownAgentsVersion: number | null = null;
  let documentHiddenAt: number | null = null;
  let channelHandlers: {
    onBinaryMessage: ChannelBinaryHandler;
    onChannelBound: ChannelBoundHandler;
    onChannelPayload: ChannelPayloadHandler;
  } | null = null;

  function emitTransportEvent(event: BrowserTransportEvent): void {
    if (event.kind === 'error') {
      if (event.message === lastBrowserErrorMessage && Date.now() - lastBrowserErrorAt < 3_000) {
        return;
      }
      lastBrowserErrorMessage = event.message;
      lastBrowserErrorAt = Date.now();
    }

    browserTransportListeners.forEach((listener) => listener(event));
    persistentBrowserTransportListeners.forEach((listener) => listener(event));
  }

  function setConnectionState(state: BrowserControlConnectionState): void {
    if (browserConnectionState === state) {
      return;
    }

    if (state === 'connected' && activeDisconnectStartedAt !== null) {
      lastDisconnectDurationMs = Math.max(0, Date.now() - activeDisconnectStartedAt);
      activeDisconnectStartedAt = null;
    }

    if (state !== 'connected') {
      hasConfirmedAuthenticatedSession = false;
    }

    browserConnectionState = state;
    emitTransportEvent({ kind: 'connection', state });
  }

  function confirmAuthenticatedSession(): void {
    if (hasConfirmedAuthenticatedSession) {
      return;
    }

    hasConfirmedAuthenticatedSession = true;
    authenticatedListeners.forEach((listener) => listener());
    persistentAuthenticatedListeners.forEach((listener) => listener());
  }

  function emitBrowserMessage(message: BrowserServerMessage): void {
    if (message.type === 'agent-error') {
      emitTransportEvent({
        kind: 'error',
        message: `Agent ${message.agentId}: ${message.message}`,
      });
    }

    browserMessageListeners.get(message.type)?.forEach((listener) => listener(message));
    persistentBrowserMessageListeners.get(message.type)?.forEach((listener) => listener(message));
  }

  const browserServerMessageHandlers = {
    channel: (message) => {
      channelHandlers?.onChannelPayload(message.channelId, message.payload);
    },
    'ipc-event': (message) => {
      browserEventListeners.get(message.channel)?.forEach((listener) => listener(message.payload));
    },
    'channel-bound': (message) => {
      channelHandlers?.onChannelBound(message.channelId);
    },
    output: emitBrowserMessage,
    status: emitBrowserMessage,
    agents: emitBrowserMessage,
    scrollback: emitBrowserMessage,
    pong: emitBrowserMessage,
    'agent-lifecycle': emitBrowserMessage,
    'agent-controller': emitBrowserMessage,
    'coordinator-event': emitBrowserMessage,
    'remote-status': emitBrowserMessage,
    'peer-presences': emitBrowserMessage,
    'task-event': emitBrowserMessage,
    'git-status-changed': emitBrowserMessage,
    'task-ports-changed': emitBrowserMessage,
    'state-bootstrap': emitBrowserMessage,
    'permission-request': emitBrowserMessage,
    'agent-error': emitBrowserMessage,
    'agent-command-result': emitBrowserMessage,
    'terminal-input-trace-clock-sync': emitBrowserMessage,
    'terminal-recovery-result': emitBrowserMessage,
    'terminal-stream': emitBrowserMessage,
    'task-command-lease-result': emitBrowserMessage,
    'task-command-takeover-request': emitBrowserMessage,
    'task-command-takeover-result': emitBrowserMessage,
  } satisfies BrowserServerMessageHandlerMap;

  function handleBrowserServerMessage(message: BrowserControlIncomingMessage): void {
    if (isReplayTruncatedMessage(message)) {
      replayTruncatedSinceDisconnect = true;
      confirmAuthenticatedSession();
      return;
    }
    if (message.type === 'control-replay-batch') {
      // Unwrapped by the websocket client core; never dispatched whole.
      return;
    }

    if (message.type === 'state-bootstrap' && message.serverInstanceId !== undefined) {
      knownServerInstanceId = message.serverInstanceId;
    }
    if (message.type === 'agents' && message.version !== undefined) {
      lastKnownAgentsVersion = message.version;
    }

    if (isSequencedServerMessage(message)) {
      sequencedMessageSinceDisconnect = true;
    }
    confirmAuthenticatedSession();
    dispatchByType(browserServerMessageHandlers, message);
  }

  function isSequencedServerMessage(message: CoreServerMessage): boolean {
    const seq = (message as { seq?: unknown }).seq;
    return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0;
  }

  function isBrowserControlIncomingMessage(value: unknown): value is BrowserControlIncomingMessage {
    return isCoreServerMessage(value);
  }

  function getDisconnectConnectedDurationMs(event: {
    lastConnectedAt: number | null;
    lastConnectionDurationMs: number | null;
    lastDisconnectedAt: number | null;
  }): number | null {
    if (event.lastConnectionDurationMs !== null) {
      return event.lastConnectionDurationMs;
    }
    if (event.lastConnectedAt === null || event.lastDisconnectedAt === null) {
      return null;
    }
    return Math.max(0, event.lastDisconnectedAt - event.lastConnectedAt);
  }

  function getActiveDisconnectStartedAt(event: {
    hasConnected: boolean;
    lastDisconnectedAt: number | null;
  }): number | null {
    if (!event.hasConnected || event.lastDisconnectedAt === null) {
      return null;
    }
    return event.lastDisconnectedAt;
  }

  function getLastDisconnectDurationMs(): number | null {
    if (activeDisconnectStartedAt === null) {
      return lastDisconnectDurationMs;
    }
    return Math.max(0, Date.now() - activeDisconnectStartedAt);
  }

  function shouldKeepSocketAlive(): boolean {
    return (
      browserEventListeners.size > 0 ||
      browserMessageListeners.size > 0 ||
      persistentBrowserMessageListeners.size > 0 ||
      browserTransportListeners.size > 0 ||
      persistentBrowserTransportListeners.size > 0 ||
      authenticatedListeners.size > 0 ||
      persistentAuthenticatedListeners.size > 0 ||
      options.hasChannelBindings()
    );
  }

  const browserSocketClient = createWebSocketClientCore<
    BrowserControlIncomingMessage,
    ClientMessage
  >({
    binaryType: 'arraybuffer',
    createPingMessage: () => ({ type: 'ping' }),
    getClientId: options.getClientId,
    getSocketUrl: ({ clientId, lastSeq }) => {
      const resyncState = knownServerInstanceId === null ? null : (resyncStateProvider?.() ?? null);
      return getBrowserSocketUrl({
        clientId,
        lastSeq,
        resync:
          resyncState === null || knownServerInstanceId === null
            ? null
            : {
                agentsVersion: lastKnownAgentsVersion,
                categoryVersions: resyncState.categoryVersions,
                serverInstanceId: knownServerInstanceId,
              },
      });
    },
    isPongMessage: (message) => message.type === 'pong',
    isIncomingMessage: isBrowserControlIncomingMessage,
    onAuthExpired: options.onAuthExpired,
    onBinaryMessage: (buffer) => {
      channelHandlers?.onBinaryMessage(buffer);
    },
    onDisconnect: (event) => {
      activeDisconnectStartedAt = getActiveDisconnectStartedAt(event);
      lastDisconnectDurationMs = null;
      replayTruncatedSinceDisconnect = false;
      sequenceGapSinceDisconnect = false;
      sequencedMessageSinceDisconnect = false;
      emitTransportEvent({
        kind: 'metrics',
        payload: {
          connectedDurationMs: getDisconnectConnectedDurationMs(event),
          reason: event.reason,
          type: 'disconnect',
        },
      });
    },
    onMessage: handleBrowserServerMessage,
    onReplayBatch: () => {
      // The batch frame is the sequenced replay confirmation even when it
      // carries zero events (nothing missed during the blip).
      sequencedMessageSinceDisconnect = true;
    },
    onPong: (rttMs) => {
      emitTransportEvent({
        kind: 'metrics',
        payload: {
          rttMs,
          type: 'pong',
        },
      });
    },
    onReconnectScheduled: (event) => {
      emitTransportEvent({
        kind: 'metrics',
        payload: {
          attempt: event.attempt,
          delayMs: event.delayMs,
          lastDisconnectReason: event.lastDisconnectReason,
          type: 'reconnect-scheduled',
        },
      });
    },
    onSequenceGap: (event) => {
      sequenceGapSinceDisconnect = true;
      sequencedMessageSinceDisconnect = true;
      emitTransportEvent({
        kind: 'metrics',
        payload: {
          actualSeq: event.actualSeq,
          expectedSeq: event.expectedSeq,
          type: 'sequence-gap',
        },
      });
    },
    onStateChange: setConnectionState,
    pingIntervalMs: WEAK_CONNECTIVITY_CLIENT_HEARTBEAT.pingIntervalMs,
    pongTimeoutMs: WEAK_CONNECTIVITY_CLIENT_HEARTBEAT.pongTimeoutMs,
    maxMissedPongs: WEAK_CONNECTIVITY_CLIENT_HEARTBEAT.maxMissedPongs,
    reconnectDelayMs: (attempt: number, context: WebSocketReconnectDelayContext): number =>
      getWeakConnectivityReconnectDelayMs(attempt, context),
    shouldReconnect: shouldKeepSocketAlive,
  });

  function bindLifecycle(): void {
    if (browserSocketLifecycleBound || typeof window === 'undefined') {
      return;
    }

    browserSocketLifecycleBound = true;

    const handleWakeEvent = (eventKind: 'online' | 'pageshow' | 'visible') => {
      if (!shouldKeepSocketAlive()) {
        return;
      }

      if (browserSocketClient.isOpen()) {
        // After a sleep/wake the dead TCP socket can still report OPEN and
        // silently swallow input. Probe it with a short deadline instead of
        // trusting it; a miss force-closes and the fast-reconnect table
        // takes over.
        const hiddenGapMs = documentHiddenAt === null ? null : Date.now() - documentHiddenAt;
        if (
          eventKind === 'online' ||
          (hiddenGapMs !== null && hiddenGapMs > WAKE_LIVENESS_PROBE.minHiddenGapMs)
        ) {
          browserSocketClient.probeLiveness(WAKE_LIVENESS_PROBE.probeDeadlineMs);
        }
        return;
      }

      if (browserSocketClient.hasPendingConnection()) {
        return;
      }

      ignoreErrorAsync(browserSocketClient.ensureConnected());
    };

    const handleOnline = () => handleWakeEvent('online');
    const handlePageShow = () => handleWakeEvent('pageshow');
    window.addEventListener('online', handleOnline);
    window.addEventListener('pageshow', handlePageShow);
    const handleVisibilityChange = () => {
      if (document.hidden) {
        documentHiddenAt = Date.now();
        return;
      }

      handleWakeEvent('visible');
      documentHiddenAt = null;
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    cleanupBrowserSocketLifecycle = () => {
      window.removeEventListener?.('online', handleOnline);
      window.removeEventListener?.('pageshow', handlePageShow);
      document.removeEventListener?.('visibilitychange', handleVisibilityChange);
    };
  }

  function emitError(message: string): void {
    emitTransportEvent({
      kind: 'error',
      message,
    });
  }

  function setAuthExpired(message: string): void {
    setConnectionState('auth-expired');
    emitError(message);
  }

  function ensureConnected(): Promise<WebSocket> {
    bindLifecycle();
    return browserSocketClient.ensureConnected();
  }

  function send(message: ClientMessage): Promise<void> {
    return browserSocketClient.send(message);
  }

  function sendIfOpen(message: ClientMessage): boolean {
    return browserSocketClient.sendIfOpen(message);
  }

  function listenEvent(channel: string, listener: BrowserEventListener): () => void {
    const listeners = getOrCreateListenerSet(browserEventListeners, channel);
    listeners.add(listener);
    bindLifecycle();
    ignoreErrorAsync(ensureConnected());

    return () => {
      const current = browserEventListeners.get(channel);
      current?.delete(listener);
      if (current?.size === 0) {
        browserEventListeners.delete(channel);
      }
    };
  }

  function listenMessage<T extends BrowserServerMessageType>(
    type: T,
    listener: BrowserServerMessageListener<T>,
    listenerOptions: BrowserControlListenerOptions = {},
  ): () => void {
    const listenerMap = listenerOptions.preserveOnReset
      ? persistentBrowserMessageListeners
      : browserMessageListeners;
    const listeners = getOrCreateListenerSet(listenerMap, type);
    const wrapped = (message: BrowserServerMessage) => {
      listener(message as Extract<BrowserServerMessage, { type: T }>);
    };

    listeners.add(wrapped);
    bindLifecycle();
    ignoreErrorAsync(ensureConnected());

    return () => {
      const current = listenerMap.get(type);
      current?.delete(wrapped);
      if (current?.size === 0) {
        listenerMap.delete(type);
      }
    };
  }

  function onTransportEvent(
    listener: BrowserTransportListener,
    listenerOptions: BrowserControlListenerOptions = {},
  ): () => void {
    const listeners = listenerOptions.preserveOnReset
      ? persistentBrowserTransportListeners
      : browserTransportListeners;
    listeners.add(listener);
    bindLifecycle();
    ignoreErrorAsync(ensureConnected());

    return () => {
      listeners.delete(listener);
    };
  }

  function onAuthenticated(
    listener: () => void,
    listenerOptions: BrowserControlListenerOptions = {},
  ): () => void {
    const listeners = listenerOptions.preserveOnReset
      ? persistentAuthenticatedListeners
      : authenticatedListeners;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function resetForTests(): void {
    browserEventListeners.clear();
    browserMessageListeners.clear();
    browserTransportListeners.clear();
    authenticatedListeners.clear();
    hasConfirmedAuthenticatedSession = false;
    lastBrowserErrorMessage = null;
    lastBrowserErrorAt = 0;
    cleanupBrowserSocketLifecycle?.();
    cleanupBrowserSocketLifecycle = null;
    browserSocketLifecycleBound = false;
    browserSocketClient.resetForTests();
    activeDisconnectStartedAt = null;
    lastDisconnectDurationMs = null;
    replayTruncatedSinceDisconnect = false;
    sequenceGapSinceDisconnect = false;
    sequencedMessageSinceDisconnect = false;
    resyncStateProvider = null;
    knownServerInstanceId = null;
    lastKnownAgentsVersion = null;
    documentHiddenAt = null;
  }

  function setChannelHandlers(handlers: {
    onBinaryMessage: ChannelBinaryHandler;
    onChannelBound: ChannelBoundHandler;
    onChannelPayload: ChannelPayloadHandler;
  }): void {
    channelHandlers = handlers;
  }

  return {
    bindLifecycle,
    disconnect: browserSocketClient.disconnect,
    expireSession: () => browserSocketClient.disconnect('auth-expired'),
    getBufferedAmount: browserSocketClient.getBufferedAmount,
    getConnectionState: () => browserConnectionState,
    hasReplayTruncatedSinceDisconnect: () => replayTruncatedSinceDisconnect,
    hasSequenceGapSinceDisconnect: () => sequenceGapSinceDisconnect,
    hasSequencedMessageSinceDisconnect: () => sequencedMessageSinceDisconnect,
    getLastDisconnectDurationMs,
    isAuthenticated: () => hasConfirmedAuthenticatedSession,
    emitError,
    ensureConnected,
    isOpen: browserSocketClient.isOpen,
    getLastRttMs: browserSocketClient.getLastRttMs,
    listenEvent,
    listenMessage,
    onAuthenticated,
    onTransportEvent,
    resetForTests,
    send,
    sendIfOpen,
    setAuthExpired,
    setResyncStateProvider: (provider) => {
      resyncStateProvider = provider;
    },
    setChannelHandlers,
  };
}
