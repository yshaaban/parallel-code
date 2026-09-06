import { IPC } from './channels.js';
import type { HandlerContext, IpcHandler } from './handler-context.js';
import {
  getAllFileDiffs,
  getAllFileDiffsFromBranch,
  checkMergeStatus,
  createWorktree,
  getBranchLog,
  getChangedFiles,
  getChangedFilesFromBranch,
  getBranchCommitHistory,
  getCurrentBranch,
  getFileDiff,
  getFileDiffFromBranch,
  getGitRepoRoot,
  listBranches,
  listImportableWorktrees,
  getMainBranch,
  getProjectDiff,
  streamPushTask,
  getWorktreeStatus,
  mergeTask,
  removeWorktree,
} from './git.js';
import {
  commitAllWorkflow,
  discardUncommittedWorkflow,
  rebaseTaskWorkflow,
  scheduleTaskConvergenceRefreshForGitTarget,
  scheduleTaskReviewRefreshForGitTarget,
} from './git-status-workflows.js';
import {
  cleanupTaskRuntimeWorkflow,
  createTaskWorkflow,
  deleteTaskWorkflow,
  findRegisteredTaskIdForWorktreePath,
  hasRegisteredSharedRootTask,
  stopTaskAgentWorkflowsForTask,
} from './task-workflows.js';
import {
  cleanupCoordinatorTaskStateAndOwnedSubtasks,
  executeCoordinatorProducer,
} from '../coordinator/tool-gateway.js';
import { scheduleTaskReviewSignalsRefresh } from './task-review-signals.js';
import { destroyManagedTaskContainersByLabels } from './task-containers.js';
import {
  assertBoolean,
  assertOptionalBoolean,
  assertOptionalString,
  assertString,
  assertStringArray,
} from './validate.js';
import { BadRequestError } from './errors.js';
import {
  validateBranchName,
  validateOptionalBranchName,
  validatePath,
  validateRelativePath,
} from './path-utils.js';
import { getOptionalChannelId } from './channel-id.js';
import { isTaskCommandLeaseHeld } from './task-command-leases.js';
import {
  encodeTaskWorktreeLinkRequestV1,
  getWorktreeSymlinkCandidates,
} from './git-worktree-symlinks.js';
import { defineIpcHandler } from './typed-handler.js';
import { isChangedFileStatus, type ChangedFileStatus } from '../../src/domain/git-status.js';
import {
  isReviewDiffMode,
  type ProjectMode,
  type ReviewDiffMode,
  type TaskGitIsolationMode,
} from '../../src/store/types.js';
import type { TaskNameRegistry } from '../../server/task-names.js';
import type { TaskCommandControllerSnapshot } from '../../src/domain/server-state.js';
import type { TaskCleanupResult, TaskCleanupWarning } from '../../src/domain/task-cleanup.js';
import type { MergeResult } from '../../src/ipc/types.js';
import {
  registerArenaTerminalLaunch,
  revokeArenaTerminalLaunches,
} from './arena-terminal-launches.js';
import {
  TaskStructureConflictError,
  type AddPreparedTaskRequest,
} from './task-structure-mutations.js';
import type { TaskMergeGitRequest, TaskMergeGitResult } from './task-merge-workflow.js';
import {
  isTaskMergeOperationAccess,
  isTaskMergeSemanticRequest,
} from '../../src/domain/task-merge.js';

function assertReviewDiffMode(value: unknown): asserts value is ReviewDiffMode {
  if (typeof value !== 'string' || !isReviewDiffMode(value)) {
    throw new BadRequestError('mode must be one of: all, staged, unstaged, branch');
  }
}

function assertOptionalChangedFileStatus(
  value: unknown,
  label: string,
): asserts value is ChangedFileStatus | undefined {
  if (value === undefined) {
    return;
  }

  if (typeof value !== 'string' || !isChangedFileStatus(value)) {
    throw new BadRequestError(`${label} must be a valid changed-file status`);
  }
}

function assertOptionalCommitHash(
  value: unknown,
  label: string,
): asserts value is string | undefined {
  if (value === undefined) {
    return;
  }

  if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/iu.test(value)) {
    throw new BadRequestError(`${label} must be a hex commit hash`);
  }
}

function emitReleasedTaskCommandController(
  context: HandlerContext,
  snapshot: TaskCommandControllerSnapshot | null,
): void {
  if (!snapshot) {
    return;
  }

  context.emitIpcEvent?.(IPC.TaskCommandControllerChanged, snapshot);
}

function assertOptionalTaskGitIsolation(
  value: unknown,
): asserts value is TaskGitIsolationMode | undefined {
  if (value === undefined) {
    return;
  }

  if (value !== 'worktree' && value !== 'current-branch' && value !== 'existing-worktree') {
    throw new BadRequestError(
      'gitIsolation must be one of: worktree, current-branch, existing-worktree',
    );
  }
}

function assertOptionalProjectMode(value: unknown): asserts value is ProjectMode | undefined {
  if (value === undefined || value === 'git' || value === 'non-git') {
    return;
  }

  throw new BadRequestError('projectMode must be one of: git, non-git');
}

function assertArenaBranchName(branchName: string): void {
  if (!branchName.startsWith('arena/')) {
    throw new BadRequestError('branchName must be an arena branch');
  }
}

async function resolveArenaProjectRoot(projectRoot: string): Promise<string> {
  const canonicalProjectRoot = await getGitRepoRoot(projectRoot);
  if (!canonicalProjectRoot) {
    throw new BadRequestError('projectRoot must identify a Git repository');
  }

  return canonicalProjectRoot;
}

function createOutputHandler(
  context: HandlerContext,
  channelId: string | undefined,
): ((text: string) => void) | undefined {
  if (channelId === undefined) {
    return undefined;
  }

  return function handleOutput(text: string): void {
    context.sendToChannel(channelId, text);
  };
}

function assertTaskCommandLeaseHeld(taskId: string, controllerId: string): void {
  if (!isTaskCommandLeaseHeld(taskId, controllerId)) {
    throw new BadRequestError('Task is controlled by another client');
  }
}

function assertExactRequestKeys(value: object, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !(key in value))) {
    throw new BadRequestError('Request contains unsupported fields');
  }
}

async function requireTaskMergeWorkflow(context: HandlerContext) {
  if (!context.getTaskMergeWorkflow) {
    throw new Error('The canonical task merge workflow is unavailable');
  }
  return context.getTaskMergeWorkflow();
}

function executeTaskLeaseProtectedCoordinatorProducer<T>(
  context: HandlerContext,
  request: { controllerId: string; taskId: string },
  operation: () => Promise<T> | T,
): Promise<T> {
  // Fail fast on arrival, then revalidate after the coordinator readiness/admission wait. A
  // lease may expire or move while an early browser request is queued behind runtime startup.
  assertTaskCommandLeaseHeld(request.taskId, request.controllerId);
  return executeCoordinatorProducer(context, () => {
    assertTaskCommandLeaseHeld(request.taskId, request.controllerId);
    return operation();
  });
}

function getTaskCleanupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertRegisteredTaskGitMutationLease(request: {
  controllerId?: string;
  taskId?: string;
  worktreePath: string;
}): void {
  const registeredTaskId = findRegisteredTaskIdForWorktreePath(
    request.worktreePath,
    request.taskId,
  );
  if (!registeredTaskId) {
    if (request.taskId !== undefined || request.controllerId !== undefined) {
      throw new BadRequestError('taskId and controllerId require a registered task worktree');
    }
    return;
  }

  if (request.taskId === undefined) {
    throw new BadRequestError('taskId is required for task git mutations');
  }
  if (request.controllerId === undefined) {
    throw new BadRequestError('controllerId is required for task git mutations');
  }
  if (request.taskId !== registeredTaskId) {
    throw new BadRequestError('taskId must match the registered task worktree');
  }

  assertTaskCommandLeaseHeld(request.taskId, request.controllerId);
}

interface MergeBranchRequest {
  baseBranch?: string;
  branchName: string;
  cleanup?: boolean;
  message?: string | null;
  projectRoot: string;
  squash: boolean;
  worktreePath: string;
}

function mergeBranchAndRefreshGitStatus(request: MergeBranchRequest): Promise<MergeResult> {
  return mergeTask(
    request.projectRoot,
    request.worktreePath,
    request.branchName,
    request.squash,
    request.message ?? null,
    request.cleanup ?? false,
    request.baseBranch,
    hasRegisteredSharedRootTask,
  ).finally(() => {
    scheduleTaskConvergenceRefreshForGitTarget({
      projectRoot: request.projectRoot,
    });
    scheduleTaskReviewRefreshForGitTarget({
      projectRoot: request.projectRoot,
    });
  });
}

/** Trusted D09 low-level adapter. Generic removal owns every cleanup effect. */
export async function executeBackendTaskMergeGit(
  request: TaskMergeGitRequest,
): Promise<TaskMergeGitResult> {
  const result = await mergeBranchAndRefreshGitStatus({
    ...(request.baseBranch !== undefined ? { baseBranch: request.baseBranch } : {}),
    branchName: request.branchName,
    cleanup: false,
    ...(request.message !== undefined ? { message: request.message } : {}),
    projectRoot: request.projectRoot,
    squash: request.squash,
    worktreePath: request.worktreePath,
  });
  return { linesAdded: result.lines_added, linesRemoved: result.lines_removed };
}

function getCreatedTaskWorktreeOwnership(result: {
  git_isolation?: TaskGitIsolationMode;
  project_mode?: ProjectMode;
}): 'external' | 'managed' | null {
  if (result.project_mode === 'non-git') {
    return null;
  }

  return result.git_isolation === 'existing-worktree' ? 'external' : 'managed';
}

async function addPreparedTaskToWorkspace(
  context: HandlerContext,
  request: {
    agentDefId?: string;
    baseBranch?: string;
    githubUrl?: string;
    name: string;
    operationId: string;
    projectId: string;
    projectMode?: ProjectMode;
    projectRoot: string;
    stepsTracking?: boolean;
    gitIsolation?: TaskGitIsolationMode;
  },
  result: {
    base_branch?: string;
    branch_name: string;
    git_isolation?: TaskGitIsolationMode;
    id: string;
    project_mode?: ProjectMode;
    worktree_path: string;
  },
): Promise<void> {
  const host = context.workspaceMutations;
  if (!host) return;

  const projectMode = result.project_mode ?? request.projectMode ?? 'git';
  const gitIsolation =
    projectMode === 'git'
      ? (result.git_isolation ?? request.gitIsolation ?? 'worktree')
      : undefined;
  const prepared: AddPreparedTaskRequest = {
    branchName: result.branch_name,
    name: request.name,
    projectId: request.projectId,
    projectMode,
    projectRoot: request.projectRoot,
    taskId: result.id,
    taskMode: request.agentDefId === undefined ? 'terminal' : 'agent',
    worktreePath: result.worktree_path,
    ...(projectMode === 'git' && gitIsolation !== undefined ? { gitIsolation } : {}),
    ...((result.base_branch ?? request.baseBranch)
      ? { baseBranch: result.base_branch ?? request.baseBranch }
      : {}),
    ...(request.githubUrl !== undefined ? { githubUrl: request.githubUrl } : {}),
    ...(request.stepsTracking !== undefined ? { stepsTracking: request.stepsTracking } : {}),
  };

  try {
    await (
      await host.getTaskStructureService()
    ).addTask({ operation: `create-task:${request.operationId}` }, prepared);
  } catch (error) {
    if (error instanceof TaskStructureConflictError) {
      throw new BadRequestError(error.message);
    }
    throw error;
  }
}

type TaskRemovalHandlerDispatch<TResult> =
  | { cleanupResult: TaskCleanupResult; kind: 'generic-owner' }
  | { effectResult: TResult; kind: 'legacy-fallback' };

async function removeTaskUsingOwnerOrLegacy<TResult>(
  context: HandlerContext,
  taskId: string,
  operation: string,
  legacyEffect: () => Promise<TResult>,
): Promise<TaskRemovalHandlerDispatch<TResult>> {
  const host = context.workspaceMutations;
  if (!host) {
    return { effectResult: await legacyEffect(), kind: 'legacy-fallback' };
  }
  try {
    const [structure, legacyGate] = await Promise.all([
      host.getTaskStructureService(),
      host.getTaskRemovalLegacyWriterGate(),
    ]);
    const dispatch = await structure.removeTaskWithLegacyFallback({ operation }, taskId, () =>
      legacyGate.runLegacyRemoval(legacyEffect),
    );
    if (dispatch.kind === 'legacy-fallback') {
      return { effectResult: dispatch.effectResult, kind: 'legacy-fallback' };
    }
    const removalState = dispatch.removal.result.removalState;
    if (removalState === undefined) {
      throw new Error('Generic task removal returned no durable removal state');
    }
    return {
      cleanupResult: { cleanupWarnings: [], removalState },
      kind: 'generic-owner',
    };
  } catch (error) {
    if (error instanceof TaskStructureConflictError) {
      throw new BadRequestError(error.message);
    }
    throw error;
  }
}

async function runLegacyTaskMerge<TResult>(
  context: HandlerContext,
  effect: () => Promise<TResult>,
): Promise<TResult> {
  const host = context.workspaceMutations;
  if (!host) return effect();
  return (await host.getTaskMergeLegacyWriterGate()).runLegacyMerge(effect);
}

export function createTaskAndGitIpcHandlers(
  context: HandlerContext,
  taskNames: Pick<TaskNameRegistry, 'deleteTask' | 'registerCreatedTask'> &
    Partial<Pick<TaskNameRegistry, 'markTaskClosing'>>,
): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.CreateTask]: defineIpcHandler<IPC.CreateTask>(IPC.CreateTask, async (args) => {
      const request = args;
      assertString(request.name, 'name');
      assertString(request.projectId, 'projectId');
      validatePath(request.projectRoot, 'projectRoot');
      assertStringArray(request.symlinkDirs, 'symlinkDirs');
      assertOptionalString(request.agentDefId, 'agentDefId');
      assertOptionalString(request.agentDefName, 'agentDefName');
      validateOptionalBranchName(request.baseBranch, 'baseBranch');
      assertOptionalBoolean(request.coordinatorMode, 'coordinatorMode');
      assertOptionalString(request.existingWorktreePath, 'existingWorktreePath');
      assertOptionalString(request.githubUrl, 'githubUrl');
      assertOptionalString(request.initialPrompt, 'initialPrompt');
      assertString(request.operationId, 'operationId');
      if (request.operationId.trim().length === 0 || request.operationId.length > 128) {
        throw new BadRequestError(
          'operationId must be a non-empty string no longer than 128 characters',
        );
      }
      assertOptionalProjectMode(request.projectMode);
      validateOptionalBranchName(request.branchPrefix, 'branchPrefix');
      assertOptionalBoolean(request.stepsTracking, 'stepsTracking');
      assertOptionalBoolean(request.skipPermissions, 'skipPermissions');
      assertOptionalTaskGitIsolation(request.gitIsolation);
      if (
        request.agentDefId === undefined &&
        (request.coordinatorMode === true ||
          request.initialPrompt !== undefined ||
          request.skipPermissions !== undefined)
      ) {
        throw new BadRequestError('Agent-only task creation fields require agentDefId');
      }
      if (request.projectMode === 'non-git') {
        if (request.gitIsolation !== undefined) {
          throw new BadRequestError('gitIsolation is not valid for non-git tasks');
        }
        if (request.baseBranch !== undefined) {
          throw new BadRequestError('baseBranch is not valid for non-git tasks');
        }
        if (request.existingWorktreePath !== undefined) {
          throw new BadRequestError('existingWorktreePath is not valid for non-git tasks');
        }
        if (request.branchPrefix !== undefined) {
          throw new BadRequestError('branchPrefix is not valid for non-git tasks');
        }
      }
      if (request.gitIsolation === 'existing-worktree') {
        validatePath(request.existingWorktreePath, 'existingWorktreePath');
      } else if (typeof request.existingWorktreePath === 'string') {
        throw new BadRequestError('existingWorktreePath is only valid for existing-worktree tasks');
      }

      const getManagedCreationCommand = context.getTaskCreationCommand;
      const usesManagedCreationCommand = getManagedCreationCommand !== undefined;
      const result = getManagedCreationCommand
        ? await (
            await getManagedCreationCommand()
          ).create({
            adapterOperationId: request.operationId,
            ...(request.agentDefId !== undefined ? { agentDefId: request.agentDefId } : {}),
            ...(typeof request.baseBranch === 'string' ? { baseBranch: request.baseBranch } : {}),
            ...(request.projectMode !== 'non-git'
              ? { branchPrefix: request.branchPrefix ?? 'task' }
              : {}),
            ...(request.coordinatorMode !== undefined
              ? { coordinatorMode: request.coordinatorMode }
              : {}),
            ...(request.existingWorktreePath !== undefined
              ? { existingWorktreePath: request.existingWorktreePath }
              : {}),
            ...(request.gitIsolation !== undefined ? { gitIsolation: request.gitIsolation } : {}),
            ...(request.githubUrl !== undefined ? { githubUrl: request.githubUrl } : {}),
            ...(request.initialPrompt !== undefined
              ? { initialPrompt: request.initialPrompt }
              : {}),
            name: request.name,
            projectId: request.projectId,
            ...(request.projectMode !== undefined ? { projectMode: request.projectMode } : {}),
            projectRoot: request.projectRoot,
            ...(request.skipPermissions !== undefined
              ? { skipPermissions: request.skipPermissions }
              : {}),
            ...(request.stepsTracking !== undefined
              ? { stepsTracking: request.stepsTracking }
              : {}),
            symlinkDirs: request.symlinkDirs,
          })
        : await createTaskWorkflow(context, {
            ...(request.agentDefId !== undefined ? { agentDefId: request.agentDefId } : {}),
            ...(request.agentDefName !== undefined ? { agentDefName: request.agentDefName } : {}),
            ...(typeof request.baseBranch === 'string' ? { baseBranch: request.baseBranch } : {}),
            name: request.name,
            operationId: request.operationId,
            projectId: request.projectId,
            projectRoot: request.projectRoot,
            ...(request.githubUrl !== undefined ? { githubUrl: request.githubUrl } : {}),
            ...(request.projectMode !== undefined ? { projectMode: request.projectMode } : {}),
            symlinkDirs: request.symlinkDirs,
            ...(request.projectMode !== 'non-git'
              ? { branchPrefix: request.branchPrefix ?? 'task' }
              : {}),
            ...(request.existingWorktreePath !== undefined
              ? { existingWorktreePath: request.existingWorktreePath }
              : {}),
            ...(request.stepsTracking !== undefined
              ? { stepsTracking: request.stepsTracking }
              : {}),
            ...(request.gitIsolation !== undefined ? { gitIsolation: request.gitIsolation } : {}),
          });
      const gitIsolation = 'git_isolation' in result ? result.git_isolation : undefined;
      const projectMode = 'project_mode' in result ? result.project_mode : undefined;

      if (
        usesManagedCreationCommand &&
        (typeof result.task_name !== 'string' ||
          (request.agentDefId !== undefined &&
            (typeof result.agent_def_id !== 'string' || typeof result.agent_def_name !== 'string')))
      ) {
        throw new Error('Managed task creation returned incomplete canonical registry metadata');
      }

      if (!usesManagedCreationCommand) {
        await addPreparedTaskToWorkspace(context, request, result);
      }

      taskNames.registerCreatedTask(result.id, {
        agentDefId: usesManagedCreationCommand
          ? (result.agent_def_id ?? null)
          : (request.agentDefId ?? null),
        agentDefName: usesManagedCreationCommand
          ? (result.agent_def_name ?? null)
          : (request.agentDefName ?? null),
        branchName: result.branch_name,
        directMode: gitIsolation === 'current-branch',
        ...(gitIsolation !== undefined ? { gitIsolation } : {}),
        ...(projectMode !== undefined ? { projectMode } : {}),
        taskName: usesManagedCreationCommand ? (result.task_name ?? null) : request.name,
        worktreePath: result.worktree_path,
        worktreeOwnership: getCreatedTaskWorktreeOwnership(result),
      });
      return result;
    }),

    [IPC.DeleteTask]: defineIpcHandler<IPC.DeleteTask>(IPC.DeleteTask, async (args) => {
      const request = args;
      assertStringArray(request.agentIds, 'agentIds');
      validatePath(request.projectRoot, 'projectRoot');
      validatePath(request.worktreePath, 'worktreePath');
      validateBranchName(request.branchName, 'branchName');
      assertBoolean(request.deleteBranch, 'deleteBranch');
      assertString(request.controllerId, 'controllerId');
      assertString(request.taskId, 'taskId');

      return executeTaskLeaseProtectedCoordinatorProducer(context, request, async () => {
        taskNames.markTaskClosing?.(request.taskId);
        const removal = await removeTaskUsingOwnerOrLegacy(
          context,
          request.taskId,
          `delete-task:${request.taskId}`,
          async () => {
            const cleanupResult = await deleteTaskWorkflow({
              agentIds: request.agentIds,
              branchName: request.branchName,
              deleteBranch: request.deleteBranch,
              projectRoot: request.projectRoot,
              taskId: request.taskId,
              worktreePath: request.worktreePath,
            });
            emitReleasedTaskCommandController(context, cleanupResult.releasedTaskCommandController);
            const coordinatorCleanupWarnings = await cleanupCoordinatorTaskStateAndOwnedSubtasks(
              { context, taskNames },
              request.taskId,
            );
            return {
              cleanupWarnings: [...cleanupResult.cleanupWarnings, ...coordinatorCleanupWarnings],
            };
          },
        );
        if (removal.kind === 'generic-owner') return removal.cleanupResult;
        taskNames.deleteTask(request.taskId);
        return removal.effectResult;
      });
    }),

    [IPC.SetTaskCollapsed]: defineIpcHandler<IPC.SetTaskCollapsed>(
      IPC.SetTaskCollapsed,
      async (request) => {
        assertString(request.taskId, 'taskId');
        assertString(request.controllerId, 'controllerId');
        assertBoolean(request.collapsed, 'collapsed');
        const getTaskCollapseWorkflow = context.getTaskCollapseWorkflow;
        if (!getTaskCollapseWorkflow) throw new Error('Canonical task lifecycle is unavailable');
        return executeTaskLeaseProtectedCoordinatorProducer(context, request, async () => {
          const owner = await getTaskCollapseWorkflow();
          await owner.setCollapsed(request, () =>
            assertTaskCommandLeaseHeld(request.taskId, request.controllerId),
          );
          return undefined;
        });
      },
    ),

    [IPC.CleanupTaskRuntime]: defineIpcHandler<IPC.CleanupTaskRuntime>(
      IPC.CleanupTaskRuntime,
      async (args) => {
        const request = args;
        assertStringArray(request.agentIds, 'agentIds');
        assertString(request.controllerId, 'controllerId');
        assertOptionalProjectMode(request.projectMode);
        assertOptionalString(request.projectRoot, 'projectRoot');
        assertOptionalBoolean(request.removeTaskState, 'removeTaskState');
        assertString(request.taskId, 'taskId');
        assertOptionalString(request.worktreePath, 'worktreePath');
        if (typeof request.worktreePath === 'string') {
          validatePath(request.worktreePath, 'worktreePath');
        }
        if (typeof request.projectRoot === 'string') {
          validatePath(request.projectRoot, 'projectRoot');
        }
        const cleanupLegacyRuntime = async (removeTaskState: boolean) => {
          const cleanupWarnings: TaskCleanupWarning[] = [];
          if (removeTaskState) {
            try {
              await stopTaskAgentWorkflowsForTask(request.taskId, request.agentIds);
            } catch (error) {
              cleanupWarnings.push({
                kind: 'runners',
                message: `Failed to clean agent runners while removing task runtime: ${getTaskCleanupErrorMessage(error)}`,
              });
            }

            if (
              typeof request.projectRoot === 'string' &&
              typeof request.worktreePath === 'string'
            ) {
              try {
                await destroyManagedTaskContainersByLabels({
                  projectPath: request.projectRoot,
                  taskId: request.taskId,
                  worktreePath: request.worktreePath,
                });
              } catch (error) {
                cleanupWarnings.push({
                  kind: 'containers',
                  message: `Failed to clean task containers while removing task runtime: ${getTaskCleanupErrorMessage(error)}`,
                });
              }
            }
          }

          const cleanupResult = cleanupTaskRuntimeWorkflow({
            agentIds: request.agentIds,
            ...(request.projectMode !== undefined ? { projectMode: request.projectMode } : {}),
            removeTaskState,
            taskId: request.taskId,
            ...(typeof request.worktreePath === 'string'
              ? { worktreePath: request.worktreePath }
              : {}),
          });
          emitReleasedTaskCommandController(context, cleanupResult.releasedTaskCommandController);

          if (removeTaskState) {
            cleanupWarnings.push(
              ...(await cleanupCoordinatorTaskStateAndOwnedSubtasks(
                { context, taskNames },
                request.taskId,
              )),
            );
          }

          return { cleanupWarnings };
        };

        if (request.removeTaskState === true) {
          return executeTaskLeaseProtectedCoordinatorProducer(context, request, async () => {
            taskNames.markTaskClosing?.(request.taskId);
            const removal = await removeTaskUsingOwnerOrLegacy(
              context,
              request.taskId,
              `cleanup-task-runtime:${request.taskId}`,
              () => cleanupLegacyRuntime(true),
            );
            if (removal.kind === 'generic-owner') return removal.cleanupResult;
            taskNames.deleteTask(request.taskId);
            return removal.effectResult;
          });
        }

        assertTaskCommandLeaseHeld(request.taskId, request.controllerId);
        return cleanupLegacyRuntime(false);
      },
    ),

    [IPC.GetChangedFiles]: defineIpcHandler<IPC.GetChangedFiles>(IPC.GetChangedFiles, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      validateOptionalBranchName(request.baseBranch, 'baseBranch');
      return getChangedFiles(request.worktreePath, request.baseBranch);
    }),

    [IPC.GetChangedFilesFromBranch]: defineIpcHandler<IPC.GetChangedFilesFromBranch>(
      IPC.GetChangedFilesFromBranch,
      (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        validateBranchName(request.branchName, 'branchName');
        validateOptionalBranchName(request.baseBranch, 'baseBranch');
        return getChangedFilesFromBranch(
          request.projectRoot,
          request.branchName,
          request.baseBranch,
        );
      },
    ),

    [IPC.GetFileDiff]: defineIpcHandler<IPC.GetFileDiff>(IPC.GetFileDiff, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      validateRelativePath(request.filePath, 'filePath');
      validateOptionalBranchName(request.baseBranch, 'baseBranch');
      assertOptionalChangedFileStatus(request.status, 'status');
      return getFileDiff(
        request.worktreePath,
        request.filePath,
        request.status === undefined ? {} : { status: request.status },
      );
    }),

    [IPC.GetFileDiffFromBranch]: defineIpcHandler<IPC.GetFileDiffFromBranch>(
      IPC.GetFileDiffFromBranch,
      (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        validateBranchName(request.branchName, 'branchName');
        validateRelativePath(request.filePath, 'filePath');
        validateOptionalBranchName(request.baseBranch, 'baseBranch');
        assertOptionalChangedFileStatus(request.status, 'status');
        assertOptionalCommitHash(request.commitHash, 'commitHash');
        const diffOptions = {
          ...(request.commitHash !== undefined ? { commitHash: request.commitHash } : {}),
          ...(request.status !== undefined ? { status: request.status } : {}),
        };
        return getFileDiffFromBranch(
          request.projectRoot,
          request.branchName,
          request.filePath,
          diffOptions,
          request.baseBranch,
        );
      },
    ),

    [IPC.GetAllFileDiffs]: defineIpcHandler<IPC.GetAllFileDiffs>(IPC.GetAllFileDiffs, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      validateOptionalBranchName(request.baseBranch, 'baseBranch');
      return getAllFileDiffs(request.worktreePath, request.baseBranch);
    }),

    [IPC.GetAllFileDiffsFromBranch]: defineIpcHandler<IPC.GetAllFileDiffsFromBranch>(
      IPC.GetAllFileDiffsFromBranch,
      (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        validateBranchName(request.branchName, 'branchName');
        validateOptionalBranchName(request.baseBranch, 'baseBranch');
        return getAllFileDiffsFromBranch(
          request.projectRoot,
          request.branchName,
          request.baseBranch,
        );
      },
    ),

    [IPC.GetGitRepoRoot]: defineIpcHandler<IPC.GetGitRepoRoot>(IPC.GetGitRepoRoot, (args) => {
      const request = args;
      validatePath(request.path, 'path');
      return getGitRepoRoot(request.path);
    }),

    [IPC.GetGitignoredDirs]: defineIpcHandler<IPC.GetGitignoredDirs>(
      IPC.GetGitignoredDirs,
      (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        return getWorktreeSymlinkCandidates(request.projectRoot);
      },
    ),

    [IPC.ListBranches]: defineIpcHandler<IPC.ListBranches>(IPC.ListBranches, (args) => {
      const request = args;
      validatePath(request.projectRoot, 'projectRoot');
      return listBranches(request.projectRoot);
    }),

    [IPC.ListImportableWorktrees]: defineIpcHandler<IPC.ListImportableWorktrees>(
      IPC.ListImportableWorktrees,
      (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        validateOptionalBranchName(request.baseBranch, 'baseBranch');
        if (request.registeredWorktreePaths !== undefined) {
          assertStringArray(request.registeredWorktreePaths, 'registeredWorktreePaths');
          for (const worktreePath of request.registeredWorktreePaths) {
            validatePath(worktreePath, 'registeredWorktreePaths[]');
          }
        }
        return listImportableWorktrees(request.projectRoot, {
          ...(request.baseBranch !== undefined ? { baseBranch: request.baseBranch } : {}),
          ...(request.registeredWorktreePaths !== undefined
            ? { registeredWorktreePaths: request.registeredWorktreePaths }
            : {}),
        });
      },
    ),

    [IPC.GetWorktreeStatus]: defineIpcHandler<IPC.GetWorktreeStatus>(
      IPC.GetWorktreeStatus,
      (args) => {
        const request = args;
        validatePath(request.worktreePath, 'worktreePath');
        validateOptionalBranchName(request.baseBranch, 'baseBranch');
        return getWorktreeStatus(request.worktreePath, request.baseBranch);
      },
    ),

    [IPC.CommitAll]: defineIpcHandler<IPC.CommitAll>(IPC.CommitAll, async (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      assertString(request.message, 'message');
      assertOptionalString(request.controllerId, 'controllerId');
      assertOptionalString(request.taskId, 'taskId');
      assertRegisteredTaskGitMutationLease(request);
      await commitAllWorkflow(context, {
        worktreePath: request.worktreePath,
        message: request.message,
      });

      return undefined;
    }),

    [IPC.DiscardUncommitted]: defineIpcHandler<IPC.DiscardUncommitted>(
      IPC.DiscardUncommitted,
      async (args) => {
        const request = args;
        validatePath(request.worktreePath, 'worktreePath');
        assertOptionalString(request.controllerId, 'controllerId');
        assertOptionalString(request.taskId, 'taskId');
        assertRegisteredTaskGitMutationLease(request);
        await discardUncommittedWorkflow(context, {
          worktreePath: request.worktreePath,
        });

        return undefined;
      },
    ),

    [IPC.GetProjectDiff]: defineIpcHandler<IPC.GetProjectDiff>(IPC.GetProjectDiff, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      assertReviewDiffMode(request.mode);
      validateOptionalBranchName(request.baseBranch, 'baseBranch');

      return getProjectDiff(request.worktreePath, request.mode, request.baseBranch);
    }),

    [IPC.CheckMergeStatus]: defineIpcHandler<IPC.CheckMergeStatus>(IPC.CheckMergeStatus, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      validateOptionalBranchName(request.baseBranch, 'baseBranch');
      return checkMergeStatus(request.worktreePath, request.baseBranch);
    }),

    [IPC.IssueTaskMergeOperation]: defineIpcHandler<IPC.IssueTaskMergeOperation>(
      IPC.IssueTaskMergeOperation,
      async (args) => {
        const request = args;
        assertExactRequestKeys(request, ['controllerId', 'taskId']);
        assertString(request.controllerId, 'controllerId');
        assertString(request.taskId, 'taskId');
        assertTaskCommandLeaseHeld(request.taskId, request.controllerId);
        const workflow = await requireTaskMergeWorkflow(context);
        // Activation can wait for durable owner cutovers. Revalidate at the
        // operation-admission boundary after that wait.
        assertTaskCommandLeaseHeld(request.taskId, request.controllerId);
        return workflow.issue({ principalId: request.controllerId, taskId: request.taskId });
      },
    ),

    [IPC.StartTaskMergeOperation]: defineIpcHandler<IPC.StartTaskMergeOperation>(
      IPC.StartTaskMergeOperation,
      async (args) => {
        const request = args;
        assertExactRequestKeys(request, ['access', 'controllerId', 'semanticRequest']);
        assertString(request.controllerId, 'controllerId');
        if (!isTaskMergeOperationAccess(request.access)) {
          throw new BadRequestError('access must identify an issued task merge operation');
        }
        if (!isTaskMergeSemanticRequest(request.semanticRequest)) {
          throw new BadRequestError('semanticRequest must be a valid task merge request');
        }
        assertTaskCommandLeaseHeld(request.semanticRequest.taskId, request.controllerId);
        const workflow = await requireTaskMergeWorkflow(context);
        assertTaskCommandLeaseHeld(request.semanticRequest.taskId, request.controllerId);
        return workflow.start({
          access: request.access,
          principalId: request.controllerId,
          semanticRequest: request.semanticRequest,
        });
      },
    ),

    [IPC.GetTaskMergeOperationStatus]: defineIpcHandler<IPC.GetTaskMergeOperationStatus>(
      IPC.GetTaskMergeOperationStatus,
      async (args) => {
        const request = args;
        assertExactRequestKeys(request, ['access', 'controllerId']);
        assertString(request.controllerId, 'controllerId');
        if (!isTaskMergeOperationAccess(request.access)) {
          throw new BadRequestError('access must identify an issued task merge operation');
        }
        return (await requireTaskMergeWorkflow(context)).status({
          access: request.access,
          principalId: request.controllerId,
        });
      },
    ),

    [IPC.MergeTask]: defineIpcHandler<IPC.MergeTask>(IPC.MergeTask, (args) => {
      const request = args;
      validatePath(request.projectRoot, 'projectRoot');
      validatePath(request.worktreePath, 'worktreePath');
      validateBranchName(request.branchName, 'branchName');
      assertBoolean(request.squash, 'squash');
      assertString(request.controllerId, 'controllerId');
      assertOptionalString(request.message, 'message');
      assertOptionalBoolean(request.cleanup, 'cleanup');
      validateOptionalBranchName(request.baseBranch, 'baseBranch');
      assertString(request.taskId, 'taskId');
      assertTaskCommandLeaseHeld(request.taskId, request.controllerId);
      return runLegacyTaskMerge(context, () => mergeBranchAndRefreshGitStatus(request));
    }),

    [IPC.MergeArenaWorktree]: defineIpcHandler<IPC.MergeArenaWorktree>(
      IPC.MergeArenaWorktree,
      (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        validatePath(request.worktreePath, 'worktreePath');
        validateBranchName(request.branchName, 'branchName');
        assertArenaBranchName(request.branchName);
        assertBoolean(request.squash, 'squash');
        assertOptionalString(request.message, 'message');
        assertOptionalBoolean(request.cleanup, 'cleanup');
        validateOptionalBranchName(request.baseBranch, 'baseBranch');
        assertOptionalString(request.controllerId, 'controllerId');
        assertOptionalString(request.taskId, 'taskId');
        assertRegisteredTaskGitMutationLease(request);
        return mergeBranchAndRefreshGitStatus(request);
      },
    ),

    [IPC.GetBranchLog]: defineIpcHandler<IPC.GetBranchLog>(IPC.GetBranchLog, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      validateOptionalBranchName(request.baseBranch, 'baseBranch');
      return getBranchLog(request.worktreePath, request.baseBranch);
    }),

    [IPC.GetBranchCommitHistory]: defineIpcHandler<IPC.GetBranchCommitHistory>(
      IPC.GetBranchCommitHistory,
      (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        validateBranchName(request.branchName, 'branchName');
        validateOptionalBranchName(request.baseBranch, 'baseBranch');
        return getBranchCommitHistory({
          ...(request.baseBranch !== undefined ? { baseBranch: request.baseBranch } : {}),
          branchName: request.branchName,
          projectRoot: request.projectRoot,
        });
      },
    ),

    [IPC.PushTask]: defineIpcHandler<IPC.PushTask>(IPC.PushTask, async (args) => {
      const request = args;
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      assertString(request.controllerId, 'controllerId');
      assertString(request.taskId, 'taskId');
      assertTaskCommandLeaseHeld(request.taskId, request.controllerId);
      const channelId = getOptionalChannelId(request.onOutput);
      const projectRoot = request.projectRoot;
      const branchName = request.branchName;
      const onOutput = createOutputHandler(context, channelId);
      await streamPushTask(projectRoot, branchName, onOutput).finally(() => {
        scheduleTaskConvergenceRefreshForGitTarget({
          branchName,
          projectRoot,
        });
        scheduleTaskReviewRefreshForGitTarget({
          branchName,
          projectRoot,
        });
        scheduleTaskReviewSignalsRefresh(request.taskId);
      });

      return undefined;
    }),

    [IPC.RebaseTask]: defineIpcHandler<IPC.RebaseTask>(IPC.RebaseTask, async (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      validateOptionalBranchName(request.baseBranch, 'baseBranch');
      assertString(request.controllerId, 'controllerId');
      assertString(request.taskId, 'taskId');
      assertTaskCommandLeaseHeld(request.taskId, request.controllerId);
      await rebaseTaskWorkflow(context, {
        ...(request.baseBranch !== undefined ? { baseBranch: request.baseBranch } : {}),
        worktreePath: request.worktreePath,
      });

      return undefined;
    }),

    [IPC.GetMainBranch]: defineIpcHandler<IPC.GetMainBranch>(IPC.GetMainBranch, (args) => {
      const request = args;
      validatePath(request.projectRoot, 'projectRoot');
      validateOptionalBranchName(request.baseBranch, 'baseBranch');
      return getMainBranch(request.projectRoot, request.baseBranch);
    }),

    [IPC.GetCurrentBranch]: defineIpcHandler<IPC.GetCurrentBranch>(IPC.GetCurrentBranch, (args) => {
      const request = args;
      validatePath(request.projectRoot, 'projectRoot');
      return getCurrentBranch(request.projectRoot);
    }),

    [IPC.CreateArenaWorktree]: defineIpcHandler<IPC.CreateArenaWorktree>(
      IPC.CreateArenaWorktree,
      async (args) => {
        const request = args;
        assertString(request.agentId, 'agentId');
        assertString(request.taskId, 'taskId');
        validatePath(request.projectRoot, 'projectRoot');
        validateBranchName(request.branchName, 'branchName');
        assertArenaBranchName(request.branchName);
        if (request.symlinkDirs !== undefined) {
          assertStringArray(request.symlinkDirs, 'symlinkDirs');
        }
        const canonicalProjectRoot = await resolveArenaProjectRoot(request.projectRoot);
        const result = await createWorktree(
          canonicalProjectRoot,
          request.branchName,
          encodeTaskWorktreeLinkRequestV1(request.symlinkDirs ?? []),
          true,
        );
        return {
          ...result,
          launchToken: registerArenaTerminalLaunch({
            agentId: request.agentId,
            branchName: request.branchName,
            projectRoot: canonicalProjectRoot,
            root: result.path,
            taskId: request.taskId,
          }),
        };
      },
    ),

    [IPC.RemoveArenaWorktree]: defineIpcHandler<IPC.RemoveArenaWorktree>(
      IPC.RemoveArenaWorktree,
      async (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        validateBranchName(request.branchName, 'branchName');
        assertArenaBranchName(request.branchName);
        const canonicalProjectRoot = await resolveArenaProjectRoot(request.projectRoot);
        revokeArenaTerminalLaunches(canonicalProjectRoot, request.branchName);
        await removeWorktree(canonicalProjectRoot, request.branchName, true);
        return undefined;
      },
    ),
  };
}
