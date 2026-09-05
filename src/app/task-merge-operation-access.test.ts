import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TASK_MERGE_MESSAGE_MAX_UTF8_BYTES } from '../domain/task-merge';
import {
  clearRetainedTaskMergeOperation,
  getRetainedTaskMergeOperation,
  resetRetainedTaskMergeOperationsForTests,
  retainTaskMergeOperation,
} from './task-merge-operation-access';

function createMemoryStorage(
  options: { failRemovals?: boolean; failWrites?: boolean } = {},
): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      if (options.failRemovals) throw new DOMException('Access denied', 'SecurityError');
      values.delete(key);
    },
    setItem: (key, value) => {
      if (options.failWrites) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      values.set(key, value);
    },
  };
}

describe('task merge operation access retention', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', createMemoryStorage());
    resetRetainedTaskMergeOperationsForTests();
  });

  it('durably retains an exact maximum-size semantic message', () => {
    const message = 'm'.repeat(TASK_MERGE_MESSAGE_MAX_UTF8_BYTES);

    expect(
      retainTaskMergeOperation(
        { operationCapability: 'capability-1', operationId: 'operation-1' },
        { cleanup: true, message, squash: true, taskId: 'task-1' },
      ),
    ).toBe(true);
    expect(getRetainedTaskMergeOperation('task-1')).toEqual({
      access: { operationCapability: 'capability-1', operationId: 'operation-1' },
      semanticRequest: { cleanup: true, message, squash: true, taskId: 'task-1' },
    });
    expect(sessionStorage.getItem('parallel-code-task-merge-operations-v1')).toContain(message);
  });

  it('rolls memory retention back when browser quota rejects the exact request', () => {
    vi.stubGlobal('sessionStorage', createMemoryStorage({ failWrites: true }));
    resetRetainedTaskMergeOperationsForTests();

    expect(
      retainTaskMergeOperation(
        { operationCapability: 'capability-1', operationId: 'operation-1' },
        { cleanup: false, message: 'merge', squash: true, taskId: 'task-1' },
      ),
    ).toBe(false);
    expect(getRetainedTaskMergeOperation('task-1')).toBeNull();
  });

  it('rejects a 33rd distinct operation without changing memory or persisted recovery state', () => {
    for (let index = 0; index < 32; index += 1) {
      expect(
        retainTaskMergeOperation(
          {
            operationCapability: `capability-${index}`,
            operationId: `operation-${index}`,
          },
          {
            cleanup: index % 2 === 0,
            message: `merge-${index}`,
            squash: index % 2 === 1,
            taskId: `task-${index}`,
          },
        ),
      ).toBe(true);
    }
    const persistedBeforeRejection = sessionStorage.getItem(
      'parallel-code-task-merge-operations-v1',
    );

    expect(() =>
      retainTaskMergeOperation(
        { operationCapability: 'capability-32', operationId: 'operation-32' },
        { cleanup: true, message: 'merge-32', squash: false, taskId: 'task-32' },
      ),
    ).toThrow('Too many task merge operations are awaiting recovery');

    expect(getRetainedTaskMergeOperation('task-32')).toBeNull();
    expect(getRetainedTaskMergeOperation('task-31')).toEqual({
      access: { operationCapability: 'capability-31', operationId: 'operation-31' },
      semanticRequest: {
        cleanup: false,
        message: 'merge-31',
        squash: true,
        taskId: 'task-31',
      },
    });
    expect(sessionStorage.getItem('parallel-code-task-merge-operations-v1')).toBe(
      persistedBeforeRejection,
    );
  });

  it('lets exactly one terminal consumer release a matching retained operation', () => {
    expect(
      retainTaskMergeOperation(
        { operationCapability: 'capability-1', operationId: 'operation-1' },
        { cleanup: true, squash: false, taskId: 'task-1' },
      ),
    ).toBe(true);

    expect(clearRetainedTaskMergeOperation('task-1', 'operation-other')).toBe(false);
    expect(clearRetainedTaskMergeOperation('task-1', 'operation-1')).toBe(true);
    expect(clearRetainedTaskMergeOperation('task-1', 'operation-1')).toBe(false);
    expect(getRetainedTaskMergeOperation('task-1')).toBeNull();
  });

  it('restores in-memory access when durable credential removal is unavailable', () => {
    const storageBehavior = { failRemovals: false };
    vi.stubGlobal('sessionStorage', createMemoryStorage(storageBehavior));
    resetRetainedTaskMergeOperationsForTests();
    expect(
      retainTaskMergeOperation(
        { operationCapability: 'capability-1', operationId: 'operation-1' },
        { cleanup: true, squash: false, taskId: 'task-1' },
      ),
    ).toBe(true);
    storageBehavior.failRemovals = true;

    expect(clearRetainedTaskMergeOperation('task-1', 'operation-1')).toBe(false);
    expect(getRetainedTaskMergeOperation('task-1')).not.toBeNull();
  });
});
