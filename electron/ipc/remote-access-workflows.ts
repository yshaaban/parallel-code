import path from 'path';
import { fileURLToPath } from 'url';
import { startRemoteServer } from '../remote/server.js';
import type { AgentStatusSnapshot } from './agent-status.js';

export interface RemoteAccessStartResult {
  url: string;
  wifiUrl: string | null;
  tailscaleUrl: string | null;
  token: string;
  port: number;
}

export interface RemoteAccessStatus {
  enabled: boolean;
  connectedClients: number;
  peerClients?: number;
  url?: string;
  wifiUrl?: string | null;
  tailscaleUrl?: string | null;
  token?: string;
  port?: number;
}

export interface RemoteAccessController {
  start: (args: RemoteAccessStartRequest) => Promise<RemoteAccessStartResult>;
  stop: () => Promise<void>;
  status: () => RemoteAccessStatus;
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

export interface RemoteAccessStartRequest {
  getAgentStatus: (agentId: string) => AgentStatusSnapshot;
  getTaskName: (taskId: string) => string;
  port?: number;
}

function createDisabledRemoteAccessStatus(): RemoteAccessStatus {
  return { enabled: false, connectedClients: 0, peerClients: 0 };
}

function getDefaultRemoteStaticDir(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(thisDir, '..', '..', 'dist-remote');
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

function mapRemoteServerStatus(server: RemoteServerController | null): RemoteAccessStatus {
  if (!server) {
    return createDisabledRemoteAccessStatus();
  }

  const connectedClients = server.connectedClients();
  return {
    enabled: true,
    connectedClients,
    peerClients: connectedClients,
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

  let remoteServer: RemoteServerController | null = null;

  return {
    start: async (args) => {
      if (!remoteServer) {
        remoteServer = await startServer({
          port: args.port ?? defaultPort,
          staticDir,
          getTaskName: args.getTaskName,
          getAgentStatus: args.getAgentStatus,
        });
      }

      return mapRemoteServerStartResult(remoteServer);
    },
    stop: async () => {
      if (!remoteServer) {
        return;
      }

      await remoteServer.stop();
      remoteServer = null;
    },
    status: () => mapRemoteServerStatus(remoteServer),
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
