import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { installManualAnimationFrame } from '../test/manual-animation-frame';
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

vi.mock('../app/remote-access', () => ({
  startRemoteAccess: startRemoteAccessMock,
  stopRemoteAccess: stopRemoteAccessMock,
}));

vi.mock('../lib/focus-restore', () => ({
  createFocusRestore: vi.fn(),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: toDataUrlMock },
}));

import { ConnectPhoneModal } from './ConnectPhoneModal';

describe('ConnectPhoneModal', () => {
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetStoreForTest();
    toDataUrlMock.mockResolvedValue('data:image/png;base64,qr');
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: originalRequestAnimationFrame,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value: originalCancelAnimationFrame,
    });
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

    expect(await screen.findByAltText('Connection QR code', {}, { timeout: 10_000 })).toBeDefined();
    expect(startRemoteAccessMock).toHaveBeenCalledTimes(1);

    expect(screen.getByText(/1 client connected/i)).toBeDefined();
    expect(screen.getByText(/tailscale network/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await waitFor(
      () => {
        expect(stopRemoteAccessMock).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
      },
      { timeout: 10_000 },
    );
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

    expect(await screen.findByAltText('Connection QR code', {}, { timeout: 10_000 })).toBeDefined();
    expect(startRemoteAccessMock).not.toHaveBeenCalled();
    expect(screen.getByText(/2 peer clients connected/i)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined();
  });

  it('cancels stale dialog focus when the modal closes before the scheduled frame', () => {
    const animationFrame = installManualAnimationFrame();
    isElectronRuntimeMock.mockReturnValue(true);
    setStore('remoteAccess', {
      enabled: true,
      connectedClients: 1,
      peerClients: 1,
      port: 7777,
      url: 'https://browser',
      wifiUrl: 'https://wifi',
      tailscaleUrl: null,
      token: 'secret',
    });

    const [open, setOpen] = createSignal(true);

    render(() => <ConnectPhoneModal open={open()} onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Connect Phone' }) as HTMLDivElement;
    const focusSpy = vi.spyOn(dialog, 'focus');

    setOpen(false);
    animationFrame.flush();

    expect(animationFrame.cancelAnimationFrameMock).toHaveBeenCalledWith(1);
    expect(focusSpy).not.toHaveBeenCalled();
  });
});
