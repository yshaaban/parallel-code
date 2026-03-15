export type WebSocketConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'auth-expired';

type ConnectState = Extract<WebSocketConnectionState, 'connecting' | 'reconnecting'>;
type TimerHandle = number | ReturnType<typeof globalThis.setTimeout>;
type IntervalHandle = number | ReturnType<typeof globalThis.setInterval>;
type ConnectionRecord =
  | { kind: 'disconnected' }
  | {
      kind: 'connecting';
      promise: Promise<WebSocket>;
      reject: (error: Error) => void;
      socket: WebSocket;
    }
  | { kind: 'connected'; socket: WebSocket };

function closeSocket(target: WebSocket): void {
  try {
    target.close();
  } catch {
    /* ignore close failures */
  }
}

function scheduleTimeout(callback: () => void, delayMs: number): TimerHandle {
  if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
    return window.setTimeout(callback, delayMs);
  }

  return globalThis.setTimeout(callback, delayMs);
}

function clearTimeoutHandle(handle: TimerHandle | null): void {
  if (!handle) {
    return;
  }

  if (typeof handle === 'number' && typeof window !== 'undefined') {
    window.clearTimeout(handle);
    return;
  }

  globalThis.clearTimeout(handle);
}

function scheduleInterval(callback: () => void, delayMs: number): IntervalHandle {
  if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
    return window.setInterval(callback, delayMs);
  }

  return globalThis.setInterval(callback, delayMs);
}

export interface CreateWebSocketClientCoreOptions<
  IncomingMessage extends { type: string },
  OutgoingMessage,
> {
  createAuthMessage?: (context: {
    clientId: string;
    lastSeq: number;
    token: string;
  }) => OutgoingMessage;
  getClientId: () => string;
  getSocketUrl: () => string;
  getToken?: () => string | null;
  shouldReconnect: () => boolean;
  onMessage: (message: IncomingMessage) => void;
  clearToken?: () => void;
  createPingMessage?: () => OutgoingMessage;
  binaryType?: BinaryType;
  isPongMessage?: (message: IncomingMessage) => boolean;
  onAuthenticated?: (socket: WebSocket) => void;
  onAuthExpired?: (error: Error) => void;
  onMissingToken?: (error: Error) => void;
  onPong?: (rttMs: number | null) => void;
  onStateChange?: (state: WebSocketConnectionState) => void;
  onBinaryMessage?: (buffer: ArrayBuffer) => void | Promise<void>;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  reconnectDelayMs?: (attempt: number) => number;
}

export interface WebSocketClientCore<OutgoingMessage> {
  disconnect: (nextState?: WebSocketConnectionState) => void;
  ensureConnected: (nextState?: ConnectState) => Promise<WebSocket>;
  getLastRttMs: () => number | null;
  getLastSeq: () => number;
  getState: () => WebSocketConnectionState;
  hasPendingConnection: () => boolean;
  isOpen: () => boolean;
  send: (message: OutgoingMessage) => Promise<void>;
  sendIfOpen: (message: OutgoingMessage) => boolean;
}

function clearIntervalHandle(handle: IntervalHandle | null): void {
  if (!handle) {
    return;
  }

  if (typeof handle === 'number' && typeof window !== 'undefined') {
    window.clearInterval(handle);
    return;
  }

  globalThis.clearInterval(handle);
}

function getDefaultReconnectDelay(attempt: number): number {
  return Math.min(200 * Math.pow(2, attempt), 5_000);
}

function getReconnectDelayWithJitter(attempt: number): number {
  const baseDelay = getDefaultReconnectDelay(attempt);
  return Math.floor(baseDelay * (0.8 + Math.random() * 0.4));
}

export function createWebSocketClientCore<
  IncomingMessage extends { type: string },
  OutgoingMessage,
>(
  options: CreateWebSocketClientCoreOptions<IncomingMessage, OutgoingMessage>,
): WebSocketClientCore<OutgoingMessage> {
  let connection: ConnectionRecord = { kind: 'disconnected' };
  let reconnectTimer: TimerHandle | null = null;
  let reconnectAttempts = 0;
  let hasConnected = false;
  let state: WebSocketConnectionState = 'disconnected';
  let lastSeq = -1;
  let lastPingAt = 0;
  let lastRttMs: number | null = null;
  let heartbeatInterval: IntervalHandle | null = null;
  let pongTimeout: TimerHandle | null = null;

  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
  const reconnectDelayMs = options.reconnectDelayMs ?? getReconnectDelayWithJitter;

  function setState(nextState: WebSocketConnectionState): void {
    if (state === nextState) return;
    state = nextState;
    options.onStateChange?.(nextState);
  }

  function clearReconnectTimer(): void {
    clearTimeoutHandle(reconnectTimer);
    reconnectTimer = null;
  }

  function clearPongTimeout(): void {
    clearTimeoutHandle(pongTimeout);
    pongTimeout = null;
  }

  function clearHeartbeat(): void {
    clearIntervalHandle(heartbeatInterval);
    heartbeatInterval = null;
    clearPongTimeout();
  }

  function recordPong(): void {
    clearPongTimeout();
    lastRttMs = lastPingAt > 0 ? Date.now() - lastPingAt : null;
    options.onPong?.(lastRttMs);
  }

  function sendSerializedMessage(target: WebSocket, message: OutgoingMessage): boolean {
    if (target.readyState !== WebSocket.OPEN) return false;

    try {
      target.send(JSON.stringify(message));
      return true;
    } catch {
      closeSocket(target);
      return false;
    }
  }

  function shouldProcessMessage(message: IncomingMessage): boolean {
    const seq = (message as { seq?: unknown }).seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq)) return true;
    if (seq <= lastSeq) return false;
    lastSeq = seq;
    return true;
  }

  function isCurrentConnection(target: WebSocket): boolean {
    return (
      (connection.kind === 'connected' || connection.kind === 'connecting') &&
      connection.socket === target
    );
  }

  function armPongTimeout(target: WebSocket): void {
    if (!options.createPingMessage) return;

    clearPongTimeout();
    pongTimeout = scheduleTimeout(() => {
      pongTimeout = null;
      if (isCurrentConnection(target) && target.readyState === WebSocket.OPEN) {
        setState('disconnected');
        target.close();
      }
    }, pongTimeoutMs);
  }

  function startHeartbeat(target: WebSocket): void {
    const createPingMessage = options.createPingMessage;
    if (!createPingMessage) return;

    clearHeartbeat();
    heartbeatInterval = scheduleInterval(() => {
      if (!isCurrentConnection(target) || target.readyState !== WebSocket.OPEN) return;
      lastPingAt = Date.now();
      if (!sendSerializedMessage(target, createPingMessage())) {
        return;
      }
      armPongTimeout(target);
    }, pingIntervalMs);
  }

  async function handleIncomingMessage(
    event: MessageEvent<string | ArrayBuffer | Blob>,
  ): Promise<void> {
    if (event.data instanceof ArrayBuffer) {
      await options.onBinaryMessage?.(event.data);
      return;
    }

    if (event.data instanceof Blob) {
      await options.onBinaryMessage?.(await event.data.arrayBuffer());
      return;
    }

    if (typeof event.data !== 'string') return;

    let message: IncomingMessage;
    try {
      message = JSON.parse(event.data) as IncomingMessage;
    } catch {
      return;
    }

    if (!shouldProcessMessage(message)) return;
    if (options.isPongMessage?.(message)) {
      recordPong();
    }
    options.onMessage(message);
  }

  function scheduleReconnect(): void {
    if (reconnectTimer || !options.shouldReconnect()) return;

    reconnectTimer = scheduleTimeout(() => {
      reconnectTimer = null;
      if (!options.shouldReconnect()) {
        return;
      }
      reconnectAttempts += 1;
      void ensureConnected('reconnecting').catch(() => {});
    }, reconnectDelayMs(reconnectAttempts));
  }

  function handleAuthExpired(message: string): void {
    const error = new Error(message);
    clearReconnectTimer();
    clearHeartbeat();
    options.clearToken?.();
    setState('auth-expired');
    options.onAuthExpired?.(error);
  }

  async function ensureConnected(nextState?: ConnectState): Promise<WebSocket> {
    if (connection.kind === 'connected' && connection.socket.readyState === WebSocket.OPEN) {
      return connection.socket;
    }
    if (connection.kind === 'connecting') {
      return connection.promise;
    }

    const requiresAuthMessage = options.createAuthMessage !== undefined;
    const token = requiresAuthMessage ? (options.getToken?.() ?? null) : null;
    if (requiresAuthMessage && !token) {
      const error = new Error('Missing auth token');
      options.onMissingToken?.(error);
      throw error;
    }

    setState(nextState ?? (hasConnected ? 'reconnecting' : 'connecting'));

    const ws = new WebSocket(options.getSocketUrl());
    let resolvePromise!: (value: WebSocket) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<WebSocket>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    connection = {
      kind: 'connecting',
      promise,
      reject: rejectPromise,
      socket: ws,
    };

    if (options.binaryType) {
      ws.binaryType = options.binaryType;
    }

    function clearPromiseIfCurrent(): void {
      if (connection.kind === 'connecting' && connection.socket === ws) {
        connection = { kind: 'disconnected' };
      }
    }

    ws.onopen = () => {
      if (!isCurrentConnection(ws)) return;

      if (options.createAuthMessage) {
        const authMessage = options.createAuthMessage({
          clientId: options.getClientId(),
          lastSeq,
          token: token as string,
        });
        if (!sendSerializedMessage(ws, authMessage)) {
          clearPromiseIfCurrent();
          rejectPromise(new Error('WebSocket authentication failed'));
          return;
        }
      }

      connection = {
        kind: 'connected',
        socket: ws,
      };
      hasConnected = true;
      reconnectAttempts = 0;
      clearReconnectTimer();
      options.onAuthenticated?.(ws);
      startHeartbeat(ws);
      setState('connected');
      resolvePromise(ws);
    };

    ws.onmessage = (event) => {
      if (!isCurrentConnection(ws)) return;
      void handleIncomingMessage(event as MessageEvent<string | ArrayBuffer | Blob>);
    };

    ws.onclose = (event) => {
      if (!isCurrentConnection(ws)) return;

      connection = { kind: 'disconnected' };
      clearHeartbeat();
      clearPromiseIfCurrent();

      if (event.code === 4001) {
        handleAuthExpired('Session expired');
        return;
      }

      setState('disconnected');
      if (options.shouldReconnect()) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      if (!isCurrentConnection(ws)) return;

      clearPromiseIfCurrent();
      rejectPromise(new Error('WebSocket connection failed'));
      closeSocket(ws);
    };

    return promise;
  }

  function disconnect(nextState: WebSocketConnectionState = 'disconnected'): void {
    clearReconnectTimer();
    clearHeartbeat();

    let target: WebSocket | null = null;
    if (connection.kind === 'connecting') {
      target = connection.socket;
      connection.reject(new Error('WebSocket connection cancelled'));
      connection = { kind: 'disconnected' };
    } else if (connection.kind === 'connected') {
      target = connection.socket;
      connection = { kind: 'disconnected' };
    }

    if (target) {
      closeSocket(target);
    }

    setState(nextState);
  }

  async function send(message: OutgoingMessage): Promise<void> {
    const target = await ensureConnected();
    if (!sendSerializedMessage(target, message)) {
      throw new Error('WebSocket send failed');
    }
  }

  function sendIfOpen(message: OutgoingMessage): boolean {
    if (connection.kind !== 'connected' || connection.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    return sendSerializedMessage(connection.socket, message);
  }

  function isOpen(): boolean {
    return connection.kind === 'connected' && connection.socket.readyState === WebSocket.OPEN;
  }

  function hasPendingConnection(): boolean {
    return connection.kind === 'connecting';
  }

  function getState(): WebSocketConnectionState {
    return state;
  }

  function getLastSeq(): number {
    return lastSeq;
  }

  function getLastRttMs(): number | null {
    return lastRttMs;
  }

  return {
    disconnect,
    ensureConnected,
    getLastRttMs,
    getLastSeq,
    getState,
    hasPendingConnection,
    isOpen,
    send,
    sendIfOpen,
  };
}
