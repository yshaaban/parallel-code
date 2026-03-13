import fs from 'fs';

import { IPC } from './channels.js';
import type { HandlerContext, IpcHandler } from './handler-context.js';
import {
  requireDialog,
  requireRemoteAccess,
  requireShell,
  requireWindow,
} from './handler-context.js';
import {
  getRemoteAccessStatusWorkflow,
  startRemoteAccessWorkflow,
  stopRemoteAccessWorkflow,
} from './remote-access-workflows.js';
import {
  loadAppStateForEnv,
  loadArenaDataForEnv,
  saveAppStateForEnv,
  saveArenaDataForEnv,
} from './storage.js';
import {
  compareDirectoryNames,
  getErrorMessage,
  getHomeDirectory,
  resolveUserPath,
  validatePath,
  validateRelativePath,
} from './path-utils.js';
import { getRecentProjectPaths } from './recent-projects.js';
import { getAgentStatusSnapshot } from './agent-status.js';
import { assertBoolean, assertInt, assertOptionalString, assertString } from './validate.js';

export function createSystemIpcHandlers(
  context: HandlerContext,
  options: {
    getTaskName: (taskId: string) => string;
    syncTaskConvergenceFromJson: (json: string) => void;
    syncTaskNamesFromJson: (json: string) => void;
  },
): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.WindowFocus]: () => null,
    [IPC.WindowBlur]: () => null,
    [IPC.WindowResized]: () => null,
    [IPC.WindowMoved]: () => null,
    [IPC.WindowCloseRequested]: () => null,
    [IPC.PlanContent]: () => null,

    [IPC.SaveAppState]: (args) => {
      const request = args ?? {};
      assertString(request.json, 'json');
      assertOptionalString(request.sourceId, 'sourceId');
      options.syncTaskNamesFromJson(request.json);
      options.syncTaskConvergenceFromJson(request.json);
      const result = saveAppStateForEnv(context, request.json);
      context.emitIpcEvent?.(IPC.SaveAppState, {
        sourceId: request.sourceId ?? null,
        savedAt: Date.now(),
      });
      return result;
    },

    [IPC.LoadAppState]: () => {
      const json = loadAppStateForEnv(context);
      if (json) {
        options.syncTaskNamesFromJson(json);
        options.syncTaskConvergenceFromJson(json);
      }
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

    [IPC.GetHomePath]: () => getHomeDirectory(),

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

      const command = request.editorCommand.trim();
      if (/[;&|`$(){}[\]<>\\'"*?!#~]/.test(command)) {
        throw new Error('editorCommand must not contain shell metacharacters');
      }

      return requireShell(context).openInEditor(command, request.worktreePath);
    },

    [IPC.StartRemoteServer]: async (args) => {
      const request = (args ?? {}) as { port?: unknown };
      if (request.port !== undefined) {
        assertInt(request.port, 'port');
      }

      return startRemoteAccessWorkflow(requireRemoteAccess(context), {
        getTaskName: options.getTaskName,
        getAgentStatus: getAgentStatusSnapshot,
        ...(request.port !== undefined ? { port: request.port as number } : {}),
      });
    },

    [IPC.StopRemoteServer]: async () => stopRemoteAccessWorkflow(requireRemoteAccess(context)),
    [IPC.GetRemoteStatus]: () => getRemoteAccessStatusWorkflow(requireRemoteAccess(context)),
  };
}
