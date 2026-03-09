import { IPC } from '../../electron/ipc/channels';
import type { ClientMessage, PauseReason, ServerMessage } from '../../electron/remote/protocol';

const TOKEN_KEY = 'parallel-code-token';

type BrowserEventListener = (payload: unknown) => void;
type BrowserServerMessage = Exclude<ServerMessage, { type: 'channel' } | { type: 'ipc-event' }>;
type BrowserServerMessageType = BrowserServerMessage['type'];
type BrowserServerMessageListener<T extends BrowserServerMessageType> = (
  message: Extract<BrowserServerMessage, { type: T }>,
) => void;

function getPauseReason(value: unknown): PauseReason | undefined {
  if (value === undefined) return undefined;
  if (value === 'manual' || value === 'flow-control' || value === 'restore') return value;
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

let browserSocket: WebSocket | null = null;
let browserSocketPromise: Promise<WebSocket> | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempts = 0;
let browserTokenInitialized = false;
let browserSocketLifecycleBound = false;
let hasBrowserSocketConnected = false;
let browserConnectionState: Extract<BrowserTransportEvent, { kind: 'connection' }>['state'] =
  'disconnected';
let lastBrowserErrorMessage: string | null = null;
let lastBrowserErrorAt = 0;

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

export function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && typeof window.electron?.ipcRenderer !== 'undefined';
}

function shouldKeepBrowserSocketAlive(): boolean {
  return (
    boundChannelIds.size > 0 ||
    browserEventListeners.size > 0 ||
    browserMessageListeners.size > 0 ||
    browserTransportListeners.size > 0
  );
}

function emitBrowserTransportEvent(event: BrowserTransportEvent): void {
  if (event.kind === 'error') {
    const now = Date.now();
    if (event.message === lastBrowserErrorMessage && now - lastBrowserErrorAt < 3_000) return;
    lastBrowserErrorMessage = event.message;
    lastBrowserErrorAt = now;
  }

  for (const listener of browserTransportListeners) {
    listener(event);
  }
}

function setBrowserConnectionState(
  state: Extract<BrowserTransportEvent, { kind: 'connection' }>['state'],
): void {
  if (browserConnectionState === state) return;
  browserConnectionState = state;
  emitBrowserTransportEvent({ kind: 'connection', state });
}

function emitBrowserMessage(message: BrowserServerMessage): void {
  browserMessageListeners.get(message.type)?.forEach((listener) => listener(message));
}

function rejectPendingChannelReady(error: unknown): void {
  const pending = Array.from(browserChannelReadyResolvers.values());
  browserChannelReadyResolvers.clear();
  for (const { reject } of pending) {
    reject(error);
  }
}

function bindBrowserSocketLifecycle(): void {
  if (browserSocketLifecycleBound || typeof window === 'undefined' || isElectronRuntime()) return;
  browserSocketLifecycleBound = true;

  const reconnect = () => {
    if (!shouldKeepBrowserSocketAlive()) return;
    if (browserSocket?.readyState === WebSocket.OPEN || browserSocketPromise) return;
    void ensureBrowserSocket().catch(() => {});
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

  const delay = Math.min(200 * Math.pow(2, reconnectAttempts), 5_000);
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

function noopCleanup(): void {}

async function ensureBrowserSocket(): Promise<WebSocket> {
  if (isElectronRuntime()) {
    throw new Error('Browser socket is unavailable in Electron mode');
  }

  if (browserSocket?.readyState === WebSocket.OPEN) return browserSocket;
  if (browserSocketPromise) return browserSocketPromise;

  bindBrowserSocketLifecycle();

  const token = getBrowserToken();
  if (!token) {
    const error = new Error('Missing auth token');
    rejectPendingChannelReady(error);
    setBrowserConnectionState('auth-expired');
    emitBrowserTransportEvent({
      kind: 'error',
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
      ws.send(JSON.stringify({ type: 'auth', token } satisfies ClientMessage));
      for (const channelId of boundChannelIds) {
        ws.send(JSON.stringify({ type: 'bind-channel', channelId } satisfies ClientMessage));
      }
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0;
      setBrowserConnectionState('connected');
      clearPromise();
      resolve(ws);
    };

    ws.onmessage = (event) => {
      void handleBrowserMessage(event as MessageEvent<string | ArrayBuffer | Blob>);
    };

    ws.onclose = (closeEvent) => {
      browserSocket = null;
      clearPromise();
      if (closeEvent.code === 4001) {
        rejectPendingChannelReady(new Error('Browser session expired'));
        clearBrowserToken();
        setBrowserConnectionState('auth-expired');
        emitBrowserTransportEvent({
          kind: 'error',
          message: 'Browser session expired. Open a fresh server URL to reconnect.',
        });
        return;
      }

      setBrowserConnectionState('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
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

async function browserFetch<T>(cmd: IPC, args?: unknown): Promise<T> {
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
    setBrowserConnectionState('disconnected');
    emitBrowserTransportEvent({
      kind: 'error',
      message: 'Unable to reach the Parallel Code server.',
    });
    throw error;
  }

  const data = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!response.ok) {
    if (response.status === 401) {
      clearBrowserToken();
      setBrowserConnectionState('auth-expired');
      emitBrowserTransportEvent({
        kind: 'error',
        message: 'Browser session expired. Open a fresh server URL to reconnect.',
      });
    } else if (response.status >= 500) {
      emitBrowserTransportEvent({
        kind: 'error',
        message: data.error ?? 'The server failed to process the request.',
      });
    }
    throw new Error(data.error ?? `IPC request failed (${response.status})`);
  }
  return data.result as T;
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
      await sendBrowserCommand({ type: 'kill', agentId });
      return undefined as T;
    }
    case IPC.PauseAgent: {
      const agentId = String(payload?.agentId ?? '');
      const reason = getPauseReason(payload?.reason);
      // 'restore' pauses must use HTTP so the caller can await server-side
      // completion before fetching scrollback on the same connection.
      // Flow-control pauses use fire-and-forget WebSocket for low latency.
      if (reason === 'restore') return browserFetch<T>(cmd, args);
      await sendBrowserCommand({ type: 'pause', agentId, reason });
      return undefined as T;
    }
    case IPC.ResumeAgent: {
      const agentId = String(payload?.agentId ?? '');
      const reason = getPauseReason(payload?.reason);
      if (reason === 'restore') return browserFetch<T>(cmd, args);
      await sendBrowserCommand({ type: 'resume', agentId, reason });
      return undefined as T;
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

  let listeners = browserEventListeners.get(channel);
  if (!listeners) {
    listeners = new Set();
    browserEventListeners.set(channel, listeners);
  }
  listeners.add(listener);
  bindBrowserSocketLifecycle();
  void ensureBrowserSocket().catch(() => {});

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
  if (isElectronRuntime()) return noopCleanup;

  let listeners = browserMessageListeners.get(type);
  if (!listeners) {
    listeners = new Set();
    browserMessageListeners.set(type, listeners);
  }

  const wrapped = (message: BrowserServerMessage) => {
    listener(message as Extract<BrowserServerMessage, { type: T }>);
  };

  listeners.add(wrapped);
  bindBrowserSocketLifecycle();
  void ensureBrowserSocket().catch(() => {});

  return () => {
    const current = browserMessageListeners.get(type);
    current?.delete(wrapped);
    if (current?.size === 0) browserMessageListeners.delete(type);
  };
}

export function onBrowserTransportEvent(listener: BrowserTransportListener): () => void {
  if (isElectronRuntime()) return noopCleanup;

  browserTransportListeners.add(listener);
  bindBrowserSocketLifecycle();
  void ensureBrowserSocket().catch(() => {});

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
      void sendBrowserCommand({ type: 'unbind-channel', channelId: this._id }).catch(() => {});
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
