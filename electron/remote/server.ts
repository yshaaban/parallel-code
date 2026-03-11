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
import { createWebSocketTransport } from './ws-transport.js';

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

  function sendSafely(ws: WebSocket, message: ServerMessage | string): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(typeof message === 'string' ? message : JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  const transport = createWebSocketTransport<WebSocket>({
    closeClient: (client, code, reason) => {
      client.close(code, reason);
    },
    sendBroadcastText: (client, text) => sendSafely(client, text),
    sendDirectText: (client, text) => sendSafely(client, text),
    terminateClient: (client) => {
      client.terminate();
    },
  });

  function sendAgentList(ws: WebSocket): void {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
    transport.sendMessage(ws, { type: 'agents', list } satisfies ServerMessage);
  }

  function sendAgentSnapshot(ws: WebSocket): void {
    sendAgentList(ws);
    transport.sendAgentControllers(ws);
  }

  function broadcastAgentList(): void {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
    transport.broadcast({ type: 'agents', list });
  }

  function authenticateConnection(ws: WebSocket, clientId?: string, lastSeq?: number): boolean {
    if (!transport.authenticateClient(ws, clientId)) return false;
    if (lastSeq !== undefined) {
      transport.replayControlEvents(ws, lastSeq);
    }
    sendAgentSnapshot(ws);
    return true;
  }

  const unsubSpawn = onPtyEvent('spawn', () => {
    broadcastAgentList();
  });

  const unsubListChanged = onPtyEvent('list-changed', () => {
    broadcastAgentList();
  });

  const unsubPause = onPtyEvent('pause', () => {
    broadcastAgentList();
  });

  const unsubResume = onPtyEvent('resume', () => {
    broadcastAgentList();
  });

  const unsubExit = onPtyEvent('exit', (agentId, data) => {
    const { exitCode } = (data ?? {}) as { exitCode?: number };
    transport.releaseAgentControl(agentId);
    transport.broadcastControl({
      type: 'status',
      agentId,
      status: 'exited',
      exitCode: exitCode ?? null,
    });
    // Clean stale subscription entries from all connected clients
    for (const client of wss.clients) {
      clientSubs.get(client)?.delete(agentId);
    }
    setTimeout(() => {
      broadcastAgentList();
    }, 100);
  });

  function sendAgentError(
    ws: WebSocket,
    agentId: string,
    fallbackMessage: string,
    error: unknown,
  ): void {
    transport.sendMessage(ws, {
      type: 'agent-error',
      agentId,
      message: error instanceof Error ? error.message : fallbackMessage,
    } satisfies ServerMessage);
  }

  function shouldRequireAgentControl(reason?: PauseReason): boolean {
    return !isAutomaticPauseReason(reason);
  }

  function stopRemoteServerResources(): void {
    transport.stopHeartbeat();
    unsubSpawn();
    unsubExit();
    unsubListChanged();
    unsubPause();
    unsubResume();
  }

  function buildAccessUrl(host: string): string {
    return `http://${host}:${opts.port}?token=${token}`;
  }

  function buildOptionalAccessUrl(host: string | null): string | null {
    if (!host) return null;
    return buildAccessUrl(host);
  }

  function claimAgentControlOrSendError(ws: WebSocket, agentId: string, command: string): boolean {
    if (transport.claimAgentControl(ws, agentId)) return true;
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

    // Support legacy URL-based auth (verifyClient accepted all connections)
    if (checkAuth(req)) {
      if (!authenticateConnection(ws)) return;
    } else {
      transport.scheduleAuthTimeout(ws);
    }

    ws.on('pong', () => {
      transport.notePong(ws);
    });

    ws.on('message', (raw) => {
      const msg = parseClientMessage(String(raw));
      if (!msg) return;

      // Handle first-message auth
      if (msg.type === 'auth') {
        if (safeCompare(msg.token)) {
          if (!authenticateConnection(ws, msg.clientId, msg.lastSeq ?? -1)) return;
        } else {
          ws.close(4001, 'Unauthorized');
        }
        return;
      }

      // Reject messages from unauthenticated clients
      if (!transport.isAuthenticated(ws)) {
        ws.close(4001, 'Unauthorized');
        return;
      }

      switch (msg.type) {
        case 'ping':
          transport.sendMessage(ws, { type: 'pong' } satisfies ServerMessage);
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
            transport.sendMessage(ws, {
              type: 'scrollback',
              agentId: msg.agentId,
              data: scrollback,
              cols: getAgentCols(msg.agentId),
            } satisfies ServerMessage);
          }

          const cb = (encoded: string) => {
            if (ws.readyState === WebSocket.OPEN) {
              transport.sendMessage(ws, {
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
      transport.cleanupClient(ws);
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
        transport.startHeartbeat();
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
  const url = buildOptionalAccessUrl(ips.wifi ?? ips.tailscale) ?? fallbackUrl;

  return {
    token,
    port: opts.port,
    url,
    /** Re-detect network IPs so newly connected interfaces (e.g. Tailscale) are picked up. */
    get wifiUrl() {
      return buildOptionalAccessUrl(getNetworkIps().wifi);
    },
    get tailscaleUrl() {
      return buildOptionalAccessUrl(getNetworkIps().tailscale);
    },
    connectedClients: () => transport.getAuthenticatedClientCount(),
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
