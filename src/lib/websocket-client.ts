export type WebSocketConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'auth-expired';

type ConnectState = Extract<WebSocketConnectionState, 'connecting' | 'reconnecting'>;
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
type IntervalHandle = ReturnType<typeof globalThis.setInterval>;

function scheduleTimeout(callback: () => void, delayMs: number): TimerHandle {
  if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
    return window.setTimeout(callback, delayMs) as unknown as TimerHandle;
  }
  return globalThis.setTimeout(callback, delayMs);
}

function clearTimeoutHandle(handle: TimerHandle | null): void {
  if (!handle) return;
  if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') {
    window.clearTimeout(handle as unknown as number);
    return;
  }
  globalThis.clearTimeout(handle);
}

function scheduleInterval(callback: () => void, delayMs: number): IntervalHandle {
  if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
    return window.setInterval(callback, delayMs) as unknown as IntervalHandle;
  }
  return globalThis.setInterval(callback, delayMs);
}

export interface CreateWebSocketClientCoreOptions<
  IncomingMessage extends { type: string },
  OutgoingMessage,
> {
  createAuthMessage: (context: {
    clientId: string;
    lastSeq: number;
    token: string;
  }) => OutgoingMessage;
  getClientId: () => string;
  getSocketUrl: () => string;
  getToken: () => string | null;
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
  disconnect: () => void;
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
  if (!handle) return;
  if (typeof window !== 'undefined' && typeof window.clearInterval === 'function') {
    window.clearInterval(handle as unknown as number);
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
  let socket: WebSocket | null = null;
  let connectingSocket: WebSocket | null = null;
  let socketPromise: Promise<WebSocket> | null = null;
  let reconnectTimer: TimerHandle | null = null;
  let reconnectAttempts = 0;
  let hasConnected = false;
  let state: WebSocketConnectionState = 'disconnected';
  let lastSeq = -1;
  let lastPingAt = 0;
  let lastRttMs: number | null = null;
  let heartbeatInterval: IntervalHandle | null = null;
  let pongTimeout: TimerHandle | null = null;
  let manualDisconnect = false;

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
      try {
        target.close();
      } catch {
        /* ignore close failures after send errors */
      }
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

  function armPongTimeout(target: WebSocket): void {
    if (!options.createPingMessage) return;

    clearPongTimeout();
    pongTimeout = scheduleTimeout(() => {
      pongTimeout = null;
      if (socket === target && target.readyState === WebSocket.OPEN) {
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
      if (socket !== target || target.readyState !== WebSocket.OPEN) return;
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
    if (socket?.readyState === WebSocket.OPEN) return socket;
    if (socketPromise) return socketPromise;

    const token = options.getToken();
    if (!token) {
      const error = new Error('Missing auth token');
      options.onMissingToken?.(error);
      throw error;
    }

    setState(nextState ?? (hasConnected ? 'reconnecting' : 'connecting'));

    socketPromise = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(options.getSocketUrl());
      connectingSocket = ws;

      if (options.binaryType) {
        ws.binaryType = options.binaryType;
      }

      function clearPromiseIfCurrent(): void {
        if (socketPromise) {
          socketPromise = null;
        }
      }

      ws.onopen = () => {
        connectingSocket = null;
        socket = ws;
        hasConnected = true;
        reconnectAttempts = 0;
        clearReconnectTimer();

        const authMessage = options.createAuthMessage({
          clientId: options.getClientId(),
          lastSeq,
          token,
        });
        if (!sendSerializedMessage(ws, authMessage)) {
          clearPromiseIfCurrent();
          reject(new Error('WebSocket authentication failed'));
          return;
        }

        options.onAuthenticated?.(ws);
        startHeartbeat(ws);
        setState('connected');
        clearPromiseIfCurrent();
        resolve(ws);
      };

      ws.onmessage = (event) => {
        void handleIncomingMessage(event as MessageEvent<string | ArrayBuffer | Blob>);
      };

      ws.onclose = (event) => {
        if (socket === ws) {
          socket = null;
        }
        if (connectingSocket === ws) {
          connectingSocket = null;
        }
        clearHeartbeat();
        clearPromiseIfCurrent();

        const shouldReconnectAfterClose = !manualDisconnect && options.shouldReconnect();
        manualDisconnect = false;

        if (event.code === 4001) {
          handleAuthExpired('Session expired');
          return;
        }

        setState('disconnected');
        if (shouldReconnectAfterClose) {
          scheduleReconnect();
        }
      };

      ws.onerror = () => {
        clearPromiseIfCurrent();
        reject(new Error('WebSocket connection failed'));
        try {
          ws.close();
        } catch {
          /* ignore close failures after connection errors */
        }
      };
    });

    return socketPromise;
  }

  function disconnect(): void {
    manualDisconnect = true;
    clearReconnectTimer();
    clearHeartbeat();

    const target = socket ?? connectingSocket;
    if (target) {
      try {
        target.close();
      } catch {
        /* ignore close failures during manual disconnect */
      }
    } else {
      manualDisconnect = false;
    }

    setState('disconnected');
  }

  async function send(message: OutgoingMessage): Promise<void> {
    const target = await ensureConnected();
    if (!sendSerializedMessage(target, message)) {
      throw new Error('WebSocket send failed');
    }
  }

  function sendIfOpen(message: OutgoingMessage): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    return sendSerializedMessage(socket, message);
  }

  function isOpen(): boolean {
    return socket?.readyState === WebSocket.OPEN;
  }

  function hasPendingConnection(): boolean {
    return socketPromise !== null;
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
