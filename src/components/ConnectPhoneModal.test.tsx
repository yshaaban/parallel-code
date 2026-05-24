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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

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

  it('ignores stale QR generation after switching network modes', async () => {
    const wifiQr = createDeferred<string>();
    const tailscaleQr = createDeferred<string>();
    toDataUrlMock.mockImplementation((url: string) => {
      if (url === 'https://wifi') {
        return wifiQr.promise;
      }

      if (url === 'https://tailscale') {
        return tailscaleQr.promise;
      }

      return Promise.reject(new Error(`Unexpected QR URL: ${url}`));
    });
    isElectronRuntimeMock.mockReturnValue(true);
    setStore('remoteAccess', {
      enabled: true,
      connectedClients: 1,
      peerClients: 1,
      port: 7777,
      url: 'https://browser',
      wifiUrl: 'https://wifi',
      tailscaleUrl: 'https://tailscale',
      token: 'secret',
    });

    render(() => <ConnectPhoneModal open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(toDataUrlMock).toHaveBeenCalledWith('https://wifi', expect.any(Object));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Tailscale' }));
    await waitFor(() => {
      expect(toDataUrlMock).toHaveBeenCalledWith('https://tailscale', expect.any(Object));
    });

    tailscaleQr.resolve('data:image/png;base64,dGFpbHNjYWxl');
    const image = (await screen.findByAltText('Connection QR code')) as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('data:image/png;base64,dGFpbHNjYWxl');

    wifiQr.resolve('data:image/png;base64,d2lmaQ==');
    await Promise.resolve();
    await Promise.resolve();

    expect(image.getAttribute('src')).toBe('data:image/png;base64,dGFpbHNjYWxl');
  });

  it('shows a visible QR placeholder when QR rendering fails', async () => {
    isElectronRuntimeMock.mockReturnValue(false);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    toDataUrlMock.mockRejectedValue(new Error('QR renderer unavailable'));
    setStore('remoteAccess', {
      enabled: true,
      connectedClients: 0,
      peerClients: 0,
      port: 7777,
      url: 'https://browser',
      wifiUrl: 'https://wifi',
      tailscaleUrl: null,
      token: 'secret',
    });

    try {
      render(() => <ConnectPhoneModal open onClose={vi.fn()} />);

      expect(screen.getByRole('status', { name: 'Generating connection QR code' })).toBeDefined();
      expect(await screen.findByRole('status', { name: 'QR code unavailable' })).toBeDefined();
      expect(screen.queryByAltText('Connection QR code')).toBeNull();
      expect(screen.getByText('https://wifi')).toBeDefined();
    } finally {
      consoleErrorSpy.mockRestore();
    }
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
