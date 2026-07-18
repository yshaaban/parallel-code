import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { WebSocket } from 'ws';

import { runIndependentCleanups } from '../scripts/lib/cleanup-outcome.mjs';
import {
  __browserServerTestExports,
  BrowserRuntimeCleanupError,
  startBrowserServer,
} from './browser-server.js';
import { IPC } from '../electron/ipc/channels.js';
import type { TaskPortExposureCandidate } from '../src/domain/server-state.js';
import { saveAppStateForEnv } from '../electron/ipc/storage.js';
import { clearTaskPortRegistry } from '../electron/ipc/task-ports.js';
import { resetCoordinatorRuntimeForTests } from '../electron/coordinator/runtime.js';
import { resetCoordinatorServiceForTests } from '../electron/coordinator/service.js';
import { resetCoordinatorToolGatewayForTests } from '../electron/coordinator/tool-gateway.js';
import type {
  CoordinatorCreateRunResult,
  CoordinatorDiagnosticsSnapshot,
  CoordinatorToolCallResult,
} from '../src/domain/coordinator.js';
import {
  CoordinatorRuntimeCleanupError,
  CoordinatorRuntimeInitializationError,
  __coordinatorRuntimeLoaderTestExports,
} from './coordinator-runtime-loader.js';

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

async function stopBrowserServer(controller: ReturnType<typeof startBrowserServer>): Promise<void> {
  controller.cleanup();
  await controller.whenCoordinatorRuntimeStopped();
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

describe('browser runtime cleanup observation', () => {
  it('observes an immediate cleanup rejection while retaining the original promise', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cleanup = Promise.reject(new Error('cleanup failed immediately'));

    const retained = __browserServerTestExports.retainObservedRuntimeCleanup(
      cleanup,
      'coordinator',
    );

    expect(retained).toBe(cleanup);
    await expect(retained).rejects.toThrow('cleanup failed immediately');
    await Promise.resolve();
    expect(warning).toHaveBeenCalledWith(
      'Browser server coordinator cleanup failed:',
      expect.objectContaining({ message: 'cleanup failed immediately' }),
    );
    warning.mockRestore();
  });

  it('waits for every runtime owner before rejecting with all cleanup failures', async () => {
    let rejectCoordinator: (error: unknown) => void = () => {};
    let rejectAgentRunner: (error: unknown) => void = () => {};
    let rejectAskAboutCode: (error: unknown) => void = () => {};
    const coordinatorError = new Error('coordinator cleanup failed');
    const agentRunnerError = new Error('agent runner cleanup failed');
    const askAboutCodeError = new Error('ask-about-code cleanup failed');
    const coordinatorCleanup = new Promise<void>((_resolve, reject) => {
      rejectCoordinator = reject;
    });
    const agentRunnerCleanup = new Promise<void>((_resolve, reject) => {
      rejectAgentRunner = reject;
    });
    const askAboutCodeCleanup = new Promise<void>((_resolve, reject) => {
      rejectAskAboutCode = reject;
    });
    const cleanup = __browserServerTestExports.settleBrowserRuntimeCleanupOwners([
      { cleanup: coordinatorCleanup, label: 'coordinator' },
      { cleanup: agentRunnerCleanup, label: 'agent runner' },
      { cleanup: askAboutCodeCleanup, label: 'ask about code' },
    ]);
    let cleanupSettled = false;
    void cleanup.then(
      () => {
        cleanupSettled = true;
      },
      () => {
        cleanupSettled = true;
      },
    );

    rejectCoordinator(coordinatorError);
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    rejectAgentRunner(agentRunnerError);
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    rejectAskAboutCode(askAboutCodeError);
    const error = await cleanup.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrowserRuntimeCleanupError);
    expect((error as BrowserRuntimeCleanupError).failures).toEqual([
      { error: coordinatorError, label: 'coordinator' },
      { error: agentRunnerError, label: 'agent runner' },
      { error: askAboutCodeError, label: 'ask about code' },
    ]);
    expect(cleanupSettled).toBe(true);
  });

  it('uses a nonzero process exit when settled runtime cleanup rejects', async () => {
    const exit = vi.fn<(code: number) => void>();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cleanupError = new BrowserRuntimeCleanupError([
      { error: new Error('disk full'), label: 'coordinator' },
    ]);

    await __browserServerTestExports.exitAfterBrowserRuntimeCleanup(
      Promise.reject(cleanupError),
      exit,
    );

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorLog).toHaveBeenCalledWith('Browser server shutdown cleanup failed:', cleanupError);
    errorLog.mockRestore();
  });

  it('exits nonzero when coordinator initialization rollback leaves ownership unreleased', async () => {
    const initializationError = new Error('coordinator subscription failed');
    const rollbackError = new Error('coordinator producer rollback failed');
    const loader = __coordinatorRuntimeLoaderTestExports.startSerializedCoordinatorRuntimeLoad(() =>
      __coordinatorRuntimeLoaderTestExports.initializeCoordinatorRuntimeOwners({
        emitRepairEvents: () => {},
        ensureServiceLoaded: () => {},
        startMutationProducers: () => () => {
          throw rollbackError;
        },
        startPersistence: () => () => {},
        subscribeEventConsumers: () => {
          throw initializationError;
        },
      }),
    );
    const exit = vi.fn<(code: number) => void>();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const initializationFailure = await loader.ready.catch((error: unknown) => error);
      expect(initializationFailure).toBeInstanceOf(CoordinatorRuntimeInitializationError);
      expect(
        (initializationFailure as CoordinatorRuntimeInitializationError).cleanupError,
      ).toBeInstanceOf(CoordinatorRuntimeCleanupError);

      const cleanup = __browserServerTestExports.settleBrowserRuntimeCleanupOwners([
        { cleanup: loader.cleanup(), label: 'coordinator' },
        { cleanup: Promise.resolve(), label: 'agent runner' },
        { cleanup: Promise.resolve(), label: 'ask about code' },
      ]);
      await __browserServerTestExports.exitAfterBrowserRuntimeCleanup(cleanup, exit);

      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(1);
      const shutdownFailure = errorLog.mock.calls[0]?.[1];
      expect(shutdownFailure).toBeInstanceOf(BrowserRuntimeCleanupError);
      expect((shutdownFailure as BrowserRuntimeCleanupError).failures).toEqual([
        { error: initializationFailure, label: 'coordinator' },
      ]);
    } finally {
      __coordinatorRuntimeLoaderTestExports.resetSerializedCoordinatorRuntimeForTests();
      errorLog.mockRestore();
    }
  });

  it('uses a zero process exit only after successful runtime cleanup', async () => {
    const exit = vi.fn<(code: number) => void>();

    await __browserServerTestExports.exitAfterBrowserRuntimeCleanup(Promise.resolve(), exit);

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('startBrowserServer', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    clearTaskPortRegistry();
    resetCoordinatorToolGatewayForTests();
    await resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    try {
      await runIndependentCleanups(
        'Browser server test temporary directories',
        tempDirs
          .splice(0)
          .map(
            (directory, index) =>
              [
                `remove browser server temporary directory ${index + 1}`,
                () => rm(directory, { force: true, recursive: true }),
              ] as const,
          ),
      );
    } finally {
      vi.restoreAllMocks();
    }
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

      await stopBrowserServer(controller);

      for (const eventName of trackedEvents) {
        expect(process.listenerCount(eventName)).toBe(baselineListenerCounts[eventName]);
      }
    }
  });

  it('becomes coordinator-ready after cleanup followed by an immediate in-process restart', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-server-'));
    tempDirs.push(rootDir);

    const distDir = path.join(rootDir, 'dist');
    const distRemoteDir = path.join(rootDir, 'dist-remote');
    const userDataPath = path.join(rootDir, 'user-data');
    await Promise.all([
      mkdir(distDir, { recursive: true }),
      mkdir(distRemoteDir, { recursive: true }),
    ]);

    const firstPort = await getAvailablePort();
    const replacementPort = await getAvailablePort();
    const firstToken = 'browser-server-restart-token-first';
    const first = startBrowserServer({
      distDir,
      distRemoteDir,
      port: firstPort,
      registerProcessHandlers: false,
      token: firstToken,
      userDataPath,
    });
    let replacement: ReturnType<typeof startBrowserServer> | null = null;

    try {
      await waitForBrowserIpcResult<CoordinatorDiagnosticsSnapshot>({
        body: undefined,
        channel: IPC.CoordinatorGetDiagnostics,
        port: firstPort,
        token: firstToken,
      });

      first.cleanup();
      const firstStopped = first.whenCoordinatorRuntimeStopped();
      const replacementToken = 'browser-server-restart-token-replacement';
      replacement = startBrowserServer({
        distDir,
        distRemoteDir,
        port: replacementPort,
        registerProcessHandlers: false,
        token: replacementToken,
        userDataPath,
      });

      await waitForBrowserIpcResult<CoordinatorDiagnosticsSnapshot>({
        body: undefined,
        channel: IPC.CoordinatorGetDiagnostics,
        port: replacementPort,
        token: replacementToken,
      });
      await firstStopped;

      const diagnosticsAfterPriorCleanup =
        await waitForBrowserIpcResult<CoordinatorDiagnosticsSnapshot>({
          body: undefined,
          channel: IPC.CoordinatorGetDiagnostics,
          port: replacementPort,
          token: replacementToken,
        });
      expect(diagnosticsAfterPriorCleanup.persistence).toEqual(
        expect.objectContaining({ degraded: false }),
      );
    } finally {
      await stopBrowserServer(first);
      if (replacement) {
        await stopBrowserServer(replacement);
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
      await stopBrowserServer(controller);
    }
  });

  it('routes coordinator tool calls through per-run credentials instead of browser auth', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-server-'));
    tempDirs.push(rootDir);

    const distDir = path.join(rootDir, 'dist');
    const distRemoteDir = path.join(rootDir, 'dist-remote');
    await Promise.all([
      mkdir(distDir, { recursive: true }),
      mkdir(distRemoteDir, { recursive: true }),
    ]);

    const token = 'browser-server-test-token-coordinator';
    const port = await getAvailablePort();
    const controller = startBrowserServer({
      distDir,
      distRemoteDir,
      port,
      token,
      userDataPath: path.join(rootDir, 'user-data'),
    });

    try {
      const createdRun = await waitForBrowserIpcResult<CoordinatorCreateRunResult>({
        body: {
          coordinatorAgentId: 'agent-coordinator',
          coordinatorTaskId: 'task-coordinator',
          projectId: 'project-1',
          projectMode: 'git',
          projectRoot: rootDir,
        },
        channel: IPC.CoordinatorCreateRun,
        port,
        token,
      });
      const credential = JSON.parse(await readFile(createdRun.credentialPath, 'utf8')) as {
        token: string;
      };

      const browserTokenResponse = await fetch(
        `http://127.0.0.1:${port}/api/coordinator/tool-call`,
        {
          body: JSON.stringify({
            callId: 'call-browser-token',
            runId: createdRun.run.id,
            taskId: 'task-coordinator',
            token,
            toolName: 'get_task_status',
          }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      const browserTokenBody = (await browserTokenResponse.json()) as { error?: string };
      expect(browserTokenResponse.status).toBe(400);
      expect(browserTokenBody.error).toBe('Invalid coordinator tool token');

      const toolResponse = await fetch(`http://127.0.0.1:${port}/api/coordinator/tool-call`, {
        body: JSON.stringify({
          callId: 'call-1',
          runId: createdRun.run.id,
          taskId: 'task-coordinator',
          token: credential.token,
          toolName: 'get_task_status',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const toolBody = (await toolResponse.json()) as { result?: CoordinatorToolCallResult };

      expect(toolResponse.status).toBe(200);
      expect(toolBody.result).toMatchObject({
        accepted: true,
        callId: 'call-1',
        result: {
          coordinatorTaskId: 'task-coordinator',
          id: createdRun.run.id,
        },
      });
    } finally {
      await stopBrowserServer(controller);
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
      await stopBrowserServer(controller);
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

    await stopBrowserServer(controller);

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
      await stopBrowserServer(controller);
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
      await stopBrowserServer(controller);
    }
  });
});
