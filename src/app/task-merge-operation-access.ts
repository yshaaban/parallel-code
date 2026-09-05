import {
  TASK_MERGE_MESSAGE_MAX_UTF8_BYTES,
  isTaskMergeOperationAccess,
  isTaskMergeSemanticRequest,
  type TaskMergeOperationAccess,
  type TaskMergeSemanticRequest,
} from '../domain/task-merge';
import {
  getSafeSessionStorage,
  getSafeStorageItem,
  removeSafeStorageItem,
  setSafeStorageItem,
} from '../lib/browser-storage';

const STORAGE_KEY = 'parallel-code-task-merge-operations-v1';
const MAX_RETAINED_OPERATIONS = 32;
// JSON may expand a legal one-byte control scalar to a six-byte `\u00xx` escape. Keep the parser
// bound large enough for every legal retained request at the operation-count limit; browser quota
// remains an independent admission check and must succeed before Start is dispatched.
const MAX_JSON_EXPANSION_PER_UTF8_BYTE = 6;
const MAX_SERIALIZED_OPERATION_OVERHEAD_BYTES = 8 * 1_024;
const MAX_STORAGE_BYTES =
  MAX_RETAINED_OPERATIONS *
    (TASK_MERGE_MESSAGE_MAX_UTF8_BYTES * MAX_JSON_EXPANSION_PER_UTF8_BYTE +
      MAX_SERIALIZED_OPERATION_OVERHEAD_BYTES) +
  2;

export interface RetainedTaskMergeOperation {
  access: TaskMergeOperationAccess;
  semanticRequest: TaskMergeSemanticRequest;
}

const retainedByTaskId = new Map<string, RetainedTaskMergeOperation>();
let hydrated = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneRetained(value: RetainedTaskMergeOperation): RetainedTaskMergeOperation {
  return {
    access: { ...value.access },
    semanticRequest: { ...value.semanticRequest },
  };
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const storage = getSafeSessionStorage();
  const json = getSafeStorageItem(storage, STORAGE_KEY);
  if (!json) return;
  if (new TextEncoder().encode(json).byteLength > MAX_STORAGE_BYTES) {
    removeSafeStorageItem(storage, STORAGE_KEY);
    return;
  }
  try {
    const decoded: unknown = JSON.parse(json);
    if (!Array.isArray(decoded) || decoded.length > MAX_RETAINED_OPERATIONS) throw new Error();
    for (const value of decoded) {
      if (
        !isRecord(value) ||
        !isTaskMergeOperationAccess(value.access) ||
        !isTaskMergeSemanticRequest(value.semanticRequest) ||
        value.semanticRequest.taskId.length === 0
      ) {
        throw new Error();
      }
      retainedByTaskId.set(value.semanticRequest.taskId, {
        access: { ...value.access },
        semanticRequest: { ...value.semanticRequest },
      });
    }
  } catch {
    retainedByTaskId.clear();
    removeSafeStorageItem(storage, STORAGE_KEY);
  }
}

function persist(): boolean {
  const storage = getSafeSessionStorage();
  if (retainedByTaskId.size === 0) {
    return removeSafeStorageItem(storage, STORAGE_KEY);
  }
  const json = JSON.stringify([...retainedByTaskId.values()]);
  if (new TextEncoder().encode(json).byteLength > MAX_STORAGE_BYTES) return false;
  return setSafeStorageItem(storage, STORAGE_KEY, json);
}

export function areTaskMergeSemanticRequestsEqual(
  left: Readonly<TaskMergeSemanticRequest>,
  right: Readonly<TaskMergeSemanticRequest>,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.cleanup === right.cleanup &&
    left.squash === right.squash &&
    left.message === right.message
  );
}

export function getRetainedTaskMergeOperation(taskId: string): RetainedTaskMergeOperation | null {
  hydrate();
  const retained = retainedByTaskId.get(taskId);
  return retained ? cloneRetained(retained) : null;
}

export function listRetainedTaskMergeOperations(): RetainedTaskMergeOperation[] {
  hydrate();
  return [...retainedByTaskId.values()].map(cloneRetained);
}

export function retainTaskMergeOperation(
  access: Readonly<TaskMergeOperationAccess>,
  semanticRequest: Readonly<TaskMergeSemanticRequest>,
): boolean {
  hydrate();
  const normalizedAccess = {
    operationCapability: access.operationCapability,
    operationId: access.operationId,
  };
  if (
    !isTaskMergeOperationAccess(normalizedAccess) ||
    !isTaskMergeSemanticRequest(semanticRequest)
  ) {
    throw new Error('Cannot retain invalid task merge operation access');
  }
  if (
    !retainedByTaskId.has(semanticRequest.taskId) &&
    retainedByTaskId.size >= MAX_RETAINED_OPERATIONS
  ) {
    throw new Error('Too many task merge operations are awaiting recovery');
  }
  const previous = retainedByTaskId.get(semanticRequest.taskId);
  retainedByTaskId.set(semanticRequest.taskId, {
    access: {
      operationCapability: normalizedAccess.operationCapability,
      operationId: normalizedAccess.operationId,
    },
    semanticRequest: { ...semanticRequest },
  });
  if (persist()) return true;
  if (previous) {
    retainedByTaskId.set(semanticRequest.taskId, previous);
  } else {
    retainedByTaskId.delete(semanticRequest.taskId);
  }
  return false;
}

/** Release exact matches with one synchronous storage update; failure leaves every match retained. */
export function releaseRetainedTaskMergeOperations(
  operations: ReadonlyArray<Readonly<{ operationId: string; taskId: string }>>,
): ReadonlySet<string> {
  hydrate();
  const released: Array<[string, RetainedTaskMergeOperation]> = [];
  for (const operation of operations) {
    const retained = retainedByTaskId.get(operation.taskId);
    if (!retained || retained.access.operationId !== operation.operationId) continue;
    retainedByTaskId.delete(operation.taskId);
    released.push([operation.taskId, retained]);
  }
  if (released.length === 0) return new Set();
  if (persist()) return new Set(released.map(([taskId]) => taskId));
  for (const [taskId, retained] of released) {
    retainedByTaskId.set(taskId, retained);
  }
  return new Set();
}

export function clearRetainedTaskMergeOperation(taskId: string, operationId: string): boolean {
  return releaseRetainedTaskMergeOperations([{ operationId, taskId }]).has(taskId);
}

export function resetRetainedTaskMergeOperationsForTests(): void {
  retainedByTaskId.clear();
  hydrated = false;
  removeSafeStorageItem(getSafeSessionStorage(), STORAGE_KEY);
}
