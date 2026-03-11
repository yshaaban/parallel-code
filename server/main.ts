import express from 'express';
import { createServer } from 'http';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { IPC } from '../electron/ipc/channels.js';
import { createIpcHandlers, BadRequestError } from '../electron/ipc/handlers.js';
import { NotFoundError } from '../electron/ipc/errors.js';
import { loadAppStateForEnv } from '../electron/ipc/storage.js';
import {
  killAgent,
  pauseAgent,
  resizeAgent,
  resumeAgent,
  writeToAgent,
  subscribeToAgent,
  unsubscribeFromAgent,
  clearAutoPauseReasonsForChannel,
  getAgentScrollback,
  getAgentCols,
} from '../electron/ipc/pty.js';
import {
  isAutomaticPauseReason,
  parseClientMessage,
  type PauseReason,
  type ServerMessage,
} from '../electron/remote/protocol.js';
import { buildRemoteAgentList } from '../electron/remote/agent-list.js';
import {
  buildAccessUrl as buildRemoteAccessUrl,
  buildOptionalAccessUrl as buildOptionalRemoteAccessUrl,
  getNetworkIps,
} from '../electron/remote/network.js';
import { createTokenComparator } from '../electron/remote/token-auth.js';
import { createWebSocketTransport } from '../electron/remote/ws-transport.js';
import { startGitWatcher, stopAllGitWatchers } from '../electron/ipc/git-watcher.js';
import { getWorktreeStatus, invalidateWorktreeStatusCache } from '../electron/ipc/git.js';
import { registerAgentLifecycleBroadcasts } from './agent-lifecycle.js';
import {
  createQueuedChannelMessage,
  isChannelDataPayload,
  type QueuedMessage,
} from './channel-frames.js';
import { createTaskNameRegistry } from './task-names.js';

type WebSocketClient = WebSocket;

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
const { safeCompare } = createTokenComparator(token);
const userDataPath =
  process.env.PARALLEL_CODE_USER_DATA_DIR ?? path.resolve(__dirname, '..', '..', '.server-data');

const app = express();
const server = createServer(app);

const wss = new WebSocketServer({
  server,
  maxPayload: 256 * 1024,
});

const boundChannels = new WeakMap<WebSocketClient, Set<string>>();
const channelSubscribers = new Map<string, Set<WebSocketClient>>();
const clientBatches = new WeakMap<WebSocketClient, ClientBatch>();

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
const taskNames = createTaskNameRegistry();

// Cap pending queue at 2MB per channel instead of 1024 messages (~87MB worst case).
const PENDING_CHANNEL_MAX_BYTES = 2 * 1024 * 1024;
const PENDING_CHANNEL_CLEANUP_MS = 30_000;
const WS_BACKPRESSURE_MAX_BYTES = 1_048_576;
const MICRO_BATCH_INTERVAL_MS = 8;

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

const savedState = loadAppStateForEnv({ userDataPath, isPackaged: false });
if (savedState) {
  taskNames.syncFromSavedState(savedState);
}

function cleanupClientState(client: WebSocketClient): void {
  transport.cleanupClient(client);

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
  transport.sendAgentControllers(client);
}

function sendAgentSnapshot(client: WebSocketClient): void {
  sendAgentList(client);
  sendAgentControllers(client);
}

function authenticateConnection(
  client: WebSocketClient,
  clientId?: string,
  lastSeq?: number,
): boolean {
  if (!transport.authenticateClient(client, clientId)) return false;
  if (lastSeq !== undefined) {
    replayStaledEvents(client, lastSeq);
  }
  sendAgentSnapshot(client);
  broadcastRemoteStatus();
  return true;
}

function shouldRequireAgentControl(reason?: PauseReason): boolean {
  return !isAutomaticPauseReason(reason);
}

function claimAgentControlOrSendError(
  client: WebSocketClient,
  agentId: string,
  action: string,
): boolean {
  if (transport.claimAgentControl(client, agentId)) return true;
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

const transport = createWebSocketTransport<WebSocketClient>({
  closeClient: (client, code, reason) => {
    client.close(code, reason);
  },
  sendBroadcastText: (client, text) => queueBatchedMessage(client, text),
  sendDirectText: (client, text) => sendSafely(client, text),
  terminateClient: (client) => {
    client.terminate();
  },
});

function isAuthorizedRequest(req: express.Request): boolean {
  const auth = req.header('authorization');
  if (auth?.startsWith('Bearer ') && safeCompare(auth.slice(7))) return true;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  return safeCompare(queryToken);
}

function replayStaledEvents(client: WebSocketClient, lastSeq = -1): void {
  transport.replayControlEvents(client, lastSeq);
}

function broadcast(message: ServerMessage): void {
  transport.broadcast(message);
}

function broadcastControl(message: ServerMessage): void {
  transport.broadcastControl(message);
}

function buildAgentList() {
  return buildRemoteAgentList({
    getTaskName: taskNames.getTaskName,
  });
}

function broadcastAgentList(): void {
  broadcast({
    type: 'agents',
    list: buildAgentList(),
  });
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

function broadcastRemoteStatus(): void {
  const connectedClients = transport.getAuthenticatedClientCount();
  broadcastControl({
    type: 'remote-status',
    connectedClients,
    peerClients: Math.max(connectedClients - 1, 0),
  });
}

function buildAccessUrl(host: string): string {
  return buildRemoteAccessUrl(host, port, token);
}

function buildOptionalAccessUrl(host: string | null): string | null {
  return buildOptionalRemoteAccessUrl(host, port, token);
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
    status: () => {
      const connectedClients = transport.getAuthenticatedClientCount();
      return {
        enabled: true,
        connectedClients,
        peerClients: Math.max(connectedClients - 1, 0),
        ...getServerInfo(),
      };
    },
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
      if (typeof body?.json === 'string') {
        taskNames.syncFromSavedState(body.json);
      }
    }

    if (channel === IPC.CreateTask) {
      const body = req.body as { name?: string } | undefined;
      const created = result as { id?: string; branch_name?: string; worktree_path?: string };
      if (created.id) {
        if (typeof body?.name === 'string' && body.name.trim()) {
          taskNames.setTaskName(created.id, body.name);
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
        taskNames.deleteTaskName(body.taskId);
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

const cleanupAgentLifecycleBroadcasts = registerAgentLifecycleBroadcasts({
  broadcastAgentList,
  broadcastControl,
  releaseAgentControl: (agentId) => {
    transport.releaseAgentControl(agentId);
  },
});

wss.on('connection', (ws, req) => {
  const client = ws as WebSocketClient;
  boundChannels.set(client, new Set());
  outputSubscriptions.set(client, new Map());

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (safeCompare(url.searchParams.get('token'))) {
    if (!authenticateConnection(client)) return;
  } else {
    transport.scheduleAuthTimeout(client);
  }

  client.on('pong', () => {
    transport.notePong(client);
  });

  client.on('message', (raw) => {
    const message = parseClientMessage(String(raw));
    if (!message) return;

    if (message.type === 'auth') {
      if (!safeCompare(message.token)) {
        client.close(4001, 'Unauthorized');
        return;
      }
      if (!authenticateConnection(client, message.clientId, message.lastSeq ?? -1)) {
        return;
      }
      return;
    }

    if (!transport.isAuthenticated(client)) {
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
    const wasAuthenticated = transport.isAuthenticated(client);
    cleanupClientState(client);
    if (wasAuthenticated) broadcastRemoteStatus();
  });
});

server.listen(port, '0.0.0.0', () => {
  const info = getServerInfo();
  process.stdout.write(`Parallel Code server listening on ${info.url}\n`);
  if (info.wifiUrl) process.stdout.write(`WiFi: ${info.wifiUrl}\n`);
  if (info.tailscaleUrl) process.stdout.write(`Tailscale: ${info.tailscaleUrl}\n`);
  transport.startHeartbeat();
});

function cleanup(): void {
  cleanupAgentLifecycleBroadcasts();
  stopAllGitWatchers();
  transport.stopHeartbeat();
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
  for (const client of wss.clients) {
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
