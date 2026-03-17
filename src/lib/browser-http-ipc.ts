import { IPC } from '../../electron/ipc/channels';
import type {
  RendererInvokeChannel,
  RendererInvokeRequestMap,
  RendererInvokeResponseMap,
} from '../domain/renderer-invoke';

const MAX_RETRIES = 3;
const MAX_QUEUE_DEPTH = 20;
const PENDING_REQUEST_RETRY_BASE_MS = 250;
const PENDING_REQUEST_RETRY_MAX_MS = 2_000;
const DEDUPED_PENDING_REQUESTS = new Set<RendererInvokeChannel>([
  IPC.SaveAppState,
  IPC.LoadAppState,
  IPC.SaveWorkspaceState,
  IPC.LoadWorkspaceState,
]);
const DURABLE_QUEUE_KEY = 'ipc-durable-queue';
const BROWSER_UNREACHABLE_MESSAGE = 'Unable to reach the Parallel Code server.';

type BrowserInvokeRequest = RendererInvokeRequestMap[RendererInvokeChannel];
type UndefinedRendererInvokeChannel = {
  [TChannel in RendererInvokeChannel]: RendererInvokeResponseMap[TChannel] extends undefined
    ? TChannel
    : never;
}[RendererInvokeChannel];

interface PendingRequest<TChannel extends RendererInvokeChannel = RendererInvokeChannel> {
  args?: RendererInvokeRequestMap[TChannel];
  cmd: TChannel;
  durable?: boolean;
  reject(reason: unknown): void;
  resolve(value: unknown): void;
  retries: number;
}

type BrowserInvokeResponseEnvelope<TChannel extends RendererInvokeChannel> =
  | {
      error?: string;
      result: RendererInvokeResponseMap[TChannel];
    }
  | {
      error?: string;
    };

const UNDEFINED_RENDERER_INVOKE_CHANNELS = new Set<UndefinedRendererInvokeChannel>([
  IPC.CommitAll,
  IPC.DeleteTask,
  IPC.DetachAgentOutput,
  IPC.DiscardUncommitted,
  IPC.KillAgent,
  IPC.KillAllAgents,
  IPC.PauseAgent,
  IPC.PushTask,
  IPC.RebaseTask,
  IPC.RemoveArenaWorktree,
  IPC.ResetBackendRuntimeDiagnostics,
  IPC.ResizeAgent,
  IPC.ResumeAgent,
  IPC.SaveAppState,
  IPC.SaveArenaData,
  IPC.ShellOpenInEditor,
  IPC.ShellReveal,
  IPC.SpawnAgent,
  IPC.StopRemoteServer,
  IPC.WindowClose,
  IPC.WindowForceClose,
  IPC.WindowHide,
  IPC.WindowMaximize,
  IPC.WindowMinimize,
  IPC.WindowSetPosition,
  IPC.WindowSetSize,
  IPC.WindowToggleMaximize,
  IPC.WindowUnmaximize,
  IPC.WriteToAgent,
]);

export interface BrowserHttpIpcClient {
  clearDurableQueueStorage: () => void;
  fetch: <TChannel extends RendererInvokeChannel>(
    cmd: TChannel,
    args?: RendererInvokeRequestMap[TChannel],
  ) => Promise<RendererInvokeResponseMap[TChannel]>;
  getQueueDepth: () => number;
  onStateChange: (listener: (state: BrowserHttpIpcState) => void) => () => void;
  rejectPendingRequests: (error: unknown) => void;
}

export type BrowserHttpIpcState = 'available' | 'unreachable' | 'auth-expired';

export interface CreateBrowserHttpIpcClientOptions {
  enabled?: boolean;
  getToken: () => string | null;
  onAuthExpired: (error: Error) => void;
  onServerError: (message: string) => void;
  onUnreachable: (message: string) => void;
}

class QueueableBrowserFetchError extends Error {
  originalError: unknown;

  constructor(message: string, originalError: unknown) {
    super(message);
    this.name = 'QueueableBrowserFetchError';
    this.originalError = originalError;
  }
}

function getRequestReason(args: BrowserInvokeRequest | undefined): unknown {
  if (!args || typeof args !== 'object' || !('reason' in args)) {
    return undefined;
  }

  return args.reason;
}

function isDurablePendingRequest(
  cmd: RendererInvokeChannel,
  args: BrowserInvokeRequest | undefined,
): boolean {
  if (cmd === IPC.KillAgent) {
    return true;
  }

  if (cmd !== IPC.PauseAgent && cmd !== IPC.ResumeAgent) {
    return false;
  }

  const reason = getRequestReason(args);
  return reason === undefined || reason === 'manual';
}

function getPendingRequestRetryDelay(retries: number): number {
  return Math.min(
    PENDING_REQUEST_RETRY_BASE_MS * Math.pow(2, Math.max(0, retries - 1)),
    PENDING_REQUEST_RETRY_MAX_MS,
  );
}

interface StoredPendingRequest {
  args?: BrowserInvokeRequest;
  cmd: RendererInvokeChannel;
  retries: number;
}

async function readResponseEnvelope<TChannel extends RendererInvokeChannel>(
  response: Response,
): Promise<BrowserInvokeResponseEnvelope<TChannel>> {
  const data: unknown = await response.json().catch(() => ({}));
  if (typeof data !== 'object' || data === null) {
    return {};
  }

  return data as BrowserInvokeResponseEnvelope<TChannel>;
}

function isUndefinedRendererInvokeChannel(
  channel: RendererInvokeChannel,
): channel is UndefinedRendererInvokeChannel {
  return UNDEFINED_RENDERER_INVOKE_CHANNELS.has(channel as UndefinedRendererInvokeChannel);
}

function getResponseResult<TChannel extends RendererInvokeChannel>(
  cmd: TChannel,
  envelope: BrowserInvokeResponseEnvelope<TChannel>,
): RendererInvokeResponseMap[TChannel];
function getResponseResult(
  cmd: RendererInvokeChannel,
  envelope: BrowserInvokeResponseEnvelope<RendererInvokeChannel>,
): unknown {
  if ('result' in envelope) {
    return envelope.result;
  }

  if (isUndefinedRendererInvokeChannel(cmd)) {
    return undefined;
  }

  throw new Error(`IPC response for ${cmd} was missing a result payload`);
}

export function createBrowserHttpIpcClient(
  options: CreateBrowserHttpIpcClientOptions,
): BrowserHttpIpcClient {
  const pendingRequestQueue: PendingRequest[] = [];
  const stateListeners = new Set<(state: BrowserHttpIpcState) => void>();

  let drainingPendingRequestQueue = false;
  let pendingRequestDrainTimer: number | null = null;
  let browserQueueLifecycleBound = false;
  let state: BrowserHttpIpcState = 'available';

  function setState(nextState: BrowserHttpIpcState): void {
    if (state === nextState) {
      return;
    }

    state = nextState;
    stateListeners.forEach((listener) => listener(nextState));
  }

  function clearDurableQueueStorage(): void {
    if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') {
      return;
    }

    sessionStorage.removeItem(DURABLE_QUEUE_KEY);
  }

  function saveDurableQueue(): void {
    if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') {
      return;
    }

    const durableRequests = pendingRequestQueue
      .filter((request) => request.durable)
      .map((request) => ({
        cmd: request.cmd,
        args: request.args,
        retries: 0,
      }));

    if (durableRequests.length === 0) {
      sessionStorage.removeItem(DURABLE_QUEUE_KEY);
      return;
    }

    sessionStorage.setItem(DURABLE_QUEUE_KEY, JSON.stringify(durableRequests));
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
    existing.durable = existing.durable === true || next.durable === true;
  }

  function enqueuePendingRequest(request: PendingRequest): void {
    if (DEDUPED_PENDING_REQUESTS.has(request.cmd)) {
      for (let index = pendingRequestQueue.length - 1; index >= 0; index -= 1) {
        const existing = pendingRequestQueue[index];
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

  function rejectPendingRequests(error: unknown): void {
    pendingRequestQueue.splice(0).forEach((request) => request.reject(error));
    saveDurableQueue();
  }

  function bindLifecycle(): void {
    if (browserQueueLifecycleBound || typeof window === 'undefined') {
      return;
    }

    browserQueueLifecycleBound = true;

    const retryDrain = () => {
      if (pendingRequestQueue.length === 0) {
        return;
      }

      schedulePendingRequestQueueDrain();
    };

    window.addEventListener('online', retryDrain);
    window.addEventListener('pageshow', retryDrain);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        retryDrain();
      }
    });
  }

  function schedulePendingRequestQueueDrain(delayMs = 0): void {
    if (pendingRequestDrainTimer !== null || typeof window === 'undefined') {
      return;
    }
    if (pendingRequestQueue.length === 0) {
      return;
    }

    pendingRequestDrainTimer = window.setTimeout(() => {
      pendingRequestDrainTimer = null;
      void drainPendingRequestQueue();
    }, delayMs);
  }

  function loadDurableQueue(): void {
    if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') {
      return;
    }

    const stored = sessionStorage.getItem(DURABLE_QUEUE_KEY);
    if (!stored) {
      return;
    }

    try {
      const durableRequests = JSON.parse(stored) as StoredPendingRequest[];

      for (const request of durableRequests) {
        enqueuePendingRequest({
          args: request.args,
          cmd: request.cmd,
          durable: true,
          reject: () => {},
          resolve: () => {},
          retries: request.retries,
        });
      }

      sessionStorage.removeItem(DURABLE_QUEUE_KEY);
    } catch {
      sessionStorage.removeItem(DURABLE_QUEUE_KEY);
    }
  }

  async function executeFetch<TChannel extends RendererInvokeChannel>(
    cmd: TChannel,
    args?: RendererInvokeRequestMap[TChannel],
  ): Promise<RendererInvokeResponseMap[TChannel]> {
    const token = options.getToken();
    let response: Response;
    try {
      response = await fetch(`/api/ipc/${encodeURIComponent(cmd)}`, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive:
          cmd === IPC.SaveAppState ||
          cmd === IPC.SaveWorkspaceState ||
          cmd === IPC.DetachAgentOutput,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(args ?? {}),
      });
    } catch (error) {
      setState('unreachable');
      options.onUnreachable(BROWSER_UNREACHABLE_MESSAGE);
      throw new QueueableBrowserFetchError(BROWSER_UNREACHABLE_MESSAGE, error);
    }

    const data = await readResponseEnvelope<TChannel>(response);
    if (response.status === 401) {
      setState('auth-expired');
      const authError = new Error(data.error ?? 'Browser session expired');
      options.onAuthExpired(authError);
      throw authError;
    }

    setState('available');
    if (response.ok) {
      return getResponseResult(cmd, data);
    }

    if (response.status < 400) {
      const responseError = new Error(data.error ?? `IPC request failed (${response.status})`);
      options.onUnreachable(responseError.message);
      throw new QueueableBrowserFetchError(responseError.message, responseError);
    }

    if (response.status >= 500) {
      options.onServerError(data.error ?? 'The server failed to process the request.');
    } else {
      console.warn('[ipc] Bad request to', cmd, ':', data.error ?? `${response.status}`);
    }

    throw new Error(data.error ?? `IPC request failed (${response.status})`);
  }

  async function replayPendingRequest(request: PendingRequest): Promise<void> {
    try {
      request.resolve(await executeFetch(request.cmd, request.args));
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
    if (drainingPendingRequestQueue || pendingRequestQueue.length === 0) {
      return;
    }

    drainingPendingRequestQueue = true;
    try {
      const requestsToProcess = pendingRequestQueue.length;
      for (let index = 0; index < requestsToProcess; index += 1) {
        const request = pendingRequestQueue.shift();
        if (!request) {
          break;
        }

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

  function queueRequest<TChannel extends RendererInvokeChannel>(
    cmd: TChannel,
    args: RendererInvokeRequestMap[TChannel] | undefined,
    retries: number,
  ): Promise<RendererInvokeResponseMap[TChannel]> {
    bindLifecycle();

    return new Promise<RendererInvokeResponseMap[TChannel]>((resolve, reject) => {
      enqueuePendingRequest({
        args,
        cmd,
        durable: isDurablePendingRequest(cmd, args),
        reject,
        resolve,
        retries,
      });
      saveDurableQueue();
      schedulePendingRequestQueueDrain();
    });
  }

  async function fetchWithQueue<TChannel extends RendererInvokeChannel>(
    cmd: TChannel,
    args?: RendererInvokeRequestMap[TChannel],
  ): Promise<RendererInvokeResponseMap[TChannel]> {
    try {
      return await executeFetch(cmd, args);
    } catch (error) {
      if (error instanceof QueueableBrowserFetchError) {
        return queueRequest(cmd, args, 0);
      }
      throw error;
    }
  }

  if (options.enabled !== false) {
    loadDurableQueue();
    schedulePendingRequestQueueDrain();
  }

  return {
    clearDurableQueueStorage,
    fetch: fetchWithQueue,
    getQueueDepth: () => pendingRequestQueue.length,
    onStateChange: (listener) => {
      stateListeners.add(listener);
      listener(state);
      return () => {
        stateListeners.delete(listener);
      };
    },
    rejectPendingRequests,
  };
}
