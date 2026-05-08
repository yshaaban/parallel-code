import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import type { ChangedFile, FileDiffResult } from '../ipc/types';

export type TaskReviewDiffSource = 'branch' | 'worktree';

export interface TaskReviewDiffFileTarget {
  commitHash?: string;
  committed?: boolean;
  path: string;
  status: ChangedFile['status'];
}

export interface TaskReviewDiffRequest {
  baseBranch?: string;
  branchName?: string | null;
  projectRoot?: string;
  worktreePath: string;
}

export function createTaskReviewDiffRequest(request: TaskReviewDiffRequest): TaskReviewDiffRequest {
  return {
    ...(request.baseBranch !== undefined ? { baseBranch: request.baseBranch } : {}),
    ...(request.branchName !== undefined ? { branchName: request.branchName } : {}),
    ...(request.projectRoot ? { projectRoot: request.projectRoot } : {}),
    worktreePath: request.worktreePath,
  };
}

function fetchFileDiffFromWorktree(
  worktreePath: string,
  file: TaskReviewDiffFileTarget,
  baseBranch?: string,
): Promise<FileDiffResult> {
  return invoke(IPC.GetFileDiff, {
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    filePath: file.path,
    status: file.status,
    worktreePath,
  });
}

function fetchFileDiffFromBranch(
  projectRoot: string,
  branchName: string,
  file: TaskReviewDiffFileTarget,
  baseBranch?: string,
): Promise<FileDiffResult> {
  return invoke(IPC.GetFileDiffFromBranch, {
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    ...(file.commitHash !== undefined ? { commitHash: file.commitHash } : {}),
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
    return fetchFileDiffFromBranch(projectRoot, branchName, file, request.baseBranch);
  }

  try {
    return await fetchFileDiffFromWorktree(request.worktreePath, file, request.baseBranch);
  } catch {
    const { branchName, projectRoot } = requireBranchDiffContext(
      request,
      'Task file diff unavailable',
    );
    return fetchFileDiffFromBranch(projectRoot, branchName, file, request.baseBranch);
  }
}
