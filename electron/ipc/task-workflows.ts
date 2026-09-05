import fs from 'fs';
import path from 'path';
import { performance } from 'node:perf_hooks';
import type { AgentSessionLaunchReason } from '../../src/domain/agent-session-operation.js';

import { IPC } from './channels.js';
import { normalizeAgentRunnerProfileConfig } from './agent-runner-handlers.js';
import { resolveHydraAdapterLaunch } from './hydra-adapter.js';
import {
  cleanupPendingDockerAgentRunnerBuilds,
  createDockerAgentRunnerLaunch,
} from './agent-runner-docker.js';
import { removeAgentSupervision, removeTaskSupervision } from './agent-supervision.js';
import { removeGitStatusSnapshot } from './git-status-state.js';
import { startTaskGitStatusMonitoring, stopTaskGitStatusWatcher } from './git-status-workflows.js';
import { ensurePlansDirectory, startPlanWatcher, stopPlanWatcher } from './plans.js';
import {
  attachExistingAgentSessionExact,
  countRunningAgents,
  getAgentLifecycleGeneration,
  getAgentMeta,
  hasAgentSession,
  killAllAgentsAndWaitForRunnerCleanup,
  killAgentAndWaitForRunnerCleanup,
  killTaskAgentsAndWaitForRunnerCleanup,
  revokeAgentContentAuthority,
  revokeAllAgentContentAuthorities,
  revokeTaskAgentContentAuthorities,
  spawnAgent as spawnPtyAgent,
  type AgentSpawnDisposition,
} from './pty.js';
import {
  recordAgentSessionSpawnAdmissionState,
  recordAgentSessionSpawnAdmissionWait,
  recordAgentSessionSpawnDuration,
} from './runtime-diagnostics.js';
import {
  registerTaskConvergenceTask,
  removeTaskConvergence,
  scheduleTaskConvergenceRefresh,
} from './task-convergence-state.js';
import {
  registerTaskReviewTask,
  removeTaskReview,
  scheduleTaskReviewRefresh,
} from './task-review-state.js';
import {
  registerTaskReviewSignalsTask,
  removeTaskReviewSignals,
  scheduleTaskReviewSignalsRefresh,
} from './task-review-signals.js';
import {
  assertTaskStepsPathAvailable,
  registerTaskStepsTask,
  removeTaskSteps,
} from './task-steps.js';
import { removeTaskPorts } from './task-ports.js';
import {
  destroyManagedTaskContainersByLabels,
  removeTaskContainerPreviewTargets,
} from './task-containers.js';
import { clearTaskCommandLeaseForTask } from './task-command-leases.js';
import { toSavedStateDocument, type SavedStateDocument } from './saved-state-document.js';
import {
  createCurrentBranchTask,
  createNonGitTask,
  createTask,
  deleteTask,
  importExistingWorktreeTask,
} from './tasks.js';
import { getGitRepoRoot, getMainBranch } from './git.js';
import { withRepositoryWorktreeLock } from './git-worktree-lock.js';
import {
  hasPreparedSharedRootTask,
  releasePreparedSharedRootTask,
  resetPreparedSharedRootTasksForTests,
} from './task-shared-root-admission.js';
import {
  encodeTaskWorktreeLinkRequestV1,
  type TaskWorktreeLinkRequestV1,
} from './git-worktree-symlinks.js';
import type { TaskCommandControllerSnapshot } from '../../src/domain/server-state.js';
import type { AgentRuntimeIdentity } from '../../src/domain/agent-runners.js';
import type {
  DeleteTaskCleanupWarning,
  DeleteTaskCleanupWarningKind,
} from '../../src/domain/task-cleanup.js';
import type { ProjectMode, TaskGitIsolationMode } from '../../src/store/types.js';
import type { CreateTaskResult } from '../../src/ipc/types.js';
import type { PendingTaskContentRootAdmission } from './terminal-root-authority.js';
import type {
  AgentSessionSpawnPermit,
  AgentSessionWriterPurpose,
  AgentSessionWriterRuntime,
} from './agent-session-writer-authority.js';

export interface TaskWorkflowContext {
  agentSessionWriter?: AgentSessionWriterRuntime;
  beginTaskContentRootAdmission?: (taskId: string) => PendingTaskContentRootAdmission | null;
  emitIpcEvent?: (channel: IPC, payload: unknown) => void;
  sendToChannel: (channelId: string, msg: unknown) => void;
}

export interface SpawnTaskAgentWorkflowRequest {
  adapter?: 'hydra';
  agentSessionLaunchReason?: AgentSessionLaunchReason;
  agentSessionOperationId?: string;
  agentSessionResumed?: boolean;
  agentId: string;
  args: string[];
  assertSpawnAdmitted?: () => void;
  baseBranch?: string;
  bindOutputChannel?: () => boolean;
  cols: number;
  command: string;
  contentAuthorityClass?: 'explicit-transient';
  contentAuthorityRoot?: string;
  cwd: string;
  env: unknown;
  isShell?: boolean;
  onOutput?: { __CHANNEL_ID__: string };
  projectMode?: ProjectMode;
  replaceExistingSession?: boolean;
  resumeOnStart?: boolean;
  rows: number;
  runnerProfile?: unknown;
  skipExistingSessionAttach?: boolean;
  startsTaskWatchers?: boolean;
  taskId: string;
  writerPermit?: AgentSessionSpawnPermit;
}

export interface OwnedTaskAgentSpawnRequest {
  operationId: string;
  purpose: Exclude<AgentSessionWriterPurpose, 'agent-session-operation'>;
}

export interface CreateTaskWorkflowRequest {
  agentDefId?: string;
  agentDefName?: string;
  baseBranch?: string;
  branchPrefix?: string;
  existingWorktreePath?: string;
  gitIsolation?: TaskGitIsolationMode;
  githubUrl?: string;
  name: string;
  operationId?: string;
  projectId: string;
  projectMode?: ProjectMode;
  projectRoot: string;
  stepsTracking?: boolean;
  symlinkDirs: string[];
}

export interface DeleteTaskWorkflowRequest {
  agentIds: string[];
  branchName: string;
  deleteBranch: boolean;
  projectRoot: string;
  taskId: string;
  worktreePath: string;
}

export interface CleanupTaskRuntimeWorkflowRequest {
  agentIds: string[];
  projectMode?: ProjectMode;
  removeTaskState?: boolean;
  taskId: string;
  worktreePath?: string;
}

export interface CleanupTaskRuntimeWorkflowResult {
  releasedTaskCommandController: TaskCommandControllerSnapshot | null;
}

export interface DeleteTaskWorkflowResult extends CleanupTaskRuntimeWorkflowResult {
  cleanupWarnings: DeleteTaskCleanupWarning[];
}

interface LegacyTaskInfrastructureCleanupRequest {
  agentIds: string[];
  branchName: string;
  deleteBranch: boolean;
  gitCleanup: 'managed-worktree' | 'preserve';
  projectMode: 'git' | 'non-git';
  projectRoot: string;
  taskId: string;
  worktreePath: string;
}

interface ResolvedSpawnLaunch {
  args: string[];
  command: string;
  cwd?: string;
  env: Record<string, string>;
  isInternalNodeProcess: boolean;
  onExitCleanup?: () => Promise<void> | void;
  runnerIdentity?: AgentRuntimeIdentity;
}

interface PendingTaskAgentSpawn {
  abortController: AbortController;
  agentId: string;
  completion?: Promise<unknown>;
  taskId: string;
}

interface PendingSpawnAdmission {
  operation: PendingTaskAgentSpawn;
  reject: (error: Error) => void;
  resolve: () => void;
  startedAt: number;
}

interface PreparedRunnerCleanup {
  agentId: string;
  cleanup: () => Promise<void> | void;
  cleanupPromise?: Promise<void>;
  taskId: string;
}

type TaskAgentStopWorkflowOwner =
  | {
      completion: Promise<void>;
      status: 'stopping';
      token: object;
    }
  | {
      status: 'failed';
    };

interface CreatedTaskRuntimeMetadata {
  branch_name: string;
  id: string;
  worktree_path: string;
}

interface TaskCreationOperation {
  fingerprint: string;
  promise: Promise<CreateTaskResult>;
}

// Runtime registrations and saved-state registrations have different lifetimes.
// A renderer save may legitimately lag a task creation or deletion, so replacing
// runtime state with every saved snapshot can otherwise reopen a worktree while
// its create workflow is still settling (or resurrect one after cleanup).
const liveTaskIdByWorktreeIdentity = new Map<string, Set<string>>();
const liveWorktreeIdentityByTaskId = new Map<string, string>();
const savedTaskIdByWorktreeIdentity = new Map<string, Set<string>>();
const savedWorktreeIdentityByTaskId = new Map<string, string>();
const sharedRootTaskIds = new Set<string>();
const removedTaskWorktreeIds = new Set<string>();
const pendingTaskWorktreeIdentities = new Set<string>();
const taskCreationOperationsById = new Map<string, TaskCreationOperation>();
const taskCreationOperationIdsByTaskId = new Map<string, Set<string>>();
const MAX_CONCURRENT_AGENT_SESSION_SPAWNS = 4;
const pendingTaskAgentSpawns = new Set<PendingTaskAgentSpawn>();
const latestTaskAgentSpawnByAgentId = new Map<string, PendingTaskAgentSpawn>();
// Hydra's daemon and durable coordination files belong to a checkout, not an agent.
// Ordinary CLI agents may share that checkout; two Hydra writers may not.
const hydraWorkspaceByAgentId = new Map<string, string>();
const pendingSpawnAdmissions: PendingSpawnAdmission[] = [];
const closingTaskSpawnIds = new Set<string>();
const preparedRunnerCleanups = new Set<PreparedRunnerCleanup>();
const taskAgentStopWorkflowsByAgentId = new Map<string, TaskAgentStopWorkflowOwner>();
let activeSpawnAdmissions = 0;
let stoppingAllTaskAgentSpawns = false;
let keepTaskAgentSpawnAdmissionClosed = false;
let stopAllTaskAgentWorkflowsPromise: Promise<void> | null = null;

function getSpawnAbortError(operation: PendingTaskAgentSpawn): Error {
  const reason = operation.abortController.signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(`Agent spawn cancelled for ${operation.agentId}`);
  error.name = 'AbortError';
  return error;
}

function getTaskAgentSpawnAdmissionError(agentId: string, taskId: string): Error | null {
  if (taskAgentStopWorkflowsByAgentId.has(agentId)) {
    return new Error(`Agent ${agentId} is stopping and does not admit new spawns`);
  }
  if (closingTaskSpawnIds.has(taskId)) {
    return new Error(`Task ${taskId} is closing and no longer admits agent spawns`);
  }
  if (stoppingAllTaskAgentSpawns) {
    return new Error('Agent sessions are stopping and do not admit new spawns');
  }
  return null;
}

function assertTaskAgentSpawnAdmitted(operation: PendingTaskAgentSpawn): void {
  if (operation.abortController.signal.aborted) {
    throw getSpawnAbortError(operation);
  }
  const admissionError = getTaskAgentSpawnAdmissionError(operation.agentId, operation.taskId);
  if (admissionError) {
    throw admissionError;
  }
}

function assertExactExistingSession(request: SpawnTaskAgentWorkflowRequest): void {
  const metadata = getAgentMeta(request.agentId);
  if (
    !metadata ||
    metadata.agentId !== request.agentId ||
    metadata.taskId !== request.taskId ||
    metadata.isShell !== (request.isShell === true)
  ) {
    throw new Error('Exact agent session is unavailable for attach');
  }
}

function attachExistingTaskAgentSession(
  context: TaskWorkflowContext,
  request: SpawnTaskAgentWorkflowRequest,
): AgentSpawnDisposition {
  if (request.contentAuthorityClass === 'explicit-transient') {
    throw new Error('A transient Arena launch cannot attach to an existing PTY session');
  }
  if (request.skipExistingSessionAttach === true) {
    assertExactExistingSession(request);
    return { channelAttached: false, kind: 'attached-existing' };
  }
  const disposition = attachExistingAgentSessionExact(context.sendToChannel, {
    agentId: request.agentId,
    ...(request.bindOutputChannel !== undefined ? { bindChannel: request.bindOutputChannel } : {}),
    isShell: request.isShell === true,
    ...(request.onOutput !== undefined ? { onOutput: request.onOutput } : {}),
    taskId: request.taskId,
  });
  if (disposition.channelBound === false) {
    throw new Error('Agent output channel is unavailable');
  }
  return finishTaskAgentSpawn(context, request, disposition);
}

function recordSpawnAdmissionState(): void {
  recordAgentSessionSpawnAdmissionState({
    activeSpawns: activeSpawnAdmissions,
    pendingSpawns: pendingSpawnAdmissions.length,
  });
}

function removePendingSpawnAdmission(admission: PendingSpawnAdmission): boolean {
  const index = pendingSpawnAdmissions.indexOf(admission);
  if (index < 0) {
    return false;
  }
  pendingSpawnAdmissions.splice(index, 1);
  recordSpawnAdmissionState();
  return true;
}

async function acquireTaskAgentSpawnAdmission(operation: PendingTaskAgentSpawn): Promise<void> {
  const startedAt = performance.now();
  assertTaskAgentSpawnAdmitted(operation);
  if (activeSpawnAdmissions < MAX_CONCURRENT_AGENT_SESSION_SPAWNS) {
    activeSpawnAdmissions += 1;
    recordSpawnAdmissionState();
    recordAgentSessionSpawnAdmissionWait(performance.now() - startedAt);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const admission: PendingSpawnAdmission = {
      operation,
      reject,
      resolve: () => {
        operation.abortController.signal.removeEventListener('abort', handleAbort);
        recordAgentSessionSpawnAdmissionWait(performance.now() - startedAt);
        resolve();
      },
      startedAt,
    };
    const handleAbort = (): void => {
      if (!removePendingSpawnAdmission(admission)) {
        return;
      }
      recordAgentSessionSpawnAdmissionWait(performance.now() - startedAt);
      reject(getSpawnAbortError(operation));
    };
    operation.abortController.signal.addEventListener('abort', handleAbort, { once: true });
    pendingSpawnAdmissions.push(admission);
    recordSpawnAdmissionState();
  });
  assertTaskAgentSpawnAdmitted(operation);
}

function releaseTaskAgentSpawnAdmission(): void {
  while (pendingSpawnAdmissions.length > 0) {
    const admission = pendingSpawnAdmissions.shift();
    if (!admission || admission.operation.abortController.signal.aborted) {
      continue;
    }
    recordSpawnAdmissionState();
    admission.resolve();
    return;
  }

  activeSpawnAdmissions = Math.max(0, activeSpawnAdmissions - 1);
  recordSpawnAdmissionState();
}

function waitForPredecessorOrAbort(
  predecessor: Promise<unknown>,
  operation: PendingTaskAgentSpawn,
): Promise<void> {
  const signal = operation.abortController.signal;
  if (signal.aborted) {
    return Promise.reject(getSpawnAbortError(operation));
  }

  return new Promise<void>((resolve, reject) => {
    const handleAbort = (): void => {
      reject(getSpawnAbortError(operation));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    void predecessor.then(
      () => {
        signal.removeEventListener('abort', handleAbort);
        resolve();
      },
      () => {
        signal.removeEventListener('abort', handleAbort);
        resolve();
      },
    );
  });
}

function waitForSpawnPromiseOrAbort<T>(
  promise: Promise<T>,
  operation: PendingTaskAgentSpawn,
): Promise<T> {
  const signal = operation.abortController.signal;
  if (signal.aborted) {
    return Promise.reject(getSpawnAbortError(operation));
  }

  return new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => {
      reject(getSpawnAbortError(operation));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      },
    );
  });
}

function removePendingTaskAgentSpawn(operation: PendingTaskAgentSpawn): void {
  pendingTaskAgentSpawns.delete(operation);
  if (latestTaskAgentSpawnByAgentId.get(operation.agentId) === operation) {
    latestTaskAgentSpawnByAgentId.delete(operation.agentId);
  }
}

function cancelTaskAgentSpawnOperations(
  predicate: (operation: PendingTaskAgentSpawn) => boolean,
  reason: string,
): Promise<unknown>[] {
  const operations = [...pendingTaskAgentSpawns].filter(predicate);
  for (const operation of operations) {
    if (!operation.abortController.signal.aborted) {
      const error = new Error(reason);
      error.name = 'AbortError';
      operation.abortController.abort(error);
    }
  }
  return operations.flatMap((operation) =>
    operation.completion === undefined ? [] : [operation.completion],
  );
}

async function drainCancelledTaskAgentSpawns(completions: Promise<unknown>[]): Promise<void> {
  await Promise.allSettled(completions);
}

function registerPreparedRunnerCleanup(
  request: SpawnTaskAgentWorkflowRequest,
  cleanup: () => Promise<void> | void,
): PreparedRunnerCleanup {
  const owner: PreparedRunnerCleanup = {
    agentId: request.agentId,
    cleanup,
    taskId: request.taskId,
  };
  preparedRunnerCleanups.add(owner);
  return owner;
}

function transferPreparedRunnerCleanup(owner: PreparedRunnerCleanup): void {
  preparedRunnerCleanups.delete(owner);
}

async function runPreparedRunnerCleanup(owner: PreparedRunnerCleanup): Promise<void> {
  if (!owner.cleanupPromise) {
    let cleanupAttempt: Promise<void>;
    try {
      cleanupAttempt = Promise.resolve(owner.cleanup());
    } catch (error) {
      cleanupAttempt = Promise.reject(error);
    }
    owner.cleanupPromise = cleanupAttempt.then(
      () => {
        preparedRunnerCleanups.delete(owner);
      },
      (error: unknown) => {
        delete owner.cleanupPromise;
        throw error;
      },
    );
  }
  await owner.cleanupPromise;
}

async function cleanupPreparedRunnerLaunches(
  options: {
    agentIds?: ReadonlySet<string>;
    taskId?: string;
  } = {},
): Promise<void> {
  const owners = [...preparedRunnerCleanups].filter(
    (owner) =>
      (options.taskId === undefined || owner.taskId === options.taskId) &&
      (options.agentIds === undefined || options.agentIds.has(owner.agentId)),
  );
  const results = await Promise.allSettled(owners.map((owner) => runPreparedRunnerCleanup(owner)));
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw combineWorkflowFailures('Failed to clean prepared agent runner launches', failures);
  }
}

function combineWorkflowFailures(message: string, failures: unknown[]): Error {
  if (failures.length === 1 && failures[0] instanceof Error) {
    return failures[0];
  }
  const error = new Error(message);
  Object.defineProperty(error, 'cause', {
    configurable: true,
    value: failures,
    writable: true,
  });
  return error;
}

function getWorktreeIdentity(worktreePath: string): string {
  try {
    return fs.realpathSync(worktreePath);
  } catch {
    return path.resolve(worktreePath);
  }
}

function getSavedWorktreeIdentity(worktreePath: string): string {
  const identity = getWorktreeIdentity(worktreePath);
  try {
    if (!fs.statSync(identity).isDirectory()) {
      return identity;
    }
  } catch {
    // Missing worktrees must retain their exact saved identity. Walking to an
    // ancestor repository would incorrectly claim that repository's root.
    return identity;
  }

  let candidate = identity;
  while (true) {
    if (fs.existsSync(path.join(candidate, '.git'))) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return identity;
    }
    candidate = parent;
  }
}

function registeredTaskIds(identity: string): Set<string> {
  return new Set([
    ...(liveTaskIdByWorktreeIdentity.get(identity) ?? []),
    ...(savedTaskIdByWorktreeIdentity.get(identity) ?? []),
  ]);
}

export function hasRegisteredSharedRootTask(worktreePath: string): boolean {
  return (
    hasPreparedSharedRootTask(worktreePath) ||
    [...registeredTaskIds(getWorktreeIdentity(worktreePath))].some((id) =>
      sharedRootTaskIds.has(id),
    )
  );
}

function addWorktreeTask(
  registry: Map<string, Set<string>>,
  identity: string,
  taskId: string,
): void {
  const tasks = registry.get(identity) ?? new Set<string>();
  tasks.add(taskId);
  registry.set(identity, tasks);
}

function removeWorktreeTask(
  registry: Map<string, Set<string>>,
  identity: string,
  taskId: string,
): void {
  const tasks = registry.get(identity);
  tasks?.delete(taskId);
  if (tasks?.size === 0) registry.delete(identity);
}

function isDescendantWorktreeIdentity(parentIdentity: string, candidateIdentity: string): boolean {
  const relativePath = path.relative(parentIdentity, candidateIdentity);
  return (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function assertWorktreeIdentityAvailable(
  taskId: string | undefined,
  identity: string,
  worktreePath: string,
  sharedRoot = false,
): void {
  const existingTaskId = [...registeredTaskIds(identity)].find(
    (id) => id !== taskId && (!sharedRoot || !sharedRootTaskIds.has(id)),
  );
  if (existingTaskId !== undefined) {
    throw new Error(`Worktree is already registered for task ${existingTaskId}: ${worktreePath}`);
  }
}

export function findRegisteredTaskIdForWorktreePath(
  worktreePath: string,
  preferredTaskId?: string,
): string | null {
  const identity = getWorktreeIdentity(worktreePath);
  const exactTasks = registeredTaskIds(identity);
  if (exactTasks.size > 0) {
    return preferredTaskId !== undefined && exactTasks.has(preferredTaskId)
      ? preferredTaskId
      : (exactTasks.values().next().value ?? null);
  }

  let owner: { identity: string; taskIds: Set<string> } | null = null;
  for (const registry of [liveTaskIdByWorktreeIdentity, savedTaskIdByWorktreeIdentity]) {
    for (const registeredIdentity of registry.keys()) {
      if (
        isDescendantWorktreeIdentity(registeredIdentity, identity) &&
        (!owner || registeredIdentity.length > owner.identity.length)
      ) {
        owner = { identity: registeredIdentity, taskIds: registeredTaskIds(registeredIdentity) };
      }
    }
  }

  return preferredTaskId !== undefined && owner?.taskIds.has(preferredTaskId)
    ? preferredTaskId
    : (owner?.taskIds.values().next().value ?? null);
}

function reserveTaskWorktreeIdentity(worktreePath: string, sharedRoot = false): () => void {
  const identity = getWorktreeIdentity(worktreePath);
  assertWorktreeIdentityAvailable(undefined, identity, worktreePath, sharedRoot);
  if (pendingTaskWorktreeIdentities.has(identity)) {
    throw new Error(`Worktree is already being registered for another task: ${worktreePath}`);
  }

  pendingTaskWorktreeIdentities.add(identity);
  return () => {
    pendingTaskWorktreeIdentities.delete(identity);
  };
}

async function withReservedTaskWorktreeIdentity<T>(
  worktreePath: string,
  operation: () => Promise<T>,
  sharedRoot = false,
): Promise<T> {
  const release = reserveTaskWorktreeIdentity(worktreePath, sharedRoot);
  try {
    return await operation();
  } finally {
    release();
  }
}

function registerTaskWorktreeIdentity(
  taskId: string,
  worktreePath: string,
  sharedRoot = false,
): void {
  const identity = getWorktreeIdentity(worktreePath);
  assertWorktreeIdentityAvailable(taskId, identity, worktreePath, sharedRoot);

  const previousIdentity = liveWorktreeIdentityByTaskId.get(taskId);
  if (previousIdentity !== undefined) {
    removeWorktreeTask(liveTaskIdByWorktreeIdentity, previousIdentity, taskId);
  }
  const previousSavedIdentity = savedWorktreeIdentityByTaskId.get(taskId);
  if (previousSavedIdentity !== undefined) {
    savedWorktreeIdentityByTaskId.delete(taskId);
    removeWorktreeTask(savedTaskIdByWorktreeIdentity, previousSavedIdentity, taskId);
  }

  removedTaskWorktreeIds.delete(taskId);
  if (sharedRoot) sharedRootTaskIds.add(taskId);
  else sharedRootTaskIds.delete(taskId);
  liveWorktreeIdentityByTaskId.set(taskId, identity);
  addWorktreeTask(liveTaskIdByWorktreeIdentity, identity, taskId);
}

function removeTaskWorktreeIdentity(taskId: string): void {
  releasePreparedSharedRootTask(taskId);
  const liveIdentity = liveWorktreeIdentityByTaskId.get(taskId);
  if (liveIdentity !== undefined) {
    liveWorktreeIdentityByTaskId.delete(taskId);
    removeWorktreeTask(liveTaskIdByWorktreeIdentity, liveIdentity, taskId);
  }

  const savedIdentity = savedWorktreeIdentityByTaskId.get(taskId);
  if (savedIdentity !== undefined) {
    savedWorktreeIdentityByTaskId.delete(taskId);
    removeWorktreeTask(savedTaskIdByWorktreeIdentity, savedIdentity, taskId);
  }

  // Ignore stale client snapshots for this task until the process restarts.
  // Task ids are unique, so retaining this tombstone cannot mask a new task.
  removedTaskWorktreeIds.add(taskId);
  sharedRootTaskIds.delete(taskId);
}

export function clearTaskWorkflowWorktreeRegistryForTests(): void {
  resetPreparedSharedRootTasksForTests();
  liveTaskIdByWorktreeIdentity.clear();
  liveWorktreeIdentityByTaskId.clear();
  savedTaskIdByWorktreeIdentity.clear();
  savedWorktreeIdentityByTaskId.clear();
  sharedRootTaskIds.clear();
  removedTaskWorktreeIds.clear();
  pendingTaskWorktreeIdentities.clear();
  taskCreationOperationsById.clear();
  taskCreationOperationIdsByTaskId.clear();
  for (const operation of pendingTaskAgentSpawns) {
    operation.abortController.abort(new Error('Task workflow test state reset'));
  }
  pendingTaskAgentSpawns.clear();
  latestTaskAgentSpawnByAgentId.clear();
  hydraWorkspaceByAgentId.clear();
  pendingSpawnAdmissions.splice(0, pendingSpawnAdmissions.length);
  closingTaskSpawnIds.clear();
  preparedRunnerCleanups.clear();
  taskAgentStopWorkflowsByAgentId.clear();
  activeSpawnAdmissions = 0;
  stoppingAllTaskAgentSpawns = false;
  keepTaskAgentSpawnAdmissionClosed = false;
  stopAllTaskAgentWorkflowsPromise = null;
}

function forgetTaskCreationOperations(taskId: string): void {
  const operationIds = taskCreationOperationIdsByTaskId.get(taskId);
  if (!operationIds) {
    return;
  }

  taskCreationOperationIdsByTaskId.delete(taskId);
  for (const operationId of operationIds) {
    taskCreationOperationsById.delete(operationId);
  }
}

export function syncTaskWorkflowWorktreesFromSavedState(
  savedState: string | SavedStateDocument,
): void {
  for (const taskId of savedWorktreeIdentityByTaskId.keys()) sharedRootTaskIds.delete(taskId);
  savedTaskIdByWorktreeIdentity.clear();
  savedWorktreeIdentityByTaskId.clear();

  const parsed = toSavedStateDocument(savedState).taskLookup;
  for (const task of Object.values(parsed.tasks)) {
    if (task.projectMode === 'non-git') {
      continue;
    }

    if (!task.id || !task.worktreePath || removedTaskWorktreeIds.has(task.id)) {
      continue;
    }
    if (liveWorktreeIdentityByTaskId.has(task.id) || savedWorktreeIdentityByTaskId.has(task.id)) {
      continue;
    }

    const identity = getSavedWorktreeIdentity(task.worktreePath);
    if (pendingTaskWorktreeIdentities.has(identity) && task.gitIsolation !== 'current-branch') {
      continue;
    }
    const sharedRoot = task.gitIsolation === 'current-branch';
    const existingIds = registeredTaskIds(identity);
    if ([...existingIds].some((id) => !sharedRoot || !sharedRootTaskIds.has(id))) {
      // Live backend state wins over a lagging renderer snapshot. The matching
      // task is already represented; a different task is a stale conflict.
      continue;
    }
    if (sharedRoot) sharedRootTaskIds.add(task.id);
    addWorktreeTask(savedTaskIdByWorktreeIdentity, identity, task.id);
    savedWorktreeIdentityByTaskId.set(task.id, identity);
  }
}

function filterStringEnvironment(envValue: unknown): Record<string, string> {
  if (!envValue || typeof envValue !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(envValue).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function logWorkflowWarning(message: string, error: unknown): void {
  console.warn(message, error);
}

function getWorkflowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runWorkflowStep(step: () => void, warningMessage: string): void {
  try {
    step();
  } catch (error) {
    logWorkflowWarning(warningMessage, error);
  }
}

async function runDeleteCleanupStep(
  kind: DeleteTaskCleanupWarningKind,
  step: () => Promise<void>,
  warningMessage: string,
): Promise<DeleteTaskCleanupWarning | null> {
  try {
    await step();
    return null;
  } catch (error) {
    logWorkflowWarning(warningMessage, error);
    return {
      kind,
      message: `${warningMessage} ${getWorkflowErrorMessage(error)}`,
    };
  }
}

async function cleanupTaskAgentRunners(agentIds: readonly string[], taskId: string): Promise<void> {
  const results = await settleIndependentWorkflowSteps([
    () => killTaskAgentsAndWaitForRunnerCleanup(taskId, agentIds),
    () => cleanupPreparedRunnerLaunches({ taskId }),
    () => cleanupPendingDockerAgentRunnerBuilds({ taskId }),
  ]);
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failures.length === 0) {
    return;
  }

  throw new Error(failures.map((failure) => getWorkflowErrorMessage(failure.reason)).join('; '));
}

function startPlanWatcherSafely(
  context: TaskWorkflowContext,
  taskId: string,
  worktreePath: string,
): void {
  const beginContentAdmission = context.beginTaskContentRootAdmission;
  if (!beginContentAdmission) {
    return;
  }
  runWorkflowStep(() => {
    startPlanWatcher(
      taskId,
      worktreePath,
      () => beginContentAdmission(taskId),
      (message) => {
        context.emitIpcEvent?.(IPC.PlanContent, message);
      },
    );
  }, 'Failed to start plan watcher:');
}

function ensurePlansDirectorySafely(worktreePath: string): void {
  runWorkflowStep(() => {
    ensurePlansDirectory(worktreePath);
  }, 'Failed to set up plans directory:');
}

function startTaskGitWatcherSafely(
  context: TaskWorkflowContext,
  baseBranch: string | undefined,
  taskId: string,
  worktreePath: string,
): void {
  void startTaskGitStatusMonitoring(context, {
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    taskId,
    worktreePath,
  }).catch((error) => {
    logWorkflowWarning('Failed to start git watcher:', error);
  });
}

function startTaskWorktreeWatchers(
  context: TaskWorkflowContext,
  baseBranch: string | undefined,
  taskId: string,
  worktreePath: string,
): void {
  ensurePlansDirectorySafely(worktreePath);
  startPlanWatcherSafely(context, taskId, worktreePath);
  startTaskGitWatcherSafely(context, baseBranch, taskId, worktreePath);
}

function startTaskPlanWatchers(
  context: TaskWorkflowContext,
  taskId: string,
  worktreePath: string,
): void {
  ensurePlansDirectorySafely(worktreePath);
  startPlanWatcherSafely(context, taskId, worktreePath);
}

function registerTaskGitMetadata(options: {
  baseBranch?: string;
  branchName: string;
  projectId: string;
  projectRoot: string;
  githubUrl?: string;
  taskId: string;
  taskName: string;
  worktreePath: string;
}): void {
  registerTaskConvergenceTask({
    ...(options.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
    taskId: options.taskId,
    taskName: options.taskName,
    projectId: options.projectId,
    projectRoot: options.projectRoot,
    branchName: options.branchName,
    worktreePath: options.worktreePath,
  });
  registerTaskReviewTask({
    ...(options.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
    taskId: options.taskId,
    projectId: options.projectId,
    projectRoot: options.projectRoot,
    branchName: options.branchName,
    worktreePath: options.worktreePath,
  });
  registerTaskReviewSignalsTask({
    ...(options.githubUrl !== undefined ? { githubUrl: options.githubUrl } : {}),
    taskId: options.taskId,
    worktreePath: options.worktreePath,
  });
}

function registerTaskStepsMetadata(options: {
  stepsTracking?: boolean;
  taskId: string;
  worktreePath: string;
}): void {
  if (options.stepsTracking !== true) {
    return;
  }

  registerTaskStepsTask({
    taskId: options.taskId,
    worktreePath: options.worktreePath,
  });
}

function registerCreatedTaskRuntime(
  context: TaskWorkflowContext,
  request: CreateTaskWorkflowRequest,
  result: CreatedTaskRuntimeMetadata,
  baseBranch: string | undefined,
): void {
  if (request.stepsTracking === true) {
    assertTaskStepsPathAvailable(result.id, result.worktree_path);
  }
  closingTaskSpawnIds.delete(result.id);
  registerTaskWorktreeIdentity(
    result.id,
    result.worktree_path,
    request.gitIsolation === 'current-branch',
  );

  registerTaskGitMetadata({
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    taskId: result.id,
    taskName: request.name,
    ...(request.githubUrl !== undefined ? { githubUrl: request.githubUrl } : {}),
    projectId: request.projectId,
    projectRoot: request.projectRoot,
    branchName: result.branch_name,
    worktreePath: result.worktree_path,
  });
  registerTaskStepsMetadata({
    taskId: result.id,
    worktreePath: result.worktree_path,
    ...(request.stepsTracking !== undefined ? { stepsTracking: request.stepsTracking } : {}),
  });

  startTaskGitWatcherSafely(context, baseBranch, result.id, result.worktree_path);
  scheduleTaskConvergenceRefresh(result.id);
  scheduleTaskReviewRefresh(result.id);
  scheduleTaskReviewSignalsRefresh(result.id);
}

function registerCreatedNonGitTaskRuntime(
  request: CreateTaskWorkflowRequest,
  result: CreatedTaskRuntimeMetadata,
): void {
  closingTaskSpawnIds.delete(result.id);
  registerTaskStepsMetadata({
    taskId: result.id,
    worktreePath: result.worktree_path,
    ...(request.stepsTracking !== undefined ? { stepsTracking: request.stepsTracking } : {}),
  });
}

function createManagedWorktreeTask(
  request: CreateTaskWorkflowRequest,
  worktreeLinkRequest: TaskWorktreeLinkRequestV1,
  baseBranch: string,
): ReturnType<typeof createTask> {
  const branchPrefix = request.branchPrefix ?? 'task';
  return createTask(
    request.name,
    request.projectRoot,
    worktreeLinkRequest,
    branchPrefix,
    baseBranch,
  );
}

export function stopTaskWorktreeWatchers(taskId: string): void {
  stopPlanWatcher(taskId);
  stopTaskGitStatusWatcher(taskId);
}

export function cleanupTaskRuntimeWorkflow(
  request: CleanupTaskRuntimeWorkflowRequest,
): CleanupTaskRuntimeWorkflowResult {
  for (const agentId of request.agentIds) {
    removeAgentSupervision(agentId);
  }

  stopTaskWorktreeWatchers(request.taskId);

  if (request.removeTaskState !== true) {
    return {
      releasedTaskCommandController: null,
    };
  }

  const releasedTaskCommandController = clearTaskCommandLeaseForTask(request.taskId);
  removeTaskSupervision(request.taskId);
  removeTaskConvergence(request.taskId);
  removeTaskReview(request.taskId);
  removeTaskReviewSignals(request.taskId);
  removeTaskSteps(request.taskId);
  removeTaskPorts(request.taskId);
  removeTaskContainerPreviewTargets(request.taskId);
  forgetTaskCreationOperations(request.taskId);
  removeTaskWorktreeIdentity(request.taskId);
  if (
    request.projectMode !== 'non-git' &&
    typeof request.worktreePath === 'string' &&
    registeredTaskIds(getWorktreeIdentity(request.worktreePath)).size === 0
  ) {
    removeGitStatusSnapshot(request.worktreePath);
  }

  return {
    releasedTaskCommandController: releasedTaskCommandController.changed
      ? releasedTaskCommandController.snapshot
      : null,
  };
}

function resolveSpawnLaunch(request: SpawnTaskAgentWorkflowRequest): ResolvedSpawnLaunch {
  const env = filterStringEnvironment(request.env);
  if (request.adapter === 'hydra') {
    return resolveHydraAdapterLaunch({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      env,
      resumeOnStart: request.resumeOnStart === true,
    });
  }

  return {
    command: request.command,
    args: request.args,
    env,
    isInternalNodeProcess: false,
  };
}

async function resolveRunnerLaunch(
  request: SpawnTaskAgentWorkflowRequest,
  launch: ResolvedSpawnLaunch,
  signal: AbortSignal,
): Promise<ResolvedSpawnLaunch> {
  const profile = normalizeAgentRunnerProfileConfig(request.runnerProfile);
  if (!profile || profile.provider === 'host') {
    return launch;
  }

  if (profile.provider === 'docker-sandbox') {
    throw new Error('Docker sandbox agent runners are not supported in this build.');
  }

  if (request.adapter === 'hydra') {
    throw new Error('Docker container agent runners do not support Hydra adapter agents yet.');
  }

  const dockerLaunch = await createDockerAgentRunnerLaunch({
    agentId: request.agentId,
    args: launch.args,
    command: launch.command,
    cwd: request.cwd,
    env: launch.env,
    profile,
    signal,
    taskId: request.taskId,
  });

  return {
    args: dockerLaunch.args,
    command: dockerLaunch.command,
    cwd: dockerLaunch.cwd,
    env: dockerLaunch.env,
    isInternalNodeProcess: false,
    onExitCleanup: dockerLaunch.cleanup,
    runnerIdentity: dockerLaunch.identity,
  };
}

async function executeTaskAgentSpawn(
  context: TaskWorkflowContext,
  request: SpawnTaskAgentWorkflowRequest,
  operation: PendingTaskAgentSpawn,
  existingSessionKnown = false,
): Promise<AgentSpawnDisposition> {
  const assertAdmitted = (): void => {
    assertTaskAgentSpawnAdmitted(operation);
    request.assertSpawnAdmitted?.();
  };
  const assertWriterAdmitted = (): void => {
    context.agentSessionWriter?.assertSpawnPermit(request.writerPermit, {
      agentId: request.agentId,
      taskId: request.taskId,
    });
  };
  const assertProcessWriterAdmitted = (): void => {
    assertAdmitted();
    assertWriterAdmitted();
  };
  assertAdmitted();
  if (
    (request.contentAuthorityClass === undefined) !==
    (request.contentAuthorityRoot === undefined)
  ) {
    throw new Error('Transient PTY authority requires one exact backend root');
  }
  if (
    request.replaceExistingSession !== true &&
    (existingSessionKnown || hasAgentSession(request.agentId))
  ) {
    return attachExistingTaskAgentSession(context, request);
  }
  assertWriterAdmitted();
  const resolvedLaunch = await resolveRunnerLaunch(
    request,
    resolveSpawnLaunch(request),
    operation.abortController.signal,
  );
  const preparedCleanup = resolvedLaunch.onExitCleanup
    ? registerPreparedRunnerCleanup(request, resolvedLaunch.onExitCleanup)
    : undefined;
  let runnerCleanupTransferred = false;

  try {
    assertProcessWriterAdmitted();
    // Runner resolution may await external setup. Recheck the exact tuple
    // after that await so a raced session is identity-validated before the
    // output channel is bound; the synchronous PTY create follows directly.
    if (request.replaceExistingSession !== true && hasAgentSession(request.agentId)) {
      const disposition = attachExistingTaskAgentSession(context, request);
      if (preparedCleanup) await runPreparedRunnerCleanup(preparedCleanup);
      return disposition;
    }
    const spawnCwd = resolvedLaunch.cwd ?? request.cwd;
    if (
      request.contentAuthorityClass === 'explicit-transient' &&
      path.resolve(spawnCwd) !== request.contentAuthorityRoot
    ) {
      throw new Error('Transient PTY launch root changed before process spawn');
    }
    const channelBound = request.bindOutputChannel?.();
    if (channelBound === false) throw new Error('Agent output channel is unavailable');
    const spawned = spawnPtyAgent(context.sendToChannel, {
      taskId: request.taskId,
      agentId: request.agentId,
      ...(request.agentSessionLaunchReason !== undefined
        ? { agentSessionLaunchReason: request.agentSessionLaunchReason }
        : {}),
      ...(request.agentSessionOperationId !== undefined
        ? { agentSessionOperationId: request.agentSessionOperationId }
        : {}),
      ...(request.agentSessionResumed !== undefined
        ? { agentSessionResumed: request.agentSessionResumed }
        : {}),
      command: resolvedLaunch.command,
      ...(request.contentAuthorityClass !== undefined
        ? { contentAuthorityClass: request.contentAuthorityClass }
        : {}),
      args: resolvedLaunch.args,
      cwd: spawnCwd,
      env: resolvedLaunch.env,
      cols: request.cols,
      rows: request.rows,
      isShell: request.isShell === true,
      isInternalNodeProcess: resolvedLaunch.isInternalNodeProcess,
      ...(request.writerPermit !== undefined
        ? { lifecycleGeneration: request.writerPermit.targetGeneration }
        : {}),
      replaceExistingSession: request.replaceExistingSession === true,
      ...(request.onOutput !== undefined ? { onOutput: request.onOutput } : {}),
      ...(resolvedLaunch.runnerIdentity !== undefined
        ? { runnerIdentity: resolvedLaunch.runnerIdentity }
        : {}),
      ...(resolvedLaunch.onExitCleanup !== undefined
        ? { onExitCleanup: resolvedLaunch.onExitCleanup }
        : {}),
    });
    const spawnDisposition = channelBound === undefined ? spawned : { ...spawned, channelBound };

    if (spawnDisposition.kind === 'created-session') {
      if (preparedCleanup) {
        transferPreparedRunnerCleanup(preparedCleanup);
      }
      runnerCleanupTransferred = true;
    } else if (preparedCleanup) {
      await runPreparedRunnerCleanup(preparedCleanup);
    }
    if (spawnDisposition.replacedSessionCleanup) {
      const replacedSessionCleanup = spawnDisposition.replacedSessionCleanup;
      try {
        await waitForSpawnPromiseOrAbort(replacedSessionCleanup, operation);
        assertAdmitted();
      } catch (error) {
        const firstRollback = killAgentAndWaitForRunnerCleanup(request.agentId);
        const [rollbackResult] = await Promise.allSettled([firstRollback, replacedSessionCleanup]);
        let rollbackFailure = rollbackResult;
        if (rollbackFailure.status === 'rejected') {
          try {
            await killAgentAndWaitForRunnerCleanup(request.agentId);
            rollbackFailure = { status: 'fulfilled', value: undefined };
          } catch (retryError) {
            rollbackFailure = { reason: retryError, status: 'rejected' };
          }
        }
        if (rollbackFailure.status === 'rejected') {
          throw combineWorkflowFailures(
            'Agent replacement cleanup failed and the replacement runner rollback also failed',
            [error, rollbackFailure.reason],
          );
        }
        throw error;
      }
    }

    return finishTaskAgentSpawn(context, request, spawnDisposition);
  } catch (error) {
    if (!preparedCleanup || runnerCleanupTransferred) {
      throw error;
    }
    try {
      await runPreparedRunnerCleanup(preparedCleanup);
    } catch (cleanupError) {
      throw combineWorkflowFailures(
        'Agent spawn failed and its prepared runner cleanup also failed',
        [error, cleanupError],
      );
    }
    throw error;
  }
}

function finishTaskAgentSpawn(
  context: TaskWorkflowContext,
  request: SpawnTaskAgentWorkflowRequest,
  disposition: AgentSpawnDisposition,
): AgentSpawnDisposition {
  if ((request.isShell && request.startsTaskWatchers !== true) || !request.cwd) {
    return disposition;
  }
  if (request.projectMode === 'non-git') {
    startTaskPlanWatchers(context, request.taskId, request.cwd);
    return disposition;
  }
  startTaskWorktreeWatchers(context, request.baseBranch, request.taskId, request.cwd);
  return disposition;
}

function reserveHydraWorkspace(request: SpawnTaskAgentWorkflowRequest): void {
  if (request.adapter !== 'hydra') return;
  const workspace = getWorktreeIdentity(request.cwd);
  for (const [agentId, existingWorkspace] of hydraWorkspaceByAgentId) {
    if (agentId === request.agentId) continue;
    if (!hasAgentSession(agentId) && !latestTaskAgentSpawnByAgentId.has(agentId)) {
      hydraWorkspaceByAgentId.delete(agentId);
      continue;
    }
    if (existingWorkspace === workspace) {
      throw new Error(
        'Hydra is already running or starting in this checkout. Stop that Hydra agent or use an isolated worktree; other agent types can share the project root.',
      );
    }
  }
  hydraWorkspaceByAgentId.set(request.agentId, workspace);
}

export function spawnTaskAgentWorkflow(
  context: TaskWorkflowContext,
  request: SpawnTaskAgentWorkflowRequest,
): Promise<AgentSpawnDisposition> {
  const admissionError = getTaskAgentSpawnAdmissionError(request.agentId, request.taskId);
  if (admissionError) {
    return Promise.reject(admissionError);
  }

  const predecessor = latestTaskAgentSpawnByAgentId.get(request.agentId)?.completion;
  const operation: PendingTaskAgentSpawn = {
    abortController: new AbortController(),
    agentId: request.agentId,
    taskId: request.taskId,
  };
  pendingTaskAgentSpawns.add(operation);
  latestTaskAgentSpawnByAgentId.set(request.agentId, operation);

  const completion = (async () => {
    if (predecessor) {
      await waitForPredecessorOrAbort(predecessor, operation);
    }
    assertTaskAgentSpawnAdmitted(operation);
    if (request.replaceExistingSession !== true && hasAgentSession(request.agentId)) {
      return executeTaskAgentSpawn(context, request, operation, true);
    }
    await acquireTaskAgentSpawnAdmission(operation);
    const startedAt = performance.now();
    try {
      assertTaskAgentSpawnAdmitted(operation);
      reserveHydraWorkspace(request);
      const disposition = await executeTaskAgentSpawn(context, request, operation);
      if (request.adapter !== 'hydra') hydraWorkspaceByAgentId.delete(request.agentId);
      return disposition;
    } finally {
      if (!hasAgentSession(request.agentId)) hydraWorkspaceByAgentId.delete(request.agentId);
      recordAgentSessionSpawnDuration(performance.now() - startedAt);
      releaseTaskAgentSpawnAdmission();
    }
  })().finally(() => {
    removePendingTaskAgentSpawn(operation);
  });
  operation.completion = completion;
  return completion;
}

/**
 * Process-effect seam for a durable owner that already reserved the exact
 * generation. The permit remains a separate argument so ordinary request
 * construction cannot accidentally manufacture an admitted spawn.
 */
export function spawnAllocatedTaskAgentWorkflow(
  context: TaskWorkflowContext,
  request: SpawnTaskAgentWorkflowRequest,
  writerPermit: AgentSessionSpawnPermit,
): Promise<AgentSpawnDisposition> {
  if (!context.agentSessionWriter?.isActive()) {
    return Promise.reject(new Error('Agent-session managed writer is not active'));
  }
  context.agentSessionWriter.assertSpawnPermit(writerPermit, {
    agentId: request.agentId,
    taskId: request.taskId,
  });
  return spawnTaskAgentWorkflow(context, { ...request, writerPermit });
}

/**
 * Compatibility writers use the same generation reservation/permit authority
 * as the durable D11 workflow. Before cutover it preserves legacy behavior;
 * after cutover it is the only legal path for a process-creating legacy call.
 */
export function spawnOwnedTaskAgentWorkflow(
  context: TaskWorkflowContext,
  ownership: OwnedTaskAgentSpawnRequest,
  request: SpawnTaskAgentWorkflowRequest,
): Promise<AgentSpawnDisposition> {
  const writer = context.agentSessionWriter;
  if (!writer?.isActive()) {
    return spawnTaskAgentWorkflow(context, request);
  }
  if (
    (request.contentAuthorityClass === undefined) !==
    (request.contentAuthorityRoot === undefined)
  ) {
    return Promise.reject(new Error('Transient PTY authority requires one exact backend root'));
  }
  if (request.replaceExistingSession !== true && hasAgentSession(request.agentId)) {
    if (request.contentAuthorityClass === 'explicit-transient') {
      return Promise.reject(
        new Error('A transient Arena launch cannot attach to an existing PTY session'),
      );
    }
    if (request.skipExistingSessionAttach === true) {
      assertExactExistingSession(request);
      return Promise.resolve({ channelAttached: false, kind: 'attached-existing' });
    }
    try {
      const disposition = attachExistingAgentSessionExact(context.sendToChannel, {
        agentId: request.agentId,
        ...(request.bindOutputChannel !== undefined
          ? { bindChannel: request.bindOutputChannel }
          : {}),
        isShell: request.isShell === true,
        ...(request.onOutput !== undefined ? { onOutput: request.onOutput } : {}),
        taskId: request.taskId,
      });
      if (disposition.channelBound === false) {
        return Promise.reject(new Error('Agent output channel is unavailable'));
      }
      return Promise.resolve(finishTaskAgentSpawn(context, request, disposition));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  const expectedSourceGeneration = getAgentLifecycleGeneration(request.agentId);
  const targetGeneration = (expectedSourceGeneration ?? -1) + 1;
  const allocation = writer.allocate({
    agentId: request.agentId,
    expectedSourceGeneration,
    operationId: ownership.operationId,
    purpose: ownership.purpose,
    targetGeneration,
    taskId: request.taskId,
  });
  if (allocation === 'stale') {
    return Promise.reject(new Error('Agent-session generation admission is stale'));
  }
  return writer.executeAllocated(ownership.operationId, async (writerPermit) => {
    const result = await spawnAllocatedTaskAgentWorkflow(context, request, writerPermit);
    if (result.kind === 'created-session') {
      const observed = getAgentLifecycleGeneration(request.agentId);
      if (observed !== targetGeneration) {
        throw new Error('Agent-session process generation differs from its reservation');
      }
    }
    return result;
  });
}

function settleIndependentWorkflowSteps(
  steps: ReadonlyArray<() => Promise<void> | void>,
): Promise<PromiseSettledResult<void>[]> {
  return Promise.allSettled(steps.map((step) => Promise.resolve().then(step)));
}

async function runIndependentRunnerCleanupSteps(
  steps: ReadonlyArray<() => Promise<void> | void>,
  failureMessage: string,
): Promise<void> {
  const results = await settleIndependentWorkflowSteps(steps);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw combineWorkflowFailures(failureMessage, failures);
  }
}

async function runTaskAgentStopWorkflow(agentId: string): Promise<void> {
  const completions = cancelTaskAgentSpawnOperations(
    (operation) => operation.agentId === agentId,
    `Agent ${agentId} was stopped before its spawn completed`,
  );
  await drainCancelledTaskAgentSpawns(completions);
  const agentIds = new Set([agentId]);
  await runIndependentRunnerCleanupSteps(
    [
      () => killAgentAndWaitForRunnerCleanup(agentId),
      () => cleanupPreparedRunnerLaunches({ agentIds }),
      () => cleanupPendingDockerAgentRunnerBuilds({ agentIds }),
    ],
    `Failed to stop agent ${agentId}`,
  );
}

export function stopTaskAgentWorkflow(agentId: string): Promise<void> {
  revokeAgentContentAuthority(agentId);
  const existingOwner = taskAgentStopWorkflowsByAgentId.get(agentId);
  if (existingOwner?.status === 'stopping') {
    return existingOwner.completion;
  }

  const token = {};
  const completion = Promise.resolve()
    .then(() => runTaskAgentStopWorkflow(agentId))
    .then(
      () => {
        const currentOwner = taskAgentStopWorkflowsByAgentId.get(agentId);
        if (currentOwner?.status === 'stopping' && currentOwner.token === token) {
          taskAgentStopWorkflowsByAgentId.delete(agentId);
        }
      },
      (error: unknown) => {
        const currentOwner = taskAgentStopWorkflowsByAgentId.get(agentId);
        if (currentOwner?.status === 'stopping' && currentOwner.token === token) {
          taskAgentStopWorkflowsByAgentId.set(agentId, { status: 'failed' });
        }
        throw error;
      },
    );
  taskAgentStopWorkflowsByAgentId.set(agentId, { completion, status: 'stopping', token });
  return completion;
}

export function stopAllTaskAgentWorkflows(
  options: { keepAdmissionClosed?: boolean } = {},
): Promise<void> {
  revokeAllAgentContentAuthorities();
  if (options.keepAdmissionClosed === true) {
    keepTaskAgentSpawnAdmissionClosed = true;
    stoppingAllTaskAgentSpawns = true;
  }
  if (stopAllTaskAgentWorkflowsPromise) {
    return stopAllTaskAgentWorkflowsPromise;
  }
  stoppingAllTaskAgentSpawns = true;
  let completedSuccessfully = false;
  const stopPromise = (async () => {
    try {
      const completions = cancelTaskAgentSpawnOperations(
        () => true,
        'All agent sessions were stopped before spawn completed',
      );
      await drainCancelledTaskAgentSpawns(completions);
      await runIndependentRunnerCleanupSteps(
        [
          () => killAllAgentsAndWaitForRunnerCleanup(),
          () => cleanupPreparedRunnerLaunches(),
          () => cleanupPendingDockerAgentRunnerBuilds(),
        ],
        'Failed to stop all agent sessions',
      );
      // A successful global cleanup supersedes retained per-agent failures because it has just
      // settled every runner owner. Leaving those failed admission sentinels behind would block
      // the affected agent ids even after the global barrier reopens.
      taskAgentStopWorkflowsByAgentId.clear();
      completedSuccessfully = true;
    } finally {
      stopAllTaskAgentWorkflowsPromise = null;
      if (completedSuccessfully && !keepTaskAgentSpawnAdmissionClosed) {
        stoppingAllTaskAgentSpawns = false;
      }
    }
  })();
  stopAllTaskAgentWorkflowsPromise = stopPromise;
  return stopPromise;
}

export function countRunningAndPendingTaskAgents(): number {
  const pendingAgentIds = new Set(
    [...pendingTaskAgentSpawns].map((operation) => operation.agentId),
  );
  let count = countRunningAgents();
  for (const agentId of pendingAgentIds) {
    if (!hasAgentSession(agentId)) {
      count += 1;
    }
  }
  return count;
}

async function closeTaskAgentSpawns(taskId: string): Promise<void> {
  closingTaskSpawnIds.add(taskId);
  const completions = cancelTaskAgentSpawnOperations(
    (operation) => operation.taskId === taskId,
    `Task ${taskId} was closed before agent spawn completed`,
  );
  await drainCancelledTaskAgentSpawns(completions);
}

export async function stopTaskAgentWorkflowsForTask(
  taskId: string,
  agentIds: readonly string[],
): Promise<void> {
  revokeTaskAgentContentAuthorities(taskId, agentIds);
  await closeTaskAgentSpawns(taskId);
  await cleanupTaskAgentRunners(agentIds, taskId);
}

function getTaskCreationOperationFingerprint(
  request: CreateTaskWorkflowRequest,
  worktreeLinkRequest: TaskWorktreeLinkRequestV1,
): string {
  return JSON.stringify([
    request.agentDefId ?? null,
    request.agentDefName ?? null,
    request.baseBranch ?? null,
    request.branchPrefix ?? null,
    request.existingWorktreePath ?? null,
    request.gitIsolation ?? null,
    request.githubUrl ?? null,
    request.name,
    request.projectId,
    request.projectMode ?? null,
    request.projectRoot,
    request.stepsTracking ?? null,
    Buffer.from(
      worktreeLinkRequest.encodedBytes.buffer,
      worktreeLinkRequest.encodedBytes.byteOffset,
      worktreeLinkRequest.encodedBytes.byteLength,
    ).toString('base64'),
  ]);
}

function rememberTaskCreationOperation(taskId: string, operationId: string): void {
  const operationIds = taskCreationOperationIdsByTaskId.get(taskId) ?? new Set<string>();
  operationIds.add(operationId);
  taskCreationOperationIdsByTaskId.set(taskId, operationIds);
}

export async function createTaskWorkflow(
  context: TaskWorkflowContext,
  request: CreateTaskWorkflowRequest,
): Promise<CreateTaskResult> {
  const worktreeLinkRequest = encodeTaskWorktreeLinkRequestV1(request.symlinkDirs);
  const operationId = request.operationId;
  if (!operationId || operationId.trim().length === 0) {
    return executeCreateTaskWorkflow(context, request, worktreeLinkRequest);
  }

  const fingerprint = getTaskCreationOperationFingerprint(request, worktreeLinkRequest);
  const existingOperation = taskCreationOperationsById.get(operationId);
  if (existingOperation) {
    if (existingOperation.fingerprint !== fingerprint) {
      throw new Error(`Task creation operation ${operationId} was reused with different inputs`);
    }
    return existingOperation.promise;
  }

  const operation: TaskCreationOperation = {
    fingerprint,
    promise: executeCreateTaskWorkflow(context, request, worktreeLinkRequest),
  };
  taskCreationOperationsById.set(operationId, operation);

  try {
    const result = await operation.promise;
    rememberTaskCreationOperation(result.id, operationId);
    return result;
  } catch (error) {
    if (taskCreationOperationsById.get(operationId) === operation) {
      taskCreationOperationsById.delete(operationId);
    }
    throw error;
  }
}

async function executeCreateTaskWorkflow(
  context: TaskWorkflowContext,
  request: CreateTaskWorkflowRequest,
  worktreeLinkRequest: TaskWorktreeLinkRequestV1,
): Promise<CreateTaskResult> {
  if (request.projectMode === 'non-git') {
    if (request.stepsTracking === true) {
      assertTaskStepsPathAvailable(undefined, request.projectRoot);
    }
    const result = createNonGitTask(request.projectRoot);
    registerCreatedNonGitTaskRuntime(request, result);
    return result;
  }

  if (request.gitIsolation === 'current-branch') {
    const canonicalProjectRoot = await getGitRepoRoot(request.projectRoot);
    if (!canonicalProjectRoot) {
      throw new Error(`Project root is not a Git repository: ${request.projectRoot}`);
    }
    const canonicalRequest =
      canonicalProjectRoot === request.projectRoot
        ? request
        : { ...request, projectRoot: canonicalProjectRoot };

    assertWorktreeIdentityAvailable(
      undefined,
      getWorktreeIdentity(canonicalProjectRoot),
      canonicalProjectRoot,
      true,
    );
    const createSharedRootTask = (): Promise<CreateTaskResult> =>
      withRepositoryWorktreeLock(canonicalProjectRoot, async () => {
        if (request.stepsTracking === true)
          assertTaskStepsPathAvailable(undefined, canonicalProjectRoot);
        const result = await createCurrentBranchTask(canonicalProjectRoot, request.baseBranch);
        const baseBranch = result.base_branch ?? request.baseBranch;
        registerCreatedTaskRuntime(context, canonicalRequest, result, baseBranch);
        return result;
      });
    // Only the shared steps file needs exclusive admission; ordinary root tasks are read-only
    // at this boundary and may be prepared concurrently.
    return request.stepsTracking === true
      ? withReservedTaskWorktreeIdentity(canonicalProjectRoot, createSharedRootTask, true)
      : createSharedRootTask();
  }

  if (request.gitIsolation === 'existing-worktree') {
    if (!request.existingWorktreePath) {
      throw new Error('existingWorktreePath is required for existing-worktree tasks');
    }
    const [canonicalProjectRoot, existingWorktreePath] = await Promise.all([
      getGitRepoRoot(request.projectRoot),
      getGitRepoRoot(request.existingWorktreePath),
    ]);
    if (!canonicalProjectRoot) {
      throw new Error(`Project root is not a Git repository: ${request.projectRoot}`);
    }
    if (!existingWorktreePath) {
      throw new Error(`Existing worktree is not a Git repository: ${request.existingWorktreePath}`);
    }
    if (getWorktreeIdentity(canonicalProjectRoot) === getWorktreeIdentity(existingWorktreePath)) {
      throw new Error('Existing worktree import cannot use the project root.');
    }
    const canonicalRequest =
      canonicalProjectRoot === request.projectRoot
        ? request
        : { ...request, projectRoot: canonicalProjectRoot };

    return withReservedTaskWorktreeIdentity(existingWorktreePath, async () => {
      const result = await importExistingWorktreeTask(
        canonicalProjectRoot,
        existingWorktreePath,
        request.baseBranch,
      );
      const baseBranch = result.base_branch ?? request.baseBranch;
      registerCreatedTaskRuntime(context, canonicalRequest, result, baseBranch);

      return result;
    });
  }

  const canonicalProjectRoot = await getGitRepoRoot(request.projectRoot);
  if (!canonicalProjectRoot) {
    throw new Error(`Project root is not a Git repository: ${request.projectRoot}`);
  }
  const canonicalRequest =
    canonicalProjectRoot === request.projectRoot
      ? request
      : { ...request, projectRoot: canonicalProjectRoot };
  const baseBranch = await getMainBranch(canonicalProjectRoot, request.baseBranch);
  const result = await createManagedWorktreeTask(canonicalRequest, worktreeLinkRequest, baseBranch);
  registerCreatedTaskRuntime(context, canonicalRequest, result, baseBranch);

  return {
    ...result,
    base_branch: baseBranch,
  };
}

export async function deleteTaskWorkflow(
  request: DeleteTaskWorkflowRequest,
): Promise<DeleteTaskWorkflowResult> {
  return cleanupTaskInfrastructureWorkflow({
    agentIds: [...request.agentIds],
    branchName: request.branchName,
    deleteBranch: request.deleteBranch,
    gitCleanup: 'managed-worktree',
    projectMode: 'git',
    projectRoot: request.projectRoot,
    taskId: request.taskId,
    worktreePath: request.worktreePath,
  });
}

/** Compatibility workflow for pre-cutover callers and failed-creation rollback. */
export async function cleanupTaskInfrastructureWorkflow(
  request: Readonly<LegacyTaskInfrastructureCleanupRequest>,
): Promise<DeleteTaskWorkflowResult> {
  const cleanupWarnings: DeleteTaskCleanupWarning[] = [];
  await closeTaskAgentSpawns(request.taskId);
  const runnerCleanupWarning = await runDeleteCleanupStep(
    'runners',
    () => cleanupTaskAgentRunners(request.agentIds, request.taskId),
    'Failed to clean agent runners while deleting task:',
  );
  if (runnerCleanupWarning !== null) {
    cleanupWarnings.push(runnerCleanupWarning);
  }

  const containerCleanupWarning = await runDeleteCleanupStep(
    'containers',
    () =>
      destroyManagedTaskContainersByLabels({
        projectPath: request.projectRoot,
        taskId: request.taskId,
        worktreePath: request.worktreePath,
      }),
    'Failed to clean task containers while deleting task:',
  );
  if (containerCleanupWarning !== null) {
    cleanupWarnings.push(containerCleanupWarning);
  }

  const worktreeCleanupWarning = await runDeleteCleanupStep(
    'worktree',
    () =>
      request.gitCleanup === 'managed-worktree'
        ? deleteTask(
            request.branchName,
            request.deleteBranch,
            request.projectRoot,
            request.worktreePath,
          )
        : Promise.resolve(),
    'Failed to clean task worktree while deleting task:',
  );
  if (worktreeCleanupWarning !== null) {
    cleanupWarnings.push(worktreeCleanupWarning);
  }

  const cleanupResult = cleanupTaskRuntimeWorkflow({
    agentIds: [...request.agentIds],
    projectMode: request.projectMode,
    removeTaskState: true,
    taskId: request.taskId,
    worktreePath: request.worktreePath,
  });
  return {
    ...cleanupResult,
    cleanupWarnings,
  };
}
