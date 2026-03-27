import { createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTaskActivityClockForTests, useTaskActivityNow } from './task-activity-clock';

describe('task-activity-clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    resetTaskActivityClockForTests(1_000);
  });

  afterEach(() => {
    resetTaskActivityClockForTests();
    vi.useRealTimers();
  });

  it('ticks at the shared 500ms cadence while subscribed', () => {
    let nowAccessor: ReturnType<typeof useTaskActivityNow> | undefined;
    let dispose!: () => void;

    createRoot((cleanup) => {
      dispose = cleanup;
      nowAccessor = useTaskActivityNow();
    });

    expect(nowAccessor?.()).toBe(1_000);

    vi.advanceTimersByTime(499);
    expect(nowAccessor?.()).toBe(1_000);

    vi.advanceTimersByTime(1);
    expect(nowAccessor?.()).toBe(1_500);

    dispose();
  });

  it('stops ticking after the last subscriber cleans up', () => {
    let nowAccessor: ReturnType<typeof useTaskActivityNow> | undefined;
    let dispose!: () => void;

    createRoot((cleanup) => {
      dispose = cleanup;
      nowAccessor = useTaskActivityNow();
    });

    vi.advanceTimersByTime(500);
    expect(nowAccessor?.()).toBe(1_500);

    dispose();

    vi.advanceTimersByTime(1_000);
    expect(nowAccessor?.()).toBe(1_500);
  });
});
