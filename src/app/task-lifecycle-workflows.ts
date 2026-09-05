import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { resolveAgentRunnerProfile } from '../domain/agent-runners';
import { hasTaskClosingState, isTaskCloseInProgress } from '../domain/task-closing';
import { isTerminalTask } from '../domain/task-mode';
import type { RendererInvokeResponseMap } from '../domain/renderer-invoke';
import { isTerminalTaskMergePhase } from '../domain/task-merge';
import type { TaskCleanupResult, TaskCleanupWarning } from '../domain/task-cleanup';
import type { AgentDef, WorktreeSymlinkWarning, WorktreeSymlinkWarningReason } from '../ipc/types';
import { confirm } from '../lib/dialog';
import { invoke } from '../lib/ipc';
import { isElectronRuntime } from '../lib/browser-auth';
import { createRandomId } from '../lib/random-id';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import {
  getProject,
  getProjectBaseBranch,
  getProjectBranchPrefix,
  getProjectPath,
  isProjectMissing,
} from '../store/projects';
import { showNotification } from '../store/notification';
import { saveCurrentRuntimeState } from '../store/persistence';
import { applyLoadedWorkspaceStateJson } from '../store/persistence-load';
import {
  enqueueWorkspaceOrderEdit,
  enqueueWorkspaceTaskFieldEdit,
} from '../store/persistence-session';
import { getProjectMode } from '../store/project-mode';
import { setStore, store, updateWindowTitle } from '../store/state';
import { isExistingWorktreeTask, isManagedWorktreeTask } from '../store/task-git-isolation';
import { getSelectedTaskRuntimeAgentId } from '../store/task-agent-selection';
import { removeAgentScopedStoreState, removeTaskStoreState } from '../store/task-state-cleanup';
import { clearAgentActivity, markAgentSpawned } from '../store/taskStatus';
import type { Agent, ProjectMode, Task, TaskGitIsolationMode } from '../store/types';
import { clearAgentSupervisionSnapshots } from './task-attention';
import { clearTaskCloseState, markTaskCloseError, markTaskClosing } from './task-close-state';
import { isTaskCommandLeaseSkipped, runWithTaskCommandLease } from './task-command-lease';
import { clearTaskConvergence } from './task-convergence';
import { createPushOutputBinding } from './task-output-channels';
import { clearTaskReview } from './task-review-state';
import { clearTaskReviewSignals } from './task-review-signals';
import {
  getCurrentTaskGitActionDecision,
  notifyTaskGitActionDenial,
} from './task-git-action-capability';
import { applyMergeProgressSnapshot } from './merge-progress';
import {
  areTaskMergeSemanticRequestsEqual,
  clearRetainedTaskMergeOperation,
  getRetainedTaskMergeOperation,
  retainTaskMergeOperation,
  resetRetainedTaskMergeOperationsForTests,
} from './task-merge-operation-access';
import { notifyTaskMergeFinalizerRepair } from './task-merge-operation-recovery';
import {
  admitDesktopTaskNotesRemoval,
  completeDesktopTaskNotesRemoval,
} from './task-notes-recovery-channel';

const collapsingTaskIds = new Set<string>();

function getSharedOrderedTaskIds(order: readonly string[]): string[] {
  return order.filter((taskId) => store.tasks[taskId] !== undefined);
}

interface TaskRuntimeCleanupRequest {
  agentIds: string[];
  projectMode?: ProjectMode;
  projectRoot?: string;
  removeTaskState: boolean;
  taskId: string;
  worktreePath?: string;
}

interface TaskRuntimeCleanupOptions {
  bestEffort: boolean;
  removeTaskState: boolean;
  includeWorktreePath: boolean;
}

const TASK_CONTROLLED_BY_PEER_MESSAGE = 'Task is controlled by another client';

async function admitTaskNotesRemoval(taskId: string, confirmed = false): Promise<boolean> {
  return admitDesktopTaskNotesRemoval(taskId, {
    confirmed,
    confirmDiscard: (message) =>
      confirm(message, {
        cancelLabel: 'Keep task',
        kind: 'warning',
        okLabel: 'Discard notes and continue',
        title: 'Discard unsaved task notes?',
      }),
  });
}

function getRuntimeAgentIds(task: Pick<Task, 'agentIds' | 'shellAgentIds'>): string[] {
  return [...task.agentIds, ...task.shellAgentIds];
}

function createTaskRuntimeCleanupRequest(
  task: Pick<
    Task,
    'agentIds' | 'shellAgentIds' | 'id' | 'projectId' | 'projectMode' | 'worktreePath'
  >,
  options: TaskRuntimeCleanupOptions,
): TaskRuntimeCleanupRequest {
  const projectRoot = options.removeTaskState ? getProjectPath(task.projectId) : undefined;
  return {
    agentIds: getRuntimeAgentIds(task),
    ...(task.projectMode !== undefined ? { projectMode: task.projectMode } : {}),
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    removeTaskState: options.removeTaskState,
    taskId: task.id,
    ...(options.includeWorktreePath && typeof task.worktreePath === 'string'
      ? { worktreePath: task.worktreePath }
      : {}),
  };
}

async function cleanupTaskRuntimeState(
  request: TaskRuntimeCleanupRequest,
): Promise<TaskCleanupResult> {
  return invoke(IPC.CleanupTaskRuntime, {
    agentIds: request.agentIds,
    controllerId: getRuntimeClientId(),
    ...(request.projectMode !== undefined ? { projectMode: request.projectMode } : {}),
    ...(request.projectRoot !== undefined ? { projectRoot: request.projectRoot } : {}),
    ...(request.removeTaskState ? { removeTaskState: true } : {}),
    taskId: request.taskId,
    ...(typeof request.worktreePath === 'string' ? { worktreePath: request.worktreePath } : {}),
  });
}

function isTaskCommandLeaseLossError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(TASK_CONTROLLED_BY_PEER_MESSAGE);
}

async function cleanupTaskRuntimeForTask(
  task: Pick<
    Task,
    'agentIds' | 'shellAgentIds' | 'id' | 'projectId' | 'projectMode' | 'worktreePath'
  >,
  options: TaskRuntimeCleanupOptions,
): Promise<TaskCleanupResult | undefined> {
  const request = createTaskRuntimeCleanupRequest(task, options);
  if (options.bestEffort) {
    return cleanupTaskRuntimeState(request).catch((error) => {
      if (isTaskCommandLeaseLossError(error)) {
        throw error;
      }

      console.error('Failed to clean task runtime state:', error);
      return undefined;
    });
  }

  return cleanupTaskRuntimeState(request);
}

async function killTaskAgentsBestEffort(
  task: Pick<Task, 'agentIds' | 'shellAgentIds'>,
): Promise<void> {
  await Promise.allSettled(
    getRuntimeAgentIds(task).map((agentId) => invoke(IPC.KillAgent, { agentId })),
  );
}

function getCompleteTaskAgentDefs(task: Pick<Task, 'agentIds'>): AgentDef[] | null {
  const agentDefs: AgentDef[] = [];
  for (const agentId of task.agentIds) {
    const agentDef = store.agents[agentId]?.def;
    if (!agentDef) {
      return null;
    }

    agentDefs.push(agentDef);
  }

  return agentDefs;
}

function getSelectedTaskAgentIndex(
  task: Pick<Task, 'agentIds' | 'selectedAgentId'>,
): number | null {
  if (!task.selectedAgentId) {
    return null;
  }

  const index = task.agentIds.indexOf(task.selectedAgentId);
  return index === -1 ? null : index;
}

function createRestoredAgent(taskId: string, agentDef: AgentDef): Agent {
  return {
    id: createRandomId(),
    taskId,
    def: agentDef,
    resumed: true,
    status: 'running',
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 0,
  };
}

function getSelectedRestoredAgent(
  restoredAgents: Agent[],
  savedSelectedAgentIndex: number | undefined,
): Agent | undefined {
  if (savedSelectedAgentIndex === undefined) {
    return restoredAgents[0];
  }

  return restoredAgents[savedSelectedAgentIndex] ?? restoredAgents[0];
}

function getTaskActiveAgentId(
  task: Pick<Task, 'agentIds' | 'selectedAgentId' | 'shellAgentIds'> | null | undefined,
): string | null {
  return task ? getSelectedTaskRuntimeAgentId(task) : null;
}

function syncWindowTitleToActiveSelection(): void {
  const activeId = store.activeTaskId;
  const activeTask = activeId ? store.tasks[activeId] : null;
  const activeTerminal = activeId ? store.terminals[activeId] : null;
  updateWindowTitle(activeTask?.name ?? activeTerminal?.name);
}

function removeTaskFromStore(taskId: string, agentIds: string[]): void {
  for (const agentId of agentIds) {
    clearAgentActivity(agentId);
  }
  clearAgentSupervisionSnapshots(agentIds);
  clearTaskConvergence(taskId);
  clearTaskReview(taskId);
  clearTaskReviewSignals(taskId);

  setStore(
    produce((state) => {
      let neighbor: string | null = null;
      if (state.activeTaskId === taskId) {
        const index = state.taskOrder.indexOf(taskId);
        const filteredOrder = state.taskOrder.filter((id) => id !== taskId);
        const neighborIndex = index <= 0 ? 0 : index - 1;
        neighbor = filteredOrder[neighborIndex] ?? null;
      }

      removeTaskStoreState(state, taskId);

      if (state.activeTaskId === taskId) {
        state.activeTaskId = neighbor;
        const neighborTask = neighbor ? state.tasks[neighbor] : null;
        state.activeAgentId = getTaskActiveAgentId(neighborTask);
      }

      removeAgentScopedStoreState(state, agentIds);
    }),
  );

  syncWindowTitleToActiveSelection();
}

async function persistTaskRemovalBestEffort(taskId: string): Promise<void> {
  try {
    await saveCurrentRuntimeState();
  } catch (error) {
    console.warn(`Failed to persist removal for task ${taskId}:`, error);
  }
}

function getTaskCleanupWarnings(result: TaskCleanupResult | undefined): TaskCleanupWarning[] {
  if (!result || !Array.isArray(result.cleanupWarnings)) {
    return [];
  }

  return result.cleanupWarnings;
}

function requireCommittedTaskRemoval(result: TaskCleanupResult | undefined): void {
  if (
    result?.removalState === undefined ||
    result.removalState === 'complete' ||
    result.removalState === 'finalizer-repair-pending'
  ) {
    return;
  }
  throw new Error(
    result.removalState === 'cleanup-pending'
      ? 'Task cleanup is still pending. Retry closing the task to continue safely.'
      : 'Task removal is waiting for its linked operation to finish.',
  );
}

function getTaskCleanupWarningMessage(warnings: TaskCleanupWarning[]): string {
  const hasWorktreeWarning = warnings.some((warning) => warning.kind === 'worktree');
  const hasContainerWarning = warnings.some((warning) => warning.kind === 'containers');
  const hasRunnerWarning = warnings.some((warning) => warning.kind === 'runners');

  if (hasRunnerWarning) {
    const scopes = [
      ...(hasWorktreeWarning ? ['worktree'] : []),
      'task process',
      ...(hasContainerWarning ? ['container'] : []),
    ];
    const scopeList =
      scopes.length === 1
        ? scopes[0]
        : scopes.length === 2
          ? scopes.join(' and ')
          : `${scopes.slice(0, -1).join(', ')}, and ${scopes[scopes.length - 1]}`;
    return `Task closed, but ${scopeList} cleanup did not finish. Check server logs before reusing this task${hasWorktreeWarning ? ' branch' : ''}.`;
  }

  if (hasWorktreeWarning && hasContainerWarning) {
    return 'Task closed, but worktree and container cleanup did not finish. Check server logs before reusing this task branch.';
  }

  if (hasWorktreeWarning) {
    return 'Task closed, but worktree cleanup did not finish. Check server logs before reusing this task branch.';
  }

  return 'Task closed, but container cleanup did not finish. Check server logs before reusing this task.';
}

function reportTaskCleanupWarnings(taskId: string, warnings: TaskCleanupWarning[]): void {
  if (warnings.length === 0) {
    return;
  }

  console.warn(`Task ${taskId} closed with cleanup warnings:`, warnings);
  showNotification(getTaskCleanupWarningMessage(warnings));
}

function reportWorktreeSymlinkWarnings(warnings: readonly WorktreeSymlinkWarning[]): void {
  if (warnings.length === 0) {
    return;
  }

  const reasonCounts: Partial<Record<WorktreeSymlinkWarningReason, number>> = {};
  for (const warning of warnings) {
    reasonCounts[warning.reason] = (reasonCounts[warning.reason] ?? 0) + 1;
  }

  console.warn('Task created with ignored-file sharing warnings:', {
    count: warnings.length,
    reasonCounts,
  });
  showNotification(
    warnings.length === 1
      ? 'Task created, but 1 ignored entry could not be shared with its worktree.'
      : `Task created, but ${warnings.length} ignored entries could not be shared with its worktree.`,
  );
}

export type TaskLaunch =
  | {
      kind: 'agent';
      agentDef: AgentDef;
      initialPrompt?: string;
      skipPermissions?: boolean;
      coordinatorMode?: boolean;
    }
  | { kind: 'terminal' };

export interface TaskCreationOptions {
  /** Stable identity allocated by the desktop submission owner and reused for exact retries. */
  adapterOperationId: string;
  name: string;
  projectId: string;
  baseBranch?: string;
  githubUrl?: string;
  launch: TaskLaunch;
  stepsTracking?: boolean;
}

export interface CreateTaskOptions extends TaskCreationOptions {
  gitIsolation?: TaskGitIsolationMode;
  existingWorktreePath?: string;
  symlinkDirs?: string[];
  branchPrefixOverride?: string;
  projectMode?: ProjectMode;
}

export async function createTask(opts: CreateTaskOptions): Promise<string> {
  const {
    name,
    projectId,
    baseBranch,
    gitIsolation = 'worktree',
    existingWorktreePath,
    symlinkDirs = [],
    githubUrl,
    launch,
    stepsTracking,
    adapterOperationId,
  } = opts;
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) {
    throw new Error('Project not found');
  }
  if (isProjectMissing(projectId)) {
    throw new Error('Project folder not found');
  }

  const project = getProject(projectId);
  const projectMode = opts.projectMode ?? getProjectMode(project);
  if (launch.kind === 'agent' && launch.coordinatorMode === true) {
    if (isElectronRuntime()) {
      throw new Error('Coordinator mode is available in browser server mode.');
    }
    const runnerResolution = resolveAgentRunnerProfile(
      project?.agentRunnerConfig,
      project?.containerConfig,
    );
    if (runnerResolution.activeProvider !== 'host') {
      throw new Error('Coordinator mode currently requires host-run agents.');
    }
  }
  const resolvedBaseBranch =
    projectMode === 'git' ? (baseBranch ?? getProjectBaseBranch(projectId)) : undefined;
  const branchPrefix = opts.branchPrefixOverride ?? getProjectBranchPrefix(projectId);
  const result = await invoke(IPC.CreateTask, {
    ...(launch.kind === 'agent'
      ? {
          agentDefId: launch.agentDef.id,
          agentDefName: launch.agentDef.name,
          ...(launch.coordinatorMode !== undefined
            ? { coordinatorMode: launch.coordinatorMode }
            : {}),
          ...(launch.initialPrompt !== undefined ? { initialPrompt: launch.initialPrompt } : {}),
          ...(launch.skipPermissions !== undefined
            ? { skipPermissions: launch.skipPermissions }
            : {}),
        }
      : {}),
    ...(typeof resolvedBaseBranch === 'string' ? { baseBranch: resolvedBaseBranch } : {}),
    name,
    operationId: adapterOperationId,
    ...(projectMode === 'non-git' ? { projectMode } : {}),
    ...(projectMode === 'git' ? { branchPrefix } : {}),
    ...(projectMode === 'git' && gitIsolation !== undefined ? { gitIsolation } : {}),
    ...(projectMode === 'git' && existingWorktreePath !== undefined
      ? { existingWorktreePath }
      : {}),
    ...(githubUrl !== undefined ? { githubUrl } : {}),
    projectId,
    projectRoot,
    symlinkDirs,
    ...(stepsTracking !== undefined ? { stepsTracking } : {}),
  });

  if (
    result.creation_writer_epoch !== 'managed-initial-shell-v1' ||
    !result.session_id ||
    !Number.isSafeInteger(result.workspace_revision) ||
    (result.workspace_revision ?? -1) < 1
  ) {
    throw new Error('Managed task creation did not return its canonical commit identity');
  }
  const canonical = await invoke(IPC.LoadWorkspaceState);
  if (!canonical?.json || canonical.revision < (result.workspace_revision as number)) {
    throw new Error('Created task canonical workspace projection is unavailable');
  }
  applyLoadedWorkspaceStateJson(canonical.json, canonical.revision);
  const runtimeId = result.session_id;
  const canonicalTask = store.tasks[result.id];
  if (
    !canonicalTask ||
    canonicalTask.taskMode !== launch.kind ||
    canonicalTask.projectId !== projectId ||
    canonicalTask.branchName !== result.branch_name ||
    canonicalTask.worktreePath !== result.worktree_path ||
    (launch.kind === 'agent'
      ? !canonicalTask.agentIds.includes(runtimeId) || !store.agents[runtimeId]
      : !canonicalTask.shellAgentIds.includes(runtimeId))
  ) {
    throw new Error('Created task canonical projection does not match its committed identity');
  }
  if (launch.kind === 'agent' && launch.coordinatorMode === true) {
    const canonicalAgent = store.agents[runtimeId];
    const env = canonicalAgent?.def.env;
    if (
      canonicalTask.coordinatorRole !== 'coordinator' ||
      canonicalTask.coordinatorRunId !== result.coordinator_run_id ||
      canonicalTask.coordinatorCredentialPath !== result.coordinator_credential_path ||
      env?.PARALLEL_CODE_COORDINATOR_RUN_ID !== result.coordinator_run_id ||
      env?.PARALLEL_CODE_COORDINATOR_CREDENTIAL !== result.coordinator_credential_path ||
      (result.coordinator_tool_command !== undefined &&
        env?.PARALLEL_CODE_COORDINATOR_TOOL !== result.coordinator_tool_command)
    ) {
      throw new Error('Created coordinator canonical launch metadata is unavailable');
    }
  }

  setStore(
    produce((state) => {
      if (launch.kind === 'terminal') state.focusedPanel[result.id] = 'shell:0';
      state.activeTaskId = result.id;
      state.activeAgentId = runtimeId;
      state.lastProjectId = projectId;
      if (launch.kind === 'agent') state.lastAgentId = launch.agentDef.id;
    }),
  );

  markAgentSpawned(runtimeId);
  updateWindowTitle(name);
  reportWorktreeSymlinkWarnings(result.symlink_warnings ?? []);
  return result.id;
}

export type CreateCurrentBranchTaskOptions = TaskCreationOptions;

export async function createCurrentBranchTask(
  opts: CreateCurrentBranchTaskOptions,
): Promise<string> {
  const { adapterOperationId, name, projectId, baseBranch, githubUrl, launch } = opts;
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) {
    throw new Error('Project not found');
  }
  if (isProjectMissing(projectId)) {
    throw new Error('Project folder not found');
  }

  return createTask({
    adapterOperationId,
    name,
    launch,
    projectId,
    ...(typeof baseBranch === 'string' ? { baseBranch } : {}),
    gitIsolation: 'current-branch',
    symlinkDirs: [],
    ...(githubUrl !== undefined ? { githubUrl } : {}),
    ...(opts.stepsTracking !== undefined ? { stepsTracking: opts.stepsTracking } : {}),
  });
}

export const createDirectTask = createCurrentBranchTask;
export type CreateDirectTaskOptions = CreateCurrentBranchTaskOptions;

export interface CreateExistingWorktreeTaskOptions extends CreateCurrentBranchTaskOptions {
  existingWorktreePath: string;
}

export async function createExistingWorktreeTask(
  opts: CreateExistingWorktreeTaskOptions,
): Promise<string> {
  return createTask({
    adapterOperationId: opts.adapterOperationId,
    name: opts.name,
    launch: opts.launch,
    projectId: opts.projectId,
    ...(typeof opts.baseBranch === 'string' ? { baseBranch: opts.baseBranch } : {}),
    existingWorktreePath: opts.existingWorktreePath,
    gitIsolation: 'existing-worktree',
    symlinkDirs: [],
    ...(opts.githubUrl !== undefined ? { githubUrl: opts.githubUrl } : {}),
    ...(opts.stepsTracking !== undefined ? { stepsTracking: opts.stepsTracking } : {}),
  });
}

export interface CloseTaskOptions {
  taskNotesDiscardConfirmed?: boolean;
}

export async function closeTask(taskId: string, options: CloseTaskOptions = {}): Promise<void> {
  const initialTask = store.tasks[taskId];
  if (!initialTask || isTaskCloseInProgress(initialTask)) {
    return;
  }

  const result = await runWithTaskCommandLease(taskId, 'close this task', async () => {
    const task = store.tasks[taskId];
    if (!task || isTaskCloseInProgress(task)) return;
    if (!(await admitTaskNotesRemoval(taskId, options.taskNotesDiscardConfirmed))) return;

    const branchName = task.branchName;
    const projectRoot = getProjectPath(task.projectId) ?? '';
    const deleteBranch = getProject(task.projectId)?.deleteBranchOnClose ?? true;

    markTaskClosing(taskId);

    try {
      const runtimeAgentIds = getRuntimeAgentIds(task);
      if (isManagedWorktreeTask(task)) {
        const deleteResult = await invoke(IPC.DeleteTask, {
          taskId,
          agentIds: runtimeAgentIds,
          branchName,
          controllerId: getRuntimeClientId(),
          deleteBranch,
          projectRoot,
          worktreePath: task.worktreePath,
        });
        requireCommittedTaskRemoval(deleteResult);
        reportTaskCleanupWarnings(taskId, getTaskCleanupWarnings(deleteResult));
      } else {
        const cleanupResult = await cleanupTaskRuntimeForTask(task, {
          bestEffort: false,
          includeWorktreePath: true,
          removeTaskState: true,
        });
        requireCommittedTaskRemoval(cleanupResult);
        reportTaskCleanupWarnings(taskId, getTaskCleanupWarnings(cleanupResult));
      }

      completeDesktopTaskNotesRemoval(taskId);
      removeTaskFromStore(taskId, runtimeAgentIds);
      await persistTaskRemovalBestEffort(taskId);
    } catch (error) {
      console.error('Failed to close task:', error);
      markTaskCloseError(taskId, String(error));
    }
  });

  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }
}

export async function retryCloseTask(taskId: string): Promise<void> {
  clearTaskCloseState(taskId);
  await closeTask(taskId);
}

function getTaskGitWorkflowAdmission(
  action: 'merge' | 'push',
  taskId: string,
): { projectRoot: string; task: Task } | null {
  const decision = getCurrentTaskGitActionDecision(action, taskId);
  if (!decision.allowed) {
    notifyTaskGitActionDenial(decision);
    return null;
  }

  const task = store.tasks[taskId];
  const projectRoot = task ? getProjectPath(task.projectId) : null;
  if (!task || !projectRoot) {
    return null;
  }
  return { projectRoot, task };
}

export async function mergeTask(
  taskId: string,
  options?: { squash?: boolean; message?: string; cleanup?: boolean },
): Promise<void> {
  if (!getTaskGitWorkflowAdmission('merge', taskId)) return;

  const result = await runWithTaskCommandLease(taskId, 'merge this task', async () => {
    // Lease acquisition is asynchronous. Re-read the capability and task snapshot at the final
    // effect boundary so collapse/close/project churn cannot reach Git through a stale closure.
    const admission = getTaskGitWorkflowAdmission('merge', taskId);
    if (!admission) return;
    const { task } = admission;
    const cleanup = !isExistingWorktreeTask(task) && options?.cleanup === true;
    if (cleanup && !(await admitTaskNotesRemoval(taskId))) return;
    const controllerId = getRuntimeClientId();
    const semanticRequest = {
      cleanup,
      ...(options?.message !== undefined ? { message: options.message } : {}),
      squash: options?.squash ?? false,
      taskId,
    };
    let retained = getRetainedTaskMergeOperation(taskId);
    let mergeResult: RendererInvokeResponseMap[IPC.StartTaskMergeOperation] | undefined;
    if (retained) {
      const status = await invoke(IPC.GetTaskMergeOperationStatus, {
        access: retained.access,
        controllerId,
      });
      const terminal = isTerminalTaskMergePhase(status.originalOutcome.phase);
      if (!areTaskMergeSemanticRequestsEqual(retained.semanticRequest, semanticRequest)) {
        if (!terminal) {
          throw new Error('A task merge with different options is already in progress');
        }
        clearRetainedTaskMergeOperation(taskId, retained.access.operationId);
        retained = null;
      } else if (terminal || status.originalOutcome.phase === 'manual-reconciliation-required') {
        mergeResult = status;
      }
    }
    if (!retained) {
      const issued = await invoke(IPC.IssueTaskMergeOperation, { controllerId, taskId });
      if (!retainTaskMergeOperation(issued, semanticRequest)) {
        throw new Error('Task merge operation access could not be retained for recovery');
      }
      retained = getRetainedTaskMergeOperation(taskId);
      if (!retained) {
        throw new Error('Task merge operation access could not be retained for recovery');
      }
    }
    mergeResult ??= await invoke(IPC.StartTaskMergeOperation, {
      access: retained.access,
      controllerId,
      semanticRequest,
    });
    applyMergeProgressSnapshot(mergeResult.currentProgress);

    const outcome = mergeResult.originalOutcome;
    const terminal = isTerminalTaskMergePhase(outcome.phase);
    const releasedRetainedAccess = terminal
      ? clearRetainedTaskMergeOperation(taskId, outcome.operationId)
      : false;
    if (
      releasedRetainedAccess &&
      mergeResult.currentRemoval?.removalState === 'finalizer-repair-pending'
    ) {
      notifyTaskMergeFinalizerRepair();
    }

    if (outcome.phase === 'failed') {
      throw new Error(`Task merge failed (${outcome.issue?.code ?? 'unknown'})`);
    }
    if (outcome.phase === 'manual-reconciliation-required') {
      throw new Error('Task merge outcome needs local reconciliation before it can continue');
    }
    if (outcome.phase === 'expired-unused' || outcome.phase === 'superseded-unused') {
      throw new Error('Task merge operation expired before admission');
    }
    if (cleanup && outcome.phase !== 'completed') {
      throw new Error('Task merge cleanup is still pending and can be retried safely');
    }
    if (!cleanup && outcome.phase !== 'completed-not-counted') {
      throw new Error('Task merge did not reach a completed state');
    }

    if (cleanup) {
      const canonical = await invoke(IPC.LoadWorkspaceState);
      if (!canonical?.json) {
        throw new Error('Merged task canonical removal projection is unavailable');
      }
      return {
        canonical: { json: canonical.json, revision: canonical.revision },
      };
    }
    return null;
  });

  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }
  if (!result) return;

  // Project canonical absence only after the enclosing command lease has released. Applying the
  // projection clears removed-task runtime state, including retained lease state; doing that inside
  // the lease callback would race its mandatory backend release.
  applyLoadedWorkspaceStateJson(result.canonical.json, result.canonical.revision);
  if (store.tasks[taskId]) {
    throw new Error('Merged task remains in canonical workspace state');
  }
  completeDesktopTaskNotesRemoval(taskId);
}

export async function pushTask(taskId: string, onOutput?: (text: string) => void): Promise<void> {
  if (!getTaskGitWorkflowAdmission('push', taskId)) return;

  const result = await runWithTaskCommandLease(taskId, 'push this task', async () => {
    const admission = getTaskGitWorkflowAdmission('push', taskId);
    if (!admission) return;
    const { projectRoot, task } = admission;
    const { channel, cleanup } = createPushOutputBinding(onOutput);

    try {
      await invoke(IPC.PushTask, {
        projectRoot,
        branchName: task.branchName,
        controllerId: getRuntimeClientId(),
        taskId,
        ...(channel ? { onOutput: channel } : {}),
      });
    } finally {
      cleanup();
    }
  });

  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }
}

export async function collapseTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.collapsed || hasTaskClosingState(task) || collapsingTaskIds.has(taskId)) {
    return;
  }

  collapsingTaskIds.add(taskId);
  let result: Awaited<ReturnType<typeof runWithTaskCommandLease<void>>>;
  try {
    result = await runWithTaskCommandLease(taskId, 'collapse this task', async () => {
      try {
        const agentDefs = getCompleteTaskAgentDefs(task);
        const agentDef = agentDefs?.[0];
        const selectedAgentIndex = getSelectedTaskAgentIndex(task);
        const runtimeAgentIds = getRuntimeAgentIds(task);

        await killTaskAgentsBestEffort(task);
        await cleanupTaskRuntimeForTask(task, {
          bestEffort: true,
          includeWorktreePath: false,
          removeTaskState: false,
        });
        for (const agentId of runtimeAgentIds) {
          clearAgentActivity(agentId);
        }
        clearAgentSupervisionSnapshots(runtimeAgentIds);

        const baseActiveOrder = getSharedOrderedTaskIds(store.taskOrder);
        const baseCollapsedOrder = getSharedOrderedTaskIds(store.collapsedTaskOrder);
        setStore(
          produce((state) => {
            const currentTask = state.tasks[taskId];
            if (!currentTask) {
              return;
            }

            currentTask.collapsed = true;
            if (agentDef) {
              currentTask.savedAgentDef = agentDef;
            } else {
              delete currentTask.savedAgentDef;
            }
            if (agentDefs && agentDefs.length > 1) {
              currentTask.savedAgentDefs = agentDefs;
              if (selectedAgentIndex !== null) {
                currentTask.savedSelectedAgentIndex = selectedAgentIndex;
              } else {
                delete currentTask.savedSelectedAgentIndex;
              }
            } else {
              delete currentTask.savedAgentDefs;
              delete currentTask.savedSelectedAgentIndex;
            }
            currentTask.agentIds = [];
            delete currentTask.selectedAgentId;
            currentTask.shellAgentIds = [];
            const index = state.taskOrder.indexOf(taskId);
            if (index !== -1) {
              state.taskOrder.splice(index, 1);
            }
            state.collapsedTaskOrder.push(taskId);

            removeAgentScopedStoreState(state, runtimeAgentIds);

            if (state.activeTaskId === taskId) {
              const neighbor = state.taskOrder[Math.max(0, index - 1)] ?? null;
              state.activeTaskId = neighbor;
              const neighborTask = neighbor ? state.tasks[neighbor] : null;
              state.activeAgentId = getTaskActiveAgentId(neighborTask);
            }
          }),
        );
        enqueueWorkspaceOrderEdit(
          'active',
          baseActiveOrder,
          getSharedOrderedTaskIds(store.taskOrder),
        );
        enqueueWorkspaceOrderEdit(
          'collapsed',
          baseCollapsedOrder,
          getSharedOrderedTaskIds(store.collapsedTaskOrder),
        );
        enqueueWorkspaceTaskFieldEdit(taskId, 'collapsed', undefined, true);

        syncWindowTitleToActiveSelection();
      } catch (error) {
        console.error('Failed to collapse task:', error);
      }
    });
  } finally {
    collapsingTaskIds.delete(taskId);
  }

  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }
}

export async function uncollapseTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || !task.collapsed) {
    return;
  }

  const result = await runWithTaskCommandLease(taskId, 'restore this task', async () => {
    const terminalShellId = isTerminalTask(task) ? createRandomId() : null;
    const savedDefs = isTerminalTask(task)
      ? []
      : (task.savedAgentDefs ?? (task.savedAgentDef ? [task.savedAgentDef] : []));
    const restoredAgents = savedDefs.map((agentDef) => createRestoredAgent(taskId, agentDef));
    const selectedRestoredAgent = getSelectedRestoredAgent(
      restoredAgents,
      task.savedSelectedAgentIndex,
    );

    const baseActiveOrder = getSharedOrderedTaskIds(store.taskOrder);
    const baseCollapsedOrder = getSharedOrderedTaskIds(store.collapsedTaskOrder);
    setStore(
      produce((state) => {
        const currentTask = state.tasks[taskId];
        if (!currentTask) {
          return;
        }

        currentTask.collapsed = false;
        state.collapsedTaskOrder = state.collapsedTaskOrder.filter((id) => id !== taskId);
        state.taskOrder.push(taskId);
        state.activeTaskId = taskId;

        if (terminalShellId) {
          currentTask.agentIds = [];
          delete currentTask.selectedAgentId;
          currentTask.shellAgentIds = [terminalShellId];
          delete currentTask.savedAgentDef;
          delete currentTask.savedAgentDefs;
          delete currentTask.savedSelectedAgentIndex;
          state.focusedPanel[taskId] = 'shell:0';
        } else if (restoredAgents.length > 0) {
          for (const agent of restoredAgents) {
            state.agents[agent.id] = agent;
          }
          currentTask.agentIds = restoredAgents.map((agent) => agent.id);
          const selectedAgentId = selectedRestoredAgent?.id ?? restoredAgents[0]?.id;
          if (selectedAgentId) {
            currentTask.selectedAgentId = selectedAgentId;
          } else {
            delete currentTask.selectedAgentId;
          }
          delete currentTask.savedAgentDef;
          delete currentTask.savedAgentDefs;
          delete currentTask.savedSelectedAgentIndex;
        }

        state.activeAgentId = getTaskActiveAgentId(currentTask);
      }),
    );
    enqueueWorkspaceOrderEdit('active', baseActiveOrder, getSharedOrderedTaskIds(store.taskOrder));
    enqueueWorkspaceOrderEdit(
      'collapsed',
      baseCollapsedOrder,
      getSharedOrderedTaskIds(store.collapsedTaskOrder),
    );
    enqueueWorkspaceTaskFieldEdit(taskId, 'collapsed', true, undefined);

    for (const agent of restoredAgents) {
      markAgentSpawned(agent.id);
    }
    if (terminalShellId) {
      markAgentSpawned(terminalShellId);
    }

    updateWindowTitle(task.name);
  });

  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }
}

export function resetTaskLifecycleRuntimeStateForTests(): void {
  collapsingTaskIds.clear();
  resetRetainedTaskMergeOperationsForTests();
}
