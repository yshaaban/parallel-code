// electron/remote/server.ts

import { createServer, type IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'crypto';
import { getAgentMeta, getAgentScrollback } from '../ipc/pty.js';
import { buildRemoteAgentList } from './agent-list.js';
import { createRemoteHttpHandler } from './http-handler.js';
import {
  buildAccessUrl as buildRemoteAccessUrl,
  buildOptionalAccessUrl as buildOptionalRemoteAccessUrl,
  getNetworkIps,
} from './network.js';
import { createTokenComparator } from './token-auth.js';
import { registerRemoteWebSocketServer } from './ws-server.js';
import { createWebSocketTransport, type SendTextResult } from './ws-transport.js';

interface RemoteServer {
  stop: () => Promise<void>;
  token: string;
  port: number;
  url: string;
  tailscaleUrl: string | null;
  wifiUrl: string | null;
  connectedClients: () => number;
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
  getTaskMetadata?: (
    taskId: string,
  ) => import('../../src/domain/server-state.js').RemoteAgentTaskMeta | null;
  onAuthenticatedClientCountChanged?: (count: number) => void;
}): Promise<RemoteServer> {
  const token = randomBytes(24).toString('base64url');
  const ips = getNetworkIps();
  const { safeCompare } = createTokenComparator(token);
  let stopped = false;
  const getAgentList = () =>
    buildRemoteAgentList({
      getAgentStatus: opts.getAgentStatus,
      ...(opts.getTaskMetadata ? { getTaskMetadata: opts.getTaskMetadata } : {}),
      getTaskName: opts.getTaskName,
    });

  function checkAuth(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ') && safeCompare(auth.slice(7))) return true;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    return safeCompare(url.searchParams.get('token'));
  }

  const server = createServer(
    createRemoteHttpHandler({
      checkAuth,
      getAgentDetail: (agentId) => {
        const scrollback = getAgentScrollback(agentId);
        if (scrollback === null) return null;

        const meta = getAgentMeta(agentId);
        const info = meta ? opts.getAgentStatus(agentId) : null;
        return {
          exitCode: info?.exitCode ?? null,
          scrollback,
          status: info?.status ?? 'exited',
        };
      },
      getAgentList,
      staticDir: opts.staticDir,
    }),
  );

  // --- WebSocket server ---
  const wss = new WebSocketServer({
    server,
    maxPayload: 256 * 1024,
  });

  function sendSafely(ws: WebSocket, message: string): SendTextResult {
    if (ws.readyState !== WebSocket.OPEN) {
      return { ok: false, reason: 'not-open' };
    }

    try {
      ws.send(message);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: 'send-error',
        error,
      };
    }
  }

  const transport = createWebSocketTransport<WebSocket>({
    closeClient: (client, code, reason) => {
      client.close(code, reason);
    },
    ...(opts.onAuthenticatedClientCountChanged
      ? { onAuthenticatedClientCountChanged: opts.onAuthenticatedClientCountChanged }
      : {}),
    sendBroadcastText: (client, text) => sendSafely(client, text),
    sendDirectText: (client, text) => sendSafely(client, text),
    terminateClient: (client) => {
      client.terminate();
    },
  });

  function authenticateConnection(ws: WebSocket, clientId?: string, lastSeq?: number): boolean {
    const authResult = transport.authenticateClient(ws, clientId);
    if (!authResult.ok) return false;
    if (lastSeq !== undefined) {
      transport.replayControlEvents(ws, lastSeq);
    }
    transport.sendMessage(ws, {
      type: 'agents',
      list: getAgentList(),
    });
    transport.sendAgentControllers(ws);
    return true;
  }

  function buildAccessUrl(host: string): string {
    return buildRemoteAccessUrl(host, opts.port, token);
  }

  function buildOptionalAccessUrl(host: string | null): string | null {
    return buildOptionalRemoteAccessUrl(host, opts.port, token);
  }

  const remoteSocketServer = registerRemoteWebSocketServer({
    authenticateConnection,
    getAgentList,
    safeCompareToken: safeCompare,
    transport,
    wss,
  });

  function stopRemoteServerResources(): void {
    transport.stopHeartbeat();
    remoteSocketServer.cleanup();
  }

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
        if (stopped) {
          resolve();
          return;
        }
        stopped = true;
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
