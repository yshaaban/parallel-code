import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import type { ChangedFile } from '../ipc/types';
import type { ReviewDiffMode } from '../store/types';

export interface TaskReviewFilesResult {
  files: ChangedFile[];
  totalAdded: number;
  totalRemoved: number;
}

interface TaskReviewFilesRequest {
  branchName?: string | null;
  projectRoot?: string;
  worktreePath: string;
}

export function createTaskReviewFilesRequest(
  request: TaskReviewFilesRequest,
): TaskReviewFilesRequest {
  return {
    ...(request.branchName !== undefined ? { branchName: request.branchName } : {}),
    ...(request.projectRoot ? { projectRoot: request.projectRoot } : {}),
    worktreePath: request.worktreePath,
  };
}

function fetchProjectDiffFiles(
  worktreePath: string,
  mode: ReviewDiffMode,
): Promise<TaskReviewFilesResult> {
  return invoke(IPC.GetProjectDiff, {
    worktreePath,
    mode,
  });
}

function fetchBranchReviewFiles(
  projectRoot: string,
  branchName: string,
): Promise<TaskReviewFilesResult> {
  return invoke<ChangedFile[]>(IPC.GetChangedFilesFromBranch, {
    projectRoot,
    branchName,
  }).then((files) => summarizeChangedFiles(files));
}

function summarizeChangedFiles(files: ReadonlyArray<ChangedFile>): TaskReviewFilesResult {
  return {
    files: [...files],
    totalAdded: files.reduce((sum, file) => sum + file.lines_added, 0),
    totalRemoved: files.reduce((sum, file) => sum + file.lines_removed, 0),
  };
}

export async function fetchTaskReviewFiles(
  request: TaskReviewFilesRequest,
  mode: ReviewDiffMode,
): Promise<TaskReviewFilesResult> {
  if (mode !== 'all') {
    return fetchProjectDiffFiles(request.worktreePath, mode);
  }

  try {
    return await fetchProjectDiffFiles(request.worktreePath, 'all');
  } catch {
    if (!request.projectRoot || !request.branchName) {
      throw new Error('Task review files unavailable');
    }

    return fetchBranchReviewFiles(request.projectRoot, request.branchName);
  }
}
