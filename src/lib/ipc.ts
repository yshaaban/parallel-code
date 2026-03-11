import { IPC } from '../../electron/ipc/channels';
import type { ClientMessage, PauseReason, ServerMessage } from '../../electron/remote/protocol';

const TOKEN_KEY = 'parallel-code-token';
const CLIENT_ID_KEY = 'parallel-code-client-id';

type BrowserEventListener = (payload: unknown) => void;
type BrowserServerMessage = Exclude<ServerMessage, { type: 'channel' } | { type: 'ipc-event' }>;
type BrowserServerMessageType = BrowserServerMessage['type'];
type BrowserServerMessageListener<T extends BrowserServerMessageType> = (
  message: Extract<BrowserServerMessage, { type: T }>,
) => void;

interface PendingRequest {
  cmd: IPC;
  args?: unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  retries: number;
  durable?: boolean;
}

function getPauseReason(value: unknown): PauseReason | undefined {
  if (value === undefined) return undefined;
  if (VALID_PAUSE_REASONS.has(value as PauseReason)) return value as PauseReason;
  throw new Error(
    `Invalid pause reason: ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`,
  );
}

export type BrowserTransportEvent =
  | {
      kind: 'connection';
      state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'auth-expired';
    }
  | {
      kind: 'error';
      message: string;
    };

type BrowserTransportListener = (event: BrowserTransportEvent) => void;

declare global {
  interface Window {
    electron?: {
      ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
        on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
        removeAllListeners: (channel: string) => void;
      };
    };
  }
}

const browserChannelListeners = new Map<string, (msg: unknown) => void>();
const browserChannelReadyResolvers = new Map<
  string,
  { resolve: () => void; reject: (reason?: unknown) => void }
>();
const browserEventListeners = new Map<string, Set<BrowserEventListener>>();
const browserMessageListeners = new Map<
  BrowserServerMessageType,
  Set<(msg: BrowserServerMessage) => void>
>();
const browserTransportListeners = new Set<BrowserTransportListener>();
const boundChannelIds = new Set<string>();
const CHANNEL_DATA_FRAME_TYPE = 0x01;
const CHANNEL_ID_BYTES = 36;
const CHANNEL_BINARY_HEADER_BYTES = 1 + CHANNEL_ID_BYTES;
const CHANNEL_ID_DECODER = new TextDecoder();
const UUID_CHANNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RETRIES = 3;
const MAX_QUEUE_DEPTH = 20;
const PENDING_REQUEST_RETRY_BASE_MS = 250;
const PENDING_REQUEST_RETRY_MAX_MS = 2_000;
const BROWSER_PING_INTERVAL_MS = 30_000;
const BROWSER_PONG_TIMEOUT_MS = 10_000;
const DEDUPED_PENDING_REQUESTS = new Set<IPC>([IPC.SaveAppState, IPC.LoadAppState]);
const VALID_PAUSE_REASONS = new Set<PauseReason>(['manual', 'flow-control', 'restore']);
const BROWSER_UNREACHABLE_MESSAGE = 'Unable to reach the Parallel Code server.';
const DURABLE_QUEUE_KEY = 'ipc-durable-queue';

let browserSocket: WebSocket | null = null;
let browserSocketPromise: Promise<WebSocket> | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempts = 0;
let browserTokenInitialized = false;
let browserSocketLifecycleBound = false;
let hasBrowserSocketConnected = false;
let browserConnectionState: Extract<BrowserTransportEvent, { kind: 'connection' }>['state'] =
  'disconnected';
let lastServerSeq = -1;
let lastBrowserErrorMessage: string | null = null;
let lastBrowserErrorAt = 0;
let browserPingInterval: number | null = null;
let browserPongTimeout: number | null = null;
let lastBrowserPingAt = 0;
let lastBrowserRttMs: number | null = null;
const pendingRequestQueue: PendingRequest[] = [];
let drainingPendingRequestQueue = false;
let pendingRequestDrainTimer: number | null = null;

class QueueableBrowserFetchError extends Error {
  originalError: unknown;

  constructor(message: string, originalError: unknown) {
    super(message);
    this.name = 'QueueableBrowserFetchError';
    this.originalError = originalError;
  }
}

function initBrowserToken(): void {
  if (browserTokenInitialized || typeof window === 'undefined') return;
  browserTokenInitialized = true;

  const url = new URL(window.location.href);
  const urlToken = url.searchParams.get('token');
  if (urlToken) {
    localStorage.setItem(TOKEN_KEY, urlToken);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.pathname + url.search);
  }
}

function getBrowserToken(): string | null {
  initBrowserToken();
  return localStorage.getItem(TOKEN_KEY);
}

function clearBrowserToken(): void {
  if (typeof window !== 'undefined') localStorage.removeItem(TOKEN_KEY);
}

function clearDurableQueueStorage(): void {
  if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return;
  sessionStorage.removeItem(DURABLE_QUEUE_KEY);
}

function getBrowserClientStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  if (typeof sessionStorage !== 'undefined') return sessionStorage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

export function getBrowserClientId(): string {
  const storage = getBrowserClientStorage();
  if (!storage) return 'server';
  const existing = storage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const clientId = crypto.randomUUID();
  storage.setItem(CLIENT_ID_KEY, clientId);
  return clientId;
}

function isDurablePendingRequest(cmd: IPC, args: unknown): boolean {
  if (cmd === IPC.KillAgent) return true;
  if (cmd !== IPC.PauseAgent && cmd !== IPC.ResumeAgent) return false;
  const reason = (args as { reason?: unknown } | undefined)?.reason;
  return reason === undefined || reason === 'manual';
}

function shouldProcessBrowserMessage(message: ServerMessage): boolean {
  const seq = (message as { seq?: unknown }).seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq)) return true;
  if (seq <= lastServerSeq) return false;
  lastServerSeq = seq;
  return true;
}

function saveDurableQueue(): void {
  if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return;
  const durableRequests = pendingRequestQueue
    .filter((r) => r.durable)
    .map((r) => ({
      cmd: r.cmd,
      args: r.args,
      retries: 0, // Reset retries on restore
    }));
  if (durableRequests.length > 0) {
    sessionStorage.setItem(DURABLE_QUEUE_KEY, JSON.stringify(durableRequests));
  } else {
    sessionStorage.removeItem(DURABLE_QUEUE_KEY);
  }
}

function loadDurableQueue(): void {
  if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return;
  const stored = sessionStorage.getItem(DURABLE_QUEUE_KEY);
  if (!stored) return;
  try {
    const durableRequests = JSON.parse(stored) as Array<{
      cmd: IPC;
      args?: unknown;
      retries: number;
    }>;
    for (const req of durableRequests) {
      enqueuePendingRequest({
        cmd: req.cmd,
        args: req.args,
        retries: req.retries,
        resolve: () => {},
        reject: () => {},
        durable: true,
      });
    }
    sessionStorage.removeItem(DURABLE_QUEUE_KEY);
  } catch {
    // Malformed stored data — ignore
    sessionStorage.removeItem(DURABLE_QUEUE_KEY);
  }
}

export function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && typeof window.electron?.ipcRenderer !== 'undefined';
}

function isBrowserSocketOpen(): boolean {
  return browserSocket?.readyState === WebSocket.OPEN;
}

function ignoreErrorAsync<T>(promise: Promise<T>): void {
  void promise.catch(() => {});
}

function markBrowserUnreachable(): void {
  setBrowserConnectionState('disconnected');
  emitBrowserTransportEvent({
    kind: 'error',
    message: BROWSER_UNREACHABLE_MESSAGE,
  });
}

function handleBrowserAuthExpired(
  error: Error,
  options: {
    clearToken?: boolean;
    rejectPending: 'all' | 'queue';
    message: string;
  },
): void {
  if (options.clearToken) {
    clearBrowserToken();
  }
  clearDurableQueueStorage();

  if (options.rejectPending === 'all') {
    rejectAllPending(error);
  } else {
    rejectPendingRequestQueue(error);
  }

  setBrowserConnectionState('auth-expired');
  emitBrowserTransportEvent({
    kind: 'error',
    message: options.message,
  });
}

function setBrowserInterval(callback: () => void, delayMs: number): number {
  if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
    return window.setInterval(callback, delayMs);
  }
  return globalThis.setInterval(callback, delayMs) as unknown as number;
}

function clearBrowserInterval(timerId: number): void {
  if (typeof window !== 'undefined' && typeof window.clearInterval === 'function') {
    window.clearInterval(timerId);
    return;
  }
  globalThis.clearInterval(timerId);
}

function clearBrowserPongTimeout(): void {
  if (browserPongTimeout === null || typeof window === 'undefined') return;
  window.clearTimeout(browserPongTimeout);
  browserPongTimeout = null;
}

function clearBrowserHeartbeat(): void {
  if (browserPingInterval !== null) {
    clearBrowserInterval(browserPingInterval);
    browserPingInterval = null;
  }
  clearBrowserPongTimeout();
}

function armBrowserPongTimeout(ws: WebSocket): void {
  if (typeof window === 'undefined') return;
  clearBrowserPongTimeout();
  browserPongTimeout = window.setTimeout(() => {
    browserPongTimeout = null;
    if (browserSocket === ws && ws.readyState === WebSocket.OPEN) {
      setBrowserConnectionState('disconnected');
      ws.close();
    }
  }, BROWSER_PONG_TIMEOUT_MS);
}

function startBrowserHeartbeat(ws: WebSocket): void {
  if (typeof window === 'undefined') return;
  clearBrowserHeartbeat();
  browserPingInterval = setBrowserInterval(() => {
    if (browserSocket !== ws || ws.readyState !== WebSocket.OPEN) return;
    lastBrowserPingAt = Date.now();
    ws.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage));
    armBrowserPongTimeout(ws);
  }, BROWSER_PING_INTERVAL_MS);
}

function shouldKeepBrowserSocketAlive(): boolean {
  return (
    boundChannelIds.size > 0 ||
    browserEventListeners.size > 0 ||
    browserMessageListeners.size > 0 ||
    browserTransportListeners.size > 0 ||
    pendingRequestQueue.length > 0
  );
}

function emitBrowserTransportEvent(event: BrowserTransportEvent): void {
  // Skip duplicate error messages within 3 second window
  if (event.kind === 'error') {
    if (event.message === lastBrowserErrorMessage && Date.now() - lastBrowserErrorAt < 3_000) {
      return;
    }
    lastBrowserErrorMessage = event.message;
    lastBrowserErrorAt = Date.now();
  }

  browserTransportListeners.forEach((listener) => listener(event));
}

function setBrowserConnectionState(
  state: Extract<BrowserTransportEvent, { kind: 'connection' }>['state'],
): void {
  if (browserConnectionState === state) return;
  browserConnectionState = state;
  emitBrowserTransportEvent({ kind: 'connection', state });
}

function emitBrowserMessage(message: BrowserServerMessage): void {
  if (message.type === 'pong') {
    clearBrowserPongTimeout();
    lastBrowserRttMs = lastBrowserPingAt > 0 ? Date.now() - lastBrowserPingAt : null;
  }
  if (message.type === 'agent-error') {
    emitBrowserTransportEvent({
      kind: 'error',
      message: `Agent ${message.agentId}: ${message.message}`,
    });
  }

  browserMessageListeners.get(message.type)?.forEach((listener) => listener(message));
}

function rejectPendingChannelReady(error: unknown): void {
  browserChannelReadyResolvers.forEach(({ reject }) => reject(error));
  browserChannelReadyResolvers.clear();
}

function rejectPendingRequestQueue(error: unknown): void {
  pendingRequestQueue.splice(0).forEach((request) => request.reject(error));
  saveDurableQueue();
}

function rejectAllPending(error: unknown): void {
  rejectPendingChannelReady(error);
  rejectPendingRequestQueue(error);
}

function getOrCreateListenerSet<T>(map: Map<unknown, Set<T>>, key: unknown): Set<T> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

function mergePendingRequest(existing: PendingRequest, next: PendingRequest): void {
  const previousResolve = existing.resolve;
  const previousReject = existing.reject;

  existing.args = next.args;
  existing.retries = next.retries;
  existing.resolve = (value) => {
    previousResolve(value);
    next.resolve(value);
  };
  existing.reject = (reason) => {
    previousReject(reason);
    next.reject(reason);
  };
  existing.durable = existing.durable || next.durable;
}

function enqueuePendingRequest(request: PendingRequest): void {
  // Try to merge duplicate requests (last-write-wins semantics)
  if (DEDUPED_PENDING_REQUESTS.has(request.cmd)) {
    // Search from end of queue for most recent duplicate
    for (let i = pendingRequestQueue.length - 1; i >= 0; i -= 1) {
      const existing = pendingRequestQueue[i];
      if (existing?.cmd === request.cmd) {
        mergePendingRequest(existing, request);
        return;
      }
    }
  }

  if (
    pendingRequestQueue.length >= MAX_QUEUE_DEPTH &&
    !request.durable &&
    pendingRequestQueue.every((queued) => queued.durable)
  ) {
    request.reject(new Error('IPC request queue overflowed while reconnecting.'));
    return;
  }

  // Queue new request and reject the oldest non-durable request first.
  pendingRequestQueue.push(request);
  while (pendingRequestQueue.length > MAX_QUEUE_DEPTH) {
    const overflowIndex = pendingRequestQueue.findIndex((queued) => !queued.durable);
    const overflow =
      overflowIndex >= 0
        ? pendingRequestQueue.splice(overflowIndex, 1)[0]
        : pendingRequestQueue.shift();
    overflow?.reject(new Error('IPC request queue overflowed while reconnecting.'));
  }
}

function getPendingRequestRetryDelay(retries: number): number {
  return Math.min(
    PENDING_REQUEST_RETRY_BASE_MS * Math.pow(2, Math.max(0, retries - 1)),
    PENDING_REQUEST_RETRY_MAX_MS,
  );
}

function schedulePendingRequestQueueDrain(delayMs = 0): void {
  if (pendingRequestDrainTimer !== null || typeof window === 'undefined') return;
  if (pendingRequestQueue.length === 0) return;

  pendingRequestDrainTimer = window.setTimeout(() => {
    pendingRequestDrainTimer = null;
    void drainPendingRequestQueue();
  }, delayMs);
}

function bindBrowserSocketLifecycle(): void {
  if (browserSocketLifecycleBound || typeof window === 'undefined' || isElectronRuntime()) return;
  browserSocketLifecycleBound = true;

  const reconnect = () => {
    if (!shouldKeepBrowserSocketAlive()) return;
    if (isBrowserSocketOpen() || browserSocketPromise) return;
    schedulePendingRequestQueueDrain();
    ignoreErrorAsync(ensureBrowserSocket());
  };

  window.addEventListener('online', reconnect);
  window.addEventListener('pageshow', reconnect);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reconnect();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null || typeof window === 'undefined' || !shouldKeepBrowserSocketAlive()) {
    return;
  }

  const base = Math.min(200 * Math.pow(2, reconnectAttempts), 5_000);
  const delay = Math.floor(base * (0.8 + Math.random() * 0.4));
  reconnectAttempts++;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    setBrowserConnectionState('reconnecting');
    void ensureBrowserSocket();
  }, delay);
}

export function parseBrowserBinaryChannelFrame(
  buffer: ArrayBuffer,
): { channelId: string; data: Uint8Array } | null {
  const frame = new Uint8Array(buffer);
  if (frame.length < CHANNEL_BINARY_HEADER_BYTES || frame[0] !== CHANNEL_DATA_FRAME_TYPE) {
    return null;
  }

  const channelId = CHANNEL_ID_DECODER.decode(frame.subarray(1, CHANNEL_BINARY_HEADER_BYTES));
  if (!UUID_CHANNEL_ID_RE.test(channelId)) {
    console.warn('[ipc] Ignoring malformed channel frame header');
    return null;
  }

  return {
    channelId,
    data: frame.subarray(CHANNEL_BINARY_HEADER_BYTES),
  };
}

function dispatchBrowserBinaryMessage(buffer: ArrayBuffer): void {
  const message = parseBrowserBinaryChannelFrame(buffer);
  if (!message) return;

  browserChannelListeners.get(message.channelId)?.({
    type: 'Data',
    data: message.data,
  });
}

function bindBrowserChannel(channelId: string): void {
  void sendBrowserCommand({ type: 'bind-channel', channelId } satisfies ClientMessage).catch(() => {
    // Transient failures should keep Channel.ready pending so the socket
    // lifecycle can retry after reconnect. Auth failures reject pending
    // channel readiness via rejectPendingChannelReady().
  });
}

async function handleBrowserMessage(
  event: MessageEvent<string | ArrayBuffer | Blob>,
): Promise<void> {
  if (event.data instanceof ArrayBuffer) {
    dispatchBrowserBinaryMessage(event.data);
    return;
  }

  if (event.data instanceof Blob) {
    dispatchBrowserBinaryMessage(await event.data.arrayBuffer());
    return;
  }

  if (typeof event.data !== 'string') return;

  let message: ServerMessage;
  try {
    message = JSON.parse(event.data) as ServerMessage;
  } catch {
    return;
  }

  if (!shouldProcessBrowserMessage(message)) return;

  switch (message.type) {
    case 'channel':
      browserChannelListeners.get(message.channelId)?.(message.payload);
      break;
    case 'ipc-event':
      browserEventListeners.get(message.channel)?.forEach((listener) => listener(message.payload));
      break;
    case 'channel-bound':
      browserChannelReadyResolvers.get(message.channelId)?.resolve();
      browserChannelReadyResolvers.delete(message.channelId);
      break;
    default:
      emitBrowserMessage(message);
      break;
  }
}

function queueBrowserRequest<T>(cmd: IPC, args: unknown, retries: number): Promise<T> {
  bindBrowserSocketLifecycle();

  return new Promise<T>((resolve, reject) => {
    const request: PendingRequest = {
      cmd,
      args,
      retries,
      resolve: (value) => resolve(value as T),
      reject,
      durable: isDurablePendingRequest(cmd, args),
    };
    enqueuePendingRequest(request);
    saveDurableQueue();
    schedulePendingRequestQueueDrain();
  });
}

async function executeBrowserFetch<T>(cmd: IPC, args?: unknown): Promise<T> {
  const token = getBrowserToken();
  let response: Response;
  try {
    response = await fetch(`/api/ipc/${encodeURIComponent(cmd)}`, {
      method: 'POST',
      keepalive: cmd === IPC.SaveAppState || cmd === IPC.DetachAgentOutput,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(args ?? {}),
    });
  } catch (error) {
    markBrowserUnreachable();
    throw new QueueableBrowserFetchError(BROWSER_UNREACHABLE_MESSAGE, error);
  }

  const data = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
  if (response.ok) {
    return data.result as T;
  }

  // Handle authentication failure (401)
  if (response.status === 401) {
    const authError = new Error(data.error ?? 'Browser session expired');
    handleBrowserAuthExpired(authError, {
      clearToken: true,
      rejectPending: 'queue',
      message: 'Browser session expired. Open a fresh server URL to reconnect.',
    });
    throw authError;
  }

  // Handle unexpected non-error status (should not happen)
  if (response.status < 400) {
    const responseError = new Error(data.error ?? `IPC request failed (${response.status})`);
    markBrowserUnreachable();
    throw new QueueableBrowserFetchError(responseError.message, responseError);
  }

  // Handle server errors (5xx) vs client errors (4xx)
  if (response.status >= 500) {
    emitBrowserTransportEvent({
      kind: 'error',
      message: data.error ?? 'The server failed to process the request.',
    });
  } else {
    console.warn('[ipc] Bad request to', cmd, ':', data.error ?? `${response.status}`);
  }

  throw new Error(data.error ?? `IPC request failed (${response.status})`);
}

async function replayPendingRequest(request: PendingRequest): Promise<void> {
  try {
    request.resolve(await executeBrowserFetch(request.cmd, request.args));
  } catch (error) {
    if (error instanceof QueueableBrowserFetchError) {
      if (request.retries < MAX_RETRIES) {
        enqueuePendingRequest(request);
        saveDurableQueue();
        schedulePendingRequestQueueDrain(getPendingRequestRetryDelay(request.retries));
        return;
      }
      request.reject(error.originalError);
      return;
    }

    request.reject(error);
  }
}

async function drainPendingRequestQueue(): Promise<void> {
  if (drainingPendingRequestQueue || pendingRequestQueue.length === 0) return;

  drainingPendingRequestQueue = true;
  try {
    const requestsToProcess = pendingRequestQueue.length;
    for (let index = 0; index < requestsToProcess; index += 1) {
      const request = pendingRequestQueue.shift();
      if (!request) break;

      await replayPendingRequest({
        ...request,
        retries: request.retries + 1,
      });
    }
  } finally {
    drainingPendingRequestQueue = false;
    saveDurableQueue();
    if (pendingRequestQueue.length > 0 && pendingRequestDrainTimer === null) {
      schedulePendingRequestQueueDrain();
    }
  }
}

async function ensureBrowserSocket(): Promise<WebSocket> {
  if (isElectronRuntime()) {
    throw new Error('Browser socket is unavailable in Electron mode');
  }

  if (browserSocket && isBrowserSocketOpen()) return browserSocket;
  if (browserSocketPromise) return browserSocketPromise;

  bindBrowserSocketLifecycle();

  const token = getBrowserToken();
  if (!token) {
    const error = new Error('Missing auth token');
    handleBrowserAuthExpired(error, {
      rejectPending: 'all',
      message: 'Browser session expired. Reload the page to reconnect.',
    });
    throw error;
  }

  setBrowserConnectionState(hasBrowserSocketConnected ? 'reconnecting' : 'connecting');

  browserSocketPromise = new Promise<WebSocket>((resolve, reject) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.binaryType = 'arraybuffer';

    const clearPromise = () => {
      if (browserSocketPromise) browserSocketPromise = null;
    };

    ws.onopen = () => {
      browserSocket = ws;
      hasBrowserSocketConnected = true;
      ws.send(
        JSON.stringify({
          type: 'auth',
          token,
          lastSeq: lastServerSeq,
          clientId: getBrowserClientId(),
        } satisfies ClientMessage),
      );
      for (const channelId of boundChannelIds) {
        ws.send(JSON.stringify({ type: 'bind-channel', channelId } satisfies ClientMessage));
      }
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0;
      startBrowserHeartbeat(ws);
      setBrowserConnectionState('connected');
      clearPromise();
      resolve(ws);
    };

    ws.onmessage = (event) => {
      void handleBrowserMessage(event as MessageEvent<string | ArrayBuffer | Blob>);
    };

    ws.onclose = (closeEvent) => {
      browserSocket = null;
      clearBrowserHeartbeat();
      clearPromise();
      if (closeEvent.code === 4001) {
        const authError = new Error('Browser session expired');
        handleBrowserAuthExpired(authError, {
          clearToken: true,
          rejectPending: 'all',
          message: 'Browser session expired. Open a fresh server URL to reconnect.',
        });
        return;
      }

      setBrowserConnectionState('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      clearBrowserHeartbeat();
      clearPromise();
      reject(new Error('WebSocket connection failed'));
      ws.close();
    };
  });

  return browserSocketPromise;
}

async function sendBrowserCommand(message: ClientMessage): Promise<void> {
  const ws = await ensureBrowserSocket();
  ws.send(JSON.stringify(message));
}

async function sendNonQueueableBrowserCommand(message: ClientMessage): Promise<void> {
  if (!isBrowserSocketOpen()) {
    throw new Error('Browser socket unavailable');
  }
  try {
    await sendBrowserCommand(message);
  } catch {
    throw new Error('Browser socket unavailable');
  }
}

async function sendBrowserCommandWithFallback<T>(
  message: ClientMessage,
  fallbackCmd: IPC,
  fallbackArgs?: unknown,
): Promise<T> {
  if (!isBrowserSocketOpen()) {
    return browserFetch<T>(fallbackCmd, fallbackArgs);
  }
  try {
    await sendBrowserCommand(message);
    return undefined as T;
  } catch {
    return browserFetch<T>(fallbackCmd, fallbackArgs);
  }
}

async function browserFetch<T>(cmd: IPC, args?: unknown): Promise<T> {
  try {
    return await executeBrowserFetch<T>(cmd, args);
  } catch (error) {
    if (error instanceof QueueableBrowserFetchError) {
      return queueBrowserRequest<T>(cmd, args, 0);
    }
    throw error;
  }
}

async function browserInvoke<T>(cmd: IPC, args?: unknown): Promise<T> {
  const payload = args as Record<string, unknown> | undefined;

  switch (cmd) {
    case IPC.WriteToAgent: {
      const agentId = String(payload?.agentId ?? '');
      const data = String(payload?.data ?? '');
      await sendBrowserCommand({ type: 'input', agentId, data });
      return undefined as T;
    }
    case IPC.ResizeAgent: {
      const agentId = String(payload?.agentId ?? '');
      const cols = Number(payload?.cols ?? 80);
      const rows = Number(payload?.rows ?? 24);
      await sendBrowserCommand({ type: 'resize', agentId, cols, rows });
      return undefined as T;
    }
    case IPC.KillAgent: {
      const agentId = String(payload?.agentId ?? '');
      return sendBrowserCommandWithFallback<T>({ type: 'kill', agentId }, cmd, args);
    }
    case IPC.PauseAgent: {
      const agentId = String(payload?.agentId ?? '');
      const reason = getPauseReason(payload?.reason);
      const channelId =
        typeof payload?.channelId === 'string' && payload.channelId.length > 0
          ? payload.channelId
          : undefined;
      if (reason === 'flow-control') {
        await sendNonQueueableBrowserCommand({ type: 'pause', agentId, reason, channelId });
        return undefined as T;
      }
      return browserFetch<T>(cmd, args);
    }
    case IPC.ResumeAgent: {
      const agentId = String(payload?.agentId ?? '');
      const reason = getPauseReason(payload?.reason);
      const channelId =
        typeof payload?.channelId === 'string' && payload.channelId.length > 0
          ? payload.channelId
          : undefined;
      if (reason === 'flow-control') {
        await sendNonQueueableBrowserCommand({ type: 'resume', agentId, reason, channelId });
        return undefined as T;
      }
      return browserFetch<T>(cmd, args);
    }
    case IPC.SpawnAgent:
      await ensureBrowserSocket();
      return browserFetch<T>(cmd, args);
    default:
      return browserFetch<T>(cmd, args);
  }
}

export function listen(channel: string, listener: (payload: unknown) => void): () => void {
  if (isElectronRuntime()) {
    const electron = window.electron?.ipcRenderer;
    if (!electron) throw new Error('Electron IPC bridge is unavailable');
    return electron.on(channel, listener);
  }

  const listeners = getOrCreateListenerSet(browserEventListeners, channel);
  listeners.add(listener);
  bindBrowserSocketLifecycle();
  ignoreErrorAsync(ensureBrowserSocket());

  return () => {
    const current = browserEventListeners.get(channel);
    current?.delete(listener);
    if (current?.size === 0) browserEventListeners.delete(channel);
  };
}

export function listenServerMessage<T extends BrowserServerMessageType>(
  type: T,
  listener: BrowserServerMessageListener<T>,
): () => void {
  if (isElectronRuntime()) return () => {};

  const listeners = getOrCreateListenerSet(browserMessageListeners, type);

  const wrapped = (message: BrowserServerMessage) => {
    listener(message as Extract<BrowserServerMessage, { type: T }>);
  };

  listeners.add(wrapped);
  bindBrowserSocketLifecycle();
  ignoreErrorAsync(ensureBrowserSocket());

  return () => {
    const current = browserMessageListeners.get(type);
    current?.delete(wrapped);
    if (current?.size === 0) browserMessageListeners.delete(type);
  };
}

export function onBrowserTransportEvent(listener: BrowserTransportListener): () => void {
  if (isElectronRuntime()) return () => {};

  browserTransportListeners.add(listener);
  bindBrowserSocketLifecycle();
  ignoreErrorAsync(ensureBrowserSocket());

  return () => {
    browserTransportListeners.delete(listener);
  };
}

export class Channel<T> {
  private _id = crypto.randomUUID();
  cleanup: (() => void) | null = null;
  onmessage: ((msg: T) => void) | null = null;

  constructor() {
    if (isElectronRuntime()) {
      const electron = window.electron?.ipcRenderer;
      if (!electron) throw new Error('Electron IPC bridge is unavailable');
      this.cleanup = electron.on(`channel:${this._id}`, (msg: unknown) => {
        this.onmessage?.(msg as T);
      });
      return;
    }

    browserChannelListeners.set(this._id, (msg: unknown) => {
      this.onmessage?.(msg as T);
    });
    boundChannelIds.add(this._id);
    this.ready = new Promise<void>((resolve, reject) => {
      browserChannelReadyResolvers.set(this._id, { resolve, reject });
    });
    bindBrowserChannel(this._id);

    this.cleanup = () => {
      browserChannelListeners.delete(this._id);
      browserChannelReadyResolvers.get(this._id)?.reject(new Error('Channel cleaned up'));
      browserChannelReadyResolvers.delete(this._id);
      boundChannelIds.delete(this._id);
      ignoreErrorAsync(sendBrowserCommand({ type: 'unbind-channel', channelId: this._id }));
    };
  }

  ready: Promise<void> = Promise.resolve();
  get id() {
    return this._id;
  }

  toJSON() {
    return { __CHANNEL_ID__: this._id };
  }
}

export async function invoke<T>(cmd: IPC, args?: unknown): Promise<T> {
  const safeArgs = args ? (JSON.parse(JSON.stringify(args)) as Record<string, unknown>) : undefined;
  if (isElectronRuntime()) {
    const electron = window.electron?.ipcRenderer;
    if (!electron) throw new Error('Electron IPC bridge is unavailable');
    return electron.invoke(cmd, safeArgs) as Promise<T>;
  }
  return browserInvoke<T>(cmd, safeArgs);
}

export function fireAndForget(cmd: IPC, args?: unknown, onError?: (err: unknown) => void): void {
  invoke(cmd, args).catch((err: unknown) => {
    console.error(`[IPC] ${cmd} failed:`, err);
    onError?.(err);
  });
}

export function getBrowserQueueDepth(): number {
  if (isElectronRuntime()) return 0;
  return pendingRequestQueue.length;
}

export function getBrowserLastRttMs(): number | null {
  if (isElectronRuntime()) return null;
  return lastBrowserRttMs;
}

// Module initialization: restore any durable requests that survived a reload
if (typeof window !== 'undefined' && !isElectronRuntime()) {
  loadDurableQueue();
  schedulePendingRequestQueueDrain();
}
