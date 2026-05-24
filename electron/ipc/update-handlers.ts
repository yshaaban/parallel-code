import { createUnsupportedAppUpdateStatus } from '../../src/domain/app-update.js';
import { IPC } from './channels.js';
import type { HandlerContext, IpcHandler } from './handler-context.js';

function getUnsupportedUpdateStatus(
  context: HandlerContext,
): ReturnType<typeof createUnsupportedAppUpdateStatus> {
  return createUnsupportedAppUpdateStatus(context.window ? 'not-configured' : 'browser');
}

function getUpdateStatus(
  context: HandlerContext,
): ReturnType<typeof createUnsupportedAppUpdateStatus> {
  return context.update?.getStatus() ?? getUnsupportedUpdateStatus(context);
}

export function createUpdateIpcHandlers(context: HandlerContext): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.GetUpdateStatus]: () => getUpdateStatus(context),
    [IPC.CheckForUpdates]: () =>
      context.update?.checkForUpdates() ?? getUnsupportedUpdateStatus(context),
    [IPC.InstallUpdate]: () =>
      context.update?.installUpdate() ?? getUnsupportedUpdateStatus(context),
  };
}
