import {
  advanceCompletedMergeProgress,
  assertMergeProgressSnapshot,
  isCommittedMergeOperationMarker,
  isMergeProgressSnapshot,
  seedMergeProgressSnapshot,
  type CommittedMergeOperationMarker,
  type MergeProgressSnapshot,
} from '../../src/domain/task-merge.js';
import { cloneJsonObject, type JsonObject, type JsonValue } from './workspace-state-storage.js';

export const COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION =
  'commit-completed-merge-progress-v1' as const;

export interface CommitCompletedMergeProgressRequest {
  committedAt: Date;
  linesAdded: unknown;
  linesRemoved: unknown;
  operationId: string;
  removedTask: JsonObject;
  stateAfterRemoval: JsonObject;
}

export interface CommitCompletedMergeProgressResult {
  changed: boolean;
  marker: CommittedMergeOperationMarker;
  nextSharedState: JsonObject;
  progress: MergeProgressSnapshot;
}

export class MergeProgressCommitContextError extends Error {
  readonly code = 'merge-progress-commit-context-invalid';
}

const MAX_OPERATION_ID_BYTES = 128;

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getRemovedTaskId(removedTask: JsonObject): string {
  const taskId = removedTask.id;
  if (typeof taskId !== 'string' || taskId.trim().length === 0) {
    throw new MergeProgressCommitContextError('Removed task has no canonical ID');
  }
  return taskId;
}

function validateOperationId(operationId: string): void {
  if (
    operationId.length === 0 ||
    Buffer.byteLength(operationId, 'ascii') !== Buffer.byteLength(operationId, 'utf8') ||
    Buffer.byteLength(operationId, 'ascii') > MAX_OPERATION_ID_BYTES
  ) {
    throw new MergeProgressCommitContextError('Merge operation ID is invalid');
  }
}

function assertTaskAbsentFromCanonicalMembership(state: JsonObject, taskId: string): void {
  const tasks = state.tasks;
  if (tasks !== undefined) {
    if (!isJsonObject(tasks)) {
      throw new MergeProgressCommitContextError('Canonical tasks must be an object');
    }
    if (Object.prototype.hasOwnProperty.call(tasks, taskId)) {
      throw new MergeProgressCommitContextError(
        'Merge progress cannot commit before structural task removal',
      );
    }
  }

  for (const field of ['taskOrder', 'collapsedTaskOrder'] as const) {
    const order = state[field];
    if (order === undefined) continue;
    if (!Array.isArray(order) || order.some((entry) => typeof entry !== 'string')) {
      throw new MergeProgressCommitContextError(`Canonical ${field} must be a string array`);
    }
    if (order.includes(taskId)) {
      throw new MergeProgressCommitContextError(
        `Merge progress cannot commit while ${taskId} remains in ${field}`,
      );
    }
  }
}

function decodeMarker(state: JsonObject): CommittedMergeOperationMarker | null {
  const marker = state.mergeOperation;
  const committedId = state.committedMergeOperationId;
  if (marker === undefined && committedId === undefined) return null;
  if (!isCommittedMergeOperationMarker(marker) || committedId !== marker.operationId) {
    throw new MergeProgressCommitContextError('Committed merge operation marker is invalid');
  }
  return {
    committedAt: marker.committedAt,
    operationId: marker.operationId,
    progressVersion: marker.progressVersion,
    taskId: marker.taskId,
  };
}

export function readMergeProgressSnapshot(
  state: JsonObject,
  seededAt: Date,
): MergeProgressSnapshot {
  if (state.mergeProgress === undefined) {
    return seedMergeProgressSnapshot(
      {
        completedTaskCount: state.completedTaskCount,
        completedTaskDate: state.completedTaskDate,
        mergedLinesAdded: state.mergedLinesAdded,
        mergedLinesRemoved: state.mergedLinesRemoved,
      },
      seededAt,
    );
  }
  if (!isMergeProgressSnapshot(state.mergeProgress)) {
    throw new MergeProgressCommitContextError('Canonical merge progress is invalid');
  }
  const progress = state.mergeProgress;
  return {
    schemaVersion: progress.schemaVersion,
    version: progress.version,
    dateKey: progress.dateKey,
    tasksToday: progress.tasksToday,
    linesAdded: progress.linesAdded,
    linesRemoved: progress.linesRemoved,
    updatedAt: progress.updatedAt,
  };
}

function toJsonProgress(progress: MergeProgressSnapshot): JsonObject {
  return {
    schemaVersion: progress.schemaVersion,
    version: progress.version,
    dateKey: progress.dateKey,
    tasksToday: progress.tasksToday,
    linesAdded: progress.linesAdded,
    linesRemoved: progress.linesRemoved,
    updatedAt: progress.updatedAt,
  };
}

function toJsonMarker(marker: CommittedMergeOperationMarker): JsonObject {
  return {
    committedAt: marker.committedAt,
    operationId: marker.operationId,
    progressVersion: marker.progressVersion,
    taskId: marker.taskId,
  };
}

/**
 * Pure extension for Design 13's eventual final removal mutation. The structural owner must supply
 * state after its private membership transform; this function owns no queue, cleanup, or removal.
 */
export function commitCompletedMergeProgress(
  request: CommitCompletedMergeProgressRequest,
): CommitCompletedMergeProgressResult {
  validateOperationId(request.operationId);
  const taskId = getRemovedTaskId(request.removedTask);
  assertTaskAbsentFromCanonicalMembership(request.stateAfterRemoval, taskId);
  const currentMarker = decodeMarker(request.stateAfterRemoval);
  if (currentMarker && request.stateAfterRemoval.mergeProgress === undefined) {
    throw new MergeProgressCommitContextError(
      'Committed merge marker is missing its canonical progress snapshot',
    );
  }
  const currentProgress = readMergeProgressSnapshot(request.stateAfterRemoval, request.committedAt);
  assertMergeProgressSnapshot(currentProgress);

  if (currentMarker?.operationId === request.operationId) {
    if (
      currentMarker.taskId !== taskId ||
      currentMarker.progressVersion !== currentProgress.version
    ) {
      throw new MergeProgressCommitContextError(
        'Committed merge marker does not match canonical progress',
      );
    }
    return {
      changed: false,
      marker: currentMarker,
      nextSharedState: request.stateAfterRemoval,
      progress: currentProgress,
    };
  }

  const progress = advanceCompletedMergeProgress(currentProgress, {
    committedAt: request.committedAt,
    linesAdded: request.linesAdded,
    linesRemoved: request.linesRemoved,
  });
  const marker: CommittedMergeOperationMarker = {
    committedAt: request.committedAt.toISOString(),
    operationId: request.operationId,
    progressVersion: progress.version,
    taskId,
  };
  const nextSharedState = cloneJsonObject(request.stateAfterRemoval);
  nextSharedState.mergeProgress = toJsonProgress(progress);
  nextSharedState.mergeOperation = toJsonMarker(marker);
  nextSharedState.committedMergeOperationId = marker.operationId;
  // One rollback-window compatibility projection. These are never independent writers after cutover.
  nextSharedState.completedTaskDate = progress.dateKey;
  nextSharedState.completedTaskCount = progress.tasksToday;
  nextSharedState.mergedLinesAdded = progress.linesAdded;
  nextSharedState.mergedLinesRemoved = progress.linesRemoved;

  return {
    changed: true,
    marker,
    nextSharedState,
    progress,
  };
}
