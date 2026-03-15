import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import type { FileDiffResult } from '../ipc/types';

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
  filePath: string,
): Promise<FileDiffResult> {
  return invoke(IPC.GetFileDiff, {
    worktreePath,
    filePath,
  });
}

function fetchFileDiffFromBranch(
  projectRoot: string,
  branchName: string,
  filePath: string,
): Promise<FileDiffResult> {
  return invoke(IPC.GetFileDiffFromBranch, {
    projectRoot,
    branchName,
    filePath,
  });
}

function fetchAllDiffsFromWorktree(worktreePath: string): Promise<string> {
  return invoke(IPC.GetAllFileDiffs, {
    worktreePath,
  });
}

function fetchAllDiffsFromBranch(projectRoot: string, branchName: string): Promise<string> {
  return invoke(IPC.GetAllFileDiffsFromBranch, {
    projectRoot,
    branchName,
  });
}

export async function fetchTaskFileDiff(
  request: TaskReviewDiffRequest,
  filePath: string,
): Promise<FileDiffResult> {
  try {
    return await fetchFileDiffFromWorktree(request.worktreePath, filePath);
  } catch {
    if (!request.projectRoot || !request.branchName) {
      throw new Error('Task file diff unavailable');
    }

    return fetchFileDiffFromBranch(request.projectRoot, request.branchName, filePath);
  }
}

export async function fetchTaskAllDiffs(request: TaskReviewDiffRequest): Promise<string> {
  try {
    return await fetchAllDiffsFromWorktree(request.worktreePath);
  } catch {
    if (!request.projectRoot || !request.branchName) {
      throw new Error('Task diff unavailable');
    }

    return fetchAllDiffsFromBranch(request.projectRoot, request.branchName);
  }
}
