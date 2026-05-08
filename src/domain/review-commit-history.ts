import type { ChangedFile } from '../ipc/types.js';

export interface ReviewCommitFile {
  commitHash: string;
  committed: true;
  lines_added: number;
  lines_removed: number;
  path: string;
  status: ChangedFile['status'];
}

export interface ReviewCommitSummary {
  authoredAt: string;
  authorName: string;
  files: ReviewCommitFile[];
  hash: string;
  parentHashes: string[];
  shortHash: string;
  subject: string;
  totalAdded: number;
  totalRemoved: number;
}

export interface BranchCommitHistoryResult {
  baseHash: string;
  commits: ReviewCommitSummary[];
  headHash: string;
  revisionId: string;
}
