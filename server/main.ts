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
const port = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
const token = randomBytes(24).toString('base64url');
const tokenBuf = Buffer.from(token);

const app = express();
const server = createServer(app);

const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024,
});

const authenticatedClients = new Set<WebSocketClient>();
const authTimers = new WeakMap<WebSocketClient, ReturnType<typeof setTimeout>>();
const boundChannels = new WeakMap<WebSocketClient, Set<string>>();
const pendingChannelMessages = new Map<string, unknown[]>();
const outputSubscriptions = new WeakMap<WebSocketClient, Map<string, (data: string) => void>>();

const PENDING_CHANNEL_LIMIT = 256;

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
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
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

function queueChannelMessage(channelId: string, payload: unknown): void {
  const queue = pendingChannelMessages.get(channelId) ?? [];
  queue.push(payload);
  if (queue.length > PENDING_CHANNEL_LIMIT) queue.shift();
  pendingChannelMessages.set(channelId, queue);
}

function sendChannelMessage(channelId: string, payload: unknown): void {
  let delivered = false;
  for (const client of authenticatedClients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const channels = boundChannels.get(client);
    if (!channels?.has(channelId)) continue;
    delivered = true;
    client.send(
      JSON.stringify({
        type: 'channel',
        channelId,
        payload,
      } satisfies ServerMessage),
    );
  }

  if (!delivered) queueChannelMessage(channelId, payload);
}

function flushPendingChannelMessages(ws: WebSocketClient, channelId: string): void {
  const queue = pendingChannelMessages.get(channelId);
  if (!queue || queue.length === 0) return;
  for (const payload of queue) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'channel',
        channelId,
        payload,
      } satisfies ServerMessage),
    );
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
    client.send(
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
      client.send(
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
          pauseAgent(message.agentId);
        } catch {
          /* agent already gone */
        }
        break;
      case 'resume':
        try {
          resumeAgent(message.agentId);
        } catch {
          /* agent already gone */
        }
        break;
      case 'bind-channel': {
        const channels = boundChannels.get(client);
        channels?.add(message.channelId);
        flushPendingChannelMessages(client, message.channelId);
        break;
      }
      case 'unbind-channel': {
        const channels = boundChannels.get(client);
        channels?.delete(message.channelId);
        break;
      }
      case 'subscribe': {
        const subscriptions = outputSubscriptions.get(client);
        if (!subscriptions || subscriptions.has(message.agentId)) break;

        const scrollback = getAgentScrollback(message.agentId);
        if (scrollback) {
          client.send(
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
            client.send(
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
    authenticatedClients.delete(client);
    const timer = authTimers.get(client);
    if (timer) clearTimeout(timer);

    const subscriptions = outputSubscriptions.get(client);
    if (subscriptions) {
      for (const [agentId, callback] of subscriptions) {
        unsubscribeFromAgent(agentId, callback);
      }
    }
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
