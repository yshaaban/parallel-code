import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type Server as HttpServer,
} from 'node:http';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from '../../electron/ipc/runtime-diagnostics.js';
import type { TaskPortSnapshot } from '../../src/domain/server-state.js';
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

interface StartedHttpServer {
  close: () => Promise<void>;
  port: number;
}

interface PreviewTargetUpgradeRequest {
  headers: IncomingHttpHeaders;
  url: string | undefined;
}

function listenOnHttpServer(server: HttpServer): Promise<StartedHttpServer> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind HTTP server'));
        return;
      }

      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.closeAllConnections?.();
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }

              closeResolve();
            });
          }),
      });
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

async function waitForWebSocketMessage(socket: WebSocket): Promise<string> {
  const [data] = (await once(socket, 'message')) as [WebSocket.RawData];
  return String(data);
}

function getSessionCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('Expected remote auth bootstrap to set a session cookie');
  }

  return setCookie.split(';')[0] ?? setCookie;
}

function expectRedirectLocation(response: Response, baseUrl: string): URL {
  expect(response.status).toBeGreaterThanOrEqual(300);
  expect(response.status).toBeLessThan(400);

  const location = response.headers.get('location');
  if (!location) {
    throw new Error('Expected redirect response to include a Location header');
  }

  return new URL(location, baseUrl);
}

async function createBrowserSessionCookie(baseUrl: string, authToken: string): Promise<string> {
  const bootstrapResponse = await fetch(`${baseUrl}/?token=${encodeURIComponent(authToken)}`, {
    redirect: 'manual',
  });

  return getSessionCookie(bootstrapResponse);
}

async function fetchRemoteShellWithSession(baseUrl: string, authToken: string): Promise<Response> {
  const bootstrapResponse = await fetch(
    `${baseUrl}/remote?token=${encodeURIComponent(authToken)}`,
    {
      redirect: 'manual',
    },
  );
  const sessionCookie = getSessionCookie(bootstrapResponse);
  let nextUrl = expectRedirectLocation(bootstrapResponse, baseUrl);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(nextUrl, {
      headers: {
        Cookie: sessionCookie,
      },
      redirect: 'manual',
    });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    nextUrl = expectRedirectLocation(response, baseUrl);
  }

  throw new Error('Remote auth bootstrap redirected too many times');
}

function createPreviewTargetServer(
  options: {
    onUpgrade?: (request: PreviewTargetUpgradeRequest) => void;
  } = {},
): HttpServer {
  const server = createHttpServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('set-cookie', 'target-session=abc; Path=/; HttpOnly');
    res.end(
      [
        '<html><head></head>',
        `<body data-auth="${req.headers.authorization ?? ''}" data-cookie="${req.headers.cookie ?? ''}" data-path="${req.url ?? ''}">`,
        '<script type="module" src="/assets/app.js"></script>',
        '</body></html>',
      ].join(''),
    );
  });

  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket, request) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    socket.on('message', (message) => {
      socket.send(`target:${request.url ?? ''}:${String(message)}`);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/hmr') {
      socket.destroy();
      return;
    }

    options.onUpgrade?.({ headers: req.headers, url: req.url });
    wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit('connection', client, req);
    });
  });

  server.on('close', () => {
    for (const socket of sockets) {
      socket.terminate();
    }
    wss.close();
  });

  return server;
}

describe('browser-lab standalone server startup', { timeout: 15_000 }, () => {
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

  it('starts on an ephemeral port even when the default browser port is already occupied', async () => {
    const blocker = await occupyPortIfAvailable(43_117);
    if (blocker) {
      cleanup.push(() => closeServer(blocker));
    }

    const server = await startStandaloneBrowserServer({
      scenario: createInteractiveNodeScenario(),
      testSlug: 'ephemeral-port-startup',
      validateBrowserBuildArtifacts: false,
    });
    cleanup.push(() => server.stop());

    expect(server.port).not.toBe(43_117);
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

  it('can seed multiple task panels for product scorecard switching', async () => {
    const server = await startStandaloneBrowserServer({
      scenario: {
        ...createInteractiveNodeScenario(),
        additionalTaskNames: ['Scorecard Switch Target Fixture'],
      },
      testSlug: 'multi-task-scorecard-startup',
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
      taskOrder?: string[];
      tasks?: Record<string, { name?: string }>;
    };

    expect(server.taskIds).toEqual(['task-browser-lab', 'task-browser-lab-2']);
    expect(server.agentIds).toEqual(['agent-browser-lab', 'agent-browser-lab-2']);
    expect(savedState.taskOrder).toEqual(server.taskIds);
    expect(savedState.tasks?.[server.taskIds[1] ?? '']?.name).toBe(
      'Scorecard Switch Target Fixture',
    );
  });

  it('serves the authenticated remote shell and accepts its websocket endpoint', async () => {
    const server = await startStandaloneBrowserServer({
      scenario: createInteractiveNodeScenario(),
      testSlug: 'remote-shell-startup',
      validateBrowserBuildArtifacts: false,
    });
    cleanup.push(() => server.stop());

    const unauthenticatedResponse = await fetch(`${server.baseUrl}/remote/`, {
      redirect: 'manual',
    });
    const authGateUrl = expectRedirectLocation(unauthenticatedResponse, server.baseUrl);
    expect(authGateUrl.pathname).toBe('/auth');
    expect(authGateUrl.searchParams.get('next')).toBe('/remote/');

    const remoteShellResponse = await fetchRemoteShellWithSession(server.baseUrl, server.authToken);
    expect(remoteShellResponse.ok).toBe(true);
    expect(remoteShellResponse.headers.get('cache-control')).toBe('no-store, max-age=0');

    const remoteShellBody = await remoteShellResponse.text();
    expect(remoteShellBody).toContain('<title>Parallel Code</title>');
    expect(remoteShellBody).toContain('<div id="root"></div>');
    expect(remoteShellBody).not.toContain('Not authenticated');

    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(server.authToken)}&clientId=remote-route-smoke&lastSeq=-1`,
    );
    cleanup.push(async () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    });

    await waitForWebSocketOpen(socket);
  });

  it('wires authenticated port exposure through the browser preview proxy', async () => {
    const upgradeCapture: {
      headers: IncomingHttpHeaders | null;
      url: string | undefined;
    } = { headers: null, url: undefined };
    const target = await listenOnHttpServer(
      createPreviewTargetServer({
        onUpgrade({ headers, url }) {
          upgradeCapture.headers = headers;
          upgradeCapture.url = url;
        },
      }),
    );
    cleanup.push(target.close);

    const server = await startStandaloneBrowserServer({
      scenario: createInteractiveNodeScenario(),
      testSlug: 'preview-proxy-startup',
      validateBrowserBuildArtifacts: false,
    });
    cleanup.push(() => server.stop());

    const sessionCookie = await createBrowserSessionCookie(server.baseUrl, server.authToken);
    const encodedTaskId = encodeURIComponent(server.taskId);
    const unexposedResponse = await fetch(
      `${server.baseUrl}/_preview/${encodedTaskId}/${target.port}/nested/path`,
      {
        headers: {
          Cookie: sessionCookie,
        },
      },
    );
    expect(unexposedResponse.status).toBe(404);
    expect(await unexposedResponse.text()).toBe('Preview not found');

    const snapshot = await invokeIpcViaHttp<TaskPortSnapshot>(
      server.baseUrl,
      server.authToken,
      IPC.ExposePort,
      {
        label: 'Remote test app',
        port: target.port,
        taskId: server.taskId,
      },
    );
    expect(snapshot.exposed.map((port) => port.port)).toContain(target.port);

    const unauthenticatedPreviewResponse = await fetch(
      `${server.baseUrl}/_preview/${encodedTaskId}/${target.port}/nested/path?mode=remote`,
    );
    expect(unauthenticatedPreviewResponse.status).toBe(401);
    expect(await unauthenticatedPreviewResponse.text()).toBe('Unauthorized');

    const hostileOriginPreviewResponse = await fetch(
      `${server.baseUrl}/_preview/${encodedTaskId}/${target.port}/nested/path?mode=remote`,
      {
        headers: {
          Cookie: sessionCookie,
          Origin: 'https://example.invalid',
        },
      },
    );
    expect(hostileOriginPreviewResponse.status).toBe(401);
    expect(await hostileOriginPreviewResponse.text()).toBe('Unauthorized');

    const previewResponse = await fetch(
      `${server.baseUrl}/_preview/${encodedTaskId}/${target.port}/nested/path?mode=remote&token=${encodeURIComponent(server.authToken)}`,
      {
        headers: {
          Authorization: 'Bearer should-not-reach-target',
          Cookie: `${sessionCookie}; target-session=kept`,
        },
      },
    );

    expect(previewResponse.ok).toBe(true);
    const setCookie = previewResponse.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(
      `target-session=abc; Path=/_preview/${encodedTaskId}/${target.port}; HttpOnly`,
    );

    const html = await previewResponse.text();
    expect(html).toContain(`<base href="/_preview/${encodedTaskId}/${target.port}/nested/">`);
    expect(html).toContain(`src="/_preview/${encodedTaskId}/${target.port}/assets/app.js"`);
    expect(html).toContain('data-auth=""');
    expect(html).toContain('data-cookie="target-session=kept"');
    expect(html).not.toContain('parallel_code_session=');
    expect(html).not.toContain(server.authToken);
    expect(html).not.toContain('should-not-reach-target');
    expect(html).toContain('data-path="/nested/path?mode=remote"');

    const previewWebSocket = new WebSocket(
      `ws://127.0.0.1:${server.port}/_preview/${encodedTaskId}/${target.port}/hmr?channel=vite&token=${encodeURIComponent(server.authToken)}`,
      {
        headers: {
          Authorization: 'Bearer should-not-reach-target',
          Cookie: `${sessionCookie}; target-session=kept`,
        },
      },
    );
    cleanup.push(async () => {
      if (
        previewWebSocket.readyState === WebSocket.OPEN ||
        previewWebSocket.readyState === WebSocket.CONNECTING
      ) {
        previewWebSocket.close();
      }
    });

    await waitForWebSocketOpen(previewWebSocket);
    previewWebSocket.send('ping');
    await expect(waitForWebSocketMessage(previewWebSocket)).resolves.toBe(
      'target:/hmr?channel=vite:ping',
    );

    if (!upgradeCapture.headers) {
      throw new Error('Expected preview websocket target to receive an upgrade request');
    }
    expect(upgradeCapture.headers.authorization).toBeUndefined();
    expect(upgradeCapture.headers.cookie).toBe('target-session=kept');
    expect(upgradeCapture.url).toBe('/hmr?channel=vite');
  });

  it('honors the shared skip-build env contract for standalone browser startup', async () => {
    vi.stubEnv('PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK', '1');
    cleanup.push(async () => {
      vi.unstubAllEnvs();
    });

    const server = await startStandaloneBrowserServer({
      scenario: createInteractiveNodeScenario(),
      testSlug: 'skip-build-env-startup',
    });
    cleanup.push(() => server.stop());

    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });

  it('parses readiness output after stdout chunks are reassembled', () => {
    const output =
      'Booting browser server\nParallel Code server li' +
      'stening on http://127.0.0.1:43123?token=test-token\n';

    expect(parseStandaloneServerReadyOutput(output)).toEqual({
      baseUrl: 'http://127.0.0.1:43123',
      port: 43123,
      url: 'http://127.0.0.1:43123?token=test-token',
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
    const userDataPath = path.join(rootDir, 'user-data');
    const taskId = 'task-shutdown-trace';
    const agentId = 'agent-shutdown-trace';
    const clientId = 'client-shutdown-trace';
    const requestId = 'request-shutdown-trace';
    await mkdir(distDir, { recursive: true });
    await mkdir(distRemoteDir, { recursive: true });
    let diagnosticsAtExit: ReturnType<typeof getBackendRuntimeDiagnosticsSnapshot> | null = null;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      diagnosticsAtExit = getBackendRuntimeDiagnosticsSnapshot();
      return undefined;
    }) as typeof process.exit);
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
      await controller.whenCoordinatorRuntimeStopped();
    });

    await controller.whenReady();

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
    await controller.whenCoordinatorRuntimeStopped();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledOnce(), { timeout: 2_000 });

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(diagnosticsAtExit?.terminalInputTracing.activeTraceCount).toBe(0);
    expect(diagnosticsAtExit?.terminalInputTracing.completedTraces).toEqual(
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
  });
});
