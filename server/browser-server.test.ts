import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { WebSocket } from 'ws';

import { startBrowserServer } from './browser-server.js';
import { IPC } from '../electron/ipc/channels.js';
import type { TaskPortExposureCandidate } from '../src/domain/server-state.js';
import { saveAppStateForEnv } from '../electron/ipc/storage.js';
import { clearTaskPortRegistry } from '../electron/ipc/task-ports.js';

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate test port');
  }

  return address.port;
}

async function waitForBrowserIpcResult<T>(options: {
  body: unknown;
  channel: IPC;
  port: number;
  token: string;
}): Promise<T> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${options.port}/api/ipc/${options.channel}`, {
        body: JSON.stringify(options.body),
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        result?: T;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? `IPC ${options.channel} failed with ${response.status}`);
      }

      return payload.result as T;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for browser IPC channel ${options.channel}`);
}

async function waitForSocketMessage<T>(
  socket: WebSocket,
  predicate: (message: unknown) => message is T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for websocket message'));
    }, 5_000);

    function cleanup(): void {
      clearTimeout(timeout);
      socket.off('message', handleMessage);
      socket.off('error', handleError);
    }

    function handleError(error: Error): void {
      cleanup();
      reject(error);
    }

    function handleMessage(raw: unknown): void {
      const parsed = JSON.parse(String(raw)) as unknown;
      if (!predicate(parsed)) {
        return;
      }

      cleanup();
      resolve(parsed);
    }

    socket.on('message', handleMessage);
    socket.on('error', handleError);
  });
}

async function expectWebSocketUpgradeRejected(url: string, statusCode: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new Error(`Timed out waiting for websocket rejection from ${url}`));
    }, 5_000);

    function cleanup(): void {
      clearTimeout(timeout);
      socket.off('open', handleOpen);
      socket.off('error', handleError);
    }

    function handleOpen(): void {
      cleanup();
      socket.close();
      reject(new Error(`Expected websocket upgrade to ${url} to be rejected`));
    }

    function handleError(error: Error): void {
      cleanup();
      try {
        expect(error.message).toContain(`Unexpected server response: ${statusCode}`);
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    }

    socket.once('open', handleOpen);
    socket.once('error', handleError);
  });
}

describe('startBrowserServer', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    clearTaskPortRegistry();
    await Promise.all(
      tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
    vi.restoreAllMocks();
  });

  it('removes process handlers during repeated in-process start and cleanup cycles', async () => {
    const trackedEvents = ['uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM'] as const;
    const baselineListenerCounts = Object.fromEntries(
      trackedEvents.map((eventName) => [eventName, process.listenerCount(eventName)]),
    ) as Record<(typeof trackedEvents)[number], number>;

    for (let index = 0; index < 2; index += 1) {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-server-'));
      tempDirs.push(rootDir);

      const distDir = path.join(rootDir, 'dist');
      const distRemoteDir = path.join(rootDir, 'dist-remote');
      await Promise.all([
        mkdir(distDir, { recursive: true }),
        mkdir(distRemoteDir, { recursive: true }),
      ]);

      const controller = startBrowserServer({
        distDir,
        distRemoteDir,
        port: await getAvailablePort(),
        token: `browser-server-test-token-${index}`,
        userDataPath: path.join(rootDir, 'user-data'),
      });

      for (const eventName of trackedEvents) {
        expect(process.listenerCount(eventName)).toBe(baselineListenerCounts[eventName] + 1);
      }

      controller.cleanup();

      for (const eventName of trackedEvents) {
        expect(process.listenerCount(eventName)).toBe(baselineListenerCounts[eventName]);
      }
    }
  });

  it('serves the latency diagnostics lab through token bootstrap before static fallback', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-server-'));
    tempDirs.push(rootDir);

    const distDir = path.join(rootDir, 'dist');
    const distRemoteDir = path.join(rootDir, 'dist-remote');
    await Promise.all([
      mkdir(distDir, { recursive: true }),
      mkdir(distRemoteDir, { recursive: true }),
    ]);

    const token = 'browser-server-test-token-latency-lab';
    const port = await getAvailablePort();
    const controller = startBrowserServer({
      distDir,
      distRemoteDir,
      port,
      token,
      userDataPath: path.join(rootDir, 'user-data'),
    });

    try {
      const bootstrapResponse = await fetch(
        `http://127.0.0.1:${port}/latency?token=${token}&autorun=1`,
        { redirect: 'manual' },
      );

      expect(bootstrapResponse.status).toBe(302);
      expect(bootstrapResponse.headers.get('location')).toBe('/latency?autorun=1');
      const cookie = bootstrapResponse.headers.get('set-cookie');
      expect(cookie).toContain('parallel_code_session=');

      const labResponse = await fetch(`http://127.0.0.1:${port}/latency?autorun=1`, {
        headers: cookie ? { cookie } : {},
      });
      const labHtml = await labResponse.text();

      expect(labResponse.status).toBe(200);
      expect(labHtml).toContain('Parallel Code Latency Lab');
      expect(labHtml).toContain('/api/diagnostics/latency-ping');

      const pingResponse = await fetch(
        `http://127.0.0.1:${port}/api/diagnostics/latency-ping?nonce=integration`,
        {
          headers: cookie ? { cookie } : {},
        },
      );
      const pingPayload = (await pingResponse.json()) as { kind?: string; nonce?: string };

      expect(pingResponse.status).toBe(200);
      expect(pingPayload).toMatchObject({
        kind: 'latency-pong',
        nonce: 'integration',
      });
    } finally {
      controller.cleanup();
    }
  });

  it('replays restored task-port snapshots with backend ordering versions', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-server-'));
    tempDirs.push(rootDir);

    const distDir = path.join(rootDir, 'dist');
    const distRemoteDir = path.join(rootDir, 'dist-remote');
    const userDataPath = path.join(rootDir, 'user-data');
    await Promise.all([
      mkdir(distDir, { recursive: true }),
      mkdir(distRemoteDir, { recursive: true }),
    ]);
    saveAppStateForEnv(
      { isPackaged: false, userDataPath },
      JSON.stringify({
        projects: [],
        taskOrder: ['task-1'],
        tasks: {
          'task-1': {
            exposedPorts: [{ port: 3000 }],
            id: 'task-1',
            worktreePath: rootDir,
          },
        },
      }),
    );

    const token = 'browser-server-test-token-restored-task-ports';
    const port = await getAvailablePort();
    const controller = startBrowserServer({
      distDir,
      distRemoteDir,
      port,
      token,
      userDataPath,
    });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });

      const taskPortsMessage = waitForSocketMessage(
        socket,
        (
          message,
        ): message is {
          kind: 'snapshot';
          stateVersion: number;
          taskId: string;
          type: 'task-ports-changed';
        } =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'task-ports-changed' &&
          'kind' in message &&
          message.kind === 'snapshot',
      );

      socket.send(
        JSON.stringify({
          clientId: 'client-restored-task-ports',
          lastSeq: -1,
          token,
          type: 'auth',
        }),
      );

      await expect(taskPortsMessage).resolves.toMatchObject({
        kind: 'snapshot',
        stateVersion: expect.any(Number),
        taskId: 'task-1',
        type: 'task-ports-changed',
      });
    } finally {
      socket.close();
      controller.cleanup();
    }
  });

  it('closes authenticated websocket clients during cleanup without stranding shutdown', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-server-'));
    tempDirs.push(rootDir);

    const distDir = path.join(rootDir, 'dist');
    const distRemoteDir = path.join(rootDir, 'dist-remote');
    await Promise.all([
      mkdir(distDir, { recursive: true }),
      mkdir(distRemoteDir, { recursive: true }),
    ]);

    const token = 'browser-server-test-token-live-client';
    const port = await getAvailablePort();
    const controller = startBrowserServer({
      distDir,
      distRemoteDir,
      port,
      token,
      userDataPath: path.join(rootDir, 'user-data'),
    });

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    socket.send(
      JSON.stringify({
        clientId: 'client-live',
        type: 'auth',
        token,
      }),
    );

    const closePromise = new Promise<void>((resolve, reject) => {
      socket.once('close', () => resolve());
      socket.once('error', reject);
    });

    controller.cleanup();

    await closePromise;
  });

  it('rejects unknown websocket upgrade paths without stranding clients', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-server-'));
    tempDirs.push(rootDir);

    const distDir = path.join(rootDir, 'dist');
    const distRemoteDir = path.join(rootDir, 'dist-remote');
    await Promise.all([
      mkdir(distDir, { recursive: true }),
      mkdir(distRemoteDir, { recursive: true }),
    ]);

    const port = await getAvailablePort();
    const controller = startBrowserServer({
      distDir,
      distRemoteDir,
      port,
      token: 'browser-server-test-token-unknown-upgrade',
      userDataPath: path.join(rootDir, 'user-data'),
    });

    try {
      await expectWebSocketUpgradeRejected(`ws://127.0.0.1:${port}/unknown`, 404);
    } finally {
      controller.cleanup();
    }
  });

  it('registers the preview port-scan IPC channel in browser mode', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-server-'));
    tempDirs.push(rootDir);

    const distDir = path.join(rootDir, 'dist');
    const distRemoteDir = path.join(rootDir, 'dist-remote');
    await Promise.all([
      mkdir(distDir, { recursive: true }),
      mkdir(distRemoteDir, { recursive: true }),
    ]);

    const token = 'browser-server-test-token-port-scan';
    const port = await getAvailablePort();
    const controller = startBrowserServer({
      distDir,
      distRemoteDir,
      port,
      token,
      userDataPath: path.join(rootDir, 'user-data'),
    });

    try {
      const candidates = await waitForBrowserIpcResult<TaskPortExposureCandidate[]>({
        body: {
          taskId: 'task-port-scan',
          worktreePath: rootDir,
        },
        channel: IPC.GetTaskPortExposureCandidates,
        port,
        token,
      });

      expect(Array.isArray(candidates)).toBe(true);
    } finally {
      controller.cleanup();
    }
  });
});
