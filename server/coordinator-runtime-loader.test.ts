import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCoordinatorRun,
  getCoordinatorRuntimeState,
  resetCoordinatorRuntimeForTests,
  type CoordinatorEventListener,
} from '../electron/coordinator/runtime.js';
import { saveCoordinatorRuntimeStateForEnv } from '../electron/coordinator/persistence.js';
import { resetCoordinatorServiceForTests } from '../electron/coordinator/service.js';
import { resetCoordinatorToolGatewayForTests } from '../electron/coordinator/tool-gateway.js';
import type { HandlerContext } from '../electron/ipc/handler-context.js';
import {
  CoordinatorRuntimeInitializationError,
  CoordinatorRuntimeCleanupError,
  __coordinatorRuntimeLoaderTestExports,
  cleanupCoordinatorRuntimeOwners,
  startCoordinatorRuntimeLoad,
} from './coordinator-runtime-loader.js';

function createHandlerContext(userDataPath: string): HandlerContext {
  return {
    userDataPath,
    isPackaged: false,
    sendToChannel: () => {},
  };
}

const taskNamesStub = {
  deleteTask: () => {},
  registerCreatedTask: () => {},
};

describe('coordinator runtime loader', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    __coordinatorRuntimeLoaderTestExports.resetSerializedCoordinatorRuntimeForTests();
    resetCoordinatorToolGatewayForTests();
    await resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    if (tempDir) {
      fs.rmSync(tempDir, { force: true, recursive: true });
      tempDir = null;
    }
  });

  it('flushes persistence after shutdown rollback mutations and event unsubscription', async () => {
    const order: string[] = [];
    let state = 'before-rollback';
    let persistedState = '';

    await cleanupCoordinatorRuntimeOwners({
      stopMutationProducers: async () => {
        order.push('rollback');
        state = 'after-rollback';
      },
      unsubscribeEventConsumers: () => {
        order.push('unsubscribe');
      },
      stopPersistence: async () => {
        order.push('persist');
        persistedState = state;
      },
    });

    expect(order).toEqual(['rollback', 'unsubscribe', 'persist']);
    expect(persistedState).toBe('after-rollback');
  });

  it('settles later cleanup owners and aggregates failures when an earlier owner rejects', async () => {
    const stopPersistence = vi.fn(async () => undefined);
    const unsubscribeEventConsumers = vi.fn(() => {
      throw new Error('event unsubscribe failed');
    });

    const error = await cleanupCoordinatorRuntimeOwners({
      stopMutationProducers: async () => {
        throw new Error('rollback cleanup failed');
      },
      stopPersistence,
      unsubscribeEventConsumers,
    }).catch((cleanupError: unknown) => cleanupError);

    expect(error).toBeInstanceOf(CoordinatorRuntimeCleanupError);
    expect((error as CoordinatorRuntimeCleanupError).errors).toEqual([
      expect.objectContaining({ message: 'rollback cleanup failed' }),
      expect.objectContaining({ message: 'event unsubscribe failed' }),
    ]);
    expect(unsubscribeEventConsumers).toHaveBeenCalledOnce();
    expect(stopPersistence).toHaveBeenCalledOnce();
  });

  it('rolls back every acquired owner in shutdown order when later initialization fails', async () => {
    const order: string[] = [];
    const initializationError = new Error('repair failed');

    const initialization = __coordinatorRuntimeLoaderTestExports.initializeCoordinatorRuntimeOwners(
      {
        emitRepairEvents: () => {
          order.push('repair');
          throw initializationError;
        },
        ensureServiceLoaded: () => {
          order.push('load');
        },
        startMutationProducers: () => {
          order.push('start-producers');
          return () => {
            order.push('stop-producers');
          };
        },
        startPersistence: () => {
          order.push('start-persistence');
          return () => {
            order.push('stop-persistence');
          };
        },
        subscribeEventConsumers: () => {
          order.push('subscribe');
          return () => {
            order.push('unsubscribe');
          };
        },
      },
    );

    await expect(initialization).rejects.toBe(initializationError);
    expect(order).toEqual([
      'load',
      'start-persistence',
      'start-producers',
      'subscribe',
      'repair',
      'stop-producers',
      'unsubscribe',
      'stop-persistence',
    ]);
  });

  it('preserves initialization and rollback failures when transactional cleanup also rejects', async () => {
    const initializationError = new Error('subscription failed');
    const rollbackError = new Error('producer rollback failed');
    const stopPersistence = vi.fn(() => undefined);

    const error = await __coordinatorRuntimeLoaderTestExports
      .initializeCoordinatorRuntimeOwners({
        emitRepairEvents: () => {},
        ensureServiceLoaded: () => {},
        startMutationProducers: () => () => {
          throw rollbackError;
        },
        startPersistence: () => stopPersistence,
        subscribeEventConsumers: () => {
          throw initializationError;
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CoordinatorRuntimeInitializationError);
    expect((error as CoordinatorRuntimeInitializationError).initializationError).toBe(
      initializationError,
    );
    expect((error as CoordinatorRuntimeInitializationError).cleanupError).toBeInstanceOf(
      CoordinatorRuntimeCleanupError,
    );
    expect(
      (
        (error as CoordinatorRuntimeInitializationError)
          .cleanupError as CoordinatorRuntimeCleanupError
      ).errors,
    ).toEqual([rollbackError]);
    expect(stopPersistence).toHaveBeenCalledOnce();
  });

  it('waits for the prior runtime cleanup before an immediate replacement acquires owners', async () => {
    let finishFirstCleanup: () => void = () => {};
    const firstCleanupFinished = new Promise<void>((resolve) => {
      finishFirstCleanup = resolve;
    });
    const firstCleanupStarted = vi.fn();
    const first = __coordinatorRuntimeLoaderTestExports.startSerializedCoordinatorRuntimeLoad(
      async () => ({
        cleanup: async () => {
          firstCleanupStarted();
          await firstCleanupFinished;
        },
      }),
    );
    await first.ready;

    const firstCleanup = first.cleanup();
    const initializeReplacement = vi.fn(async () => ({
      cleanup: () => Promise.resolve(),
    }));
    const replacement =
      __coordinatorRuntimeLoaderTestExports.startSerializedCoordinatorRuntimeLoad(
        initializeReplacement,
      );

    try {
      await vi.waitFor(() => {
        expect(firstCleanupStarted).toHaveBeenCalledOnce();
      });
      await Promise.resolve();
      expect(initializeReplacement).not.toHaveBeenCalled();

      finishFirstCleanup();
      await firstCleanup;
      await replacement.ready;
      expect(initializeReplacement).toHaveBeenCalledOnce();
    } finally {
      finishFirstCleanup();
      await Promise.allSettled([firstCleanup, replacement.cleanup()]);
    }
  });

  it('retains a failed initialization rollback and rejects replacement admission', async () => {
    const initializationError = new Error('subscription failed');
    const rollbackError = new Error('producer rollback failed');
    const first = __coordinatorRuntimeLoaderTestExports.startSerializedCoordinatorRuntimeLoad(() =>
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

    const failure = await first.ready.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoordinatorRuntimeInitializationError);
    expect((failure as CoordinatorRuntimeInitializationError).initializationError).toBe(
      initializationError,
    );
    await expect(first.cleanup()).rejects.toBe(failure);

    const initializeReplacement = vi.fn(async () => ({
      cleanup: () => Promise.resolve(),
    }));
    const replacement =
      __coordinatorRuntimeLoaderTestExports.startSerializedCoordinatorRuntimeLoad(
        initializeReplacement,
      );

    await expect(replacement.ready).rejects.toBe(failure);
    await expect(replacement.cleanup()).rejects.toBe(failure);
    expect(initializeReplacement).not.toHaveBeenCalled();
  });

  it('releases replacement admission after an initialization failure with successful rollback', async () => {
    const initializationError = new Error('module import failed');
    const first = __coordinatorRuntimeLoaderTestExports.startSerializedCoordinatorRuntimeLoad(
      async () => {
        throw initializationError;
      },
    );

    await expect(first.ready).rejects.toBe(initializationError);
    await expect(first.cleanup()).rejects.toBe(initializationError);

    const initializeReplacement = vi.fn(async () => ({
      cleanup: () => Promise.resolve(),
    }));
    const replacement =
      __coordinatorRuntimeLoaderTestExports.startSerializedCoordinatorRuntimeLoad(
        initializeReplacement,
      );
    try {
      await expect(replacement.ready).resolves.toEqual({ cleanup: expect.any(Function) });
      expect(initializeReplacement).toHaveBeenCalledOnce();
    } finally {
      await replacement.cleanup();
    }
  });

  it('retains a runtime whose owner cleanup fails and rejects replacement admission', async () => {
    const cleanupError = new Error('persistence flush failed');
    const first = __coordinatorRuntimeLoaderTestExports.startSerializedCoordinatorRuntimeLoad(
      async () => ({
        cleanup: async () => {
          throw cleanupError;
        },
      }),
    );
    await first.ready;

    const firstCleanup = first.cleanup();
    const initializeReplacement = vi.fn(async () => ({
      cleanup: () => Promise.resolve(),
    }));
    const replacement =
      __coordinatorRuntimeLoaderTestExports.startSerializedCoordinatorRuntimeLoad(
        initializeReplacement,
      );

    await expect(firstCleanup).rejects.toBe(cleanupError);
    await expect(replacement.ready).rejects.toBe(cleanupError);
    await expect(replacement.cleanup()).rejects.toBe(cleanupError);
    expect(initializeReplacement).not.toHaveBeenCalled();
  });

  it('repairs early-bootstrapped clients by re-emitting hydrated runs after load', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-runtime-loader-'));
    const env = { userDataPath: tempDir, isPackaged: false } as const;

    // Seed persisted coordinator state, then drop the in-memory runtime so the
    // loader has to hydrate it from disk (a fresh server process).
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    saveCoordinatorRuntimeStateForEnv(env, getCoordinatorRuntimeState());
    await resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();

    const received: Array<{ eventType: string; runId: string }> = [];
    const emitCoordinatorChanged: CoordinatorEventListener = (event) => {
      received.push({ eventType: event.eventType, runId: event.runId });
    };

    const loader = startCoordinatorRuntimeLoad({
      emitCoordinatorChanged,
      handlerContext: createHandlerContext(tempDir),
      taskNames: taskNamesStub,
    });

    try {
      await loader.ready;
      // A client that authenticated before the post-listen load finished got an
      // empty coordinator bootstrap; the repair events delivered through the
      // control-plane subscription are what bring it up to date.
      expect(received).toContainEqual({ eventType: 'run-upserted', runId: run.id });
    } finally {
      await loader.cleanup();
    }
  });

  it('emits no repair events when there is no persisted coordinator state', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-runtime-loader-'));

    const received: unknown[] = [];
    const loader = startCoordinatorRuntimeLoad({
      emitCoordinatorChanged: (event) => received.push(event),
      handlerContext: createHandlerContext(tempDir),
      taskNames: taskNamesStub,
    });

    try {
      await loader.ready;
      expect(received).toEqual([]);
    } finally {
      await loader.cleanup();
    }
  });
});
