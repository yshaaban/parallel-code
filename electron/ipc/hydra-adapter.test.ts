import type { ChildProcess } from 'child_process';
import { createServer } from 'node:http';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoundedSpawn } from './bounded-process.js';
import {
  __hydraAdapterTestExports,
  buildHydraOperatorArgs,
  deriveHydraPortFromWorktree,
  getHydraRuntimeAvailability,
  HYDRA_HTTP_REQUEST_TIMEOUT_MS,
  HydraOperationCleanupError,
  HydraRuntimeCleanupError,
  HYDRA_SHUTDOWN_TIMEOUT_MS,
  normalizeHydraStartupMode,
  resolveHydraAdapterLaunch,
  resolveHydraRuntime,
} from './hydra-adapter.js';

function createControllableBoundedChild(): {
  bounded: BoundedSpawn;
  reject: (error: Error) => void;
  resolve: () => void;
  setForcedTerminationError: (error: Error) => void;
} {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new EventEmitter() as NonNullable<ChildProcess['stdin']>;
  const stdout = new EventEmitter() as NonNullable<ChildProcess['stdout']>;
  const stderr = new EventEmitter() as NonNullable<ChildProcess['stderr']>;
  stdin.destroy = vi.fn();
  stdout.destroy = vi.fn();
  stderr.destroy = vi.fn();
  Object.assign(child, {
    exitCode: null,
    kill: vi.fn(),
    killed: true,
    signalCode: null,
    stderr,
    stdin,
    stdout,
  });

  let resolveCompletion!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    },
  );
  const terminate = vi.fn();
  let forcedTerminationError: Error | undefined;
  const bounded: BoundedSpawn = {
    child,
    completion,
    get forcedTerminationError() {
      return forcedTerminationError;
    },
    terminate,
  };

  return {
    bounded,
    reject: rejectCompletion,
    resolve: () => resolveCompletion({ code: 0, signal: null }),
    setForcedTerminationError: (error) => {
      forcedTerminationError = error;
    },
  };
}

describe('hydra adapter helpers', () => {
  it.each([0, 1])(
    'rejects an existing Hydra daemon at port offset %s without shutting it down',
    async (offset) => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-port-owner-'));
      const port = 43_000 + ((deriveHydraPortFromWorktree(workspace) - 43_000 + offset) % 15_000);
      const ownedHealthUrl = `http://127.0.0.1:${port}/health`;
      const server = createServer();
      const fetchHealth = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (url) =>
          new Response(
            JSON.stringify({
              running: true,
              projectRoot: url === ownedHealthUrl ? workspace : '/unrelated-checkout',
            }),
          ),
      );
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolve);
        });
        await expect(__hydraAdapterTestExports.pickHydraPort(workspace)).rejects.toThrow(
          'Hydra is already running in this checkout',
        );
        const requestedUrls = fetchHealth.mock.calls.map(([url]) => String(url));
        expect(requestedUrls).toContain(ownedHealthUrl);
        expect(requestedUrls.every((url) => url.endsWith('/health'))).toBe(true);
        expect(server.listening).toBe(true);
      } finally {
        fetchHealth.mockRestore();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  it('derives a stable per-worktree daemon port', () => {
    const first = deriveHydraPortFromWorktree('/tmp/parallel-code/worktree-one');
    const second = deriveHydraPortFromWorktree('/tmp/parallel-code/worktree-one');
    const third = deriveHydraPortFromWorktree('/tmp/parallel-code/worktree-two');

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(43_000);
    expect(first).toBeLessThan(58_000);
    expect(third).not.toBe(first);
  });

  it('normalizes unsupported startup modes back to auto', () => {
    expect(normalizeHydraStartupMode('dispatch')).toBe('dispatch');
    expect(normalizeHydraStartupMode('unsupported')).toBe('auto');
    expect(normalizeHydraStartupMode(undefined)).toBe('auto');
  });

  it('builds operator args with url, startup mode, and welcome suppression', () => {
    expect(
      buildHydraOperatorArgs(['agents=codex,claude'], {
        resumeOnStart: false,
        url: 'http://127.0.0.1:43123',
        startupMode: 'smart',
      }),
    ).toEqual(['agents=codex,claude', 'url=http://127.0.0.1:43123', 'welcome=false', 'mode=smart']);
  });

  it('does not override explicit operator args', () => {
    expect(
      buildHydraOperatorArgs(['mode=council', 'welcome=true', 'url=http://127.0.0.1:41000'], {
        resumeOnStart: true,
        url: 'http://127.0.0.1:43123',
        startupMode: 'auto',
      }),
    ).toEqual(['mode=council', 'welcome=true', 'url=http://127.0.0.1:41000', 'resumeOnStart=true']);
  });

  it('adds startup recovery when requested', () => {
    expect(
      buildHydraOperatorArgs([], {
        resumeOnStart: true,
        url: 'http://127.0.0.1:43123',
        startupMode: 'auto',
      }),
    ).toEqual(['url=http://127.0.0.1:43123', 'welcome=false', 'mode=auto', 'resumeOnStart=true']);
  });

  it('wraps Hydra launches through the internal adapter process', () => {
    const launch = resolveHydraAdapterLaunch({
      command: 'hydra',
      args: ['agents=codex,claude'],
      cwd: '/tmp/parallel-code/worktree-one',
      env: { PARALLEL_CODE_HYDRA_STARTUP_MODE: 'council' },
      resumeOnStart: true,
    });

    expect(launch.command).toBe(process.execPath);
    expect(launch.isInternalNodeProcess).toBe(true);
    expect(launch.args).toEqual(
      expect.arrayContaining([
        expect.stringContaining('hydra-adapter'),
        '--hydra-command',
        'hydra',
        '--startup-mode',
        'council',
        '--resume-on-start',
        '--operator-arg',
        'agents=codex,claude',
      ]),
    );
  });
});

describe('hydra child lifecycle ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cleans up only its owned daemon process, never the listener at its former port', async () => {
    const { bounded, resolve } = createControllableBoundedChild();
    const fetchRequest = vi.spyOn(globalThis, 'fetch');
    try {
      const cleanup = __hydraAdapterTestExports.shutdownHydraDaemon(bounded);
      resolve();
      await cleanup;
      expect(bounded.terminate).toHaveBeenCalledOnce();
      expect(fetchRequest).not.toHaveBeenCalled();
    } finally {
      fetchRequest.mockRestore();
    }
  });

  it.each([
    { pid: 42, projectRoot: '/other-checkout' },
    { pid: 43, projectRoot: '/repo' },
  ])('rejects health from a different process or checkout: %j', async (identity) => {
    vi.useFakeTimers();
    const { bounded } = createControllableBoundedChild();
    Object.assign(bounded.child, { pid: 42 });
    const fetchHealth = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ running: true, ...identity })));
    try {
      const ready = __hydraAdapterTestExports.waitForHydraHealth(
        'http://127.0.0.1:43123',
        bounded.child,
        [],
        { current: null },
        '/repo',
      );
      const rejection = expect(ready).rejects.toThrow('does not belong to the launched daemon');
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
    } finally {
      fetchHealth.mockRestore();
    }
  });

  it('accepts health only from its owned daemon and checkout', async () => {
    const { bounded } = createControllableBoundedChild();
    Object.assign(bounded.child, { pid: 42 });
    const fetchHealth = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ running: true, pid: 42, projectRoot: '/repo' })),
      );
    try {
      await expect(
        __hydraAdapterTestExports.waitForHydraHealth(
          'http://127.0.0.1:43123',
          bounded.child,
          [],
          { current: null },
          '/repo',
        ),
      ).resolves.toBeUndefined();
    } finally {
      fetchHealth.mockRestore();
    }
  });

  it('keeps long-lived children deadline-free while delegating process-tree ownership', () => {
    const { bounded } = createControllableBoundedChild();
    const spawnChild = vi.fn(() => bounded);

    expect(
      __hydraAdapterTestExports.spawnHydraChild(
        'hydra-daemon',
        ['start'],
        { cwd: '/repo', stdio: ['ignore', 'pipe', 'pipe'] },
        spawnChild,
      ),
    ).toBe(bounded);
    expect(spawnChild).toHaveBeenCalledWith(
      'hydra-daemon',
      ['start'],
      { cwd: '/repo', stdio: ['ignore', 'pipe', 'pipe'] },
      {
        terminateGraceMs: HYDRA_SHUTDOWN_TIMEOUT_MS,
        timeoutMs: 0,
      },
    );
  });

  it('forwards terminal resize signals across the owned POSIX process-group boundary', () => {
    const { bounded } = createControllableBoundedChild();

    __hydraAdapterTestExports.forwardHydraOperatorResize(bounded, 'darwin');
    expect(bounded.child.kill).toHaveBeenCalledWith('SIGWINCH');

    __hydraAdapterTestExports.forwardHydraOperatorResize(bounded, 'win32');
    expect(bounded.child.kill).toHaveBeenCalledOnce();
  });

  it('bounds stalled Hydra HTTP work and aborts the underlying request', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const request = __hydraAdapterTestExports.withHydraRequestDeadline(
      'Hydra test request',
      HYDRA_HTTP_REQUEST_TIMEOUT_MS,
      (signal) => {
        requestSignal = signal;
        return new Promise<never>(() => undefined);
      },
    );
    const outcome = request.catch((error: unknown) => error);

    await Promise.resolve();
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(HYDRA_HTTP_REQUEST_TIMEOUT_MS);

    const error = await outcome;
    expect(error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `Hydra test request timed out after ${HYDRA_HTTP_REQUEST_TIMEOUT_MS}ms.`,
    );
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the Hydra HTTP deadline after successful work', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;

    await expect(
      __hydraAdapterTestExports.withHydraRequestDeadline(
        'Hydra test request',
        HYDRA_HTTP_REQUEST_TIMEOUT_MS,
        async (signal) => {
          requestSignal = signal;
          return 'healthy';
        },
      ),
    ).resolves.toBe('healthy');

    expect(requestSignal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces daemon stream failures to health polling while terminating the owned tree', async () => {
    const { bounded } = createControllableBoundedChild();
    const daemonFailure: { current: Error | null } = { current: null };

    __hydraAdapterTestExports.handleHydraDaemonStreamError(
      bounded,
      daemonFailure,
      new Error('broken pipe'),
    );

    expect(daemonFailure.current?.message).toBe('Hydra daemon output stream failed: broken pipe');
    expect(bounded.terminate).toHaveBeenCalledWith(daemonFailure.current);
    await expect(
      __hydraAdapterTestExports.waitForHydraHealth(
        'http://127.0.0.1:43123',
        bounded.child,
        ['daemon output'],
        daemonFailure,
        '/repo',
      ),
    ).rejects.toThrow('Hydra daemon output stream failed: broken pipe\ndaemon output');
  });

  it('does not mistake a delivered kill signal for completed process cleanup', async () => {
    vi.useFakeTimers();
    const { bounded } = createControllableBoundedChild();
    const waiting = __hydraAdapterTestExports.waitForHydraChildExit(bounded, 50);
    let settled = false;
    void waiting
      .catch(() => undefined)
      .then(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).rejects.toThrow('Timed out waiting for child process to exit.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for bounded tree termination and destroys streams before cleanup resolves', async () => {
    const { bounded, reject } = createControllableBoundedChild();
    const cleanup = __hydraAdapterTestExports.terminateHydraChild(bounded);
    let settled = false;
    void cleanup.then(() => {
      settled = true;
    });

    expect(bounded.terminate).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(settled).toBe(false);

    const requestedTermination = vi.mocked(bounded.terminate).mock.calls[0]?.[0];
    expect(requestedTermination).toBeInstanceOf(Error);
    reject(requestedTermination as Error);
    await cleanup;

    expect(bounded.child.stdin?.destroy).toHaveBeenCalledOnce();
    expect(bounded.child.stdout?.destroy).toHaveBeenCalledOnce();
    expect(bounded.child.stderr?.destroy).toHaveBeenCalledOnce();
  });

  it('rejects cleanup when forced settlement cannot confirm process-tree termination', async () => {
    const { bounded, reject, setForcedTerminationError } = createControllableBoundedChild();
    const cleanup = __hydraAdapterTestExports.terminateHydraChild(bounded);
    const lifecycleError = new Error('Hydra process tree remained unconfirmed');

    setForcedTerminationError(lifecycleError);
    reject(lifecycleError);

    await expect(cleanup).rejects.toBe(lifecycleError);
    expect(bounded.child.stdin?.destroy).toHaveBeenCalledOnce();
    expect(bounded.child.stdout?.destroy).toHaveBeenCalledOnce();
    expect(bounded.child.stderr?.destroy).toHaveBeenCalledOnce();
  });

  it('does not erase an unexpected child lifecycle failure during termination', async () => {
    const { bounded, reject } = createControllableBoundedChild();
    const cleanup = __hydraAdapterTestExports.terminateHydraChild(bounded);
    const lifecycleError = new Error('Hydra child failed before termination');

    reject(lifecycleError);

    await expect(cleanup).rejects.toBe(lifecycleError);
    expect(bounded.child.stdin?.destroy).toHaveBeenCalledOnce();
    expect(bounded.child.stdout?.destroy).toHaveBeenCalledOnce();
    expect(bounded.child.stderr?.destroy).toHaveBeenCalledOnce();
  });

  it('settles daemon cleanup after an already-observed operator failure', async () => {
    const { bounded, reject } = createControllableBoundedChild();
    const operationError = new Error('operator failed');
    const cleanupDaemon = vi.fn(async () => undefined);
    const cleanup = __hydraAdapterTestExports.settleHydraRuntimeCleanupOwners(
      bounded,
      cleanupDaemon,
      { observedOperatorFailure: operationError },
    );

    reject(operationError);

    await expect(cleanup).resolves.toBeUndefined();
    expect(cleanupDaemon).toHaveBeenCalledOnce();
  });

  it('retains every independent Hydra runtime cleanup failure', async () => {
    const { bounded, reject, setForcedTerminationError } = createControllableBoundedChild();
    const operatorCleanupError = new Error('operator cleanup unconfirmed');
    const daemonCleanupError = new Error('daemon cleanup failed');
    const cleanup = __hydraAdapterTestExports.settleHydraRuntimeCleanupOwners(bounded, () =>
      Promise.reject(daemonCleanupError),
    );

    setForcedTerminationError(operatorCleanupError);
    reject(operatorCleanupError);
    const error = await cleanup.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HydraRuntimeCleanupError);
    expect((error as HydraRuntimeCleanupError).failures).toEqual([
      { error: operatorCleanupError, owner: 'operator' },
      { error: daemonCleanupError, owner: 'daemon' },
    ]);
  });

  it('preserves the operation error when independent Hydra cleanup also fails', async () => {
    const { bounded, reject } = createControllableBoundedChild();
    const operationError = new Error('operator failed');
    const daemonCleanupError = new Error('daemon cleanup failed');
    const failure = __hydraAdapterTestExports.rethrowHydraOperationFailure(
      operationError,
      bounded,
      () => Promise.reject(daemonCleanupError),
    );

    reject(operationError);
    const error = await failure.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HydraOperationCleanupError);
    expect(error).toMatchObject({ cleanupError: daemonCleanupError, operationError });
  });
});

describe('resolveHydraRuntime', () => {
  const tempRoots: string[] = [];
  const vendoredRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../vendor/hydra',
  );

  afterEach(() => {
    for (const tempRoot of tempRoots) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses bare hydra and hydra-daemon commands by default', () => {
    const runtime = resolveHydraRuntime('hydra', { resolveBareCommandPath: false });

    expect(runtime.operator).toMatchObject({
      command: 'hydra',
      args: [],
    });
    expect(runtime.daemon).toMatchObject({
      command: 'hydra-daemon',
      args: ['start'],
    });
  });

  it('derives node-backed Hydra commands from a local Hydra checkout', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-hydra-'));
    tempRoots.push(tempRoot);
    fs.mkdirSync(path.join(tempRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'bin', 'hydra-cli.mjs'), '#!/usr/bin/env node\n');
    fs.writeFileSync(
      path.join(tempRoot, 'lib', 'orchestrator-daemon.mjs'),
      '#!/usr/bin/env node\n',
    );

    expect(resolveHydraRuntime(path.join(tempRoot, 'bin', 'hydra-cli.mjs'))).toEqual({
      operator: {
        command: process.execPath,
        args: [path.join(tempRoot, 'bin', 'hydra-cli.mjs')],
      },
      daemon: {
        command: process.execPath,
        args: [path.join(tempRoot, 'lib', 'orchestrator-daemon.mjs'), 'start'],
      },
    });
  });

  it('falls back to the vendored Hydra runtime when bare hydra is not on PATH', () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';

    try {
      expect(resolveHydraRuntime('hydra', { resolveBareCommandPath: true })).toEqual({
        operator: {
          command: process.execPath,
          args: [path.join(vendoredRoot, 'bin', 'hydra-cli.mjs')],
        },
        daemon: {
          command: process.execPath,
          args: [path.join(vendoredRoot, 'lib', 'orchestrator-daemon.mjs'), 'start'],
        },
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('finds the vendored Hydra runtime from a standalone server dist layout', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-server-dist-'));
    tempRoots.push(tempRoot);

    const startDir = path.join(tempRoot, 'dist-server', 'electron', 'ipc');
    fs.mkdirSync(startDir, { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'vendor', 'hydra', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'vendor', 'hydra', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'vendor', 'hydra', 'bin', 'hydra-cli.mjs'), '');
    fs.writeFileSync(path.join(tempRoot, 'vendor', 'hydra', 'lib', 'orchestrator-daemon.mjs'), '');

    const originalPath = process.env.PATH;
    process.env.PATH = '';

    try {
      expect(
        resolveHydraRuntime('hydra', {
          assetSearch: { startDir },
          resolveBareCommandPath: true,
        }),
      ).toEqual({
        operator: {
          command: process.execPath,
          args: [path.join(tempRoot, 'vendor', 'hydra', 'bin', 'hydra-cli.mjs')],
        },
        daemon: {
          command: process.execPath,
          args: [path.join(tempRoot, 'vendor', 'hydra', 'lib', 'orchestrator-daemon.mjs'), 'start'],
        },
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('reports a useful diagnostic when a Hydra override path is invalid', async () => {
    const availability = await getHydraRuntimeAvailability('/tmp/does-not-exist/hydra-cli.mjs', {
      resolveBareCommandPath: true,
    });

    expect(availability.available).toBe(false);
    expect(availability.source).toBe('unavailable');
    expect(availability.detail).toContain('not found');
  });
});
