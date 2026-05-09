import { describe, expect, it } from 'vitest';

import {
  isRemovedTaskReviewSignalsEvent,
  isTaskReviewCiSignal,
  isTaskReviewCoverageSignal,
  isTaskReviewSignalsEvent,
  isTaskReviewSignalsSnapshot,
} from './task-review-signals';

describe('task review signals domain helpers', () => {
  it('identifies removed review signal events by explicit removal value', () => {
    expect(
      isRemovedTaskReviewSignalsEvent({
        removed: true,
        taskId: 'task-1',
      }),
    ).toBe(true);
    expect(
      isRemovedTaskReviewSignalsEvent({
        removed: false,
        taskId: 'task-1',
      }),
    ).toBe(false);
  });

  it('validates review signals snapshots and events from transport boundaries', () => {
    const ci = {
      failureCount: 0,
      label: 'CI passing',
      state: 'success',
      totalCount: 3,
    };
    const coverage = {
      label: 'Coverage 90%',
      linesPct: 90,
      source: 'coverage-summary',
      state: 'available',
    };
    const snapshot = {
      ci,
      coverage,
      taskId: 'task-1',
      updatedAt: 10,
    };

    expect(isTaskReviewCiSignal(ci)).toBe(true);
    expect(isTaskReviewCoverageSignal(coverage)).toBe(true);
    expect(isTaskReviewSignalsSnapshot(snapshot)).toBe(true);
    expect(isTaskReviewSignalsEvent(snapshot)).toBe(true);
    expect(isTaskReviewSignalsEvent({ ...snapshot, stateVersion: '7' })).toBe(false);
    expect(isTaskReviewSignalsEvent({ ...snapshot, stateVersion: 1.5 })).toBe(false);
    expect(isTaskReviewCiSignal({ ...ci, state: 'blocked' })).toBe(false);
    expect(isTaskReviewCiSignal({ ...ci, failureCount: -1 })).toBe(false);
    expect(isTaskReviewCiSignal({ ...ci, totalCount: 1.5 })).toBe(false);
    expect(isTaskReviewCiSignal({ ...ci, checkedAt: -1 })).toBe(false);
    expect(isTaskReviewCoverageSignal({ ...coverage, source: 'json' })).toBe(false);
    expect(isTaskReviewCoverageSignal({ ...coverage, checkedAt: 1.5 })).toBe(false);
    expect(isTaskReviewSignalsSnapshot({ ...snapshot, updatedAt: Number.NaN })).toBe(false);
    expect(isTaskReviewSignalsSnapshot({ ...snapshot, updatedAt: -1 })).toBe(false);
  });
});
