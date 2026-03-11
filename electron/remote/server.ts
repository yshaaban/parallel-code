// electron/remote/server.ts

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { existsSync, createReadStream } from 'fs';
import { join, resolve, relative, extname, isAbsolute } from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, timingSafeEqual } from 'crypto';
import { networkInterfaces } from 'os';
import {
  writeToAgent,
  resizeAgent,
  pauseAgent,
  resumeAgent,
  killAgent,
  subscribeToAgent,
  unsubscribeFromAgent,
  getAgentScrollback,
  getActiveAgentIds,
  getAgentMeta,
  getAgentCols,
  getAgentPauseState,
  onPtyEvent,
} from '../ipc/pty.js';
import {
  getRemoteAgentStatus,
  isAutomaticPauseReason,
  parseClientMessage,
  type PauseReason,
  type ServerMessage,
  type RemoteAgent,
} from './protocol.js';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

interface RemoteServer {
  stop: () => Promise<void>;
  token: string;
  port: number;
  url: string;
  tailscaleUrl: string | null;
  wifiUrl: string | null;
  connectedClients: () => number;
}

/** Detect available network IPs (WiFi and Tailscale). */
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

/** Build the agent list, deduplicated by taskId (keeps main agent per task). */
function buildAgentList(
  getTaskName: (taskId: string) => string,
  getAgentStatus: (agentId: string) => {
    status: 'running' | 'paused' | 'flow-controlled' | 'restoring' | 'exited';
    exitCode: number | null;
    lastLine: string;
  },
): RemoteAgent[] {
  const byTask = new Map<string, RemoteAgent>();
  for (const agentId of getActiveAgentIds()) {
    const meta = getAgentMeta(agentId);
    if (!meta) continue;
    // Skip shell/sub-terminals — mobile should only show the main agent
    if (meta.isShell) continue;
    const info = getAgentStatus(agentId);
    const pauseReason = getAgentPauseState(agentId);
    const agent: RemoteAgent = {
      agentId,
      taskId: meta.taskId,
      taskName: getTaskName(meta.taskId),
      status: getRemoteAgentStatus(pauseReason, info.status),
      exitCode: info.exitCode,
      lastLine: info.lastLine,
    };
    // Prefer running agents over exited ones for the same task
    const existing = byTask.get(meta.taskId);
    if (!existing || (agent.status === 'running' && existing.status !== 'running')) {
      byTask.set(meta.taskId, agent);
    }
  }
  return Array.from(byTask.values());
}

export async function startRemoteServer(opts: {
  port: number;
  staticDir: string;
  getTaskName: (taskId: string) => string;
  getAgentStatus: (agentId: string) => {
    status: 'running' | 'paused' | 'flow-controlled' | 'restoring' | 'exited';
    exitCode: number | null;
    lastLine: string;
  };
}): Promise<RemoteServer> {
  const token = randomBytes(24).toString('base64url');
  const ips = getNetworkIps();

  const tokenBuf = Buffer.from(token);

  function safeCompare(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    const buf = Buffer.from(candidate);
    if (buf.length !== tokenBuf.length) return false;
    return timingSafeEqual(buf, tokenBuf);
  }

  function checkAuth(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ') && safeCompare(auth.slice(7))) return true;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    return safeCompare(url.searchParams.get('token'));
  }

  const SECURITY_HEADERS: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // --- API routes (require auth) ---
    if (url.pathname.startsWith('/api/')) {
      if (!checkAuth(req)) {
        res.writeHead(401, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (url.pathname === '/api/agents' && req.method === 'GET') {
        const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
      }

      const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch && req.method === 'GET') {
        const agentId = agentMatch[1];
        const scrollback = getAgentScrollback(agentId);
        if (scrollback === null) {
          res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'agent not found' }));
          return;
        }
        const meta = getAgentMeta(agentId);
        const info = meta ? opts.getAgentStatus(agentId) : null;
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            agentId,
            scrollback,
            status: info?.status ?? 'exited',
            exitCode: info?.exitCode ?? null,
          }),
        );
        return;
      }

      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    // --- Static file serving for mobile SPA (async) ---
    const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const fullPath = resolve(opts.staticDir, filePath.replace(/^\/+/, ''));
    const rel = relative(opts.staticDir, fullPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      res.writeHead(400, SECURITY_HEADERS);
      res.end('Bad request');
      return;
    }

    const serveFile = (path: string, ct: string, cc: string) => {
      const stream = createReadStream(path);
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': ct, 'Cache-Control': cc });
      stream.pipe(res);
      stream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });
    };

    if (!existsSync(fullPath)) {
      const indexPath = join(opts.staticDir, 'index.html');
      if (existsSync(indexPath)) {
        serveFile(indexPath, 'text/html', 'no-cache');
        return;
      }
      res.writeHead(404, SECURITY_HEADERS);
      res.end('Not found');
      return;
    }

    const ext = extname(fullPath);
    const contentType = MIME[ext] ?? 'application/octet-stream';
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
    serveFile(fullPath, contentType, cacheControl);
  });

  // --- WebSocket server ---
  const wss = new WebSocketServer({
    server,
    maxPayload: 256 * 1024,
  });

  const clientSubs = new WeakMap<WebSocket, Map<string, (data: string) => void>>();
  const authenticatedClients = new Set<WebSocket>();
  const authTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>();
  const clientMissedPongs = new WeakMap<WebSocket, number>();
  const clientIds = new WeakMap<WebSocket, string>();
  const agentControllers = new Map<string, { clientId: string; touchedAt: number }>();
  const MAX_AUTHENTICATED_CLIENTS = 100;
  const AGENT_CONTROL_LEASE_MS = 5_000;
  const MAX_CONTROL_EVENT_BUFFER = 200;
  let controlEventSeq = 0;
  const controlEventRingBuffer: Array<{ seq: number; json: string }> = [];
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const MAX_MISSED_PONGS = 2;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  function sendSafely(ws: WebSocket, message: ServerMessage | string): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(typeof message === 'string' ? message : JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function tryAuthenticateClient(ws: WebSocket): boolean {
    if (authenticatedClients.has(ws)) return true;
    if (authenticatedClients.size >= MAX_AUTHENTICATED_CLIENTS) {
      ws.close(1013, 'Too many authenticated sessions');
      return false;
    }

    authenticatedClients.add(ws);
    const timer = authTimers.get(ws);
    if (timer) clearTimeout(timer);
    return true;
  }

  function sendAgentList(ws: WebSocket): void {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
    sendSafely(ws, { type: 'agents', list } satisfies ServerMessage);
  }

  function sendAgentControllers(ws: WebSocket): void {
    for (const [agentId] of agentControllers) {
      const controller = getAgentController(agentId);
      if (!controller) continue;
      sendSafely(ws, {
        type: 'agent-controller',
        agentId,
        controllerId: controller.clientId,
      } satisfies ServerMessage);
    }
  }

  function broadcast(msg: ServerMessage): void {
    const json = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && authenticatedClients.has(client)) {
        sendSafely(client, json);
      }
    }
  }

  function broadcastControl(msg: ServerMessage): void {
    const seq = controlEventSeq++;
    const json = JSON.stringify({ ...msg, seq });
    controlEventRingBuffer.push({ seq, json });
    while (controlEventRingBuffer.length > MAX_CONTROL_EVENT_BUFFER) {
      controlEventRingBuffer.shift();
    }
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && authenticatedClients.has(client)) {
        sendSafely(client, json);
      }
    }
  }

  function replayStaledEvents(ws: WebSocket, lastSeq = -1): void {
    for (const event of controlEventRingBuffer) {
      if (event.seq > lastSeq && !sendSafely(ws, event.json)) return;
    }
  }

  function broadcastAgentController(agentId: string, controllerId: string | null): void {
    broadcastControl({ type: 'agent-controller', agentId, controllerId });
  }

  function getAgentController(agentId: string): { clientId: string; touchedAt: number } | null {
    const controller = agentControllers.get(agentId);
    if (!controller) return null;
    if (Date.now() - controller.touchedAt <= AGENT_CONTROL_LEASE_MS) return controller;
    agentControllers.delete(agentId);
    broadcastAgentController(agentId, null);
    return null;
  }

  function claimAgentControl(ws: WebSocket, agentId: string): boolean {
    const clientId = clientIds.get(ws);
    if (!clientId) return true;
    const current = getAgentController(agentId);
    if (current && current.clientId !== clientId) return false;
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

  function releaseClientControls(ws: WebSocket): void {
    const clientId = clientIds.get(ws);
    if (!clientId) return;
    for (const [agentId, controller] of agentControllers) {
      if (controller.clientId === clientId) releaseAgentControl(agentId, clientId);
    }
  }

  function startHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      for (const client of authenticatedClients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        const missedPongs = clientMissedPongs.get(client) ?? 0;
        if (missedPongs >= MAX_MISSED_PONGS) {
          client.terminate();
          continue;
        }
        clientMissedPongs.set(client, missedPongs + 1);
        client.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  const unsubSpawn = onPtyEvent('spawn', () => {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
    broadcast({ type: 'agents', list });
  });

  const unsubListChanged = onPtyEvent('list-changed', () => {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
    broadcast({ type: 'agents', list });
  });

  const unsubPause = onPtyEvent('pause', () => {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
    broadcast({ type: 'agents', list });
  });

  const unsubResume = onPtyEvent('resume', () => {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
    broadcast({ type: 'agents', list });
  });

  const unsubExit = onPtyEvent('exit', (agentId, data) => {
    const { exitCode } = (data ?? {}) as { exitCode?: number };
    releaseAgentControl(agentId);
    broadcastControl({ type: 'status', agentId, status: 'exited', exitCode: exitCode ?? null });
    // Clean stale subscription entries from all connected clients
    for (const client of wss.clients) {
      clientSubs.get(client)?.delete(agentId);
    }
    setTimeout(() => {
      const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
      broadcast({ type: 'agents', list });
    }, 100);
  });

  function sendAgentError(
    ws: WebSocket,
    agentId: string,
    fallbackMessage: string,
    error: unknown,
  ): void {
    sendSafely(ws, {
      type: 'agent-error',
      agentId,
      message: error instanceof Error ? error.message : fallbackMessage,
    } satisfies ServerMessage);
  }

  function shouldRequireAgentControl(reason?: PauseReason): boolean {
    return !isAutomaticPauseReason(reason);
  }

  function stopRemoteServerResources(): void {
    stopHeartbeat();
    unsubSpawn();
    unsubExit();
    unsubListChanged();
    unsubPause();
    unsubResume();
  }

  function buildAccessUrl(host: string | null): string | null {
    if (!host) return null;
    return `http://${host}:${opts.port}?token=${token}`;
  }

  function claimAgentControlOrSendError(ws: WebSocket, agentId: string, command: string): boolean {
    if (claimAgentControl(ws, agentId)) return true;
    sendAgentError(
      ws,
      agentId,
      `${command} failed`,
      new Error('Agent is controlled by another client.'),
    );
    return false;
  }

  function executeAgentCommand(
    ws: WebSocket,
    agentId: string,
    command: string,
    execute: () => void,
  ): void {
    try {
      execute();
    } catch (error) {
      sendAgentError(ws, agentId, `${command} failed`, error);
    }
  }

  function runAgentCommand(
    ws: WebSocket,
    agentId: string,
    command: string,
    execute: () => void,
    requireControl = true,
  ): void {
    if (requireControl && !claimAgentControlOrSendError(ws, agentId, command)) {
      return;
    }
    executeAgentCommand(ws, agentId, command, execute);
  }

  wss.on('connection', (ws, req) => {
    clientSubs.set(ws, new Map());
    clientMissedPongs.set(ws, 0);

    // Support legacy URL-based auth (verifyClient accepted all connections)
    if (checkAuth(req)) {
      if (!tryAuthenticateClient(ws)) return;
      clientIds.set(ws, randomBytes(12).toString('hex'));
      sendAgentList(ws);
      sendAgentControllers(ws);
    } else {
      // Close unauthenticated connections after 5 seconds
      const authTimer = setTimeout(() => {
        if (!authenticatedClients.has(ws)) {
          ws.close(4001, 'Auth timeout');
        }
      }, 5_000);
      authTimers.set(ws, authTimer);
    }

    ws.on('pong', () => {
      clientMissedPongs.set(ws, 0);
    });

    ws.on('message', (raw) => {
      const msg = parseClientMessage(String(raw));
      if (!msg) return;

      // Handle first-message auth
      if (msg.type === 'auth') {
        if (safeCompare(msg.token)) {
          if (!tryAuthenticateClient(ws)) return;
          clientIds.set(ws, msg.clientId ?? randomBytes(12).toString('hex'));
          replayStaledEvents(ws, msg.lastSeq ?? -1);
          sendAgentList(ws);
          sendAgentControllers(ws);
        } else {
          ws.close(4001, 'Unauthorized');
        }
        return;
      }

      // Reject messages from unauthenticated clients
      if (!authenticatedClients.has(ws)) {
        ws.close(4001, 'Unauthorized');
        return;
      }

      switch (msg.type) {
        case 'ping':
          sendSafely(ws, { type: 'pong' } satisfies ServerMessage);
          break;

        case 'input':
          runAgentCommand(ws, msg.agentId, 'write', () => {
            writeToAgent(msg.agentId, msg.data);
          });
          break;

        case 'resize':
          runAgentCommand(ws, msg.agentId, 'resize', () => {
            resizeAgent(msg.agentId, msg.cols, msg.rows);
          });
          break;

        case 'kill':
          runAgentCommand(ws, msg.agentId, 'kill', () => {
            killAgent(msg.agentId);
          });
          break;

        case 'pause':
          runAgentCommand(
            ws,
            msg.agentId,
            'pause',
            () => {
              pauseAgent(msg.agentId, msg.reason, msg.channelId);
            },
            shouldRequireAgentControl(msg.reason),
          );
          break;

        case 'resume':
          runAgentCommand(
            ws,
            msg.agentId,
            'resume',
            () => {
              resumeAgent(msg.agentId, msg.reason, msg.channelId);
            },
            shouldRequireAgentControl(msg.reason),
          );
          break;

        case 'subscribe': {
          const subs = clientSubs.get(ws);
          if (subs?.has(msg.agentId)) break;

          const scrollback = getAgentScrollback(msg.agentId);
          if (scrollback) {
            sendSafely(ws, {
              type: 'scrollback',
              agentId: msg.agentId,
              data: scrollback,
              cols: getAgentCols(msg.agentId),
            } satisfies ServerMessage);
          }

          const cb = (encoded: string) => {
            if (ws.readyState === WebSocket.OPEN) {
              sendSafely(ws, {
                type: 'output',
                agentId: msg.agentId,
                data: encoded,
              } satisfies ServerMessage);
            }
          };
          if (subscribeToAgent(msg.agentId, cb)) {
            subs?.set(msg.agentId, cb);
          }
          break;
        }

        case 'unsubscribe': {
          const subs = clientSubs.get(ws);
          const cb = subs?.get(msg.agentId);
          if (cb) {
            unsubscribeFromAgent(msg.agentId, cb);
            subs?.delete(msg.agentId);
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      authenticatedClients.delete(ws);
      releaseClientControls(ws);
      const timer = authTimers.get(ws);
      if (timer) clearTimeout(timer);
      const subs = clientSubs.get(ws);
      if (subs) {
        for (const [agentId, cb] of subs) {
          unsubscribeFromAgent(agentId, cb);
        }
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const handleError = (err: Error) => {
        server.off('listening', handleListening);
        reject(err);
      };
      const handleListening = () => {
        server.off('error', handleError);
        startHeartbeat();
        resolve();
      };

      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(opts.port, '0.0.0.0');
    });
  } catch (error) {
    stopRemoteServerResources();
    wss.close();
    server.close();
    throw error;
  }

  server.on('error', (err) => {
    console.error('[remote] Server error:', err.message);
  });

  const fallbackUrl = buildAccessUrl('127.0.0.1');
  if (!fallbackUrl) {
    throw new Error('Failed to build the remote access URL.');
  }
  const url = buildAccessUrl(ips.wifi ?? ips.tailscale) ?? fallbackUrl;

  return {
    token,
    port: opts.port,
    url,
    /** Re-detect network IPs so newly connected interfaces (e.g. Tailscale) are picked up. */
    get wifiUrl() {
      return buildAccessUrl(getNetworkIps().wifi);
    },
    get tailscaleUrl() {
      return buildAccessUrl(getNetworkIps().tailscale);
    },
    connectedClients: () => authenticatedClients.size,
    stop: () =>
      new Promise<void>((resolve) => {
        stopRemoteServerResources();
        for (const client of wss.clients) client.close();
        wss.close();
        const timeout = setTimeout(() => resolve(), 5_000);
        server.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      }),
  };
}
