import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activateTerminalSwitchEchoGrace,
  beginTerminalSwitchEchoGrace,
  completeTerminalSwitchEchoGrace,
  getTerminalSwitchEchoGraceSnapshot,
  hasTerminalSwitchEchoGraceReservationForTask,
  resetTerminalSwitchEchoGraceForTests,
} from './terminal-switch-echo-grace';

describe('terminal-switch-echo-grace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTerminalSwitchEchoGraceForTests();
  });

  afterEach(() => {
    resetTerminalSwitchEchoGraceForTests();
    vi.useRealTimers();
  });

  it('arms the target at input-ready and only becomes active after local input', () => {
    beginTerminalSwitchEchoGrace('task-1', 120);

    expect(hasTerminalSwitchEchoGraceReservationForTask('task-1')).toBe(true);
    expect(hasTerminalSwitchEchoGraceReservationForTask('task-2')).toBe(false);
    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        targetTaskId: 'task-1',
      }),
    );

    activateTerminalSwitchEchoGrace('task-1');

    expect(hasTerminalSwitchEchoGraceReservationForTask('task-1')).toBe(true);
    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );

    vi.advanceTimersByTime(45);
    completeTerminalSwitchEchoGrace('task-1');

    expect(hasTerminalSwitchEchoGraceReservationForTask('task-1')).toBe(false);
    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          durationMs: expect.any(Number),
          reason: 'completed',
          taskId: 'task-1',
        }),
      }),
    );
  });

  it('times out the pending reservation when no input arrives', () => {
    beginTerminalSwitchEchoGrace('task-2', 100);

    vi.advanceTimersByTime(100);

    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'timed-out',
          taskId: 'task-2',
        }),
      }),
    );
  });

  it('starts the active timeout window when local input arrives', () => {
    beginTerminalSwitchEchoGrace('task-2', 100);
    vi.advanceTimersByTime(75);

    activateTerminalSwitchEchoGrace('task-2');
    vi.advanceTimersByTime(99);

    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        lastCompletion: null,
        targetTaskId: 'task-2',
      }),
    );

    vi.advanceTimersByTime(1);

    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'timed-out',
          taskId: 'task-2',
        }),
        targetTaskId: null,
      }),
    );
  });

  it('times out when the performance API is unavailable', () => {
    const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: undefined,
    });

    try {
      beginTerminalSwitchEchoGrace('task-3', 100);
      vi.advanceTimersByTime(100);

      expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
        expect.objectContaining({
          active: false,
          lastCompletion: expect.objectContaining({
            reason: 'timed-out',
            taskId: 'task-3',
          }),
        }),
      );
    } finally {
      if (performanceDescriptor) {
        Object.defineProperty(globalThis, 'performance', performanceDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'performance');
      }
    }
  });

  it('records replacement when a new target starts before the old grace completes', () => {
    beginTerminalSwitchEchoGrace('task-1', 120);
    vi.advanceTimersByTime(25);
    beginTerminalSwitchEchoGrace('task-2', 120);

    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'replaced',
          taskId: 'task-1',
        }),
        targetTaskId: 'task-2',
      }),
    );
  });
});
