import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCoordinatorPersistenceScheduler } from './persistence-scheduler.js';

describe('coordinator persistence scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a 50-event burst into exactly one trailing save', async () => {
    const save = vi.fn(async () => {});
    const scheduler = createCoordinatorPersistenceScheduler({ save });

    for (let index = 0; index < 50; index += 1) {
      scheduler.schedulePersist();
      await vi.advanceTimersByTimeAsync(1);
    }

    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);
    expect(scheduler.getHealth()).toMatchObject({ degraded: false, pendingFlush: false });
    await scheduler.stop();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('bounds a sustained event stream by the max save interval', async () => {
    const save = vi.fn(async () => {});
    const scheduler = createCoordinatorPersistenceScheduler({ save });

    // Events every 100ms for 10s: trailing debounce alone would never fire,
    // the 2s max-interval bound forces roughly one save per window.
    for (let elapsedMs = 0; elapsedMs < 10_000; elapsedMs += 100) {
      scheduler.schedulePersist();
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(300);

    expect(save.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(save.mock.calls.length).toBeLessThanOrEqual(7);
    await scheduler.stop();
  });

  it('reports degraded health on failure, retries with backoff, and recovers', async () => {
    let failuresRemaining = 2;
    const save = vi.fn(async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error('disk full');
      }
    });
    const scheduler = createCoordinatorPersistenceScheduler({ save });

    scheduler.schedulePersist();
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);
    expect(scheduler.getHealth()).toMatchObject({
      degraded: true,
      lastError: 'disk full',
      pendingFlush: true,
    });

    // First retry after 1s backoff fails again.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(save).toHaveBeenCalledTimes(2);
    expect(scheduler.getHealth().degraded).toBe(true);

    // Second retry (5s backoff) succeeds and clears degraded health.
    await vi.advanceTimersByTimeAsync(5_100);
    expect(save).toHaveBeenCalledTimes(3);
    expect(scheduler.getHealth()).toMatchObject({ degraded: false, pendingFlush: false });
    expect(scheduler.getHealth().lastSuccessAt).not.toBeNull();
    await scheduler.stop();
  });

  it('flushNow persists immediately and propagates save failures to the caller', async () => {
    const saved: number[] = [];
    let shouldFail = false;
    const scheduler = createCoordinatorPersistenceScheduler({
      save: async () => {
        if (shouldFail) {
          throw new Error('flush failed');
        }
        saved.push(Date.now());
      },
    });

    scheduler.schedulePersist();
    await scheduler.flushNow();
    expect(saved).toHaveLength(1);
    expect(scheduler.getHealth().pendingFlush).toBe(false);

    shouldFail = true;
    await expect(scheduler.flushNow()).rejects.toThrow('flush failed');
    expect(scheduler.getHealth().degraded).toBe(true);
    shouldFail = false;
    await scheduler.stop();
  });

  it('stop flushes the pending write and rejects later schedules', async () => {
    const save = vi.fn(async () => {});
    const scheduler = createCoordinatorPersistenceScheduler({ save });

    scheduler.schedulePersist();
    await scheduler.stop();
    expect(save).toHaveBeenCalledTimes(1);

    scheduler.schedulePersist();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('queues one final current-state snapshot behind every older write', async () => {
    let releaseFirstSave: () => void = () => {};
    const firstSaveBlocked = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let state = 'before-shutdown';
    const persisted: string[] = [];
    const save = vi.fn(async () => {
      const snapshot = state;
      if (persisted.length === 0) {
        await firstSaveBlocked;
      }
      persisted.push(snapshot);
    });
    const scheduler = createCoordinatorPersistenceScheduler({ save });

    const olderWrite = scheduler.flushNow();
    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });

    state = 'at-shutdown';
    const stop = scheduler.stop();
    expect(scheduler.stop()).toBe(stop);
    expect(scheduler.flushNow()).toBe(stop);
    expect(save).toHaveBeenCalledTimes(1);

    releaseFirstSave();
    await Promise.all([olderWrite, stop]);

    expect(persisted).toEqual(['before-shutdown', 'at-shutdown']);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('always attempts a final snapshot and propagates its failure to every caller', async () => {
    const save = vi.fn(async () => {
      throw new Error('final save failed');
    });
    const scheduler = createCoordinatorPersistenceScheduler({ save });

    const stop = scheduler.stop();

    expect(scheduler.stop()).toBe(stop);
    expect(scheduler.flushNow()).toBe(stop);
    await expect(stop).rejects.toThrow('final save failed');
    expect(save).toHaveBeenCalledOnce();
    expect(scheduler.getHealth()).toMatchObject({
      degraded: true,
      lastError: 'final save failed',
      pendingFlush: false,
    });
  });

  it('serializes saves so a flush never overlaps an in-flight save', async () => {
    let active = 0;
    let maxActive = 0;
    const scheduler = createCoordinatorPersistenceScheduler({
      save: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active -= 1;
      },
    });

    const firstFlush = scheduler.flushNow();
    const secondFlush = scheduler.flushNow();
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([firstFlush, secondFlush]);
    const stop = scheduler.stop();
    await vi.advanceTimersByTimeAsync(100);
    await stop;

    expect(maxActive).toBe(1);
  });

  it('reports a queued or in-flight save as a pending flush', async () => {
    let releaseSave: () => void = () => {};
    const saveBlocked = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const scheduler = createCoordinatorPersistenceScheduler({
      save: () => saveBlocked,
    });

    const flush = scheduler.flushNow();
    await Promise.resolve();
    expect(scheduler.getHealth().pendingFlush).toBe(true);

    releaseSave();
    await flush;
    expect(scheduler.getHealth().pendingFlush).toBe(false);
  });
});
