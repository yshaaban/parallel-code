import { EventEmitter } from 'events';
import { createServer } from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from './runtime-diagnostics.js';

interface RediscoveredTaskPortMock {
  host: string | null;
  port: number;
  suggestion: string;
  taskId: string;
}

interface TaskPortExposureCandidateScanResultMock {
  host: string | null;
  port: number;
  source: 'local' | 'task';
}

const { createConnectionControl, rediscoverTaskPortsMock, scanTaskPortExposureCandidatesMock } =
  vi.hoisted(() => {
    const control: {
      delegate: (...args: unknown[]) => unknown;
      mock: ReturnType<typeof vi.fn>;
      realDelegate: (...args: unknown[]) => unknown;
    } = {
      delegate: () => {
        throw new Error('createConnection delegate is not initialized');
      },
      mock: vi.fn((...args: unknown[]) => control.delegate(...args)),
      realDelegate: () => {
        throw new Error('createConnection real delegate is not initialized');
      },
    };

    return {
      createConnectionControl: control,
      rediscoverTaskPortsMock: vi.fn<() => RediscoveredTaskPortMock[]>(() => []),
      scanTaskPortExposureCandidatesMock: vi.fn<() => TaskPortExposureCandidateScanResultMock[]>(
        () => [],
      ),
    };
  });

vi.mock('net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('net')>();
  const realDelegate = (...args: unknown[]): unknown => {
    return Reflect.apply(actual.createConnection, actual, args);
  };
  createConnectionControl.delegate = realDelegate;
  createConnectionControl.realDelegate = realDelegate;

  return {
    ...actual,
    createConnection: createConnectionControl.mock,
  };
});

vi.mock('./port-discovery.js', () => ({
  rediscoverTaskPorts: rediscoverTaskPortsMock,
  scanTaskPortExposureCandidates: scanTaskPortExposureCandidatesMock,
}));
import {
  clearTaskPortRegistry,
  exposeTaskPort,
  getExposedTaskPort,
  getTaskPortExposureCandidates,
  getTaskPortSnapshots,
  observeTaskPortsFromOutput,
  resolveTaskPreviewTarget,
  restoreSavedTaskPorts,
  revalidateTaskPortPreview,
  removeTaskPorts,
  subscribeTaskPorts,
  unexposeTaskPort,
} from './task-ports.js';

async function withPreviewServer(
  run: (port: number) => Promise<void>,
  host = '127.0.0.1',
): Promise<void> {
  const server = createServer((_req, res) => {
    res.end('ok');
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, host, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind preview test server');
  }

  try {
    await run(address.port);
  } finally {
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

async function withClosedPreviewPort(run: (port: number) => Promise<void>): Promise<void> {
  const server = createServer((_req, res) => {
    res.end('ok');
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind preview test server');
  }

  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  await run(port);
}

interface ControlledPreviewSocket {
  destroy: ReturnType<typeof vi.fn>;
  emitConnect: () => void;
  emitError: () => void;
  once: (event: string, listener: (...args: unknown[]) => void) => ControlledPreviewSocket;
  setTimeout: ReturnType<typeof vi.fn>;
}

function createControlledPreviewSocket(): ControlledPreviewSocket {
  const events = new EventEmitter();
  const socket: ControlledPreviewSocket = {
    destroy: vi.fn(),
    emitConnect() {
      events.emit('connect');
    },
    emitError() {
      events.emit('error', new Error('Preview connection failed'));
    },
    once(event, listener) {
      events.once(event, listener);
      return socket;
    },
    setTimeout: vi.fn(),
  };

  return socket;
}

describe('task port registry', () => {
  beforeEach(() => {
    clearTaskPortRegistry();
    resetBackendRuntimeDiagnostics();
    createConnectionControl.delegate = createConnectionControl.realDelegate;
    createConnectionControl.mock.mockClear();
    rediscoverTaskPortsMock.mockReset();
    rediscoverTaskPortsMock.mockReturnValue([]);
    scanTaskPortExposureCandidatesMock.mockReset();
    scanTaskPortExposureCandidatesMock.mockReturnValue([]);
  });

  it('detects observed ports from PTY output once per port', () => {
    const snapshot = observeTaskPortsFromOutput(
      'task-1',
      'VITE v6 ready in 200ms\nLocal: http://127.0.0.1:5173/\n',
    );

    expect(snapshot).toMatchObject({
      taskId: 'task-1',
      observed: [
        expect.objectContaining({
          host: '127.0.0.1',
          port: 5173,
          protocol: 'http',
          source: 'output',
        }),
      ],
    });

    expect(
      observeTaskPortsFromOutput(
        'task-1',
        'Local: http://127.0.0.1:5173/\nAnother line mentioning localhost:5173\n',
      ),
    ).toBeNull();
  });

  it('preserves detected https ports when exposing them', () => {
    observeTaskPortsFromOutput('task-https', 'Local: https://127.0.0.1:3443/\n');

    const exposed = exposeTaskPort('task-https', 3443, 'Secure app');

    expect(exposed.observed).toEqual([
      expect.objectContaining({
        host: '127.0.0.1',
        port: 3443,
        protocol: 'https',
      }),
    ]);
    expect(exposed.exposed).toEqual([
      expect.objectContaining({
        host: '127.0.0.1',
        port: 3443,
        protocol: 'https',
        source: 'observed',
      }),
    ]);
  });

  it('updates an observed port when later output provides stronger protocol details', () => {
    observeTaskPortsFromOutput('task-upgrade', 'Listening on port 3443\n');

    const upgraded = observeTaskPortsFromOutput('task-upgrade', 'Local: https://127.0.0.1:3443/\n');

    expect(upgraded?.observed).toEqual([
      expect.objectContaining({
        host: '127.0.0.1',
        port: 3443,
        protocol: 'https',
      }),
    ]);
  });

  it('keeps generic listening detections hostless for safe loopback exposure', () => {
    const snapshot = observeTaskPortsFromOutput('task-generic', 'Server listening on port 3000\n');

    expect(snapshot?.observed).toEqual([
      expect.objectContaining({
        host: null,
        port: 3000,
        protocol: 'http',
      }),
    ]);
  });

  it('returns exposable listening-port candidates with task matches first', () => {
    observeTaskPortsFromOutput('task-1', 'Local: http://127.0.0.1:5173/\n');
    exposeTaskPort('task-1', 3001, 'Existing');
    scanTaskPortExposureCandidatesMock.mockReturnValue([
      { host: '127.0.0.1', port: 8080, source: 'local' },
      { host: '127.0.0.1', port: 5173, source: 'task' },
      { host: '192.168.1.4', port: 4173, source: 'local' },
      { host: null, port: 3001, source: 'task' },
    ]);

    expect(getTaskPortExposureCandidates('task-1', '/tmp/task-1')).toEqual([
      {
        host: '127.0.0.1',
        port: 5173,
        source: 'task',
        suggestion: 'Detected in task output and confirmed listening in this task',
      },
      {
        host: '127.0.0.1',
        port: 8080,
        source: 'local',
        suggestion: 'Active local server port',
      },
    ]);
  });

  it('exposes and unexposes task ports', () => {
    observeTaskPortsFromOutput('task-1', 'Local: http://127.0.0.1:3001/');

    const exposed = exposeTaskPort('task-1', 3001, 'Frontend');
    expect(exposed.exposed).toEqual([
      expect.objectContaining({
        host: '127.0.0.1',
        label: 'Frontend',
        port: 3001,
        protocol: 'http',
        source: 'observed',
      }),
    ]);
    expect(getExposedTaskPort('task-1', 3001)).toMatchObject({
      label: 'Frontend',
      port: 3001,
    });

    const afterUnexpose = unexposeTaskPort('task-1', 3001);
    expect(afterUnexpose).toMatchObject({
      taskId: 'task-1',
      exposed: [],
      observed: [expect.objectContaining({ port: 3001 })],
    });
  });

  it('emits removed events when task port state is deleted', () => {
    const events: Array<unknown> = [];
    const unsubscribe = subscribeTaskPorts((event) => {
      events.push(event);
    });

    exposeTaskPort('task-1', 8080, 'App');
    removeTaskPorts('task-1');
    unsubscribe();

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'removed',
        removed: true,
        taskId: 'task-1',
      }),
    );
    expect(getTaskPortSnapshots()).toEqual([]);
  });

  it('restores exposed port intent from saved state', () => {
    restoreSavedTaskPorts(
      JSON.stringify({
        tasks: {
          'task-1': {
            id: 'task-1',
            worktreePath: '/tmp/worktree-1',
            exposedPorts: [
              {
                port: 4173,
                label: 'Frontend',
                protocol: 'https',
                source: 'manual',
              },
            ],
          },
        },
      }),
    );

    expect(getExposedTaskPort('task-1', 4173)).toMatchObject({
      availability: 'unknown',
      host: null,
      label: 'Frontend',
      port: 4173,
      protocol: 'https',
      source: 'manual',
      statusMessage: null,
      verifiedHost: null,
    });
  });

  it('restores only validated task port entries from malformed saved state', () => {
    rediscoverTaskPortsMock.mockReturnValue([
      {
        taskId: 'task-good',
        host: '127.0.0.1',
        port: 5173,
        suggestion: 'Rediscovered localhost:5173',
      },
    ]);

    expect(() =>
      restoreSavedTaskPorts(
        JSON.stringify({
          tasks: {
            'task-null': null,
            'task-bad-worktree': {
              worktreePath: 42,
              exposedPorts: [{ port: 3000 }],
            },
            'task-good': {
              id: 'task-good',
              worktreePath: '/tmp/worktree-good',
              exposedPorts: [
                { port: 5173, label: 'Frontend', protocol: 'https' },
                { port: 'not-a-port', label: 'Broken' },
                null,
              ],
            },
          },
        }),
      ),
    ).not.toThrow();

    expect(rediscoverTaskPortsMock).toHaveBeenCalledWith([
      {
        taskId: 'task-good',
        worktreePath: '/tmp/worktree-good',
      },
    ]);
    expect(getExposedTaskPort('task-good', 5173)).toMatchObject({
      label: 'Frontend',
      port: 5173,
      protocol: 'https',
    });
    expect(getExposedTaskPort('task-bad-worktree', 3000)).toMatchObject({
      port: 3000,
      protocol: 'http',
    });
  });

  it('preserves saved https exposure protocol during restart rediscovery', () => {
    rediscoverTaskPortsMock.mockReturnValue([
      {
        taskId: 'task-1',
        host: '127.0.0.1',
        port: 4173,
        suggestion: 'Rediscovered localhost:4173',
      },
    ]);

    restoreSavedTaskPorts(
      JSON.stringify({
        tasks: {
          'task-1': {
            id: 'task-1',
            worktreePath: '/tmp/worktree-1',
            exposedPorts: [
              {
                port: 4173,
                label: 'Frontend',
                protocol: 'https',
                source: 'manual',
              },
            ],
          },
        },
      }),
    );

    expect(getExposedTaskPort('task-1', 4173)).toMatchObject({
      host: '127.0.0.1',
      port: 4173,
      protocol: 'https',
    });
  });

  it('marks exposed ports available after successful preview revalidation', async () => {
    await withPreviewServer(async (port) => {
      exposeTaskPort('task-available', port, 'Preview');
      resetBackendRuntimeDiagnostics();
      const snapshot = await revalidateTaskPortPreview('task-available', port);

      expect(snapshot?.exposed).toEqual([
        expect.objectContaining({
          availability: 'available',
          port,
          verifiedHost: '127.0.0.1',
        }),
      ]);
      const diagnostics = getBackendRuntimeDiagnosticsSnapshot().previewValidation;
      expect(diagnostics.cacheHits).toBe(0);
      expect(diagnostics.connectionFailures).toBe(0);
      expect(diagnostics.lastProbeFailureReason).toBeNull();
      expect(diagnostics.probeSuccesses).toBeGreaterThanOrEqual(1);
      expect(diagnostics.revalidations).toBeGreaterThanOrEqual(1);
      expect(diagnostics.lastProbeDurationMs).toEqual(expect.any(Number));
      expect(diagnostics.lastProbeTarget).toBe(`http://127.0.0.1:${port}`);
      expect(diagnostics.maxProbeDurationMs).toBeGreaterThanOrEqual(
        diagnostics.lastProbeDurationMs ?? 0,
      );
    });
  });

  it('records preview probe failure reasons when an exposed port is unavailable', async () => {
    await withClosedPreviewPort(async (port) => {
      exposeTaskPort('task-unavailable', port, 'Preview');
      resetBackendRuntimeDiagnostics();

      const snapshot = await revalidateTaskPortPreview('task-unavailable', port);

      expect(snapshot?.exposed).toEqual([
        expect.objectContaining({
          availability: 'unavailable',
          port,
          statusMessage: `Preview target is not reachable on loopback port ${port}.`,
          verifiedHost: null,
        }),
      ]);
      const diagnostics = getBackendRuntimeDiagnosticsSnapshot().previewValidation;
      expect(diagnostics.probeFailures).toBeGreaterThanOrEqual(1);
      expect(diagnostics.connectionFailures).toBeGreaterThanOrEqual(1);
      expect(diagnostics.lastProbeFailureReason).toBe('connection-error');
      expect(diagnostics.lastProbeDurationMs).toEqual(expect.any(Number));
      expect(diagnostics.lastProbeTarget).toEqual(expect.stringContaining(`:${port}`));
      expect(diagnostics.maxProbeDurationMs).toBeGreaterThanOrEqual(
        diagnostics.lastProbeDurationMs ?? 0,
      );
    });
  });

  it('ignores stale preview validation after a port is unexposed and re-exposed', async () => {
    const sockets: ControlledPreviewSocket[] = [];
    createConnectionControl.delegate = () => {
      const socket = createControlledPreviewSocket();
      sockets.push(socket);
      return socket;
    };

    exposeTaskPort('task-race', 4321, 'Old preview');
    expect(sockets).toHaveLength(1);

    unexposeTaskPort('task-race', 4321);
    exposeTaskPort('task-race', 4321, 'Fresh preview');
    expect(sockets).toHaveLength(2);

    sockets[0]?.emitConnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(getExposedTaskPort('task-race', 4321)).toMatchObject({
      availability: 'unknown',
      label: 'Fresh preview',
      verifiedHost: null,
    });

    sockets.slice(1).forEach((socket) => socket.emitError());
    await Promise.resolve();
  });

  it('ignores preview probe diagnostics from validations started before a reset', async () => {
    await withClosedPreviewPort(async (port) => {
      exposeTaskPort('task-reset', port, 'Preview');

      const revalidation = revalidateTaskPortPreview('task-reset', port);
      resetBackendRuntimeDiagnostics();
      await revalidation;

      const diagnostics = getBackendRuntimeDiagnosticsSnapshot().previewValidation;
      expect(diagnostics).toMatchObject({
        connectionFailures: 0,
        lastProbeDurationMs: null,
        lastProbeFailureReason: null,
        lastProbeTarget: null,
        maxProbeDurationMs: 0,
        probeFailures: 0,
        probeSuccesses: 0,
        revalidations: 0,
        timeoutFailures: 0,
      });
    });
  });

  it('records preview cache hits after a successful revalidation', async () => {
    await withPreviewServer(async (port) => {
      exposeTaskPort('task-cache', port, 'Preview');
      resetBackendRuntimeDiagnostics();
      await revalidateTaskPortPreview('task-cache', port);
      const target = await resolveTaskPreviewTarget('task-cache', port);

      expect(target).toBe(`http://127.0.0.1:${port}`);
      const diagnostics = getBackendRuntimeDiagnosticsSnapshot().previewValidation;
      expect(diagnostics.cacheHits).toBeGreaterThanOrEqual(1);
      expect(diagnostics.probeSuccesses).toBeGreaterThanOrEqual(1);
      expect(diagnostics.revalidations).toBeGreaterThanOrEqual(1);
      expect(diagnostics.lastProbeDurationMs).toEqual(expect.any(Number));
    });
  });

  it('does not count preview cache entries created before a diagnostics reset', async () => {
    await withPreviewServer(async (port) => {
      exposeTaskPort('task-cache-reset', port, 'Preview');
      resetBackendRuntimeDiagnostics();
      await revalidateTaskPortPreview('task-cache-reset', port);
      expect(await resolveTaskPreviewTarget('task-cache-reset', port)).toBe(
        `http://127.0.0.1:${port}`,
      );

      resetBackendRuntimeDiagnostics();

      expect(await resolveTaskPreviewTarget('task-cache-reset', port)).toBe(
        `http://127.0.0.1:${port}`,
      );
      expect(getBackendRuntimeDiagnosticsSnapshot().previewValidation.cacheHits).toBe(0);
    });
  });

  it('records preview cache hits when reusing a verified host after the short cache expires', async () => {
    await withPreviewServer(async (port) => {
      exposeTaskPort('task-verified-cache', port, 'Preview');
      resetBackendRuntimeDiagnostics();
      await revalidateTaskPortPreview('task-verified-cache', port, {
        previewTargetCacheTtlMs: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      const target = await resolveTaskPreviewTarget('task-verified-cache', port, {
        previewTargetCacheTtlMs: 1_000,
      });

      expect(target).toBe(`http://127.0.0.1:${port}`);
      const diagnostics = getBackendRuntimeDiagnosticsSnapshot().previewValidation;
      expect(diagnostics.cacheHits).toBeGreaterThanOrEqual(1);
      expect(diagnostics.probeSuccesses).toBeGreaterThanOrEqual(1);
      expect(diagnostics.revalidations).toBeGreaterThanOrEqual(1);
      expect(diagnostics.lastProbeDurationMs).toEqual(expect.any(Number));
    });
  });

  it('revalidates IPv6 loopback preview targets without bracketed-host drift', async () => {
    await withPreviewServer(async (port) => {
      restoreSavedTaskPorts(
        JSON.stringify({
          tasks: {
            'task-ipv6': {
              id: 'task-ipv6',
              worktreePath: '/tmp/worktree-ipv6',
              exposedPorts: [
                {
                  port,
                  label: 'IPv6 preview',
                  protocol: 'http',
                  source: 'manual',
                  host: '::1',
                },
              ],
            },
          },
        }),
      );
      resetBackendRuntimeDiagnostics();

      const snapshot = await revalidateTaskPortPreview('task-ipv6', port);
      const target = await resolveTaskPreviewTarget('task-ipv6', port, {
        previewTargetCacheTtlMs: 1_000,
      });

      expect(snapshot?.exposed).toEqual([
        expect.objectContaining({
          availability: 'available',
          host: '::1',
          port,
          verifiedHost: '::1',
        }),
      ]);
      expect(target).toBe(`http://[::1]:${port}`);
      const diagnostics = getBackendRuntimeDiagnosticsSnapshot().previewValidation;
      expect(diagnostics.probeSuccesses).toBeGreaterThanOrEqual(1);
      expect(diagnostics.revalidations).toBeGreaterThanOrEqual(1);
    }, '::1');
  });
});
