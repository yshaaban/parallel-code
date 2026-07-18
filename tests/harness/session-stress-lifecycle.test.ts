import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  bindSessionStressClients,
  connectAndBindOwnedSessionStressClient,
  connectAndBindOwnedSessionStressClients,
  connectOwnedSessionStressClients,
  connectSessionStressClient,
  createSessionStressClientOwner,
  runSessionStressWithCleanup,
} from '../../scripts/session-stress.mjs';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createClient(label: string) {
  return {
    close: vi.fn(),
    label,
  };
}

function createServerTarget(stop = vi.fn().mockResolvedValue(undefined)) {
  return {
    client: {
      authToken: 'session-stress-token',
      createWebSocketUrl: () => 'ws://127.0.0.1:43117/ws',
    },
    stop,
  };
}

function createClientState(label: string) {
  return {
    clientId: `client-${label}`,
    label,
    lastSeq: -1,
  };
}

describe('session-stress lifecycle', () => {
  it('attempts every cleanup and preserves all failures after a successful run', async () => {
    const agentCleanupError = new Error('agent cleanup failed');
    const clientCleanupError = new Error('client cleanup failed');
    const serverCleanupError = new Error('server cleanup failed');
    const killAgent = vi
      .fn()
      .mockRejectedValueOnce(agentCleanupError)
      .mockResolvedValueOnce(undefined);
    const closeFirstClient = vi.fn(() => {
      throw clientCleanupError;
    });
    const closeSecondClient = vi.fn();
    const stopServer = vi.fn().mockRejectedValue(serverCleanupError);

    const failure = await runSessionStressWithCleanup(
      async () => ({ result: 'complete' }),
      {
        getAgents: () => [{ agentId: 'agent-1' }, { agentId: 'agent-2' }],
        getClients: () => [{ close: closeFirstClient }, { close: closeSecondClient }],
        serverTarget: { stop: stopServer },
      },
      { killAgent },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe('Session stress cleanup failed');
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        cause: expect.objectContaining({ errors: [agentCleanupError] }),
        message: 'stop stress agents: Failed to stop one or more stress agents',
      }),
      expect.objectContaining({
        cause: expect.objectContaining({ errors: [clientCleanupError] }),
        message: 'close stress clients: Failed to close one or more stress clients',
      }),
      expect.objectContaining({
        cause: serverCleanupError,
        message: 'stop stress server: server cleanup failed',
      }),
    ]);
    expect(killAgent).toHaveBeenCalledTimes(2);
    expect(closeFirstClient).toHaveBeenCalledOnce();
    expect(closeSecondClient).toHaveBeenCalledOnce();
    expect(stopServer).toHaveBeenCalledOnce();
  });

  it('returns the operation result after every cleanup succeeds', async () => {
    const stopServer = vi.fn().mockResolvedValue(undefined);

    await expect(
      runSessionStressWithCleanup(async () => ({ result: 'complete' }), {
        getAgents: () => [],
        getClients: () => [],
        serverTarget: { stop: stopServer },
      }),
    ).resolves.toEqual({ result: 'complete' });
    expect(stopServer).toHaveBeenCalledOnce();
  });

  it('closes a failed connection attempt and detaches every startup listener', async () => {
    class FakeSocket extends EventEmitter {
      readonly close = vi.fn(() => {
        this.readyState = 3;
        this.emit('close');
      });

      readyState = 0;
      readonly send = vi.fn();
      readonly terminate = vi.fn(() => {
        this.readyState = 3;
        this.emit('close');
      });
    }

    const socket = new FakeSocket();
    const connection = connectSessionStressClient(
      createServerTarget(),
      createClientState('failed-connect'),
      {
        createSocket: () => socket,
        timeoutMs: 1_000,
      },
    );
    const failure = new Error('connection refused');

    socket.emit('error', failure);

    await expect(connection).rejects.toBe(failure);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.close).not.toHaveBeenCalled();
    for (const eventName of ['open', 'message', 'error', 'close']) {
      expect(socket.listenerCount(eventName)).toBe(0);
    }
  });

  it.each([
    ['open', 1],
    ['closing', 2],
  ])('force-terminates a failed %s pre-authentication socket', async (_stateName, readyState) => {
    class FakeSocket extends EventEmitter {
      readonly close = vi.fn();
      readyState = readyState;
      readonly send = vi.fn();
      readonly terminate = vi.fn(() => {
        this.readyState = 3;
        this.emit('close');
      });
    }

    const socket = new FakeSocket();
    const connection = connectSessionStressClient(
      createServerTarget(),
      createClientState(`failed-${_stateName}`),
      {
        createSocket: () => socket,
        timeoutMs: 1_000,
      },
    );
    const failure = new Error('authentication failed');

    socket.emit('error', failure);

    await expect(connection).rejects.toBe(failure);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.close).not.toHaveBeenCalled();
    for (const eventName of ['open', 'message', 'error', 'close']) {
      expect(socket.listenerCount(eventName)).toBe(0);
    }
  });

  it('preserves connection and arbitrary socket-cleanup failures together', async () => {
    class FakeSocket extends EventEmitter {
      readonly close = vi.fn(() => {
        throw null;
      });

      readyState = 0;
      readonly send = vi.fn();
      readonly terminate = vi.fn(() => {
        throw undefined;
      });
    }

    const socket = new FakeSocket();
    const connectionFailure = new Error('authentication failed');
    const connection = connectSessionStressClient(
      createServerTarget(),
      createClientState('failed-cleanup'),
      {
        createSocket: () => socket,
        timeoutMs: 1_000,
      },
    );

    socket.emit('error', connectionFailure);
    const failure = await connection.catch((error: unknown) => error);

    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      'Stress client failed-cleanup connection operation and cleanup failed',
    );
    expect((failure as AggregateError).errors).toEqual([
      connectionFailure,
      expect.objectContaining({
        cause: undefined,
        message: 'terminate failed stress client socket: undefined',
      }),
      expect.objectContaining({ cause: null, message: 'close failed stress client socket: null' }),
    ]);
    for (const eventName of ['open', 'message', 'error', 'close']) {
      expect(socket.listenerCount(eventName)).toBe(0);
    }
  });

  it('waits for late initial-client acquisition before closing every partial success', async () => {
    const firstClient = createClient('first');
    const lateClient = createClient('late');
    const lateConnection = createDeferred<typeof lateClient>();
    const connectionFailure = new Error('second client auth failed');
    const clientOwner = createSessionStressClientOwner();
    const serverTarget = createServerTarget();
    const connectClient = vi.fn((_target, state: { label: string }) => {
      switch (state.label) {
        case 'first':
          return Promise.resolve(firstClient);
        case 'failed':
          return Promise.reject(connectionFailure);
        case 'late':
          return lateConnection.promise;
        default:
          throw new Error(`Unexpected client ${state.label}`);
      }
    });

    let settled = false;
    const outcome = runSessionStressWithCleanup(
      () =>
        connectOwnedSessionStressClients(
          serverTarget,
          [createClientState('first'), createClientState('failed'), createClientState('late')],
          clientOwner,
          { connectClient },
        ),
      {
        getAgents: () => [],
        getClients: clientOwner.getClients,
        serverTarget,
      },
    ).then(
      (value) => {
        settled = true;
        return { status: 'fulfilled' as const, value };
      },
      (reason: unknown) => {
        settled = true;
        return { reason, status: 'rejected' as const };
      },
    );

    await vi.waitFor(() => {
      expect(clientOwner.getClients()).toEqual([firstClient]);
    });
    expect(settled).toBe(false);
    expect(firstClient.close).not.toHaveBeenCalled();

    lateConnection.resolve(lateClient);
    const result = await outcome;

    expect(result).toEqual({
      reason: expect.objectContaining({
        errors: [connectionFailure],
        message: 'Failed to connect one or more stress clients',
      }),
      status: 'rejected',
    });
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(lateClient.close).toHaveBeenCalledOnce();
    expect(serverTarget.stop).toHaveBeenCalledOnce();
  });

  it('waits for every initial secondary-client bind before cleanup starts', async () => {
    const firstClient = createClient('first-secondary');
    const lateClient = createClient('late-secondary');
    const lateBind = createDeferred<string[]>();
    const bindFailure = new Error('first secondary bind failed');
    const clientOwner = createSessionStressClientOwner();
    clientOwner.own(firstClient);
    clientOwner.own(lateClient);
    const serverTarget = createServerTarget();
    const bindClientToChannels = vi.fn((client: typeof firstClient) => {
      if (client === firstClient) {
        throw bindFailure;
      }
      return lateBind.promise;
    });
    let settled = false;
    const outcome = runSessionStressWithCleanup(
      () =>
        bindSessionStressClients([firstClient, lateClient], ['channel-1'], {
          bindClientToChannels,
        }),
      {
        getAgents: () => [],
        getClients: clientOwner.getClients,
        serverTarget,
      },
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });

    await vi.waitFor(() => {
      expect(bindClientToChannels).toHaveBeenCalledTimes(2);
    });
    expect(settled).toBe(false);
    expect(firstClient.close).not.toHaveBeenCalled();
    expect(lateClient.close).not.toHaveBeenCalled();

    lateBind.resolve([]);
    const failure = await outcome;

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe('Failed to bind one or more stress clients');
    expect((failure as AggregateError).errors).toEqual([bindFailure]);
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(lateClient.close).toHaveBeenCalledOnce();
  });

  it('waits for all late-join binds and retains clients whose bind failed', async () => {
    const firstClient = createClient('first-late-join');
    const secondClient = createClient('second-late-join');
    const secondBind = createDeferred<string[]>();
    const bindFailure = new Error('first late-join bind failed');
    const clientOwner = createSessionStressClientOwner();
    const serverTarget = createServerTarget();
    const connectClient = vi.fn((_target, state: { label: string }) =>
      Promise.resolve(state.label === 'first' ? firstClient : secondClient),
    );
    const bindClientToChannels = vi.fn((client: typeof firstClient) =>
      client === firstClient ? Promise.reject(bindFailure) : secondBind.promise,
    );

    let settled = false;
    const outcome = runSessionStressWithCleanup(
      () =>
        connectAndBindOwnedSessionStressClients(
          serverTarget,
          [createClientState('first'), createClientState('second')],
          ['channel-1'],
          clientOwner,
          { bindClientToChannels, connectClient },
        ),
      {
        getAgents: () => [],
        getClients: clientOwner.getClients,
        serverTarget,
      },
    ).then(
      (value) => {
        settled = true;
        return { status: 'fulfilled' as const, value };
      },
      (reason: unknown) => {
        settled = true;
        return { reason, status: 'rejected' as const };
      },
    );

    await vi.waitFor(() => {
      expect(clientOwner.getClients()).toEqual([firstClient, secondClient]);
      expect(bindClientToChannels).toHaveBeenCalledTimes(2);
    });
    expect(settled).toBe(false);
    expect(firstClient.close).not.toHaveBeenCalled();
    expect(secondClient.close).not.toHaveBeenCalled();

    secondBind.resolve([]);
    const result = await outcome;

    expect(result).toEqual({
      reason: expect.objectContaining({
        errors: [bindFailure],
        message: 'Failed to connect or bind one or more stress clients',
      }),
      status: 'rejected',
    });
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(secondClient.close).toHaveBeenCalledOnce();
  });

  it('retains a reconnect replacement through a later restore failure', async () => {
    const replacementClient = createClient('replacement');
    const restoreFailure = new Error('reconnect snapshot failed');
    const clientOwner = createSessionStressClientOwner();
    const serverTarget = createServerTarget();

    const outcome = runSessionStressWithCleanup(
      async () => {
        const result = await connectAndBindOwnedSessionStressClient(
          serverTarget,
          createClientState('replacement'),
          ['channel-1'],
          clientOwner,
          {
            bindClientToChannels: vi.fn().mockResolvedValue([]),
            connectClient: vi.fn().mockResolvedValue(replacementClient),
          },
        );
        expect(result.client).toBe(replacementClient);
        throw restoreFailure;
      },
      {
        getAgents: () => [],
        getClients: clientOwner.getClients,
        serverTarget,
      },
    ).catch((error: unknown) => error);

    await expect(outcome).resolves.toBe(restoreFailure);
    expect(replacementClient.close).toHaveBeenCalledOnce();
    expect(serverTarget.stop).toHaveBeenCalledOnce();
  });
});
