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
  getCurrentBranch,
  getFileDiff,
  getFileDiffFromBranch,
  getGitIgnoredDirs,
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
import { createTaskWorkflow, deleteTaskWorkflow } from './task-workflows.js';
import {
  assertBoolean,
  assertOptionalBoolean,
  assertOptionalString,
  assertString,
  assertStringArray,
} from './validate.js';
import { BadRequestError } from './errors.js';
import { validateBranchName, validatePath, validateRelativePath } from './path-utils.js';
import { getOptionalChannelId } from './channel-id.js';
import { defineIpcHandler } from './typed-handler.js';
import type { ReviewDiffMode } from '../../src/store/types.js';

function assertReviewDiffMode(value: unknown): asserts value is ReviewDiffMode {
  if (value !== 'all' && value !== 'staged' && value !== 'unstaged' && value !== 'branch') {
    throw new BadRequestError('mode must be one of: all, staged, unstaged, branch');
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

export function createTaskAndGitIpcHandlers(
  context: HandlerContext,
  taskNames: Map<string, string>,
): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.CreateTask]: defineIpcHandler<IPC.CreateTask>(IPC.CreateTask, async (args) => {
      const request = args;
      assertString(request.name, 'name');
      assertString(request.projectId, 'projectId');
      validatePath(request.projectRoot, 'projectRoot');
      assertStringArray(request.symlinkDirs, 'symlinkDirs');
      assertOptionalString(request.branchPrefix, 'branchPrefix');

      const result = await createTaskWorkflow(context, {
        name: request.name,
        projectId: request.projectId,
        projectRoot: request.projectRoot,
        symlinkDirs: request.symlinkDirs,
        branchPrefix: request.branchPrefix ?? 'task',
      });

      taskNames.set(result.id, request.name);
      return result;
    }),

    [IPC.DeleteTask]: defineIpcHandler<IPC.DeleteTask>(IPC.DeleteTask, async (args) => {
      const request = args;
      assertStringArray(request.agentIds, 'agentIds');
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      assertBoolean(request.deleteBranch, 'deleteBranch');
      assertOptionalString(request.taskId, 'taskId');
      assertOptionalString(request.worktreePath, 'worktreePath');

      await deleteTaskWorkflow({
        agentIds: request.agentIds,
        branchName: request.branchName,
        deleteBranch: request.deleteBranch,
        projectRoot: request.projectRoot,
        ...(typeof request.taskId === 'string' ? { taskId: request.taskId } : {}),
        ...(typeof request.worktreePath === 'string' ? { worktreePath: request.worktreePath } : {}),
      });

      if (typeof request.taskId === 'string') {
        taskNames.delete(request.taskId);
      }

      return undefined;
    }),

    [IPC.GetChangedFiles]: defineIpcHandler<IPC.GetChangedFiles>(IPC.GetChangedFiles, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      return getChangedFiles(request.worktreePath);
    }),

    [IPC.GetChangedFilesFromBranch]: defineIpcHandler<IPC.GetChangedFilesFromBranch>(
      IPC.GetChangedFilesFromBranch,
      (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        validateBranchName(request.branchName, 'branchName');
        return getChangedFilesFromBranch(request.projectRoot, request.branchName);
      },
    ),

    [IPC.GetFileDiff]: defineIpcHandler<IPC.GetFileDiff>(IPC.GetFileDiff, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      validateRelativePath(request.filePath, 'filePath');
      return getFileDiff(request.worktreePath, request.filePath);
    }),

    [IPC.GetFileDiffFromBranch]: defineIpcHandler<IPC.GetFileDiffFromBranch>(
      IPC.GetFileDiffFromBranch,
      (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        validateBranchName(request.branchName, 'branchName');
        validateRelativePath(request.filePath, 'filePath');
        return getFileDiffFromBranch(request.projectRoot, request.branchName, request.filePath);
      },
    ),

    [IPC.GetAllFileDiffs]: defineIpcHandler<IPC.GetAllFileDiffs>(IPC.GetAllFileDiffs, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      return getAllFileDiffs(request.worktreePath);
    }),

    [IPC.GetAllFileDiffsFromBranch]: defineIpcHandler<IPC.GetAllFileDiffsFromBranch>(
      IPC.GetAllFileDiffsFromBranch,
      (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        validateBranchName(request.branchName, 'branchName');
        return getAllFileDiffsFromBranch(request.projectRoot, request.branchName);
      },
    ),

    [IPC.GetGitignoredDirs]: defineIpcHandler<IPC.GetGitignoredDirs>(
      IPC.GetGitignoredDirs,
      (args) => {
        const request = args;
        validatePath(request.projectRoot, 'projectRoot');
        return getGitIgnoredDirs(request.projectRoot);
      },
    ),

    [IPC.GetWorktreeStatus]: defineIpcHandler<IPC.GetWorktreeStatus>(
      IPC.GetWorktreeStatus,
      (args) => {
        const request = args;
        validatePath(request.worktreePath, 'worktreePath');
        return getWorktreeStatus(request.worktreePath);
      },
    ),

    [IPC.CommitAll]: defineIpcHandler<IPC.CommitAll>(IPC.CommitAll, async (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      assertString(request.message, 'message');
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

      return getProjectDiff(request.worktreePath, request.mode);
    }),

    [IPC.CheckMergeStatus]: defineIpcHandler<IPC.CheckMergeStatus>(IPC.CheckMergeStatus, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      return checkMergeStatus(request.worktreePath);
    }),

    [IPC.MergeTask]: defineIpcHandler<IPC.MergeTask>(IPC.MergeTask, (args) => {
      const request = args;
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      assertBoolean(request.squash, 'squash');
      assertOptionalString(request.message, 'message');
      assertOptionalBoolean(request.cleanup, 'cleanup');
      const projectRoot = request.projectRoot;
      const branchName = request.branchName;
      const squash = request.squash;
      const message = request.message ?? null;
      const cleanup = request.cleanup ?? false;
      return mergeTask(projectRoot, branchName, squash, message, cleanup).finally(() => {
        scheduleTaskConvergenceRefreshForGitTarget({
          projectRoot,
        });
        scheduleTaskReviewRefreshForGitTarget({
          projectRoot,
        });
      });
    }),

    [IPC.GetBranchLog]: defineIpcHandler<IPC.GetBranchLog>(IPC.GetBranchLog, (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      return getBranchLog(request.worktreePath);
    }),

    [IPC.PushTask]: defineIpcHandler<IPC.PushTask>(IPC.PushTask, async (args) => {
      const request = args;
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
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
      });

      return undefined;
    }),

    [IPC.RebaseTask]: defineIpcHandler<IPC.RebaseTask>(IPC.RebaseTask, async (args) => {
      const request = args;
      validatePath(request.worktreePath, 'worktreePath');
      await rebaseTaskWorkflow(context, {
        worktreePath: request.worktreePath,
      });

      return undefined;
    }),

    [IPC.GetMainBranch]: defineIpcHandler<IPC.GetMainBranch>(IPC.GetMainBranch, (args) => {
      const request = args;
      validatePath(request.projectRoot, 'projectRoot');
      assertOptionalString(request.baseBranch, 'baseBranch');
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
