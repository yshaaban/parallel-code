import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { resolveAgentRunnerProfile } from '../domain/agent-runners';
import { buildCoordinatorInitialPrompt } from '../domain/coordinator-instructions';
import {
  hasProjectCurrentBranchTask,
  hasTaskClosingState,
  isTaskCloseInProgress,
  isTaskRemoving,
} from '../domain/task-closing';
import { isTerminalTask } from '../domain/task-mode';
import type { TaskCleanupResult, TaskCleanupWarning } from '../domain/task-cleanup';
import type { AgentDef } from '../ipc/types';
import { invoke } from '../lib/ipc';
import { isElectronRuntime } from '../lib/browser-auth';
import { createRandomId } from '../lib/random-id';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { recordMergedLines, recordMergedTaskToday } from '../store/completion';
import {
  getProject,
  getProjectBaseBranch,
  getProjectBranchPrefix,
  getProjectPath,
  isProjectMissing,
} from '../store/projects';
import { showNotification } from '../store/notification';
import { saveCurrentRuntimeState } from '../store/persistence';
import { buildTaskProjectModeFields, getProjectMode, isNonGitProject } from '../store/project-mode';
import { setStore, store, updateWindowTitle } from '../store/state';
import {
  buildTaskGitIsolationFields,
  isCurrentBranchTask,
  isExistingWorktreeTask,
  isManagedWorktreeTask,
} from '../store/task-git-isolation';
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
import type { CoordinatorCreateRunResult } from '../domain/coordinator';

const collapsingTaskIds = new Set<string>();

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

function buildTaskInitialPrompt(
  initialPrompt: string | undefined,
  coordinatorMode: boolean,
  coordinatorRunResult: CoordinatorCreateRunResult | undefined,
): string | undefined {
  if (!coordinatorMode) {
    return initialPrompt;
  }
  if (coordinatorRunResult?.toolCommand === undefined) {
    return buildCoordinatorInitialPrompt(initialPrompt);
  }

  return buildCoordinatorInitialPrompt(initialPrompt, {
    toolCommand: coordinatorRunResult.toolCommand,
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

async function rollbackCreatedTaskAfterCoordinatorFailure(options: {
  agentIds: string[];
  branchName: string;
  gitIsolation: TaskGitIsolationMode;
  projectMode: ProjectMode;
  projectRoot: string;
  taskId: string;
  worktreePath: string;
}): Promise<void> {
  const controllerId = getRuntimeClientId();
  try {
    const lease = await invoke(IPC.AcquireTaskCommandLease, {
      action: 'roll back failed coordinator setup',
      clientId: controllerId,
      ownerId: controllerId,
      taskId: options.taskId,
      takeover: true,
    });
    if (!lease.acquired) {
      throw new Error('Failed to acquire rollback control for coordinator setup');
    }

    if (options.projectMode === 'git' && options.gitIsolation === 'worktree') {
      const cleanupResult = await invoke(IPC.DeleteTask, {
        agentIds: options.agentIds,
        branchName: options.branchName,
        controllerId,
        deleteBranch: true,
        projectRoot: options.projectRoot,
        taskId: options.taskId,
        worktreePath: options.worktreePath,
      });
      reportTaskCleanupWarnings(options.taskId, getTaskCleanupWarnings(cleanupResult));
      return;
    }

    const cleanupResult = await invoke(IPC.CleanupTaskRuntime, {
      agentIds: options.agentIds,
      controllerId,
      projectMode: options.projectMode,
      projectRoot: options.projectRoot,
      removeTaskState: true,
      taskId: options.taskId,
      worktreePath: options.worktreePath,
    });
    reportTaskCleanupWarnings(options.taskId, getTaskCleanupWarnings(cleanupResult));
  } catch (error) {
    console.warn('Failed to roll back task after coordinator setup failure:', error);
  } finally {
    await invoke(IPC.ReleaseTaskCommandLease, {
      clientId: controllerId,
      ownerId: controllerId,
      taskId: options.taskId,
    }).catch(() => undefined);
  }
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
      ? { agentDefId: launch.agentDef.id, agentDefName: launch.agentDef.name }
      : {}),
    ...(typeof resolvedBaseBranch === 'string' ? { baseBranch: resolvedBaseBranch } : {}),
    name,
    operationId: createRandomId(),
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

  const runtimeId = createRandomId();
  const resolvedGitIsolation = result.git_isolation ?? gitIsolation;
  const resultProjectMode = result.project_mode ?? projectMode;
  const taskBaseBranch =
    resultProjectMode === 'git' ? (result.base_branch ?? resolvedBaseBranch) : undefined;
  let coordinatorRunResult: CoordinatorCreateRunResult | undefined;
  if (launch.kind === 'agent' && launch.coordinatorMode === true) {
    try {
      coordinatorRunResult = await invoke(IPC.CoordinatorCreateRun, {
        coordinatorAgentId: runtimeId,
        coordinatorTaskId: result.id,
        projectId,
        projectMode: resultProjectMode,
        projectRoot,
      });
    } catch (error) {
      await rollbackCreatedTaskAfterCoordinatorFailure({
        agentIds: [],
        branchName: result.branch_name,
        gitIsolation: resolvedGitIsolation,
        projectMode: resultProjectMode,
        projectRoot,
        taskId: result.id,
        worktreePath: result.worktree_path,
      });
      throw error;
    }
  }
  const taskInitialPrompt =
    launch.kind === 'agent'
      ? buildTaskInitialPrompt(
          launch.initialPrompt,
          launch.coordinatorMode === true,
          coordinatorRunResult,
        )
      : undefined;
  const task: Task = {
    id: result.id,
    taskMode: launch.kind,
    name,
    projectId,
    branchName: result.branch_name,
    worktreePath: result.worktree_path,
    agentIds: launch.kind === 'agent' ? [runtimeId] : [],
    ...(launch.kind === 'agent' ? { selectedAgentId: runtimeId } : {}),
    shellAgentIds: launch.kind === 'terminal' ? [runtimeId] : [],
    notes: '',
    lastPrompt: '',
    ...buildTaskProjectModeFields({ projectMode: resultProjectMode }),
    ...(resultProjectMode === 'git'
      ? buildTaskGitIsolationFields({ gitIsolation: resolvedGitIsolation })
      : {}),
    ...(typeof taskBaseBranch === 'string' ? { baseBranch: taskBaseBranch } : {}),
    ...(taskInitialPrompt ? { initialPrompt: taskInitialPrompt } : {}),
    ...(launch.kind === 'agent' && launch.skipPermissions ? { skipPermissions: true } : {}),
    ...(stepsTracking !== undefined ? { stepsTracking } : {}),
    ...(githubUrl !== undefined ? { githubUrl } : {}),
    ...(taskInitialPrompt ? { savedInitialPrompt: taskInitialPrompt } : {}),
    ...(coordinatorRunResult !== undefined
      ? {
          coordinatorCredentialPath: coordinatorRunResult.credentialPath,
          coordinatorRole: 'coordinator' as const,
          coordinatorRunId: coordinatorRunResult.run.id,
          ...(coordinatorRunResult.toolCommand !== undefined
            ? { coordinatorToolCommand: coordinatorRunResult.toolCommand }
            : {}),
        }
      : {}),
  };

  const agent: Agent | undefined =
    launch.kind === 'agent'
      ? {
          id: runtimeId,
          taskId: result.id,
          def: launch.agentDef,
          resumed: false,
          status: 'running',
          exitCode: null,
          signal: null,
          lastOutput: [],
          generation: 0,
        }
      : undefined;

  setStore(
    produce((state) => {
      state.tasks[result.id] = task;
      if (agent) {
        state.agents[runtimeId] = agent;
      } else {
        state.focusedPanel[result.id] = 'shell:0';
      }
      state.taskOrder.push(result.id);
      state.activeTaskId = result.id;
      state.activeAgentId = runtimeId;
      state.lastProjectId = projectId;
      if (agent && launch.kind === 'agent') {
        state.lastAgentId = launch.agentDef.id;
      }
    }),
  );

  markAgentSpawned(runtimeId);
  updateWindowTitle(name);
  return result.id;
}

export type CreateCurrentBranchTaskOptions = TaskCreationOptions;

export async function createCurrentBranchTask(
  opts: CreateCurrentBranchTaskOptions,
): Promise<string> {
  const { name, projectId, baseBranch, githubUrl, launch } = opts;
  if (
    hasProjectCurrentBranchTask(
      [...store.taskOrder, ...store.collapsedTaskOrder],
      store.tasks,
      projectId,
    )
  ) {
    throw new Error('A project-root task already exists for this project');
  }

  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) {
    throw new Error('Project not found');
  }
  if (isProjectMissing(projectId)) {
    throw new Error('Project folder not found');
  }

  return createTask({
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

export async function closeTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || isTaskCloseInProgress(task)) {
    return;
  }

  const result = await runWithTaskCommandLease(taskId, 'close this task', async () => {
    const branchName = task.branchName;
    const projectRoot = getProjectPath(task.projectId) ?? '';
    const deleteBranch = getProject(task.projectId)?.deleteBranchOnClose ?? true;

    markTaskClosing(taskId);

    try {
      await killTaskAgentsBestEffort(task);

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
        reportTaskCleanupWarnings(taskId, getTaskCleanupWarnings(deleteResult));
      } else {
        const cleanupResult = await cleanupTaskRuntimeForTask(task, {
          bestEffort: false,
          includeWorktreePath: true,
          removeTaskState: true,
        });
        reportTaskCleanupWarnings(taskId, getTaskCleanupWarnings(cleanupResult));
      }

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

export async function mergeTask(
  taskId: string,
  options?: { squash?: boolean; message?: string; cleanup?: boolean },
): Promise<void> {
  const task = store.tasks[taskId];
  if (
    !task ||
    isTaskRemoving(task) ||
    task.collapsed ||
    isCurrentBranchTask(task) ||
    isNonGitProject(task)
  ) {
    return;
  }

  const projectRoot = getProjectPath(task.projectId);
  if (!projectRoot) {
    return;
  }

  const result = await runWithTaskCommandLease(taskId, 'merge this task', async () => {
    const branchName = task.branchName;
    const cleanup = !isExistingWorktreeTask(task) && options?.cleanup === true;
    const runtimeAgentIds = getRuntimeAgentIds(task);

    const mergeResult = await invoke(IPC.MergeTask, {
      projectRoot,
      branchName,
      ...(task.baseBranch !== undefined ? { baseBranch: task.baseBranch } : {}),
      squash: options?.squash ?? false,
      cleanup,
      controllerId: getRuntimeClientId(),
      taskId,
      worktreePath: task.worktreePath,
      ...(options?.message !== undefined ? { message: options.message } : {}),
    });
    recordMergedLines(mergeResult.lines_added, mergeResult.lines_removed);

    if (cleanup) {
      await killTaskAgentsBestEffort(task);
      const cleanupResult = await cleanupTaskRuntimeForTask(task, {
        bestEffort: true,
        includeWorktreePath: true,
        removeTaskState: true,
      });
      reportTaskCleanupWarnings(taskId, getTaskCleanupWarnings(cleanupResult));
      recordMergedTaskToday();
      removeTaskFromStore(taskId, runtimeAgentIds);
      await persistTaskRemovalBestEffort(taskId);
    }
  });

  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }
}

export async function pushTask(taskId: string, onOutput?: (text: string) => void): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || isCurrentBranchTask(task) || isNonGitProject(task)) {
    return;
  }

  const projectRoot = getProjectPath(task.projectId);
  if (!projectRoot) {
    return;
  }

  const result = await runWithTaskCommandLease(taskId, 'push this task', async () => {
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
}
