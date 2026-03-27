import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activateTerminalSwitchEchoGrace,
  beginTerminalSwitchEchoGrace,
  completeTerminalSwitchEchoGrace,
  getTerminalSwitchEchoGraceSnapshot,
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

    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        targetTaskId: 'task-1',
      }),
    );

    activateTerminalSwitchEchoGrace('task-1');

    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );

    vi.advanceTimersByTime(45);
    completeTerminalSwitchEchoGrace('task-1');

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

  it('times out the active grace when it expires', () => {
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
