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

function getOptionalChannelId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const channel = value as { __CHANNEL_ID__?: unknown } | null;
  if (typeof channel?.__CHANNEL_ID__ !== 'string') {
    throw new BadRequestError('onOutput.__CHANNEL_ID__ must be a string');
  }

  return channel.__CHANNEL_ID__;
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
    [IPC.CreateTask]: async (args) => {
      const request = args ?? {};
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
    },

    [IPC.DeleteTask]: async (args) => {
      const request = args ?? {};
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
    },

    [IPC.GetChangedFiles]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return getChangedFiles(request.worktreePath);
    },

    [IPC.GetChangedFilesFromBranch]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      return getChangedFilesFromBranch(request.projectRoot, request.branchName);
    },

    [IPC.GetFileDiff]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      validateRelativePath(request.filePath, 'filePath');
      return getFileDiff(request.worktreePath, request.filePath);
    },

    [IPC.GetFileDiffFromBranch]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      validateRelativePath(request.filePath, 'filePath');
      return getFileDiffFromBranch(request.projectRoot, request.branchName, request.filePath);
    },

    [IPC.GetAllFileDiffs]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return getAllFileDiffs(request.worktreePath);
    },

    [IPC.GetAllFileDiffsFromBranch]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      return getAllFileDiffsFromBranch(request.projectRoot, request.branchName);
    },

    [IPC.GetGitignoredDirs]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      return getGitIgnoredDirs(request.projectRoot);
    },

    [IPC.GetWorktreeStatus]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return getWorktreeStatus(request.worktreePath);
    },

    [IPC.CommitAll]: async (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      assertString(request.message, 'message');
      return commitAllWorkflow(context, {
        worktreePath: request.worktreePath,
        message: request.message,
      });
    },

    [IPC.DiscardUncommitted]: async (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return discardUncommittedWorkflow(context, {
        worktreePath: request.worktreePath,
      });
    },

    [IPC.GetProjectDiff]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      assertString(request.mode, 'mode');
      if (!['all', 'staged', 'unstaged', 'branch'].includes(request.mode)) {
        throw new BadRequestError('mode must be one of: all, staged, unstaged, branch');
      }

      return getProjectDiff(
        request.worktreePath,
        request.mode as 'all' | 'staged' | 'unstaged' | 'branch',
      );
    },

    [IPC.CheckMergeStatus]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return checkMergeStatus(request.worktreePath);
    },

    [IPC.MergeTask]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      assertBoolean(request.squash, 'squash');
      assertOptionalString(request.message, 'message');
      assertOptionalBoolean(request.cleanup, 'cleanup');
      const projectRoot = request.projectRoot as string;
      const branchName = request.branchName as string;
      const squash = request.squash as boolean;
      const message = (request.message as string | null | undefined) ?? null;
      const cleanup = (request.cleanup as boolean | undefined) ?? false;
      return mergeTask(projectRoot, branchName, squash, message, cleanup).finally(() => {
        scheduleTaskConvergenceRefreshForGitTarget({
          projectRoot,
        });
        scheduleTaskReviewRefreshForGitTarget({
          projectRoot,
        });
      });
    },

    [IPC.GetBranchLog]: (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return getBranchLog(request.worktreePath);
    },

    [IPC.PushTask]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      const channelId = getOptionalChannelId(request.onOutput);
      const projectRoot = request.projectRoot as string;
      const branchName = request.branchName as string;
      const onOutput = createOutputHandler(context, channelId);
      return streamPushTask(projectRoot, branchName, onOutput).finally(() => {
        scheduleTaskConvergenceRefreshForGitTarget({
          branchName,
          projectRoot,
        });
        scheduleTaskReviewRefreshForGitTarget({
          branchName,
          projectRoot,
        });
      });
    },

    [IPC.RebaseTask]: async (args) => {
      const request = args ?? {};
      validatePath(request.worktreePath, 'worktreePath');
      return rebaseTaskWorkflow(context, {
        worktreePath: request.worktreePath,
      });
    },

    [IPC.GetMainBranch]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      return getMainBranch(request.projectRoot);
    },

    [IPC.GetCurrentBranch]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      return getCurrentBranch(request.projectRoot);
    },

    [IPC.CreateArenaWorktree]: (args) => {
      const request = args ?? {};
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

    [IPC.RemoveArenaWorktree]: (args) => {
      const request = args ?? {};
      validatePath(request.projectRoot, 'projectRoot');
      validateBranchName(request.branchName, 'branchName');
      return removeWorktree(request.projectRoot, request.branchName, true);
    },
  };
}
