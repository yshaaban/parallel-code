import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectMessages,
  cleanupTestServerEnv,
  createTestServerEnv,
  expectNoMessage,
  startServer,
  stopServer,
  stopTestServerProcess,
  type ServerMessage,
  trackSocketMessages,
  waitForTestServerStartup,
  waitForMessage,
} from './test-utils.test-helper.js';

class FakeWebSocket extends EventEmitter {
  readyState = 1;
}

class FakeServerProcess extends EventEmitter {
  exitCode: number | null = null;
  readonly kill = vi.fn();
  signalCode: NodeJS.Signals | null = null;
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
  it('applies the shared test-only browser build bypass and shell sandbox env', () => {
    const env = createTestServerEnv({
      PARALLEL_CODE_USER_DATA_DIR: '/tmp/custom-user-data',
      PORT: '1234',
    });

    expect(env.PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK).toBe('1');
    expect(env.PARALLEL_CODE_USER_DATA_DIR).toBe('/tmp/custom-user-data');
    expect(env.PARALLEL_CODE_TEST_SHELL_HOME).toBe(
      path.resolve('/tmp/custom-user-data', 'shell-home'),
    );
    expect(env.PORT).toBe('1234');
  });

  it('allows a caller to override the derived shell sandbox path explicitly', () => {
    const env = createTestServerEnv({
      PARALLEL_CODE_TEST_SHELL_HOME: '/tmp/custom-shell-home',
      PARALLEL_CODE_USER_DATA_DIR: '/tmp/custom-user-data',
    });

    expect(env.PARALLEL_CODE_TEST_SHELL_HOME).toBe('/tmp/custom-shell-home');
  });

  it('removes a canonical sandbox and its empty helper-owned user-data root', async () => {
    const parentPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-server-env-test-'));
    const userDataPath = path.join(parentPath, 'user-data');
    const env = createTestServerEnv({
      PARALLEL_CODE_USER_DATA_DIR: userDataPath,
    });
    const shellHomePath = env.PARALLEL_CODE_TEST_SHELL_HOME;
    const developmentStatePath = `${userDataPath}-dev`;
    if (!shellHomePath) {
      throw new Error('Expected a derived test shell home path');
    }

    try {
      fs.mkdirSync(shellHomePath, { recursive: true });
      fs.writeFileSync(path.join(shellHomePath, '.shell_history'), 'sandboxed\n');
      fs.mkdirSync(developmentStatePath, { recursive: true });
      fs.writeFileSync(path.join(developmentStatePath, 'state.json'), '{}');

      await cleanupTestServerEnv(env, { defaultUserDataPath: userDataPath });

      expect(fs.existsSync(shellHomePath)).toBe(false);
      expect(fs.existsSync(userDataPath)).toBe(false);
      expect(fs.existsSync(developmentStatePath)).toBe(false);
    } finally {
      fs.rmSync(parentPath, { force: true, recursive: true });
    }
  });

  it('preserves caller-owned shell and user-data directories', async () => {
    const parentPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-server-env-test-'));
    const userDataPath = path.join(parentPath, 'user-data');
    const shellHomePath = path.join(parentPath, 'caller-owned-shell-home');
    const developmentStatePath = `${userDataPath}-dev`;
    const env = createTestServerEnv({
      PARALLEL_CODE_TEST_SHELL_HOME: shellHomePath,
      PARALLEL_CODE_USER_DATA_DIR: userDataPath,
    });

    try {
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.mkdirSync(shellHomePath, { recursive: true });
      fs.writeFileSync(path.join(shellHomePath, 'keep.txt'), 'keep\n');
      fs.mkdirSync(developmentStatePath, { recursive: true });
      fs.writeFileSync(path.join(developmentStatePath, 'keep.json'), '{}');

      await cleanupTestServerEnv(env, {
        defaultUserDataPath: path.join(parentPath, 'different-default'),
      });

      expect(fs.readFileSync(path.join(shellHomePath, 'keep.txt'), 'utf8')).toBe('keep\n');
      expect(fs.existsSync(userDataPath)).toBe(true);
      expect(fs.existsSync(developmentStatePath)).toBe(true);
    } finally {
      fs.rmSync(parentPath, { force: true, recursive: true });
    }
  });

  it('cleans the canonical sandbox when server startup rejects', async () => {
    const parentPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-server-start-test-'));
    const userDataPath = path.join(parentPath, 'user-data');
    const shellHomePath = path.join(userDataPath, 'shell-home');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      fs.mkdirSync(shellHomePath, { recursive: true });
      fs.writeFileSync(path.join(shellHomePath, '.shell_history'), 'sandboxed\n');

      await expect(
        startServer({
          NODE_OPTIONS: '--parallel-code-invalid-node-option',
          PARALLEL_CODE_USER_DATA_DIR: userDataPath,
        }),
      ).rejects.toBeInstanceOf(Error);

      expect(fs.existsSync(shellHomePath)).toBe(false);
      expect(fs.existsSync(userDataPath)).toBe(true);
      await expect(stopServer()).resolves.toBeUndefined();
    } finally {
      await stopServer();
      warnSpy.mockRestore();
      fs.rmSync(parentPath, { force: true, recursive: true });
    }
  });
});

describe('waitForTestServerStartup', () => {
  it('detects the readiness line across stdout chunks', async () => {
    const proc = new FakeServerProcess();
    const ready = waitForTestServerStartup(proc as never, 100);

    proc.stdout.emit('data', Buffer.from('Parallel Code server list'));
    proc.stdout.emit('data', Buffer.from('ening on http://127.0.0.1:43117\n'));

    await expect(ready).resolves.toBeUndefined();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('ignores incidental readiness text and bounds retained startup output', async () => {
    const proc = new FakeServerProcess();
    const ready = waitForTestServerStartup(proc as never, 100);

    proc.stdout.emit('data', Buffer.alloc(32_768, 'x'));
    proc.stdout.emit('data', Buffer.from('\ndependency listening on a local socket\n'));
    await Promise.resolve();
    expect(proc.stdout.listenerCount('data')).toBe(1);

    proc.stdout.emit(
      'data',
      Buffer.from('\nParallel Code server listening on http://127.0.0.1:43117\n'),
    );
    await expect(ready).resolves.toBeUndefined();
  });

  it('rejects immediately on timeout and ignores late readiness output', async () => {
    vi.useFakeTimers();
    const proc = new FakeServerProcess();
    const ready = waitForTestServerStartup(proc as never, 5);
    const rejected = expect(ready).rejects.toThrow(
      'Standalone server did not report readiness within 5ms',
    );

    await vi.advanceTimersByTimeAsync(5);
    await rejected;
    proc.stdout.emit('data', Buffer.from('Parallel Code server listening on http://late\n'));
    await Promise.resolve();

    expect(proc.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('rejects immediately when readiness observation starts after the server exited', async () => {
    const proc = new FakeServerProcess();
    proc.exitCode = 1;

    await expect(waitForTestServerStartup(proc as never, 100)).rejects.toThrow(
      'Standalone server exited before readiness with code 1',
    );
    expect(proc.listenerCount('error')).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
  });
});

describe('stopTestServerProcess', () => {
  it('settles and removes listeners when signal delivery emits a process error', async () => {
    const proc = new FakeServerProcess();
    proc.kill.mockImplementationOnce(() => {
      proc.emit('error', new Error('signal delivery failed'));
      return true;
    });

    await expect(stopTestServerProcess(proc as never)).resolves.toBeUndefined();
    expect(proc.listenerCount('error')).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
  });
});
