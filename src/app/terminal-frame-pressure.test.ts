import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setStore } from '../store/core';
import { syncTerminalHighLoadMode } from './terminal-high-load-mode';
import {
  getTerminalFramePressureLevel,
  resetTerminalFramePressureForTests,
  setTerminalFramePressureLevelForTests,
  subscribeTerminalFramePressureChanges,
} from './terminal-frame-pressure';
import { resetTerminalPerformanceExperimentConfigForTests } from '../lib/terminal-performance-experiments';

describe('terminal-frame-pressure', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  let animationFrameCallbacks: FrameRequestCallback[] = [];

  function setTerminalHighLoadModeForTest(enabled: boolean): void {
    setStore('terminalHighLoadMode', enabled);
    syncTerminalHighLoadMode(enabled);
  }

  beforeEach(() => {
    animationFrameCallbacks = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
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
        animationFrameCallbacks[id] = () => undefined;
      }),
    );
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalFramePressureForTests();
    setTerminalHighLoadModeForTest(false);
  });

  afterEach(() => {
    resetTerminalFramePressureForTests();
    resetTerminalPerformanceExperimentConfigForTests();
    vi.unstubAllGlobals();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    Reflect.deleteProperty(globalThis, 'window');
  });

  function runNextAnimationFrame(frameTimeMs: number): void {
    const callback = animationFrameCallbacks.shift();
    if (!callback) {
      throw new Error('Expected a pending frame-pressure animation frame');
    }

    callback(frameTimeMs);
  }

  it('stays stable and does not install monitoring when adaptive throttling is disabled', () => {
    expect(getTerminalFramePressureLevel()).toBe('stable');
    expect(animationFrameCallbacks).toHaveLength(0);
  });

  it('derives frame pressure levels from recent frame gaps when monitoring is enabled', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      adaptiveVisibleBackgroundThrottleMode: 'moderate',
    };
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalFramePressureLevel()).toBe('stable');
    expect(animationFrameCallbacks).toHaveLength(1);

    runNextAnimationFrame(16);
    expect(getTerminalFramePressureLevel()).toBe('stable');

    runNextAnimationFrame(40);
    expect(getTerminalFramePressureLevel()).toBe('elevated');

    runNextAnimationFrame(90);
    expect(getTerminalFramePressureLevel()).toBe('critical');
  });

  it('installs monitoring when adaptive active-visible throttling is enabled', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      adaptiveActiveVisibleThrottleMode: 'moderate',
    };
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalFramePressureLevel()).toBe('stable');
    expect(animationFrameCallbacks).toHaveLength(1);
  });

  it('installs monitoring when multi-visible pressure scaling is enabled', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      multiVisiblePressureNonTargetVisibleFrameBudgetScales: {
        elevated: 0.5,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalFramePressureLevel()).toBe('stable');
    expect(animationFrameCallbacks).toHaveLength(1);
  });

  it('does not install monitoring for dense overload while high load mode is disabled', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
    };
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalFramePressureLevel()).toBe('stable');
    expect(animationFrameCallbacks).toHaveLength(0);
  });

  it('installs monitoring for dense overload once high load mode is enabled', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);

    expect(getTerminalFramePressureLevel()).toBe('stable');
    expect(animationFrameCallbacks).toHaveLength(1);
  });

  it('installs monitoring for the built-in high load mode profile when enabled', () => {
    setTerminalHighLoadModeForTest(true);
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalFramePressureLevel()).toBe('stable');
    expect(animationFrameCallbacks).toHaveLength(1);
  });

  it('installs monitoring for the built-in high load mode profile without injected experiments', () => {
    setTerminalHighLoadModeForTest(true);

    expect(getTerminalFramePressureLevel()).toBe('stable');
    expect(animationFrameCallbacks).toHaveLength(1);
  });

  it('notifies listeners when the frame pressure level changes', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      adaptiveVisibleBackgroundThrottleMode: 'moderate',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    getTerminalFramePressureLevel();
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalFramePressureChanges(listener);

    runNextAnimationFrame(16);
    expect(listener).not.toHaveBeenCalled();

    runNextAnimationFrame(40);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('allows tests to override the measured frame pressure level', () => {
    setTerminalFramePressureLevelForTests('critical');
    expect(getTerminalFramePressureLevel()).toBe('critical');

    setTerminalFramePressureLevelForTests('stable');
    expect(getTerminalFramePressureLevel()).toBe('stable');
  });
});
