import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEffect, createRoot } from 'solid-js';
import {
  clearPendingSessionInput,
  clearPendingSessionInputForTask,
  enqueuePendingSessionInput,
  getPendingSessionInputCount,
  resetPendingSessionInputForTests,
  takePendingSessionInput,
} from './terminal-pending-session-input';

const KEY = 'task-1:agent-1';

describe('terminal-pending-session-input', () => {
  beforeEach(() => {
    resetPendingSessionInputForTests();
  });

  afterEach(() => {
    resetPendingSessionInputForTests();
  });

  it('drains enqueued chunks in order as one string', () => {
    expect(enqueuePendingSessionInput(KEY, 'a', 1_000)).toBe(true);
    expect(enqueuePendingSessionInput(KEY, 'b', 1_001)).toBe(true);
    expect(enqueuePendingSessionInput(KEY, '\r', 1_002)).toBe(true);

    expect(takePendingSessionInput(KEY, 1_500)).toBe('ab\r');
    expect(takePendingSessionInput(KEY, 1_500)).toBeNull();
  });

  it('keeps queues isolated per terminal startup key', () => {
    enqueuePendingSessionInput('task-1:agent-1', 'first', 1_000);
    enqueuePendingSessionInput('task-2:agent-2', 'second', 1_000);

    expect(takePendingSessionInput('task-1:agent-1', 1_000)).toBe('first');
    expect(takePendingSessionInput('task-2:agent-2', 1_000)).toBe('second');
  });

  it('rejects input past the byte cap and keeps the existing queue intact', () => {
    expect(enqueuePendingSessionInput(KEY, 'x'.repeat(4_000), 1_000)).toBe(true);
    expect(enqueuePendingSessionInput(KEY, 'y'.repeat(200), 1_001)).toBe(false);
    expect(enqueuePendingSessionInput(KEY, 'z'.repeat(96), 1_002)).toBe(true);

    expect(takePendingSessionInput(KEY, 1_500)).toBe('x'.repeat(4_000) + 'z'.repeat(96));
  });

  it('counts multibyte input in bytes, not characters', () => {
    expect(enqueuePendingSessionInput(KEY, '€'.repeat(1_366), 1_000)).toBe(false);
    expect(enqueuePendingSessionInput(KEY, '€'.repeat(1_365), 1_000)).toBe(true);
  });

  it('drops entries that are older than the drain TTL instead of misrouting them', () => {
    enqueuePendingSessionInput(KEY, 'stale', 1_000);

    expect(takePendingSessionInput(KEY, 1_000 + 30_001)).toBeNull();
    expect(getPendingSessionInputCount(KEY, 1_000 + 30_001)).toBe(0);
  });

  it('does not revive stale buffered keys when new preready input arrives later', () => {
    enqueuePendingSessionInput(KEY, 'stale', 1_000);
    expect(enqueuePendingSessionInput(KEY, 'fresh', 1_000 + 30_001)).toBe(true);

    expect(takePendingSessionInput(KEY, 1_000 + 30_002)).toBe('fresh');
  });

  it('keeps entries alive exactly through the TTL window', () => {
    enqueuePendingSessionInput(KEY, 'fresh', 1_000);

    expect(takePendingSessionInput(KEY, 1_000 + 30_000)).toBe('fresh');
  });

  it('drops stale queued-count state when the count is read after the TTL', async () => {
    enqueuePendingSessionInput(KEY, 'stale', 1_000);

    expect(getPendingSessionInputCount(KEY, 1_000 + 30_001)).toBe(0);
    await Promise.resolve();
    expect(getPendingSessionInputCount(KEY, 1_000 + 30_001)).toBe(0);
  });

  it('exposes a reactive per-key count', () => {
    const observed: number[] = [];
    const dispose = createRoot((disposeRoot) => {
      createEffect(() => {
        observed.push(getPendingSessionInputCount(KEY, 1_000));
      });
      return disposeRoot;
    });

    enqueuePendingSessionInput(KEY, 'a', 1_000);
    enqueuePendingSessionInput(KEY, 'b', 1_001);
    takePendingSessionInput(KEY, 1_002);
    dispose();

    expect(observed).toEqual([0, 1, 2, 0]);
  });

  it('clears a single key and all keys for a task', () => {
    enqueuePendingSessionInput('task-1:agent-1', 'a', 1_000);
    enqueuePendingSessionInput('task-1:agent-2', 'b', 1_000);
    enqueuePendingSessionInput('task-10:agent-3', 'c', 1_000);

    clearPendingSessionInput('task-1:agent-1');
    expect(getPendingSessionInputCount('task-1:agent-1', 1_000)).toBe(0);
    expect(getPendingSessionInputCount('task-1:agent-2', 1_000)).toBe(1);

    clearPendingSessionInputForTask('task-1');
    expect(getPendingSessionInputCount('task-1:agent-2', 1_000)).toBe(0);
    expect(getPendingSessionInputCount('task-10:agent-3', 1_000)).toBe(1);
  });

  it('reset seam clears every queue', () => {
    enqueuePendingSessionInput(KEY, 'a', 1_000);
    resetPendingSessionInputForTests();
    expect(getPendingSessionInputCount(KEY, 1_000)).toBe(0);
  });
});
