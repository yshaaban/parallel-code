import { describe, expect, it, beforeEach } from 'vitest';
import type { TaskReviewSignalsSnapshot } from '../domain/task-review-signals';
import { resetStoreForTest } from '../test/store-test-helpers';
import { store } from '../store/core';
import {
  applyTaskReviewSignalsEvent,
  getTaskReviewSignalsSnapshot,
  replaceTaskReviewSignalsSnapshots,
  resetTaskReviewSignalsProjectionStateForTests,
} from './task-review-signals';

function createSnapshot(
  taskId: string,
  overrides: Partial<TaskReviewSignalsSnapshot> = {},
): TaskReviewSignalsSnapshot {
  return {
    ci: {
      label: 'CI passing',
      state: 'success',
    },
    coverage: {
      label: 'Coverage 90.0%',
      linesPct: 90,
      source: 'coverage-summary',
      state: 'available',
    },
    taskId,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('task review signals state projection', () => {
  beforeEach(() => {
    resetStoreForTest();
    resetTaskReviewSignalsProjectionStateForTests();
  });

  it('applies bootstrap replacement and live updates through the same store record', () => {
    const first = createSnapshot('task-1', {
      updatedAt: 1_000,
    });
    const second = createSnapshot('task-1', {
      ci: {
        label: 'CI failing',
        state: 'failure',
      },
      updatedAt: 2_000,
    });

    replaceTaskReviewSignalsSnapshots([first], { replaceVersion: 1 });
    applyTaskReviewSignalsEvent({
      ...second,
      stateVersion: 2,
    });

    expect(getTaskReviewSignalsSnapshot('task-1')).toEqual(second);
    expect(store.taskReviewSignals['task-1']).toEqual(second);
  });

  it('removes signal state by task id', () => {
    replaceTaskReviewSignalsSnapshots([createSnapshot('task-1')], { replaceVersion: 1 });

    applyTaskReviewSignalsEvent({
      removed: true,
      stateVersion: 2,
      taskId: 'task-1',
    });

    expect(getTaskReviewSignalsSnapshot('task-1')).toBeUndefined();
  });
});
