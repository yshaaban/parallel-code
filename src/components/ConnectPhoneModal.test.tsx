import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { resetStoreForTest } from '../test/store-test-helpers';

const { isElectronRuntimeMock, startRemoteAccessMock, stopRemoteAccessMock, toDataUrlMock } =
  vi.hoisted(() => ({
    isElectronRuntimeMock: vi.fn(),
    startRemoteAccessMock: vi.fn(),
    stopRemoteAccessMock: vi.fn(),
    toDataUrlMock: vi.fn(),
  }));

vi.mock('../lib/ipc', () => ({
  isElectronRuntime: isElectronRuntimeMock,
}));

vi.mock('../store/remote', () => ({
  startRemoteAccess: startRemoteAccessMock,
  stopRemoteAccess: stopRemoteAccessMock,
}));

vi.mock('../lib/focus-restore', () => ({
  createFocusRestore: vi.fn(),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: toDataUrlMock },
  toDataURL: toDataUrlMock,
}));

import { ConnectPhoneModal } from './ConnectPhoneModal';

describe('ConnectPhoneModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    toDataUrlMock.mockResolvedValue('data:image/png;base64,qr');
  });

  it('starts remote access on open in Electron and disconnects cleanly', async () => {
    isElectronRuntimeMock.mockReturnValue(true);
    startRemoteAccessMock.mockImplementation(async () => {
      setStore('remoteAccess', {
        enabled: true,
        connectedClients: 1,
        peerClients: 1,
        port: 7777,
        url: 'http://desktop',
        wifiUrl: null,
        tailscaleUrl: 'https://tailscale',
        token: 'secret',
      });

      return {
        port: 7777,
        url: 'http://desktop',
        wifiUrl: null,
        tailscaleUrl: 'https://tailscale',
        token: 'secret',
      };
    });

    const onClose = vi.fn();

    render(() => <ConnectPhoneModal open onClose={onClose} />);

    await waitFor(() => {
      expect(startRemoteAccessMock).toHaveBeenCalledTimes(1);
      expect(screen.getByAltText('Connection QR code')).toBeDefined();
    });

    expect(screen.getByText(/1 client connected/i)).toBeDefined();
    expect(screen.getByText(/tailscale network/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => {
      expect(stopRemoteAccessMock).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('shows existing pushed browser remote status without starting a server', async () => {
    isElectronRuntimeMock.mockReturnValue(false);
    setStore('remoteAccess', {
      enabled: true,
      connectedClients: 3,
      peerClients: 2,
      port: 7777,
      url: 'https://browser',
      wifiUrl: 'https://wifi',
      tailscaleUrl: null,
      token: 'secret',
    });

    render(() => <ConnectPhoneModal open onClose={vi.fn()} />);

    expect(await screen.findByAltText('Connection QR code')).toBeDefined();
    expect(startRemoteAccessMock).not.toHaveBeenCalled();
    expect(screen.getByText(/2 peer clients connected/i)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined();
  });
});
