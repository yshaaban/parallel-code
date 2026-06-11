import type { IPC } from './channels.js';
import type { HandlerArgs, IpcHandler } from './handler-context.js';
import type { IpcHandlerMap } from './handlers.js';

// Transport-only lazy binding for a group of IPC channels. The group shares a
// single load promise; a load failure rejects the in-flight calls and the next
// call retries the load. No domain policy lives here.

export function createLazyIpcHandlerGroup(
  channels: readonly IPC[],
  load: () => Promise<IpcHandlerMap>,
): IpcHandlerMap {
  let loadPromise: Promise<IpcHandlerMap> | null = null;

  function loadHandlers(): Promise<IpcHandlerMap> {
    if (!loadPromise) {
      loadPromise = Promise.resolve()
        .then(load)
        .catch((error: unknown) => {
          loadPromise = null;
          throw error;
        });
    }

    return loadPromise;
  }

  const lazyHandlers: IpcHandlerMap = {};
  for (const channel of channels) {
    const lazyHandler: IpcHandler = async (args?: HandlerArgs) => {
      const handlers = await loadHandlers();
      const handler = handlers[channel];
      if (!handler) {
        throw new Error(`Lazy IPC handler group did not provide a handler for ${channel}`);
      }

      return handler(args);
    };
    lazyHandlers[channel] = lazyHandler;
  }

  return lazyHandlers;
}
