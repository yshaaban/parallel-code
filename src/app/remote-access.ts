import { IPC } from '../../electron/ipc/channels';
import type {
  RemoteAccessStartResult,
  RemoteAccessStatus,
} from '../../electron/ipc/remote-access-workflows';
import { invoke, isElectronRuntime } from '../lib/ipc';
import { setStore } from '../store/core';

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

function applyRemoteStatus(result: RemoteAccessStatus): void {
  if (!result.enabled) {
    setStore('remoteAccess', DISABLED_REMOTE_ACCESS);
    return;
  }

  setStore('remoteAccess', {
    enabled: true,
    connectedClients: result.connectedClients,
    peerClients: result.peerClients,
    url: result.url,
    wifiUrl: result.wifiUrl,
    tailscaleUrl: result.tailscaleUrl,
    token: result.token,
    port: result.port,
  });
}

async function fetchRemoteStatus(): Promise<RemoteAccessStatus> {
  return invoke<RemoteAccessStatus>(IPC.GetRemoteStatus);
}

export async function startRemoteAccess(port?: number): Promise<RemoteAccessStartResult> {
  if (!isElectronRuntime()) {
    const result = await fetchRemoteStatus();
    applyRemoteStatus(result);
    if (!result.enabled) {
      throw new Error('Remote access information is unavailable');
    }
    return {
      url: result.url,
      wifiUrl: result.wifiUrl,
      tailscaleUrl: result.tailscaleUrl,
      token: result.token,
      port: result.port,
    };
  }

  const result = await invoke<RemoteAccessStartResult>(IPC.StartRemoteServer, port ? { port } : {});
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
