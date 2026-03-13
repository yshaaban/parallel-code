import { IPC } from './channels.js';
import type { HandlerContext, IpcHandler } from './handler-context.js';
import { getServerStateBootstrap } from './server-state-bootstrap.js';
import { requireRemoteAccess } from './handler-context.js';

export function createServerStateIpcHandlers(
  context: HandlerContext,
): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.GetServerStateBootstrap]: () => {
      const remoteAccess = requireRemoteAccess(context);
      const bootstrapContext = {
        getRemoteStatus: () => remoteAccess.status(),
      };

      if ('getStatusVersion' in remoteAccess) {
        return getServerStateBootstrap({
          ...bootstrapContext,
          getRemoteStatusVersion: () => remoteAccess.getStatusVersion(),
        });
      }

      return getServerStateBootstrap(bootstrapContext);
    },
  };
}
