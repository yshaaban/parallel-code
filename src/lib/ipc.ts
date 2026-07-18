import { IPC } from '../../electron/ipc/channels';
import {
  MAX_CLIENT_INPUT_DATA_LENGTH,
  type ClientMessage,
  type PauseReason,
  type TaskCommandLeaseOperation,
  type TaskCommandLeaseResultMessage,
  type TaskControlContext,
} from '../../electron/remote/protocol';
import type {
  RendererInvokeChannel,
  RendererInvokeRequestMap,
  RendererInvokeResponseMap,
} from '../domain/renderer-invoke';
import { BROWSER_CLIENT_ID_HEADER } from '../domain/browser-ipc';
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
  type BrowserControlConnectionState,
  type BrowserServerMessage,
  type BrowserServerMessageListener,
  type BrowserServerMessageType,
  type BrowserTransportEvent,
} from './browser-control-client';
import { createBrowserHttpIpcClient, type BrowserHttpIpcState } from './browser-http-ipc';
import { createRandomId } from './random-id';
import { splitTerminalInputChunks } from './terminal-input-batching';
import {
  recordBrowserControlSendBufferedAmount,
  recordBrowserControlSendCompleted,
} from './terminalLatency';
import { isNonEmptyString } from './type-guards';
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
    __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__?: boolean;
    __parallelCodeBrowserTransportForTests__?: {
      disconnect: (nextState?: BrowserControlConnectionState) => void;
      ensureConnected: () => Promise<void>;
      getConnectionState: () => BrowserControlConnectionState;
      getLastDisconnectDurationMs: () => number | null;
      hasReplayTruncatedSinceDisconnect: () => boolean;
      hasSequenceGapSinceDisconnect: () => boolean;
      hasSequencedMessageSinceDisconnect: () => boolean;
    };
    electron?: {
      getPathForFile?: (file: File) => string;
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

  browserHttpClient.invalidateActiveRequests(error);
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
const BROWSER_TASK_COMMAND_LEASE_TIMEOUT_MS = 10_000;
export const BROWSER_AGENT_COMMAND_CANCELED_ERROR_MESSAGE = 'Browser agent command canceled';
const BROWSER_SOCKET_UNAVAILABLE_ERROR_MESSAGE = 'Browser socket unavailable';
const TERMINAL_TRACE_CLOCK_SYNC_INTERVAL_MS = 15_000;
const TERMINAL_TRACE_CLOCK_SYNC_SAMPLE_COUNT = 4;

interface PendingBrowserAgentCommandRequest {
  agentId: string;
  command: 'input' | 'pause' | 'resize' | 'resume';
  reject: (error: Error) => void;
  resolve: (receivedAtMs: number) => void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
}

interface PendingBrowserTaskCommandLeaseRequest {
  operation: TaskCommandLeaseOperation;
  reject: (error: Error) => void;
  resolve: (message: TaskCommandLeaseResultMessage) => void;
  send: () => Promise<void>;
  sending: boolean;
  sent: boolean;
  timeout?: ReturnType<typeof globalThis.setTimeout>;
}

interface BrowserInputSendOptions {
  awaitCommandResult?: boolean;
  canSend?: () => boolean;
  controllerId?: string;
  inputEpoch?: string;
  inputSeq?: number;
  onCommandResultReceived?: (receivedAtMs: number) => void;
  requestId?: string;
  taskId?: string;
  trace?: TerminalInputTraceMessage;
}

type BrowserInputOrderContext = Partial<
  Pick<Extract<ClientMessage, { type: 'input' }>, 'inputEpoch' | 'inputSeq'>
>;
type BrowserResizeOrderContext = Partial<
  Pick<Extract<ClientMessage, { type: 'resize' }>, 'resizeEpoch' | 'resizeSeq'>
>;

const pendingBrowserAgentCommandRequests = new Map<string, PendingBrowserAgentCommandRequest>();
const pendingBrowserTaskCommandLeaseRequests = new Map<
  string,
  PendingBrowserTaskCommandLeaseRequest
>();
const pendingTerminalTraceClockSyncRequests = new Map<string, number>();
let browserAgentCommandSendChain: Promise<void> = Promise.resolve();
let cleanupBrowserAgentCommandRequestListeners: (() => void) | null = null;
let cleanupBrowserTaskCommandLeaseRequestListeners: (() => void) | null = null;
let terminalTraceClockSyncBound = false;
let terminalTraceClockSyncTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

function createBrowserAgentCommandCanceledError(): Error {
  return new Error(BROWSER_AGENT_COMMAND_CANCELED_ERROR_MESSAGE);
}

function createBrowserAgentCommandTimeoutError(): Error {
  return new Error('Timed out waiting for browser agent command result');
}

function createBrowserTaskCommandLeaseTimeoutError(): Error {
  return new Error('Timed out waiting for browser task-command lease result');
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

// Resolves a channel's ready promise when the AttachTerminalSession RPC
// confirms the server bound the channel for this client, so attach does not
// wait for the separate websocket channel-bound ack.
export function markBrowserChannelBound(channelId: string): void {
  if (isElectronRuntime()) {
    return;
  }

  browserChannelClient.handleChannelBound(channelId);
}

bindTerminalTraceClockSyncLifecycle();
bindBrowserTransportTestHook();

browserControlClient.onTransportEvent(
  (event) => {
    if (event.kind === 'connection' && event.state === 'connected') {
      browserChannelClient.rebindChannels();
    }
  },
  { preserveOnReset: true },
);

function clearPendingBrowserAgentCommandRequest(requestId: string): void {
  const pendingRequest = pendingBrowserAgentCommandRequests.get(requestId);
  if (!pendingRequest) {
    return;
  }

  clearTimeout(pendingRequest.timeout);
  pendingBrowserAgentCommandRequests.delete(requestId);
  cleanupBrowserAgentCommandRequestListenersIfIdle();
}

function clearPendingBrowserTaskCommandLeaseRequest(requestId: string): void {
  const pendingRequest = pendingBrowserTaskCommandLeaseRequests.get(requestId);
  if (!pendingRequest) {
    return;
  }

  if (pendingRequest.timeout !== undefined) {
    clearTimeout(pendingRequest.timeout);
  }
  pendingBrowserTaskCommandLeaseRequests.delete(requestId);
  cleanupBrowserTaskCommandLeaseRequestListenersIfIdle();
}

function bindBrowserTransportTestHook(): void {
  if (
    typeof window === 'undefined' ||
    window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ !== true ||
    window.__parallelCodeBrowserTransportForTests__
  ) {
    return;
  }

  window.__parallelCodeBrowserTransportForTests__ = {
    disconnect: (nextState) => {
      browserControlClient.disconnect(nextState);
    },
    ensureConnected: async () => {
      await browserControlClient.ensureConnected();
    },
    getConnectionState: () => browserControlClient.getConnectionState(),
    getLastDisconnectDurationMs: () => browserControlClient.getLastDisconnectDurationMs(),
    hasReplayTruncatedSinceDisconnect: () =>
      browserControlClient.hasReplayTruncatedSinceDisconnect(),
    hasSequenceGapSinceDisconnect: () => browserControlClient.hasSequenceGapSinceDisconnect(),
    hasSequencedMessageSinceDisconnect: () =>
      browserControlClient.hasSequencedMessageSinceDisconnect(),
  };
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

function cleanupBrowserAgentCommandRequestListenersIfIdle(): void {
  if (pendingBrowserAgentCommandRequests.size !== 0) {
    return;
  }

  cleanupBrowserAgentCommandRequestListeners?.();
  cleanupBrowserAgentCommandRequestListeners = null;
}

function cleanupBrowserTaskCommandLeaseRequestListenersIfIdle(): void {
  if (pendingBrowserTaskCommandLeaseRequests.size !== 0) {
    return;
  }

  cleanupBrowserTaskCommandLeaseRequestListeners?.();
  cleanupBrowserTaskCommandLeaseRequestListeners = null;
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

    const resultReceivedAtMs = performance.now();
    clearPendingBrowserAgentCommandRequest(message.requestId);
    if (message.accepted) {
      pendingRequest.resolve(resultReceivedAtMs);
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

function rejectPendingBrowserTaskCommandLeaseRequests(error: Error): void {
  for (const [requestId, pendingRequest] of pendingBrowserTaskCommandLeaseRequests) {
    if (pendingRequest.timeout !== undefined) {
      clearTimeout(pendingRequest.timeout);
    }
    pendingBrowserTaskCommandLeaseRequests.delete(requestId);
    pendingRequest.reject(error);
  }
  cleanupBrowserTaskCommandLeaseRequestListenersIfIdle();
}

function startBrowserTaskCommandLeaseResultTimeout(requestId: string): void {
  const pendingRequest = pendingBrowserTaskCommandLeaseRequests.get(requestId);
  if (!pendingRequest || pendingRequest.timeout !== undefined) {
    return;
  }

  pendingRequest.timeout = globalThis.setTimeout(() => {
    pendingBrowserTaskCommandLeaseRequests.delete(requestId);
    cleanupBrowserTaskCommandLeaseRequestListenersIfIdle();
    pendingRequest.reject(createBrowserTaskCommandLeaseTimeoutError());
  }, BROWSER_TASK_COMMAND_LEASE_TIMEOUT_MS);
}

function isBrowserTaskCommandLeaseRetryableSendError(): boolean {
  const state = browserControlClient.getConnectionState();
  return state === 'connecting' || state === 'disconnected' || state === 'reconnecting';
}

function attemptPendingBrowserTaskCommandLeaseSend(requestId: string): void {
  const pendingRequest = pendingBrowserTaskCommandLeaseRequests.get(requestId);
  if (!pendingRequest || pendingRequest.sending || pendingRequest.sent) {
    return;
  }

  pendingRequest.sending = true;
  void pendingRequest
    .send()
    .then(() => {
      const currentRequest = pendingBrowserTaskCommandLeaseRequests.get(requestId);
      if (!currentRequest) {
        return;
      }

      currentRequest.sending = false;
      currentRequest.sent = true;
      startBrowserTaskCommandLeaseResultTimeout(requestId);
    })
    .catch((error) => {
      const currentRequest = pendingBrowserTaskCommandLeaseRequests.get(requestId);
      if (!currentRequest) {
        return;
      }

      currentRequest.sending = false;
      if (isBrowserTaskCommandLeaseRetryableSendError()) {
        return;
      }

      clearPendingBrowserTaskCommandLeaseRequest(requestId);
      currentRequest.reject(error instanceof Error ? error : new Error(String(error)));
    });
}

function retryUnsentBrowserTaskCommandLeaseRequests(): void {
  for (const [requestId, pendingRequest] of pendingBrowserTaskCommandLeaseRequests) {
    if (!pendingRequest.sent) {
      attemptPendingBrowserTaskCommandLeaseSend(requestId);
    }
  }
}

function ensureBrowserTaskCommandLeaseRequestListeners(): void {
  if (cleanupBrowserTaskCommandLeaseRequestListeners) {
    return;
  }

  const offResult = browserControlClient.listenMessage('task-command-lease-result', (message) => {
    const pendingRequest = pendingBrowserTaskCommandLeaseRequests.get(message.requestId);
    if (!pendingRequest || pendingRequest.operation !== message.operation) {
      return;
    }

    clearPendingBrowserTaskCommandLeaseRequest(message.requestId);
    if ('error' in message) {
      pendingRequest.reject(new Error(message.error));
      return;
    }

    pendingRequest.resolve(message);
  });
  const offTransport = browserControlClient.onTransportEvent((event) => {
    if (event.kind !== 'connection') {
      return;
    }

    switch (event.state) {
      case 'auth-expired':
        rejectPendingBrowserTaskCommandLeaseRequests(createBrowserSocketUnavailableError());
        break;
      case 'disconnected':
      case 'reconnecting':
      case 'connecting':
        break;
      case 'connected':
        retryUnsentBrowserTaskCommandLeaseRequests();
        break;
      default:
        throw new Error(`Unhandled browser transport state: ${String(event.state)}`);
    }
  });
  cleanupBrowserTaskCommandLeaseRequestListeners = () => {
    offResult();
    offTransport();
  };
}

function waitForBrowserAgentCommandResult(
  requestId: string,
  details: {
    agentId: string;
    command: 'input' | 'pause' | 'resize' | 'resume';
  },
  send: () => Promise<void>,
): Promise<number> {
  ensureBrowserAgentCommandRequestListeners();
  return new Promise<number>((resolve, reject) => {
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

function waitForBrowserTaskCommandLeaseResult(
  requestId: string,
  operation: TaskCommandLeaseOperation,
  send: () => Promise<void>,
): Promise<TaskCommandLeaseResultMessage> {
  ensureBrowserTaskCommandLeaseRequestListeners();
  return new Promise<TaskCommandLeaseResultMessage>((resolve, reject) => {
    pendingBrowserTaskCommandLeaseRequests.set(requestId, {
      operation,
      reject,
      resolve,
      send,
      sending: false,
      sent: false,
    });

    attemptPendingBrowserTaskCommandLeaseSend(requestId);
  });
}

async function sendBrowserCommand(message: ClientMessage): Promise<void> {
  await browserControlClient.send(message);
}

function enqueueBrowserAgentCommandSend(send: () => Promise<void>): Promise<void> {
  const run = browserAgentCommandSendChain.then(send, send);
  browserAgentCommandSendChain = run.catch(() => undefined);
  return run;
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

  recordBrowserControlSendBufferedAmount(message.type, browserControlClient.getBufferedAmount());

  const sendStartedAtMs = performance.now();
  const sent = browserControlClient.sendIfOpen(message);
  recordBrowserControlSendCompleted(
    message.type,
    performance.now() - sendStartedAtMs,
    browserControlClient.getBufferedAmount(),
  );

  if (!sent) {
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

export function getBrowserTransportConnectionState(): BrowserControlConnectionState {
  if (isElectronRuntime()) {
    return 'disconnected';
  }

  return browserControlClient.getConnectionState();
}

export function isBrowserControlAuthenticated(): boolean {
  if (isElectronRuntime()) {
    return false;
  }

  return browserControlClient.isAuthenticated();
}

export function onBrowserAuthenticated(listener: () => void): () => void {
  if (isElectronRuntime()) {
    return () => {};
  }

  return browserControlClient.onAuthenticated(listener);
}

export class Channel<T> {
  private browserChannelState: BrowserChannelState<T> | null = null;
  private _id: string = createRandomId();
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

  dispose(): void {
    this.onmessage = null;
    this.cleanup?.();
    this.cleanup = null;
    this.browserChannelState = null;
  }
}

type InvokeArgs<TChannel extends RendererInvokeChannel> =
  undefined extends RendererInvokeRequestMap[TChannel]
    ? [args?: RendererInvokeRequestMap[TChannel]]
    : [args: RendererInvokeRequestMap[TChannel]];

type BrowserTaskCommandLeaseChannel =
  | IPC.AcquireTaskCommandLease
  | IPC.RenewTaskCommandLease
  | IPC.ReleaseTaskCommandLease;

type BrowserTaskCommandLeaseMessage = Extract<ClientMessage, { type: 'task-command-lease' }>;

type BrowserPauseResumeChannel = IPC.PauseAgent | IPC.ResumeAgent;

type BrowserPauseResumeRequest =
  | Exclude<RendererInvokeRequestMap[IPC.PauseAgent], undefined>
  | Exclude<RendererInvokeRequestMap[IPC.ResumeAgent], undefined>;

type BrowserControlChannel =
  | BrowserTaskCommandLeaseChannel
  | IPC.AttachTerminalSession
  | IPC.EnsureAgentSessionsBatch
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

const BROWSER_CONTROL_CHANNELS = {
  [IPC.AcquireTaskCommandLease]: true,
  [IPC.AttachTerminalSession]: true,
  [IPC.EnsureAgentSessionsBatch]: true,
  [IPC.KillAgent]: true,
  [IPC.PauseAgent]: true,
  [IPC.ReleaseTaskCommandLease]: true,
  [IPC.RenewTaskCommandLease]: true,
  [IPC.ResizeAgent]: true,
  [IPC.ResumeAgent]: true,
  [IPC.SpawnAgent]: true,
  [IPC.WriteToAgent]: true,
} satisfies Record<BrowserControlChannel, true>;

function isBrowserControlChannel(channel: RendererInvokeChannel): channel is BrowserControlChannel {
  return Object.prototype.hasOwnProperty.call(BROWSER_CONTROL_CHANNELS, channel);
}

function cloneInvokeArgs<TChannel extends RendererInvokeChannel>(
  args: RendererInvokeRequestMap[TChannel],
): RendererInvokeRequestMap[TChannel] {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(args);
    } catch {
      // Payloads carrying non-cloneable values (for example Channel refs with
      // a toJSON) fall back to the JSON round trip below.
    }
  }

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

function createBrowserTaskControlContext(options: {
  controllerId?: string;
  taskId?: string;
}): TaskControlContext {
  return options.controllerId && options.taskId
    ? {
        controllerId: options.controllerId,
        taskId: options.taskId,
      }
    : {};
}

function createBrowserInputOrderContext(options: {
  inputEpoch?: string | undefined;
  inputSeq?: number | undefined;
}): BrowserInputOrderContext {
  if (options.inputEpoch === undefined || options.inputSeq === undefined) {
    return {};
  }

  return {
    inputEpoch: options.inputEpoch,
    inputSeq: options.inputSeq,
  };
}

function createBrowserInputChunkOrderContext(
  options: {
    inputEpoch?: string | undefined;
    inputSeq?: number | undefined;
  },
  chunkIndex: number,
): BrowserInputOrderContext {
  return createBrowserInputOrderContext({
    inputEpoch: options.inputEpoch,
    inputSeq: options.inputSeq !== undefined ? options.inputSeq + chunkIndex : undefined,
  });
}

function createBrowserResizeOrderContext(options: {
  resizeEpoch?: string | undefined;
  resizeSeq?: number | undefined;
}): BrowserResizeOrderContext {
  if (options.resizeEpoch === undefined || options.resizeSeq === undefined) {
    return {};
  }

  return {
    resizeEpoch: options.resizeEpoch,
    resizeSeq: options.resizeSeq,
  };
}

function createBrowserInputMessage(
  agentId: string,
  data: string,
  options: {
    controllerId?: string;
    inputEpoch?: string;
    inputSeq?: number;
    requestId?: string;
    taskId?: string;
    trace?: TerminalInputTraceMessage;
  },
): Extract<ClientMessage, { type: 'input' }> {
  return {
    type: 'input',
    agentId,
    data,
    ...createBrowserTaskControlContext(options),
    ...createBrowserInputOrderContext(options),
    ...(options.requestId ? { requestId: options.requestId } : {}),
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
    ...(update.outputTransportReceivedAtMs !== undefined
      ? { outputTransportReceivedAtMs: update.outputTransportReceivedAtMs }
      : {}),
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
    const requestId = createRandomId();
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
    { preserveOnReset: true },
  );
  browserControlClient.onAuthenticated(
    () => {
      pendingTerminalTraceClockSyncRequests.clear();
      clearTerminalTraceClockAlignment();
      requestTerminalTraceClockSyncSamples(TERMINAL_TRACE_CLOCK_SYNC_SAMPLE_COUNT);
    },
    { preserveOnReset: true },
  );
  browserControlClient.onTransportEvent(
    (event) => {
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
    },
    { preserveOnReset: true },
  );
}

function createBrowserResizeMessage(
  args: Exclude<RendererInvokeRequestMap[IPC.ResizeAgent], undefined>,
  requestId: string,
): Extract<ClientMessage, { type: 'resize' }> {
  return {
    type: 'resize',
    agentId: args.agentId,
    cols: args.cols,
    ...createBrowserTaskControlContext(args),
    requestId,
    ...createBrowserResizeOrderContext(args),
    rows: args.rows,
  };
}

function getBrowserTaskCommandLeaseOperation(
  channel: BrowserTaskCommandLeaseChannel,
): TaskCommandLeaseOperation {
  switch (channel) {
    case IPC.AcquireTaskCommandLease:
      return 'acquire';
    case IPC.RenewTaskCommandLease:
      return 'renew';
    case IPC.ReleaseTaskCommandLease:
      return 'release';
  }
}

function createBrowserTaskCommandLeaseMessage<TChannel extends BrowserTaskCommandLeaseChannel>(
  channel: TChannel,
  args: Exclude<RendererInvokeRequestMap[TChannel], undefined>,
  requestId: string,
): BrowserTaskCommandLeaseMessage {
  switch (channel) {
    case IPC.AcquireTaskCommandLease: {
      const acquireArgs = args as Exclude<
        RendererInvokeRequestMap[IPC.AcquireTaskCommandLease],
        undefined
      >;
      const message: Extract<BrowserTaskCommandLeaseMessage, { operation: 'acquire' }> = {
        type: 'task-command-lease',
        action: acquireArgs.action,
        operation: 'acquire',
        ownerId: acquireArgs.ownerId,
        requestId,
        taskId: acquireArgs.taskId,
      };
      if (acquireArgs.takeover) {
        message.takeover = true;
      }
      return message;
    }
    case IPC.RenewTaskCommandLease: {
      const renewArgs = args as Exclude<
        RendererInvokeRequestMap[IPC.RenewTaskCommandLease],
        undefined
      >;
      const message: Extract<BrowserTaskCommandLeaseMessage, { operation: 'renew' }> = {
        type: 'task-command-lease',
        operation: 'renew',
        ownerId: renewArgs.ownerId,
        requestId,
        taskId: renewArgs.taskId,
      };
      if (renewArgs.leaseGeneration !== undefined) {
        message.leaseGeneration = renewArgs.leaseGeneration;
      }
      return message;
    }
    case IPC.ReleaseTaskCommandLease: {
      const releaseArgs = args as Exclude<
        RendererInvokeRequestMap[IPC.ReleaseTaskCommandLease],
        undefined
      >;
      const message: Extract<BrowserTaskCommandLeaseMessage, { operation: 'release' }> = {
        type: 'task-command-lease',
        operation: 'release',
        ownerId: releaseArgs.ownerId,
        requestId,
        taskId: releaseArgs.taskId,
      };
      if (releaseArgs.leaseGeneration !== undefined) {
        message.leaseGeneration = releaseArgs.leaseGeneration;
      }
      return message;
    }
  }
}

function getBrowserAgentCommandRequestId(
  requestId: string | undefined,
  chunkCount: number,
  chunkIndex: number,
): string {
  if (requestId === undefined) {
    return createRandomId();
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
): Promise<number> {
  return await waitForBrowserAgentCommandResult(requestId, details, () =>
    enqueueBrowserAgentCommandSend(() =>
      sendNonQueueableBrowserCommand(message, {
        canSend: () => pendingBrowserAgentCommandRequests.has(requestId),
        waitForConnection: true,
      }),
    ),
  );
}

async function sendBrowserPauseResumeCommand(
  requestId: string,
  details: {
    agentId: string;
    command: 'pause' | 'resume';
  },
  message: Extract<ClientMessage, { type: 'pause' | 'resume' }>,
): Promise<void> {
  await waitForBrowserAgentCommandResult(requestId, details, () =>
    sendNonQueueableBrowserCommand(message, {
      canSend: () => pendingBrowserAgentCommandRequests.has(requestId),
      waitForConnection: message.reason === 'restore',
    }),
  );
}

async function sendBrowserTaskCommandLease<TChannel extends BrowserTaskCommandLeaseChannel>(
  channel: TChannel,
  args: Exclude<RendererInvokeRequestMap[TChannel], undefined>,
): Promise<RendererInvokeResponseMap[TChannel]> {
  const requestId = createRandomId();
  const operation = getBrowserTaskCommandLeaseOperation(channel);
  const resultMessage = await waitForBrowserTaskCommandLeaseResult(requestId, operation, () =>
    sendNonQueueableBrowserCommand(createBrowserTaskCommandLeaseMessage(channel, args, requestId), {
      canSend: () => pendingBrowserTaskCommandLeaseRequests.has(requestId),
      waitForConnection: true,
    }),
  );

  if ('error' in resultMessage) {
    throw new Error(resultMessage.error);
  }

  return resultMessage.result as RendererInvokeResponseMap[TChannel];
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
          ...createBrowserInputChunkOrderContext(options, index),
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

  let commandResultReceivedAtMs: number | null = null;
  for (const [index, chunk] of inputChunks.entries()) {
    const requestId = getBrowserAgentCommandRequestId(options.requestId, inputChunks.length, index);
    commandResultReceivedAtMs = await sendBrowserAgentCommand(
      requestId,
      { agentId, command: 'input' },
      createBrowserInputMessage(agentId, chunk, {
        ...(options.controllerId ? { controllerId: options.controllerId } : {}),
        ...createBrowserInputChunkOrderContext(options, index),
        requestId,
        ...(options.taskId ? { taskId: options.taskId } : {}),
        ...(index === 0 && options.trace ? { trace: options.trace } : {}),
      }),
    );
  }

  if (commandResultReceivedAtMs !== null) {
    options.onCommandResultReceived?.(commandResultReceivedAtMs);
  }
}

function invokeElectronTransport<TChannel extends RendererInvokeChannel>(
  electron: NonNullable<Window['electron']>['ipcRenderer'],
  cmd: TChannel,
  args: RendererInvokeRequestMap[TChannel] | undefined,
): Promise<RendererInvokeResponseMap[TChannel]> {
  return electron.invoke(cmd, args);
}

function settleConsumerOnAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => {
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', handleAbort);
    });
  });
}

function createAutomaticPauseResumeCommand(
  type: 'pause' | 'resume',
  request: BrowserPauseResumeRequest,
  requestId?: string,
): Extract<ClientMessage, { type: 'pause' | 'resume' }> | null {
  const reason = getPauseReason(request.reason);
  if (reason !== 'flow-control' && reason !== 'restore') {
    return null;
  }

  const channelId = isNonEmptyString(request.channelId) ? request.channelId : undefined;
  if (request.restoreLeaseId !== undefined && !isNonEmptyString(request.restoreLeaseId)) {
    return null;
  }

  const restoreLeaseId = request.restoreLeaseId;
  if (restoreLeaseId !== undefined && reason !== 'restore') {
    return null;
  }

  return {
    type,
    agentId: request.agentId,
    reason,
    ...(channelId ? { channelId } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(restoreLeaseId !== undefined ? { restoreLeaseId } : {}),
  };
}

function createPauseControlRequest(
  request: BrowserPauseResumeRequest,
): RendererInvokeRequestMap[IPC.PauseAgent] {
  const channelId = isNonEmptyString(request.channelId) ? request.channelId : undefined;
  const reason = getPauseReason(request.reason);
  const restoreLeaseId =
    typeof request.restoreLeaseId === 'string' ? request.restoreLeaseId : undefined;
  return {
    agentId: request.agentId,
    ...(channelId ? { channelId } : {}),
    ...(reason ? { reason } : {}),
    ...(restoreLeaseId !== undefined ? { restoreLeaseId } : {}),
  };
}

async function sendBrowserPauseResumeWithFallback(
  cmd: BrowserPauseResumeChannel,
  type: 'pause' | 'resume',
  args: BrowserPauseResumeRequest,
): Promise<void> {
  const shouldTrackResult = args.reason === 'restore';
  const requestId = shouldTrackResult ? createRandomId() : undefined;
  const message = createAutomaticPauseResumeCommand(type, args, requestId);
  if (message) {
    if (requestId !== undefined) {
      await sendBrowserPauseResumeCommand(
        requestId,
        { agentId: args.agentId, command: type },
        message,
      );
    } else {
      await sendNonQueueableBrowserCommand(message);
    }
    return;
  }

  await browserHttpClient.fetch(cmd, createPauseControlRequest(args));
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
  call: BrowserControlCall,
): Promise<RendererInvokeResponseMap[BrowserControlChannel]> {
  const [cmd, args] = call;
  switch (cmd) {
    case IPC.AcquireTaskCommandLease:
    case IPC.RenewTaskCommandLease:
    case IPC.ReleaseTaskCommandLease:
      return sendBrowserTaskCommandLease(cmd, args);
    case IPC.WriteToAgent: {
      await sendBrowserInput(args.agentId, args.data, {
        ...(args.controllerId ? { controllerId: args.controllerId } : {}),
        ...createBrowserInputOrderContext(args),
        ...(args.requestId ? { requestId: args.requestId } : {}),
        ...(args.taskId ? { taskId: args.taskId } : {}),
        ...(args.trace ? { trace: args.trace } : {}),
      });
      return undefined;
    }
    case IPC.ResizeAgent: {
      const requestId = args.requestId ?? createRandomId();
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
      await sendBrowserPauseResumeWithFallback(IPC.PauseAgent, 'pause', args);
      return undefined;
    }
    case IPC.ResumeAgent: {
      await sendBrowserPauseResumeWithFallback(IPC.ResumeAgent, 'resume', args);
      return undefined;
    }
    case IPC.SpawnAgent:
      browserControlClient.bindLifecycle();
      await browserControlClient.ensureConnected();
      return browserHttpClient.fetch(IPC.SpawnAgent, args);
    case IPC.AttachTerminalSession:
      // The websocket must be connected before the RPC so the server can bind
      // the output channel for this client inside the same round trip.
      browserControlClient.bindLifecycle();
      await browserControlClient.ensureConnected();
      return browserHttpClient.fetch(IPC.AttachTerminalSession, args);
    case IPC.EnsureAgentSessionsBatch:
      browserControlClient.bindLifecycle();
      await browserControlClient.ensureConnected();
      return browserHttpClient.fetch(IPC.EnsureAgentSessionsBatch, args);
  }
}

function invokeBrowserTransport<TChannel extends RendererInvokeChannel>(
  cmd: TChannel,
  args: Exclude<RendererInvokeRequestMap[TChannel], undefined>,
): Promise<RendererInvokeResponseMap[TChannel]> {
  if (isBrowserControlChannel(cmd)) {
    return browserInvoke([cmd, args] as BrowserControlCall) as Promise<
      RendererInvokeResponseMap[TChannel]
    >;
  }

  return browserHttpClient.fetch(cmd, args);
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

export async function invokeWithAbortSignal<TChannel extends RendererInvokeChannel>(
  cmd: TChannel,
  signal: AbortSignal,
  ...args: InvokeArgs<TChannel>
): Promise<RendererInvokeResponseMap[TChannel]> {
  signal.throwIfAborted();
  const [argsValue] = args;
  const safeArgs = getSafeInvokeArgs(cmd, argsValue);
  let result: RendererInvokeResponseMap[TChannel];

  if (isElectronRuntime()) {
    const electron = window.electron?.ipcRenderer;
    if (!electron) {
      throw new Error('Electron IPC bridge is unavailable');
    }

    // Electron cannot cancel work already admitted by the main process, but
    // the renderer-side consumer must still release its reactive ownership
    // promptly when the request is no longer relevant.
    result = await settleConsumerOnAbort(invokeElectronTransport(electron, cmd, safeArgs), signal);
  } else {
    if (isBrowserControlChannel(cmd)) {
      throw new Error(`Abortable browser IPC is unsupported for control channel ${cmd}`);
    }

    result = await browserHttpClient.fetchCancellable(cmd, safeArgs, signal);
  }

  signal.throwIfAborted();
  return result;
}

export function sendPagehideInvoke<TChannel extends RendererInvokeChannel>(
  cmd: TChannel,
  args: Exclude<RendererInvokeRequestMap[TChannel], undefined>,
  onError?: (err: unknown) => void,
): void {
  if (isElectronRuntime()) {
    invoke(cmd, args).catch((err: unknown) => {
      console.error(`[IPC pagehide] ${cmd} failed:`, err);
      onError?.(err);
    });
    return;
  }

  const url = `/api/ipc/${encodeURIComponent(cmd)}`;
  const body = JSON.stringify(args);
  const browserClientId = getBrowserClientId();
  const requiresBrowserClientIdentity =
    cmd === IPC.AcquireTaskCommandLease ||
    cmd === IPC.RenewTaskCommandLease ||
    cmd === IPC.ReleaseTaskCommandLease;

  if (
    !requiresBrowserClientIdentity &&
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function'
  ) {
    try {
      const payload = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(url, payload)) {
        return;
      }
    } catch {
      // Fall through to keepalive fetch.
    }
  }

  void fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      ...(browserClientId ? { [BROWSER_CLIENT_ID_HEADER]: browserClientId } : {}),
    },
    body,
  }).catch((err: unknown) => {
    console.error(`[IPC pagehide] ${cmd} failed:`, err);
    onError?.(err);
  });
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

export type { BrowserResyncStateProvider } from './browser-control-client';

// Injection seam for the reconnect version handshake: the app layer owns the
// per-category version collection (lib must not import app), and the control
// client presents it on reconnect socket URLs.
export function setBrowserResyncStateProvider(
  provider: (() => { categoryVersions: Record<string, number> } | null) | null,
): void {
  if (isElectronRuntime()) {
    return;
  }

  browserControlClient.setResyncStateProvider(provider);
}

export function getBrowserReconnectContinuity(): {
  disconnectedDurationMs: number | null;
  hasReplayTruncatedSinceDisconnect: boolean;
  hasSequenceGapSinceDisconnect: boolean;
  hasSequencedMessageSinceDisconnect: boolean;
} {
  if (isElectronRuntime()) {
    return {
      disconnectedDurationMs: null,
      hasReplayTruncatedSinceDisconnect: false,
      hasSequenceGapSinceDisconnect: false,
      hasSequencedMessageSinceDisconnect: false,
    };
  }

  return {
    disconnectedDurationMs: browserControlClient.getLastDisconnectDurationMs(),
    hasReplayTruncatedSinceDisconnect: browserControlClient.hasReplayTruncatedSinceDisconnect(),
    hasSequenceGapSinceDisconnect: browserControlClient.hasSequenceGapSinceDisconnect(),
    hasSequencedMessageSinceDisconnect: browserControlClient.hasSequencedMessageSinceDisconnect(),
  };
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
  options: {
    onBrowserCommandResultReceived?: (receivedAtMs: number) => void;
  } = {},
): Promise<void> {
  if (isElectronRuntime()) {
    const electron = window.electron?.ipcRenderer;
    if (!electron) {
      throw new Error('Electron IPC bridge is unavailable');
    }

    const inputChunks = splitBrowserInputData(request.data);
    const requestWithoutTrace = { ...request };
    delete requestWithoutTrace.trace;
    for (const [index, chunk] of inputChunks.entries()) {
      const baseRequest = index === 0 ? request : requestWithoutTrace;
      await invokeElectronTransport(electron, IPC.WriteToAgent, {
        ...baseRequest,
        data: chunk,
        ...createBrowserInputChunkOrderContext(request, index),
        ...(request.requestId !== undefined && inputChunks.length > 1
          ? {
              requestId: getBrowserAgentCommandRequestId(
                request.requestId,
                inputChunks.length,
                index,
              ),
            }
          : {}),
      });
    }
    return;
  }

  const requestId = request.requestId ?? createRandomId();
  await sendBrowserInput(request.agentId, request.data, {
    canSend: () => pendingBrowserAgentCommandRequests.has(requestId),
    ...(request.controllerId ? { controllerId: request.controllerId } : {}),
    ...createBrowserInputOrderContext(request),
    ...(options.onBrowserCommandResultReceived
      ? { onCommandResultReceived: options.onBrowserCommandResultReceived }
      : {}),
    requestId,
    ...(request.taskId ? { taskId: request.taskId } : {}),
    ...(request.trace ? { trace: request.trace } : {}),
  });
}

export type { BrowserServerMessage, BrowserServerMessageType, BrowserTransportEvent };
export { isElectronRuntime, parseBrowserBinaryChannelFrame };

export function resetBrowserAgentCommandRequestStateForTests(): void {
  rejectPendingBrowserAgentCommandRequests(new Error('Browser agent command test state reset'));
  rejectPendingBrowserTaskCommandLeaseRequests(
    new Error('Browser task-command lease test state reset'),
  );
  cleanupBrowserAgentCommandRequestListeners?.();
  cleanupBrowserAgentCommandRequestListeners = null;
  cleanupBrowserTaskCommandLeaseRequestListeners?.();
  cleanupBrowserTaskCommandLeaseRequestListeners = null;
  browserAgentCommandSendChain = Promise.resolve();
  pendingTerminalTraceClockSyncRequests.clear();
  clearTerminalTraceClockSyncTimer();
  resetTerminalTraceClockAlignmentForTests();
}

export function resetBrowserTransportStateForTests(): void {
  resetBrowserAgentCommandRequestStateForTests();
  browserControlClient.resetForTests();
  browserChannelClient.resetForTests();
  browserHttpClient.resetForTests();
}

export function cancelBrowserAgentCommandRequest(requestId: string): void {
  cancelPendingBrowserAgentCommandRequests(requestId);
}

export function assertBrowserAgentCommandRequestStateCleanForTests(): void {
  if (pendingBrowserAgentCommandRequests.size !== 0) {
    throw new Error(
      `Expected no pending browser agent command requests, found ${pendingBrowserAgentCommandRequests.size}`,
    );
  }

  if (cleanupBrowserAgentCommandRequestListeners !== null) {
    throw new Error('Expected no browser agent command request listeners to remain registered');
  }

  if (pendingBrowserTaskCommandLeaseRequests.size !== 0) {
    throw new Error(
      `Expected no pending browser task-command lease requests, found ${pendingBrowserTaskCommandLeaseRequests.size}`,
    );
  }

  if (cleanupBrowserTaskCommandLeaseRequestListeners !== null) {
    throw new Error(
      'Expected no browser task-command lease request listeners to remain registered',
    );
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
