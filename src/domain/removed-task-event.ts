import { isOptionalNonNegativeInteger, isRecord } from '../lib/type-guards.js';

export interface RemovedTaskScopedEvent {
  removed: true;
  stateVersion?: number;
  taskId: string;
}

export interface RemovedTaskScopedKindEvent extends RemovedTaskScopedEvent {
  kind: 'removed';
}

export function isRemovedTaskScopedEvent(value: unknown): value is RemovedTaskScopedEvent {
  return (
    isRecord(value) &&
    value.removed === true &&
    typeof value.taskId === 'string' &&
    isOptionalNonNegativeInteger(value.stateVersion)
  );
}

export function isRemovedTaskScopedKindEvent(value: unknown): value is RemovedTaskScopedKindEvent {
  return isRecord(value) && value.kind === 'removed' && isRemovedTaskScopedEvent(value);
}
