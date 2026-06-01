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
  getGitIgnoredDirs,
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
} from './task-workflows.js';
import { cleanupCoordinatorTaskStateAndOwnedSubtasks } from '../coordinator/tool-gateway.js';
import { scheduleTaskReviewSignalsRefresh } from './task-review-signals.js';
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
import type { MergeResult } from '../../src/ipc/types.js';

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

function assertRegisteredTaskGitMutationLease(request: {
  controllerId?: string;
  taskId?: string;
  worktreePath: string;
}): void {
  const registeredTaskId = findRegisteredTaskIdForWorktreePath(request.worktreePath);
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
  ).finally(() => {
    scheduleTaskConvergenceRefreshForGitTarget({
      projectRoot: request.projectRoot,
    });
    scheduleTaskReviewRefreshForGitTarget({
      projectRoot: request.projectRoot,
    });
  });
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

export function createTaskAndGitIpcHandlers(
  context: HandlerContext,
  taskNames: Pick<TaskNameRegistry, 'deleteTask' | 'registerCreatedTask'>,
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
      assertOptionalString(request.existingWorktreePath, 'existingWorktreePath');
      assertOptionalString(request.githubUrl, 'githubUrl');
      assertOptionalProjectMode(request.projectMode);
      validateOptionalBranchName(request.branchPrefix, 'branchPrefix');
      assertOptionalBoolean(request.stepsTracking, 'stepsTracking');
      assertOptionalTaskGitIsolation(request.gitIsolation);
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

      const result = await createTaskWorkflow(context, {
        ...(typeof request.baseBranch === 'string' ? { baseBranch: request.baseBranch } : {}),
        name: request.name,
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
        ...(request.stepsTracking !== undefined ? { stepsTracking: request.stepsTracking } : {}),
        ...(request.gitIsolation !== undefined ? { gitIsolation: request.gitIsolation } : {}),
      });
      const gitIsolation = 'git_isolation' in result ? result.git_isolation : undefined;
      const projectMode = 'project_mode' in result ? result.project_mode : undefined;

      taskNames.registerCreatedTask(result.id, {
        agentDefId: request.agentDefId ?? null,
        agentDefName: request.agentDefName ?? null,
        branchName: result.branch_name,
        directMode: gitIsolation === 'current-branch',
        ...(gitIsolation !== undefined ? { gitIsolation } : {}),
        ...(projectMode !== undefined ? { projectMode } : {}),
        taskName: request.name,
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
      assertTaskCommandLeaseHeld(request.taskId, request.controllerId);

      const cleanupResult = await deleteTaskWorkflow({
        agentIds: request.agentIds,
        branchName: request.branchName,
        deleteBranch: request.deleteBranch,
        projectRoot: request.projectRoot,
        taskId: request.taskId,
        worktreePath: request.worktreePath,
      });
      emitReleasedTaskCommandController(context, cleanupResult.releasedTaskCommandController);

      taskNames.deleteTask(request.taskId);
      const coordinatorCleanupWarnings = await cleanupCoordinatorTaskStateAndOwnedSubtasks(
        { context, taskNames },
        request.taskId,
      );

      return {
        cleanupWarnings: [...cleanupResult.cleanupWarnings, ...coordinatorCleanupWarnings],
      };
    }),

    [IPC.CleanupTaskRuntime]: defineIpcHandler<IPC.CleanupTaskRuntime>(
      IPC.CleanupTaskRuntime,
      async (args) => {
        const request = args;
        assertStringArray(request.agentIds, 'agentIds');
        assertString(request.controllerId, 'controllerId');
        assertOptionalProjectMode(request.projectMode);
        assertOptionalBoolean(request.removeTaskState, 'removeTaskState');
        assertString(request.taskId, 'taskId');
        assertOptionalString(request.worktreePath, 'worktreePath');
        if (typeof request.worktreePath === 'string') {
          validatePath(request.worktreePath, 'worktreePath');
        }
        assertTaskCommandLeaseHeld(request.taskId, request.controllerId);

        const cleanupResult = cleanupTaskRuntimeWorkflow({
          agentIds: request.agentIds,
          ...(request.projectMode !== undefined ? { projectMode: request.projectMode } : {}),
          removeTaskState: request.removeTaskState ?? false,
          taskId: request.taskId,
          ...(typeof request.worktreePath === 'string'
            ? { worktreePath: request.worktreePath }
            : {}),
        });
        emitReleasedTaskCommandController(context, cleanupResult.releasedTaskCommandController);

        if (request.removeTaskState === true) {
          taskNames.deleteTask(request.taskId);
          await cleanupCoordinatorTaskStateAndOwnedSubtasks({ context, taskNames }, request.taskId);
        }

        return undefined;
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
        return getGitIgnoredDirs(request.projectRoot);
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
      return mergeBranchAndRefreshGitStatus(request);
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
      (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        validateBranchName(request.branchName, 'branchName');
        if (request.symlinkDirs !== undefined) {
          assertStringArray(request.symlinkDirs, 'symlinkDirs');
        }
        return createWorktree(
          request.projectRoot,
          request.branchName,
          request.symlinkDirs ?? [],
          true,
        );
      },
    ),

    [IPC.RemoveArenaWorktree]: defineIpcHandler<IPC.RemoveArenaWorktree>(
      IPC.RemoveArenaWorktree,
      async (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        validateBranchName(request.branchName, 'branchName');
        await removeWorktree(request.projectRoot, request.branchName, true);
        return undefined;
      },
    ),
  };
}
