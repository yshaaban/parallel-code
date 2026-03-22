import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import type { ChangedFile } from '../ipc/types';
import type { ReviewDiffMode } from '../store/types';
import { assertNever } from '../lib/assert-never';

export type TaskReviewFilesSource = 'branch-fallback' | 'project-diff';

export interface TaskReviewFilesResult {
  files: ChangedFile[];
  source: TaskReviewFilesSource;
  totalAdded: number;
  totalRemoved: number;
}

export interface TaskReviewFilesRequest {
  branchName?: string | null;
  projectRoot?: string;
  worktreePath: string;
}

export function createTaskReviewFilesRequest(
  request: TaskReviewFilesRequest,
): TaskReviewFilesRequest {
  const nextRequest: TaskReviewFilesRequest = {
    worktreePath: request.worktreePath,
  };

  if (request.branchName !== undefined) {
    nextRequest.branchName = request.branchName;
  }

  if (request.projectRoot) {
    nextRequest.projectRoot = request.projectRoot;
  }

  return nextRequest;
}

function fetchProjectDiffFiles(
  worktreePath: string,
  mode: ReviewDiffMode,
): Promise<TaskReviewFilesResult> {
  return invoke(IPC.GetProjectDiff, {
    worktreePath,
    mode,
  }).then((result) => ({
    ...result,
    source: 'project-diff',
  }));
}

function fetchBranchReviewFiles(
  projectRoot: string,
  branchName: string,
): Promise<TaskReviewFilesResult> {
  return invoke(IPC.GetChangedFilesFromBranch, {
    projectRoot,
    branchName,
  }).then((files) => summarizeChangedFiles(files, 'branch-fallback'));
}

function summarizeChangedFiles(
  files: ReadonlyArray<ChangedFile>,
  source: TaskReviewFilesSource,
): TaskReviewFilesResult {
  return {
    files: [...files],
    source,
    totalAdded: files.reduce((sum, file) => sum + file.lines_added, 0),
    totalRemoved: files.reduce((sum, file) => sum + file.lines_removed, 0),
  };
}

export async function fetchTaskReviewFiles(
  request: TaskReviewFilesRequest,
  mode: ReviewDiffMode,
): Promise<TaskReviewFilesResult> {
  switch (mode) {
    case 'staged':
    case 'unstaged':
    case 'branch':
      return fetchProjectDiffFiles(request.worktreePath, mode);
    case 'all':
      try {
        return await fetchProjectDiffFiles(request.worktreePath, 'all');
      } catch {
        if (!request.projectRoot || !request.branchName) {
          throw new Error('Task review files unavailable');
        }

        return fetchBranchReviewFiles(request.projectRoot, request.branchName);
      }
  }

  return assertNever(mode, 'Unhandled review diff mode');
}
