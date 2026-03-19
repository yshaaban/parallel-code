import { WebSocket } from 'ws';
import {
  recordBrowserControlDelayedQueue,
  recordBrowserControlSendResult,
} from '../electron/ipc/runtime-diagnostics.js';
import type { SendTextResult } from '../electron/remote/ws-transport.js';

const WS_BACKPRESSURE_MAX_BYTES = 1_048_576;
export const DELAYED_SEND_RETRY_INTERVAL_MS = 25;

interface DelayedClientSendEntry {
  data: string | Buffer;
  dueAt: number;
  enqueuedAt: number;
  sizeBytes: number;
}

interface DelayedClientSendState {
  queue: DelayedClientSendEntry[];
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
  onFailedClientSend: (client: WebSocket) => void;
  onInactiveClient: (client: WebSocket) => void;
}

export interface BrowserControlDelayedSends {
  clearClient: (client: WebSocket) => void;
  getPendingChannelSendState: (client: WebSocket) => PendingChannelSendState | null;
  sendChannelData: (client: WebSocket, data: string | Buffer) => boolean;
  sendSafely: (client: WebSocket, data: string | Buffer) => SendTextResult;
}

function getDataSizeBytes(data: string | Buffer): number {
  return Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
}

function getDelayedClientQueueAgeMs(state: DelayedClientSendState): number {
  const firstEntry = state.queue[0];
  if (!firstEntry) {
    return 0;
  }

  return Math.max(0, Date.now() - firstEntry.enqueuedAt);
}

function recordDelayedClientQueueHighWater(state: DelayedClientSendState): void {
  if (state.queue.length === 0) {
    return;
  }

  recordBrowserControlDelayedQueue(
    state.queue.length,
    state.totalBytes,
    getDelayedClientQueueAgeMs(state),
  );
}

export function createBrowserControlDelayedSends(
  options: CreateBrowserControlDelayedSendsOptions,
): BrowserControlDelayedSends {
  const delayedClientSends = new WeakMap<WebSocket, DelayedClientSendState>();

  function getDelayedClientSendState(client: WebSocket): DelayedClientSendState {
    let state = delayedClientSends.get(client);
    if (state) {
      return state;
    }

    state = {
      queue: [],
      timer: null,
      totalBytes: 0,
    };
    delayedClientSends.set(client, state);
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
  }

  function sendSafely(client: WebSocket, data: string | Buffer): SendTextResult {
    if (client.readyState !== WebSocket.OPEN) {
      recordBrowserControlSendResult('not-open');
      options.onInactiveClient(client);
      return { ok: false, reason: 'not-open' };
    }
    if (client.bufferedAmount > WS_BACKPRESSURE_MAX_BYTES) {
      recordBrowserControlSendResult('backpressure');
      return { ok: false, reason: 'backpressure' };
    }

    try {
      client.send(data);
      return { ok: true };
    } catch (error) {
      recordBrowserControlSendResult('send-error');
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
    const firstDueAt = state.queue[0]?.dueAt;
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

    while (state.queue.length > 0) {
      recordDelayedClientQueueHighWater(state);
      const nextEntry = state.queue[0];
      if (!nextEntry) {
        break;
      }

      const delayMs = nextEntry.dueAt - Date.now();
      if (delayMs > 0) {
        scheduleDelayedClientDrainForQueueHead(client, state);
        return;
      }

      const result = sendSafely(client, nextEntry.data);
      if (!result.ok) {
        if (result.reason === 'backpressure') {
          scheduleDelayedClientDrain(client, state, DELAYED_SEND_RETRY_INTERVAL_MS);
        }
        return;
      }

      state.queue.shift();
      state.totalBytes -= nextEntry.sizeBytes;
    }

    clearClient(client);
  }

  function queueDelayedChannelSend(
    client: WebSocket,
    data: string | Buffer,
    delayMs: number,
  ): boolean {
    if (client.readyState !== WebSocket.OPEN) {
      recordBrowserControlSendResult('not-open');
      options.onInactiveClient(client);
      return false;
    }

    const state = getDelayedClientSendState(client);
    const sizeBytes = getDataSizeBytes(data);
    const bufferedBytes = state.totalBytes + client.bufferedAmount + sizeBytes;
    if (bufferedBytes > WS_BACKPRESSURE_MAX_BYTES) {
      recordBrowserControlSendResult('backpressure');
      return false;
    }

    state.queue.push({
      data,
      dueAt: Date.now() + delayMs,
      enqueuedAt: Date.now(),
      sizeBytes,
    });
    state.totalBytes += sizeBytes;
    recordDelayedClientQueueHighWater(state);
    scheduleDelayedClientDrainForQueueHead(client, state);
    return true;
  }

  function sendChannelData(client: WebSocket, data: string | Buffer): boolean {
    const delayMs = options.getChannelDelayMs();
    if (delayMs > 0) {
      return queueDelayedChannelSend(client, data, delayMs);
    }

    return sendSafely(client, data).ok;
  }

  function getPendingChannelSendState(client: WebSocket): PendingChannelSendState | null {
    const state = delayedClientSends.get(client);
    if (!state || state.queue.length === 0) {
      return null;
    }

    return {
      queueAgeMs: getDelayedClientQueueAgeMs(state),
      queueBytes: state.totalBytes,
      queueDepth: state.queue.length,
    };
  }

  return {
    clearClient,
    getPendingChannelSendState,
    sendChannelData,
    sendSafely,
  };
}
