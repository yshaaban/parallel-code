import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  scheduleTerminalStartupTask,
  yieldTerminalStartupTask,
} from './terminal-startup-task-scheduler';

describe('terminal-startup-task-scheduler', () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { scheduler?: unknown }).scheduler;
    vi.unstubAllGlobals();
  });

  it('uses scheduler.postTask with role priority when enabled', async () => {
    const postTask = vi.fn(async (callback: () => string) => callback());
    (globalThis as typeof globalThis & { scheduler?: unknown }).scheduler = {
      postTask,
    };

    const result = await scheduleTerminalStartupTask('hidden', 'post-task', () => 'done');

    expect(result).toEqual({
      outcome: 'scheduler-post-task',
      value: 'done',
    });
    expect(postTask).toHaveBeenCalledWith(expect.any(Function), { priority: 'background' });
  });

  it('falls back to scheduler.yield when postTask is unavailable', async () => {
    const schedulerYield = vi.fn(async () => undefined);
    (globalThis as typeof globalThis & { scheduler?: unknown }).scheduler = {
      yield: schedulerYield,
    };

    const result = await scheduleTerminalStartupTask('visible-sibling', 'post-task', () => 7);

    expect(result).toEqual({
      outcome: 'scheduler-yield',
      value: 7,
    });
    expect(schedulerYield).toHaveBeenCalledTimes(1);
  });

  it('uses scheduler.yield in yield-only mode', async () => {
    const schedulerYield = vi.fn(async () => undefined);
    (globalThis as typeof globalThis & { scheduler?: unknown }).scheduler = {
      yield: schedulerYield,
    };

    const result = await yieldTerminalStartupTask({
      mode: 'yield-only',
      role: 'visible-sibling',
      useTimeoutFallback: false,
    });

    expect(result).toBe('scheduler-yield');
    expect(schedulerYield).toHaveBeenCalledTimes(1);
  });

  it('falls back to requestAnimationFrame for visible work when scheduling is off', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const result = await yieldTerminalStartupTask({
      mode: 'off',
      role: 'visible-sibling',
      useTimeoutFallback: false,
    });

    expect(result).toBe('fallback-animation-frame');
  });

  it('falls back to timeout for hidden work when scheduling is off', async () => {
    vi.useFakeTimers();

    const resultPromise = yieldTerminalStartupTask({
      mode: 'off',
      role: 'hidden',
      useTimeoutFallback: true,
    });
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toBe('fallback-timeout');

    vi.useRealTimers();
  });
});
