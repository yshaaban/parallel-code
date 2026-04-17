import { beforeEach, describe, expect, it } from 'vitest';

import { resetStoreForTest } from '../test/store-test-helpers.js';
import { createRemovedTaskStepsEvent } from '../domain/task-steps.js';
import {
  applyTaskStepsEvent,
  clearTaskSteps,
  getTaskStepsSnapshot,
  getTaskStepsSummary,
  replaceTaskStepsSummarySnapshots,
  setTaskStepsSnapshot,
} from './task-steps.js';

describe('task steps store projection', () => {
  beforeEach(() => {
    resetStoreForTest();
  });

  it('stores summary events and full snapshots separately', () => {
    applyTaskStepsEvent({
      errorMessage: null,
      latestStep: {
        summary: 'Investigating the bug',
        status: 'investigating',
        timestamp: '2026-04-17T09:00:00.000Z',
      },
      nextAction: 'Open the failing trace',
      preview: 'Open the failing trace',
      revisionId: 'task-1::summary',
      state: 'active',
      stepCount: 1,
      taskId: 'task-1',
      trackingEnabled: true,
      updatedAt: 1_000,
    });
    setTaskStepsSnapshot({
      errorMessage: null,
      revisionId: 'task-1::snapshot',
      state: 'active',
      steps: [
        {
          summary: 'Investigating the bug',
          status: 'investigating',
          timestamp: '2026-04-17T09:00:00.000Z',
        },
      ],
      taskId: 'task-1',
      trackingEnabled: true,
      updatedAt: 1_500,
    });

    expect(getTaskStepsSummary('task-1')).toMatchObject({
      preview: 'Open the failing trace',
      taskId: 'task-1',
    });
    expect(getTaskStepsSnapshot('task-1')).toMatchObject({
      revisionId: 'task-1::snapshot',
      taskId: 'task-1',
    });
  });

  it('replaces summary snapshots and clears both projections on removal', () => {
    replaceTaskStepsSummarySnapshots([
      {
        errorMessage: null,
        latestStep: null,
        nextAction: null,
        preview: 'Waiting for the first step',
        revisionId: 'task-1::summary',
        state: 'waiting',
        stepCount: 0,
        taskId: 'task-1',
        trackingEnabled: true,
        updatedAt: 1_000,
      },
    ]);
    setTaskStepsSnapshot({
      errorMessage: null,
      revisionId: 'task-1::snapshot',
      state: 'waiting',
      steps: [],
      taskId: 'task-1',
      trackingEnabled: true,
      updatedAt: 1_000,
    });

    applyTaskStepsEvent(createRemovedTaskStepsEvent('task-1'));

    expect(getTaskStepsSummary('task-1')).toBeUndefined();
    expect(getTaskStepsSnapshot('task-1')).toBeUndefined();

    clearTaskSteps('task-1');
    expect(getTaskStepsSummary('task-1')).toBeUndefined();
    expect(getTaskStepsSnapshot('task-1')).toBeUndefined();
  });
});
