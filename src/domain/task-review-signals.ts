export type TaskReviewCiState = 'unconfigured' | 'pending' | 'success' | 'failure' | 'error';
export type TaskReviewCoverageState = 'missing' | 'available' | 'error';
export type TaskReviewCoverageSource = 'coverage-summary' | 'lcov';

export interface TaskReviewCiSignal {
  checkedAt?: number;
  description?: string;
  failureCount?: number;
  headSha?: string;
  label: string;
  pendingCount?: number;
  state: TaskReviewCiState;
  targetUrl?: string;
  totalCount?: number;
}

export interface TaskReviewCoverageSignal {
  branchesPct?: number;
  checkedAt?: number;
  description?: string;
  functionsPct?: number;
  label: string;
  linesPct?: number;
  source?: TaskReviewCoverageSource;
  state: TaskReviewCoverageState;
  statementsPct?: number;
}

export interface TaskReviewSignalsSnapshot {
  ci: TaskReviewCiSignal;
  coverage: TaskReviewCoverageSignal;
  taskId: string;
  updatedAt: number;
}

export interface RemovedTaskReviewSignalsEvent {
  removed: true;
  stateVersion?: number;
  taskId: string;
}

export type TaskReviewSignalsEvent =
  | (TaskReviewSignalsSnapshot & { stateVersion?: number })
  | RemovedTaskReviewSignalsEvent;

export function isRemovedTaskReviewSignalsEvent(
  event: TaskReviewSignalsEvent,
): event is RemovedTaskReviewSignalsEvent {
  return 'removed' in event;
}
