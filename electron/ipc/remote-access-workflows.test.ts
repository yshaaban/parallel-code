import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteAccessController,
  getRemoteAccessStatusWorkflow,
  startRemoteAccessWorkflow,
  stopRemoteAccessWorkflow,
} from './remote-access-workflows.js';

describe('remote access workflows', () => {
  it('caches the started remote server and reports status', async () => {
    const stopMock = vi.fn().mockResolvedValue(undefined);
    const connectedClientsMock = vi.fn().mockReturnValue(3);
    let notifyStatusChanged: ((count: number) => void) | undefined;
    const startServerMock = vi.fn().mockResolvedValue({
      stop: stopMock,
      token: 'token-123',
      port: 8123,
      url: 'http://localhost:8123',
      wifiUrl: 'http://wifi:8123',
      tailscaleUrl: null,
      connectedClients: connectedClientsMock,
    });
    startServerMock.mockImplementation(async (options) => {
      notifyStatusChanged = options.onAuthenticatedClientCountChanged;
      return {
        stop: stopMock,
        token: 'token-123',
        port: 8123,
        url: 'http://localhost:8123',
        wifiUrl: 'http://wifi:8123',
        tailscaleUrl: null,
        connectedClients: connectedClientsMock,
      };
    });

    const controller = createRemoteAccessController({
      defaultPort: 7000,
      startServer: startServerMock,
      staticDir: '/tmp/dist-remote',
    });
    const statusListener = vi.fn();
    const unsubscribeStatus = controller.subscribe(statusListener);

    expect(getRemoteAccessStatusWorkflow(controller)).toEqual({
      enabled: false,
      connectedClients: 0,
      peerClients: 0,
      token: null,
      port: 7000,
      url: null,
      wifiUrl: null,
      tailscaleUrl: null,
    });

    const firstStart = await startRemoteAccessWorkflow(controller, {
      getTaskName: (taskId) => `task:${taskId}`,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
    });
    const secondStart = await startRemoteAccessWorkflow(controller, {
      port: 9000,
      getTaskName: (taskId) => `task:${taskId}`,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
    });

    expect(startServerMock).toHaveBeenCalledTimes(1);
    expect(startServerMock).toHaveBeenCalledWith({
      port: 7000,
      staticDir: '/tmp/dist-remote',
      getTaskName: expect.any(Function),
      getAgentStatus: expect.any(Function),
      onAuthenticatedClientCountChanged: expect.any(Function),
    });
    expect(firstStart).toEqual({
      url: 'http://localhost:8123',
      wifiUrl: 'http://wifi:8123',
      tailscaleUrl: null,
      token: 'token-123',
      port: 8123,
    });
    expect(secondStart).toEqual(firstStart);
    expect(getRemoteAccessStatusWorkflow(controller)).toEqual({
      enabled: true,
      connectedClients: 3,
      peerClients: 3,
      url: 'http://localhost:8123',
      wifiUrl: 'http://wifi:8123',
      tailscaleUrl: null,
      token: 'token-123',
      port: 8123,
    });
    expect(getRemoteAccessStatusWorkflow(controller).peerClients).toBe(3);
    expect(statusListener).toHaveBeenCalledWith({
      enabled: true,
      connectedClients: 3,
      peerClients: 3,
      url: 'http://localhost:8123',
      wifiUrl: 'http://wifi:8123',
      tailscaleUrl: null,
      token: 'token-123',
      port: 8123,
    });

    connectedClientsMock.mockReturnValue(5);
    notifyStatusChanged?.(5);

    expect(statusListener).toHaveBeenLastCalledWith({
      enabled: true,
      connectedClients: 5,
      peerClients: 5,
      url: 'http://localhost:8123',
      wifiUrl: 'http://wifi:8123',
      tailscaleUrl: null,
      token: 'token-123',
      port: 8123,
    });

    await stopRemoteAccessWorkflow(controller);

    expect(stopMock).toHaveBeenCalledOnce();
    expect(getRemoteAccessStatusWorkflow(controller)).toEqual({
      enabled: false,
      connectedClients: 0,
      peerClients: 0,
      token: null,
      port: 7000,
      url: null,
      wifiUrl: null,
      tailscaleUrl: null,
    });
    expect(statusListener).toHaveBeenLastCalledWith({
      enabled: false,
      connectedClients: 0,
      peerClients: 0,
      token: null,
      port: 7000,
      url: null,
      wifiUrl: null,
      tailscaleUrl: null,
    });

    unsubscribeStatus();
  });
});
