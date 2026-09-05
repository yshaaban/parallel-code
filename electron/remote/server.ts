// electron/remote/server.ts

import { createServer, type IncomingMessage } from 'http';
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'crypto';
import { getAgentMeta, getAgentScrollback } from '../ipc/pty.js';
import { buildRemoteAgentList } from './agent-list.js';
import { createRemoteHttpHandler } from './http-handler.js';
import {
  buildAccessUrl as buildRemoteAccessUrl,
  buildOptionalAccessUrl as buildOptionalRemoteAccessUrl,
  buildOptionalSecureSessionBootstrapUrl,
  buildSecureSessionBootstrapUrl,
  getNetworkIps,
  type RemotePeerTrustPolicy,
} from './network.js';
import { createTokenComparator } from './token-auth.js';
import { registerRemoteWebSocketServer } from './ws-server.js';
import { createWebSocketTransport, type SendTextResult } from './ws-transport.js';
import type { RemoteCommandRegistrationTable, RemoteGrant } from '../ipc/remote-command-gateway.js';
import type { TaskCatalogDeltaBatch } from '../../src/domain/task-catalog.js';
import type { TaskNotesChangedNotification } from '../../src/domain/task-notes.js';
import type { RemoteTaskCreationOperationSource } from '../ipc/task-creation-remote-commands.js';
import { createScopedRemoteCommandRuntime } from './scoped-command-runtime.js';

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
    agentId: string,
  ) => import('../../src/domain/server-state.js').RemoteAgentTaskMeta | null;
  onAuthenticatedClientCountChanged?: (count: number) => void;
  scopedCommands?: {
    grants: ReadonlySet<RemoteGrant>;
    mutationAdmissionInitiallyOpen?: boolean;
    peerTrustPolicy: RemotePeerTrustPolicy;
    registrations: RemoteCommandRegistrationTable;
    subscribeTaskCatalog?: (listener: (batch: TaskCatalogDeltaBatch) => void) => () => void;
    subscribeTaskNotesChanged?: (
      listener: (notification: TaskNotesChangedNotification) => void,
    ) => () => void;
    taskCreationOperations?: RemoteTaskCreationOperationSource;
    tls: Pick<HttpsServerOptions, 'cert' | 'key'>;
    workspacePrincipalId: string;
  };
}): Promise<RemoteServer> {
  const token = randomBytes(24).toString('base64url');
  const scopedCommands = opts.scopedCommands;
  const scopedRuntime = scopedCommands
    ? createScopedRemoteCommandRuntime({
        accessToken: token,
        grants: scopedCommands.grants,
        ...(scopedCommands.mutationAdmissionInitiallyOpen !== undefined
          ? { mutationAdmissionInitiallyOpen: scopedCommands.mutationAdmissionInitiallyOpen }
          : {}),
        onInternalError: (error) => console.error('[remote] Scoped command failed:', error),
        peerTrustPolicy: scopedCommands.peerTrustPolicy,
        registrations: scopedCommands.registrations,
        workspacePrincipalId: scopedCommands.workspacePrincipalId,
      })
    : null;
  const gateway = scopedRuntime?.gateway ?? null;
  const ips = getNetworkIps();
  const { safeCompare } = createTokenComparator(token);
  let stopped = false;
  const getAgentList = () =>
    buildRemoteAgentList({
      getAgentStatus: opts.getAgentStatus,
      ...(opts.getTaskMetadata ? { getTaskMetadata: opts.getTaskMetadata } : {}),
      getTaskName: opts.getTaskName,
    });

  function checkAuth(req: IncomingMessage): boolean | { terminalRead: boolean } {
    if (scopedRuntime) {
      const url = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`);
      if (url.searchParams.has('token')) return false;
      const access = scopedRuntime.authenticateReadRequest(req);
      return access ? { terminalRead: access.terminalRead } : false;
    }
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ') && safeCompare(auth.slice(7))) return true;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    return safeCompare(url.searchParams.get('token'));
  }

  const legacyHttpHandler = createRemoteHttpHandler({
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
  });
  const authHttpHandler = scopedRuntime?.authHttpHandler ?? null;
  const commandHttpHandler = scopedRuntime?.commandHttpHandler ?? null;

  const requestHandler = (request: IncomingMessage, response: import('http').ServerResponse) => {
    if (authHttpHandler?.(request, response)) return;
    if (commandHttpHandler) {
      void commandHttpHandler(request, response).then((handled) => {
        if (!handled) legacyHttpHandler(request, response);
      });
      return;
    }
    legacyHttpHandler(request, response);
  };
  const server = scopedCommands
    ? createHttpsServer(scopedCommands.tls, requestHandler)
    : createServer(requestHandler);

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

  function authenticateConnection(
    ws: WebSocket,
    clientId?: string,
    lastSeq?: number,
    access: { terminalRead: boolean } = { terminalRead: true },
  ): boolean {
    const authResult = transport.authenticateClient(ws, clientId, {
      receiveControlEvents: access.terminalRead,
    });
    if (!authResult.ok) return false;
    if (lastSeq !== undefined && access.terminalRead) {
      transport.replayControlEvents(ws, lastSeq);
    }
    if (access.terminalRead) {
      transport.sendMessage(ws, {
        type: 'agents',
        list: getAgentList(),
      });
      transport.sendAgentControllers(ws);
    }
    return true;
  }

  function buildAccessUrl(host: string): string {
    return scopedCommands
      ? buildSecureSessionBootstrapUrl(host, opts.port, token)
      : buildRemoteAccessUrl(host, opts.port, token);
  }

  function buildOptionalAccessUrl(host: string | null): string | null {
    return scopedCommands
      ? buildOptionalSecureSessionBootstrapUrl(host, opts.port, token)
      : buildOptionalRemoteAccessUrl(host, opts.port, token);
  }

  const remoteSocketServer = registerRemoteWebSocketServer({
    authenticateConnection,
    ...(scopedCommands && scopedRuntime
      ? {
          authenticateScopedConnection: (request: IncomingMessage) =>
            scopedRuntime.authenticateSocket(request),
          getCurrentScopedAuthentication: (authentication) =>
            scopedRuntime.getCurrentAuthentication(authentication),
          refreshScopedAuthentication: (authentication) =>
            scopedRuntime.refreshSocketAuthentication(authentication),
          subscribeScopedAuthenticationInvalidation: (listener) =>
            scopedRuntime.subscribeAuthenticationInvalidation(listener),
        }
      : {}),
    getAgentList,
    ...(gateway ? { remoteCommandGateway: gateway } : {}),
    ...(scopedCommands?.subscribeTaskCatalog
      ? { subscribeTaskCatalog: scopedCommands.subscribeTaskCatalog }
      : {}),
    ...(scopedCommands?.subscribeTaskNotesChanged
      ? { subscribeTaskNotesChanged: scopedCommands.subscribeTaskNotesChanged }
      : {}),
    ...(scopedCommands?.taskCreationOperations
      ? { taskCreationOperations: scopedCommands.taskCreationOperations }
      : {}),
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
    stop: async () => {
      if (gateway) {
        await gateway.closeAndDrainMutations();
      }
      scopedRuntime?.revokeAll();
      await new Promise<void>((resolve) => {
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
      });
    },
  };
}
