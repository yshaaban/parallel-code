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
import type {
  TerminalInputTraceClockSyncRequest,
  TerminalInputTraceClockSyncResponse,
  TerminalInputTraceClientUpdate,
  TerminalInputTraceMessage,
} from '../domain/terminal-input-tracing';
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
import {
  clearTerminalTraceClockAlignment,
  getLocalTerminalTraceTimestampMs,
  getTerminalTraceClockAlignmentSnapshot,
  resetTerminalTraceClockAlignmentForTests,
  setTerminalTraceClockAlignment,
} from './terminal-trace-clock';

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
  getClientId: getBrowserClientId,
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

const BROWSER_AGENT_COMMAND_TIMEOUT_MS = 10_000;
export const BROWSER_AGENT_COMMAND_CANCELED_ERROR_MESSAGE = 'Browser agent command canceled';
const BROWSER_SOCKET_UNAVAILABLE_ERROR_MESSAGE = 'Browser socket unavailable';
const TERMINAL_TRACE_CLOCK_SYNC_INTERVAL_MS = 15_000;
const TERMINAL_TRACE_CLOCK_SYNC_SAMPLE_COUNT = 4;

interface PendingBrowserAgentCommandRequest {
  agentId: string;
  command: 'input' | 'resize';
  reject: (error: Error) => void;
  resolve: () => void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
}

interface PendingBrowserTerminalInputSend {
  reject: (error: Error) => void;
}

interface BrowserInputSendOptions {
  awaitCommandResult?: boolean;
  canSend?: () => boolean;
  controllerId?: string;
  requestId?: string;
  taskId?: string;
  trace?: TerminalInputTraceMessage;
}

const pendingBrowserAgentCommandRequests = new Map<string, PendingBrowserAgentCommandRequest>();
const pendingBrowserTerminalInputSends = new Map<string, PendingBrowserTerminalInputSend>();
const pendingTerminalTraceClockSyncRequests = new Map<string, number>();
let cleanupBrowserAgentCommandRequestListeners: (() => void) | null = null;
let terminalTraceClockSyncBound = false;
let terminalTraceClockSyncTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

function createBrowserAgentCommandCanceledError(): Error {
  return new Error(BROWSER_AGENT_COMMAND_CANCELED_ERROR_MESSAGE);
}

function createBrowserAgentCommandTimeoutError(): Error {
  return new Error('Timed out waiting for browser agent command result');
}

function createBrowserSocketUnavailableError(): Error {
  return new Error(BROWSER_SOCKET_UNAVAILABLE_ERROR_MESSAGE);
}

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

bindTerminalTraceClockSyncLifecycle();

browserControlClient.onTransportEvent((event) => {
  if (event.kind === 'connection' && event.state === 'connected') {
    browserChannelClient.rebindChannels();
  }
});

function clearPendingBrowserAgentCommandRequest(requestId: string): void {
  const pendingRequest = pendingBrowserAgentCommandRequests.get(requestId);
  if (!pendingRequest) {
    return;
  }

  clearTimeout(pendingRequest.timeout);
  pendingBrowserAgentCommandRequests.delete(requestId);
  cleanupBrowserAgentCommandRequestListenersIfIdle();
}

function matchesPendingBrowserAgentCommandRequestId(
  requestId: string,
  pendingRequestId: string,
): boolean {
  return pendingRequestId === requestId || pendingRequestId.startsWith(`${requestId}:`);
}

function rejectPendingBrowserAgentCommandRequests(error: Error): void {
  for (const [requestId, pendingRequest] of pendingBrowserAgentCommandRequests) {
    clearTimeout(pendingRequest.timeout);
    pendingBrowserAgentCommandRequests.delete(requestId);
    pendingRequest.reject(error);
  }
  cleanupBrowserAgentCommandRequestListenersIfIdle();
}

function clearPendingBrowserTerminalInputSend(requestId: string): void {
  pendingBrowserTerminalInputSends.delete(requestId);
}

function rejectPendingBrowserTerminalInputSends(error: Error): void {
  for (const [requestId, pendingSend] of pendingBrowserTerminalInputSends) {
    pendingBrowserTerminalInputSends.delete(requestId);
    pendingSend.reject(error);
  }
}

function cancelPendingBrowserAgentCommandRequests(requestId: string): void {
  for (const [pendingRequestId, pendingRequest] of pendingBrowserAgentCommandRequests) {
    if (!matchesPendingBrowserAgentCommandRequestId(requestId, pendingRequestId)) {
      continue;
    }

    clearTimeout(pendingRequest.timeout);
    pendingBrowserAgentCommandRequests.delete(pendingRequestId);
    pendingRequest.reject(createBrowserAgentCommandCanceledError());
  }
  cleanupBrowserAgentCommandRequestListenersIfIdle();
}

function cancelPendingBrowserTerminalInputSends(requestId: string): void {
  for (const [pendingRequestId, pendingSend] of pendingBrowserTerminalInputSends) {
    if (!matchesPendingBrowserAgentCommandRequestId(requestId, pendingRequestId)) {
      continue;
    }

    pendingBrowserTerminalInputSends.delete(pendingRequestId);
    pendingSend.reject(createBrowserAgentCommandCanceledError());
  }
}

function cleanupBrowserAgentCommandRequestListenersIfIdle(): void {
  if (pendingBrowserAgentCommandRequests.size !== 0) {
    return;
  }

  cleanupBrowserAgentCommandRequestListeners?.();
  cleanupBrowserAgentCommandRequestListeners = null;
}

function ensureBrowserAgentCommandRequestListeners(): void {
  if (cleanupBrowserAgentCommandRequestListeners) {
    return;
  }

  const offResult = browserControlClient.listenMessage('agent-command-result', (message) => {
    const pendingRequest = pendingBrowserAgentCommandRequests.get(message.requestId);
    if (!pendingRequest) {
      return;
    }

    if (pendingRequest.agentId !== message.agentId || pendingRequest.command !== message.command) {
      return;
    }

    clearPendingBrowserAgentCommandRequest(message.requestId);
    if (message.accepted) {
      pendingRequest.resolve();
      return;
    }

    pendingRequest.reject(new Error(message.message ?? `${message.command} failed`));
  });
  const offTransport = browserControlClient.onTransportEvent((event) => {
    if (event.kind !== 'connection') {
      return;
    }

    switch (event.state) {
      case 'auth-expired':
      case 'disconnected':
      case 'reconnecting':
        rejectPendingBrowserAgentCommandRequests(createBrowserSocketUnavailableError());
        break;
      case 'connecting':
      case 'connected':
        break;
      default:
        throw new Error(`Unhandled browser transport state: ${String(event.state)}`);
    }
  });
  cleanupBrowserAgentCommandRequestListeners = () => {
    offResult();
    offTransport();
  };
}

function waitForBrowserAgentCommandResult(
  requestId: string,
  details: {
    agentId: string;
    command: 'input' | 'resize';
  },
  send: () => Promise<void>,
): Promise<void> {
  ensureBrowserAgentCommandRequestListeners();
  return new Promise<void>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      pendingBrowserAgentCommandRequests.delete(requestId);
      cleanupBrowserAgentCommandRequestListenersIfIdle();
      reject(createBrowserAgentCommandTimeoutError());
    }, BROWSER_AGENT_COMMAND_TIMEOUT_MS);

    pendingBrowserAgentCommandRequests.set(requestId, {
      agentId: details.agentId,
      command: details.command,
      reject,
      resolve,
      timeout,
    });

    void send().catch((error) => {
      clearPendingBrowserAgentCommandRequest(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function sendBrowserCommand(message: ClientMessage): Promise<void> {
  await browserControlClient.send(message);
}

async function sendNonQueueableBrowserCommand(
  message: ClientMessage,
  options: {
    canSend?: () => boolean;
    waitForConnection?: boolean;
  } = {},
): Promise<void> {
  if (options.canSend && !options.canSend()) {
    throw createBrowserAgentCommandCanceledError();
  }

  if (options.waitForConnection) {
    await browserControlClient.ensureConnected();
  }

  if (options.canSend && !options.canSend()) {
    throw createBrowserAgentCommandCanceledError();
  }

  if (!browserControlClient.sendIfOpen(message)) {
    throw createBrowserSocketUnavailableError();
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

function shouldCloneInvokeArgs<TChannel extends RendererInvokeChannel>(cmd: TChannel): boolean {
  return cmd !== IPC.WriteToAgent;
}

function getSafeInvokeArgs<TChannel extends RendererInvokeChannel>(
  cmd: TChannel,
  args: RendererInvokeRequestMap[TChannel] | undefined,
): RendererInvokeRequestMap[TChannel] | undefined {
  if (args === undefined) {
    return undefined;
  }

  if (!shouldCloneInvokeArgs(cmd)) {
    return args;
  }

  return cloneInvokeArgs(args);
}

function splitBrowserInputData(data: string): string[] {
  return splitTerminalInputChunks(data, MAX_CLIENT_INPUT_DATA_LENGTH).map((chunk) => chunk.data);
}

function createBrowserInputMessage(
  agentId: string,
  data: string,
  options: {
    controllerId?: string;
    requestId?: string;
    taskId?: string;
    trace?: TerminalInputTraceMessage;
  },
): Extract<ClientMessage, { type: 'input' }> {
  return {
    type: 'input',
    agentId,
    data,
    ...(options.controllerId ? { controllerId: options.controllerId } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
    ...(options.trace ? { trace: options.trace } : {}),
  };
}

function createBrowserTerminalInputTraceMessage(
  update: TerminalInputTraceClientUpdate,
): Extract<ClientMessage, { type: 'terminal-input-trace' }> {
  return {
    type: 'terminal-input-trace',
    agentId: update.agentId,
    outputReceivedAtMs: update.outputReceivedAtMs,
    outputRenderedAtMs: update.outputRenderedAtMs,
    requestId: update.requestId,
  };
}

function createBrowserTerminalTraceClockSyncMessage(
  request: TerminalInputTraceClockSyncRequest,
): Extract<ClientMessage, { type: 'terminal-input-trace-clock-sync' }> {
  return {
    type: 'terminal-input-trace-clock-sync',
    clientSentAtMs: request.clientSentAtMs,
    requestId: request.requestId,
  };
}

function clearTerminalTraceClockSyncTimer(): void {
  if (terminalTraceClockSyncTimer === undefined) {
    return;
  }

  clearTimeout(terminalTraceClockSyncTimer);
  terminalTraceClockSyncTimer = undefined;
}

function scheduleTerminalTraceClockSync(delayMs = TERMINAL_TRACE_CLOCK_SYNC_INTERVAL_MS): void {
  if (isElectronRuntime()) {
    return;
  }

  clearTerminalTraceClockSyncTimer();
  terminalTraceClockSyncTimer = setTimeout(() => {
    requestTerminalTraceClockSyncSamples(TERMINAL_TRACE_CLOCK_SYNC_SAMPLE_COUNT);
  }, delayMs);
}

function requestTerminalTraceClockSyncSamples(sampleCount: number): void {
  if (isElectronRuntime() || sampleCount <= 0 || !browserControlClient.isOpen()) {
    return;
  }

  for (let index = 0; index < sampleCount; index += 1) {
    const requestId = crypto.randomUUID();
    const clientSentAtMs = getLocalTerminalTraceTimestampMs();
    pendingTerminalTraceClockSyncRequests.set(requestId, clientSentAtMs);
    if (
      !browserControlClient.sendIfOpen(
        createBrowserTerminalTraceClockSyncMessage({
          clientSentAtMs,
          requestId,
        }),
      )
    ) {
      pendingTerminalTraceClockSyncRequests.delete(requestId);
      return;
    }
  }

  scheduleTerminalTraceClockSync();
}

function handleTerminalTraceClockSyncResponse(response: TerminalInputTraceClockSyncResponse): void {
  const clientSentAtMs =
    pendingTerminalTraceClockSyncRequests.get(response.requestId) ?? response.clientSentAtMs;
  pendingTerminalTraceClockSyncRequests.delete(response.requestId);
  const clientReceivedAtMs = getLocalTerminalTraceTimestampMs();
  const clientMidpoint = (clientSentAtMs + clientReceivedAtMs) / 2;
  const serverMidpoint = (response.serverReceivedAtMs + response.serverSentAtMs) / 2;
  setTerminalTraceClockAlignment(
    serverMidpoint - clientMidpoint,
    clientReceivedAtMs - clientSentAtMs,
  );
}

function bindTerminalTraceClockSyncLifecycle(): void {
  if (isElectronRuntime() || terminalTraceClockSyncBound) {
    return;
  }

  terminalTraceClockSyncBound = true;
  browserControlClient.listenMessage(
    'terminal-input-trace-clock-sync',
    handleTerminalTraceClockSyncResponse,
  );
  browserControlClient.onAuthenticated(() => {
    pendingTerminalTraceClockSyncRequests.clear();
    clearTerminalTraceClockAlignment();
    requestTerminalTraceClockSyncSamples(TERMINAL_TRACE_CLOCK_SYNC_SAMPLE_COUNT);
  });
  browserControlClient.onTransportEvent((event) => {
    if (event.kind !== 'connection') {
      return;
    }

    switch (event.state) {
      case 'connected':
        requestTerminalTraceClockSyncSamples(TERMINAL_TRACE_CLOCK_SYNC_SAMPLE_COUNT);
        return;
      case 'connecting':
      case 'reconnecting':
        pendingTerminalTraceClockSyncRequests.clear();
        clearTerminalTraceClockSyncTimer();
        return;
      case 'auth-expired':
      case 'disconnected':
        pendingTerminalTraceClockSyncRequests.clear();
        clearTerminalTraceClockSyncTimer();
        clearTerminalTraceClockAlignment();
        return;
      default:
        return;
    }
  });
}

function createBrowserResizeMessage(
  args: Exclude<RendererInvokeRequestMap[IPC.ResizeAgent], undefined>,
  requestId: string,
): Extract<ClientMessage, { type: 'resize' }> {
  return {
    type: 'resize',
    agentId: args.agentId,
    cols: args.cols,
    ...(args.controllerId ? { controllerId: args.controllerId } : {}),
    requestId,
    rows: args.rows,
    ...(args.taskId ? { taskId: args.taskId } : {}),
  };
}

function getBrowserAgentCommandRequestId(
  requestId: string | undefined,
  chunkCount: number,
  chunkIndex: number,
): string {
  if (requestId === undefined) {
    return crypto.randomUUID();
  }

  if (chunkCount === 1) {
    return requestId;
  }

  return `${requestId}:${chunkIndex}`;
}

async function sendBrowserAgentCommand(
  requestId: string,
  details: {
    agentId: string;
    command: 'input' | 'resize';
  },
  message: Extract<ClientMessage, { type: 'input' | 'resize' }>,
): Promise<void> {
  await waitForBrowserAgentCommandResult(requestId, details, () =>
    sendNonQueueableBrowserCommand(message, {
      canSend: () => pendingBrowserAgentCommandRequests.has(requestId),
      waitForConnection: true,
    }),
  );
}

function waitForBrowserTerminalInputSend(
  requestId: string,
  send: () => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    pendingBrowserTerminalInputSends.set(requestId, {
      reject,
    });

    void send()
      .then(() => {
        if (!pendingBrowserTerminalInputSends.has(requestId)) {
          return;
        }

        clearPendingBrowserTerminalInputSend(requestId);
        resolve();
      })
      .catch((error) => {
        if (!pendingBrowserTerminalInputSends.has(requestId)) {
          return;
        }

        clearPendingBrowserTerminalInputSend(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

async function sendBrowserInput(
  agentId: string,
  data: string,
  options: BrowserInputSendOptions = {},
): Promise<void> {
  const inputChunks = splitBrowserInputData(data);
  if (options.awaitCommandResult === false) {
    for (const [index, chunk] of inputChunks.entries()) {
      await sendNonQueueableBrowserCommand(
        createBrowserInputMessage(agentId, chunk, {
          ...(options.controllerId ? { controllerId: options.controllerId } : {}),
          ...(options.taskId ? { taskId: options.taskId } : {}),
          ...(index === 0 && options.requestId ? { requestId: options.requestId } : {}),
          ...(index === 0 && options.trace ? { trace: options.trace } : {}),
        }),
        {
          ...(options.canSend ? { canSend: options.canSend } : {}),
          waitForConnection: true,
        },
      );
    }
    return;
  }

  for (const [index, chunk] of inputChunks.entries()) {
    const requestId = getBrowserAgentCommandRequestId(options.requestId, inputChunks.length, index);
    await sendBrowserAgentCommand(
      requestId,
      { agentId, command: 'input' },
      createBrowserInputMessage(agentId, chunk, {
        ...(options.controllerId ? { controllerId: options.controllerId } : {}),
        requestId,
        ...(options.taskId ? { taskId: options.taskId } : {}),
        ...(index === 0 && options.trace ? { trace: options.trace } : {}),
      }),
    );
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
      await sendBrowserInput(args.agentId, args.data, {
        ...(args.controllerId ? { controllerId: args.controllerId } : {}),
        ...(args.requestId ? { requestId: args.requestId } : {}),
        ...(args.taskId ? { taskId: args.taskId } : {}),
        ...(args.trace ? { trace: args.trace } : {}),
      });
      return undefined;
    }
    case IPC.ResizeAgent: {
      const requestId = args.requestId ?? crypto.randomUUID();
      await sendBrowserAgentCommand(
        requestId,
        { agentId: args.agentId, command: 'resize' },
        createBrowserResizeMessage(args, requestId),
      );
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
  const safeArgs = getSafeInvokeArgs(cmd, argsValue);
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

export async function sendBrowserControlMessage(message: ClientMessage): Promise<void> {
  if (isElectronRuntime()) {
    return;
  }

  await sendBrowserCommand(message);
}

export async function sendImmediateBrowserControlMessage(message: ClientMessage): Promise<void> {
  if (isElectronRuntime()) {
    return;
  }

  await sendNonQueueableBrowserCommand(message);
}

export function sendTerminalInputTraceUpdate(update: TerminalInputTraceClientUpdate): void {
  if (isElectronRuntime()) {
    return;
  }

  if (!browserControlClient.sendIfOpen(createBrowserTerminalInputTraceMessage(update))) {
    return;
  }
}

export async function sendTerminalInput(
  request: Exclude<RendererInvokeRequestMap[IPC.WriteToAgent], undefined>,
): Promise<void> {
  if (isElectronRuntime()) {
    const electron = window.electron?.ipcRenderer;
    if (!electron) {
      throw new Error('Electron IPC bridge is unavailable');
    }

    await invokeElectronTransport(electron, IPC.WriteToAgent, request);
    return;
  }

  if (!request.requestId) {
    await sendBrowserInput(request.agentId, request.data, {
      awaitCommandResult: false,
      ...(request.controllerId ? { controllerId: request.controllerId } : {}),
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.trace ? { trace: request.trace } : {}),
    });
    return;
  }

  const requestId = request.requestId;
  await waitForBrowserTerminalInputSend(requestId, () =>
    sendBrowserInput(request.agentId, request.data, {
      awaitCommandResult: false,
      canSend: () => pendingBrowserTerminalInputSends.has(requestId),
      ...(request.controllerId ? { controllerId: request.controllerId } : {}),
      requestId,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.trace ? { trace: request.trace } : {}),
    }),
  );
}

export type { BrowserServerMessage, BrowserServerMessageType, BrowserTransportEvent };
export { isElectronRuntime, parseBrowserBinaryChannelFrame };

export function resetBrowserAgentCommandRequestStateForTests(): void {
  rejectPendingBrowserAgentCommandRequests(new Error('Browser agent command test state reset'));
  rejectPendingBrowserTerminalInputSends(new Error('Browser terminal input test state reset'));
  cleanupBrowserAgentCommandRequestListeners?.();
  cleanupBrowserAgentCommandRequestListeners = null;
  pendingTerminalTraceClockSyncRequests.clear();
  clearTerminalTraceClockSyncTimer();
  resetTerminalTraceClockAlignmentForTests();
}

export function cancelBrowserAgentCommandRequest(requestId: string): void {
  cancelPendingBrowserAgentCommandRequests(requestId);
  cancelPendingBrowserTerminalInputSends(requestId);
}

export function assertBrowserAgentCommandRequestStateCleanForTests(): void {
  if (pendingBrowserAgentCommandRequests.size !== 0) {
    throw new Error(
      `Expected no pending browser agent command requests, found ${pendingBrowserAgentCommandRequests.size}`,
    );
  }

  if (pendingBrowserTerminalInputSends.size !== 0) {
    throw new Error(
      `Expected no pending browser terminal input sends, found ${pendingBrowserTerminalInputSends.size}`,
    );
  }

  if (cleanupBrowserAgentCommandRequestListeners !== null) {
    throw new Error('Expected no browser agent command request listeners to remain registered');
  }
}

export function getTerminalTraceClockSyncStateForTests(): {
  alignment: ReturnType<typeof getTerminalTraceClockAlignmentSnapshot>;
  pendingRequestCount: number;
  timerScheduled: boolean;
} {
  return {
    alignment: getTerminalTraceClockAlignmentSnapshot(),
    pendingRequestCount: pendingTerminalTraceClockSyncRequests.size,
    timerScheduled: terminalTraceClockSyncTimer !== undefined,
  };
}
