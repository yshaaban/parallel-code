import { isTaskCreationOperationSnapshot } from '../../src/domain/task-creation.js';
import { isTaskCreationOperationId } from '../../src/domain/task-creation-ticket.js';
import { isRecord } from '../../src/lib/type-guards.js';
import type {
  TaskCreationOperationSnapshotMessage,
  TaskCreationOperationSubscriptionStateMessage,
} from './protocol.js';

export type TaskCreationOperationServerMessage =
  | TaskCreationOperationSnapshotMessage
  | TaskCreationOperationSubscriptionStateMessage;

export function isTaskCreationOperationSnapshotMessage(
  value: unknown,
): value is TaskCreationOperationSnapshotMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.type === 'task-creation-operation-snapshot' &&
    isTaskCreationOperationSnapshot(value.snapshot)
  );
}

export function isTaskCreationOperationSubscriptionStateMessage(
  value: unknown,
): value is TaskCreationOperationSubscriptionStateMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.type === 'task-creation-operation-subscription-state' &&
    isTaskCreationOperationId(value.operationId) &&
    (value.state === 'degraded' || value.state === 'ready')
  );
}

export function isTaskCreationOperationServerMessage(
  value: unknown,
): value is TaskCreationOperationServerMessage {
  return (
    isTaskCreationOperationSnapshotMessage(value) ||
    isTaskCreationOperationSubscriptionStateMessage(value)
  );
}
