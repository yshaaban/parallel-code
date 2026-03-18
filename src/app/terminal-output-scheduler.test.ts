import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerTerminalOutputCandidate,
  resetTerminalOutputSchedulerForTests,
} from './terminal-output-scheduler';

describe('terminal-output-scheduler', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  let animationFrameCallbacks: Array<FrameRequestCallback | undefined> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    animationFrameCallbacks = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length - 1;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        animationFrameCallbacks[id] = undefined;
      }),
    );
    resetTerminalOutputSchedulerForTests();
  });

  afterEach(() => {
    resetTerminalOutputSchedulerForTests();
    vi.useRealTimers();
    animationFrameCallbacks = [];
    vi.unstubAllGlobals();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  function runAnimationFrame(index = 0): void {
    const callback = animationFrameCallbacks[index];
    if (!callback) {
      throw new Error(`Expected animation frame callback at index ${index}`);
    }

    callback(16);
  }

  it('drains focused terminal output before background output in the same frame', () => {
    const drainOrder: string[] = [];
    let focusedPendingBytes = 4_096;
    let backgroundPendingBytes = 4_096;

    const focused = registerTerminalOutputCandidate(
      'focused-terminal',
      () => 'focused',
      () => focusedPendingBytes,
      () => {
        drainOrder.push('focused');
        focusedPendingBytes = 0;
        return 4_096;
      },
    );
    const background = registerTerminalOutputCandidate(
      'background-terminal',
      () => 'visible-background',
      () => backgroundPendingBytes,
      () => {
        drainOrder.push('background');
        backgroundPendingBytes = 0;
        return 4_096;
      },
    );

    background.requestDrain();
    focused.requestDrain();
    vi.runOnlyPendingTimers();

    expect(drainOrder).toEqual(['focused', 'background']);

    focused.unregister();
    background.unregister();
  });

  it('uses the slower timeout lane when only hidden terminals have pending output', () => {
    let drainedBytes = 0;

    const hidden = registerTerminalOutputCandidate(
      'hidden-terminal',
      () => 'hidden',
      () => (drainedBytes === 0 ? 2_048 : 0),
      () => {
        drainedBytes = 2_048;
        return drainedBytes;
      },
    );

    hidden.requestDrain();
    expect(animationFrameCallbacks.filter(Boolean)).toHaveLength(0);

    vi.advanceTimersByTime(47);
    expect(drainedBytes).toBe(0);

    vi.advanceTimersByTime(1);
    expect(drainedBytes).toBe(2_048);

    hidden.unregister();
  });

  it('uses the animation-frame lane when visible terminals have pending output', () => {
    let drainedBytes = 0;

    const visible = registerTerminalOutputCandidate(
      'visible-terminal',
      () => 'active-visible',
      () => (drainedBytes === 0 ? 2_048 : 0),
      () => {
        drainedBytes = 2_048;
        return drainedBytes;
      },
    );

    visible.requestDrain();
    expect(animationFrameCallbacks.filter(Boolean)).toHaveLength(1);
    expect(drainedBytes).toBe(0);

    runAnimationFrame();
    expect(drainedBytes).toBe(2_048);

    visible.unregister();
  });

  it('preempts a hidden drain when focused output becomes pending', () => {
    const drainOrder: string[] = [];
    let hiddenPendingBytes = 2_048;
    let focusedPendingBytes = 1_024;

    const hidden = registerTerminalOutputCandidate(
      'hidden-terminal',
      () => 'hidden',
      () => hiddenPendingBytes,
      () => {
        drainOrder.push('hidden');
        hiddenPendingBytes = 0;
        return 2_048;
      },
    );
    const focused = registerTerminalOutputCandidate(
      'focused-terminal',
      () => 'focused',
      () => focusedPendingBytes,
      () => {
        drainOrder.push('focused');
        focusedPendingBytes = 0;
        return 1_024;
      },
    );

    hidden.requestDrain();
    vi.advanceTimersByTime(10);

    focused.requestDrain();
    vi.runOnlyPendingTimers();

    expect(drainOrder[0]).toBe('focused');

    hidden.unregister();
    focused.unregister();
  });

  it('rotates focused terminals so one noisy candidate cannot monopolize the lane', () => {
    const drainOrder: string[] = [];
    let firstPendingBytes = 192 * 1024;
    let secondPendingBytes = 192 * 1024;

    const first = registerTerminalOutputCandidate(
      'focused-a',
      () => 'focused',
      () => firstPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, firstPendingBytes);
        drainOrder.push(`focused-a:${drainedBytes}`);
        firstPendingBytes -= drainedBytes;
        return drainedBytes;
      },
    );
    const second = registerTerminalOutputCandidate(
      'focused-b',
      () => 'focused',
      () => secondPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, secondPendingBytes);
        drainOrder.push(`focused-b:${drainedBytes}`);
        secondPendingBytes -= drainedBytes;
        return drainedBytes;
      },
    );

    first.requestDrain();
    second.requestDrain();
    vi.runOnlyPendingTimers();
    vi.runOnlyPendingTimers();

    expect(drainOrder.slice(0, 2)).toEqual([`focused-a:${96 * 1024}`, `focused-b:${96 * 1024}`]);

    first.unregister();
    second.unregister();
  });
});
