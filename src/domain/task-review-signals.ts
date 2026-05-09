import {
  isNonNegativeInteger,
  isOptionalFiniteNumber,
  isOptionalNonNegativeInteger,
  isOptionalString,
  isRecord,
  isStringMember,
} from '../lib/type-guards.js';
import { isRemovedTaskScopedEvent } from './removed-task-event.js';

export type TaskReviewCiState = 'unconfigured' | 'pending' | 'success' | 'failure' | 'error';
export type TaskReviewCoverageState = 'missing' | 'available' | 'error';
export type TaskReviewCoverageSource = 'coverage-summary' | 'lcov';

const TASK_REVIEW_CI_STATE_VALUES = {
  error: true,
  failure: true,
  pending: true,
  success: true,
  unconfigured: true,
} satisfies Record<TaskReviewCiState, true>;

const TASK_REVIEW_COVERAGE_STATE_VALUES = {
  available: true,
  error: true,
  missing: true,
} satisfies Record<TaskReviewCoverageState, true>;

const TASK_REVIEW_COVERAGE_SOURCE_VALUES = {
  'coverage-summary': true,
  lcov: true,
} satisfies Record<TaskReviewCoverageSource, true>;

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

export function isTaskReviewCiState(value: unknown): value is TaskReviewCiState {
  return isStringMember(value, TASK_REVIEW_CI_STATE_VALUES);
}

export function isTaskReviewCoverageState(value: unknown): value is TaskReviewCoverageState {
  return isStringMember(value, TASK_REVIEW_COVERAGE_STATE_VALUES);
}

export function isTaskReviewCoverageSource(value: unknown): value is TaskReviewCoverageSource {
  return isStringMember(value, TASK_REVIEW_COVERAGE_SOURCE_VALUES);
}

export function isTaskReviewCiSignal(value: unknown): value is TaskReviewCiSignal {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isOptionalNonNegativeInteger(value.checkedAt) &&
    isOptionalString(value.description) &&
    isOptionalNonNegativeInteger(value.failureCount) &&
    isOptionalString(value.headSha) &&
    typeof value.label === 'string' &&
    isOptionalNonNegativeInteger(value.pendingCount) &&
    isTaskReviewCiState(value.state) &&
    isOptionalString(value.targetUrl) &&
    isOptionalNonNegativeInteger(value.totalCount)
  );
}

export function isTaskReviewCoverageSignal(value: unknown): value is TaskReviewCoverageSignal {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isOptionalFiniteNumber(value.branchesPct) &&
    isOptionalNonNegativeInteger(value.checkedAt) &&
    isOptionalString(value.description) &&
    isOptionalFiniteNumber(value.functionsPct) &&
    typeof value.label === 'string' &&
    isOptionalFiniteNumber(value.linesPct) &&
    (value.source === undefined || isTaskReviewCoverageSource(value.source)) &&
    isTaskReviewCoverageState(value.state) &&
    isOptionalFiniteNumber(value.statementsPct)
  );
}

export function isTaskReviewSignalsSnapshot(value: unknown): value is TaskReviewSignalsSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isTaskReviewCiSignal(value.ci) &&
    isTaskReviewCoverageSignal(value.coverage) &&
    typeof value.taskId === 'string' &&
    isNonNegativeInteger(value.updatedAt)
  );
}

export function isRemovedTaskReviewSignalsEvent(
  event: unknown,
): event is RemovedTaskReviewSignalsEvent {
  return isRemovedTaskScopedEvent(event);
}

export function isTaskReviewSignalsEvent(value: unknown): value is TaskReviewSignalsEvent {
  if (!isRecord(value)) {
    return false;
  }

  if (isRemovedTaskReviewSignalsEvent(value)) {
    return true;
  }

  return isTaskReviewSignalsSnapshot(value) && isOptionalNonNegativeInteger(value.stateVersion);
}
