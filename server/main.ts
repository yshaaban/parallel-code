import express from 'express';
import { createServer } from 'http';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, timingSafeEqual } from 'crypto';
import { networkInterfaces } from 'os';
import { WebSocketServer, WebSocket } from 'ws';
import { IPC } from '../electron/ipc/channels.js';
import { createIpcHandlers } from '../electron/ipc/handlers.js';
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
  getAgentScrollback,
  getAgentCols,
} from '../electron/ipc/pty.js';
import {
  parseClientMessage,
  type RemoteAgent,
  type ServerMessage,
} from '../electron/remote/protocol.js';

type WebSocketClient = WebSocket & {
  isAlive?: boolean;
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

const app = express();
const server = createServer(app);

const wss = new WebSocketServer({
  server,
  maxPayload: 256 * 1024,
});

const authenticatedClients = new Set<WebSocketClient>();
const authTimers = new WeakMap<WebSocketClient, ReturnType<typeof setTimeout>>();
const boundChannels = new WeakMap<WebSocketClient, Set<string>>();
const channelSubscribers = new Map<string, Set<WebSocketClient>>();

interface QueuedMessage {
  data: string | Buffer;
  sizeBytes: number;
}
interface PendingQueue {
  messages: QueuedMessage[];
  totalBytes: number;
}
const pendingChannelMessages = new Map<string, PendingQueue>();
const pendingChannelCleanupTimers = new Map<string, NodeJS.Timeout>();
const outputSubscriptions = new WeakMap<WebSocketClient, Map<string, (data: string) => void>>();

// Cap pending queue at 2MB per channel instead of 1024 messages (~87MB worst case).
const PENDING_CHANNEL_MAX_BYTES = 2 * 1024 * 1024;
const PENDING_CHANNEL_CLEANUP_MS = 30_000;
const CHANNEL_DATA_FRAME_TYPE = 0x01;
const CHANNEL_ID_BYTES = 36;
const CHANNEL_BINARY_HEADER_BYTES = 1 + CHANNEL_ID_BYTES;
const UUID_CHANNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Optional latency simulation (env-var gated, zero overhead when unset)
// ---------------------------------------------------------------------------
const SIMULATE_LATENCY_MS = Number(process.env.SIMULATE_LATENCY_MS) || 0;
const SIMULATE_JITTER_MS = Number(process.env.SIMULATE_JITTER_MS) || 0;
const SIMULATE_PACKET_LOSS = Number(process.env.SIMULATE_PACKET_LOSS) || 0;

function cleanupClientState(client: WebSocketClient): void {
  authenticatedClients.delete(client);

  const timer = authTimers.get(client);
  if (timer) clearTimeout(timer);

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

function broadcast(message: ServerMessage): void {
  const json = JSON.stringify(message);
  for (const client of authenticatedClients) {
    void sendSafely(client, json);
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
      taskName: meta.taskId,
      status: 'running',
      exitCode: null,
      lastLine: '',
    };

    const existing = byTask.get(meta.taskId);
    if (!existing || existing.status !== 'running') {
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

function removeChannelSubscriber(channelId: string, client: WebSocketClient): void {
  const subscribers = channelSubscribers.get(channelId);
  if (!subscribers) return;
  subscribers.delete(client);
  if (subscribers.size === 0) {
    channelSubscribers.delete(channelId);
    schedulePendingChannelCleanup(channelId);
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
      if ((channelSubscribers.get(channelId)?.size ?? 0) === 0) {
        pendingChannelMessages.delete(channelId);
      }
    }, PENDING_CHANNEL_CLEANUP_MS),
  );
}

function queueChannelMessage(
  channelId: string,
  payload: unknown,
  message = createQueuedChannelMessage(channelId, payload),
): void {
  let queue = pendingChannelMessages.get(channelId);
  if (!queue) {
    queue = { messages: [], totalBytes: 0 };
    pendingChannelMessages.set(channelId, queue);
  }
  queue.messages.push(message);
  queue.totalBytes += message.sizeBytes;
  // Evict oldest messages until under byte limit
  while (queue.totalBytes > PENDING_CHANNEL_MAX_BYTES && queue.messages.length > 1) {
    const dropped = queue.messages.shift();
    if (!dropped) break;
    queue.totalBytes -= dropped.sizeBytes;
  }
}

function sendChannelMessage(channelId: string, payload: unknown): void {
  const message = createQueuedChannelMessage(channelId, payload);
  let delivered = false;
  for (const client of channelSubscribers.get(channelId) ?? []) {
    if (simulatedSend(client, message.data)) {
      delivered = true;
    }
  }

  if (!delivered) queueChannelMessage(channelId, payload, message);
}

function flushPendingChannelMessages(ws: WebSocketClient, channelId: string): void {
  const queue = pendingChannelMessages.get(channelId);
  if (!queue || queue.messages.length === 0) return;
  for (const entry of queue.messages) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!simulatedSend(ws, entry.data)) return;
  }
  pendingChannelMessages.delete(channelId);
}

function getServerInfo(): ServerInfo {
  const { wifi, tailscale } = getNetworkIps();
  return {
    url: `http://127.0.0.1:${port}?token=${token}`,
    wifiUrl: wifi ? `http://${wifi}:${port}?token=${token}` : null,
    tailscaleUrl: tailscale ? `http://${tailscale}:${port}?token=${token}` : null,
    token,
    port,
  };
}

const handlers = createIpcHandlers({
  userDataPath:
    process.env.PARALLEL_CODE_USER_DATA_DIR ?? path.resolve(__dirname, '..', '..', '.server-data'),
  isPackaged: false,
  sendToChannel: sendChannelMessage,
  emitIpcEvent: (channel, payload) => {
    broadcast({
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
      ...getServerInfo(),
    }),
  },
});

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

    if (channel === IPC.CreateTask) {
      const body = req.body as { name?: string } | undefined;
      const created = result as { id?: string; branch_name?: string; worktree_path?: string };
      if (created.id) {
        broadcast({
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
        broadcast({
          type: 'task-event',
          event: 'deleted',
          taskId: body.taskId,
          branchName: body.branchName,
        });
      }
      broadcast({
        type: 'git-status-changed',
        branchName: typeof body?.branchName === 'string' ? body.branchName : undefined,
        projectRoot: typeof body?.projectRoot === 'string' ? body.projectRoot : undefined,
      });
    }

    if (
      channel === IPC.CommitAll ||
      channel === IPC.DiscardUncommitted ||
      channel === IPC.RebaseTask
    ) {
      const body = req.body as { worktreePath?: string } | undefined;
      broadcast({
        type: 'git-status-changed',
        worktreePath: typeof body?.worktreePath === 'string' ? body.worktreePath : undefined,
      });
    }

    if (channel === IPC.MergeTask || channel === IPC.PushTask) {
      const body = req.body as { projectRoot?: string; branchName?: string } | undefined;
      broadcast({
        type: 'git-status-changed',
        projectRoot: typeof body?.projectRoot === 'string' ? body.projectRoot : undefined,
        branchName: typeof body?.branchName === 'string' ? body.branchName : undefined,
      });
    }

    res.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'internal error';
    res.status(400).json({ error: message });
  }
});

if (existsSync(distRemoteDir)) {
  app.use('/remote', express.static(distRemoteDir));
  app.get('/remote/*', (_req, res) => {
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
  broadcast({
    type: 'agent-lifecycle',
    event: 'spawn',
    agentId,
    taskId: meta?.taskId ?? null,
    isShell: meta?.isShell ?? null,
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
    type: 'agent-lifecycle',
    event: 'pause',
    agentId,
    taskId: meta?.taskId ?? null,
    isShell: meta?.isShell ?? null,
  });
});

const unsubResume = onPtyEvent('resume', (agentId) => {
  const meta = getAgentMeta(agentId);
  broadcast({
    type: 'agent-lifecycle',
    event: 'resume',
    agentId,
    taskId: meta?.taskId ?? null,
    isShell: meta?.isShell ?? null,
  });
});

const unsubExit = onPtyEvent('exit', (agentId, data) => {
  const meta = getAgentMeta(agentId);
  const { exitCode, signal } = (data ?? {}) as { exitCode?: number | null; signal?: string | null };
  broadcast({
    type: 'status',
    agentId,
    status: 'exited',
    exitCode: exitCode ?? null,
  });
  broadcast({
    type: 'agent-lifecycle',
    event: 'exit',
    agentId,
    taskId: meta?.taskId ?? null,
    isShell: meta?.isShell ?? null,
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

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (safeCompare(url.searchParams.get('token'))) {
    authenticatedClients.add(client);
    void sendSafely(
      client,
      JSON.stringify({
        type: 'agents',
        list: buildAgentList(),
      } satisfies ServerMessage),
    );
  } else {
    const authTimer = setTimeout(() => {
      if (!authenticatedClients.has(client)) {
        client.close(4001, 'Auth timeout');
      }
    }, 5_000);
    authTimers.set(client, authTimer);
  }

  client.on('message', (raw) => {
    const message = parseClientMessage(String(raw));
    if (!message) return;

    if (message.type === 'auth') {
      if (!safeCompare(message.token)) {
        client.close(4001, 'Unauthorized');
        return;
      }
      authenticatedClients.add(client);
      const timer = authTimers.get(client);
      if (timer) clearTimeout(timer);
      void sendSafely(
        client,
        JSON.stringify({
          type: 'agents',
          list: buildAgentList(),
        } satisfies ServerMessage),
      );
      return;
    }

    if (!authenticatedClients.has(client)) {
      client.close(4001, 'Unauthorized');
      return;
    }

    switch (message.type) {
      case 'input':
        try {
          writeToAgent(message.agentId, message.data);
        } catch {
          /* agent already gone */
        }
        break;
      case 'resize':
        try {
          resizeAgent(message.agentId, message.cols, message.rows);
        } catch {
          /* agent already gone */
        }
        break;
      case 'kill':
        try {
          killAgent(message.agentId);
        } catch {
          /* agent already gone */
        }
        break;
      case 'pause':
        try {
          pauseAgent(message.agentId, message.reason);
        } catch {
          /* agent already gone */
        }
        break;
      case 'resume':
        try {
          resumeAgent(message.agentId, message.reason);
        } catch {
          /* agent already gone */
        }
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
        flushPendingChannelMessages(client, message.channelId);
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
        pendingChannelMessages.delete(message.channelId);
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
    }
  });

  client.on('close', () => {
    cleanupClientState(client);
  });
});

server.listen(port, '0.0.0.0', () => {
  const info = getServerInfo();
  process.stdout.write(`Parallel Code server listening on ${info.url}\n`);
  if (info.wifiUrl) process.stdout.write(`WiFi: ${info.wifiUrl}\n`);
  if (info.tailscaleUrl) process.stdout.write(`Tailscale: ${info.tailscaleUrl}\n`);
});

function cleanup(): void {
  unsubSpawn();
  unsubListChanged();
  unsubPause();
  unsubResume();
  unsubExit();
  for (const timer of pendingChannelCleanupTimers.values()) {
    clearTimeout(timer);
  }
  pendingChannelCleanupTimers.clear();
  for (const client of authenticatedClients) {
    client.close();
  }
}

function shutdown(): void {
  cleanup();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => {
  shutdown();
});

process.on('SIGTERM', () => {
  shutdown();
});
