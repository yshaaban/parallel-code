import { WebSocket } from 'ws';
import {
  recordBrowserChannelCoalesced,
  recordBrowserChannelDegraded,
  recordBrowserChannelDroppedData,
  recordBrowserChannelQueueAge,
  recordBrowserChannelQueuedBytes,
  recordBrowserChannelRecovered,
  recordBrowserChannelResetBinding,
  recordBrowserChannelTransportBusyDeferral,
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

interface PendingChannelSendState {
  queueAgeMs: number;
  queueBytes: number;
  queueDepth: number;
}

interface TransportBusyThresholds {
  maxQueueAgeMs: number;
  maxQueueBytes: number;
  maxQueueDepth: number;
}

export interface CreateBrowserChannelManagerOptions {
  clientDegradedMaxDrainPasses?: number;
  clientDegradedMaxQueueAgeMs?: number;
  clientDegradedMaxQueuedBytes?: number;
  clearAutoPauseReasonsForChannel: (channelId: string) => void;
  coalescedChannelDataMaxBytes?: number;
  getPendingChannelSendState?: (client: WebSocket) => PendingChannelSendState | null;
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

interface FlushPendingChannelMessagesResult {
  madeProgress: boolean;
}

function createPendingQueue(): PendingQueue {
  return {
    drainPasses: 0,
    messages: [],
    totalBytes: 0,
  };
}

function createRecoveryRequiredQueue(channelId: string): PendingQueue {
  const recoveryEntry = createSerializedPendingMessage(channelId, {
    type: 'RecoveryRequired',
    reason: 'backpressure',
  });

  return {
    drainPasses: 0,
    messages: [recoveryEntry],
    totalBytes: recoveryEntry.sizeBytes,
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
  const pendingChannelRecoveryRequired = new Set<string>();
  const clientBackpressureQueues = new WeakMap<WebSocket, Map<string, PendingQueue>>();
  const pendingChannelCleanupTimers = new Map<string, NodeJS.Timeout>();
  const pendingChannelBacklogCleanupTimers = new Map<string, NodeJS.Timeout>();
  const clientRecoveryRequiredChannels = new WeakMap<WebSocket, Set<string>>();
  const boundChannels = new WeakMap<WebSocket, Set<string>>();
  const channelSubscribers = new Map<string, Set<WebSocket>>();
  const backpressuredChannels = new Set<string>();

  const pendingChannelMaxBytes = options.pendingChannelMaxBytes ?? 2 * 1024 * 1024;
  const pendingChannelCleanupMs = options.pendingChannelCleanupMs ?? 30_000;
  const backpressureDrainIntervalMs = options.backpressureDrainIntervalMs ?? 25;
  const coalescedChannelDataMaxBytes = options.coalescedChannelDataMaxBytes ?? 256 * 1024;
  const clientDegradeThresholds: ClientDegradeThresholds = {
    maxDrainPasses: options.clientDegradedMaxDrainPasses ?? 2,
    maxQueueAgeMs: options.clientDegradedMaxQueueAgeMs ?? 500,
    maxQueuedBytes: options.clientDegradedMaxQueuedBytes ?? 256 * 1024,
  };
  const transportBusyThresholds: TransportBusyThresholds = {
    maxQueueAgeMs: backpressureDrainIntervalMs,
    maxQueueBytes: 64 * 1024,
    maxQueueDepth: 4,
  };

  let backpressureDrainTimer: NodeJS.Timeout | null = null;

  function getClientRecoveryRequiredSet(client: WebSocket): Set<string> {
    let channels = clientRecoveryRequiredChannels.get(client);
    if (!channels) {
      channels = new Set();
      clientRecoveryRequiredChannels.set(client, channels);
    }
    return channels;
  }

  function isClientChannelRecoveryRequired(client: WebSocket, channelId: string): boolean {
    return clientRecoveryRequiredChannels.get(client)?.has(channelId) === true;
  }

  function clearClientChannelRecoveryRequired(client: WebSocket, channelId: string): void {
    clientRecoveryRequiredChannels.get(client)?.delete(channelId);
  }

  function clearPendingChannelRecoveryRequired(channelId: string): void {
    pendingChannelRecoveryRequired.delete(channelId);
  }

  function isPendingChannelRecoveryRequired(channelId: string): boolean {
    return pendingChannelRecoveryRequired.has(channelId);
  }

  function markPendingChannelRecoveryRequired(channelId: string): void {
    if (pendingChannelRecoveryRequired.has(channelId)) return;
    pendingChannelRecoveryRequired.add(channelId);
    pendingChannelMessages.set(channelId, createRecoveryRequiredQueue(channelId));
  }

  function markClientChannelRecoveryRequired(
    client: WebSocket,
    channelId: string,
    queueAgeMs: number,
  ): void {
    const channels = getClientRecoveryRequiredSet(client);
    if (channels.has(channelId)) return;
    channels.add(channelId);
    recordBrowserChannelDegraded(queueAgeMs);

    let clientQueues = clientBackpressureQueues.get(client);
    if (!clientQueues) {
      clientQueues = new Map();
      clientBackpressureQueues.set(client, clientQueues);
    }

    clientQueues.set(channelId, createRecoveryRequiredQueue(channelId));
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
        clearPendingChannelRecoveryRequired(channelId);
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
        clearPendingChannelRecoveryRequired(channelId);
      }, pendingChannelCleanupMs),
    );
  }

  function queueChannelMessagePerChannel(channelId: string, payload: unknown): void {
    if (isPendingChannelRecoveryRequired(channelId) && isChannelDataPayload(payload)) {
      return;
    }

    let queue = pendingChannelMessages.get(channelId);
    if (!queue) {
      queue = createPendingQueue();
      pendingChannelMessages.set(channelId, queue);
    }

    appendPendingMessage(queue, channelId, createPendingMessage(channelId, payload));

    if (trimPendingQueueToMaxBytes(queue, pendingChannelMaxBytes)) {
      markPendingChannelRecoveryRequired(channelId);
    }
  }

  function queueChannelMessagePerClient(
    client: WebSocket,
    channelId: string,
    payload: unknown,
  ): void {
    if (isClientChannelRecoveryRequired(client, channelId) && isChannelDataPayload(payload)) {
      recordBrowserChannelDroppedData();
      return;
    }

    const queue = getOrCreateClientQueue(client, channelId);

    appendPendingMessage(queue, channelId, createPendingMessage(channelId, payload));

    if (trimPendingQueueToMaxBytes(queue, pendingChannelMaxBytes)) {
      markClientChannelRecoveryRequired(client, channelId, getPendingQueueAgeMs(queue));
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
      recordBrowserChannelQueuedBytes(queue.totalBytes);
      if (bytesSaved > 0) {
        recordBrowserChannelCoalesced(bytesSaved);
      }
      return;
    }

    queue.messages.push(message);
    queue.totalBytes += message.sizeBytes;
    recordBrowserChannelQueuedBytes(queue.totalBytes);
  }

  function maybeDegradeClientQueue(
    client: WebSocket,
    channelId: string,
    queue: PendingQueue,
  ): void {
    if (isClientChannelRecoveryRequired(client, channelId)) {
      return;
    }

    const queueAgeMs = getPendingQueueAgeMs(queue);
    recordBrowserChannelQueueAge(queueAgeMs);

    if (queue.totalBytes > clientDegradeThresholds.maxQueuedBytes) {
      markClientChannelRecoveryRequired(client, channelId, queueAgeMs);
      return;
    }

    if (queueAgeMs > clientDegradeThresholds.maxQueueAgeMs) {
      markClientChannelRecoveryRequired(client, channelId, queueAgeMs);
      return;
    }

    if (queue.drainPasses >= clientDegradeThresholds.maxDrainPasses) {
      markClientChannelRecoveryRequired(client, channelId, queueAgeMs);
    }
  }

  function shouldRequireRecoveryForBacklog(channelId: string, queue: PendingQueue): boolean {
    if (isPendingChannelRecoveryRequired(channelId)) {
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

    if (shouldRequireRecoveryForBacklog(channelId, queue)) {
      recordBrowserChannelResetBinding();
      markClientChannelRecoveryRequired(client, channelId, getPendingQueueAgeMs(queue));
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

  function shouldThrottleForTransportBackpressure(client: WebSocket): boolean {
    const state = options.getPendingChannelSendState?.(client);
    if (!state) {
      return false;
    }

    return (
      state.queueAgeMs >= transportBusyThresholds.maxQueueAgeMs ||
      state.queueBytes >= transportBusyThresholds.maxQueueBytes ||
      state.queueDepth >= transportBusyThresholds.maxQueueDepth
    );
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

  function flushPendingChannelMessages(
    client: WebSocket,
    channelId: string,
  ): FlushPendingChannelMessagesResult {
    const queue = clientBackpressureQueues.get(client)?.get(channelId);
    const clientQueues = clientBackpressureQueues.get(client);
    if (!queue || queue.messages.length === 0) {
      return { madeProgress: false };
    }

    const shouldThrottleDrain = shouldThrottleForTransportBackpressure(client);

    let sent = 0;
    let sentBytes = 0;
    const maxMessagesToSend = shouldThrottleDrain ? 1 : queue.messages.length;
    for (const entry of queue.messages) {
      if (client.readyState !== WebSocket.OPEN) break;
      if (!options.send(client, serializePendingMessage(channelId, entry))) break;
      sent += 1;
      sentBytes += entry.sizeBytes;
      if (sent >= maxMessagesToSend) break;
    }
    if (sent === 0) {
      if (shouldThrottleDrain) {
        recordBrowserChannelTransportBusyDeferral();
      }
      return { madeProgress: false };
    }

    queue.messages.splice(0, sent);
    queue.totalBytes -= sentBytes;
    queue.drainPasses = 0;
    if (queue.messages.length !== 0) {
      return { madeProgress: true };
    }

    clientQueues?.delete(channelId);
    if (isClientChannelRecoveryRequired(client, channelId)) {
      recordBrowserChannelRecovered();
    }
    clearClientChannelRecoveryRequired(client, channelId);
    return { madeProgress: true };
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
          const flushResult = flushPendingChannelMessages(client, channelId);
          const queue = clientBackpressureQueues.get(client)?.get(channelId);
          if (queue && queue.messages.length > 0) {
            if (!flushResult.madeProgress) {
              if (!shouldThrottleForTransportBackpressure(client)) {
                queue.drainPasses += 1;
              }
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
    clearClientChannelRecoveryRequired(client, channelId);
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
    getClientRecoveryRequiredSet(client).clear();
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
      if (isClientChannelRecoveryRequired(client, channelId) && isChannelDataPayload(payload)) {
        recordBrowserChannelDroppedData();
        continue;
      }

      if (hasQueuedMessages(client, channelId)) {
        queueChannelMessagePerClient(client, channelId, payload);
        anyBackpressured = true;
        continue;
      }

      if (options.send(client, message.data)) {
        continue;
      }

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
    pendingChannelRecoveryRequired.clear();
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
