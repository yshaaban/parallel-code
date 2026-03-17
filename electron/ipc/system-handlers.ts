import fs from 'fs';

import type { BrowserReconnectSnapshot } from '../../src/domain/renderer-invoke.js';
import { IPC } from './channels.js';
import { BadRequestError } from './errors.js';
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
  getBackendRuntimeDiagnosticsSnapshot,
  recordReconnectSnapshotCacheHit,
  recordReconnectSnapshotCacheMiss,
  recordReconnectSnapshotInvalidation,
  resetBackendRuntimeDiagnostics,
} from './runtime-diagnostics.js';
import { getActiveAgentIds } from './pty.js';
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
  normalizeAbsolutePath,
  resolveUserPath,
  validatePath,
  validateRelativePath,
} from './path-utils.js';
import { getRecentProjectPaths } from './recent-projects.js';
import { getAgentStatusSnapshot } from './agent-status.js';
import { isPlanRelativePath, readPlanForWorktree } from './plans.js';
import { defineIpcHandler } from './typed-handler.js';
import {
  assertBoolean,
  assertInt,
  assertOptionalString,
  assertString,
  assertStringArray,
} from './validate.js';

const RECONNECT_SNAPSHOT_CACHE_TTL_MS = 200;

interface CachedReconnectSnapshot {
  expiresAt: number;
  promise: Promise<BrowserReconnectSnapshot>;
}

interface SavedStateSyncOptions {
  syncProjectBaseBranchesFromJson: (json: string) => void;
  syncTaskConvergenceFromJson: (json: string) => void;
  syncTaskNamesFromJson: (json: string) => void;
}

const reconnectSnapshotCacheByUserDataPath = new Map<string, CachedReconnectSnapshot>();

function clearReconnectSnapshotCache(userDataPath: string): void {
  if (reconnectSnapshotCacheByUserDataPath.has(userDataPath)) {
    recordReconnectSnapshotInvalidation();
  }
  reconnectSnapshotCacheByUserDataPath.delete(userDataPath);
}

function clearExpiredReconnectSnapshotCacheEntries(now: number): void {
  for (const [userDataPath, entry] of reconnectSnapshotCacheByUserDataPath) {
    if (entry.expiresAt > now) {
      continue;
    }

    reconnectSnapshotCacheByUserDataPath.delete(userDataPath);
  }
}

function cacheReconnectSnapshot(
  userDataPath: string,
  promise: Promise<BrowserReconnectSnapshot>,
  expiresAt: number,
): void {
  reconnectSnapshotCacheByUserDataPath.set(userDataPath, {
    expiresAt,
    promise,
  });
}

function clearReconnectSnapshotIfCurrent(
  userDataPath: string,
  promise: Promise<BrowserReconnectSnapshot>,
): void {
  const current = reconnectSnapshotCacheByUserDataPath.get(userDataPath);
  if (current?.promise === promise) {
    reconnectSnapshotCacheByUserDataPath.delete(userDataPath);
  }
}

function loadSavedAppStateJson(
  context: HandlerContext,
  options: SavedStateSyncOptions,
): string | null {
  const json = loadAppStateForEnv(context);
  if (!json) {
    return null;
  }

  options.syncTaskNamesFromJson(json);
  options.syncTaskConvergenceFromJson(json);
  options.syncProjectBaseBranchesFromJson(json);
  return json;
}

function createBrowserReconnectSnapshot(
  context: HandlerContext,
  options: SavedStateSyncOptions,
): BrowserReconnectSnapshot {
  return {
    appStateJson: loadSavedAppStateJson(context, options),
    runningAgentIds: getActiveAgentIds(),
  };
}

function getBrowserReconnectSnapshot(
  context: HandlerContext,
  options: SavedStateSyncOptions,
): Promise<BrowserReconnectSnapshot> {
  const now = Date.now();
  clearExpiredReconnectSnapshotCacheEntries(now);
  const cached = reconnectSnapshotCacheByUserDataPath.get(context.userDataPath);
  if (cached && cached.expiresAt > now) {
    recordReconnectSnapshotCacheHit();
    return cached.promise;
  }

  recordReconnectSnapshotCacheMiss();
  const promise = Promise.resolve(createBrowserReconnectSnapshot(context, options));
  cacheReconnectSnapshot(context.userDataPath, promise, now + RECONNECT_SNAPSHOT_CACHE_TTL_MS);

  return promise.catch((error) => {
    clearReconnectSnapshotIfCurrent(context.userDataPath, promise);
    throw error;
  });
}

export function createSystemIpcHandlers(
  context: HandlerContext,
  options: SavedStateSyncOptions & {
    getTaskName: (taskId: string) => string;
  },
): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.WindowFocus]: () => null,
    [IPC.WindowBlur]: () => null,
    [IPC.WindowResized]: () => null,
    [IPC.WindowMoved]: () => null,
    [IPC.WindowCloseRequested]: () => null,
    [IPC.PlanContent]: () => null,
    [IPC.ReadPlanContent]: defineIpcHandler<IPC.ReadPlanContent>(IPC.ReadPlanContent, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      if (request.relativePath !== undefined) {
        validateRelativePath(request.relativePath, 'relativePath');
        if (!isPlanRelativePath(request.relativePath)) {
          throw new BadRequestError('relativePath must be inside a plan directory');
        }
      }
      return readPlanForWorktree(request.worktreePath, request.relativePath);
    }),

    [IPC.SaveAppState]: defineIpcHandler<IPC.SaveAppState>(IPC.SaveAppState, (args) => {
      const request = args;
      assertString(request.json, 'json');
      assertOptionalString(request.sourceId, 'sourceId');
      options.syncTaskNamesFromJson(request.json);
      options.syncTaskConvergenceFromJson(request.json);
      options.syncProjectBaseBranchesFromJson(request.json);
      clearReconnectSnapshotCache(context.userDataPath);
      saveAppStateForEnv(context, request.json);
      context.emitIpcEvent?.(IPC.SaveAppState, {
        sourceId: request.sourceId ?? null,
        savedAt: Date.now(),
      });
      return undefined;
    }),

    [IPC.LoadAppState]: () => {
      return loadSavedAppStateJson(context, options);
    },

    [IPC.GetBrowserReconnectSnapshot]: () => getBrowserReconnectSnapshot(context, options),

    [IPC.SaveArenaData]: defineIpcHandler<IPC.SaveArenaData>(IPC.SaveArenaData, (args) => {
      const request = args;
      assertString(request.filename, 'filename');
      assertString(request.json, 'json');
      saveArenaDataForEnv(context, request.filename, request.json);
      return undefined;
    }),

    [IPC.LoadArenaData]: defineIpcHandler<IPC.LoadArenaData>(IPC.LoadArenaData, (args) => {
      const request = args;
      assertString(request.filename, 'filename');
      return loadArenaDataForEnv(context, request.filename);
    }),

    [IPC.CheckPathExists]: defineIpcHandler<IPC.CheckPathExists>(IPC.CheckPathExists, (args) => {
      const request = args;
      validatePath(request.path, 'path');
      return fs.existsSync(request.path);
    }),

    [IPC.CheckPathsExist]: defineIpcHandler<IPC.CheckPathsExist>(IPC.CheckPathsExist, (args) => {
      const request = args;
      assertStringArray(request.paths, 'paths');
      const uniquePaths = [...new Set(request.paths)];
      const result: Record<string, boolean> = {};

      for (const filePath of uniquePaths) {
        const normalizedPath = normalizeAbsolutePath(filePath);
        result[filePath] = normalizedPath ? fs.existsSync(normalizedPath) : false;
      }

      return result;
    }),

    [IPC.ListDirectory]: defineIpcHandler<IPC.ListDirectory>(IPC.ListDirectory, async (args) => {
      const request = args;
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
    }),

    [IPC.GetHomePath]: () => getHomeDirectory(),

    [IPC.GetRecentProjects]: async () => {
      const homeDir = getHomeDirectory();
      return getRecentProjectPaths(homeDir);
    },

    [IPC.GetBackendRuntimeDiagnostics]: () => getBackendRuntimeDiagnosticsSnapshot(),
    [IPC.ResetBackendRuntimeDiagnostics]: () => {
      resetBackendRuntimeDiagnostics();
      return undefined;
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

    [IPC.WindowSetSize]: defineIpcHandler<IPC.WindowSetSize>(IPC.WindowSetSize, (args) => {
      const request = args;
      assertInt(request.width, 'width');
      assertInt(request.height, 'height');
      requireWindow(context).setSize(request.width, request.height);
      return undefined;
    }),

    [IPC.WindowSetPosition]: defineIpcHandler<IPC.WindowSetPosition>(
      IPC.WindowSetPosition,
      (args) => {
        const request = args;
        assertInt(request.x, 'x');
        assertInt(request.y, 'y');
        requireWindow(context).setPosition(request.x, request.y);
        return undefined;
      },
    ),

    [IPC.WindowGetPosition]: () => requireWindow(context).getPosition(),
    [IPC.WindowGetSize]: () => requireWindow(context).getSize(),

    [IPC.DialogConfirm]: defineIpcHandler<IPC.DialogConfirm>(IPC.DialogConfirm, async (args) => {
      const request = args;
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
    }),

    [IPC.DialogOpen]: defineIpcHandler<IPC.DialogOpen>(IPC.DialogOpen, async (args) => {
      const request = args;
      if (request.directory !== undefined) assertBoolean(request.directory, 'directory');
      if (request.multiple !== undefined) assertBoolean(request.multiple, 'multiple');
      return requireDialog(context).open({
        ...(request.directory !== undefined ? { directory: request.directory } : {}),
        ...(request.multiple !== undefined ? { multiple: request.multiple } : {}),
      });
    }),

    [IPC.ShellReveal]: defineIpcHandler<IPC.ShellReveal>(IPC.ShellReveal, (args) => {
      const request = args;
      validatePath(request.filePath, 'filePath');
      requireShell(context).reveal(request.filePath);
      return undefined;
    }),

    [IPC.ShellOpenFile]: defineIpcHandler<IPC.ShellOpenFile>(IPC.ShellOpenFile, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      validateRelativePath(request.filePath, 'filePath');
      return requireShell(context).openFile(request.worktreePath, request.filePath);
    }),

    [IPC.ShellOpenInEditor]: defineIpcHandler<IPC.ShellOpenInEditor>(
      IPC.ShellOpenInEditor,
      (args) => {
        const request = args;
        validatePath(request.worktreePath, 'worktreePath');
        if (typeof request.editorCommand !== 'string' || !request.editorCommand.trim()) {
          throw new Error('editorCommand must be a non-empty string');
        }

        const command = request.editorCommand.trim();
        if (/[;&|`$(){}[\]<>\\'"*?!#~]/.test(command)) {
          throw new Error('editorCommand must not contain shell metacharacters');
        }

        return requireShell(context)
          .openInEditor(command, request.worktreePath)
          .then(() => undefined);
      },
    ),

    [IPC.StartRemoteServer]: defineIpcHandler<IPC.StartRemoteServer>(
      IPC.StartRemoteServer,
      async (args) => {
        const request = args;
        if (request.port !== undefined) {
          assertInt(request.port, 'port');
        }

        return startRemoteAccessWorkflow(requireRemoteAccess(context), {
          getTaskName: options.getTaskName,
          getAgentStatus: getAgentStatusSnapshot,
          ...(request.port !== undefined ? { port: request.port } : {}),
        });
      },
    ),

    [IPC.StopRemoteServer]: async () => stopRemoteAccessWorkflow(requireRemoteAccess(context)),
    [IPC.GetRemoteStatus]: () => getRemoteAccessStatusWorkflow(requireRemoteAccess(context)),
  };
}
