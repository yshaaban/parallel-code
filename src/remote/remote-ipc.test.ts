import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const authMocks = vi.hoisted(() => ({
  getToken: vi.fn<() => string | null>(),
}));

vi.mock('./auth', () => ({
  getToken: authMocks.getToken,
}));

vi.mock('./client-id', () => ({
  getRemoteClientId: vi.fn(() => 'remote-mobile-client'),
}));

import { acquireRemoteTaskCommandLease, writeRemoteAgent } from './remote-ipc';

describe('remote ipc auth transport', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    authMocks.getToken.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            acquired: true,
            action: 'type in the terminal',
            changed: true,
            controllerId: 'remote-mobile-client',
            taskId: 'task-1',
            version: 1,
          },
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses same-origin credentials when the auth token is absent', async () => {
    authMocks.getToken.mockReturnValue(null);

    await expect(
      acquireRemoteTaskCommandLease({
        action: 'type in the terminal',
        clientId: 'remote-mobile-client',
        ownerId: 'remote-owner',
        taskId: 'task-1',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        acquired: true,
        taskId: 'task-1',
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ipc/' + encodeURIComponent(IPC.AcquireTaskCommandLease),
      expect.objectContaining({
        credentials: 'same-origin',
        headers: expect.not.objectContaining({
          Authorization: expect.any(String),
        }),
      }),
    );
  });

  it('adds bearer auth when a bootstrap token is still available', async () => {
    authMocks.getToken.mockReturnValue('bootstrap-token');

    await acquireRemoteTaskCommandLease({
      action: 'type in the terminal',
      clientId: 'remote-mobile-client',
      ownerId: 'remote-owner',
      taskId: 'task-1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ipc/' + encodeURIComponent(IPC.AcquireTaskCommandLease),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer bootstrap-token',
        }),
      }),
    );
  });

  it('accepts empty success payloads for write operations', async () => {
    authMocks.getToken.mockReturnValue(null);
    fetchMock.mockResolvedValueOnce(
      new Response('{}', {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    await expect(
      writeRemoteAgent({
        agentId: 'agent-1',
        data: 'pwd\r',
        taskId: 'task-1',
      }),
    ).resolves.toBeUndefined();
  });
});
