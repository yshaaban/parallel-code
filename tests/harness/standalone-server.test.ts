import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from '../../electron/ipc/runtime-diagnostics.js';
import { killAllAgents, spawnAgent, writeToAgent } from '../../electron/ipc/pty.js';
import { IPC } from '../../electron/ipc/channels.js';
import {
  acquireTaskCommandLease,
  resetTaskCommandLeasesForTest,
} from '../../electron/ipc/task-command-leases.js';
import { startBrowserServer } from '../../server/browser-server.js';
import { createInteractiveNodeScenario } from '../browser/harness/scenarios.js';
import {
  parseStandaloneServerReadyOutput,
  startStandaloneBrowserServer,
} from '../browser/harness/standalone-server.js';

function listenOnPort(port: number): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function occupyPortIfAvailable(port: number): Promise<Server | null> {
  try {
    return await listenOnPort(port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      return null;
    }

    throw error;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function getAvailablePort(): Promise<number> {
  const server = await listenOnPort(0);
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : 0;
  await closeServer(server);
  if (!port) {
    throw new Error('Failed to reserve an ephemeral port');
  }

  return port;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function invokeIpcViaHttp<T>(
  baseUrl: string,
  authToken: string,
  channel: IPC,
  body: unknown,
): Promise<T> {
  const response = await fetch(`${baseUrl}/api/ipc/${channel}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  expect(response.ok).toBe(true);
  const payload = (await response.json()) as { result: T };
  return payload.result;
}

async function waitForBrowserServerIpc(baseUrl: string, authToken: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      await invokeIpcViaHttp(baseUrl, authToken, IPC.LoadAppState, {});
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Timed out waiting for the browser server IPC endpoint');
}

async function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const handleOpen = (): void => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off('open', handleOpen);
      socket.off('error', handleError);
    };

    socket.on('open', handleOpen);
    socket.on('error', handleError);
  });
}

async function waitForCondition(
  check: () => boolean,
  timeoutMs: number,
  failureMessage: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  throw new Error(failureMessage);
}

describe('browser-lab standalone server startup', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    resetBackendRuntimeDiagnostics();
    resetTaskCommandLeasesForTest();
    killAllAgents();

    while (cleanup.length > 0) {
      const dispose = cleanup.pop();
      if (!dispose) {
        continue;
      }

      await dispose();
    }
  });

  it('starts on an ephemeral port even when 3000 is already occupied', async () => {
    const blocker = await occupyPortIfAvailable(3000);
    if (blocker) {
      cleanup.push(() => closeServer(blocker));
    }

    const server = await startStandaloneBrowserServer({
      scenario: createInteractiveNodeScenario(),
      testSlug: 'ephemeral-port-startup',
      validateBrowserBuildArtifacts: false,
    });
    cleanup.push(() => server.stop());

    expect(server.port).not.toBe(3000);
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });

  it('accepts authenticated browser IPC requests after startup', async () => {
    const server = await startStandaloneBrowserServer({
      scenario: createInteractiveNodeScenario(),
      testSlug: 'auth-ipc-startup',
      validateBrowserBuildArtifacts: false,
    });
    cleanup.push(() => server.stop());

    const response = await fetch(`${server.baseUrl}/api/ipc/${IPC.LoadAppState}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${server.authToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as {
      result: string | null;
    };
    const savedState = JSON.parse(payload.result ?? 'null') as {
      tasks?: Record<string, { branchName?: string }>;
    };
    expect(savedState.tasks?.[server.taskId]?.branchName).toBe('main');
  });

  it('parses readiness output after stdout chunks are reassembled', () => {
    const output =
      'Booting browser server\nParallel Code server li' +
      'stening on http://127.0.0.1:43123?token=test-token\n';

    expect(parseStandaloneServerReadyOutput(output)).toEqual({
      baseUrl: 'http://127.0.0.1:43123',
      port: 43123,
    });
  });

  it('ignores incomplete readiness output until the full line is available', () => {
    expect(
      parseStandaloneServerReadyOutput('Parallel Code server listening on http://127.0.0.1:'),
    ).toBeNull();
  });

  it('rejects malformed readiness lines that omit the explicit bound port', () => {
    expect(() =>
      parseStandaloneServerReadyOutput('Parallel Code server listening on http://127.0.0.1:\n'),
    ).toThrow('Failed to parse standalone browser server port');
  });

  it('cleans the test directory when setup fails before the server starts', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-lab-failure-'));
    cleanup.push(() => rm(rootDir, { recursive: true, force: true }));
    const expectedTestDir = path.join(rootDir, 'seed-failure-cleanup');

    await expect(
      startStandaloneBrowserServer({
        rootDir,
        scenario: {
          ...createInteractiveNodeScenario(),
          seedRepo() {
            throw new Error('seed failed');
          },
        },
        testSlug: 'seed-failure-cleanup',
        validateBrowserBuildArtifacts: false,
      }),
    ).rejects.toThrow('seed failed');

    expect(await pathExists(expectedTestDir)).toBe(false);
  });

  it('keeps disconnect trace finalization alive during server shutdown cleanup', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-server-shutdown-'));
    cleanup.push(() => rm(rootDir, { recursive: true, force: true }));

    const distDir = path.join(rootDir, 'dist');
    const distRemoteDir = path.join(rootDir, 'dist-remote');
    const port = await getAvailablePort();
    const token = 'shutdown-trace-token';
    const baseUrl = `http://127.0.0.1:${port}`;
    const userDataPath = path.join(rootDir, 'user-data');
    const taskId = 'task-shutdown-trace';
    const agentId = 'agent-shutdown-trace';
    const clientId = 'client-shutdown-trace';
    const requestId = 'request-shutdown-trace';
    await mkdir(distDir, { recursive: true });
    await mkdir(distRemoteDir, { recursive: true });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as typeof process.exit);
    cleanup.push(async () => {
      exitSpy.mockRestore();
    });

    const controller = startBrowserServer({
      distDir,
      distRemoteDir,
      port,
      registerProcessHandlers: false,
      token,
      userDataPath,
    });
    cleanup.push(async () => {
      controller.cleanup();
    });

    await waitForBrowserServerIpc(baseUrl, token);

    spawnAgent(() => {}, {
      agentId,
      args: [],
      cols: 80,
      command: process.execPath,
      cwd: rootDir,
      env: {},
      onOutput: { __CHANNEL_ID__: 'shutdown-trace-channel' },
      rows: 24,
      taskId,
    });

    acquireTaskCommandLease(taskId, clientId, 'shutdown-trace-owner', 'terminal-input');

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}&lastSeq=-1`,
    );
    cleanup.push(async () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    });

    await waitForWebSocketOpen(socket);
    socket.send(
      JSON.stringify({
        clientId,
        lastSeq: -1,
        token,
        type: 'auth',
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    resetBackendRuntimeDiagnostics();

    const traceStartedAtMs = Date.now() - 2;
    writeToAgent(agentId, '1+1\n', {
      clientId,
      requestId,
      taskId,
      trace: {
        bufferedAtMs: traceStartedAtMs,
        inputChars: 4,
        inputKind: 'interactive',
        sendStartedAtMs: traceStartedAtMs + 1,
        startedAtMs: traceStartedAtMs,
      },
    });

    const socketClosed = once(socket, 'close');
    controller.shutdown();
    await socketClosed;
    await waitForCondition(
      () => getBackendRuntimeDiagnosticsSnapshot().terminalInputTracing.activeTraceCount === 0,
      2_000,
      'Timed out waiting for terminal input trace shutdown finalization',
    );

    const diagnostics = getBackendRuntimeDiagnosticsSnapshot();
    expect(diagnostics.terminalInputTracing.activeTraceCount).toBe(0);
    expect(diagnostics.terminalInputTracing.completedTraces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clientId,
          completed: false,
          failureReason: 'client-disconnected',
          requestId,
          taskId,
        }),
      ]),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
