import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { invokeMock, runtimeState, setStoreMock, storeState } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  runtimeState: {
    electronRuntime: false,
  },
  setStoreMock: vi.fn(),
  storeState: {
    remoteAccess: {
      enabled: false,
      connectedClients: 0,
      peerClients: 0,
    },
  },
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
  isElectronRuntime: () => runtimeState.electronRuntime,
}));

vi.mock('../store/core', () => ({
  setStore: setStoreMock,
  store: storeState,
}));

import {
  applyRemoteStatus,
  refreshRemoteStatus,
  startRemoteAccess,
  stopRemoteAccess,
  updateRemotePeerStatus,
} from './remote-access';

describe('remote access app workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeState.electronRuntime = false;
    storeState.remoteAccess = {
      enabled: false,
      connectedClients: 0,
      peerClients: 0,
    };
  });

  it('requires enabled remote status in browser mode', async () => {
    invokeMock.mockResolvedValue({
      enabled: false,
      connectedClients: 0,
      peerClients: 0,
    });

    await expect(startRemoteAccess()).rejects.toThrow('Remote access information is unavailable');
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetRemoteStatus);
    expect(setStoreMock).toHaveBeenCalledWith('remoteAccess', {
      enabled: false,
      token: null,
      port: 7777,
      url: null,
      wifiUrl: null,
      tailscaleUrl: null,
      connectedClients: 0,
      peerClients: 0,
    });
  });

  it('applies enabled remote status directly in browser mode', async () => {
    invokeMock.mockResolvedValue({
      enabled: true,
      connectedClients: 4,
      peerClients: 3,
      url: 'http://server',
      wifiUrl: 'http://wifi',
      tailscaleUrl: null,
      token: 'secret',
      port: 7777,
    });

    await expect(startRemoteAccess()).resolves.toEqual({
      url: 'http://server',
      wifiUrl: 'http://wifi',
      tailscaleUrl: null,
      token: 'secret',
      port: 7777,
    });

    expect(setStoreMock).toHaveBeenCalledWith('remoteAccess', {
      enabled: true,
      connectedClients: 4,
      peerClients: 3,
      url: 'http://server',
      wifiUrl: 'http://wifi',
      tailscaleUrl: null,
      token: 'secret',
      port: 7777,
    });
  });

  it('drops stale refresh results after an electron stop', async () => {
    runtimeState.electronRuntime = true;
    let resolveStatus!: (value: unknown) => void;

    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.GetRemoteStatus) {
        return new Promise((resolve) => {
          resolveStatus = resolve;
        });
      }

      if (channel === IPC.StopRemoteServer) {
        return Promise.resolve(undefined);
      }

      throw new Error(`Unexpected channel: ${channel}`);
    });

    const refreshPromise = refreshRemoteStatus();
    await stopRemoteAccess();

    resolveStatus({
      enabled: true,
      connectedClients: 2,
      peerClients: 2,
      url: 'http://server',
      wifiUrl: null,
      tailscaleUrl: null,
      token: 'secret',
      port: 7777,
    });
    await refreshPromise;

    expect(setStoreMock).toHaveBeenCalledWith('remoteAccess', {
      enabled: false,
      token: null,
      port: 7777,
      url: null,
      wifiUrl: null,
      tailscaleUrl: null,
      connectedClients: 0,
      peerClients: 0,
    });
    expect(setStoreMock).not.toHaveBeenCalledWith('remoteAccess', {
      enabled: true,
      connectedClients: 2,
      peerClients: 2,
      url: 'http://server',
      wifiUrl: null,
      tailscaleUrl: null,
      token: 'secret',
      port: 7777,
    });
  });

  it('preserves known peer counts when electron start reuses a running server', async () => {
    runtimeState.electronRuntime = true;
    storeState.remoteAccess = {
      enabled: true,
      connectedClients: 4,
      peerClients: 4,
    };
    invokeMock.mockResolvedValue({
      url: 'http://server',
      wifiUrl: 'http://wifi',
      tailscaleUrl: null,
      token: 'secret',
      port: 7777,
    });

    await startRemoteAccess();

    expect(setStoreMock).toHaveBeenCalledWith('remoteAccess', {
      enabled: true,
      connectedClients: 4,
      peerClients: 4,
      url: 'http://server',
      wifiUrl: 'http://wifi',
      tailscaleUrl: null,
      token: 'secret',
      port: 7777,
    });
  });

  it('applies pushed remote status snapshots and peer-count updates', () => {
    applyRemoteStatus({
      enabled: true,
      connectedClients: 3,
      peerClients: 2,
      url: 'http://server',
      wifiUrl: 'http://wifi',
      tailscaleUrl: null,
      token: 'secret',
      port: 7777,
    });
    updateRemotePeerStatus(6, 5);

    expect(setStoreMock).toHaveBeenCalledWith('remoteAccess', {
      enabled: true,
      connectedClients: 3,
      peerClients: 2,
      url: 'http://server',
      wifiUrl: 'http://wifi',
      tailscaleUrl: null,
      token: 'secret',
      port: 7777,
    });
    expect(setStoreMock).toHaveBeenCalledWith('remoteAccess', 'connectedClients', 6);
    expect(setStoreMock).toHaveBeenCalledWith('remoteAccess', 'peerClients', 5);
  });
});
