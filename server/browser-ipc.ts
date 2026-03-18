import express from 'express';
import { IPC } from '../electron/ipc/channels.js';
import { BadRequestError } from '../electron/ipc/handlers.js';
import { NotFoundError } from '../electron/ipc/errors.js';
import { getAgentMeta } from '../electron/ipc/pty.js';
import type { ServerMessage } from '../electron/remote/protocol.js';
import { BROWSER_CLIENT_ID_HEADER } from '../src/domain/browser-ipc.js';
import type { GitStatusSyncEvent } from '../src/domain/server-state.js';
import type { TaskNameRegistry } from './task-names.js';

// Browser HTTP command/query plane. This owns the request/response IPC surface
// and emits follow-up control-plane broadcasts when command-side state changes.

type IpcHandler = (args?: Record<string, unknown>) => Promise<unknown> | unknown;

export interface RegisterBrowserIpcRoutesOptions {
  app: express.Express;
  broadcastControl: (message: ServerMessage) => void;
  emitGitStatusChanged: (payload: GitStatusSyncEvent) => void;
  handlers: Partial<Record<IPC, IpcHandler>>;
  isAuthorizedRequest: (req: express.Request) => boolean;
  isAllowedMutationRequest: (req: express.Request) => boolean;
  removeGitStatus?: (worktreePath: string) => void;
  taskNames: TaskNameRegistry;
}

export function registerBrowserIpcRoutes(options: RegisterBrowserIpcRoutesOptions): void {
  options.app.use('/api', express.json({ limit: '1mb' }));

  function getBrowserClientId(req: express.Request): string | null {
    const headerValue = req.header(BROWSER_CLIENT_ID_HEADER);
    if (!headerValue) {
      return null;
    }

    const clientId = headerValue.trim();
    return clientId.length > 0 ? clientId : null;
  }

  function resolveTaskCommandTaskId(args: Record<string, unknown>): string | undefined {
    if (typeof args.taskId === 'string') {
      return args.taskId;
    }

    if (typeof args.agentId !== 'string') {
      return undefined;
    }

    return getAgentMeta(args.agentId)?.taskId;
  }

  function normalizeTaskCommandArgs(
    channel: IPC,
    args: Record<string, unknown> | undefined,
    browserClientId: string | null,
  ): Record<string, unknown> | undefined {
    if (!args || !browserClientId) {
      return args;
    }

    switch (channel) {
      case IPC.SpawnAgent:
        return {
          ...args,
          controllerId: browserClientId,
        };
      case IPC.ResizeAgent:
      case IPC.WriteToAgent: {
        const taskId = resolveTaskCommandTaskId(args);

        return {
          ...args,
          controllerId: browserClientId,
          ...(typeof taskId === 'string' ? { taskId } : {}),
        };
      }
      default:
        return args;
    }
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

    const channel = req.params.channel as IPC;
    const handler = options.handlers[channel];
    if (!handler) {
      res.status(404).json({ error: 'unknown ipc channel' });
      return;
    }

    try {
      const browserClientId = getBrowserClientId(req);
      const args = normalizeTaskCommandArgs(
        channel,
        (req.body ?? undefined) as Record<string, unknown> | undefined,
        browserClientId,
      );
      const result = await handler(args);

      if (channel === IPC.SaveAppState) {
        const body = req.body as { json?: string } | undefined;
        if (typeof body?.json === 'string') {
          options.taskNames.syncFromSavedState(body.json);
        }
      }

      if (channel === IPC.CreateTask) {
        const body = req.body as { name?: string; directMode?: boolean } | undefined;
        const created = result as { id?: string; branch_name?: string; worktree_path?: string };
        if (created.id) {
          options.taskNames.registerCreatedTask(created.id, {
            branchName: typeof created.branch_name === 'string' ? created.branch_name : null,
            directMode: body?.directMode === true,
            taskName: typeof body?.name === 'string' ? body.name : null,
            worktreePath: typeof created.worktree_path === 'string' ? created.worktree_path : null,
          });
          options.broadcastControl({
            type: 'task-event',
            event: 'created',
            taskId: created.id,
            ...(typeof body?.name === 'string' ? { name: body.name } : {}),
            ...(typeof created.branch_name === 'string' ? { branchName: created.branch_name } : {}),
            ...(typeof created.worktree_path === 'string'
              ? { worktreePath: created.worktree_path }
              : {}),
          });
        }
      }

      if (channel === IPC.DeleteTask) {
        const body = req.body as
          | { taskId?: string; branchName?: string; projectRoot?: string; worktreePath?: string }
          | undefined;
        if (typeof body?.taskId === 'string') {
          options.taskNames.deleteTask(body.taskId);
          options.broadcastControl({
            type: 'task-event',
            event: 'deleted',
            taskId: body.taskId,
            ...(typeof body.branchName === 'string' ? { branchName: body.branchName } : {}),
            ...(typeof body.worktreePath === 'string' ? { worktreePath: body.worktreePath } : {}),
          });
        }
        options.emitGitStatusChanged({
          ...(typeof body?.worktreePath === 'string' ? { worktreePath: body.worktreePath } : {}),
          ...(typeof body?.branchName === 'string' ? { branchName: body.branchName } : {}),
          ...(typeof body?.projectRoot === 'string' ? { projectRoot: body.projectRoot } : {}),
        });
        if (typeof body?.worktreePath === 'string') {
          options.removeGitStatus?.(body.worktreePath);
        }
      }

      if (channel === IPC.MergeTask || channel === IPC.PushTask) {
        const body = req.body as { projectRoot?: string; branchName?: string } | undefined;
        options.emitGitStatusChanged({
          ...(typeof body?.projectRoot === 'string' ? { projectRoot: body.projectRoot } : {}),
          ...(typeof body?.branchName === 'string' ? { branchName: body.branchName } : {}),
        });
      }

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
