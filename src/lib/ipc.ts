import { IPC } from '../../electron/ipc/channels';
import type { ClientMessage, PauseReason } from '../../electron/remote/protocol';
import type {
  RendererInvokeChannel,
  RendererInvokeRequestMap,
  RendererInvokeResponseMap,
} from '../domain/renderer-invoke';
import {
  clearBrowserToken,
  getBrowserClientId,
  isElectronRuntime,
  redirectToBrowserAuth,
} from './browser-auth';
import {
  createBrowserChannelClient,
  parseBrowserBinaryChannelFrame,
  type BrowserChannelState,
} from './browser-channel-client';
import {
  createBrowserControlClient,
  type BrowserServerMessage,
  type BrowserServerMessageListener,
  type BrowserServerMessageType,
  type BrowserTransportEvent,
} from './browser-control-client';
import { createBrowserHttpIpcClient, type BrowserHttpIpcState } from './browser-http-ipc';

const VALID_PAUSE_REASONS = new Set<PauseReason>(['manual', 'flow-control', 'restore']);

// Browser mode is intentionally split into three transport planes:
// - browser-http-ipc.ts: HTTP command/query IPC with durable replay
// - browser-control-client.ts: sequenced websocket control events and control commands
// - browser-channel-client.ts: terminal stream binding and channel frames

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

function getPauseReason(value: unknown): PauseReason | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (VALID_PAUSE_REASONS.has(value as PauseReason)) {
    return value as PauseReason;
  }

  throw new Error(
    `Invalid pause reason: ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`,
  );
}

function handleBrowserAuthExpired(
  error: Error,
  options: {
    clearToken?: boolean;
    disconnectControlPlane?: boolean;
    message: string;
  },
): void {
  if (options.clearToken) {
    clearBrowserToken();
  }

  if (options.disconnectControlPlane) {
    browserControlClient.expireSession();
  }

  browserHttpClient.clearDurableQueueStorage();
  browserHttpClient.rejectPendingRequests(error);
  browserChannelClient.rejectPendingReady(error);
  browserControlClient.setAuthExpired(options.message);
}

const browserControlClient = createBrowserControlClient({
  getClientId: getBrowserClientId,
  hasChannelBindings: () => browserChannelClient?.hasBoundChannels() === true,
  onAuthExpired: () => {
    handleBrowserAuthExpired(new Error('Browser session expired'), {
      clearToken: true,
      disconnectControlPlane: false,
      message: 'Browser session expired. Sign in again to reconnect.',
    });
    redirectToBrowserAuth();
  },
});

const browserHttpClient = createBrowserHttpIpcClient({
  enabled: !isElectronRuntime(),
  getToken: () => null,
  onAuthExpired: (error) => {
    handleBrowserAuthExpired(error, {
      clearToken: true,
      disconnectControlPlane: true,
      message: 'Browser session expired. Sign in again to reconnect.',
    });
    redirectToBrowserAuth();
  },
  onServerError: (message) => {
    browserControlClient.emitError(message);
  },
  onUnreachable: (message) => {
    browserControlClient.emitError(message);
  },
});

const browserChannelClient = createBrowserChannelClient({
  sendCommand: (message) => browserControlClient.send(message),
});

browserControlClient.setChannelHandlers({
  onBinaryMessage: (buffer) => {
    browserChannelClient.handleBinaryMessage(buffer);
  },
  onChannelBound: (channelId) => {
    browserChannelClient.handleChannelBound(channelId);
  },
  onChannelPayload: (channelId, payload) => {
    browserChannelClient.handleChannelPayload(channelId, payload);
  },
});

browserControlClient.onTransportEvent((event) => {
  if (event.kind === 'connection' && event.state === 'connected') {
    browserChannelClient.rebindChannels();
  }
});

async function sendBrowserCommand(message: ClientMessage): Promise<void> {
  await browserControlClient.send(message);
}

async function sendNonQueueableBrowserCommand(message: ClientMessage): Promise<void> {
  if (!browserControlClient.sendIfOpen(message)) {
    throw new Error('Browser socket unavailable');
  }
}

async function sendBrowserCommandWithFallback<T>(
  message: ClientMessage,
  fallbackCmd: IPC,
  fallbackArgs?: unknown,
): Promise<T> {
  if (!browserControlClient.isOpen()) {
    return browserHttpClient.fetch<T>(fallbackCmd, fallbackArgs);
  }

  try {
    await sendBrowserCommand(message);
    return undefined as T;
  } catch {
    return browserHttpClient.fetch<T>(fallbackCmd, fallbackArgs);
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
        await sendNonQueueableBrowserCommand({
          type: 'pause',
          agentId,
          reason,
          ...(channelId ? { channelId } : {}),
        });
        return undefined as T;
      }

      return browserHttpClient.fetch<T>(cmd, args);
    }
    case IPC.ResumeAgent: {
      const agentId = String(payload?.agentId ?? '');
      const reason = getPauseReason(payload?.reason);
      const channelId =
        typeof payload?.channelId === 'string' && payload.channelId.length > 0
          ? payload.channelId
          : undefined;

      if (reason === 'flow-control') {
        await sendNonQueueableBrowserCommand({
          type: 'resume',
          agentId,
          reason,
          ...(channelId ? { channelId } : {}),
        });
        return undefined as T;
      }

      return browserHttpClient.fetch<T>(cmd, args);
    }
    case IPC.SpawnAgent:
      browserControlClient.bindLifecycle();
      await browserControlClient.ensureConnected();
      return browserHttpClient.fetch<T>(cmd, args);
    default:
      return browserHttpClient.fetch<T>(cmd, args);
  }
}

export function listen(channel: string, listener: (payload: unknown) => void): () => void {
  if (isElectronRuntime()) {
    const electron = window.electron?.ipcRenderer;
    if (!electron) {
      throw new Error('Electron IPC bridge is unavailable');
    }

    return electron.on(channel, listener);
  }

  return browserControlClient.listenEvent(channel, listener);
}

export function listenServerMessage<T extends BrowserServerMessageType>(
  type: T,
  listener: BrowserServerMessageListener<T>,
): () => void {
  if (isElectronRuntime()) {
    return () => {};
  }

  return browserControlClient.listenMessage(type, listener);
}

export function onBrowserTransportEvent(
  listener: (event: BrowserTransportEvent) => void,
): () => void {
  if (isElectronRuntime()) {
    return () => {};
  }

  return browserControlClient.onTransportEvent(listener);
}

export class Channel<T> {
  private browserChannelState: BrowserChannelState<T> | null = null;
  private _id: string = crypto.randomUUID();
  private _onmessage: ((msg: T) => void) | null = null;

  cleanup: (() => void) | null = null;
  ready: Promise<void> = Promise.resolve();

  constructor() {
    if (isElectronRuntime()) {
      const electron = window.electron?.ipcRenderer;
      if (!electron) {
        throw new Error('Electron IPC bridge is unavailable');
      }

      this.cleanup = electron.on(`channel:${this._id}`, (msg: unknown) => {
        this._onmessage?.(msg as T);
      });
      return;
    }

    const browserChannelState = browserChannelClient.createChannel<T>();
    this.browserChannelState = browserChannelState;
    this._id = browserChannelState.id;
    this.ready = browserChannelState.ready;
    browserChannelState.setOnMessage((message) => {
      this._onmessage?.(message);
    });
    this.cleanup = () => {
      browserChannelState.cleanup();
    };
  }

  get id(): string {
    return this._id;
  }

  get onmessage(): ((msg: T) => void) | null {
    return this._onmessage;
  }

  set onmessage(listener: ((msg: T) => void) | null) {
    this._onmessage = listener;
    this.browserChannelState?.setOnMessage(listener);
  }

  toJSON(): { __CHANNEL_ID__: string } {
    return { __CHANNEL_ID__: this._id };
  }
}

type InvokeArgs<TChannel extends RendererInvokeChannel> =
  RendererInvokeRequestMap[TChannel] extends undefined
    ? [args?: RendererInvokeRequestMap[TChannel]]
    : [args: RendererInvokeRequestMap[TChannel]];

export async function invoke<TChannel extends RendererInvokeChannel>(
  cmd: TChannel,
  ...args: InvokeArgs<TChannel>
): Promise<RendererInvokeResponseMap[TChannel]>;
export async function invoke<T>(cmd: IPC, args?: unknown): Promise<T>;
export async function invoke<T>(cmd: IPC, ...args: [args?: unknown]): Promise<T> {
  const [argsValue] = args;
  const safeArgs = argsValue
    ? (JSON.parse(JSON.stringify(argsValue)) as Record<string, unknown>)
    : undefined;
  if (isElectronRuntime()) {
    const electron = window.electron?.ipcRenderer;
    if (!electron) {
      throw new Error('Electron IPC bridge is unavailable');
    }

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
  if (isElectronRuntime()) {
    return 0;
  }

  return browserHttpClient.getQueueDepth();
}

export function getBrowserLastRttMs(): number | null {
  if (isElectronRuntime()) {
    return null;
  }

  return browserControlClient.getLastRttMs();
}

export function onBrowserHttpStateChange(
  listener: (state: BrowserHttpIpcState) => void,
): () => void {
  if (isElectronRuntime()) {
    return () => {};
  }

  return browserHttpClient.onStateChange(listener);
}

export type { BrowserServerMessage, BrowserServerMessageType, BrowserTransportEvent };
export { isElectronRuntime, parseBrowserBinaryChannelFrame };
