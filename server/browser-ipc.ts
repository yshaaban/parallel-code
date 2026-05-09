import express from 'express';
import { isIpcChannel } from '../electron/ipc/channels.js';
import { BadRequestError, type IpcHandlerMap } from '../electron/ipc/handlers.js';
import { NotFoundError } from '../electron/ipc/errors.js';
import type { ServerMessage } from '../electron/remote/protocol.js';
import { BROWSER_CLIENT_ID_HEADER } from '../src/domain/browser-ipc.js';
import type { GitStatusSyncEvent } from '../src/domain/server-state.js';
import { isRecord } from '../src/lib/type-guards.js';
import { runBrowserIpcCommandSideEffects } from './browser-ipc-command-side-effects.js';
import { normalizeBrowserIpcTaskCommandArgs } from './browser-ipc-task-command-args.js';
import type { TaskNameRegistry } from './task-names.js';

// Browser HTTP command/query plane. This owns the request/response IPC surface
// and emits follow-up control-plane broadcasts when command-side state changes.

const IPC_REQUEST_BODY_ERROR = 'IPC request body must be a JSON object';

function isBadJsonRequestBodyError(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.status === 400 || error.statusCode === 400) &&
    typeof error.message === 'string'
  );
}

function parseRequestBody(value: unknown): Record<string, unknown> | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  return isRecord(value) ? value : null;
}

export interface RegisterBrowserIpcRoutesOptions {
  app: express.Express;
  broadcastControl: (message: ServerMessage) => void;
  emitGitStatusChanged: (payload: GitStatusSyncEvent) => void;
  handlers: IpcHandlerMap;
  isAuthorizedRequest: (req: express.Request) => boolean;
  isAllowedMutationRequest: (req: express.Request) => boolean;
  removeGitStatus?: (worktreePath: string) => void;
  taskNames: TaskNameRegistry;
}

export function registerBrowserIpcRoutes(options: RegisterBrowserIpcRoutesOptions): void {
  options.app.use('/api', express.json({ limit: '1mb' }));
  options.app.use(
    '/api',
    (error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (isBadJsonRequestBodyError(error)) {
        res.status(400).json({ error: IPC_REQUEST_BODY_ERROR });
        return;
      }

      next(error);
    },
  );

  function getBrowserClientId(req: express.Request): string | null {
    const headerValue = req.header(BROWSER_CLIENT_ID_HEADER);
    if (!headerValue) {
      return null;
    }

    const clientId = headerValue.trim();
    return clientId.length > 0 ? clientId : null;
  }

  options.app.post('/api/ipc/:channel', async (req, res) => {
    if (!options.isAuthorizedRequest(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!options.isAllowedMutationRequest(req)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    if (!isIpcChannel(req.params.channel)) {
      res.status(404).json({ error: 'unknown ipc channel' });
      return;
    }
    const channel = req.params.channel;

    const handler = options.handlers[channel];
    if (!handler) {
      res.status(404).json({ error: 'unknown ipc channel' });
      return;
    }

    try {
      const body = parseRequestBody(req.body);
      if (body === null) {
        throw new BadRequestError(IPC_REQUEST_BODY_ERROR);
      }

      const browserClientId = getBrowserClientId(req);
      const args = normalizeBrowserIpcTaskCommandArgs(channel, body, browserClientId);
      const result = await handler(args);
      runBrowserIpcCommandSideEffects(options, channel, body, result);

      res.json({ result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal error';

      if (error instanceof BadRequestError) {
        res.status(400).json({ error: message });
      } else if (error instanceof NotFoundError) {
        res.status(404).json({ error: message });
      } else {
        console.error('[server] IPC handler failed:', channel, error);
        res.status(500).json({ error: 'internal error' });
      }
    }
  });
}
