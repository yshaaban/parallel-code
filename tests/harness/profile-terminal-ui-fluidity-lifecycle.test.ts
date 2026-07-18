import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

const TEST_FILE = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(TEST_FILE), '..', '..');
const DEFAULT_OPTIONS = {
  authToken: 'fallback-token',
  injectedExperimentConfig: null,
  injectedHighLoadMode: null,
  serverUrl: 'http://127.0.0.1:43117',
  visibleTerminalCount: null,
};

async function loadProfilerModule(): Promise<
  typeof import('../../scripts/profile-terminal-ui-fluidity.mjs')
> {
  return import(
    pathToFileURL(path.resolve(ROOT_DIR, 'scripts', 'profile-terminal-ui-fluidity.mjs')).href
  );
}

function createLaunchedServer(stop: ReturnType<typeof vi.fn>) {
  return {
    authToken: 'launched-token',
    baseUrl: 'http://127.0.0.1:43210',
    seededTasks: [],
    stop,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('profile-terminal-ui-fluidity suite lifecycle', () => {
  it('preserves a non-Error operation rejection', async () => {
    const { runOperationWithCleanups } = await loadProfilerModule();

    const outcome = await runOperationWithCleanups(
      'UI fluidity suite bulk_text',
      async () => Promise.reject(null),
      [],
    ).then(
      (value) => ({ status: 'fulfilled', value }),
      (reason: unknown) => ({ reason, status: 'rejected' }),
    );

    expect(outcome).toEqual({ reason: null, status: 'rejected' });
  });

  it('preserves cleanup failure when the profiled operation succeeds', async () => {
    const { runOperationWithCleanups } = await loadProfilerModule();
    const cleanupFailure = new Error('page close failed');

    await expect(
      runOperationWithCleanups(
        'UI fluidity suite bulk_text',
        async () => ({ result: 'complete' }),
        [['close profiler page', async () => Promise.reject(cleanupFailure)]],
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        errors: [
          expect.objectContaining({
            cause: cleanupFailure,
            message: 'close profiler page: page close failed',
          }),
        ],
        message: 'UI fluidity suite bulk_text cleanup failed',
      }),
    );
  });

  it('waits for every owned server-data cleanup and labels arbitrary failures', async () => {
    const { stopUiFluidityOwnedServer } = await loadProfilerModule();
    const lateWorkspaceRemoval = createDeferred<undefined>();
    const stopProcess = vi.fn().mockResolvedValue(undefined);
    const cleanupServerData = vi.fn().mockRejectedValue(undefined);
    const remove = vi.fn(() => lateWorkspaceRemoval.promise);
    let settled = false;
    const outcome = stopUiFluidityOwnedServer(
      { pid: 43117 },
      '/tmp/ui-fluidity-user-data',
      '/tmp/ui-fluidity-seeded-workspace',
      {
        cleanupDevelopmentServerData: cleanupServerData,
        remove,
        stopProcess,
      },
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });

    await vi.waitFor(() => {
      expect(cleanupServerData).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();
    });
    expect(stopProcess).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    lateWorkspaceRemoval.reject(null);
    const failure = await outcome;

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      'UI fluidity profiler owned server data cleanup failed',
    );
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        cause: undefined,
        message: 'remove development server data: undefined',
      }),
      expect.objectContaining({ cause: null, message: 'remove seeded profiler workspace: null' }),
    ]);
  });

  it('stops the launched server when client creation fails', async () => {
    const { runSuiteAttempt } = await loadProfilerModule();
    const failure = new Error('client setup failed');
    const stop = vi.fn().mockResolvedValue(undefined);
    const newContext = vi.fn();

    await expect(
      runSuiteAttempt({ newContext }, DEFAULT_OPTIONS, 'bulk_text', {
        createClient: () => {
          throw failure;
        },
        launchServer: vi.fn().mockResolvedValue(createLaunchedServer(stop)),
      }),
    ).rejects.toBe(failure);

    expect(newContext).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops the launched server when browser context creation fails', async () => {
    const { runSuiteAttempt } = await loadProfilerModule();
    const failure = new Error('context setup failed');
    const stop = vi.fn().mockResolvedValue(undefined);
    const newContext = vi.fn().mockRejectedValue(failure);

    await expect(
      runSuiteAttempt({ newContext }, DEFAULT_OPTIONS, 'bulk_text', {
        createClient: vi.fn().mockReturnValue({}),
        launchServer: vi.fn().mockResolvedValue(createLaunchedServer(stop)),
      }),
    ).rejects.toBe(failure);

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('closes the context and stops the server when init-script setup fails', async () => {
    const { runSuiteAttempt } = await loadProfilerModule();
    const failure = new Error('init script failed');
    const stop = vi.fn().mockResolvedValue(undefined);
    const context = {
      addInitScript: vi.fn().mockRejectedValue(failure),
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn(),
    };

    await expect(
      runSuiteAttempt(
        { newContext: vi.fn().mockResolvedValue(context) },
        DEFAULT_OPTIONS,
        'bulk_text',
        {
          createClient: vi.fn().mockReturnValue({}),
          launchServer: vi.fn().mockResolvedValue(createLaunchedServer(stop)),
        },
      ),
    ).rejects.toBe(failure);

    expect(context.newPage).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('closes the page and context and stops the server when page initialization fails', async () => {
    const { runSuiteAttempt } = await loadProfilerModule();
    const failure = new Error('page initialization failed');
    const stop = vi.fn().mockResolvedValue(undefined);
    const page = {
      close: vi.fn().mockRejectedValue(new Error('page close failed')),
    };
    const context = {
      addInitScript: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockRejectedValue(new Error('context close failed')),
      newPage: vi.fn().mockResolvedValue(page),
    };

    const error = await runSuiteAttempt(
      { newContext: vi.fn().mockResolvedValue(context) },
      DEFAULT_OPTIONS,
      'bulk_text',
      {
        createClient: vi.fn().mockReturnValue({}),
        initializePage: vi.fn().mockRejectedValue(failure),
        launchServer: vi.fn().mockResolvedValue(createLaunchedServer(stop)),
      },
    ).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      failure,
      expect.objectContaining({
        cause: expect.objectContaining({ message: 'page close failed' }),
        message: 'close profiler page: page close failed',
      }),
      expect.objectContaining({
        cause: expect.objectContaining({ message: 'context close failed' }),
        message: 'close profiler browser context: context close failed',
      }),
    ]);

    expect(page.close).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
