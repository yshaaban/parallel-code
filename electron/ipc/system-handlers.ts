import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import type {
  BrowserColdBootstrapSnapshot,
  BrowserReconnectStatus,
  BrowserReconnectSnapshot,
} from '../../src/domain/renderer-invoke.js';
import { buildBrowserColdBootstrapProjectionFromJson } from '../../src/domain/browser-cold-bootstrap-projection-builder.js';
import {
  deriveRepoNameFromSshUrl,
  isGitSshUrl,
  parseGitSshHost,
} from '../../src/lib/git-ssh-url.js';
import { isFiniteNumber } from '../../src/lib/type-guards.js';
import { IPC } from './channels.js';
import { listAgents } from './agents.js';
import { BadRequestError } from './errors.js';
import type { IpcHandlerMap } from './handlers.js';
import type { HandlerContext } from './handler-context.js';
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
import { getActiveAgentIds, getAgentMeta } from './pty.js';
import {
  loadAppStateForEnv,
  loadArenaDataForEnv,
  loadWorkspaceStateForEnv,
  saveAppStateForEnv,
  saveArenaDataForEnv,
  saveWorkspaceStateForEnv,
} from './storage.js';
import {
  compareDirectoryNames,
  getErrorMessage,
  getHomeDirectory,
  getProjectBaseDirectory,
  normalizeAbsolutePath,
  resolveUserPath,
  validatePath,
  validateRelativePath,
} from './path-utils.js';
import { getRecentProjectPaths } from './recent-projects.js';
import { getAgentStatusSnapshot } from './agent-status.js';
import { readMarkdownFileForWorktree } from './markdown-files.js';
import { inspectArenaCompetitor } from './arena-competitors.js';
import { isPlanRelativePath, readPlanForWorktree } from './plans.js';
import { getServerStateBootstrap } from './server-state-bootstrap.js';
import { handleRendererLogPayload } from '../log.js';
import {
  getTaskCommandControllers,
  getTaskCommandControllerStateVersion,
} from './task-command-leases.js';
import { defineIpcHandler } from './typed-handler.js';
import {
  assertBoolean,
  assertInt,
  assertOptionalBoolean,
  assertOptionalString,
  assertString,
  assertStringArray,
  assertTcpPortNumber,
} from './validate.js';

const execFileAsync = promisify(execFile);

const RECONNECT_SNAPSHOT_CACHE_TTL_MS = 5_000;

interface CachedReconnectSnapshot {
  expiresAt: number;
  promise: Promise<ReconnectSavedStateSnapshot>;
}

type ReconnectSavedStateSnapshot = Pick<
  BrowserReconnectSnapshot,
  'appStateJson' | 'workspaceRevision' | 'workspaceStateJson'
>;

interface SavedStateSyncOptions {
  syncProjectBaseBranchesFromJson: (json: string) => void;
  syncTaskConvergenceFromJson: (json: string) => void;
  syncTaskNamesFromJson: (json: string) => void;
  syncTaskReviewSignalsFromJson: (json: string) => void;
  syncTaskStepsFromJson: (json: string) => void;
  syncTaskWorkflowWorktreesFromJson: (json: string) => void;
}

interface LoadedWorkspaceState {
  json: string | null;
  revision: number;
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

function assertOptionalChoiceIndex(
  value: unknown,
  label: 'cancelIndex' | 'defaultIndex',
  choiceCount: number,
): void {
  if (value === undefined) {
    return;
  }

  assertInt(value, label);
  if (value < 0 || value >= choiceCount) {
    throw new BadRequestError(`${label} must reference choices`);
  }
}

function cacheReconnectSnapshot(
  userDataPath: string,
  promise: Promise<ReconnectSavedStateSnapshot>,
  expiresAt: number,
): void {
  reconnectSnapshotCacheByUserDataPath.set(userDataPath, {
    expiresAt,
    promise,
  });
}

function clearReconnectSnapshotIfCurrent(
  userDataPath: string,
  promise: Promise<ReconnectSavedStateSnapshot>,
): void {
  const current = reconnectSnapshotCacheByUserDataPath.get(userDataPath);
  if (current?.promise === promise) {
    reconnectSnapshotCacheByUserDataPath.delete(userDataPath);
  }
}

function cloneReconnectSavedStateSnapshot(
  snapshot: ReconnectSavedStateSnapshot,
): ReconnectSavedStateSnapshot {
  const clone: ReconnectSavedStateSnapshot = {
    appStateJson: snapshot.appStateJson,
  };
  if (snapshot.workspaceRevision !== undefined) {
    clone.workspaceRevision = snapshot.workspaceRevision;
  }
  if (snapshot.workspaceStateJson !== undefined) {
    clone.workspaceStateJson = snapshot.workspaceStateJson;
  }
  return clone;
}

function cloneBrowserReconnectSnapshot(
  snapshot: BrowserReconnectSnapshot,
): BrowserReconnectSnapshot {
  return {
    ...(snapshot.agentGenerations ? { agentGenerations: { ...snapshot.agentGenerations } } : {}),
    appStateJson: snapshot.appStateJson,
    runningAgentIds: [...snapshot.runningAgentIds],
    taskCommandControllers: snapshot.taskCommandControllers
      ? snapshot.taskCommandControllers.map((controller) => ({ ...controller }))
      : [],
    ...(snapshot.taskCommandControllerVersion !== undefined
      ? { taskCommandControllerVersion: snapshot.taskCommandControllerVersion }
      : {}),
    ...(snapshot.workspaceRevision !== undefined
      ? { workspaceRevision: snapshot.workspaceRevision }
      : {}),
    ...(snapshot.workspaceStateJson !== undefined
      ? { workspaceStateJson: snapshot.workspaceStateJson }
      : {}),
  };
}

function loadSavedAppStateJson(
  context: HandlerContext,
  options: SavedStateSyncOptions,
): string | null {
  const json = loadAppStateForEnv(context);
  if (!json) {
    return null;
  }

  syncSavedStateJson(json, options);
  return json;
}

function loadSavedWorkspaceState(
  context: HandlerContext,
  options: SavedStateSyncOptions,
): LoadedWorkspaceState {
  const savedWorkspace = loadWorkspaceStateForEnv(context);
  if (savedWorkspace) {
    syncSavedStateJson(savedWorkspace.json, options);
    return savedWorkspace;
  }

  const legacyJson = loadSavedAppStateJson(context, options);
  return {
    json: legacyJson,
    revision: 0,
  };
}

function syncSavedStateJson(json: string, options: SavedStateSyncOptions): void {
  options.syncTaskNamesFromJson(json);
  options.syncTaskConvergenceFromJson(json);
  options.syncTaskReviewSignalsFromJson(json);
  options.syncTaskStepsFromJson(json);
  options.syncTaskWorkflowWorktreesFromJson(json);
  options.syncProjectBaseBranchesFromJson(json);
}

function createBrowserReconnectSavedStateSnapshot(
  context: HandlerContext,
  options: SavedStateSyncOptions,
): ReconnectSavedStateSnapshot {
  const appStateJson = loadSavedAppStateJson(context, options);
  const savedWorkspace = loadWorkspaceStateForEnv(context);
  if (savedWorkspace) {
    syncSavedStateJson(savedWorkspace.json, options);
  }

  const workspace = savedWorkspace ?? {
    json: appStateJson,
    revision: 0,
  };

  return {
    appStateJson,
    workspaceRevision: workspace.revision,
    workspaceStateJson: workspace.json,
  };
}

function createBrowserReconnectSnapshot(
  savedState: ReconnectSavedStateSnapshot,
): BrowserReconnectSnapshot {
  const runningAgentIds = getActiveAgentIds();
  return {
    ...savedState,
    agentGenerations: Object.fromEntries(
      runningAgentIds.map((agentId) => [agentId, getAgentMeta(agentId)?.generation ?? 0]),
    ),
    runningAgentIds,
    taskCommandControllers: getTaskCommandControllers(),
    taskCommandControllerVersion: getTaskCommandControllerStateVersion(),
  };
}

function getBrowserReconnectStatus(context: HandlerContext): BrowserReconnectStatus {
  const workspace = loadWorkspaceStateForEnv(context);
  return {
    runningAgentIds: getActiveAgentIds(),
    taskCommandControllerVersion: getTaskCommandControllerStateVersion(),
    workspaceRevision: workspace?.revision ?? 0,
  };
}

async function createBrowserColdBootstrapSnapshot(
  context: HandlerContext,
  options: SavedStateSyncOptions,
): Promise<BrowserColdBootstrapSnapshot> {
  const workspace = loadSavedWorkspaceState(context, options);
  const remoteAccess = requireRemoteAccess(context);
  const availableAgents = await listAgents();
  const bootstrapContext = {
    getRemoteStatus: () => remoteAccess.status(),
  };
  const serverStateBootstrap =
    'getStatusVersion' in remoteAccess
      ? getServerStateBootstrap({
          ...bootstrapContext,
          getRemoteStatusVersion: () => remoteAccess.getStatusVersion(),
        })
      : getServerStateBootstrap(bootstrapContext);

  return {
    serverStateBootstrap: serverStateBootstrap.filter(
      (snapshot) => snapshot.category !== 'peer-presence',
    ),
    workspaceRevision: workspace.revision,
    workspaceProjection: buildBrowserColdBootstrapProjectionFromJson(workspace.json, {
      currentAvailableAgents: availableAgents,
      currentCustomAgents: [],
    }),
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
    return cached.promise.then((snapshot) =>
      cloneBrowserReconnectSnapshot(createBrowserReconnectSnapshot(snapshot)),
    );
  }

  recordReconnectSnapshotCacheMiss();
  const promise = Promise.resolve(createBrowserReconnectSavedStateSnapshot(context, options)).then(
    (snapshot) => cloneReconnectSavedStateSnapshot(snapshot),
  );
  cacheReconnectSnapshot(context.userDataPath, promise, now + RECONNECT_SNAPSHOT_CACHE_TTL_MS);

  return promise
    .catch((error) => {
      clearReconnectSnapshotIfCurrent(context.userDataPath, promise);
      throw error;
    })
    .then((snapshot) => cloneBrowserReconnectSnapshot(createBrowserReconnectSnapshot(snapshot)));
}

const HOST_KEY_FAILURE_PATTERN = /Host key verification failed/i;
const GIT_NOT_INSTALLED_ERROR = 'git is not installed or not available on PATH';
const SSH_KEYSCAN_NOT_INSTALLED_ERROR = 'ssh-keyscan is not installed or not available on PATH';
const SSH_KEYGEN_NOT_INSTALLED_ERROR = 'ssh-keygen is not installed or not available on PATH';

export function isHostKeyVerificationFailure(stderr: string): boolean {
  return HOST_KEY_FAILURE_PATTERN.test(stderr);
}

function isMissingCommandError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function removeCloneDestination(destination: string): void {
  try {
    fs.rmSync(destination, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function getGitCloneSshCommand(acceptHostKey: boolean | undefined): string {
  if (acceptHostKey) {
    return 'ssh -o StrictHostKeyChecking=accept-new';
  }

  return 'ssh -o BatchMode=yes';
}

export async function fetchHostFingerprint(hostname: string, port: number): Promise<string> {
  try {
    const keyscan = await execFileAsync('ssh-keyscan', ['-p', String(port), hostname], {
      timeout: 15_000,
    });
    const keys = keyscan.stdout.trim();
    if (!keys) return 'Could not retrieve host key';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-ssh-'));
    const tmpFile = path.join(tmpDir, 'hostkeys');
    try {
      fs.writeFileSync(tmpFile, keys);
      let keygen;
      try {
        keygen = await execFileAsync('ssh-keygen', ['-lf', tmpFile], { timeout: 5_000 });
      } catch (error) {
        if (isMissingCommandError(error)) {
          return SSH_KEYGEN_NOT_INSTALLED_ERROR;
        }
        throw error;
      }
      return keygen.stdout.trim() || 'Could not compute fingerprint';
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    if (isMissingCommandError(error)) {
      return SSH_KEYSCAN_NOT_INSTALLED_ERROR;
    }
    return 'Could not retrieve host key fingerprint';
  }
}

export type CloneGitRepoResult =
  | { status: 'cloned'; repoRoot: string }
  | {
      status: 'host_key_confirmation_required';
      hostname: string;
      port: number;
      fingerprint: string;
    };

export async function cloneGitRepo(
  url: string,
  projectBaseDir: string,
  acceptHostKey?: boolean,
): Promise<CloneGitRepoResult> {
  const trimmedUrl = url.trim();
  if (!isGitSshUrl(trimmedUrl)) {
    throw new BadRequestError(
      'url must be a valid git SSH URL (git@host:path or ssh://user@host/path)',
    );
  }

  const repoName = deriveRepoNameFromSshUrl(trimmedUrl);
  if (!repoName) {
    throw new BadRequestError('Could not derive repository name from URL');
  }

  const destinationRoot = path.resolve(projectBaseDir);
  const destination = path.join(destinationRoot, repoName);

  if (fs.existsSync(destination)) {
    throw new BadRequestError(`Destination already exists: ${destination}`);
  }

  const sshCommand = getGitCloneSshCommand(acceptHostKey);

  try {
    fs.mkdirSync(destinationRoot, { recursive: true });
    await execFileAsync('git', ['clone', trimmedUrl, destination], {
      cwd: destinationRoot,
      timeout: 120_000,
      env: {
        ...process.env,
        GIT_SSH_COMMAND: sshCommand,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  } catch (error) {
    if (isMissingCommandError(error)) {
      throw new BadRequestError(GIT_NOT_INSTALLED_ERROR);
    }

    const stderr = (error as { stderr?: string }).stderr ?? '';
    const msg = error instanceof Error ? error.message : String(error);

    if (!acceptHostKey && isHostKeyVerificationFailure(stderr + msg)) {
      removeCloneDestination(destination);

      const host = parseGitSshHost(trimmedUrl);
      if (!host) {
        throw new BadRequestError(`Host key verification failed but could not parse host from URL`);
      }

      const fingerprint = await fetchHostFingerprint(host.hostname, host.port);
      return {
        status: 'host_key_confirmation_required',
        hostname: host.hostname,
        port: host.port,
        fingerprint,
      };
    }

    removeCloneDestination(destination);
    throw new BadRequestError(`git clone failed: ${msg}`);
  }

  if (!fs.existsSync(path.join(destination, '.git'))) {
    throw new BadRequestError('Clone completed but destination is not a git repository');
  }

  return { status: 'cloned', repoRoot: destination };
}

export function createSystemIpcHandlers(
  context: HandlerContext,
  options: SavedStateSyncOptions & {
    getTaskMetadata?: (
      taskId: string,
      agentId: string,
    ) => import('../../src/domain/server-state.js').RemoteAgentTaskMeta | null;
    getTaskName: (taskId: string) => string;
  },
): IpcHandlerMap {
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
    [IPC.ReadMarkdownFile]: defineIpcHandler<IPC.ReadMarkdownFile>(IPC.ReadMarkdownFile, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      validateRelativePath(request.relativePath, 'relativePath');
      return readMarkdownFileForWorktree(request.worktreePath, request.relativePath);
    }),

    [IPC.SaveAppState]: defineIpcHandler<IPC.SaveAppState>(IPC.SaveAppState, (args) => {
      const request = args;
      assertString(request.json, 'json');
      assertOptionalString(request.sourceId, 'sourceId');
      syncSavedStateJson(request.json, options);
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

    [IPC.SaveWorkspaceState]: defineIpcHandler<IPC.SaveWorkspaceState>(
      IPC.SaveWorkspaceState,
      (args) => {
        const request = args;
        assertString(request.json, 'json');
        assertOptionalString(request.sourceId, 'sourceId');

        const current = loadWorkspaceStateForEnv(context);
        const currentRevision = current?.revision ?? 0;
        const requestedBaseRevision = isFiniteNumber(request.baseRevision)
          ? Math.max(0, Math.floor(request.baseRevision))
          : currentRevision;

        if (requestedBaseRevision !== currentRevision) {
          throw new BadRequestError('Workspace state revision conflict');
        }

        syncSavedStateJson(request.json, options);

        const nextRevision = currentRevision + 1;
        clearReconnectSnapshotCache(context.userDataPath);
        saveWorkspaceStateForEnv(context, request.json, nextRevision);
        context.emitIpcEvent?.(IPC.WorkspaceStateChanged, {
          revision: nextRevision,
          savedAt: Date.now(),
          sourceId: request.sourceId ?? null,
        });
        return { revision: nextRevision };
      },
    ),

    [IPC.LoadWorkspaceState]: () => {
      return loadSavedWorkspaceState(context, options);
    },

    [IPC.GetBrowserReconnectStatus]: () => getBrowserReconnectStatus(context),
    [IPC.GetBrowserReconnectSnapshot]: () => getBrowserReconnectSnapshot(context, options),
    [IPC.GetBrowserColdBootstrap]: () => createBrowserColdBootstrapSnapshot(context, options),

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

    [IPC.InspectArenaCompetitor]: defineIpcHandler<IPC.InspectArenaCompetitor>(
      IPC.InspectArenaCompetitor,
      async (args) => {
        const request = args;
        assertString(request.commandTemplate, 'commandTemplate');
        return inspectArenaCompetitor(request.commandTemplate);
      },
    ),

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
    [IPC.GetProjectBasePath]: () => getProjectBaseDirectory(),

    [IPC.GetRecentProjects]: async () => {
      const homeDir = getHomeDirectory();
      const projectBaseDir = getProjectBaseDirectory();
      return getRecentProjectPaths(homeDir, projectBaseDir);
    },

    [IPC.ResolveClipboardPaste]: async () =>
      context.clipboard?.resolveClipboardPaste?.() ?? { kind: 'empty' },

    [IPC.SaveClipboardImage]: async () => context.clipboard?.saveClipboardImage() ?? null,

    [IPC.SaveDroppedImage]: defineIpcHandler<IPC.SaveDroppedImage>(
      IPC.SaveDroppedImage,
      async (args) => {
        const request = args;
        assertString(request.data, 'data');
        assertOptionalString(request.name, 'name');
        const saveRequest: { data: string; name?: string } = {
          data: request.data,
        };
        if (request.name !== undefined) {
          saveRequest.name = request.name;
        }

        return context.clipboard?.saveDroppedImage?.(saveRequest) ?? null;
      },
    ),

    [IPC.LogFromRenderer]: defineIpcHandler<IPC.LogFromRenderer>(IPC.LogFromRenderer, (args) => {
      handleRendererLogPayload(args);
    }),

    [IPC.CloneGitRepo]: defineIpcHandler<IPC.CloneGitRepo>(IPC.CloneGitRepo, async (args) => {
      const request = args;
      assertString(request.url, 'url');
      assertOptionalBoolean(request.acceptHostKey, 'acceptHostKey');
      const projectBaseDir = getProjectBaseDirectory();
      return cloneGitRepo(request.url, projectBaseDir, request.acceptHostKey);
    }),

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
    [IPC.WindowCloseHandled]: () => requireWindow(context).closeHandled(),
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

    [IPC.DialogChoose]: defineIpcHandler<IPC.DialogChoose>(IPC.DialogChoose, async (args) => {
      const request = args;
      assertString(request.message, 'message');
      assertStringArray(request.choices, 'choices');
      if (request.choices.length < 2) {
        throw new BadRequestError('choices must include at least two entries');
      }
      if (request.title !== undefined) assertString(request.title, 'title');
      if (request.kind !== undefined) assertString(request.kind, 'kind');
      assertOptionalChoiceIndex(request.defaultIndex, 'defaultIndex', request.choices.length);
      assertOptionalChoiceIndex(request.cancelIndex, 'cancelIndex', request.choices.length);
      return requireDialog(context).choose({
        message: request.message,
        choices: request.choices,
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.kind !== undefined ? { kind: request.kind } : {}),
        ...(request.defaultIndex !== undefined ? { defaultIndex: request.defaultIndex } : {}),
        ...(request.cancelIndex !== undefined ? { cancelIndex: request.cancelIndex } : {}),
      });
    }),

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
          assertTcpPortNumber(request.port, 'port');
        }

        return startRemoteAccessWorkflow(requireRemoteAccess(context), {
          getTaskName: options.getTaskName,
          getAgentStatus: getAgentStatusSnapshot,
          ...(options.getTaskMetadata ? { getTaskMetadata: options.getTaskMetadata } : {}),
          ...(request.port !== undefined ? { port: request.port } : {}),
        });
      },
    ),

    [IPC.StopRemoteServer]: async () => stopRemoteAccessWorkflow(requireRemoteAccess(context)),
    [IPC.GetRemoteStatus]: () => getRemoteAccessStatusWorkflow(requireRemoteAccess(context)),
  };
}
