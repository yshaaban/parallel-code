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
    const startServerMock = vi.fn().mockResolvedValue({
      stop: stopMock,
      token: 'token-123',
      port: 8123,
      url: 'http://localhost:8123',
      wifiUrl: 'http://wifi:8123',
      tailscaleUrl: null,
      connectedClients: connectedClientsMock,
    });

    const controller = createRemoteAccessController({
      defaultPort: 7000,
      startServer: startServerMock,
      staticDir: '/tmp/dist-remote',
    });

    expect(getRemoteAccessStatusWorkflow(controller)).toEqual({
      enabled: false,
      connectedClients: 0,
      peerClients: 0,
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

    await stopRemoteAccessWorkflow(controller);

    expect(stopMock).toHaveBeenCalledOnce();
    expect(getRemoteAccessStatusWorkflow(controller)).toEqual({
      enabled: false,
      connectedClients: 0,
      peerClients: 0,
    });
  });
});
