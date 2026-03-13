import type { ClientMessage, ServerMessage } from '../../electron/remote/protocol';
import { dispatchByType, type DispatchByTypeHandlerMap } from './dispatch-by-type';
import { createWebSocketClientCore } from './websocket-client';

export type BrowserServerMessage = Exclude<
  ServerMessage,
  { type: 'channel' } | { type: 'ipc-event' }
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
    };

type BrowserEventListener = (payload: unknown) => void;
type BrowserMessageListener = (message: BrowserServerMessage) => void;
type BrowserTransportListener = (event: BrowserTransportEvent) => void;
type ChannelBoundHandler = (channelId: string) => void;
type ChannelPayloadHandler = (channelId: string, payload: unknown) => void;
type ChannelBinaryHandler = (buffer: ArrayBuffer) => void;
type BrowserConnectionState = Extract<BrowserTransportEvent, { kind: 'connection' }>['state'];
type BrowserServerMessageHandlerMap = DispatchByTypeHandlerMap<ServerMessage>;

export interface BrowserControlClient {
  bindLifecycle: () => void;
  expireSession: () => void;
  emitError: (message: string) => void;
  ensureConnected: () => Promise<WebSocket>;
  isOpen: () => boolean;
  getLastRttMs: () => number | null;
  listenEvent: (channel: string, listener: BrowserEventListener) => () => void;
  listenMessage: <T extends BrowserServerMessageType>(
    type: T,
    listener: BrowserServerMessageListener<T>,
  ) => () => void;
  onAuthenticated: (listener: () => void) => () => void;
  onTransportEvent: (listener: BrowserTransportListener) => () => void;
  send: (message: ClientMessage) => Promise<void>;
  sendIfOpen: (message: ClientMessage) => boolean;
  setAuthExpired: (message: string) => void;
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

function getBrowserSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
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
  const browserTransportListeners = new Set<BrowserTransportListener>();
  const authenticatedListeners = new Set<() => void>();

  let browserSocketLifecycleBound = false;
  let browserConnectionState: BrowserConnectionState = 'disconnected';
  let lastBrowserErrorMessage: string | null = null;
  let lastBrowserErrorAt = 0;
  let hasConfirmedAuthenticatedSession = false;
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
  }

  function setConnectionState(state: BrowserConnectionState): void {
    if (browserConnectionState === state) {
      return;
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
  }

  function emitBrowserMessage(message: BrowserServerMessage): void {
    if (message.type === 'agent-error') {
      emitTransportEvent({
        kind: 'error',
        message: `Agent ${message.agentId}: ${message.message}`,
      });
    }

    browserMessageListeners.get(message.type)?.forEach((listener) => listener(message));
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
    'remote-status': emitBrowserMessage,
    'task-event': emitBrowserMessage,
    'git-status-changed': emitBrowserMessage,
    'task-ports-changed': emitBrowserMessage,
    'permission-request': emitBrowserMessage,
    'agent-error': emitBrowserMessage,
  } satisfies BrowserServerMessageHandlerMap;

  function handleBrowserServerMessage(message: ServerMessage): void {
    confirmAuthenticatedSession();
    dispatchByType(browserServerMessageHandlers, message);
  }

  function shouldKeepSocketAlive(): boolean {
    return (
      browserEventListeners.size > 0 ||
      browserMessageListeners.size > 0 ||
      browserTransportListeners.size > 0 ||
      options.hasChannelBindings()
    );
  }

  const browserSocketClient = createWebSocketClientCore<ServerMessage, ClientMessage>({
    binaryType: 'arraybuffer',
    createPingMessage: () => ({ type: 'ping' }),
    getClientId: options.getClientId,
    getSocketUrl: getBrowserSocketUrl,
    isPongMessage: (message) => message.type === 'pong',
    onAuthExpired: options.onAuthExpired,
    onBinaryMessage: (buffer) => {
      channelHandlers?.onBinaryMessage(buffer);
    },
    onMessage: handleBrowserServerMessage,
    onStateChange: setConnectionState,
    shouldReconnect: shouldKeepSocketAlive,
  });

  function bindLifecycle(): void {
    if (browserSocketLifecycleBound || typeof window === 'undefined') {
      return;
    }

    browserSocketLifecycleBound = true;

    const reconnect = () => {
      if (!shouldKeepSocketAlive()) {
        return;
      }
      if (browserSocketClient.isOpen() || browserSocketClient.hasPendingConnection()) {
        return;
      }

      ignoreErrorAsync(browserSocketClient.ensureConnected());
    };

    window.addEventListener('online', reconnect);
    window.addEventListener('pageshow', reconnect);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        reconnect();
      }
    });
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
  ): () => void {
    const listeners = getOrCreateListenerSet(browserMessageListeners, type);
    const wrapped = (message: BrowserServerMessage) => {
      listener(message as Extract<BrowserServerMessage, { type: T }>);
    };

    listeners.add(wrapped);
    bindLifecycle();
    ignoreErrorAsync(ensureConnected());

    return () => {
      const current = browserMessageListeners.get(type);
      current?.delete(wrapped);
      if (current?.size === 0) {
        browserMessageListeners.delete(type);
      }
    };
  }

  function onTransportEvent(listener: BrowserTransportListener): () => void {
    browserTransportListeners.add(listener);
    bindLifecycle();
    ignoreErrorAsync(ensureConnected());

    return () => {
      browserTransportListeners.delete(listener);
    };
  }

  function onAuthenticated(listener: () => void): () => void {
    authenticatedListeners.add(listener);
    return () => {
      authenticatedListeners.delete(listener);
    };
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
    expireSession: () => browserSocketClient.disconnect('auth-expired'),
    emitError,
    ensureConnected,
    isOpen: browserSocketClient.isOpen,
    getLastRttMs: browserSocketClient.getLastRttMs,
    listenEvent,
    listenMessage,
    onAuthenticated,
    onTransportEvent,
    send,
    sendIfOpen,
    setAuthExpired,
    setChannelHandlers,
  };
}
