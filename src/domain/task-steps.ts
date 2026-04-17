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
  taskId: string;
}

export type TaskStepsEvent = RemovedTaskStepsEvent | TaskStepsSummarySnapshot;

export function isTaskStepStatus(value: string): value is TaskStepStatus {
  return TASK_STEP_STATUSES.some((status) => status === value);
}

export function isTaskStepsSummaryState(value: string): value is TaskStepsSummaryState {
  return TASK_STEPS_SUMMARY_STATES.some((state) => state === value);
}

export function createRemovedTaskStepsEvent(taskId: string): RemovedTaskStepsEvent {
  return {
    removed: true,
    taskId,
  };
}

export function isRemovedTaskStepsEvent(event: TaskStepsEvent): event is RemovedTaskStepsEvent {
  return 'removed' in event && event.removed === true;
}
