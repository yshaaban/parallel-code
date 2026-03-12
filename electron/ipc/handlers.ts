import fs from 'fs';
import { IPC } from './channels.js';
import {
  spawnAgent as spawnPtyAgent,
  detachAgentOutput,
  writeToAgent,
  resizeAgent,
  pauseAgent,
  resumeAgent,
  killAgent,
  countRunningAgents,
  killAllAgents,
  getActiveAgentIds,
  getAgentScrollback,
  getAgentCols,
} from './pty.js';
import { ensurePlansDirectory, startPlanWatcher } from './plans.js';
import { startGitWatcher, stopGitWatcher } from './git-watcher.js';
import { invalidateWorktreeStatusCache } from './git.js';
import {
  getGitIgnoredDirs,
  getMainBranch,
  getCurrentBranch,
  getChangedFiles,
  getChangedFilesFromBranch,
  getFileDiff,
  getFileDiffFromBranch,
  getWorktreeStatus,
  commitAll,
  discardUncommitted,
  checkMergeStatus,
  mergeTask,
  getBranchLog,
  pushTask,
  rebaseTask,
  createWorktree,
  removeWorktree,
  getProjectDiff,
} from './git.js';
import { createTask, deleteTask } from './tasks.js';
import { listAgents } from './agents.js';
import { resolveHydraAdapterLaunch } from './hydra-adapter.js';
import { getAgentStatusSnapshot } from './agent-status.js';
import {
  compareDirectoryNames,
  getErrorMessage,
  getHomeDirectory,
  resolveUserPath,
  validateBranchName,
  validatePath,
  validateRelativePath,
} from './path-utils.js';
import { getRecentProjectPaths } from './recent-projects.js';
import {
  loadAppStateForEnv,
  loadArenaDataForEnv,
  saveAppStateForEnv,
  saveArenaDataForEnv,
  type StorageEnv,
} from './storage.js';
import {
  assertBoolean,
  assertInt,
  assertOptionalBoolean,
  assertOptionalString,
  assertString,
  assertStringArray,
} from './validate.js';
import { BadRequestError } from './errors.js';
export { BadRequestError } from './errors.js';

type HandlerArgs = Record<string, unknown> | undefined;

export type IpcHandler = (args?: HandlerArgs) => Promise<unknown> | unknown;

const VALID_PAUSE_REASONS = new Set<string>(['manual', 'flow-control', 'restore']);

function assertOptionalPauseReason(
  value: unknown,
): asserts value is 'manual' | 'flow-control' | 'restore' | undefined {
  if (value !== undefined && (typeof value !== 'string' || !VALID_PAUSE_REASONS.has(value))) {
    throw new BadRequestError('reason must be a valid pause reason');
  }
}

export interface RemoteAccessStartResult {
  url: string;
  wifiUrl: string | null;
  tailscaleUrl: string | null;
  token: string;
  port: number;
}

export interface RemoteAccessStatus {
  enabled: boolean;
  connectedClients: number;
  peerClients?: number;
  url?: string;
  wifiUrl?: string | null;
  tailscaleUrl?: string | null;
  token?: string;
  port?: number;
}

export interface RemoteAccessController {
  start: (args: {
    port?: number;
    getTaskName: (taskId: string) => string;
    getAgentStatus: (agentId: string) => {
      status: 'running' | 'paused' | 'flow-controlled' | 'restoring' | 'exited';
      exitCode: number | null;
      lastLine: string;
    };
  }) => Promise<RemoteAccessStartResult>;
  stop: () => Promise<void>;
  status: () => RemoteAccessStatus;
}

export interface WindowController {
  isFocused: () => boolean;
  isMaximized: () => boolean;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  forceClose: () => void;
  hide: () => void;
  maximize: () => void;
  unmaximize: () => void;
  setSize: (width: number, height: number) => void;
  setPosition: (x: number, y: number) => void;
  getPosition: () => { x: number; y: number };
  getSize: () => { width: number; height: number };
}

export interface DialogController {
  confirm: (args: {
    message: string;
    title?: string;
    kind?: string;
    okLabel?: string;
    cancelLabel?: string;
  }) => Promise<boolean>;
  open: (args?: { directory?: boolean; multiple?: boolean }) => Promise<string | string[] | null>;
}

export interface ShellController {
  reveal: (filePath: string) => void;
  openFile: (worktreePath: string, filePath: string) => Promise<string | undefined>;
  openInEditor: (editorCommand: string, worktreePath: string) => Promise<void>;
}

export interface HandlerContext extends StorageEnv {
  sendToChannel: (channelId: string, msg: unknown) => void;
  emitIpcEvent?: (channel: IPC, payload: unknown) => void;
  remoteAccess?: RemoteAccessController;
  window?: WindowController;
  dialog?: DialogController;
  shell?: ShellController;
}

function requireContextFeature<K extends keyof HandlerContext>(
  context: HandlerContext,
  key: K,
  description: string,
): NonNullable<HandlerContext[K]> {
  const feature = context[key];
  if (!feature) throw new Error(`${description} is unavailable in this mode`);
  return feature as NonNullable<HandlerContext[K]>;
}

function requireWindow(context: HandlerContext): WindowController {
  return requireContextFeature(context, 'window', 'Window management');
}

function requireDialog(context: HandlerContext): DialogController {
  return requireContextFeature(context, 'dialog', 'Dialog operations');
}

function requireShell(context: HandlerContext): ShellController {
  return requireContextFeature(context, 'shell', 'Shell operations');
}

function requireRemoteAccess(context: HandlerContext): RemoteAccessController {
  return requireContextFeature(context, 'remoteAccess', 'Remote access');
}

export function createIpcHandlers(context: HandlerContext): Partial<Record<IPC, IpcHandler>> {
  const taskNames = new Map<string, string>();

  function syncTaskNamesFromJson(json: string): void {
    try {
      const state = JSON.parse(json) as { tasks?: Record<string, { id: string; name: string }> };
      if (!state.tasks) return;
      for (const task of Object.values(state.tasks)) {
        if (task.id && task.name) taskNames.set(task.id, task.name);
      }
    } catch (error) {
      console.warn('Ignoring malformed saved state:', error);
    }
  }

  return {
    [IPC.WindowFocus]: () => null,
    [IPC.WindowBlur]: () => null,
    [IPC.WindowResized]: () => null,
    [IPC.WindowMoved]: () => null,
    [IPC.WindowCloseRequested]: () => null,
    [IPC.PlanContent]: () => null,

    [IPC.SpawnAgent]: (args) => {
      const request = args ?? {};
      assertString(request.taskId, 'taskId');
      assertString(request.agentId, 'agentId');
      assertStringArray(request.args, 'args');
      if (request.adapter !== undefined && request.adapter !== 'hydra') {
        throw new BadRequestError('adapter must be hydra when provided');
      }
      if (request.cwd !== undefined) validatePath(request.cwd, 'cwd');
      const onOutput = request.onOutput as { __CHANNEL_ID__?: unknown } | undefined;
      if (typeof onOutput?.__CHANNEL_ID__ !== 'string') {
        throw new BadRequestError('onOutput.__CHANNEL_ID__ must be a string');
      }

      if (!request.isShell && request.cwd) {
        try {
          ensurePlansDirectory(request.cwd);
        } catch (error) {
          console.warn('Failed to set up plans directory:', error);
        }
      }

      const env =
        request.env && typeof request.env === 'object'
          ? Object.fromEntries(
              Object.entries(request.env).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            )
          : {};

      const resolvedLaunch =
        request.adapter === 'hydra'
          ? resolveHydraAdapterLaunch({
              command: typeof request.command === 'string' ? request.command : '',
              args: request.args,
              cwd: typeof request.cwd === 'string' ? request.cwd : '',
              env,
            })
          : {
              command: typeof request.command === 'string' ? request.command : '',
              args: request.args,
              env,
              isInternalNodeProcess: false,
            };

      const result = spawnPtyAgent(context.sendToChannel, {
        taskId: request.taskId,
        agentId: request.agentId,
        command: resolvedLaunch.command,
        args: resolvedLaunch.args,
        cwd: typeof request.cwd === 'string' ? request.cwd : '',
        env: resolvedLaunch.env,
        cols: typeof request.cols === 'number' ? request.cols : 80,
        rows: typeof request.rows === 'number' ? request.rows : 24,
        isShell: request.isShell === true,
        isInternalNodeProcess: resolvedLaunch.isInternalNodeProcess,
        onOutput: { __CHANNEL_ID__: onOutput.__CHANNEL_ID__ },
      });

      if (!request.isShell && request.cwd) {
        try {
          startPlanWatcher(request.taskId, request.cwd, (message) => {
            context.emitIpcEvent?.(IPC.PlanContent, message);
          });
        } catch (error) {
          console.warn('Failed to start plan watcher:', error);
        }
        const cwd = request.cwd;
        void startGitWatcher(request.taskId, cwd, () => {
          invalidateWorktreeStatusCache(cwd);
          void getWorktreeStatus(cwd)
            .then((status) => {
              context.emitIpcEvent?.(IPC.GitStatusChanged, { worktreePath: cwd, status });
            })
            .catch(() => {
              context.emitIpcEvent?.(IPC.GitStatusChanged, { worktreePath: cwd });
            });
        });
      }

      return result;
    },

    [IPC.WriteToAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      assertString(request.data, 'data');
      return writeToAgent(request.agentId, request.data);
    },

    [IPC.DetachAgentOutput]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      assertString(request.channelId, 'channelId');
      return detachAgentOutput(request.agentId, request.channelId);
    },

    [IPC.GetAgentScrollback]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      return getAgentScrollback(request.agentId);
    },

    [IPC.GetScrollbackBatch]: (args) => {
      const request = args ?? {};
      assertStringArray(request.agentIds, 'agentIds');
      const agentIds = Array.from(new Set(request.agentIds));
      const pausedIds: string[] = [];

      try {
        for (const agentId of agentIds) {
          pauseAgent(agentId, 'restore');
          pausedIds.push(agentId);
        }

        return agentIds.map((agentId) => ({
          agentId,
          scrollback: getAgentScrollback(agentId),
          cols: getAgentCols(agentId),
        }));
      } finally {
        for (const agentId of pausedIds.reverse()) {
          try {
            resumeAgent(agentId, 'restore');
          } catch {
            // best-effort cleanup
          }
        }
      }
    },

    [IPC.ResizeAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      assertInt(request.cols, 'cols');
      assertInt(request.rows, 'rows');
      return resizeAgent(request.agentId, request.cols, request.rows);
    },

    [IPC.PauseAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      assertOptionalPauseReason(request.reason);
      assertOptionalString(request.channelId, 'channelId');
      return pauseAgent(request.agentId, request.reason, request.channelId);
    },

    [IPC.ResumeAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      assertOptionalPauseReason(request.reason);
      assertOptionalString(request.channelId, 'channelId');
      return resumeAgent(request.agentId, request.reason, request.channelId);
    },

    [IPC.KillAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      return killAgent(request.agentId);
    },

    [IPC.CountRunningAgents]: () => countRunningAgents(),
    [IPC.KillAllAgents]: () => killAllAgents(),
    [IPC.ListAgents]: () => listAgents(),
    [IPC.ListRunningAgentIds]: () => getActiveAgentIds(),

    [IPC.CreateTask]: async (args) => {
      const request = args ?? {};
      assertString(request.name, 'name');
      validatePath(request.projectRoot, 'projectRoot');
      assertStringArray(request.symlinkDirs, 'symlinkDirs');
      assertOptionalString(request.branchPrefix, 'branchPrefix');
      const result = await createTask(
        request.name,
        request.projectRoot,
        request.symlinkDirs,
        request.branchPrefix ?? 'task',
      );
      taskNames.set(result.id, request.name);
      // Start watcher immediately so new task gets push coverage without waiting for spawn
      const worktreePath = result.worktree_path;
      void startGitWatcher(result.id, worktreePath, () => {
        invalidateWorktreeStatusCache(worktreePath);
        void getWorktreeStatus(worktreePath)
          .then((status) => {
            context.emitIpcEvent?.(IPC.GitStatusChanged, { worktreePath, status });
          })
          .catch(() => {
            context.emitIpcEvent?.(IPC.GitStatusChanged, { worktreePath });
          });
      });
      return result;
    },

    [IPC.DeleteTask]: (args) => {
      const request = args ?? {};
      assertStringArray(request.agentIds, 'agentIds');
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      assertBoolean(request.deleteBranch, 'deleteBranch');
      if (typeof request.taskId === 'string') {
        stopGitWatcher(request.taskId);
      }
      return deleteTask(
        request.agentIds,
        request.branchName,
        request.deleteBranch,
        request.projectRoot,
      );
    },

    [IPC.GetChangedFiles]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return getChangedFiles(request.worktreePath);
    },

    [IPC.GetChangedFilesFromBranch]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      return getChangedFilesFromBranch(request.projectRoot, request.branchName);
    },

    [IPC.GetFileDiff]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      validateRelativePath(request.filePath, 'filePath');
      return getFileDiff(request.worktreePath, request.filePath);
    },

    [IPC.GetFileDiffFromBranch]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      validateRelativePath(request.filePath, 'filePath');
      return getFileDiffFromBranch(request.projectRoot, request.branchName, request.filePath);
    },

    [IPC.GetGitignoredDirs]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      return getGitIgnoredDirs(request.projectRoot);
    },

    [IPC.GetWorktreeStatus]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return getWorktreeStatus(request.worktreePath);
    },

    [IPC.CommitAll]: async (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      assertString(request.message, 'message');
      const result = await commitAll(request.worktreePath, request.message);
      invalidateWorktreeStatusCache(request.worktreePath);
      void getWorktreeStatus(request.worktreePath)
        .then((status) => {
          context.emitIpcEvent?.(IPC.GitStatusChanged, {
            worktreePath: request.worktreePath,
            status,
          });
        })
        .catch(() => {
          context.emitIpcEvent?.(IPC.GitStatusChanged, { worktreePath: request.worktreePath });
        });
      return result;
    },

    [IPC.DiscardUncommitted]: async (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      const result = await discardUncommitted(request.worktreePath);
      invalidateWorktreeStatusCache(request.worktreePath);
      void getWorktreeStatus(request.worktreePath)
        .then((status) => {
          context.emitIpcEvent?.(IPC.GitStatusChanged, {
            worktreePath: request.worktreePath,
            status,
          });
        })
        .catch(() => {
          context.emitIpcEvent?.(IPC.GitStatusChanged, { worktreePath: request.worktreePath });
        });
      return result;
    },

    [IPC.GetProjectDiff]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      assertString(request.mode, 'mode');
      if (!['all', 'staged', 'unstaged', 'branch'].includes(request.mode)) {
        throw new BadRequestError('mode must be one of: all, staged, unstaged, branch');
      }
      return getProjectDiff(
        request.worktreePath,
        request.mode as 'all' | 'staged' | 'unstaged' | 'branch',
      );
    },

    [IPC.CheckMergeStatus]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return checkMergeStatus(request.worktreePath);
    },

    [IPC.MergeTask]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      assertBoolean(request.squash, 'squash');
      assertOptionalString(request.message, 'message');
      assertOptionalBoolean(request.cleanup, 'cleanup');
      return mergeTask(
        request.projectRoot,
        request.branchName,
        request.squash,
        request.message ?? null,
        request.cleanup ?? false,
      );
    },

    [IPC.GetBranchLog]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return getBranchLog(request.worktreePath);
    },

    [IPC.PushTask]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      return pushTask(request.projectRoot, request.branchName);
    },

    [IPC.RebaseTask]: async (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      const result = await rebaseTask(request.worktreePath);
      invalidateWorktreeStatusCache(request.worktreePath);
      void getWorktreeStatus(request.worktreePath)
        .then((status) => {
          context.emitIpcEvent?.(IPC.GitStatusChanged, {
            worktreePath: request.worktreePath,
            status,
          });
        })
        .catch(() => {
          context.emitIpcEvent?.(IPC.GitStatusChanged, { worktreePath: request.worktreePath });
        });
      return result;
    },

    [IPC.GetMainBranch]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      return getMainBranch(request.projectRoot);
    },

    [IPC.GetCurrentBranch]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      return getCurrentBranch(request.projectRoot);
    },

    [IPC.SaveAppState]: (args) => {
      const request = args ?? {};
      assertString(request.json, 'json');
      assertOptionalString(request.sourceId, 'sourceId');
      syncTaskNamesFromJson(request.json);
      const result = saveAppStateForEnv(context, request.json);
      context.emitIpcEvent?.(IPC.SaveAppState, {
        sourceId: request.sourceId ?? null,
        savedAt: Date.now(),
      });
      return result;
    },

    [IPC.LoadAppState]: () => {
      const json = loadAppStateForEnv(context);
      if (json) syncTaskNamesFromJson(json);
      return json;
    },

    [IPC.SaveArenaData]: (args) => {
      const request = args ?? {};
      assertString(request.filename, 'filename');
      assertString(request.json, 'json');
      return saveArenaDataForEnv(context, request.filename, request.json);
    },

    [IPC.LoadArenaData]: (args) => {
      const request = args ?? {};
      assertString(request.filename, 'filename');
      return loadArenaDataForEnv(context, request.filename);
    },

    [IPC.CreateArenaWorktree]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      if (request.symlinkDirs !== undefined) assertStringArray(request.symlinkDirs, 'symlinkDirs');
      return createWorktree(
        request.projectRoot,
        request.branchName,
        request.symlinkDirs ?? [],
        true,
      );
    },

    [IPC.RemoveArenaWorktree]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      return removeWorktree(request.projectRoot, request.branchName, true);
    },

    [IPC.CheckPathExists]: (args) => {
      const request = args ?? {};
      validatePath(request.path, 'path');
      return fs.existsSync(request.path);
    },

    [IPC.ListDirectory]: async (args) => {
      const request = args ?? {};
      assertString(request.path, 'path');
      const dirPath = resolveUserPath(request.path);

      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(dirPath);
      } catch (error) {
        throw new Error(`Directory not found: ${dirPath} (${getErrorMessage(error)})`);
      }

      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${dirPath}`);
      }

      try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort(compareDirectoryNames);
      } catch (error) {
        throw new Error(`Unable to read directory: ${dirPath} (${getErrorMessage(error)})`);
      }
    },

    [IPC.GetHomePath]: () => {
      return getHomeDirectory();
    },

    [IPC.GetRecentProjects]: async () => {
      const homeDir = getHomeDirectory();
      return getRecentProjectPaths(homeDir);
    },

    [IPC.WindowIsFocused]: () => requireWindow(context).isFocused(),
    [IPC.WindowIsMaximized]: () => requireWindow(context).isMaximized(),
    [IPC.WindowMinimize]: () => requireWindow(context).minimize(),
    [IPC.WindowToggleMaximize]: () => requireWindow(context).toggleMaximize(),
    [IPC.WindowClose]: () => requireWindow(context).close(),
    [IPC.WindowForceClose]: () => requireWindow(context).forceClose(),
    [IPC.WindowHide]: () => requireWindow(context).hide(),
    [IPC.WindowMaximize]: () => requireWindow(context).maximize(),
    [IPC.WindowUnmaximize]: () => requireWindow(context).unmaximize(),
    [IPC.WindowSetSize]: (args) => {
      const request = args ?? {};
      assertInt(request.width, 'width');
      assertInt(request.height, 'height');
      return requireWindow(context).setSize(request.width, request.height);
    },
    [IPC.WindowSetPosition]: (args) => {
      const request = args ?? {};
      assertInt(request.x, 'x');
      assertInt(request.y, 'y');
      return requireWindow(context).setPosition(request.x, request.y);
    },
    [IPC.WindowGetPosition]: () => requireWindow(context).getPosition(),
    [IPC.WindowGetSize]: () => requireWindow(context).getSize(),

    [IPC.DialogConfirm]: async (args) => {
      const request = (args ?? {}) as {
        message?: unknown;
        title?: unknown;
        kind?: unknown;
        okLabel?: unknown;
        cancelLabel?: unknown;
      };
      assertString(request.message, 'message');
      if (request.title !== undefined) assertString(request.title, 'title');
      if (request.kind !== undefined) assertString(request.kind, 'kind');
      if (request.okLabel !== undefined) assertString(request.okLabel, 'okLabel');
      if (request.cancelLabel !== undefined) assertString(request.cancelLabel, 'cancelLabel');
      return requireDialog(context).confirm({
        message: request.message,
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.kind !== undefined ? { kind: request.kind } : {}),
        ...(request.okLabel !== undefined ? { okLabel: request.okLabel } : {}),
        ...(request.cancelLabel !== undefined ? { cancelLabel: request.cancelLabel } : {}),
      });
    },

    [IPC.DialogOpen]: async (args) => {
      const request = (args ?? {}) as { directory?: unknown; multiple?: unknown };
      if (request.directory !== undefined) assertBoolean(request.directory, 'directory');
      if (request.multiple !== undefined) assertBoolean(request.multiple, 'multiple');
      return requireDialog(context).open({
        ...(request.directory !== undefined ? { directory: request.directory as boolean } : {}),
        ...(request.multiple !== undefined ? { multiple: request.multiple as boolean } : {}),
      });
    },

    [IPC.ShellReveal]: (args) => {
      const request = args ?? {};
      validatePath(request.filePath, 'filePath');
      return requireShell(context).reveal(request.filePath);
    },

    [IPC.ShellOpenFile]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      validateRelativePath(request.filePath, 'filePath');
      return requireShell(context).openFile(request.worktreePath, request.filePath);
    },

    [IPC.ShellOpenInEditor]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      if (typeof request.editorCommand !== 'string' || !request.editorCommand.trim()) {
        throw new Error('editorCommand must be a non-empty string');
      }
      const cmd = request.editorCommand.trim();
      if (/[;&|`$(){}[\]<>\\'"*?!#~]/.test(cmd)) {
        throw new Error('editorCommand must not contain shell metacharacters');
      }
      return requireShell(context).openInEditor(cmd, request.worktreePath);
    },

    [IPC.StartRemoteServer]: async (args) => {
      const request = (args ?? {}) as { port?: unknown };
      if (request.port !== undefined) assertInt(request.port, 'port');
      return requireRemoteAccess(context).start({
        getTaskName: (taskId: string) => taskNames.get(taskId) ?? taskId,
        getAgentStatus: getAgentStatusSnapshot,
        ...(request.port !== undefined ? { port: request.port as number } : {}),
      });
    },

    [IPC.StopRemoteServer]: async () => requireRemoteAccess(context).stop(),
    [IPC.GetRemoteStatus]: () => requireRemoteAccess(context).status(),
  };
}
