import { createServer } from 'node:http';
import { request as requestHttps } from 'node:https';
import { execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';

import { runIndependentCleanups } from '../scripts/lib/cleanup-outcome.mjs';
import {
  __browserServerTestExports,
  BrowserRuntimeCleanupError,
  startBrowserServer,
} from './browser-server.js';
import { IPC } from '../electron/ipc/channels.js';
import type { CreateTaskResult } from '../src/ipc/types.js';
import type { TaskPortExposureCandidate } from '../src/domain/server-state.js';
import type { ServerStateBootstrapSnapshot } from '../src/domain/server-state-bootstrap.js';
import { isRecord } from '../src/lib/type-guards.js';
import {
  getStateDirForEnv,
  saveAppStateForEnv,
  saveWorkspaceStateForEnv,
} from '../electron/ipc/storage.js';
import { clearTaskPortRegistry } from '../electron/ipc/task-ports.js';
import { clearTaskWorkflowWorktreeRegistryForTests } from '../electron/ipc/task-workflows.js';
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

function execFileAsync(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr, stdout }));
        return;
      }
      resolve({ stderr, stdout });
    });
  });
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

interface TestHttpsResponse {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  status: number;
}

function sendTestHttpsRequest(options: {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
  path: string;
  port: number;
}): Promise<TestHttpsResponse> {
  return new Promise((resolve, reject) => {
    const request = requestHttps(
      {
        headers: options.headers,
        host: '127.0.0.1',
        method: options.method ?? 'GET',
        path: options.path,
        port: options.port,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

async function waitForTestHttpsResponse(
  options: Parameters<typeof sendTestHttpsRequest>[0],
): Promise<TestHttpsResponse> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await sendTestHttpsRequest(options);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Timed out waiting for HTTPS server');
}

async function createTestTlsPair(directory: string): Promise<{ cert: Buffer; key: Buffer }> {
  const certificatePath = path.join(directory, 'test-certificate.pem');
  const keyPath = path.join(directory, 'test-key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'ignore' },
  );
  const [cert, key] = await Promise.all([readFile(certificatePath), readFile(keyPath)]);
  return { cert, key };
}

function getLoopbackInterfaceName(): string {
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (addresses?.some((address) => address.address === '127.0.0.1')) return name;
  }
  throw new Error('No IPv4 loopback interface is available');
}

function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
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

  it.each([
    { token: 'parallel-code-local-browser' },
    { token: 'private-test-token', host: 'example.invalid' },
  ])(
    'rejects unsafe listener configuration before acquiring runtime state: %j',
    async (configuration) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-listener-admission-'));
      tempDirs.push(rootDir);
      expect(() =>
        startBrowserServer({
          ...configuration,
          distDir: path.join(rootDir, 'dist'),
          distRemoteDir: path.join(rootDir, 'remote'),
          port: 0,
          userDataPath: rootDir,
        }),
      ).toThrow();
      expect(await readdir(rootDir)).toEqual([]);
    },
  );

  afterEach(async () => {
    clearTaskPortRegistry();
    clearTaskWorkflowWorktreeRegistryForTests();
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

  it('opens the standalone IPC surface only after the exact task-experience owner is active', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-reliability-'));
    tempDirs.push(rootDir);
    const distDir = path.join(rootDir, 'dist');
    const distRemoteDir = path.join(rootDir, 'dist-remote');
    await Promise.all([
      mkdir(distDir, { recursive: true }),
      mkdir(distRemoteDir, { recursive: true }),
    ]);
    const port = await getAvailablePort();
    const token = 'browser-task-experience-token';
    const controller = startBrowserServer({
      distDir,
      distRemoteDir,
      port,
      registerProcessHandlers: false,
      token,
      userDataPath: path.join(rootDir, 'user-data'),
    });

    try {
      await controller.whenReady();
      await expect(
        waitForBrowserIpcResult({
          body: {},
          channel: IPC.GetTaskReliabilityCapabilities,
          port,
          token,
        }),
      ).resolves.toMatchObject({
        agentSessions: { initialLaunch: true, manualReplacement: true },
        initialPromptDelivery: { enabled: true },
        kind: 'active',
      });
    } finally {
      await stopBrowserServer(controller);
    }
  });

  it('routes ordinary standalone CreateTask through the activated managed owner', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-create-task-'));
    tempDirs.push(rootDir);
    const distDir = path.join(rootDir, 'dist');
    const distRemoteDir = path.join(rootDir, 'dist-remote');
    const projectRoot = path.join(rootDir, 'project');
    const userDataPath = path.join(rootDir, 'user-data');
    await Promise.all([
      mkdir(distDir, { recursive: true }),
      mkdir(distRemoteDir, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
    ]);
    saveAppStateForEnv(
      { isPackaged: false, userDataPath },
      JSON.stringify({
        collapsedTaskOrder: [],
        projects: [
          {
            id: 'project-1',
            name: 'Standalone project',
            path: projectRoot,
            projectMode: 'non-git',
          },
        ],
        taskOrder: [],
        tasks: {},
      }),
    );
    const port = await getAvailablePort();
    const token = 'browser-managed-create-token';
    const controller = startBrowserServer({
      distDir,
      distRemoteDir,
      port,
      registerProcessHandlers: false,
      token,
      userDataPath,
    });
    const request = {
      name: 'Managed terminal task',
      operationId: 'browser-create-terminal-1',
      projectId: 'project-1',
      projectMode: 'non-git' as const,
      projectRoot,
      symlinkDirs: [],
    };

    try {
      await controller.whenReady();
      const created = await waitForBrowserIpcResult<CreateTaskResult>({
        body: request,
        channel: IPC.CreateTask,
        port,
        token,
      });
      const replayed = await waitForBrowserIpcResult<CreateTaskResult>({
        body: request,
        channel: IPC.CreateTask,
        port,
        token,
      });

      expect(replayed).toEqual(created);
      expect(created).toMatchObject({
        branch_name: '',
        creation_phase: 'active',
        creation_writer_epoch: 'managed-initial-shell-v1',
        project_mode: 'non-git',
        worktree_path: projectRoot,
        task_creation_operation_link: {
          creationOperationId: created.creation_operation_id,
          kind: 'creation-v1',
          launchOperationId: created.launch_operation_id,
        },
        task_creation_provenance: {
          creationWriterEpoch: 'managed-initial-shell-v1',
        },
        task_initial_shell_ownership: {
          kind: 'managed-terminal-v1',
          sessionId: created.session_id,
        },
      });
      expect(created.id).toMatch(/^[A-Za-z0-9._:@-]+$/u);
      expect(created.creation_operation_id).toMatch(/^[A-Za-z0-9_-]{22}$/u);
      expect(created.creation_operation_id).not.toBe(request.operationId);
      expect(created.launch_operation_id).toMatch(/^[A-Za-z0-9._:@/-]+$/u);
      expect(created.session_id).toMatch(/^shell:/u);

      const workspace = await waitForBrowserIpcResult<{ json: string | null; revision: number }>({
        body: {},
        channel: IPC.LoadWorkspaceState,
        port,
        token,
      });
      const shared = JSON.parse(workspace.json ?? '{}') as {
        taskOrder?: string[];
        tasks?: Record<string, Record<string, unknown>>;
      };
      expect(shared.taskOrder).toEqual([created.id]);
      expect(shared.tasks?.[created.id]).toMatchObject({
        id: created.id,
        shellAgentIds: [created.session_id],
        taskCreationOperationLink: created.task_creation_operation_link,
        taskInitialShellOwnership: created.task_initial_shell_ownership,
        taskMode: 'terminal',
      });
    } finally {
      await stopBrowserServer(controller);
    }
  });

  it('keeps ordinary CreateTask unreachable when production activation fails', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-dark-create-'));
    tempDirs.push(rootDir);
    const distDir = path.join(rootDir, 'dist');
    const distRemoteDir = path.join(rootDir, 'dist-remote');
    const projectRoot = path.join(rootDir, 'project');
    const userDataPath = path.join(rootDir, 'user-data');
    await Promise.all([
      mkdir(distDir, { recursive: true }),
      mkdir(distRemoteDir, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
    ]);
    await writeFile(path.join(projectRoot, 'untouched.txt'), 'unchanged');
    const storageEnv = { isPackaged: false, userDataPath } as const;
    saveWorkspaceStateForEnv(
      storageEnv,
      JSON.stringify({
        collapsedTaskOrder: [],
        projects: 'corrupt',
        taskOrder: [],
        tasks: {},
      }),
      1,
    );
    await writeFile(path.join(getStateDirForEnv(storageEnv), 'workspace-state.json'), '{');
    const port = await getAvailablePort();
    const activationError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = startBrowserServer({
      distDir,
      distRemoteDir,
      port,
      registerProcessHandlers: false,
      token: 'browser-dark-create-token',
      userDataPath,
    });

    try {
      await expect(controller.whenReady()).rejects.toThrow();
      await expect(
        fetch(`http://127.0.0.1:${port}/api/ipc/${IPC.CreateTask}`, {
          body: JSON.stringify({
            name: 'Must not exist',
            operationId: 'dark-create-1',
            projectId: 'project-1',
            projectMode: 'non-git',
            projectRoot,
            symlinkDirs: [],
          }),
          headers: {
            Authorization: 'Bearer browser-dark-create-token',
            'Content-Type': 'application/json',
          },
          method: 'POST',
        }),
      ).rejects.toThrow();
      await vi.waitFor(() => {
        expect(activationError).toHaveBeenCalledWith(
          '[server] Task-experience activation failed:',
          expect.anything(),
        );
      });
      await expect(controller.whenCoordinatorRuntimeStopped()).rejects.toThrow();
      await expect(readFile(path.join(projectRoot, 'untouched.txt'), 'utf8')).resolves.toBe(
        'unchanged',
      );
    } finally {
      controller.cleanup();
    }
  });

  it('prints distinct full-browser and scoped-remote bootstrap URLs for secure mode', () => {
    const messages = __browserServerTestExports.getBrowserServerStartupMessages(
      {
        port: 43117,
        tailscaleUrl: null,
        token: 'scoped-token',
        url: 'https://127.0.0.1:43117/remote/auth/bootstrap?token=scoped-token&next=%2Fremote%2F',
        wifiUrl: null,
      },
      'browser-token',
      true,
    );

    expect(messages).toHaveLength(2);
    const adminUrl = new URL(messages[0]?.replace('Parallel Code browser admin: ', '') ?? '');
    expect(adminUrl.pathname).toBe('/auth/bootstrap');
    expect(adminUrl.searchParams.get('token')).toBe('browser-token');
    expect(adminUrl.searchParams.get('next')).toBe('/');
    const remoteUrl = new URL(messages[1]?.replace('Parallel Code remote: ', '') ?? '');
    expect(remoteUrl.pathname).toBe('/remote/auth/bootstrap');
    expect(remoteUrl.searchParams.get('token')).toBe('scoped-token');
    expect(remoteUrl.searchParams.get('next')).toBe('/remote/');
  });

  it('keeps standalone scoped auth, catalog commands, sockets, and generic IPC authority separated', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-scoped-server-'));
    tempDirs.push(rootDir);
    const distDir = path.join(rootDir, 'dist');
    const distRemoteDir = path.join(rootDir, 'dist-remote');
    await Promise.all([
      mkdir(distDir, { recursive: true }),
      mkdir(distRemoteDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(distDir, 'index.html'), '<html>desktop shell</html>', 'utf8'),
      writeFile(path.join(distRemoteDir, 'index.html'), '<html>remote shell</html>', 'utf8'),
    ]);
    const tls = await createTestTlsPair(rootDir);
    const browserToken = 'standalone-full-browser-secret';
    const scopedToken = 'standalone-scoped-bootstrap-secret';
    const port = await getAvailablePort();
    const origin = `https://127.0.0.1:${port}`;
    const controller = startBrowserServer({
      distDir,
      distRemoteDir,
      port,
      registerProcessHandlers: false,
      scopedCommands: {
        accessToken: scopedToken,
        grants: new Set(['catalog:read', 'notes:read']),
        peerTrustPolicy: {
          allowedInterfaces: [getLoopbackInterfaceName()],
          allowedPeerRanges: ['127.0.0.0/8'],
        },
        tls,
      },
      token: browserToken,
      userDataPath: path.join(rootDir, 'user-data'),
    });
    let socket: WebSocket | null = null;

    try {
      await controller.whenReady();
      const bootstrap = await waitForTestHttpsResponse({
        path: `/remote/auth/bootstrap?token=${encodeURIComponent(scopedToken)}&next=%2Fremote%2F`,
        port,
      });
      expect(bootstrap.status).toBe(303);
      expect(bootstrap.headers.location).toBe('/remote/');
      const setCookie = Array.isArray(bootstrap.headers['set-cookie'])
        ? bootstrap.headers['set-cookie'][0]
        : bootstrap.headers['set-cookie'];
      const cookie = setCookie?.split(';', 1)[0];
      expect(cookie).toContain('__Host-parallel_code_session=');

      const session = await sendTestHttpsRequest({
        headers: cookie ? { Cookie: cookie } : {},
        path: '/api/remote/auth/session',
        port,
      });
      expect(session.status).toBe(200);
      const sessionPayload = JSON.parse(session.body) as {
        capabilities?: { commands?: string[] };
        csrf?: string;
      };
      expect(sessionPayload.capabilities?.commands).toContain('task-catalog.get-manifest');
      expect(sessionPayload.csrf).toEqual(expect.any(String));

      const remoteShell = await sendTestHttpsRequest({
        headers: cookie ? { Cookie: cookie } : {},
        path: '/remote/',
        port,
      });
      expect(remoteShell.status).toBe(200);
      expect(remoteShell.body).toContain('remote shell');

      const catalog = await sendTestHttpsRequest({
        body: '{}',
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          'Content-Type': 'application/json',
          Origin: origin,
          'X-Parallel-Code-CSRF': sessionPayload.csrf ?? '',
        },
        method: 'POST',
        path: '/api/commands/task-catalog.get-manifest',
        port,
      });
      expect(catalog.status).toBe(200);
      expect(JSON.parse(catalog.body)).toMatchObject({
        ok: true,
        result: { kind: 'found' },
      });

      const invalidNotes = await sendTestHttpsRequest({
        body: JSON.stringify({ taskId: '__proto__' }),
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          'Content-Type': 'application/json',
          Origin: origin,
          'X-Parallel-Code-CSRF': sessionPayload.csrf ?? '',
        },
        method: 'POST',
        path: '/api/commands/task-notes.get',
        port,
      });
      expect(invalidNotes.status).toBe(400);
      expect(invalidNotes.headers['cache-control']).toBe('no-store, max-age=0');
      expect(JSON.parse(invalidNotes.body)).toEqual({
        ok: false,
        error: { code: 'bad-request' },
      });

      socket = new WebSocket(`wss://127.0.0.1:${port}/remote-ws`, {
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          Origin: origin,
        },
        rejectUnauthorized: false,
      });
      await waitForWebSocketOpen(socket);

      const browserBootstrap = await sendTestHttpsRequest({
        path: `/auth/bootstrap?token=${encodeURIComponent(browserToken)}&next=%2F`,
        port,
      });
      expect(browserBootstrap.status).toBe(302);
      expect(browserBootstrap.headers.location).toBe('/');
      const browserSetCookie = Array.isArray(browserBootstrap.headers['set-cookie'])
        ? browserBootstrap.headers['set-cookie'][0]
        : browserBootstrap.headers['set-cookie'];
      const browserCookie = browserSetCookie?.split(';', 1)[0];
      expect(browserCookie).toContain('parallel_code_session=');
      expect(browserCookie).not.toContain('__Host-parallel_code_session=');

      const browserStatus = await sendTestHttpsRequest({
        body: '{}',
        headers: {
          Authorization: `Bearer ${browserToken}`,
          'Content-Type': 'application/json',
          Origin: origin,
        },
        method: 'POST',
        path: `/api/ipc/${encodeURIComponent(IPC.GetRemoteStatus)}`,
        port,
      });
      expect(browserStatus.status).toBe(200);
      const remoteStatus = JSON.parse(browserStatus.body) as {
        result?: { token?: string; url?: string };
      };
      expect(remoteStatus.result?.token).toBe(scopedToken);
      const remoteUrl = new URL(remoteStatus.result?.url ?? 'http://invalid');
      expect(remoteUrl.protocol).toBe('https:');
      expect(remoteUrl.pathname).toBe('/remote/auth/bootstrap');
      expect(remoteUrl.searchParams.get('token')).toBe(scopedToken);
      expect(remoteUrl.searchParams.get('next')).toBe('/remote/');

      const createCoordinatorRun = await sendTestHttpsRequest({
        body: JSON.stringify({
          coordinatorAgentId: 'coordinator-agent',
          coordinatorTaskId: 'coordinator-task',
          projectId: 'project-1',
          projectMode: 'git',
          projectRoot: rootDir,
        }),
        headers: {
          Authorization: `Bearer ${browserToken}`,
          'Content-Type': 'application/json',
          Origin: origin,
        },
        method: 'POST',
        path: `/api/ipc/${encodeURIComponent(IPC.CoordinatorCreateRun)}`,
        port,
      });
      expect(createCoordinatorRun.status).toBe(200);
      const createCoordinatorPayload = JSON.parse(createCoordinatorRun.body) as {
        result?: { credentialPath?: string };
      };
      const credentialPath = createCoordinatorPayload.result?.credentialPath;
      expect(credentialPath).toEqual(expect.any(String));
      const credential = JSON.parse(await readFile(credentialPath ?? '', 'utf8')) as {
        toolCallTlsCertificate?: string;
        toolCallUrl?: string;
      };
      expect(credential.toolCallUrl).toBe(`https://127.0.0.1:${port}/api/coordinator/tool-call`);
      expect(credential.toolCallTlsCertificate).toBe(tls.cert.toString('utf8'));
      const coordinatorTool = await execFileAsync(
        process.execPath,
        [path.resolve('scripts/coordinator-tool.mjs'), 'list_tasks'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PARALLEL_CODE_COORDINATOR_CREDENTIAL: credentialPath,
          },
        },
      );
      expect(coordinatorTool.stderr).toBe('');
      expect(() => JSON.parse(coordinatorTool.stdout)).not.toThrow();

      const browserPrincipalRemoteShell = await sendTestHttpsRequest({
        headers: browserCookie ? { Cookie: browserCookie } : {},
        path: '/remote/',
        port,
      });
      expect(browserPrincipalRemoteShell.status).toBe(401);

      const scopedPrincipalHeaders: Record<string, string>[] = [
        {
          ...(cookie ? { Cookie: cookie } : {}),
          'Content-Type': 'application/json',
          Origin: origin,
        },
        {
          Authorization: `Bearer ${scopedToken}`,
          'Content-Type': 'application/json',
          Origin: origin,
        },
      ];
      for (const headers of scopedPrincipalHeaders) {
        const genericIpc = await sendTestHttpsRequest({
          body: '{}',
          headers,
          method: 'POST',
          path: `/api/ipc/${encodeURIComponent(IPC.GetBackendRuntimeDiagnostics)}`,
          port,
        });
        expect(genericIpc.status).toBe(401);
        expect(JSON.parse(genericIpc.body)).toEqual({ error: 'unauthorized' });
      }
    } finally {
      socket?.terminate();
      await stopBrowserServer(controller);
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
      await first.whenReady();
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
      await replacement.whenReady();

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
      await controller.whenReady();
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
      await controller.whenReady();
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

  it('bootstraps restored task-port snapshots with backend ordering versions', async () => {
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
            taskMode: 'terminal',
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
    await controller.whenReady();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });

      const stateBootstrapMessage = waitForSocketMessage(
        socket,
        (message): message is { snapshots: unknown[]; type: 'state-bootstrap' } =>
          isRecord(message) &&
          message.type === 'state-bootstrap' &&
          Array.isArray(message.snapshots),
      );

      socket.send(
        JSON.stringify({
          clientId: 'client-restored-task-ports',
          lastSeq: -1,
          token,
          type: 'auth',
        }),
      );

      const stateBootstrap = await stateBootstrapMessage;
      const taskPorts = stateBootstrap.snapshots.find(
        (snapshot): snapshot is ServerStateBootstrapSnapshot<'task-ports'> =>
          isRecord(snapshot) && snapshot.category === 'task-ports' && snapshot.mode === 'replace',
      );
      expect(taskPorts).toMatchObject({
        category: 'task-ports',
        mode: 'replace',
        payload: [
          {
            exposed: [expect.objectContaining({ port: 3000 })],
            taskId: 'task-1',
          },
        ],
        version: expect.any(Number),
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
    await controller.whenReady();

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
      await controller.whenReady();
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
      await controller.whenReady();
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
