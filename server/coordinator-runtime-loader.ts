import type { CoordinatorEventListener } from '../electron/coordinator/runtime.js';
import type { HandlerContext } from '../electron/ipc/handler-context.js';
import type { TaskNameRegistry } from './task-names.js';

// Post-listen coordinator runtime loader. The browser server boots and listens
// without importing the coordinator module graph; the load is kicked off on
// the server 'listening' event, and every coordinator entry point (the
// tool-call route and the lazy coordinator IPC group) awaits the single load
// promise so early requests are answered after init completes, never rejected.

export interface CoordinatorRuntimeHandle {
  cleanup: () => Promise<void>;
}

export interface StartCoordinatorRuntimeLoadOptions {
  emitCoordinatorChanged: CoordinatorEventListener;
  handlerContext: HandlerContext;
  taskNames: Pick<TaskNameRegistry, 'deleteTask' | 'registerCreatedTask'>;
}

export interface CoordinatorRuntimeLoader {
  cleanup: () => Promise<void>;
  ready: Promise<CoordinatorRuntimeHandle>;
}

type CoordinatorRuntimeCleanup = () => void | Promise<void>;

interface CoordinatorRuntimeOwnerFactories {
  emitRepairEvents: () => void;
  ensureServiceLoaded: () => void;
  startMutationProducers: () => CoordinatorRuntimeCleanup;
  startPersistence: () => CoordinatorRuntimeCleanup;
  subscribeEventConsumers: () => CoordinatorRuntimeCleanup;
}

export interface CoordinatorRuntimeCleanupOwners {
  stopMutationProducers: CoordinatorRuntimeCleanup;
  stopPersistence: CoordinatorRuntimeCleanup;
  unsubscribeEventConsumers: CoordinatorRuntimeCleanup;
}

export class CoordinatorRuntimeCleanupError extends Error {
  readonly errors: unknown[];

  constructor(errors: unknown[]) {
    super('Coordinator runtime cleanup failed');
    this.name = 'CoordinatorRuntimeCleanupError';
    this.errors = errors;
  }
}

export class CoordinatorRuntimeInitializationError extends Error {
  readonly cleanupError: unknown;
  readonly initializationError: unknown;

  constructor(initializationError: unknown, cleanupError: unknown) {
    super('Coordinator runtime initialization and rollback failed');
    this.name = 'CoordinatorRuntimeInitializationError';
    this.initializationError = initializationError;
    this.cleanupError = cleanupError;
  }
}

export async function cleanupCoordinatorRuntimeOwners(
  owners: CoordinatorRuntimeCleanupOwners,
): Promise<void> {
  const failures: unknown[] = [];
  // Persistence must remain subscribed while shutdown rollback can still mutate coordinator state.
  // Run every phase even when an earlier owner rejects, then flush persistence last.
  for (const cleanup of [
    owners.stopMutationProducers,
    owners.unsubscribeEventConsumers,
    owners.stopPersistence,
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new CoordinatorRuntimeCleanupError(failures);
  }
}

async function initializeCoordinatorRuntimeOwners(
  factories: CoordinatorRuntimeOwnerFactories,
): Promise<CoordinatorRuntimeHandle> {
  const owners: CoordinatorRuntimeCleanupOwners = {
    stopMutationProducers: () => {},
    stopPersistence: () => {},
    unsubscribeEventConsumers: () => {},
  };
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= cleanupCoordinatorRuntimeOwners(owners);
    return cleanupPromise;
  };

  try {
    factories.ensureServiceLoaded();
    owners.stopPersistence = factories.startPersistence();
    owners.stopMutationProducers = factories.startMutationProducers();
    owners.unsubscribeEventConsumers = factories.subscribeEventConsumers();
    factories.emitRepairEvents();
  } catch (initializationError) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new CoordinatorRuntimeInitializationError(initializationError, cleanupError);
    }
    throw initializationError;
  }

  return { cleanup };
}

const STOPPED_RUNTIME_HANDLE: CoordinatorRuntimeHandle = {
  cleanup: () => Promise.resolve(),
};

// Browser servers may be restarted in-process immediately after synchronous
// controller cleanup. Keep each loader's owner acquisition behind the prior
// loader's full teardown so persistence and mutation-producer owners never
// overlap or get released by the preceding server's late cleanup.
let previousCoordinatorRuntimeStopped: Promise<void> = Promise.resolve();

function startSerializedCoordinatorRuntimeLoad(
  initialize: () => Promise<CoordinatorRuntimeHandle>,
): CoordinatorRuntimeLoader {
  let cancelled = false;
  let loaderCleanupPromise: Promise<void> | null = null;
  let failRuntimeTurn: (error: unknown) => void = () => {};
  let releaseRuntimeTurn: () => void = () => {};
  let runtimeTurnSettled = false;
  const priorRuntimeStopped = previousCoordinatorRuntimeStopped;
  const runtimeStopped = new Promise<void>((resolve, reject) => {
    releaseRuntimeTurn = () => {
      if (runtimeTurnSettled) {
        return;
      }
      runtimeTurnSettled = true;
      resolve();
    };
    failRuntimeTurn = (error) => {
      if (runtimeTurnSettled) {
        return;
      }
      runtimeTurnSettled = true;
      reject(error);
    };
  });
  // A failed turn is an intentional admission barrier for future loaders. Observe
  // the rejection here while preserving it for every replacement that awaits it.
  void runtimeStopped.catch(() => {});
  previousCoordinatorRuntimeStopped = runtimeStopped;

  const ready = (async (): Promise<CoordinatorRuntimeHandle> => {
    try {
      await priorRuntimeStopped;
    } catch (error) {
      failRuntimeTurn(error);
      throw error;
    }
    if (cancelled) {
      releaseRuntimeTurn();
      return STOPPED_RUNTIME_HANDLE;
    }

    let runtimeHandle: CoordinatorRuntimeHandle;
    try {
      runtimeHandle = await initialize();
    } catch (error) {
      if (error instanceof CoordinatorRuntimeInitializationError) {
        failRuntimeTurn(error);
      } else {
        // Transactional initialization already confirmed that every acquired
        // owner was released, so a later loader may safely retry.
        releaseRuntimeTurn();
      }
      throw error;
    }

    let runtimeCleanupPromise: Promise<void> | null = null;
    return {
      cleanup: () => {
        runtimeCleanupPromise ??= (async () => {
          try {
            await runtimeHandle.cleanup();
          } catch (error) {
            failRuntimeTurn(error);
            throw error;
          }
          releaseRuntimeTurn();
        })();
        return runtimeCleanupPromise;
      },
    };
  })();

  // The browser server can boot without receiving a coordinator request. Keep
  // a rejection observed while preserving it for callers of ready.
  void ready.catch(() => {});

  function cleanup(): Promise<void> {
    cancelled = true;
    if (!loaderCleanupPromise) {
      loaderCleanupPromise = (async () => {
        const handle = await ready;
        await handle.cleanup();
      })();
    }
    return loaderCleanupPromise;
  }

  return { cleanup, ready };
}

export function startCoordinatorRuntimeLoad(
  options: StartCoordinatorRuntimeLoadOptions,
): CoordinatorRuntimeLoader {
  return startSerializedCoordinatorRuntimeLoad(async () => {
    const [serviceModule, toolGatewayModule, runtimeModule] = await Promise.all([
      import('../electron/coordinator/service.js'),
      import('../electron/coordinator/tool-gateway.js'),
      import('../electron/coordinator/runtime.js'),
    ]);

    return initializeCoordinatorRuntimeOwners({
      emitRepairEvents: runtimeModule.emitCoordinatorRunRepairEvents,
      ensureServiceLoaded: () => {
        serviceModule.ensureCoordinatorServiceLoaded(options.handlerContext);
      },
      startMutationProducers: () =>
        toolGatewayModule.startCoordinatorPromptDeliveryRuntime(
          options.handlerContext,
          options.taskNames,
        ),
      startPersistence: () =>
        serviceModule.startCoordinatorRuntimePersistence(options.handlerContext),
      subscribeEventConsumers: () =>
        runtimeModule.subscribeCoordinatorEvents(options.emitCoordinatorChanged),
    });
  });
}

export const __coordinatorRuntimeLoaderTestExports = {
  initializeCoordinatorRuntimeOwners,
  resetSerializedCoordinatorRuntimeForTests: () => {
    previousCoordinatorRuntimeStopped = Promise.resolve();
  },
  startSerializedCoordinatorRuntimeLoad,
};
