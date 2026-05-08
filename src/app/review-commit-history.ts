import { IPC } from '../../electron/ipc/channels';
import type { BranchCommitHistoryResult } from '../domain/review-commit-history';
import { invoke } from '../lib/ipc';

export interface BranchCommitHistoryRequest {
  baseBranch?: string;
  branchName: string;
  projectRoot: string;
}

export function fetchBranchCommitHistory(
  request: BranchCommitHistoryRequest,
): Promise<BranchCommitHistoryResult> {
  return invoke(IPC.GetBranchCommitHistory, {
    ...(request.baseBranch !== undefined ? { baseBranch: request.baseBranch } : {}),
    branchName: request.branchName,
    projectRoot: request.projectRoot,
  });
}
