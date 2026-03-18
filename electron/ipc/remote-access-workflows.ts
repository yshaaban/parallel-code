import path from 'path';
import { fileURLToPath } from 'url';
import { startRemoteServer } from '../remote/server.js';
import {
  createDisabledRemoteAccessStatus,
  type RemoteAccessStatus,
} from '../../src/domain/server-state.js';
import type { RemoteAccessStartResult } from '../../src/domain/renderer-invoke.js';
import type { RemoteAgentTaskMeta } from '../../src/domain/server-state.js';
import type { AgentStatusSnapshot } from './agent-status.js';

export type { RemoteAccessStatus } from '../../src/domain/server-state.js';
export type { RemoteAccessStartResult } from '../../src/domain/renderer-invoke.js';

export interface RemoteAccessController {
  getStatusVersion: () => number;
  start: (args: RemoteAccessStartRequest) => Promise<RemoteAccessStartResult>;
  stop: () => Promise<void>;
  status: () => RemoteAccessStatus;
  subscribe: (listener: RemoteAccessStatusListener) => () => void;
}

interface RemoteServerController {
  stop: () => Promise<void>;
  token: string;
  port: number;
  url: string;
  tailscaleUrl: string | null;
  wifiUrl: string | null;
  connectedClients: () => number;
}

export interface CreateRemoteAccessControllerOptions {
  defaultPort?: number;
  startServer?: typeof startRemoteServer;
  staticDir?: string;
}

export type RemoteAccessStatusListener = (status: RemoteAccessStatus) => void;

export interface RemoteAccessStartRequest {
  getAgentStatus: (agentId: string) => AgentStatusSnapshot;
  getTaskMetadata?: (taskId: string) => RemoteAgentTaskMeta | null;
  getTaskName: (taskId: string) => string;
  port?: number;
}

function getDefaultRemoteStaticDir(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(thisDir, '..', '..', 'dist-remote');
}

function buildRemoteServerStartRequest(
  args: RemoteAccessStartRequest,
  options: {
    defaultPort: number;
    notifyStatusChanged: () => void;
    staticDir: string;
  },
): Parameters<typeof startRemoteServer>[0] {
  return {
    port: args.port ?? options.defaultPort,
    staticDir: options.staticDir,
    getTaskName: args.getTaskName,
    getAgentStatus: args.getAgentStatus,
    ...(args.getTaskMetadata ? { getTaskMetadata: args.getTaskMetadata } : {}),
    onAuthenticatedClientCountChanged: () => {
      options.notifyStatusChanged();
    },
  };
}

function mapRemoteServerStartResult(server: RemoteServerController): RemoteAccessStartResult {
  return {
    url: server.url,
    wifiUrl: server.wifiUrl,
    tailscaleUrl: server.tailscaleUrl,
    token: server.token,
    port: server.port,
  };
}

function getRemotePeerCountForDesktopHost(connectedClients: number): number {
  // The Electron desktop host is not itself one of the remote websocket clients,
  // so every connected remote client is a peer from the desktop app's perspective.
  return connectedClients;
}

function mapRemoteServerStatus(
  server: RemoteServerController | null,
  defaultPort: number,
): RemoteAccessStatus {
  if (!server) {
    return createDisabledRemoteAccessStatus(defaultPort);
  }

  const connectedClients = server.connectedClients();
  return {
    enabled: true,
    connectedClients,
    peerClients: getRemotePeerCountForDesktopHost(connectedClients),
    url: server.url,
    wifiUrl: server.wifiUrl,
    tailscaleUrl: server.tailscaleUrl,
    token: server.token,
    port: server.port,
  };
}

export function createRemoteAccessController(
  options: CreateRemoteAccessControllerOptions = {},
): RemoteAccessController {
  const startServer = options.startServer ?? startRemoteServer;
  const defaultPort = options.defaultPort ?? 7777;
  const staticDir = options.staticDir ?? getDefaultRemoteStaticDir();
  const listeners = new Set<RemoteAccessStatusListener>();

  let remoteServer: RemoteServerController | null = null;
  let remoteStatusVersion = 0;

  function bumpRemoteStatusVersion(): number {
    remoteStatusVersion += 1;
    return remoteStatusVersion;
  }

  function getStatus(): RemoteAccessStatus {
    return mapRemoteServerStatus(remoteServer, defaultPort);
  }

  function notifyStatusChanged(): void {
    bumpRemoteStatusVersion();
    const status = getStatus();
    for (const listener of listeners) {
      listener(status);
    }
  }

  return {
    getStatusVersion: () => remoteStatusVersion,
    start: async (args) => {
      if (!remoteServer) {
        remoteServer = await startServer(
          buildRemoteServerStartRequest(args, {
            defaultPort,
            notifyStatusChanged,
            staticDir,
          }),
        );
      }

      notifyStatusChanged();

      return mapRemoteServerStartResult(remoteServer);
    },
    stop: async () => {
      if (!remoteServer) {
        return;
      }

      await remoteServer.stop();
      remoteServer = null;
      notifyStatusChanged();
    },
    status: getStatus,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function startRemoteAccessWorkflow(
  controller: RemoteAccessController,
  request: RemoteAccessStartRequest,
): Promise<RemoteAccessStartResult> {
  return controller.start(request);
}

export function stopRemoteAccessWorkflow(controller: RemoteAccessController): Promise<void> {
  return controller.stop();
}

export function getRemoteAccessStatusWorkflow(
  controller: RemoteAccessController,
): RemoteAccessStatus {
  return controller.status();
}
