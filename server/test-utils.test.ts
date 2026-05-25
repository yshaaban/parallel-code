import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectMessages,
  createTestServerEnv,
  expectNoMessage,
  type ServerMessage,
  trackSocketMessages,
  waitForTestServerStartup,
  waitForMessage,
} from './test-utils.js';

class FakeWebSocket extends EventEmitter {
  readyState = 1;
}

class FakeServerProcess extends EventEmitter {
  exitCode: number | null = null;
  readonly kill = vi.fn();
  readonly stderr = new EventEmitter();
  readonly stdout = new EventEmitter();
}

afterEach(() => {
  vi.useRealTimers();
});

function emitServerMessage(ws: FakeWebSocket, message: ServerMessage, isBinary = false): void {
  ws.emit('message', JSON.stringify(message), isBinary);
}

describe('test-utils buffered message helpers', () => {
  it('waitForMessage resolves from a message buffered before the waiter is attached', async () => {
    const ws = new FakeWebSocket() as unknown as import('ws').WebSocket;
    trackSocketMessages(ws);

    emitServerMessage(ws as unknown as FakeWebSocket, {
      type: 'agent-lifecycle',
      agentId: 'agent-1',
      event: 'pause',
    });

    await expect(
      waitForMessage(
        ws,
        (message) =>
          message.type === 'agent-lifecycle' &&
          message.agentId === 'agent-1' &&
          message.event === 'pause',
        100,
      ),
    ).resolves.toMatchObject({
      type: 'agent-lifecycle',
      agentId: 'agent-1',
      event: 'pause',
    });
  });

  it('collectMessages includes matching buffered messages that arrived before collection started', async () => {
    const ws = new FakeWebSocket() as unknown as import('ws').WebSocket;
    trackSocketMessages(ws);

    emitServerMessage(ws as unknown as FakeWebSocket, {
      type: 'channel',
      channelId: 'ch-1',
      payload: {
        type: 'Data',
        data: Buffer.from('first', 'utf8').toString('base64'),
      },
    });

    const collected = await collectMessages(
      ws,
      (message) => message.type === 'channel' && message.channelId === 'ch-1',
      10,
    );

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      type: 'channel',
      channelId: 'ch-1',
    });
  });

  it('expectNoMessage fails on an already buffered matching message', async () => {
    const ws = new FakeWebSocket() as unknown as import('ws').WebSocket;
    trackSocketMessages(ws);

    emitServerMessage(ws as unknown as FakeWebSocket, {
      type: 'remote-status',
      connectedClients: 2,
      peerClients: 1,
    });

    await expect(
      expectNoMessage(ws, (message) => message.type === 'remote-status', 10),
    ).rejects.toThrow('Received an unexpected buffered message');
  });
});

describe('createTestServerEnv', () => {
  it('applies the shared test-only browser build bypass and allows overrides', () => {
    const env = createTestServerEnv({
      PARALLEL_CODE_USER_DATA_DIR: '/tmp/custom-user-data',
      PORT: '1234',
    });

    expect(env.PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK).toBe('1');
    expect(env.PARALLEL_CODE_USER_DATA_DIR).toBe('/tmp/custom-user-data');
    expect(env.PORT).toBe('1234');
  });
});

describe('waitForTestServerStartup', () => {
  it('detects the readiness line across stdout chunks', async () => {
    const proc = new FakeServerProcess();
    const ready = waitForTestServerStartup(proc as never, 100);

    proc.stdout.emit('data', Buffer.from('Parallel Code server list'));
    proc.stdout.emit('data', Buffer.from('ening on http://127.0.0.1:3000\n'));

    await expect(ready).resolves.toBeUndefined();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('terminates the spawned process when readiness times out', async () => {
    vi.useFakeTimers();
    const proc = new FakeServerProcess();
    const ready = waitForTestServerStartup(proc as never, 5);
    const rejected = expect(ready).rejects.toThrow('Server startup timeout');

    await vi.advanceTimersByTimeAsync(5);

    await rejected;
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    vi.useRealTimers();
  });
});
