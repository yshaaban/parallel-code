import { WebSocket } from 'ws';
import {
  createQueuedChannelMessage,
  isChannelDataPayload,
  type QueuedMessage,
} from './channel-frames.js';

interface PendingQueue {
  messages: QueuedMessage[];
  totalBytes: number;
}

export interface CreateBrowserChannelManagerOptions {
  clearAutoPauseReasonsForChannel: (channelId: string) => void;
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

    const resetEntry = createQueuedChannelMessage(channelId, {
      type: 'ResetRequired',
      reason: 'backpressure',
    });
    pendingChannelMessages.set(channelId, {
      messages: [resetEntry],
      totalBytes: resetEntry.sizeBytes,
    });
  }

  function markClientChannelResetRequired(client: WebSocket, channelId: string): void {
    const channels = getClientResetRequiredSet(client);
    if (channels.has(channelId)) return;
    channels.add(channelId);

    let clientQueues = clientBackpressureQueues.get(client);
    if (!clientQueues) {
      clientQueues = new Map();
      clientBackpressureQueues.set(client, clientQueues);
    }

    const resetEntry = createQueuedChannelMessage(channelId, {
      type: 'ResetRequired',
      reason: 'backpressure',
    });
    clientQueues.set(channelId, {
      messages: [resetEntry],
      totalBytes: resetEntry.sizeBytes,
    });
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

  function queueChannelMessagePerChannel(
    channelId: string,
    payload: unknown,
    message = createQueuedChannelMessage(channelId, payload),
  ): void {
    if (isPendingChannelResetRequired(channelId) && isChannelDataPayload(payload)) {
      return;
    }

    let queue = pendingChannelMessages.get(channelId);
    if (!queue) {
      queue = { messages: [], totalBytes: 0 };
      pendingChannelMessages.set(channelId, queue);
    }

    queue.messages.push(message);
    queue.totalBytes += message.sizeBytes;

    let overflowed = false;
    while (queue.totalBytes > pendingChannelMaxBytes && queue.messages.length > 1) {
      const dropped = queue.messages.shift();
      if (!dropped) break;
      queue.totalBytes -= dropped.sizeBytes;
      overflowed = true;
    }
    if (overflowed) {
      markPendingChannelResetRequired(channelId);
    }
  }

  function queueChannelMessagePerClient(
    client: WebSocket,
    channelId: string,
    payload: unknown,
    message = createQueuedChannelMessage(channelId, payload),
  ): void {
    if (isClientChannelResetRequired(client, channelId) && isChannelDataPayload(payload)) {
      return;
    }

    let clientQueues = clientBackpressureQueues.get(client);
    if (!clientQueues) {
      clientQueues = new Map();
      clientBackpressureQueues.set(client, clientQueues);
    }

    let queue = clientQueues.get(channelId);
    if (!queue) {
      queue = { messages: [], totalBytes: 0 };
      clientQueues.set(channelId, queue);
    }

    queue.messages.push(message);
    queue.totalBytes += message.sizeBytes;

    let overflowed = false;
    while (queue.totalBytes > pendingChannelMaxBytes && queue.messages.length > 1) {
      const dropped = queue.messages.shift();
      if (!dropped) break;
      queue.totalBytes -= dropped.sizeBytes;
      overflowed = true;
    }
    if (overflowed) {
      markClientChannelResetRequired(client, channelId);
    }
  }

  function copyPendingChannelBacklogToClient(client: WebSocket, channelId: string): void {
    const queue = pendingChannelMessages.get(channelId);
    if (!queue || queue.messages.length === 0) return;
    for (const entry of queue.messages) {
      queueChannelMessagePerClient(client, channelId, null, entry);
    }
    schedulePendingChannelBacklogCleanup(channelId);
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

  function flushPendingChannelMessages(client: WebSocket, channelId: string): void {
    const queue = clientBackpressureQueues.get(client)?.get(channelId);
    const clientQueues = clientBackpressureQueues.get(client);
    if (!queue || queue.messages.length === 0) return;

    let sent = 0;
    let sentBytes = 0;
    for (const entry of queue.messages) {
      if (client.readyState !== WebSocket.OPEN) break;
      if (!options.send(client, entry.data)) break;
      sent += 1;
      sentBytes += entry.sizeBytes;
    }
    if (sent === 0) return;

    queue.messages.splice(0, sent);
    queue.totalBytes -= sentBytes;
    if (queue.messages.length !== 0) return;

    clientQueues?.delete(channelId);
    clearClientChannelResetRequired(client, channelId);
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
          flushPendingChannelMessages(client, channelId);
          if (hasQueuedMessages(client, channelId)) {
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
      queueChannelMessagePerChannel(channelId, payload, message);
      return;
    }

    let anyBackpressured = false;
    for (const client of subscribers) {
      if (options.send(client, message.data)) continue;
      queueChannelMessagePerClient(client, channelId, payload, message);
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
