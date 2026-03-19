import { IPC } from '../../electron/ipc/channels';
import {
  createDisabledRemoteAccessStatus,
  type RemoteAccessStatus,
  type RemotePresence,
} from '../domain/server-state';
import type { RemoteAccessStartResult } from '../domain/renderer-invoke';
import { invoke, isElectronRuntime } from '../lib/ipc';
import { setStore, store } from '../store/state';

const DISABLED_REMOTE_ACCESS = createDisabledRemoteAccessStatus(7777);

let stopGeneration = 0;

function setRemoteAccessDisabled(): void {
  setStore('remoteAccess', DISABLED_REMOTE_ACCESS);
}

export function applyRemoteStatus(result: RemoteAccessStatus): void {
  setStore('remoteAccess', result);
}

export function updateRemotePeerStatus(status: RemotePresence): void {
  setStore('remoteAccess', 'connectedClients', status.connectedClients);
  setStore('remoteAccess', 'peerClients', status.peerClients);
}

async function fetchRemoteStatus(): Promise<RemoteAccessStatus> {
  return invoke(IPC.GetRemoteStatus);
}

export async function fetchRemoteStatusSnapshot(): Promise<RemoteAccessStatus> {
  return fetchRemoteStatus();
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

  const result = port
    ? await invoke(IPC.StartRemoteServer, { port })
    : await invoke(IPC.StartRemoteServer);
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
