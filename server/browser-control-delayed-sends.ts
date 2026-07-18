import { WebSocket } from 'ws';
import {
  getBackendRuntimeDiagnosticsGeneration,
  recordBrowserControlBufferedAmount,
  recordBrowserControlDelayedQueue,
  recordBrowserControlSendResult,
  recordBrowserControlSimulatedDrop,
} from '../electron/ipc/runtime-diagnostics.js';
import type { SendTextResult } from '../electron/remote/ws-transport.js';

const WS_BACKPRESSURE_MAX_BYTES = 1_048_576;
export const DELAYED_SEND_RETRY_INTERVAL_MS = 25;

interface DelayedClientSendEntry {
  data: string | Buffer;
  dueAt: number;
  enqueuedAt: number;
  generation: number;
  sizeBytes: number;
}

interface DelayedClientSendState {
  queue: DelayedClientSendEntry[];
  queueHead: number;
  timer: ReturnType<typeof setTimeout> | null;
  totalBytes: number;
}

export interface PendingChannelSendState {
  queueAgeMs: number;
  queueBytes: number;
  queueDepth: number;
}

interface CreateBrowserControlDelayedSendsOptions {
  getChannelDelayMs: () => number;
  shouldDropSend?: () => boolean;
  onFailedClientSend: (client: WebSocket) => void;
  onInactiveClient: (client: WebSocket) => void;
}

export interface BrowserControlDelayedSends {
  cleanup: () => void;
  clearClient: (client: WebSocket) => void;
  getPendingChannelSendState: (client: WebSocket) => PendingChannelSendState | null;
  sendChannelData: (client: WebSocket, data: string | Buffer) => boolean;
  sendSafely: (
    client: WebSocket,
    data: string | Buffer,
    diagnosticsGeneration?: number,
  ) => SendTextResult;
}

function getDataSizeBytes(data: string | Buffer): number {
  return Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
}

function createDiagnosticsGenerationDetails(
  generation: number | undefined,
): { generation: number } | undefined {
  return generation === undefined ? undefined : { generation };
}

function recordClientBufferedAmount(client: WebSocket, generation?: number): void {
  recordBrowserControlBufferedAmount(
    client.bufferedAmount,
    createDiagnosticsGenerationDetails(generation),
  );
}

function shouldSimulateDroppedSend(
  options: CreateBrowserControlDelayedSendsOptions,
  generation?: number,
): boolean {
  if (options.shouldDropSend?.() !== true) {
    return false;
  }

  recordBrowserControlSimulatedDrop(createDiagnosticsGenerationDetails(generation));
  return true;
}

function getDelayedClientQueueAgeMs(state: DelayedClientSendState): number {
  const firstEntry = state.queue[state.queueHead];
  if (!firstEntry) {
    return 0;
  }

  return Math.max(0, Date.now() - firstEntry.enqueuedAt);
}

function getDelayedClientQueueDepth(state: DelayedClientSendState): number {
  return state.queue.length - state.queueHead;
}

function takeDelayedClientQueueHead(
  state: DelayedClientSendState,
): DelayedClientSendEntry | undefined {
  const entry = state.queue[state.queueHead];
  if (!entry) {
    return undefined;
  }

  state.queueHead += 1;
  // Retain constant-time dequeue while periodically releasing consumed slots.
  if (state.queueHead >= 1_024 && state.queueHead * 2 >= state.queue.length) {
    state.queue = state.queue.slice(state.queueHead);
    state.queueHead = 0;
  }
  return entry;
}

function recordDelayedClientQueueHighWater(state: DelayedClientSendState): void {
  const queueDepth = getDelayedClientQueueDepth(state);
  if (queueDepth === 0) {
    return;
  }

  recordBrowserControlDelayedQueue(
    queueDepth,
    state.totalBytes,
    getDelayedClientQueueAgeMs(state),
    createDiagnosticsGenerationDetails(state.queue[state.queueHead]?.generation),
  );
}

export function createBrowserControlDelayedSends(
  options: CreateBrowserControlDelayedSendsOptions,
): BrowserControlDelayedSends {
  const delayedClientSends = new WeakMap<WebSocket, DelayedClientSendState>();
  const trackedClients = new Set<WebSocket>();

  function getDelayedClientSendState(client: WebSocket): DelayedClientSendState {
    let state = delayedClientSends.get(client);
    if (state) {
      return state;
    }

    state = {
      queue: [],
      queueHead: 0,
      timer: null,
      totalBytes: 0,
    };
    delayedClientSends.set(client, state);
    trackedClients.add(client);
    return state;
  }

  function clearClient(client: WebSocket): void {
    const state = delayedClientSends.get(client);
    if (!state) {
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
    }
    delayedClientSends.delete(client);
    trackedClients.delete(client);
  }

  function sendNow(
    client: WebSocket,
    data: string | Buffer,
    diagnosticsGeneration?: number,
    optionsOverride: { simulateDrop?: boolean } = {},
  ): SendTextResult {
    const diagnosticsDetails = createDiagnosticsGenerationDetails(diagnosticsGeneration);
    recordClientBufferedAmount(client, diagnosticsGeneration);
    if (client.readyState !== WebSocket.OPEN) {
      recordBrowserControlSendResult('not-open', diagnosticsDetails);
      options.onInactiveClient(client);
      return { ok: false, reason: 'not-open' };
    }
    if (client.bufferedAmount > WS_BACKPRESSURE_MAX_BYTES) {
      recordBrowserControlSendResult('backpressure', diagnosticsDetails);
      return { ok: false, reason: 'backpressure' };
    }
    if (
      optionsOverride.simulateDrop !== false &&
      shouldSimulateDroppedSend(options, diagnosticsGeneration)
    ) {
      return { ok: true };
    }

    try {
      client.send(data);
      return { ok: true };
    } catch (error) {
      recordBrowserControlSendResult('send-error', diagnosticsDetails);
      options.onFailedClientSend(client);
      return {
        ok: false,
        reason: 'send-error',
        error,
      };
    }
  }

  function scheduleDelayedClientDrain(
    client: WebSocket,
    state: DelayedClientSendState,
    delayMs: number,
  ): void {
    if (state.timer) {
      return;
    }

    state.timer = setTimeout(
      () => {
        state.timer = null;
        drainDelayedClientQueue(client);
      },
      Math.max(0, delayMs),
    );
  }

  function scheduleDelayedClientDrainForQueueHead(
    client: WebSocket,
    state: DelayedClientSendState,
  ): void {
    const firstDueAt = state.queue[state.queueHead]?.dueAt;
    if (firstDueAt === undefined) {
      return;
    }

    scheduleDelayedClientDrain(client, state, firstDueAt - Date.now());
  }

  function drainDelayedClientQueue(client: WebSocket): void {
    const state = delayedClientSends.get(client);
    if (!state) {
      return;
    }

    if (client.readyState !== WebSocket.OPEN) {
      options.onInactiveClient(client);
      return;
    }

    while (getDelayedClientQueueDepth(state) > 0) {
      recordDelayedClientQueueHighWater(state);
      const nextEntry = state.queue[state.queueHead];
      if (!nextEntry) {
        break;
      }

      const delayMs = nextEntry.dueAt - Date.now();
      if (delayMs > 0) {
        scheduleDelayedClientDrainForQueueHead(client, state);
        return;
      }

      const result = sendNow(client, nextEntry.data, nextEntry.generation, {
        simulateDrop: false,
      });
      if (!result.ok) {
        if (result.reason === 'backpressure') {
          scheduleDelayedClientDrain(client, state, DELAYED_SEND_RETRY_INTERVAL_MS);
        }
        return;
      }

      takeDelayedClientQueueHead(state);
      state.totalBytes -= nextEntry.sizeBytes;
    }

    clearClient(client);
  }

  function queueDelayedSend(
    client: WebSocket,
    data: string | Buffer,
    delayMs: number,
    diagnosticsGeneration = getBackendRuntimeDiagnosticsGeneration(),
  ): SendTextResult {
    if (client.readyState !== WebSocket.OPEN) {
      recordBrowserControlSendResult('not-open', {
        generation: diagnosticsGeneration,
      });
      options.onInactiveClient(client);
      return { ok: false, reason: 'not-open' };
    }

    recordClientBufferedAmount(client, diagnosticsGeneration);
    if (shouldSimulateDroppedSend(options, diagnosticsGeneration)) {
      return { ok: true };
    }
    const state = getDelayedClientSendState(client);
    const sizeBytes = getDataSizeBytes(data);
    const bufferedBytes = state.totalBytes + client.bufferedAmount + sizeBytes;
    if (bufferedBytes > WS_BACKPRESSURE_MAX_BYTES) {
      recordBrowserControlSendResult('backpressure', { generation: diagnosticsGeneration });
      return { ok: false, reason: 'backpressure' };
    }

    const now = Date.now();
    const previousEntry = state.queue[state.queue.length - 1];
    const dueAt = Math.max(previousEntry?.dueAt ?? now, now + delayMs);
    const entry = {
      data,
      dueAt,
      enqueuedAt: now,
      generation: diagnosticsGeneration,
      sizeBytes,
    };
    state.queue.push(entry);
    state.totalBytes += sizeBytes;
    recordDelayedClientQueueHighWater(state);
    scheduleDelayedClientDrainForQueueHead(client, state);
    return { ok: true };
  }

  function sendSafely(
    client: WebSocket,
    data: string | Buffer,
    diagnosticsGeneration?: number,
  ): SendTextResult {
    const delayMs = options.getChannelDelayMs();
    if (delayMs > 0 || delayedClientSends.has(client)) {
      return queueDelayedSend(client, data, delayMs, diagnosticsGeneration);
    }

    return sendNow(client, data, diagnosticsGeneration);
  }

  function sendChannelData(client: WebSocket, data: string | Buffer): boolean {
    const delayMs = options.getChannelDelayMs();
    if (delayMs > 0 || delayedClientSends.has(client)) {
      return queueDelayedSend(client, data, delayMs).ok;
    }

    return sendSafely(client, data).ok;
  }

  function getPendingChannelSendState(client: WebSocket): PendingChannelSendState | null {
    const state = delayedClientSends.get(client);
    if (!state || getDelayedClientQueueDepth(state) === 0) {
      return null;
    }

    return {
      queueAgeMs: getDelayedClientQueueAgeMs(state),
      queueBytes: state.totalBytes,
      queueDepth: getDelayedClientQueueDepth(state),
    };
  }

  function cleanup(): void {
    for (const client of trackedClients) {
      clearClient(client);
    }
  }

  return {
    cleanup,
    clearClient,
    getPendingChannelSendState,
    sendChannelData,
    sendSafely,
  };
}
