import { IPC } from '../../electron/ipc/channels';
import {
  MAX_CLIENT_INPUT_DATA_LENGTH,
  type ClientMessage,
  type PauseReason,
} from '../../electron/remote/protocol';
import type {
  RendererInvokeChannel,
  RendererInvokeRequestMap,
  RendererInvokeResponseMap,
} from '../domain/renderer-invoke';
import { isPauseReason } from '../domain/server-state';
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
import { splitTerminalInputChunks } from './terminal-input-batching';

// Browser mode is intentionally split into three transport planes:
// - browser-http-ipc.ts: HTTP command/query IPC with durable replay
// - browser-control-client.ts: sequenced websocket control events and control commands
// - browser-channel-client.ts: terminal stream binding and channel frames

declare global {
  interface Window {
    electron?: {
      ipcRenderer: {
        invoke: <TChannel extends RendererInvokeChannel>(
          channel: TChannel,
          args?: RendererInvokeRequestMap[TChannel],
        ) => Promise<RendererInvokeResponseMap[TChannel]>;
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

  if (typeof value === 'string' && isPauseReason(value)) {
    return value;
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

export function onBrowserAuthenticated(listener: () => void): () => void {
  if (isElectronRuntime()) {
    return () => {};
  }

  return browserControlClient.onAuthenticated(listener);
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
  undefined extends RendererInvokeRequestMap[TChannel]
    ? [args?: RendererInvokeRequestMap[TChannel]]
    : [args: RendererInvokeRequestMap[TChannel]];

type BrowserControlChannel =
  | IPC.KillAgent
  | IPC.PauseAgent
  | IPC.ResizeAgent
  | IPC.ResumeAgent
  | IPC.SpawnAgent
  | IPC.WriteToAgent;

type BrowserControlCall = {
  [TChannel in BrowserControlChannel]: [
    cmd: TChannel,
    args: Exclude<RendererInvokeRequestMap[TChannel], undefined>,
  ];
}[BrowserControlChannel];

type BrowserUndefinedResponseChannel =
  | IPC.KillAgent
  | IPC.PauseAgent
  | IPC.ResizeAgent
  | IPC.ResumeAgent
  | IPC.WriteToAgent;

type FireAndForgetChannel = {
  [TChannel in RendererInvokeChannel]: RendererInvokeResponseMap[TChannel] extends undefined
    ? TChannel
    : never;
}[RendererInvokeChannel];

function cloneInvokeArgs<TChannel extends RendererInvokeChannel>(
  args: RendererInvokeRequestMap[TChannel],
): RendererInvokeRequestMap[TChannel] {
  return JSON.parse(JSON.stringify(args));
}

function splitBrowserInputData(data: string): string[] {
  return splitTerminalInputChunks(data, MAX_CLIENT_INPUT_DATA_LENGTH).map((chunk) => chunk.data);
}

async function sendBrowserInput(agentId: string, data: string): Promise<void> {
  for (const chunk of splitBrowserInputData(data)) {
    await sendBrowserCommand({ type: 'input', agentId, data: chunk });
  }
}

function invokeElectronTransport<TChannel extends RendererInvokeChannel>(
  electron: NonNullable<Window['electron']>['ipcRenderer'],
  cmd: TChannel,
  args: RendererInvokeRequestMap[TChannel] | undefined,
): Promise<RendererInvokeResponseMap[TChannel]> {
  return electron.invoke(cmd, args);
}

function invokeBrowserTransport<TChannel extends RendererInvokeChannel>(
  cmd: TChannel,
  args: Exclude<RendererInvokeRequestMap[TChannel], undefined>,
): Promise<RendererInvokeResponseMap[TChannel]> {
  switch (cmd) {
    case IPC.WriteToAgent:
      return browserInvoke(
        IPC.WriteToAgent,
        args as Exclude<RendererInvokeRequestMap[IPC.WriteToAgent], undefined>,
      ) as Promise<RendererInvokeResponseMap[TChannel]>;
    case IPC.ResizeAgent:
      return browserInvoke(
        IPC.ResizeAgent,
        args as Exclude<RendererInvokeRequestMap[IPC.ResizeAgent], undefined>,
      ) as Promise<RendererInvokeResponseMap[TChannel]>;
    case IPC.KillAgent:
      return browserInvoke(
        IPC.KillAgent,
        args as Exclude<RendererInvokeRequestMap[IPC.KillAgent], undefined>,
      ) as Promise<RendererInvokeResponseMap[TChannel]>;
    case IPC.PauseAgent:
      return browserInvoke(
        IPC.PauseAgent,
        args as Exclude<RendererInvokeRequestMap[IPC.PauseAgent], undefined>,
      ) as Promise<RendererInvokeResponseMap[TChannel]>;
    case IPC.ResumeAgent:
      return browserInvoke(
        IPC.ResumeAgent,
        args as Exclude<RendererInvokeRequestMap[IPC.ResumeAgent], undefined>,
      ) as Promise<RendererInvokeResponseMap[TChannel]>;
    case IPC.SpawnAgent:
      return browserInvoke(
        IPC.SpawnAgent,
        args as Exclude<RendererInvokeRequestMap[IPC.SpawnAgent], undefined>,
      ) as Promise<RendererInvokeResponseMap[TChannel]>;
    default:
      return browserHttpClient.fetch(cmd, args) as Promise<RendererInvokeResponseMap[TChannel]>;
  }
}

function createFlowControlCommand(
  type: 'pause' | 'resume',
  request:
    | Exclude<RendererInvokeRequestMap[IPC.PauseAgent], undefined>
    | Exclude<RendererInvokeRequestMap[IPC.ResumeAgent], undefined>,
): Extract<ClientMessage, { type: 'pause' | 'resume' }> | null {
  const reason = getPauseReason(request.reason);
  if (reason !== 'flow-control') {
    return null;
  }

  const channelId =
    typeof request.channelId === 'string' && request.channelId.length > 0
      ? request.channelId
      : undefined;

  return {
    type,
    agentId: request.agentId,
    reason,
    ...(channelId ? { channelId } : {}),
  };
}

function createPauseControlRequest(
  request:
    | Exclude<RendererInvokeRequestMap[IPC.PauseAgent], undefined>
    | Exclude<RendererInvokeRequestMap[IPC.ResumeAgent], undefined>,
): RendererInvokeRequestMap[IPC.PauseAgent] {
  const channelId =
    typeof request.channelId === 'string' && request.channelId.length > 0
      ? request.channelId
      : undefined;
  const reason = getPauseReason(request.reason);
  return {
    agentId: request.agentId,
    ...(channelId ? { channelId } : {}),
    ...(reason ? { reason } : {}),
  };
}

async function sendBrowserCommandWithFallback<TChannel extends BrowserUndefinedResponseChannel>(
  message: ClientMessage,
  fallbackCmd: TChannel,
  fallbackArgs?: RendererInvokeRequestMap[TChannel],
): Promise<RendererInvokeResponseMap[TChannel]>;
async function sendBrowserCommandWithFallback(
  message: ClientMessage,
  fallbackCmd: BrowserUndefinedResponseChannel,
  fallbackArgs?: RendererInvokeRequestMap[BrowserUndefinedResponseChannel],
): Promise<RendererInvokeResponseMap[BrowserUndefinedResponseChannel]> {
  if (!browserControlClient.isOpen()) {
    return browserHttpClient.fetch(fallbackCmd, fallbackArgs);
  }

  try {
    await sendBrowserCommand(message);
    return undefined;
  } catch {
    return browserHttpClient.fetch(fallbackCmd, fallbackArgs);
  }
}

async function browserInvoke(
  ...call: BrowserControlCall
): Promise<RendererInvokeResponseMap[BrowserControlChannel]> {
  const [cmd, args] = call;
  switch (cmd) {
    case IPC.WriteToAgent: {
      await sendBrowserInput(args.agentId, args.data);
      return undefined;
    }
    case IPC.ResizeAgent: {
      await sendBrowserCommand({
        type: 'resize',
        agentId: args.agentId,
        cols: args.cols,
        rows: args.rows,
      });
      return undefined;
    }
    case IPC.KillAgent: {
      return sendBrowserCommandWithFallback(
        { type: 'kill', agentId: args.agentId },
        IPC.KillAgent,
        { agentId: args.agentId },
      );
    }
    case IPC.PauseAgent: {
      const message = createFlowControlCommand('pause', args);
      if (message) {
        await sendNonQueueableBrowserCommand(message);
        return undefined;
      }

      return browserHttpClient.fetch(IPC.PauseAgent, createPauseControlRequest(args));
    }
    case IPC.ResumeAgent: {
      const message = createFlowControlCommand('resume', args);
      if (message) {
        await sendNonQueueableBrowserCommand(message);
        return undefined;
      }

      return browserHttpClient.fetch(IPC.ResumeAgent, createPauseControlRequest(args));
    }
    case IPC.SpawnAgent:
      browserControlClient.bindLifecycle();
      await browserControlClient.ensureConnected();
      return browserHttpClient.fetch(IPC.SpawnAgent, args);
  }
}

export async function invoke<TChannel extends RendererInvokeChannel>(
  cmd: TChannel,
  ...args: InvokeArgs<TChannel>
): Promise<RendererInvokeResponseMap[TChannel]> {
  const [argsValue] = args;
  const safeArgs: RendererInvokeRequestMap[TChannel] | undefined =
    argsValue === undefined
      ? undefined
      : cloneInvokeArgs(argsValue as Exclude<RendererInvokeRequestMap[TChannel], undefined>);
  if (isElectronRuntime()) {
    const electron = window.electron?.ipcRenderer;
    if (!electron) {
      throw new Error('Electron IPC bridge is unavailable');
    }

    return invokeElectronTransport(electron, cmd, safeArgs);
  }

  if (safeArgs === undefined) {
    return browserHttpClient.fetch(cmd, safeArgs);
  }

  return invokeBrowserTransport(
    cmd,
    safeArgs as Exclude<RendererInvokeRequestMap[TChannel], undefined>,
  );
}

export function fireAndForget<TChannel extends FireAndForgetChannel>(
  cmd: TChannel,
  args: RendererInvokeRequestMap[TChannel],
  onError?: (err: unknown) => void,
): void {
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
