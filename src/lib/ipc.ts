import { IPC } from '../../electron/ipc/channels';
import type { ClientMessage, ServerMessage } from '../../electron/remote/protocol';

const TOKEN_KEY = 'parallel-code-token';

type BrowserEventListener = (payload: unknown) => void;

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
const browserEventListeners = new Map<string, Set<BrowserEventListener>>();
const boundChannelIds = new Set<string>();

let browserSocket: WebSocket | null = null;
let browserSocketPromise: Promise<WebSocket> | null = null;
let reconnectTimer: number | null = null;
let browserTokenInitialized = false;

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

export function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && typeof window.electron?.ipcRenderer !== 'undefined';
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    void ensureBrowserSocket();
  }, 1_000);
}

function handleBrowserMessage(event: MessageEvent<string>): void {
  let message: ServerMessage;
  try {
    message = JSON.parse(String(event.data)) as ServerMessage;
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
    default:
      break;
  }
}

async function ensureBrowserSocket(): Promise<WebSocket> {
  if (isElectronRuntime()) {
    throw new Error('Browser socket is unavailable in Electron mode');
  }

  if (browserSocket?.readyState === WebSocket.OPEN) return browserSocket;
  if (browserSocketPromise) return browserSocketPromise;

  const token = getBrowserToken();
  if (!token) throw new Error('Missing auth token');

  browserSocketPromise = new Promise<WebSocket>((resolve, reject) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    const clearPromise = () => {
      if (browserSocketPromise) browserSocketPromise = null;
    };

    ws.onopen = () => {
      browserSocket = ws;
      ws.send(JSON.stringify({ type: 'auth', token } satisfies ClientMessage));
      for (const channelId of boundChannelIds) {
        ws.send(JSON.stringify({ type: 'bind-channel', channelId } satisfies ClientMessage));
      }
      clearPromise();
      resolve(ws);
    };

    ws.onmessage = (event) => {
      handleBrowserMessage(event as MessageEvent<string>);
    };

    ws.onclose = (closeEvent) => {
      browserSocket = null;
      clearPromise();
      if (
        closeEvent.code !== 4001 &&
        (boundChannelIds.size > 0 || browserEventListeners.size > 0)
      ) {
        scheduleReconnect();
      }
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
  const response = await fetch(`/api/ipc/${encodeURIComponent(cmd)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(args ?? {}),
  });

  const data = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!response.ok) {
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
    case IPC.PauseAgent: {
      const agentId = String(payload?.agentId ?? '');
      await sendBrowserCommand({ type: 'pause', agentId });
      return undefined as T;
    }
    case IPC.ResumeAgent: {
      const agentId = String(payload?.agentId ?? '');
      await sendBrowserCommand({ type: 'resume', agentId });
      return undefined as T;
    }
    case IPC.KillAgent: {
      const agentId = String(payload?.agentId ?? '');
      await sendBrowserCommand({ type: 'kill', agentId });
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
  void ensureBrowserSocket().catch(() => {});

  return () => {
    const current = browserEventListeners.get(channel);
    current?.delete(listener);
    if (current?.size === 0) browserEventListeners.delete(channel);
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
    void sendBrowserCommand({ type: 'bind-channel', channelId: this._id }).catch(() => {});

    this.cleanup = () => {
      browserChannelListeners.delete(this._id);
      boundChannelIds.delete(this._id);
      void sendBrowserCommand({ type: 'unbind-channel', channelId: this._id }).catch(() => {});
    };
  }

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
