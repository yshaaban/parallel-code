import express from 'express';
import { IPC } from '../electron/ipc/channels.js';
import { BadRequestError } from '../electron/ipc/handlers.js';
import { NotFoundError } from '../electron/ipc/errors.js';
import { startGitWatcher } from '../electron/ipc/git-watcher.js';
import { getWorktreeStatus, invalidateWorktreeStatusCache } from '../electron/ipc/git.js';
import type { ServerMessage } from '../electron/remote/protocol.js';
import type { TaskNameRegistry } from './task-names.js';

type IpcHandler = (args?: Record<string, unknown>) => Promise<unknown> | unknown;

export interface RegisterBrowserIpcRoutesOptions {
  app: express.Express;
  broadcastControl: (message: ServerMessage) => void;
  handlers: Partial<Record<IPC, IpcHandler>>;
  isAuthorizedRequest: (req: express.Request) => boolean;
  taskNames: TaskNameRegistry;
}

export interface StartSavedTaskGitWatchersOptions {
  broadcastControl: (message: ServerMessage) => void;
  emitIpcEvent?: (channel: IPC, payload: unknown) => void;
  savedJson: string;
}

export function startSavedTaskGitWatchers(options: StartSavedTaskGitWatchersOptions): void {
  function notifyGitStatusChanged(payload: {
    worktreePath: string;
    status?: {
      has_committed_changes: boolean;
      has_uncommitted_changes: boolean;
    };
  }): void {
    if (options.emitIpcEvent) {
      options.emitIpcEvent(IPC.GitStatusChanged, payload);
      return;
    }

    options.broadcastControl({
      type: 'git-status-changed',
      ...payload,
    });
  }

  try {
    const parsed = JSON.parse(options.savedJson) as {
      tasks?: Record<string, { id?: string; worktreePath?: string }>;
    };

    for (const task of Object.values(parsed.tasks ?? {})) {
      if (!task.id || !task.worktreePath) continue;

      const taskId = task.id;
      const worktreePath = task.worktreePath;
      void startGitWatcher(taskId, worktreePath, () => {
        invalidateWorktreeStatusCache(worktreePath);
        void getWorktreeStatus(worktreePath)
          .then((status) => {
            notifyGitStatusChanged({
              worktreePath,
              status,
            });
          })
          .catch(() => {
            notifyGitStatusChanged({
              worktreePath,
            });
          });
      });
    }
  } catch {
    /* malformed saved state */
  }
}

export function registerBrowserIpcRoutes(options: RegisterBrowserIpcRoutesOptions): void {
  options.app.use('/api', express.json({ limit: '1mb' }));

  options.app.post('/api/ipc/:channel', async (req, res) => {
    if (!options.isAuthorizedRequest(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const channel = req.params.channel as IPC;
    const handler = options.handlers[channel];
    if (!handler) {
      res.status(404).json({ error: 'unknown ipc channel' });
      return;
    }

    try {
      const args = (req.body ?? undefined) as Record<string, unknown> | undefined;
      const result = await handler(args);

      if (channel === IPC.SaveAppState) {
        const body = req.body as { json?: string } | undefined;
        if (typeof body?.json === 'string') {
          options.taskNames.syncFromSavedState(body.json);
        }
      }

      if (channel === IPC.CreateTask) {
        const body = req.body as { name?: string } | undefined;
        const created = result as { id?: string; branch_name?: string; worktree_path?: string };
        if (created.id) {
          if (typeof body?.name === 'string' && body.name.trim()) {
            options.taskNames.setTaskName(created.id, body.name);
          }
          options.broadcastControl({
            type: 'task-event',
            event: 'created',
            taskId: created.id,
            name: typeof body?.name === 'string' ? body.name : undefined,
            branchName: created.branch_name,
            worktreePath: created.worktree_path,
          });
        }
      }

      if (channel === IPC.DeleteTask) {
        const body = req.body as
          | { taskId?: string; branchName?: string; projectRoot?: string }
          | undefined;
        if (typeof body?.taskId === 'string') {
          options.taskNames.deleteTaskName(body.taskId);
          options.broadcastControl({
            type: 'task-event',
            event: 'deleted',
            taskId: body.taskId,
            branchName: body.branchName,
          });
        }
        options.broadcastControl({
          type: 'git-status-changed',
          branchName: typeof body?.branchName === 'string' ? body.branchName : undefined,
          projectRoot: typeof body?.projectRoot === 'string' ? body.projectRoot : undefined,
        });
      }

      if (channel === IPC.MergeTask || channel === IPC.PushTask) {
        const body = req.body as { projectRoot?: string; branchName?: string } | undefined;
        options.broadcastControl({
          type: 'git-status-changed',
          projectRoot: typeof body?.projectRoot === 'string' ? body.projectRoot : undefined,
          branchName: typeof body?.branchName === 'string' ? body.branchName : undefined,
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
