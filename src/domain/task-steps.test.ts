import { describe, expect, it } from 'vitest';

import {
  isRemovedTaskStepsEvent,
  isTaskStepEntry,
  isTaskStepStatus,
  isTaskStepsEvent,
  isTaskStepsSummarySnapshot,
  isTaskStepsSummaryState,
} from './task-steps';

describe('task steps domain helpers', () => {
  it('recognizes only supported step and summary states', () => {
    expect(isTaskStepStatus('implementing')).toBe(true);
    expect(isTaskStepStatus('blocked')).toBe(false);
    expect(isTaskStepsSummaryState('ready')).toBe(true);
    expect(isTaskStepsSummaryState('blocked')).toBe(false);
  });

  it('validates task-step summaries and events from transport boundaries', () => {
    const step = {
      detail: 'Reviewed the failing test',
      filesTouched: ['src/app.ts'],
      next: 'Patch the assertion',
      status: 'investigating',
      summary: 'Investigating the regression',
      timestamp: '2026-04-17T10:00:00.000Z',
    };
    const snapshot = {
      errorMessage: null,
      latestStep: step,
      nextAction: 'Patch the assertion',
      preview: 'Investigating the regression',
      revisionId: 'task-1::steps',
      state: 'active',
      stepCount: 1,
      taskId: 'task-1',
      trackingEnabled: true,
      updatedAt: 10,
    };

    expect(isTaskStepEntry(step)).toBe(true);
    expect(isTaskStepsSummarySnapshot(snapshot)).toBe(true);
    expect(isTaskStepsEvent(snapshot)).toBe(true);
    expect(isTaskStepsEvent({ ...snapshot, stateVersion: '7' })).toBe(false);
    expect(isTaskStepsEvent({ ...snapshot, stateVersion: -1 })).toBe(false);
    expect(
      isRemovedTaskStepsEvent({
        removed: false,
        taskId: 'task-1',
      }),
    ).toBe(false);
    expect(isTaskStepEntry({ ...step, filesTouched: [1] })).toBe(false);
    expect(
      isTaskStepsSummarySnapshot({ ...snapshot, latestStep: { ...step, status: 'blocked' } }),
    ).toBe(false);
    expect(isTaskStepsSummarySnapshot({ ...snapshot, stepCount: -1 })).toBe(false);
    expect(isTaskStepsSummarySnapshot({ ...snapshot, stepCount: 1.5 })).toBe(false);
    expect(isTaskStepsSummarySnapshot({ ...snapshot, updatedAt: 1.5 })).toBe(false);
  });
});
