import type { TaskCommandControllerSnapshot } from '../../src/domain/server-state.js';
import { assertNever } from '../../src/lib/assert-never.js';
import type { TaskCommandLeaseCommand, TaskCommandLeaseResultMessage } from '../remote/protocol.js';
import {
  acquireTaskCommandLease,
  releaseTaskCommandLease,
  renewTaskCommandLease,
} from './task-command-leases.js';

const TASK_COMMAND_LEASE_FAILED_MESSAGE = 'Task command lease failed';

type TaskCommandControllerChangeHandler = (snapshot: TaskCommandControllerSnapshot) => void;

function toTaskCommandControllerSnapshot(
  snapshot: TaskCommandControllerSnapshot,
): TaskCommandControllerSnapshot {
  return {
    action: snapshot.action,
    controllerId: snapshot.controllerId,
    taskId: snapshot.taskId,
    version: snapshot.version,
  };
}

function getTaskCommandLeaseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : TASK_COMMAND_LEASE_FAILED_MESSAGE;
}

function createTaskCommandLeaseErrorResult(
  message: TaskCommandLeaseCommand,
  error: unknown,
): TaskCommandLeaseResultMessage {
  return {
    type: 'task-command-lease-result',
    error: getTaskCommandLeaseErrorMessage(error),
    operation: message.operation,
    requestId: message.requestId,
  };
}

export function handleTaskCommandLeaseControlMessage(
  message: TaskCommandLeaseCommand,
  clientId: string | null | undefined,
  onControllerChanged: TaskCommandControllerChangeHandler,
): TaskCommandLeaseResultMessage {
  if (!clientId) {
    return createTaskCommandLeaseErrorResult(message, new Error('Unauthorized'));
  }

  try {
    switch (message.operation) {
      case 'acquire': {
        const { changed, ...acquireResult } = acquireTaskCommandLease(
          message.taskId,
          clientId,
          message.ownerId,
          message.action,
          message.takeover ?? false,
        );
        if (changed) {
          onControllerChanged(toTaskCommandControllerSnapshot(acquireResult));
        }
        return {
          type: 'task-command-lease-result',
          operation: 'acquire',
          requestId: message.requestId,
          result: acquireResult,
        };
      }
      case 'renew': {
        const result = renewTaskCommandLease(
          message.taskId,
          clientId,
          message.ownerId,
          Date.now(),
          message.leaseGeneration,
        );
        return {
          type: 'task-command-lease-result',
          operation: 'renew',
          requestId: message.requestId,
          result,
        };
      }
      case 'release': {
        const result = releaseTaskCommandLease(
          message.taskId,
          clientId,
          message.ownerId,
          Date.now(),
          message.leaseGeneration,
        );
        if (result.changed) {
          onControllerChanged(result.snapshot);
        }
        return {
          type: 'task-command-lease-result',
          operation: 'release',
          requestId: message.requestId,
          result: result.snapshot,
        };
      }
    }

    return assertNever(message, 'Unhandled task-command lease message');
  } catch (error) {
    return createTaskCommandLeaseErrorResult(message, error);
  }
}
