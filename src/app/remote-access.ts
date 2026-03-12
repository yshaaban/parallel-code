import { IPC } from '../../electron/ipc/channels';
import { invoke, isElectronRuntime } from '../lib/ipc';
import { setStore } from '../store/core';

interface ServerResult {
  url: string;
  wifiUrl: string | null;
  tailscaleUrl: string | null;
  token: string;
  port: number;
}

interface RemoteStatusResult {
  enabled: boolean;
  connectedClients: number;
  peerClients?: number;
  url?: string;
  wifiUrl?: string;
  tailscaleUrl?: string;
  token?: string;
  port?: number;
}

const DISABLED_REMOTE_ACCESS = {
  enabled: false,
  token: null,
  port: 7777,
  url: null,
  wifiUrl: null,
  tailscaleUrl: null,
  connectedClients: 0,
  peerClients: 0,
} as const;

let stopGeneration = 0;

function applyRemoteStatus(result: RemoteStatusResult): void {
  if (result.enabled) {
    setStore('remoteAccess', {
      enabled: true,
      connectedClients: result.connectedClients,
      peerClients: result.peerClients ?? result.connectedClients,
      url: result.url ?? null,
      wifiUrl: result.wifiUrl ?? null,
      tailscaleUrl: result.tailscaleUrl ?? null,
      token: result.token ?? null,
      port: result.port ?? 7777,
    });
    return;
  }

  setStore('remoteAccess', DISABLED_REMOTE_ACCESS);
}

async function fetchRemoteStatus(): Promise<RemoteStatusResult> {
  return invoke<RemoteStatusResult>(IPC.GetRemoteStatus);
}

export async function startRemoteAccess(port?: number): Promise<ServerResult> {
  if (!isElectronRuntime()) {
    const result = await fetchRemoteStatus();
    applyRemoteStatus(result);
    if (!result.enabled || !result.url || !result.token || !result.port) {
      throw new Error('Remote access information is unavailable');
    }
    return {
      url: result.url,
      wifiUrl: result.wifiUrl ?? null,
      tailscaleUrl: result.tailscaleUrl ?? null,
      token: result.token,
      port: result.port,
    };
  }

  const result = await invoke<ServerResult>(IPC.StartRemoteServer, port ? { port } : {});
  setStore('remoteAccess', {
    enabled: true,
    token: result.token,
    port: result.port,
    url: result.url,
    wifiUrl: result.wifiUrl,
    tailscaleUrl: result.tailscaleUrl,
    connectedClients: 0,
    peerClients: 0,
  });
  return result;
}

export async function stopRemoteAccess(): Promise<void> {
  if (!isElectronRuntime()) return;

  stopGeneration += 1;
  await invoke(IPC.StopRemoteServer);
  setStore('remoteAccess', DISABLED_REMOTE_ACCESS);
}

export async function refreshRemoteStatus(): Promise<void> {
  const generation = stopGeneration;
  const result = await fetchRemoteStatus();
  if (generation !== stopGeneration) return;
  applyRemoteStatus(result);
}
