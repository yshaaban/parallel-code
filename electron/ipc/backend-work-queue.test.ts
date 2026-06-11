import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearBackendClientFocus,
  enqueueBackendWork,
  getAllBackendFocusedChannelIds,
  getBackendClientFocusedChannelIds,
  getBackendClientSelectedTaskId,
  getBackendWorkPriorityForTask,
  getBackendWorkQueueDiagnostics,
  releaseBackendBackgroundWork,
  resetBackendWorkQueueForTests,
  scheduleBackgroundReconciliation,
  setBackendClientFocus,
  subscribeBackendClientFocusedChannels,
} from './backend-work-queue.js';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushResolvedPromises(iterations = 8): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

describe('backend work queue', () => {
  beforeEach(() => {
    resetBackendWorkQueueForTests();
    delete process.env.PARALLEL_CODE_BACKEND_WORK_CONCURRENCY;
  });

  afterEach(() => {
    resetBackendWorkQueueForTests();
    delete process.env.PARALLEL_CODE_BACKEND_WORK_CONCURRENCY;
    vi.useRealTimers();
  });

  it('enforces the concurrency cap and dispatches by priority class', async () => {
    process.env.PARALLEL_CODE_BACKEND_WORK_CONCURRENCY = '1';
    const order: string[] = [];
    const gate = createDeferred();

    const first = enqueueBackendWork({ key: 'job:first', priority: 'visible' }, async () => {
      order.push('first');
      await gate.promise;
    });
    await flushResolvedPromises();

    const visible = enqueueBackendWork({ key: 'job:visible', priority: 'visible' }, () => {
      order.push('visible');
    });
    const interactive = enqueueBackendWork(
      { key: 'job:interactive', priority: 'interactive' },
      () => {
        order.push('interactive');
      },
    );
    const selected = enqueueBackendWork({ key: 'job:selected', priority: 'selected' }, () => {
      order.push('selected');
    });

    expect(getBackendWorkQueueDiagnostics()).toMatchObject({
      pendingByClass: { interactive: 1, selected: 1, visible: 1 },
      running: 1,
    });

    gate.resolve();
    await Promise.all([first, visible, interactive, selected]);

    expect(order).toEqual(['first', 'interactive', 'selected', 'visible']);
    expect(getBackendWorkQueueDiagnostics()).toMatchObject({
      completed: 4,
      running: 0,
    });
  });

  it('coalesces pending jobs by key and raises their priority', async () => {
    process.env.PARALLEL_CODE_BACKEND_WORK_CONCURRENCY = '1';
    const gate = createDeferred();
    const runs = vi.fn();

    const blocker = enqueueBackendWork(
      { key: 'job:blocker', priority: 'interactive' },
      async () => {
        await gate.promise;
      },
    );
    await flushResolvedPromises();

    const lowPriority = enqueueBackendWork({ key: 'job:dedupe', priority: 'background' }, () => {
      runs();
      return 'result';
    });
    const raised = enqueueBackendWork({ key: 'job:dedupe', priority: 'interactive' }, () => {
      runs();
      return 'other';
    });

    expect(getBackendWorkQueueDiagnostics().pendingByClass.interactive).toBe(1);
    expect(getBackendWorkQueueDiagnostics().pendingByClass.background).toBe(0);

    gate.resolve();
    await Promise.all([blocker, lowPriority, raised]);

    expect(runs).toHaveBeenCalledTimes(1);
    await expect(lowPriority).resolves.toBe('result');
    await expect(raised).resolves.toBe('result');
  });

  it('derives task priority from merged multi-client focus', () => {
    expect(getBackendWorkPriorityForTask('task-1')).toBe('visible');

    setBackendClientFocus('client-a', {
      selectedTaskId: 'task-1',
      visibleTaskIds: ['task-1', 'task-2'],
    });
    setBackendClientFocus('client-b', {
      selectedTaskId: 'task-3',
      visibleTaskIds: ['task-3'],
    });

    expect(getBackendWorkPriorityForTask('task-1')).toBe('selected');
    expect(getBackendWorkPriorityForTask('task-2')).toBe('visible');
    expect(getBackendWorkPriorityForTask('task-3')).toBe('selected');
    expect(getBackendWorkPriorityForTask('task-4')).toBe('background');

    clearBackendClientFocus('client-a');
    expect(getBackendWorkPriorityForTask('task-1')).toBe('background');

    clearBackendClientFocus('client-b');
    expect(getBackendWorkPriorityForTask('task-3')).toBe('visible');
  });

  it('prunes expired client focus entries instead of skipping them forever', () => {
    vi.useFakeTimers();
    setBackendClientFocus('client-a', { selectedTaskId: 'task-1', visibleTaskIds: ['task-1'] });
    expect(getBackendClientSelectedTaskId('client-a')).toBe('task-1');

    vi.advanceTimersByTime(61_000);

    // Any registry read path deletes the expired entry rather than skipping it.
    expect(getBackendWorkPriorityForTask('task-1')).toBe('visible');
    expect(getBackendClientSelectedTaskId('client-a')).toBeNull();
  });

  it('expires focused-channel state on TTL without waiting for another focus mutation', async () => {
    vi.useFakeTimers();
    const focusedChannelListener = vi.fn();
    subscribeBackendClientFocusedChannels(focusedChannelListener);

    setBackendClientFocus('client-a', {
      focusedChannelIds: ['channel-1'],
      selectedTaskId: 'task-1',
      visibleTaskIds: ['task-1'],
    });
    expect([...getAllBackendFocusedChannelIds()]).toEqual(['channel-1']);
    focusedChannelListener.mockClear();

    await vi.advanceTimersByTimeAsync(60_001);

    expect(getBackendClientSelectedTaskId('client-a')).toBeNull();
    expect(getBackendClientFocusedChannelIds('client-a').size).toBe(0);
    expect(getAllBackendFocusedChannelIds().size).toBe(0);
    expect(focusedChannelListener).toHaveBeenCalledTimes(1);
  });

  it('retains reported focusedChannelIds for downstream channel-priority consumers', () => {
    setBackendClientFocus('client-a', {
      focusedChannelIds: ['channel-1', 'channel-2'],
      selectedTaskId: 'task-1',
      visibleTaskIds: ['task-1'],
    });

    expect([...getBackendClientFocusedChannelIds('client-a')].sort()).toEqual([
      'channel-1',
      'channel-2',
    ]);
    expect(getBackendClientFocusedChannelIds('client-missing').size).toBe(0);

    setBackendClientFocus('client-a', { selectedTaskId: 'task-1', visibleTaskIds: ['task-1'] });
    expect(getBackendClientFocusedChannelIds('client-a').size).toBe(0);
  });

  it('reprioritizes focus-derived pending jobs when focus changes', async () => {
    process.env.PARALLEL_CODE_BACKEND_WORK_CONCURRENCY = '1';
    setBackendClientFocus('client-a', { selectedTaskId: 'task-other', visibleTaskIds: [] });
    const gate = createDeferred();
    const order: string[] = [];

    const blocker = enqueueBackendWork(
      { key: 'job:blocker', priority: 'interactive' },
      async () => {
        await gate.promise;
      },
    );
    await flushResolvedPromises();

    const backgrounded = enqueueBackendWork({ key: 'job:task-1', taskId: 'task-1' }, () => {
      order.push('task-1');
    });
    const visibleJob = enqueueBackendWork({ key: 'job:other-visible', priority: 'visible' }, () => {
      order.push('other-visible');
    });

    expect(getBackendWorkQueueDiagnostics().pendingByClass.background).toBe(1);

    setBackendClientFocus('client-a', { selectedTaskId: 'task-1', visibleTaskIds: ['task-1'] });
    expect(getBackendWorkQueueDiagnostics().pendingByClass.selected).toBe(1);

    gate.resolve();
    await Promise.all([blocker, backgrounded, visibleJob]);

    expect(order).toEqual(['task-1', 'other-visible']);
  });

  it('gates background work until release and keeps it single-file behind idle lanes', async () => {
    setBackendClientFocus('client-a', { selectedTaskId: 'task-selected', visibleTaskIds: [] });
    const runs: string[] = [];

    const backgroundJob = enqueueBackendWork(
      { key: 'job:background', priority: 'background' },
      () => {
        runs.push('background');
      },
    );
    await flushResolvedPromises();
    expect(runs).toEqual([]);

    releaseBackendBackgroundWork();
    await backgroundJob;
    expect(runs).toEqual(['background']);

    const gate = createDeferred();
    const higher = enqueueBackendWork({ key: 'job:higher', priority: 'selected' }, async () => {
      await gate.promise;
    });
    await flushResolvedPromises();

    const laterBackground = enqueueBackendWork(
      { key: 'job:background-2', priority: 'background' },
      () => {
        runs.push('background-2');
      },
    );
    await flushResolvedPromises();
    expect(runs).toEqual(['background']);

    gate.resolve();
    await Promise.all([higher, laterBackground]);
    expect(runs).toEqual(['background', 'background-2']);
  });

  it('promotes aged background jobs so they cannot starve forever', async () => {
    vi.useFakeTimers();
    const runs = vi.fn();

    const job = enqueueBackendWork({ key: 'job:aged', priority: 'background' }, () => {
      runs();
    });
    expect(getBackendWorkQueueDiagnostics().pendingByClass.background).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await job;

    expect(runs).toHaveBeenCalledTimes(1);
  });

  it('starts the background reconciliation sweep after release, one task at a time', async () => {
    vi.useFakeTimers();
    const swept: string[] = [];

    scheduleBackgroundReconciliation(['task-1', 'task-2'], async (taskId) => {
      swept.push(taskId);
    });
    releaseBackendBackgroundWork();

    await vi.advanceTimersByTimeAsync(14_000);
    expect(swept).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(swept).toEqual(['task-1', 'task-2']);
  });

  it('isolates job failures from the rest of the lane', async () => {
    const failing = enqueueBackendWork({ key: 'job:fails', priority: 'visible' }, () => {
      throw new Error('job failed');
    });
    const following = enqueueBackendWork({ key: 'job:follows', priority: 'visible' }, () => 'ok');

    await expect(failing).rejects.toThrow('job failed');
    await expect(following).resolves.toBe('ok');
    expect(getBackendWorkQueueDiagnostics()).toMatchObject({ completed: 2, running: 0 });
  });

  it('resets module state through the test seam', async () => {
    setBackendClientFocus('client-a', { selectedTaskId: 'task-1', visibleTaskIds: [] });
    releaseBackendBackgroundWork();
    scheduleBackgroundReconciliation(['task-1'], async () => {});

    resetBackendWorkQueueForTests();

    expect(getBackendWorkPriorityForTask('task-1')).toBe('visible');
    expect(getBackendWorkQueueDiagnostics()).toMatchObject({
      completed: 0,
      pendingByClass: { background: 0, interactive: 0, selected: 0, visible: 0 },
    });

    const backgroundJob = enqueueBackendWork({ key: 'job:gated', priority: 'background' }, () =>
      Promise.resolve('ran'),
    );
    await flushResolvedPromises();
    expect(getBackendWorkQueueDiagnostics().pendingByClass.background).toBe(1);
    releaseBackendBackgroundWork();
    await expect(backgroundJob).resolves.toBe('ran');
  });
});
