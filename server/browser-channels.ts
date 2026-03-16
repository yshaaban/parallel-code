import { WebSocket } from 'ws';
import {
  recordBrowserChannelCoalesced,
  recordBrowserChannelDegraded,
  recordBrowserChannelDroppedData,
  recordBrowserChannelQueueAge,
} from '../electron/ipc/runtime-diagnostics.js';
import {
  createQueuedChannelMessage,
  isChannelDataPayload,
  type QueuedMessage,
} from './channel-frames.js';

// Browser terminal stream plane. This owns per-channel fanout, per-client
// backpressure queues, and reset/rebind recovery for stream loss.

interface SerializedPendingMessage {
  enqueuedAtMs: number;
  kind: 'serialized';
  message: QueuedMessage;
  sizeBytes: number;
}

interface TerminalDataPendingMessage {
  enqueuedAtMs: number;
  kind: 'terminal-data';
  rawData: Buffer;
  sizeBytes: number;
}

type PendingMessage = SerializedPendingMessage | TerminalDataPendingMessage;

interface PendingQueue {
  drainPasses: number;
  messages: PendingMessage[];
  totalBytes: number;
}

interface ClientDegradeThresholds {
  maxDrainPasses: number;
  maxQueueAgeMs: number;
  maxQueuedBytes: number;
}

export interface CreateBrowserChannelManagerOptions {
  clientDegradedMaxDrainPasses?: number;
  clientDegradedMaxQueueAgeMs?: number;
  clientDegradedMaxQueuedBytes?: number;
  clearAutoPauseReasonsForChannel: (channelId: string) => void;
  coalescedChannelDataMaxBytes?: number;
  send: (client: WebSocket, data: string | Buffer) => boolean;
  backpressureDrainIntervalMs?: number;
  pendingChannelCleanupMs?: number;
  pendingChannelMaxBytes?: number;
}

export interface BrowserChannelManager {
  bindChannel: (client: WebSocket, channelId: string) => void;
  cleanup: () => void;
  cleanupClient: (client: WebSocket) => void;
  sendChannelMessage: (channelId: string, payload: unknown) => void;
  unbindChannel: (client: WebSocket, channelId: string) => void;
}

function createPendingQueue(): PendingQueue {
  return {
    drainPasses: 0,
    messages: [],
    totalBytes: 0,
  };
}

function createResetRequiredQueue(channelId: string): PendingQueue {
  const resetEntry = createSerializedPendingMessage(channelId, {
    type: 'ResetRequired',
    reason: 'backpressure',
  });

  return {
    drainPasses: 0,
    messages: [resetEntry],
    totalBytes: resetEntry.sizeBytes,
  };
}

function createSerializedPendingMessage(
  channelId: string,
  payload: unknown,
  enqueuedAtMs = Date.now(),
): SerializedPendingMessage {
  const message = createQueuedChannelMessage(channelId, payload);
  return {
    enqueuedAtMs,
    kind: 'serialized',
    message,
    sizeBytes: message.sizeBytes,
  };
}

function createTerminalDataPendingMessage(
  channelId: string,
  payload: { type: 'Data'; data: string },
  enqueuedAtMs = Date.now(),
): TerminalDataPendingMessage {
  const rawData = Buffer.from(payload.data, 'base64');
  const serialized = createQueuedChannelMessage(channelId, {
    type: 'Data',
    data: rawData.toString('base64'),
  });

  return {
    enqueuedAtMs,
    kind: 'terminal-data',
    rawData,
    sizeBytes: serialized.sizeBytes,
  };
}

function createPendingMessage(
  channelId: string,
  payload: unknown,
  enqueuedAtMs = Date.now(),
): PendingMessage {
  if (isChannelDataPayload(payload)) {
    return createTerminalDataPendingMessage(channelId, payload, enqueuedAtMs);
  }

  return createSerializedPendingMessage(channelId, payload, enqueuedAtMs);
}

function clonePendingMessage(entry: PendingMessage): PendingMessage {
  switch (entry.kind) {
    case 'serialized':
      return {
        enqueuedAtMs: entry.enqueuedAtMs,
        kind: 'serialized',
        message: entry.message,
        sizeBytes: entry.sizeBytes,
      };
    case 'terminal-data':
      return {
        enqueuedAtMs: entry.enqueuedAtMs,
        kind: 'terminal-data',
        rawData: entry.rawData,
        sizeBytes: entry.sizeBytes,
      };
  }
}

function serializePendingMessage(channelId: string, entry: PendingMessage): string | Buffer {
  switch (entry.kind) {
    case 'serialized':
      return entry.message.data;
    case 'terminal-data':
      return createQueuedChannelMessage(channelId, {
        type: 'Data',
        data: entry.rawData.toString('base64'),
      }).data;
  }
}

function getPendingQueueAgeMs(queue: PendingQueue): number {
  const firstEntry = queue.messages[0];
  if (!firstEntry) return 0;
  return Math.max(0, Date.now() - firstEntry.enqueuedAtMs);
}

function tryCoalescePendingMessage(
  channelId: string,
  previous: PendingMessage | undefined,
  next: PendingMessage,
  maxCoalescedBytes: number,
): PendingMessage | null {
  if (!previous || previous.kind !== 'terminal-data' || next.kind !== 'terminal-data') {
    return null;
  }

  const mergedRawDataLength = previous.rawData.length + next.rawData.length;
  if (mergedRawDataLength > maxCoalescedBytes) {
    return null;
  }

  const mergedRawData = Buffer.concat([previous.rawData, next.rawData], mergedRawDataLength);
  const mergedMessage = createQueuedChannelMessage(channelId, {
    type: 'Data',
    data: mergedRawData.toString('base64'),
  });

  return {
    enqueuedAtMs: previous.enqueuedAtMs,
    kind: 'terminal-data',
    rawData: mergedRawData,
    sizeBytes: mergedMessage.sizeBytes,
  };
}

function trimPendingQueueToMaxBytes(queue: PendingQueue, maxBytes: number): boolean {
  let overflowed = false;
  while (queue.totalBytes > maxBytes && queue.messages.length > 1) {
    const dropped = queue.messages.shift();
    if (!dropped) break;
    queue.totalBytes -= dropped.sizeBytes;
    overflowed = true;
  }

  return overflowed;
}

export function createBrowserChannelManager(
  options: CreateBrowserChannelManagerOptions,
): BrowserChannelManager {
  const pendingChannelMessages = new Map<string, PendingQueue>();
  const pendingChannelResetRequired = new Set<string>();
  const clientBackpressureQueues = new WeakMap<WebSocket, Map<string, PendingQueue>>();
  const pendingChannelCleanupTimers = new Map<string, NodeJS.Timeout>();
  const pendingChannelBacklogCleanupTimers = new Map<string, NodeJS.Timeout>();
  const clientResetRequiredChannels = new WeakMap<WebSocket, Set<string>>();
  const boundChannels = new WeakMap<WebSocket, Set<string>>();
  const channelSubscribers = new Map<string, Set<WebSocket>>();
  const backpressuredChannels = new Set<string>();

  const pendingChannelMaxBytes = options.pendingChannelMaxBytes ?? 2 * 1024 * 1024;
  const pendingChannelCleanupMs = options.pendingChannelCleanupMs ?? 30_000;
  const backpressureDrainIntervalMs = options.backpressureDrainIntervalMs ?? 250;
  const coalescedChannelDataMaxBytes = options.coalescedChannelDataMaxBytes ?? 256 * 1024;
  const clientDegradeThresholds: ClientDegradeThresholds = {
    maxDrainPasses: options.clientDegradedMaxDrainPasses ?? 2,
    maxQueueAgeMs: options.clientDegradedMaxQueueAgeMs ?? 500,
    maxQueuedBytes: options.clientDegradedMaxQueuedBytes ?? 256 * 1024,
  };

  let backpressureDrainTimer: NodeJS.Timeout | null = null;

  function getClientResetRequiredSet(client: WebSocket): Set<string> {
    let channels = clientResetRequiredChannels.get(client);
    if (!channels) {
      channels = new Set();
      clientResetRequiredChannels.set(client, channels);
    }
    return channels;
  }

  function isClientChannelResetRequired(client: WebSocket, channelId: string): boolean {
    return clientResetRequiredChannels.get(client)?.has(channelId) === true;
  }

  function clearClientChannelResetRequired(client: WebSocket, channelId: string): void {
    clientResetRequiredChannels.get(client)?.delete(channelId);
  }

  function clearPendingChannelResetRequired(channelId: string): void {
    pendingChannelResetRequired.delete(channelId);
  }

  function isPendingChannelResetRequired(channelId: string): boolean {
    return pendingChannelResetRequired.has(channelId);
  }

  function markPendingChannelResetRequired(channelId: string): void {
    if (pendingChannelResetRequired.has(channelId)) return;
    pendingChannelResetRequired.add(channelId);
    pendingChannelMessages.set(channelId, createResetRequiredQueue(channelId));
  }

  function markClientChannelResetRequired(
    client: WebSocket,
    channelId: string,
    queueAgeMs: number,
  ): void {
    const channels = getClientResetRequiredSet(client);
    if (channels.has(channelId)) return;
    channels.add(channelId);
    recordBrowserChannelDegraded(queueAgeMs);

    let clientQueues = clientBackpressureQueues.get(client);
    if (!clientQueues) {
      clientQueues = new Map();
      clientBackpressureQueues.set(client, clientQueues);
    }

    clientQueues.set(channelId, createResetRequiredQueue(channelId));
  }

  function cancelPendingChannelCleanup(channelId: string): void {
    const timer = pendingChannelCleanupTimers.get(channelId);
    if (!timer) return;
    clearTimeout(timer);
    pendingChannelCleanupTimers.delete(channelId);
  }

  function schedulePendingChannelCleanup(channelId: string): void {
    cancelPendingChannelCleanup(channelId);
    pendingChannelCleanupTimers.set(
      channelId,
      setTimeout(() => {
        pendingChannelCleanupTimers.delete(channelId);
        if ((channelSubscribers.get(channelId)?.size ?? 0) !== 0) return;
        pendingChannelMessages.delete(channelId);
        clearPendingChannelResetRequired(channelId);
      }, pendingChannelCleanupMs),
    );
  }

  function schedulePendingChannelBacklogCleanup(channelId: string): void {
    const timer = pendingChannelBacklogCleanupTimers.get(channelId);
    if (timer) clearTimeout(timer);
    pendingChannelBacklogCleanupTimers.set(
      channelId,
      setTimeout(() => {
        pendingChannelBacklogCleanupTimers.delete(channelId);
        pendingChannelMessages.delete(channelId);
        clearPendingChannelResetRequired(channelId);
      }, pendingChannelCleanupMs),
    );
  }

  function queueChannelMessagePerChannel(channelId: string, payload: unknown): void {
    if (isPendingChannelResetRequired(channelId) && isChannelDataPayload(payload)) {
      return;
    }

    let queue = pendingChannelMessages.get(channelId);
    if (!queue) {
      queue = createPendingQueue();
      pendingChannelMessages.set(channelId, queue);
    }

    appendPendingMessage(queue, channelId, createPendingMessage(channelId, payload));

    if (trimPendingQueueToMaxBytes(queue, pendingChannelMaxBytes)) {
      markPendingChannelResetRequired(channelId);
    }
  }

  function queueChannelMessagePerClient(
    client: WebSocket,
    channelId: string,
    payload: unknown,
  ): void {
    if (isClientChannelResetRequired(client, channelId) && isChannelDataPayload(payload)) {
      recordBrowserChannelDroppedData();
      return;
    }

    const queue = getOrCreateClientQueue(client, channelId);

    appendPendingMessage(queue, channelId, createPendingMessage(channelId, payload));

    if (trimPendingQueueToMaxBytes(queue, pendingChannelMaxBytes)) {
      markClientChannelResetRequired(client, channelId, getPendingQueueAgeMs(queue));
      return;
    }

    maybeDegradeClientQueue(client, channelId, queue);
  }

  function appendPendingMessage(
    queue: PendingQueue,
    channelId: string,
    message: PendingMessage,
  ): void {
    const lastMessage = queue.messages[queue.messages.length - 1];
    const mergedMessage = tryCoalescePendingMessage(
      channelId,
      lastMessage,
      message,
      coalescedChannelDataMaxBytes,
    );
    if (mergedMessage && lastMessage) {
      const bytesSaved = lastMessage.sizeBytes + message.sizeBytes - mergedMessage.sizeBytes;
      queue.messages[queue.messages.length - 1] = mergedMessage;
      queue.totalBytes += mergedMessage.sizeBytes - lastMessage.sizeBytes;
      if (bytesSaved > 0) {
        recordBrowserChannelCoalesced(bytesSaved);
      }
      return;
    }

    queue.messages.push(message);
    queue.totalBytes += message.sizeBytes;
  }

  function maybeDegradeClientQueue(
    client: WebSocket,
    channelId: string,
    queue: PendingQueue,
  ): void {
    if (isClientChannelResetRequired(client, channelId)) {
      return;
    }

    const queueAgeMs = getPendingQueueAgeMs(queue);
    recordBrowserChannelQueueAge(queueAgeMs);

    if (queue.totalBytes > clientDegradeThresholds.maxQueuedBytes) {
      markClientChannelResetRequired(client, channelId, queueAgeMs);
      return;
    }

    if (queueAgeMs > clientDegradeThresholds.maxQueueAgeMs) {
      markClientChannelResetRequired(client, channelId, queueAgeMs);
      return;
    }

    if (queue.drainPasses >= clientDegradeThresholds.maxDrainPasses) {
      markClientChannelResetRequired(client, channelId, queueAgeMs);
    }
  }

  function shouldResetRequiredForBacklog(channelId: string, queue: PendingQueue): boolean {
    if (isPendingChannelResetRequired(channelId)) {
      return true;
    }

    const queueAgeMs = getPendingQueueAgeMs(queue);
    recordBrowserChannelQueueAge(queueAgeMs);
    if (queue.totalBytes > clientDegradeThresholds.maxQueuedBytes) {
      return true;
    }

    return queueAgeMs > clientDegradeThresholds.maxQueueAgeMs;
  }

  function copyPendingChannelBacklogToClient(client: WebSocket, channelId: string): void {
    const queue = pendingChannelMessages.get(channelId);
    if (!queue || queue.messages.length === 0) return;

    if (shouldResetRequiredForBacklog(channelId, queue)) {
      markClientChannelResetRequired(client, channelId, getPendingQueueAgeMs(queue));
      schedulePendingChannelBacklogCleanup(channelId);
      return;
    }

    for (const entry of queue.messages) {
      appendPendingMessageToClientQueue(client, channelId, clonePendingMessage(entry));
    }
    schedulePendingChannelBacklogCleanup(channelId);
  }

  function appendPendingMessageToClientQueue(
    client: WebSocket,
    channelId: string,
    message: PendingMessage,
  ): void {
    const queue = getOrCreateClientQueue(client, channelId);
    appendPendingMessage(queue, channelId, message);
  }

  function getOrCreateClientQueue(client: WebSocket, channelId: string): PendingQueue {
    let clientQueues = clientBackpressureQueues.get(client);
    if (!clientQueues) {
      clientQueues = new Map();
      clientBackpressureQueues.set(client, clientQueues);
    }

    let queue = clientQueues.get(channelId);
    if (!queue) {
      queue = createPendingQueue();
      clientQueues.set(channelId, queue);
    }

    return queue;
  }

  function removeChannelSubscriber(channelId: string, client: WebSocket): void {
    const subscribers = channelSubscribers.get(channelId);
    if (!subscribers) return;
    subscribers.delete(client);
    if (subscribers.size !== 0) return;

    channelSubscribers.delete(channelId);
    schedulePendingChannelCleanup(channelId);
    options.clearAutoPauseReasonsForChannel(channelId);
  }

  function hasQueuedMessages(client: WebSocket, channelId: string): boolean {
    return (clientBackpressureQueues.get(client)?.get(channelId)?.messages.length ?? 0) > 0;
  }

  function flushPendingChannelMessages(client: WebSocket, channelId: string): boolean {
    const queue = clientBackpressureQueues.get(client)?.get(channelId);
    const clientQueues = clientBackpressureQueues.get(client);
    if (!queue || queue.messages.length === 0) return false;

    let sent = 0;
    let sentBytes = 0;
    for (const entry of queue.messages) {
      if (client.readyState !== WebSocket.OPEN) break;
      if (!options.send(client, serializePendingMessage(channelId, entry))) break;
      sent += 1;
      sentBytes += entry.sizeBytes;
    }
    if (sent === 0) return false;

    queue.messages.splice(0, sent);
    queue.totalBytes -= sentBytes;
    queue.drainPasses = 0;
    if (queue.messages.length !== 0) return true;

    clientQueues?.delete(channelId);
    clearClientChannelResetRequired(client, channelId);
    return true;
  }

  function scheduleBackpressureDrain(): void {
    if (backpressureDrainTimer) return;

    backpressureDrainTimer = setTimeout(() => {
      backpressureDrainTimer = null;

      for (const channelId of backpressuredChannels) {
        const subscribers = channelSubscribers.get(channelId);
        if (!subscribers || subscribers.size === 0) {
          backpressuredChannels.delete(channelId);
          continue;
        }

        let anyQueued = false;
        for (const client of subscribers) {
          const madeProgress = flushPendingChannelMessages(client, channelId);
          const queue = clientBackpressureQueues.get(client)?.get(channelId);
          if (queue && queue.messages.length > 0) {
            if (!madeProgress) {
              queue.drainPasses += 1;
            }
            maybeDegradeClientQueue(client, channelId, queue);
            anyQueued = true;
          }
        }

        if (!anyQueued) {
          backpressuredChannels.delete(channelId);
        }
      }

      if (backpressuredChannels.size > 0) {
        scheduleBackpressureDrain();
      }
    }, backpressureDrainIntervalMs);
  }

  function bindChannel(client: WebSocket, channelId: string): void {
    let channels = boundChannels.get(client);
    if (!channels) {
      channels = new Set();
      boundChannels.set(client, channels);
    }
    channels.add(channelId);

    cancelPendingChannelCleanup(channelId);
    let subscribers = channelSubscribers.get(channelId);
    if (!subscribers) {
      subscribers = new Set();
      channelSubscribers.set(channelId, subscribers);
    }
    subscribers.add(client);

    copyPendingChannelBacklogToClient(client, channelId);
    flushPendingChannelMessages(client, channelId);
    if (hasQueuedMessages(client, channelId)) {
      backpressuredChannels.add(channelId);
      scheduleBackpressureDrain();
    }
  }

  function unbindChannel(client: WebSocket, channelId: string): void {
    boundChannels.get(client)?.delete(channelId);
    removeChannelSubscriber(channelId, client);
    cancelPendingChannelCleanup(channelId);
    clientBackpressureQueues.get(client)?.delete(channelId);
    clearClientChannelResetRequired(client, channelId);
  }

  function cleanupClient(client: WebSocket): void {
    const channels = boundChannels.get(client);
    if (channels) {
      for (const channelId of channels) {
        removeChannelSubscriber(channelId, client);
      }
      channels.clear();
    }

    const queues = clientBackpressureQueues.get(client);
    queues?.clear();
    getClientResetRequiredSet(client).clear();
  }

  function sendChannelMessage(channelId: string, payload: unknown): void {
    const subscribers = channelSubscribers.get(channelId);
    const message = createQueuedChannelMessage(channelId, payload);

    if (!subscribers || subscribers.size === 0) {
      queueChannelMessagePerChannel(channelId, payload);
      return;
    }

    let anyBackpressured = false;
    for (const client of subscribers) {
      if (isClientChannelResetRequired(client, channelId) && isChannelDataPayload(payload)) {
        recordBrowserChannelDroppedData();
        continue;
      }

      if (options.send(client, message.data)) continue;
      queueChannelMessagePerClient(client, channelId, payload);
      anyBackpressured = true;
    }

    if (!anyBackpressured) return;

    backpressuredChannels.add(channelId);
    scheduleBackpressureDrain();
  }

  function cleanup(): void {
    if (backpressureDrainTimer) {
      clearTimeout(backpressureDrainTimer);
      backpressureDrainTimer = null;
    }
    backpressuredChannels.clear();
    pendingChannelMessages.clear();
    pendingChannelResetRequired.clear();
    channelSubscribers.clear();

    for (const timer of pendingChannelCleanupTimers.values()) {
      clearTimeout(timer);
    }
    pendingChannelCleanupTimers.clear();

    for (const timer of pendingChannelBacklogCleanupTimers.values()) {
      clearTimeout(timer);
    }
    pendingChannelBacklogCleanupTimers.clear();
  }

  return {
    bindChannel,
    cleanup,
    cleanupClient,
    sendChannelMessage,
    unbindChannel,
  };
}
