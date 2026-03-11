// electron/remote/ws-transport.ts
// Shared WebSocket transport utilities for both browser (server/main.ts) and remote (electron/remote/server.ts) modes

import { WebSocketServer, WebSocket } from 'ws';
import { timingSafeEqual } from 'crypto';
import type { ServerMessage } from './protocol.js';
import type { Server as HttpServer } from 'http';

interface WssOptions {
  server: HttpServer;
  maxPayload?: number;
}

interface CreateAuthenticatedWssResult {
  wss: WebSocketServer;
  authenticateClient: (token: string, client: WebSocket) => boolean;
  safeCompare: (candidate: string | null | undefined) => boolean;
  startHeartbeat: () => void;
  stopHeartbeat: () => void;
  allClients: Set<WebSocket>;
}

export function createAuthenticatedWss(
  opts: WssOptions & {
    token: string;
    maxClients?: number;
  },
): CreateAuthenticatedWssResult {
  const tokenBuf = Buffer.from(opts.token);
  const maxClients = opts.maxClients ?? 100;
  const allClients = new Set<WebSocket>();

  function safeCompare(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    const buf = Buffer.from(candidate);
    if (buf.length !== tokenBuf.length) return false;
    return timingSafeEqual(buf, tokenBuf);
  }

  function authenticateClient(submittedToken: string, client: WebSocket): boolean {
    if (allClients.has(client)) return true;
    if (allClients.size >= maxClients) {
      client.close(1013, 'Too many authenticated sessions');
      return false;
    }
    if (!safeCompare(submittedToken)) return false;

    allClients.add(client);
    return true;
  }

  const wss = new WebSocketServer({
    server: opts.server,
    maxPayload: opts.maxPayload ?? 256 * 1024,
  });

  // Heartbeat infrastructure for long-lived connections
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const MAX_MISSED_PONGS = 2;
  const missedPongs = new WeakMap<WebSocket, number>();
  let heartbeatTimer: NodeJS.Timeout | null = null;

  function startHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      for (const client of allClients) {
        if (client.readyState !== WebSocket.OPEN) {
          allClients.delete(client);
          continue;
        }
        if ((missedPongs.get(client) ?? 0) >= MAX_MISSED_PONGS) {
          allClients.delete(client);
          client.terminate();
          continue;
        }
        missedPongs.set(client, (missedPongs.get(client) ?? 0) + 1);
        client.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Set pong handler
    wss.on('connection', (client: WebSocket) => {
      client.on('pong', () => {
        missedPongs.set(client, 0);
      });
    });
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  return {
    wss,
    authenticateClient,
    safeCompare,
    startHeartbeat,
    stopHeartbeat,
    allClients,
  };
}

export function sendSafely(client: WebSocket, data: string | Buffer): boolean {
  if (client.readyState !== WebSocket.OPEN) return false;
  try {
    client.send(data);
    return true;
  } catch {
    return false;
  }
}

export function broadcast(clients: Set<WebSocket>, message: ServerMessage): void {
  const json = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(json);
      } catch {
        // Silently drop messages to backpressured clients (not queued in this basic version)
      }
    }
  }
}
