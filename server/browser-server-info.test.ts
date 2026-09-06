import { describe, expect, it, vi } from 'vitest';
import { createBrowserControlPlane } from './browser-control-plane.js';
import { createBrowserServerInfo } from './browser-server-info.js';

vi.mock('../electron/remote/network.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../electron/remote/network.js')>()),
  getNetworkIps: () => ({ wifi: '192.0.2.15', tailscale: '100.64.0.15' }),
}));

describe('browser listener access URLs', () => {
  it('does not advertise unreachable LAN URLs for a local-only listener', () => {
    const info = createBrowserServerInfo({
      getAuthenticatedClientCount: () => 1,
      getPort: () => 43117,
      token: 'test-private-token',
    });
    expect(info.getRemoteStatus()).toMatchObject({
      connectedClients: 1,
      url: 'http://127.0.0.1:43117?token=test-private-token',
      wifiUrl: null,
      tailscaleUrl: null,
    });
  });

  it.each([false, true])(
    'projects network exposure through the control plane: %s',
    (networkAccessible) => {
      const control = createBrowserControlPlane({
        buildAgentList: () => [],
        cleanupSocketClient: () => {},
        networkAccessible,
        port: 0,
        token: 'test-private-token',
      });
      try {
        control.setServerPort(43123);
        expect(control.getRemoteStatus()).toMatchObject({
          port: 43123,
          wifiUrl: networkAccessible ? 'http://192.0.2.15:43123?token=test-private-token' : null,
          tailscaleUrl: networkAccessible
            ? 'http://100.64.0.15:43123?token=test-private-token'
            : null,
        });
      } finally {
        control.cleanup();
      }
    },
  );

  it('keeps secure remote bootstrap URLs scoped while exposing a network listener', () => {
    const info = createBrowserServerInfo({
      getAuthenticatedClientCount: () => 0,
      getPort: () => 43117,
      networkAccessible: true,
      secureSessionBootstrap: { bootstrapPath: '/remote/auth/bootstrap', nextPath: '/remote/' },
      token: 'test-scoped-token',
    });
    expect(info.getServerInfo().wifiUrl).toBe(
      'https://192.0.2.15:43117/remote/auth/bootstrap?token=test-scoped-token&next=%2Fremote%2F',
    );
  });
});
