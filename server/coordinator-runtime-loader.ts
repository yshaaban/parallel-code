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

export function startCoordinatorRuntimeLoad(
  options: StartCoordinatorRuntimeLoadOptions,
): CoordinatorRuntimeLoader {
  let cancelled = false;
  let cleaned = false;

  const ready = (async (): Promise<CoordinatorRuntimeHandle> => {
    const [serviceModule, toolGatewayModule, runtimeModule] = await Promise.all([
      import('../electron/coordinator/service.js'),
      import('../electron/coordinator/tool-gateway.js'),
      import('../electron/coordinator/runtime.js'),
    ]);

    serviceModule.ensureCoordinatorServiceLoaded(options.handlerContext);
    const cleanups: Array<() => void | Promise<void>> = [
      serviceModule.startCoordinatorRuntimePersistence(options.handlerContext),
      toolGatewayModule.startCoordinatorPromptDeliveryRuntime(
        options.handlerContext,
        options.taskNames,
      ),
      runtimeModule.subscribeCoordinatorEvents(options.emitCoordinatorChanged),
    ];
    // Repair clients that were bootstrapped during the load window: a WS auth or
    // cold bootstrap before hydration served an empty coordinator category, and
    // restoreCoordinatorRuntimeState emits no events of its own. Re-emitting the
    // hydrated run snapshots through the just-registered subscription closes that
    // gap through the ordinary event path.
    runtimeModule.emitCoordinatorRunRepairEvents();

    const handle: CoordinatorRuntimeHandle = {
      cleanup: async () => {
        if (cleaned) {
          return;
        }

        cleaned = true;
        // The persistence cleanup is async: it flushes any pending debounced
        // coordinator-state write before shutdown proceeds.
        for (const cleanup of cleanups) {
          await cleanup();
        }
      },
    };

    if (cancelled) {
      await handle.cleanup();
    }

    return handle;
  })();

  async function cleanup(): Promise<void> {
    cancelled = true;
    const handle = await ready.catch(() => null);
    if (handle) {
      await handle.cleanup();
    }
  }

  return { cleanup, ready };
}
