import express from 'express';
import { createServer } from 'http';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, timingSafeEqual } from 'crypto';
import { networkInterfaces } from 'os';
import { WebSocketServer, WebSocket } from 'ws';
import { IPC } from '../electron/ipc/channels.js';
import { createIpcHandlers, BadRequestError } from '../electron/ipc/handlers.js';
import { NotFoundError } from '../electron/ipc/errors.js';
import { loadAppStateForEnv } from '../electron/ipc/storage.js';
import {
  getAgentMeta,
  getActiveAgentIds,
  killAgent,
  pauseAgent,
  resizeAgent,
  resumeAgent,
  writeToAgent,
  onPtyEvent,
  subscribeToAgent,
  unsubscribeFromAgent,
  clearAutoPauseReasonsForChannel,
  getAgentScrollback,
  getAgentCols,
  getAgentPauseState,
} from '../electron/ipc/pty.js';
import {
  getRemoteAgentStatus,
  isAutomaticPauseReason,
  parseClientMessage,
  type PauseReason,
  type RemoteAgent,
  type ServerMessage,
} from '../electron/remote/protocol.js';
import { startGitWatcher, stopAllGitWatchers } from '../electron/ipc/git-watcher.js';
import { getWorktreeStatus, invalidateWorktreeStatusCache } from '../electron/ipc/git.js';

type WebSocketClient = WebSocket & {
  isAlive?: boolean;
  missedPongs?: number;
};

interface ServerInfo {
  url: string;
  wifiUrl: string | null;
  tailscaleUrl: string | null;
  token: string;
  port: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '..', '..', 'dist');
const distRemoteDir = path.resolve(__dirname, '..', '..', 'dist-remote');
const port = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
const token = process.env.AUTH_TOKEN || randomBytes(24).toString('base64url');
const tokenBuf = Buffer.from(token);
const userDataPath =
  process.env.PARALLEL_CODE_USER_DATA_DIR ?? path.resolve(__dirname, '..', '..', '.server-data');

const app = express();
const server = createServer(app);

const wss = new WebSocketServer({
  server,
  maxPayload: 256 * 1024,
});

const authenticatedClients = new Set<WebSocketClient>();
const authTimers = new WeakMap<WebSocketClient, ReturnType<typeof setTimeout>>();
const boundChannels = new WeakMap<WebSocketClient, Set<string>>();
const clientIds = new WeakMap<WebSocketClient, string>();
const channelSubscribers = new Map<string, Set<WebSocketClient>>();
const clientBatches = new WeakMap<WebSocketClient, ClientBatch>();
const agentControllers = new Map<string, { clientId: string; touchedAt: number }>();
let controlEventSeq = 0;

// Ring buffer for control-plane events (task-event, agent-lifecycle, git-status-changed)
// Allows slow clients to catch up on missed events after reconnection
const MAX_CONTROL_EVENT_BUFFER = 200;
interface ControlEvent {
  seq: number;
  json: string;
}
const controlEventRingBuffer: ControlEvent[] = [];

interface QueuedMessage {
  data: string | Buffer;
  sizeBytes: number;
}
interface PendingQueue {
  messages: QueuedMessage[];
  totalBytes: number;
}
// Per-channel queue for messages arriving when no subscribers exist
const pendingChannelMessages = new Map<string, PendingQueue>();
const pendingChannelResetRequired = new Set<string>();
// Per-client queues for messages that failed to send due to backpressure
const clientBackpressureQueues = new WeakMap<WebSocketClient, Map<string, PendingQueue>>();
const pendingChannelCleanupTimers = new Map<string, NodeJS.Timeout>();
const pendingChannelBacklogCleanupTimers = new Map<string, NodeJS.Timeout>();
const clientResetRequiredChannels = new WeakMap<WebSocketClient, Set<string>>();
const outputSubscriptions = new WeakMap<WebSocketClient, Map<string, (data: string) => void>>();
const taskNames = new Map<string, string>();

// Cap pending queue at 2MB per channel instead of 1024 messages (~87MB worst case).
const PENDING_CHANNEL_MAX_BYTES = 2 * 1024 * 1024;
const PENDING_CHANNEL_CLEANUP_MS = 30_000;
const CHANNEL_DATA_FRAME_TYPE = 0x01;
const CHANNEL_ID_BYTES = 36;
const CHANNEL_BINARY_HEADER_BYTES = 1 + CHANNEL_ID_BYTES;
const WS_BACKPRESSURE_MAX_BYTES = 1_048_576;
const MICRO_BATCH_INTERVAL_MS = 8;
const AGENT_CONTROL_LEASE_MS = 5_000;
const UUID_CHANNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ClientBatch {
  messages: string[];
  timer: NodeJS.Timeout | null;
}

// ---------------------------------------------------------------------------
// Optional latency simulation (env-var gated, zero overhead when unset)
// ---------------------------------------------------------------------------
const SIMULATE_LATENCY_MS = Number(process.env.SIMULATE_LATENCY_MS) || 0;
const SIMULATE_JITTER_MS = Number(process.env.SIMULATE_JITTER_MS) || 0;
const SIMULATE_PACKET_LOSS = Number(process.env.SIMULATE_PACKET_LOSS) || 0;

function syncTaskNamesFromJson(json: string): void {
  try {
    const state = JSON.parse(json) as { tasks?: Record<string, { id?: unknown; name?: unknown }> };
    if (!state.tasks) return;
    const nextTaskNames = new Map<string, string>();
    for (const task of Object.values(state.tasks)) {
      if (typeof task.id === 'string' && typeof task.name === 'string') {
        nextTaskNames.set(task.id, task.name);
      }
    }
    taskNames.clear();
    for (const [taskId, taskName] of nextTaskNames) {
      taskNames.set(taskId, taskName);
    }
  } catch (error) {
    console.warn('Ignoring malformed saved state:', error);
  }
}

function formatTaskId(taskId: string): string {
  return taskId.startsWith('task-') ? taskId.slice(5) : taskId;
}

function getTaskName(taskId: string): string {
  return taskNames.get(taskId) ?? formatTaskId(taskId);
}

function broadcastAgentController(agentId: string, controllerId: string | null): void {
  broadcastControl({
    type: 'agent-controller',
    agentId,
    controllerId,
  });
}

const savedState = loadAppStateForEnv({ userDataPath, isPackaged: false });
if (savedState) syncTaskNamesFromJson(savedState);

function cleanupClientState(client: WebSocketClient): void {
  authenticatedClients.delete(client);
  releaseClientControls(client);

  const timer = authTimers.get(client);
  if (timer) clearTimeout(timer);

  // Flush any pending batched messages
  const batch = clientBatches.get(client);
  if (batch?.timer) {
    clearTimeout(batch.timer);
  }

  const channels = boundChannels.get(client);
  if (channels) {
    for (const channelId of channels) {
      removeChannelSubscriber(channelId, client);
    }
    channels.clear();
  }

  const subscriptions = outputSubscriptions.get(client);
  if (subscriptions) {
    for (const [agentId, callback] of subscriptions) {
      unsubscribeFromAgent(agentId, callback);
    }
    subscriptions.clear();
  }
}

function getAgentController(agentId: string): { clientId: string; touchedAt: number } | null {
  const controller = agentControllers.get(agentId);
  if (!controller) return null;
  if (Date.now() - controller.touchedAt <= AGENT_CONTROL_LEASE_MS) return controller;
  agentControllers.delete(agentId);
  broadcastAgentController(agentId, null);
  return null;
}

function claimAgentControl(client: WebSocketClient, agentId: string): boolean {
  const clientId = clientIds.get(client);
  if (!clientId) return true;
  const current = getAgentController(agentId);
  if (current && current.clientId !== clientId) {
    return false;
  }
  agentControllers.set(agentId, { clientId, touchedAt: Date.now() });
  if (!current || current.clientId !== clientId) {
    broadcastAgentController(agentId, clientId);
  }
  return true;
}

function releaseAgentControl(agentId: string, clientId?: string): void {
  const controller = agentControllers.get(agentId);
  if (!controller) return;
  if (clientId && controller.clientId !== clientId) return;
  agentControllers.delete(agentId);
  broadcastAgentController(agentId, null);
}

function releaseClientControls(client: WebSocketClient): void {
  const clientId = clientIds.get(client);
  if (!clientId) return;
  for (const [agentId, controller] of agentControllers) {
    if (controller.clientId === clientId) {
      releaseAgentControl(agentId, clientId);
    }
  }
}

function sendSafely(client: WebSocketClient, data: string | Buffer): boolean {
  if (client.readyState !== WebSocket.OPEN) return false;
  if (client.bufferedAmount > WS_BACKPRESSURE_MAX_BYTES) return false;

  try {
    client.send(data);
    return true;
  } catch {
    cleanupClientState(client);
    try {
      client.close();
    } catch {
      /* ignore secondary close failures */
    }
    return false;
  }
}

function sendAgentError(
  client: WebSocketClient,
  agentId: string,
  fallbackMessage: string,
  error: unknown,
): void {
  sendJsonMessage(client, {
    type: 'agent-error',
    agentId,
    message: error instanceof Error ? error.message : fallbackMessage,
  });
}

function sendJsonMessage(client: WebSocketClient, message: ServerMessage): void {
  void sendSafely(client, JSON.stringify(message));
}

function sendAgentList(client: WebSocketClient): void {
  sendJsonMessage(client, {
    type: 'agents',
    list: buildAgentList(),
  });
}

function sendAgentControllers(client: WebSocketClient): void {
  for (const [agentId] of agentControllers) {
    const controller = getAgentController(agentId);
    if (!controller) continue;
    sendJsonMessage(client, {
      type: 'agent-controller',
      agentId,
      controllerId: controller.clientId,
    });
  }
}

function shouldRequireAgentControl(reason?: PauseReason): boolean {
  return !isAutomaticPauseReason(reason);
}

function claimAgentControlOrSendError(
  client: WebSocketClient,
  agentId: string,
  action: string,
): boolean {
  if (claimAgentControl(client, agentId)) return true;
  sendAgentError(
    client,
    agentId,
    `${action} failed`,
    new Error('Agent is controlled by another client.'),
  );
  return false;
}

function runAgentCommand(
  client: WebSocketClient,
  agentId: string,
  action: string,
  execute: () => void,
  requireControl = true,
): void {
  try {
    if (requireControl && !claimAgentControlOrSendError(client, agentId, action)) {
      return;
    }
    execute();
  } catch (error) {
    sendAgentError(client, agentId, `${action} failed`, error);
  }
}

function simulatedSend(client: WebSocketClient, data: string | Buffer): boolean {
  if (SIMULATE_PACKET_LOSS > 0 && Math.random() < SIMULATE_PACKET_LOSS) return true;
  if (SIMULATE_LATENCY_MS > 0 || SIMULATE_JITTER_MS > 0) {
    if (client.readyState !== WebSocket.OPEN) return false;
    const delay = SIMULATE_LATENCY_MS + Math.random() * SIMULATE_JITTER_MS;
    setTimeout(() => {
      void sendSafely(client, data);
    }, delay);
    return true;
  } else {
    return sendSafely(client, data);
  }
}

function flushClientBatch(client: WebSocketClient): void {
  const batch = clientBatches.get(client);
  if (!batch || batch.messages.length === 0) return;

  if (batch.timer) {
    clearTimeout(batch.timer);
    batch.timer = null;
  }

  // Send messages while respecting backpressure limit
  let i = 0;
  for (; i < batch.messages.length; i += 1) {
    const message = batch.messages[i];
    if (!message || !sendSafely(client, message)) {
      // Client hit backpressure — stop and re-schedule remaining messages
      batch.messages = batch.messages.slice(i);
      batch.timer = setTimeout(() => flushClientBatch(client), MICRO_BATCH_INTERVAL_MS);
      return;
    }
  }
  batch.messages = [];
}

function queueBatchedMessage(client: WebSocketClient, message: string): boolean {
  let batch = clientBatches.get(client);
  if (!batch) {
    batch = { messages: [], timer: null };
    clientBatches.set(client, batch);
  }

  batch.messages.push(message);

  if (!batch.timer) {
    batch.timer = setTimeout(() => {
      flushClientBatch(client);
    }, MICRO_BATCH_INTERVAL_MS);
  }

  return true;
}

function getNetworkIps(): { wifi: string | null; tailscale: string | null } {
  const nets = networkInterfaces();
  let wifi: string | null = null;
  let tailscale: string | null = null;

  for (const addrs of Object.values(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('100.')) {
        tailscale ??= addr.address;
      } else if (!addr.address.startsWith('172.')) {
        wifi ??= addr.address;
      }
    }
  }

  return { wifi, tailscale };
}

function safeCompare(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const buf = Buffer.from(candidate);
  if (buf.length !== tokenBuf.length) return false;
  return timingSafeEqual(buf, tokenBuf);
}

function isAuthorizedRequest(req: express.Request): boolean {
  const auth = req.header('authorization');
  if (auth?.startsWith('Bearer ') && safeCompare(auth.slice(7))) return true;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  return safeCompare(queryToken);
}

function addControlEventToBuffer(seq: number, json: string): void {
  const event: ControlEvent = {
    seq,
    json,
  };
  controlEventRingBuffer.push(event);
  while (controlEventRingBuffer.length > MAX_CONTROL_EVENT_BUFFER) {
    controlEventRingBuffer.shift();
  }
}

function replayStaledEvents(client: WebSocketClient, lastSeq = -1): void {
  for (const event of controlEventRingBuffer) {
    if (event.seq > lastSeq) {
      if (!sendSafely(client, event.json)) return;
    }
  }
}

function broadcast(message: ServerMessage): void {
  const json = JSON.stringify(message);
  for (const client of authenticatedClients) {
    void queueBatchedMessage(client, json);
  }
}

function broadcastControl(message: ServerMessage): void {
  const seq = controlEventSeq++;
  const json = JSON.stringify({ ...message, seq });

  addControlEventToBuffer(seq, json);
  for (const client of authenticatedClients) {
    void queueBatchedMessage(client, json);
  }
}

function buildAgentList(): RemoteAgent[] {
  const byTask = new Map<string, RemoteAgent>();

  for (const agentId of getActiveAgentIds()) {
    const meta = getAgentMeta(agentId);
    if (!meta || meta.isShell) continue;

    const agent: RemoteAgent = {
      agentId,
      taskId: meta.taskId,
      taskName: getTaskName(meta.taskId),
      status: getRemoteAgentStatus(getAgentPauseState(agentId)),
      exitCode: null,
      lastLine: '',
    };

    const existing = byTask.get(meta.taskId);
    // Keep the running agent, prefer running/paused over exited
    if (!existing || existing.status === 'exited') {
      byTask.set(meta.taskId, agent);
    }
  }

  return Array.from(byTask.values());
}

function buildChannelJsonMessage(channelId: string, payload: unknown): string {
  return JSON.stringify({ type: 'channel', channelId, payload } satisfies ServerMessage);
}

function isChannelDataPayload(payload: unknown): payload is { type: 'Data'; data: string } {
  const candidate = payload as { type?: unknown; data?: unknown } | null;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    candidate?.type === 'Data' &&
    typeof candidate.data === 'string'
  );
}

function buildBinaryChannelFrame(channelId: string, base64Data: string): Buffer | null {
  if (!UUID_CHANNEL_ID_RE.test(channelId)) return null;

  const rawDataLength = Buffer.byteLength(base64Data, 'base64');
  const frame = Buffer.allocUnsafe(CHANNEL_BINARY_HEADER_BYTES + rawDataLength);
  frame[0] = CHANNEL_DATA_FRAME_TYPE;
  frame.write(channelId, 1, CHANNEL_ID_BYTES, 'ascii');
  const bytesWritten = frame.write(
    base64Data,
    CHANNEL_BINARY_HEADER_BYTES,
    rawDataLength,
    'base64',
  );
  return bytesWritten === rawDataLength ? frame : null;
}

function createQueuedChannelMessage(channelId: string, payload: unknown): QueuedMessage {
  if (isChannelDataPayload(payload)) {
    const binaryFrame = buildBinaryChannelFrame(channelId, payload.data);
    if (binaryFrame) {
      return {
        data: binaryFrame,
        sizeBytes: binaryFrame.length,
      };
    }
  }

  const json = buildChannelJsonMessage(channelId, payload);
  return {
    data: json,
    sizeBytes: Buffer.byteLength(json),
  };
}

function getClientResetRequiredSet(client: WebSocketClient): Set<string> {
  let channels = clientResetRequiredChannels.get(client);
  if (!channels) {
    channels = new Set();
    clientResetRequiredChannels.set(client, channels);
  }
  return channels;
}

function isClientChannelResetRequired(client: WebSocketClient, channelId: string): boolean {
  return clientResetRequiredChannels.get(client)?.has(channelId) === true;
}

function clearClientChannelResetRequired(client: WebSocketClient, channelId: string): void {
  clientResetRequiredChannels.get(client)?.delete(channelId);
}

function isPendingChannelResetRequired(channelId: string): boolean {
  return pendingChannelResetRequired.has(channelId);
}

function clearPendingChannelResetRequired(channelId: string): void {
  pendingChannelResetRequired.delete(channelId);
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

function markClientChannelResetRequired(client: WebSocketClient, channelId: string): void {
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

function removeChannelSubscriber(channelId: string, client: WebSocketClient): void {
  const subscribers = channelSubscribers.get(channelId);
  if (!subscribers) return;
  subscribers.delete(client);
  if (subscribers.size === 0) {
    channelSubscribers.delete(channelId);
    schedulePendingChannelCleanup(channelId);
    // When the last subscriber for a channel disconnects, clear automatic
    // pause reasons (flow-control, restore) for agents bound to this channel.
    // We do NOT call detachAgentOutput() because the PTY channel must
    // remain bound so that reconnecting clients can rebind and receive
    // live output without re-spawning the agent.
    clearAutoPauseReasonsForChannel(channelId);
  }
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
      // Clean up the per-channel queue if no subscribers are waiting
      if ((channelSubscribers.get(channelId)?.size ?? 0) === 0) {
        pendingChannelMessages.delete(channelId);
        clearPendingChannelResetRequired(channelId);
      }
    }, PENDING_CHANNEL_CLEANUP_MS),
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
    }, PENDING_CHANNEL_CLEANUP_MS),
  );
}

// Queue message in per-channel queue (for when no subscribers exist)
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
  // Evict oldest messages until under byte limit
  let overflowed = false;
  while (queue.totalBytes > PENDING_CHANNEL_MAX_BYTES && queue.messages.length > 1) {
    const dropped = queue.messages.shift();
    if (!dropped) break;
    queue.totalBytes -= dropped.sizeBytes;
    overflowed = true;
  }
  if (overflowed) {
    markPendingChannelResetRequired(channelId);
  }
}

// Queue message in per-client backpressure queue (for when send fails)
function queueChannelMessagePerClient(
  client: WebSocketClient,
  channelId: string,
  payload: unknown,
  message = createQueuedChannelMessage(channelId, payload),
): void {
  if (isClientChannelResetRequired(client, channelId)) {
    if (isChannelDataPayload(payload)) return;
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
  // Evict oldest messages until under byte limit
  let overflowed = false;
  while (queue.totalBytes > PENDING_CHANNEL_MAX_BYTES && queue.messages.length > 1) {
    const dropped = queue.messages.shift();
    if (!dropped) break;
    queue.totalBytes -= dropped.sizeBytes;
    overflowed = true;
  }
  if (overflowed) {
    markClientChannelResetRequired(client, channelId);
  }
}

function copyPendingChannelBacklogToClient(client: WebSocketClient, channelId: string): void {
  const queue = pendingChannelMessages.get(channelId);
  if (!queue || queue.messages.length === 0) return;
  for (const entry of queue.messages) {
    queueChannelMessagePerClient(client, channelId, null, entry);
  }
  schedulePendingChannelBacklogCleanup(channelId);
}

// --- Heartbeat ping-pong ---
// Send server-initiated pings every 30s to keep long-lived NAT connections alive
// and detect stale clients. Clients missing 2 consecutive pongs are terminated.
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MISSED_PONGS = 2;
let heartbeatTimer: NodeJS.Timeout | null = null;

function broadcastRemoteStatus(): void {
  broadcastControl({
    type: 'remote-status',
    connectedClients: authenticatedClients.size,
    peerClients: Math.max(authenticatedClients.size - 1, 0),
  });
}

function buildAccessUrl(host: string): string {
  return `http://${host}:${port}?token=${token}`;
}

function buildOptionalAccessUrl(host: string | null): string | null {
  if (!host) return null;
  return buildAccessUrl(host);
}

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const client of authenticatedClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if ((client.missedPongs ?? 0) >= MAX_MISSED_PONGS) {
        cleanupClientState(client);
        client.terminate();
        continue;
      }
      client.missedPongs = (client.missedPongs ?? 0) + 1;
      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

// --- Backpressure drain ---
// When sends fail due to bufferedAmount backpressure (not disconnection),
// queued messages need to be retried periodically.
const BACKPRESSURE_DRAIN_INTERVAL_MS = 250;
let backpressureDrainTimer: NodeJS.Timeout | null = null;
const backpressuredChannels = new Set<string>();

function hasQueuedMessages(client: WebSocketClient, channelId: string): boolean {
  return (clientBackpressureQueues.get(client)?.get(channelId)?.messages.length ?? 0) > 0;
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
  }, BACKPRESSURE_DRAIN_INTERVAL_MS);
}

function sendChannelMessage(channelId: string, payload: unknown): void {
  const subscribers = channelSubscribers.get(channelId);
  const message = createQueuedChannelMessage(channelId, payload);

  // If no subscribers, queue in per-channel queue for later replay
  if (!subscribers || subscribers.size === 0) {
    queueChannelMessagePerChannel(channelId, payload, message);
    return;
  }

  // Try to send to all subscribers
  let anyBackpressured = false;
  for (const client of subscribers) {
    if (!simulatedSend(client, message.data)) {
      // Send failed for this client — queue into client's backpressure queue
      queueChannelMessagePerClient(client, channelId, payload, message);
      anyBackpressured = true;
    }
  }

  if (anyBackpressured) {
    // At least one subscriber is backpressured — schedule drain
    backpressuredChannels.add(channelId);
    scheduleBackpressureDrain();
  }
}

function flushPendingChannelMessages(ws: WebSocketClient, channelId: string): void {
  const queue = clientBackpressureQueues.get(ws)?.get(channelId);
  const clientQueues = clientBackpressureQueues.get(ws);
  if (!queue || queue.messages.length === 0) return;

  let sent = 0;
  let sentBytes = 0;
  for (const entry of queue.messages) {
    if (ws.readyState !== WebSocket.OPEN) break;
    if (!simulatedSend(ws, entry.data)) break;
    sent++;
    sentBytes += entry.sizeBytes;
  }
  if (sent === 0) return;
  queue.messages.splice(0, sent);
  queue.totalBytes -= sentBytes;
  if (queue.messages.length === 0) {
    clientQueues?.delete(channelId);
    clearClientChannelResetRequired(ws, channelId);
  }
}

function getServerInfo(): ServerInfo {
  const { wifi, tailscale } = getNetworkIps();
  return {
    url: buildAccessUrl('127.0.0.1'),
    wifiUrl: buildOptionalAccessUrl(wifi),
    tailscaleUrl: buildOptionalAccessUrl(tailscale),
    token,
    port,
  };
}

const handlers = createIpcHandlers({
  userDataPath,
  isPackaged: false,
  sendToChannel: sendChannelMessage,
  emitIpcEvent: (channel, payload) => {
    broadcastControl({
      type: 'ipc-event',
      channel,
      payload,
    });
  },
  remoteAccess: {
    start: async () => getServerInfo(),
    stop: async () => {},
    status: () => ({
      enabled: true,
      connectedClients: authenticatedClients.size,
      peerClients: Math.max(authenticatedClients.size - 1, 0),
      ...getServerInfo(),
    }),
  },
});

// Start git watchers for all existing tasks on boot (not just when agent spawns).
// This ensures inactive tasks get immediate fs.watch coverage.
const savedJson = loadAppStateForEnv({ userDataPath, isPackaged: false });
if (savedJson) {
  try {
    const parsed = JSON.parse(savedJson) as {
      tasks?: Record<string, { id: string; worktreePath?: string }>;
    };
    for (const task of Object.values(parsed.tasks ?? {})) {
      if (!task.id || !task.worktreePath) continue;
      const taskId = task.id;
      const worktreePath = task.worktreePath;
      void startGitWatcher(taskId, worktreePath, () => {
        invalidateWorktreeStatusCache(worktreePath);
        void getWorktreeStatus(worktreePath)
          .then((status) => {
            broadcastControl({
              type: 'ipc-event',
              channel: IPC.GitStatusChanged,
              payload: { worktreePath, status },
            });
          })
          .catch(() => {
            broadcastControl({
              type: 'ipc-event',
              channel: IPC.GitStatusChanged,
              payload: { worktreePath },
            });
          });
      });
    }
  } catch {
    // malformed saved state — skip boot watcher init
  }
}

app.use('/api', express.json({ limit: '1mb' }));

app.post('/api/ipc/:channel', async (req, res) => {
  if (!isAuthorizedRequest(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const channel = req.params.channel as IPC;
  const handler = handlers[channel];
  if (!handler) {
    res.status(404).json({ error: 'unknown ipc channel' });
    return;
  }

  try {
    const args = (req.body ?? undefined) as Record<string, unknown> | undefined;
    const result = await handler(args);

    if (channel === IPC.SaveAppState) {
      const body = req.body as { json?: string } | undefined;
      if (typeof body?.json === 'string') syncTaskNamesFromJson(body.json);
    }

    if (channel === IPC.CreateTask) {
      const body = req.body as { name?: string } | undefined;
      const created = result as { id?: string; branch_name?: string; worktree_path?: string };
      if (created.id) {
        if (typeof body?.name === 'string' && body.name.trim()) {
          taskNames.set(created.id, body.name);
        }
        broadcastControl({
          type: 'task-event',
          event: 'created',
          taskId: created.id,
          name: typeof body?.name === 'string' ? body.name : undefined,
          branchName: created.branch_name,
          worktreePath: created.worktree_path,
        });
      }
    }

    if (channel === IPC.DeleteTask) {
      const body = req.body as
        | { taskId?: string; branchName?: string; projectRoot?: string }
        | undefined;
      if (typeof body?.taskId === 'string') {
        taskNames.delete(body.taskId);
        broadcastControl({
          type: 'task-event',
          event: 'deleted',
          taskId: body.taskId,
          branchName: body.branchName,
        });
      }
      broadcastControl({
        type: 'git-status-changed',
        branchName: typeof body?.branchName === 'string' ? body.branchName : undefined,
        projectRoot: typeof body?.projectRoot === 'string' ? body.projectRoot : undefined,
      });
    }

    if (channel === IPC.MergeTask || channel === IPC.PushTask) {
      const body = req.body as { projectRoot?: string; branchName?: string } | undefined;
      broadcastControl({
        type: 'git-status-changed',
        projectRoot: typeof body?.projectRoot === 'string' ? body.projectRoot : undefined,
        branchName: typeof body?.branchName === 'string' ? body.branchName : undefined,
      });
    }

    res.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'internal error';

    if (error instanceof BadRequestError) {
      res.status(400).json({ error: message });
    } else if (error instanceof NotFoundError) {
      res.status(404).json({ error: message });
    } else {
      console.error('[server] IPC handler failed:', channel, error);
      res.status(500).json({ error: 'internal error' });
    }
  }
});

if (existsSync(distRemoteDir)) {
  app.use('/remote', express.static(distRemoteDir));
  app.get('/remote/{*path}', (_req, res) => {
    const indexPath = path.join(distRemoteDir, 'index.html');
    if (!existsSync(indexPath)) {
      res.status(404).send('dist-remote/index.html not found. Run "npm run build:remote" first.');
      return;
    }
    res.sendFile(indexPath);
  });
}

if (existsSync(distDir)) {
  app.use(express.static(distDir));
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    next();
    return;
  }

  const indexPath = path.join(distDir, 'index.html');
  if (!existsSync(indexPath)) {
    res.status(404).send('dist/index.html not found. Build the frontend first.');
    return;
  }
  res.sendFile(indexPath);
});

const unsubSpawn = onPtyEvent('spawn', (agentId) => {
  const meta = getAgentMeta(agentId);
  broadcast({
    type: 'agents',
    list: buildAgentList(),
  });
  broadcastControl({
    type: 'agent-lifecycle',
    event: 'spawn',
    agentId,
    taskId: meta?.taskId ?? null,
    isShell: meta?.isShell ?? null,
    status: 'running',
  });
});

const unsubListChanged = onPtyEvent('list-changed', () => {
  broadcast({
    type: 'agents',
    list: buildAgentList(),
  });
});

const unsubPause = onPtyEvent('pause', (agentId) => {
  const meta = getAgentMeta(agentId);
  broadcast({
    type: 'agents',
    list: buildAgentList(),
  });
  broadcastControl({
    type: 'agent-lifecycle',
    event: 'pause',
    agentId,
    taskId: meta?.taskId ?? null,
    isShell: meta?.isShell ?? null,
    status: getRemoteAgentStatus(getAgentPauseState(agentId), 'paused'),
  });
});

const unsubResume = onPtyEvent('resume', (agentId) => {
  const meta = getAgentMeta(agentId);
  broadcast({
    type: 'agents',
    list: buildAgentList(),
  });
  broadcastControl({
    type: 'agent-lifecycle',
    event: 'resume',
    agentId,
    taskId: meta?.taskId ?? null,
    isShell: meta?.isShell ?? null,
    status: 'running',
  });
});

const unsubExit = onPtyEvent('exit', (agentId, data) => {
  const meta = getAgentMeta(agentId);
  const { exitCode, signal } = (data ?? {}) as { exitCode?: number | null; signal?: string | null };
  releaseAgentControl(agentId);
  broadcastControl({
    type: 'status',
    agentId,
    status: 'exited',
    exitCode: exitCode ?? null,
  });
  broadcastControl({
    type: 'agent-lifecycle',
    event: 'exit',
    agentId,
    taskId: meta?.taskId ?? null,
    isShell: meta?.isShell ?? null,
    status: 'exited',
    exitCode: exitCode ?? null,
    signal: signal ?? null,
  });
  setTimeout(() => {
    broadcast({
      type: 'agents',
      list: buildAgentList(),
    });
  }, 100);
});

wss.on('connection', (ws, req) => {
  const client = ws as WebSocketClient;
  boundChannels.set(client, new Set());
  outputSubscriptions.set(client, new Map());
  client.missedPongs = 0;

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (safeCompare(url.searchParams.get('token'))) {
    authenticatedClients.add(client);
    clientIds.set(client, randomBytes(12).toString('hex'));
    sendAgentList(client);
    sendAgentControllers(client);
    broadcastRemoteStatus();
  } else {
    const authTimer = setTimeout(() => {
      if (!authenticatedClients.has(client)) {
        client.close(4001, 'Auth timeout');
      }
    }, 5_000);
    authTimers.set(client, authTimer);
  }

  client.on('pong', () => {
    client.missedPongs = 0;
  });

  client.on('message', (raw) => {
    const message = parseClientMessage(String(raw));
    if (!message) return;

    if (message.type === 'auth') {
      if (!safeCompare(message.token)) {
        client.close(4001, 'Unauthorized');
        return;
      }
      clientIds.set(client, message.clientId ?? randomBytes(12).toString('hex'));
      const timer = authTimers.get(client);
      if (timer) clearTimeout(timer);
      replayStaledEvents(client, message.lastSeq ?? -1);
      sendAgentList(client);
      sendAgentControllers(client);
      authenticatedClients.add(client);
      broadcastRemoteStatus();
      return;
    }

    if (!authenticatedClients.has(client)) {
      client.close(4001, 'Unauthorized');
      return;
    }

    switch (message.type) {
      case 'ping':
        sendJsonMessage(client, {
          type: 'pong',
        });
        break;
      case 'input':
        runAgentCommand(client, message.agentId, 'write', () => {
          writeToAgent(message.agentId, message.data);
        });
        break;
      case 'resize':
        runAgentCommand(client, message.agentId, 'resize', () => {
          resizeAgent(message.agentId, message.cols, message.rows);
        });
        break;
      case 'kill':
        runAgentCommand(client, message.agentId, 'kill', () => {
          killAgent(message.agentId);
        });
        break;
      case 'pause':
        runAgentCommand(
          client,
          message.agentId,
          'pause',
          () => {
            pauseAgent(message.agentId, message.reason, message.channelId);
          },
          shouldRequireAgentControl(message.reason),
        );
        break;
      case 'resume':
        runAgentCommand(
          client,
          message.agentId,
          'resume',
          () => {
            resumeAgent(message.agentId, message.reason, message.channelId);
          },
          shouldRequireAgentControl(message.reason),
        );
        break;
      case 'bind-channel': {
        const channels = boundChannels.get(client);
        channels?.add(message.channelId);
        cancelPendingChannelCleanup(message.channelId);
        let subscribers = channelSubscribers.get(message.channelId);
        if (!subscribers) {
          subscribers = new Set();
          channelSubscribers.set(message.channelId, subscribers);
        }
        subscribers.add(client);
        copyPendingChannelBacklogToClient(client, message.channelId);
        flushPendingChannelMessages(client, message.channelId);
        // If partial flush left messages (backpressure), schedule drain
        if (hasQueuedMessages(client, message.channelId)) {
          backpressuredChannels.add(message.channelId);
          scheduleBackpressureDrain();
        }
        void sendSafely(
          client,
          JSON.stringify({
            type: 'channel-bound',
            channelId: message.channelId,
          } satisfies ServerMessage),
        );
        break;
      }
      case 'unbind-channel': {
        const channels = boundChannels.get(client);
        channels?.delete(message.channelId);
        removeChannelSubscriber(message.channelId, client);
        cancelPendingChannelCleanup(message.channelId);
        // Delete only from this client's backpressure queue
        const clientQueues = clientBackpressureQueues.get(client);
        clientQueues?.delete(message.channelId);
        clearClientChannelResetRequired(client, message.channelId);
        break;
      }
      case 'subscribe': {
        const subscriptions = outputSubscriptions.get(client);
        if (!subscriptions || subscriptions.has(message.agentId)) break;

        const scrollback = getAgentScrollback(message.agentId);
        if (scrollback) {
          void sendSafely(
            client,
            JSON.stringify({
              type: 'scrollback',
              agentId: message.agentId,
              data: scrollback,
              cols: getAgentCols(message.agentId),
            } satisfies ServerMessage),
          );
        }

        const callback = (data: string) => {
          if (client.readyState === WebSocket.OPEN) {
            void sendSafely(
              client,
              JSON.stringify({
                type: 'output',
                agentId: message.agentId,
                data,
              } satisfies ServerMessage),
            );
          }
        };

        if (subscribeToAgent(message.agentId, callback)) {
          subscriptions.set(message.agentId, callback);
        }
        break;
      }
      case 'unsubscribe': {
        const subscriptions = outputSubscriptions.get(client);
        const callback = subscriptions?.get(message.agentId);
        if (callback) {
          unsubscribeFromAgent(message.agentId, callback);
          subscriptions?.delete(message.agentId);
        }
        break;
      }

      case 'permission-response': {
        const response = message.action === 'approve' ? 'y\n' : 'n\n';
        if (!claimAgentControlOrSendError(client, message.agentId, 'permission response')) {
          break;
        }
        try {
          writeToAgent(message.agentId, response);
        } catch {
          /* agent already gone */
        }
        break;
      }
    }
  });

  client.on('close', () => {
    const wasAuthenticated = authenticatedClients.has(client);
    cleanupClientState(client);
    if (wasAuthenticated) broadcastRemoteStatus();
  });
});

server.listen(port, '0.0.0.0', () => {
  const info = getServerInfo();
  process.stdout.write(`Parallel Code server listening on ${info.url}\n`);
  if (info.wifiUrl) process.stdout.write(`WiFi: ${info.wifiUrl}\n`);
  if (info.tailscaleUrl) process.stdout.write(`Tailscale: ${info.tailscaleUrl}\n`);
  startHeartbeat();
});

function cleanup(): void {
  unsubSpawn();
  unsubListChanged();
  unsubPause();
  unsubResume();
  unsubExit();
  stopAllGitWatchers();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (backpressureDrainTimer) {
    clearTimeout(backpressureDrainTimer);
    backpressureDrainTimer = null;
  }
  backpressuredChannels.clear();
  for (const timer of pendingChannelCleanupTimers.values()) {
    clearTimeout(timer);
  }
  pendingChannelCleanupTimers.clear();
  for (const timer of pendingChannelBacklogCleanupTimers.values()) {
    clearTimeout(timer);
  }
  pendingChannelBacklogCleanupTimers.clear();
  for (const client of authenticatedClients) {
    client.close();
  }
}

function shutdown(): void {
  cleanup();
  server.close(() => process.exit(0));
}

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught Exception:', err);
  // Do not shutdown — let the server continue serving other clients
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled Rejection:', reason);
  // Do not shutdown — unhandled rejections are non-fatal in this server
});

process.on('SIGINT', () => {
  shutdown();
});

process.on('SIGTERM', () => {
  shutdown();
});
