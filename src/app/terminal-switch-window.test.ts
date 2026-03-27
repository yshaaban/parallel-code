import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginTerminalSwitchWindow,
  cancelTerminalSwitchWindow,
  completeTerminalSwitchWindow,
  getTerminalSwitchWindowSnapshot,
  isTerminalSwitchTarget,
  isTerminalSwitchWindowOwner,
  markTerminalSwitchWindowFirstPaint,
  markTerminalSwitchWindowInputReady,
  resetTerminalSwitchWindowForTests,
} from './terminal-switch-window';

describe('terminal-switch-window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTerminalSwitchWindowForTests();
  });

  afterEach(() => {
    resetTerminalSwitchWindowForTests();
    vi.useRealTimers();
  });

  it('tracks the active target and completion metadata', () => {
    beginTerminalSwitchWindow('task-1', 250);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        phase: 'first-paint-pending',
        targetTaskId: 'task-1',
      }),
    );

    vi.advanceTimersByTime(75);
    markTerminalSwitchWindowFirstPaint('task-1');
    completeTerminalSwitchWindow('task-1');

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          firstPaintDurationMs: expect.any(Number),
          reason: 'completed',
          taskId: 'task-1',
        }),
      }),
    );
  });

  it('records first paint separately from input-ready completion', () => {
    beginTerminalSwitchWindow('task-3', 250);
    vi.advanceTimersByTime(30);
    markTerminalSwitchWindowFirstPaint('task-3');

    const pendingSnapshot = getTerminalSwitchWindowSnapshot();
    expect(pendingSnapshot).toEqual(
      expect.objectContaining({
        active: true,
        phase: 'input-ready-pending',
        targetTaskId: 'task-3',
      }),
    );
    expect(pendingSnapshot.firstPaintDurationMs).toBeGreaterThanOrEqual(30);

    vi.advanceTimersByTime(20);
    markTerminalSwitchWindowInputReady('task-3');

    const completedSnapshot = getTerminalSwitchWindowSnapshot();
    expect(completedSnapshot).toEqual(
      expect.objectContaining({
        active: false,
        phase: 'inactive',
      }),
    );
    expect(completedSnapshot.lastCompletion).toEqual(
      expect.objectContaining({
        durationMs: expect.any(Number),
        firstPaintDurationMs: expect.any(Number),
        inputReadyDurationMs: expect.any(Number),
        reason: 'completed',
        taskId: 'task-3',
      }),
    );
    expect(completedSnapshot.lastCompletion?.durationMs ?? 0).toBeGreaterThanOrEqual(50);
    expect(completedSnapshot.lastCompletion?.firstPaintDurationMs ?? 0).toBeGreaterThanOrEqual(30);
    expect(completedSnapshot.lastCompletion?.inputReadyDurationMs ?? 0).toBeGreaterThanOrEqual(50);
  });

  it('treats input-ready as first paint when completion is recorded directly', () => {
    beginTerminalSwitchWindow('task-3', 250);
    vi.advanceTimersByTime(35);
    markTerminalSwitchWindowInputReady('task-3');

    const completedSnapshot = getTerminalSwitchWindowSnapshot();
    expect(completedSnapshot).toEqual(
      expect.objectContaining({
        active: false,
        phase: 'inactive',
      }),
    );
    expect(completedSnapshot.lastCompletion).toEqual(
      expect.objectContaining({
        firstPaintDurationMs: expect.any(Number),
        inputReadyDurationMs: expect.any(Number),
        reason: 'completed',
        taskId: 'task-3',
      }),
    );
    expect(completedSnapshot.lastCompletion?.firstPaintDurationMs).toBe(
      completedSnapshot.lastCompletion?.inputReadyDurationMs,
    );
  });

  it('keeps the switch window active in a settled phase after input-ready when a settle delay is configured', () => {
    beginTerminalSwitchWindow('task-4', 250, 40);
    vi.advanceTimersByTime(25);
    markTerminalSwitchWindowFirstPaint('task-4');
    vi.advanceTimersByTime(15);
    markTerminalSwitchWindowInputReady('task-4');

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        inputReadyDurationMs: expect.any(Number),
        phase: 'settled-pending',
        targetTaskId: 'task-4',
      }),
    );

    vi.advanceTimersByTime(40);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          inputReadyDurationMs: expect.any(Number),
          reason: 'completed',
          taskId: 'task-4',
        }),
      }),
    );
  });

  it('times out the active window when it expires', () => {
    beginTerminalSwitchWindow('task-2', 100);

    vi.advanceTimersByTime(100);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'timed-out',
          taskId: 'task-2',
        }),
      }),
    );
  });

  it('records replacement when a new target starts before the old one completes', () => {
    beginTerminalSwitchWindow('task-1', 250);
    vi.advanceTimersByTime(25);
    beginTerminalSwitchWindow('task-2', 250);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        lastCompletion: expect.objectContaining({
          reason: 'replaced',
          taskId: 'task-1',
        }),
        targetTaskId: 'task-2',
      }),
    );
  });

  it('refreshes the active timeout when the same task begins again', () => {
    beginTerminalSwitchWindow('task-1', 100, 0, 'visible-owner', 1);

    vi.advanceTimersByTime(90);
    beginTerminalSwitchWindow('task-1', 100, 0, 'visible-owner', 1);

    vi.advanceTimersByTime(20);
    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        phase: 'first-paint-pending',
        targetTaskId: 'task-1',
      }),
    );

    vi.advanceTimersByTime(80);
    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'timed-out',
          taskId: 'task-1',
        }),
      }),
    );
  });

  it('keeps a single active owner per task and ignores non-owner mutation attempts', () => {
    beginTerminalSwitchWindow('task-1', 250, 0, 'visible-owner', 1);

    expect(isTerminalSwitchWindowOwner('task-1', 'visible-owner')).toBe(true);

    beginTerminalSwitchWindow('task-1', 250, 0, 'focused-owner', 2);

    expect(isTerminalSwitchWindowOwner('task-1', 'visible-owner')).toBe(false);
    expect(isTerminalSwitchWindowOwner('task-1', 'focused-owner')).toBe(true);

    cancelTerminalSwitchWindow('task-1', 'visible-owner');

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );

    markTerminalSwitchWindowFirstPaint('task-1', 'visible-owner');
    expect(getTerminalSwitchWindowSnapshot().firstPaintDurationMs).toBeNull();

    markTerminalSwitchWindowFirstPaint('task-1', 'focused-owner');
    expect(getTerminalSwitchWindowSnapshot().firstPaintDurationMs).toEqual(expect.any(Number));

    cancelTerminalSwitchWindow('task-1', 'focused-owner');

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'cancelled',
          taskId: 'task-1',
        }),
      }),
    );
  });

  it('tracks the active switch target by owner identity, not just task identity', () => {
    beginTerminalSwitchWindow('task-1', 250, 0, 'visible-owner', 1);

    expect(isTerminalSwitchTarget('task-1')).toBe(true);
    expect(isTerminalSwitchTarget('task-1', 'visible-owner')).toBe(true);
    expect(isTerminalSwitchTarget('task-1', 'sibling-owner')).toBe(false);

    beginTerminalSwitchWindow('task-1', 250, 0, 'focused-owner', 2);

    expect(isTerminalSwitchTarget('task-1')).toBe(true);
    expect(isTerminalSwitchTarget('task-1', 'visible-owner')).toBe(false);
    expect(isTerminalSwitchTarget('task-1', 'focused-owner')).toBe(true);
  });
});
