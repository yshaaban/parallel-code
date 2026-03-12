import { IPC } from './channels.js';
import type { HandlerContext, IpcHandler } from './handler-context.js';
import {
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
  getWorktreeStatus,
  mergeTask,
  pushTask,
  removeWorktree,
} from './git.js';
import {
  commitAllWorkflow,
  discardUncommittedWorkflow,
  rebaseTaskWorkflow,
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

export function createTaskAndGitIpcHandlers(
  context: HandlerContext,
  taskNames: Map<string, string>,
): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.CreateTask]: async (args) => {
      const request = args ?? {};
      assertString(request.name, 'name');
      validatePath(request.projectRoot, 'projectRoot');
      assertStringArray(request.symlinkDirs, 'symlinkDirs');
      assertOptionalString(request.branchPrefix, 'branchPrefix');

      const result = await createTaskWorkflow(context, {
        name: request.name,
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

      await deleteTaskWorkflow({
        agentIds: request.agentIds,
        branchName: request.branchName,
        deleteBranch: request.deleteBranch,
        projectRoot: request.projectRoot,
        ...(typeof request.taskId === 'string' ? { taskId: request.taskId } : {}),
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
      return mergeTask(
        request.projectRoot,
        request.branchName,
        request.squash,
        request.message ?? null,
        request.cleanup ?? false,
      );
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
      return pushTask(request.projectRoot, request.branchName);
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
