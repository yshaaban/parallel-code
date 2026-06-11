import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import type {
  BrowserColdBootstrapPlanContent,
  BrowserColdBootstrapSnapshot,
  BrowserReconnectStatus,
  BrowserReconnectSnapshot,
} from '../../src/domain/renderer-invoke.js';
import type { BrowserColdBootstrapProjection } from '../../src/domain/browser-cold-bootstrap.js';
import { buildBrowserColdBootstrapProjectionFromJson } from '../../src/domain/browser-cold-bootstrap-projection-builder.js';
import {
  deriveRepoNameFromSshUrl,
  isGitSshUrl,
  parseGitSshHost,
} from '../../src/lib/git-ssh-url.js';
import { isFiniteNumber, isRecord } from '../../src/lib/type-guards.js';
import { IPC } from './channels.js';
import { getAgentDefsWithLastKnownAvailability } from './agents.js';
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
  recordReconnectSnapshotRevisionSkip,
  resetBackendRuntimeDiagnostics,
} from './runtime-diagnostics.js';
import { getActiveAgentIds, getAgentMeta } from './pty.js';
import { getServerInstanceId } from './server-instance.js';
import { getBackendClientSelectedTaskId, setBackendClientFocus } from './backend-work-queue.js';
import {
  findRegisteredGitWatcherRequestForTask,
  scheduleGitStatusRefresh,
} from './git-status-workflows.js';
import { createSavedStateDocument, type SavedStateDocument } from './saved-state-document.js';
import {
  loadAppStateDocumentForEnv,
  loadArenaDataForEnv,
  loadWorkspaceStateDocumentForEnv,
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
import { discoverProjects, getRecentProjectPaths } from './recent-projects.js';
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

const ELECTRON_FOCUS_CLIENT_ID = 'electron-renderer';
const COLD_BOOTSTRAP_PLAN_CONTENT_MAX_TASKS = 30;
const COLD_BOOTSTRAP_PLAN_CONTENT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

// Revision-keyed reconnect saved-state cache: entries have no TTL because every
// save path in this process invalidates them; the cached snapshot carries the
// workspaceRevision used for the reconnect revision-skip comparison.
interface CachedReconnectSnapshot {
  promise: Promise<ReconnectSavedStateSnapshot>;
}

type ReconnectSavedStateSnapshot = Pick<
  BrowserReconnectSnapshot,
  'appStateJson' | 'workspaceRevision' | 'workspaceStateJson'
>;

export interface SavedStateSyncOptions {
  syncProjectBaseBranchesFromJson: (state: SavedStateDocument) => void;
  syncTaskConvergenceFromJson: (state: SavedStateDocument) => void;
  syncTaskNamesFromJson: (state: SavedStateDocument) => void;
  syncTaskReviewSignalsFromJson: (state: SavedStateDocument) => void;
  syncTaskStepsFromJson: (state: SavedStateDocument) => void;
  syncTaskWorkflowWorktreesFromJson: (state: SavedStateDocument) => void;
}

interface LoadedWorkspaceState {
  json: string | null;
  revision: number;
}

function clearReconnectSnapshotCache(
  cache: Map<string, CachedReconnectSnapshot>,
  userDataPath: string,
): void {
  if (cache.has(userDataPath)) {
    recordReconnectSnapshotInvalidation();
  }
  cache.delete(userDataPath);
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
  cache: Map<string, CachedReconnectSnapshot>,
  userDataPath: string,
  promise: Promise<ReconnectSavedStateSnapshot>,
): void {
  cache.set(userDataPath, {
    promise,
  });
}

function clearReconnectSnapshotIfCurrent(
  cache: Map<string, CachedReconnectSnapshot>,
  userDataPath: string,
  promise: Promise<ReconnectSavedStateSnapshot>,
): void {
  const current = cache.get(userDataPath);
  if (current?.promise === promise) {
    cache.delete(userDataPath);
  }
}

function cloneReconnectSavedStateSnapshot(
  snapshot: ReconnectSavedStateSnapshot,
): ReconnectSavedStateSnapshot {
  const clone: ReconnectSavedStateSnapshot = {};
  if (snapshot.appStateJson !== undefined) {
    clone.appStateJson = snapshot.appStateJson;
  }
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
    ...(snapshot.appStateJson !== undefined ? { appStateJson: snapshot.appStateJson } : {}),
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
  const document = loadAppStateDocumentForEnv(context);
  if (!document) {
    return null;
  }

  syncSavedStateDocument(document, options);
  return document.json;
}

function loadSavedWorkspaceState(
  context: HandlerContext,
  options: SavedStateSyncOptions,
): LoadedWorkspaceState {
  const savedWorkspace = loadWorkspaceStateDocumentForEnv(context);
  if (savedWorkspace) {
    syncSavedStateDocument(savedWorkspace.document, options);
    return {
      json: savedWorkspace.document.json,
      revision: savedWorkspace.revision,
    };
  }

  const legacyJson = loadSavedAppStateJson(context, options);
  return {
    json: legacyJson,
    revision: 0,
  };
}

function syncSavedStateJson(json: string, options: SavedStateSyncOptions): void {
  syncSavedStateDocument(createSavedStateDocument(json), options);
}

function syncSavedStateDocument(state: SavedStateDocument, options: SavedStateSyncOptions): void {
  options.syncTaskNamesFromJson(state);
  options.syncTaskConvergenceFromJson(state);
  options.syncTaskReviewSignalsFromJson(state);
  options.syncTaskStepsFromJson(state);
  options.syncTaskWorkflowWorktreesFromJson(state);
  options.syncProjectBaseBranchesFromJson(state);
}

function createBrowserReconnectSavedStateSnapshot(
  context: HandlerContext,
  options: SavedStateSyncOptions,
): ReconnectSavedStateSnapshot {
  const savedWorkspace = loadWorkspaceStateDocumentForEnv(context);
  if (savedWorkspace) {
    syncSavedStateDocument(savedWorkspace.document, options);
    return {
      workspaceRevision: savedWorkspace.revision,
      workspaceStateJson: savedWorkspace.document.json,
    };
  }

  // Legacy fallback: appStateJson is shipped only when no workspace-state file
  // exists, so reconnect no longer carries two full serialized state copies.
  // workspaceRevision 0 is not a real revision: legacy app-state saves mutate
  // the file without bumping it, so revision 0 must never satisfy the
  // revision-keyed skip below.
  const appStateJson = loadSavedAppStateJson(context, options);
  return {
    appStateJson,
    workspaceRevision: 0,
  };
}

function createBrowserReconnectSnapshot(
  savedState: ReconnectSavedStateSnapshot,
  knownWorkspaceRevision: number | undefined,
): BrowserReconnectSnapshot {
  const runningAgentIds = getActiveAgentIds();
  // The skip requires a real versioned workspace file: SaveWorkspaceState mints
  // revisions starting at 1, so revision 0 means the unversioned legacy
  // app-state fallback, which can change without a revision bump and therefore
  // never proves no-change.
  const skipSavedStatePayload =
    knownWorkspaceRevision !== undefined &&
    savedState.workspaceRevision !== undefined &&
    savedState.workspaceRevision > 0 &&
    savedState.workspaceRevision === knownWorkspaceRevision;
  if (skipSavedStatePayload) {
    recordReconnectSnapshotRevisionSkip();
  }

  return {
    ...(skipSavedStatePayload ? { workspaceRevision: knownWorkspaceRevision } : savedState),
    agentGenerations: getAgentGenerationMap(runningAgentIds),
    runningAgentIds,
    taskCommandControllers: getTaskCommandControllers(),
    taskCommandControllerVersion: getTaskCommandControllerStateVersion(),
  };
}

function getAgentGenerationMap(agentIds: string[]): Record<string, number> {
  return Object.fromEntries(
    agentIds.map((agentId) => [agentId, getAgentMeta(agentId)?.generation ?? 0]),
  );
}

function getBrowserReconnectStatus(context: HandlerContext): BrowserReconnectStatus {
  const runningAgentIds = getActiveAgentIds();
  const workspace = loadWorkspaceStateForEnv(context);
  return {
    agentGenerations: getAgentGenerationMap(runningAgentIds),
    runningAgentIds,
    serverInstanceId: getServerInstanceId(),
    taskCommandControllerVersion: getTaskCommandControllerStateVersion(),
    workspaceRevision: workspace?.revision ?? 0,
  };
}

// Bounded synchronous plan-content fold for the cold-bootstrap payload: exact
// persisted planRelativePath reads only, visible (taskOrder) tasks only, capped
// by task count and total bytes, per-file errors swallowed.
function collectColdBootstrapPlanContents(
  projection: BrowserColdBootstrapProjection,
): BrowserColdBootstrapPlanContent[] {
  const planContents: BrowserColdBootstrapPlanContent[] = [];
  let totalBytes = 0;

  for (const taskId of projection.taskOrder) {
    if (planContents.length >= COLD_BOOTSTRAP_PLAN_CONTENT_MAX_TASKS) {
      break;
    }

    const task = projection.tasks[taskId];
    if (!task?.worktreePath || !task.planRelativePath) {
      continue;
    }
    if (!isPlanRelativePath(task.planRelativePath)) {
      continue;
    }

    try {
      const plan = readPlanForWorktree(task.worktreePath, task.planRelativePath);
      if (!plan) {
        continue;
      }

      const contentBytes = Buffer.byteLength(plan.content, 'utf8');
      if (totalBytes + contentBytes > COLD_BOOTSTRAP_PLAN_CONTENT_MAX_TOTAL_BYTES) {
        break;
      }

      totalBytes += contentBytes;
      planContents.push({
        content: plan.content,
        fileName: plan.fileName,
        relativePath: plan.relativePath,
        taskId,
      });
    } catch {
      // Over-cap or unreadable plans stay on the lazy ReadPlanContent path.
    }
  }

  return planContents;
}

function collectColdBootstrapProjectPathsExist(
  projection: BrowserColdBootstrapProjection,
): Record<string, boolean> {
  const projectPathsExist: Record<string, boolean> = {};
  for (const project of projection.projects) {
    if (project.path in projectPathsExist) {
      continue;
    }

    try {
      projectPathsExist[project.path] = fs.existsSync(project.path);
    } catch {
      projectPathsExist[project.path] = false;
    }
  }

  return projectPathsExist;
}

// Synchronous by design: the cold-bootstrap handler must stay free of process
// spawns and probing. Agent defs ship with last-known sticky availability.
function createBrowserColdBootstrapSnapshot(
  context: HandlerContext,
  options: SavedStateSyncOptions,
): BrowserColdBootstrapSnapshot {
  const workspace = loadSavedWorkspaceState(context, options);
  const remoteAccess = requireRemoteAccess(context);
  const availableAgents = getAgentDefsWithLastKnownAvailability();
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
  const workspaceProjection = buildBrowserColdBootstrapProjectionFromJson(workspace.json, {
    currentAvailableAgents: availableAgents,
    currentCustomAgents: [],
  });

  return {
    planContents: collectColdBootstrapPlanContents(workspaceProjection),
    projectPathsExist: collectColdBootstrapProjectPathsExist(workspaceProjection),
    serverStateBootstrap: serverStateBootstrap.filter(
      (snapshot) => snapshot.category !== 'peer-presence',
    ),
    workspaceRevision: workspace.revision,
    workspaceProjection,
  };
}

function getBrowserReconnectSnapshot(
  context: HandlerContext,
  options: SavedStateSyncOptions,
  cache: Map<string, CachedReconnectSnapshot>,
  knownWorkspaceRevision: number | undefined,
): Promise<BrowserReconnectSnapshot> {
  const cached = cache.get(context.userDataPath);
  if (cached) {
    recordReconnectSnapshotCacheHit();
    return cached.promise.then((snapshot) =>
      cloneBrowserReconnectSnapshot(
        createBrowserReconnectSnapshot(snapshot, knownWorkspaceRevision),
      ),
    );
  }

  recordReconnectSnapshotCacheMiss();
  const promise = Promise.resolve(createBrowserReconnectSavedStateSnapshot(context, options)).then(
    (snapshot) => cloneReconnectSavedStateSnapshot(snapshot),
  );
  cacheReconnectSnapshot(cache, context.userDataPath, promise);

  return promise
    .catch((error) => {
      clearReconnectSnapshotIfCurrent(cache, context.userDataPath, promise);
      throw error;
    })
    .then((snapshot) =>
      cloneBrowserReconnectSnapshot(
        createBrowserReconnectSnapshot(snapshot, knownWorkspaceRevision),
      ),
    );
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

interface DiscoveredProjectsRequestOptions {
  force: boolean;
}

function parseDiscoveredProjectsRequest(args: unknown): DiscoveredProjectsRequestOptions {
  if (args === undefined) {
    return { force: false };
  }

  if (!isRecord(args)) {
    throw new BadRequestError('get_discovered_projects payload must be an object');
  }

  if (args.force === undefined) {
    return { force: false };
  }

  assertBoolean(args.force, 'force');
  return { force: args.force };
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
  const reconnectSnapshotCacheByUserDataPath = new Map<string, CachedReconnectSnapshot>();

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
      clearReconnectSnapshotCache(reconnectSnapshotCacheByUserDataPath, context.userDataPath);
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
        clearReconnectSnapshotCache(reconnectSnapshotCacheByUserDataPath, context.userDataPath);
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

    [IPC.ReportClientTaskFocus]: defineIpcHandler<IPC.ReportClientTaskFocus>(
      IPC.ReportClientTaskFocus,
      (request) => {
        if (request.selectedTaskId !== null) {
          assertString(request.selectedTaskId, 'selectedTaskId');
        }
        assertStringArray(request.visibleTaskIds, 'visibleTaskIds');
        if (request.focusedChannelIds !== undefined) {
          assertStringArray(request.focusedChannelIds, 'focusedChannelIds');
        }

        const transportClientId = (request as { clientId?: unknown }).clientId;
        const clientId =
          typeof transportClientId === 'string' && transportClientId.length > 0
            ? transportClientId
            : ELECTRON_FOCUS_CLIENT_ID;
        // The focus registry is the single owner of per-client focus state
        // (TTL pruning plus disconnect cleanup), so the previous selection is
        // read from it instead of a handler-local map that nothing prunes.
        const previousSelectedTaskId = getBackendClientSelectedTaskId(clientId);
        setBackendClientFocus(clientId, {
          selectedTaskId: request.selectedTaskId,
          visibleTaskIds: request.visibleTaskIds,
          ...(request.focusedChannelIds !== undefined
            ? { focusedChannelIds: request.focusedChannelIds }
            : {}),
        });

        if (request.selectedTaskId && request.selectedTaskId !== previousSelectedTaskId) {
          const watcher = findRegisteredGitWatcherRequestForTask(request.selectedTaskId);
          if (watcher) {
            scheduleGitStatusRefresh(context, watcher.worktreePath, watcher.baseBranch, 'selected');
          }
        }

        return null;
      },
    ),

    [IPC.GetBrowserReconnectStatus]: () => getBrowserReconnectStatus(context),
    [IPC.GetBrowserReconnectSnapshot]: defineIpcHandler<IPC.GetBrowserReconnectSnapshot>(
      IPC.GetBrowserReconnectSnapshot,
      (args) => {
        const request = args;
        if (request.knownWorkspaceRevision !== undefined) {
          if (!isFiniteNumber(request.knownWorkspaceRevision)) {
            throw new BadRequestError('knownWorkspaceRevision must be a finite number');
          }
        }

        return getBrowserReconnectSnapshot(
          context,
          options,
          reconnectSnapshotCacheByUserDataPath,
          request.knownWorkspaceRevision,
        );
      },
    ),
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

    [IPC.GetDiscoveredProjects]: async (args?: unknown) => {
      const { force } = parseDiscoveredProjectsRequest(args);
      const homeDir = getHomeDirectory();
      const projectBaseDir = getProjectBaseDirectory();
      return discoverProjects(homeDir, projectBaseDir, { force });
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
