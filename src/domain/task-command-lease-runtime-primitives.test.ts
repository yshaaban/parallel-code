import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearOptionalInterval,
  clearOptionalTimeout,
  isTaskAndTransportAttemptCurrent,
  isTransportAttemptCurrent,
} from './task-command-lease-runtime-primitives';

describe('task command lease runtime primitives', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('clears interval timers and returns undefined', () => {
    vi.useFakeTimers();
    const timer = globalThis.setInterval(() => {}, 1_000);

    expect(clearOptionalInterval(timer)).toBeUndefined();
  });

  it('clears timeout timers and returns undefined', () => {
    vi.useFakeTimers();
    const timer = globalThis.setTimeout(() => {}, 1_000);

    expect(clearOptionalTimeout(timer)).toBeUndefined();
  });

  it('treats transport attempts as current only when the transport is still available and unchanged', () => {
    expect(isTransportAttemptCurrent(3, 3, true)).toBe(true);
    expect(isTransportAttemptCurrent(4, 3, true)).toBe(false);
    expect(isTransportAttemptCurrent(3, 3, false)).toBe(false);
  });

  it('treats task attempts as current only when both task and transport generations still match', () => {
    expect(
      isTaskAndTransportAttemptCurrent(
        5,
        7,
        {
          taskGeneration: 5,
          transportGeneration: 7,
        },
        true,
      ),
    ).toBe(true);

    expect(
      isTaskAndTransportAttemptCurrent(
        6,
        7,
        {
          taskGeneration: 5,
          transportGeneration: 7,
        },
        true,
      ),
    ).toBe(false);

    expect(
      isTaskAndTransportAttemptCurrent(
        5,
        8,
        {
          taskGeneration: 5,
          transportGeneration: 7,
        },
        true,
      ),
    ).toBe(false);

    expect(
      isTaskAndTransportAttemptCurrent(
        5,
        7,
        {
          taskGeneration: 5,
          transportGeneration: 7,
        },
        false,
      ),
    ).toBe(false);
  });
});
