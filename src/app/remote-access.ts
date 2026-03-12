import { IPC } from '../../electron/ipc/channels';
import type {
  RemoteAccessStartResult,
  RemoteAccessStatus,
} from '../../electron/ipc/remote-access-workflows';
import { invoke, isElectronRuntime } from '../lib/ipc';
import { setStore, store } from '../store/core';

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

function setRemoteAccessDisabled(): void {
  setStore('remoteAccess', DISABLED_REMOTE_ACCESS);
}

export function applyRemoteStatus(result: RemoteAccessStatus): void {
  if (!result.enabled) {
    setRemoteAccessDisabled();
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

export function updateRemotePeerStatus(connectedClients: number, peerClients: number): void {
  setStore('remoteAccess', 'connectedClients', connectedClients);
  setStore('remoteAccess', 'peerClients', peerClients);
}

async function fetchRemoteStatus(): Promise<RemoteAccessStatus> {
  return invoke<RemoteAccessStatus>(IPC.GetRemoteStatus);
}

function createStartedRemoteAccessStatus(
  result: RemoteAccessStartResult,
): Extract<RemoteAccessStatus, { enabled: true }> {
  const currentRemoteAccess = store.remoteAccess;
  const connectedClients = currentRemoteAccess.enabled ? currentRemoteAccess.connectedClients : 0;
  const peerClients = currentRemoteAccess.enabled ? currentRemoteAccess.peerClients : 0;

  return {
    enabled: true,
    connectedClients,
    peerClients,
    url: result.url,
    wifiUrl: result.wifiUrl,
    tailscaleUrl: result.tailscaleUrl,
    token: result.token,
    port: result.port,
  };
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
  applyRemoteStatus(createStartedRemoteAccessStatus(result));
  return result;
}

export async function stopRemoteAccess(): Promise<void> {
  if (!isElectronRuntime()) return;

  stopGeneration += 1;
  await invoke(IPC.StopRemoteServer);
  setRemoteAccessDisabled();
}

export async function refreshRemoteStatus(): Promise<void> {
  const generation = stopGeneration;
  const result = await fetchRemoteStatus();
  if (generation !== stopGeneration) return;
  applyRemoteStatus(result);
}
