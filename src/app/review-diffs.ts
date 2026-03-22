import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import type { ChangedFile, FileDiffResult } from '../ipc/types';

export type TaskReviewDiffSource = 'branch' | 'worktree';

export interface TaskReviewDiffFileTarget {
  committed?: boolean;
  path: string;
  status: ChangedFile['status'];
}

export interface TaskReviewDiffRequest {
  branchName?: string | null;
  projectRoot?: string;
  worktreePath: string;
}

export function createTaskReviewDiffRequest(request: TaskReviewDiffRequest): TaskReviewDiffRequest {
  return {
    ...(request.branchName !== undefined ? { branchName: request.branchName } : {}),
    ...(request.projectRoot ? { projectRoot: request.projectRoot } : {}),
    worktreePath: request.worktreePath,
  };
}

function fetchFileDiffFromWorktree(
  worktreePath: string,
  file: TaskReviewDiffFileTarget,
): Promise<FileDiffResult> {
  return invoke(IPC.GetFileDiff, {
    filePath: file.path,
    status: file.status,
    worktreePath,
  });
}

function fetchFileDiffFromBranch(
  projectRoot: string,
  branchName: string,
  file: TaskReviewDiffFileTarget,
): Promise<FileDiffResult> {
  return invoke(IPC.GetFileDiffFromBranch, {
    projectRoot,
    branchName,
    filePath: file.path,
    status: file.status,
  });
}

function requireBranchDiffContext(
  request: TaskReviewDiffRequest,
  unavailableMessage: string,
): { branchName: string; projectRoot: string } {
  if (!request.projectRoot || !request.branchName) {
    throw new Error(unavailableMessage);
  }

  return {
    branchName: request.branchName,
    projectRoot: request.projectRoot,
  };
}

export async function fetchTaskFileDiff(
  request: TaskReviewDiffRequest,
  file: TaskReviewDiffFileTarget,
): Promise<FileDiffResult> {
  if (file.committed) {
    const { branchName, projectRoot } = requireBranchDiffContext(
      request,
      'Task file diff unavailable',
    );
    return fetchFileDiffFromBranch(projectRoot, branchName, file);
  }

  try {
    return await fetchFileDiffFromWorktree(request.worktreePath, file);
  } catch {
    const { branchName, projectRoot } = requireBranchDiffContext(
      request,
      'Task file diff unavailable',
    );
    return fetchFileDiffFromBranch(projectRoot, branchName, file);
  }
}
