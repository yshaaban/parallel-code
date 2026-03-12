import { IPC } from '../../electron/ipc/channels';

const MAX_RETRIES = 3;
const MAX_QUEUE_DEPTH = 20;
const PENDING_REQUEST_RETRY_BASE_MS = 250;
const PENDING_REQUEST_RETRY_MAX_MS = 2_000;
const DEDUPED_PENDING_REQUESTS = new Set<IPC>([IPC.SaveAppState, IPC.LoadAppState]);
const DURABLE_QUEUE_KEY = 'ipc-durable-queue';
const BROWSER_UNREACHABLE_MESSAGE = 'Unable to reach the Parallel Code server.';

interface PendingRequest {
  args?: unknown;
  cmd: IPC;
  durable?: boolean;
  reject: (reason: unknown) => void;
  resolve: (value: unknown) => void;
  retries: number;
}

export interface BrowserHttpIpcClient {
  clearDurableQueueStorage: () => void;
  fetch: <T>(cmd: IPC, args?: unknown) => Promise<T>;
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

function isDurablePendingRequest(cmd: IPC, args: unknown): boolean {
  if (cmd === IPC.KillAgent) {
    return true;
  }

  if (cmd !== IPC.PauseAgent && cmd !== IPC.ResumeAgent) {
    return false;
  }

  const reason = (args as { reason?: unknown } | undefined)?.reason;
  return reason === undefined || reason === 'manual';
}

function getPendingRequestRetryDelay(retries: number): number {
  return Math.min(
    PENDING_REQUEST_RETRY_BASE_MS * Math.pow(2, Math.max(0, retries - 1)),
    PENDING_REQUEST_RETRY_MAX_MS,
  );
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
      const durableRequests = JSON.parse(stored) as Array<{
        args?: unknown;
        cmd: IPC;
        retries: number;
      }>;

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

  async function executeFetch<T>(cmd: IPC, args?: unknown): Promise<T> {
    const token = options.getToken();
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
      setState('unreachable');
      options.onUnreachable(BROWSER_UNREACHABLE_MESSAGE);
      throw new QueueableBrowserFetchError(BROWSER_UNREACHABLE_MESSAGE, error);
    }

    const data = (await response.json().catch(() => ({}))) as { error?: string; result?: T };
    if (response.status === 401) {
      setState('auth-expired');
      const authError = new Error(data.error ?? 'Browser session expired');
      options.onAuthExpired(authError);
      throw authError;
    }

    setState('available');
    if (response.ok) {
      return data.result as T;
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

  function queueRequest<T>(cmd: IPC, args: unknown, retries: number): Promise<T> {
    bindLifecycle();

    return new Promise<T>((resolve, reject) => {
      enqueuePendingRequest({
        args,
        cmd,
        durable: isDurablePendingRequest(cmd, args),
        reject,
        resolve: (value) => resolve(value as T),
        retries,
      });
      saveDurableQueue();
      schedulePendingRequestQueueDrain();
    });
  }

  async function fetchWithQueue<T>(cmd: IPC, args?: unknown): Promise<T> {
    try {
      return await executeFetch<T>(cmd, args);
    } catch (error) {
      if (error instanceof QueueableBrowserFetchError) {
        return queueRequest<T>(cmd, args, 0);
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
