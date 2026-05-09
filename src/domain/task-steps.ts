import {
  isNullableString,
  isNonNegativeInteger,
  isOptionalNonNegativeInteger,
  isOptionalString,
  isRecord,
  isStringArray,
  isStringTupleMember,
} from '../lib/type-guards.js';
import { isRemovedTaskScopedEvent } from './removed-task-event.js';

export const TASK_STEP_STATUSES = [
  'starting',
  'investigating',
  'implementing',
  'testing',
  'awaiting_review',
  'done',
] as const;

export type TaskStepStatus = (typeof TASK_STEP_STATUSES)[number];

export interface TaskStepEntry {
  agentId?: string;
  detail?: string;
  filesTouched?: string[];
  next?: string;
  status: TaskStepStatus;
  summary: string;
  timestamp: string;
}

export const TASK_STEPS_SUMMARY_STATES = ['waiting', 'active', 'ready', 'done', 'error'] as const;

export type TaskStepsSummaryState = (typeof TASK_STEPS_SUMMARY_STATES)[number];

export interface TaskStepsSnapshot {
  errorMessage: string | null;
  revisionId: string;
  state: TaskStepsSummaryState;
  steps: TaskStepEntry[];
  taskId: string;
  trackingEnabled: boolean;
  updatedAt: number;
}

export interface TaskStepsSummarySnapshot {
  errorMessage: string | null;
  latestStep: TaskStepEntry | null;
  nextAction: string | null;
  preview: string | null;
  revisionId: string;
  state: TaskStepsSummaryState;
  stepCount: number;
  taskId: string;
  trackingEnabled: boolean;
  updatedAt: number;
}

export interface RemovedTaskStepsEvent {
  removed: true;
  stateVersion?: number;
  taskId: string;
}

export type TaskStepsEvent =
  | RemovedTaskStepsEvent
  | (TaskStepsSummarySnapshot & { stateVersion?: number });

export function isTaskStepStatus(value: unknown): value is TaskStepStatus {
  return isStringTupleMember(value, TASK_STEP_STATUSES);
}

export function isTaskStepsSummaryState(value: unknown): value is TaskStepsSummaryState {
  return isStringTupleMember(value, TASK_STEPS_SUMMARY_STATES);
}

export function isTaskStepEntry(value: unknown): value is TaskStepEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isOptionalString(value.agentId) &&
    isOptionalString(value.detail) &&
    (value.filesTouched === undefined || isStringArray(value.filesTouched)) &&
    isOptionalString(value.next) &&
    isTaskStepStatus(value.status) &&
    typeof value.summary === 'string' &&
    typeof value.timestamp === 'string'
  );
}

export function isTaskStepsSummarySnapshot(value: unknown): value is TaskStepsSummarySnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNullableString(value.errorMessage) &&
    (value.latestStep === null || isTaskStepEntry(value.latestStep)) &&
    isNullableString(value.nextAction) &&
    isNullableString(value.preview) &&
    typeof value.revisionId === 'string' &&
    isTaskStepsSummaryState(value.state) &&
    isNonNegativeInteger(value.stepCount) &&
    typeof value.taskId === 'string' &&
    typeof value.trackingEnabled === 'boolean' &&
    isNonNegativeInteger(value.updatedAt)
  );
}

export function createRemovedTaskStepsEvent(taskId: string): RemovedTaskStepsEvent {
  return {
    removed: true,
    taskId,
  };
}

export function isRemovedTaskStepsEvent(event: unknown): event is RemovedTaskStepsEvent {
  return isRemovedTaskScopedEvent(event);
}

export function isTaskStepsEvent(value: unknown): value is TaskStepsEvent {
  if (!isRecord(value)) {
    return false;
  }

  if (isRemovedTaskStepsEvent(value)) {
    return true;
  }

  return isTaskStepsSummarySnapshot(value) && isOptionalNonNegativeInteger(value.stateVersion);
}
