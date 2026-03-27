import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from './runtime-diagnostics';
import {
  resetTerminalFramePressureForTests,
  setTerminalFramePressureLevelForTests,
} from './terminal-frame-pressure';
import {
  activateTerminalSwitchEchoGrace,
  beginTerminalSwitchEchoGrace,
  resetTerminalSwitchEchoGraceForTests,
} from './terminal-switch-echo-grace';
import {
  noteTerminalFocusedInput,
  resetTerminalFocusedInputForTests,
  settleTerminalFocusedInput,
} from './terminal-focused-input';
import {
  beginTerminalSwitchWindow,
  markTerminalSwitchWindowFirstPaint,
  markTerminalSwitchWindowInputReady,
  markTerminalSwitchWindowRecoverySettled,
  markTerminalSwitchWindowRecoveryStarted,
  resetTerminalSwitchWindowForTests,
} from './terminal-switch-window';
import { syncTerminalHighLoadMode } from './terminal-high-load-mode';

import {
  armFocusedTerminalOutputPreemption,
  registerTerminalOutputCandidate,
  requestTerminalOutputDrain,
  resetTerminalOutputSchedulerForTests,
} from './terminal-output-scheduler';
import {
  registerTerminalVisibility,
  resetTerminalVisibleSetForTests,
} from './terminal-visible-set';
import { resetTerminalPerformanceExperimentConfigForTests } from '../lib/terminal-performance-experiments';
import { setStore } from '../store/core';

describe('terminal-output-scheduler', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalPerformance = globalThis.performance;
  let animationFrameCallbacks: Array<FrameRequestCallback | undefined> = [];

  function setTerminalHighLoadModeForTest(enabled: boolean): void {
    setStore('terminalHighLoadMode', enabled);
    syncTerminalHighLoadMode(enabled);
  }

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
    vi.stubGlobal('performance', {
      now: (() => {
        let now = 0;
        return () => {
          now += 1;
          return now;
        };
      })(),
    } as Performance);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      },
    });
    resetRendererRuntimeDiagnostics();
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalFramePressureForTests();
    resetTerminalOutputSchedulerForTests();
    resetTerminalSwitchEchoGraceForTests();
    resetTerminalFocusedInputForTests();
    resetTerminalSwitchWindowForTests();
    resetTerminalVisibleSetForTests();
    setTerminalHighLoadModeForTest(false);
  });

  afterEach(() => {
    resetTerminalOutputSchedulerForTests();
    resetRendererRuntimeDiagnostics();
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalFramePressureForTests();
    resetTerminalVisibleSetForTests();
    resetTerminalSwitchEchoGraceForTests();
    resetTerminalFocusedInputForTests();
    resetTerminalSwitchWindowForTests();
    vi.useRealTimers();
    animationFrameCallbacks = [];
    vi.unstubAllGlobals();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    globalThis.performance = originalPerformance;
    Reflect.deleteProperty(globalThis, 'window');
  });

  function runAnimationFrame(index?: number): void {
    const callbackIndex =
      index ?? animationFrameCallbacks.findIndex((callback) => callback !== undefined);
    const callback = callbackIndex >= 0 ? animationFrameCallbacks[callbackIndex] : undefined;
    if (!callback) {
      throw new Error(`Expected animation frame callback at index ${callbackIndex}`);
    }

    animationFrameCallbacks[callbackIndex] = undefined;
    callback(16);
  }

  function registerVisibleTerminals(
    count: number,
  ): Array<ReturnType<typeof registerTerminalVisibility>> {
    return Array.from({ length: count }, (_, index) =>
      registerTerminalVisibility(`visible-${index}`, {
        isFocused: index === 0,
        isSelected: index === 0,
        isVisible: true,
      }),
    );
  }

  function unregisterVisibleTerminals(
    registrations: ReadonlyArray<ReturnType<typeof registerTerminalVisibility>>,
  ): void {
    for (const registration of registrations) {
      registration.unregister();
    }
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

  it('gives the focused terminal a hard first-echo reservation during dense focused input in High Load Mode', () => {
    setTerminalHighLoadModeForTest(true);
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      label: 'terminal-output-scheduler-dense-focused-input',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');
    const visibleRegistrations = registerVisibleTerminals(4);
    let focusedPendingBytes = 16 * 1024;
    let visibleBackgroundPendingBytes = 16 * 1024;
    let focusedDrainedBytes = 0;
    let visibleBackgroundDrainedBytes = 0;

    noteTerminalFocusedInput('task-focused');

    const focused = registerTerminalOutputCandidate(
      'focused-terminal',
      'task-focused',
      () => 'focused',
      () => focusedPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, focusedPendingBytes);
        focusedPendingBytes -= drainedBytes;
        focusedDrainedBytes += drainedBytes;
        return drainedBytes;
      },
    );
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      'task-visible-background',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, visibleBackgroundPendingBytes);
        visibleBackgroundPendingBytes -= drainedBytes;
        visibleBackgroundDrainedBytes += drainedBytes;
        return drainedBytes;
      },
    );

    visibleBackground.requestDrain();
    focused.requestDrain();
    vi.runOnlyPendingTimers();

    expect(focusedDrainedBytes).toBe(16 * 1024);
    expect(visibleBackgroundDrainedBytes).toBe(0);

    settleTerminalFocusedInput('task-focused');
    visibleBackground.requestDrain();
    runAnimationFrame();

    expect(visibleBackgroundDrainedBytes).toBeGreaterThan(0);

    focused.unregister();
    visibleBackground.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
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

  it('records scheduler scan and drain counters and resets them', () => {
    let pendingBytes = 4_096;

    const focused = registerTerminalOutputCandidate(
      'focused-terminal',
      () => 'focused',
      () => pendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, pendingBytes);
        pendingBytes -= drainedBytes;
        return drainedBytes;
      },
    );

    focused.requestDrain();
    vi.runOnlyPendingTimers();

    const diagnostics = getRendererRuntimeDiagnosticsSnapshot().terminalOutputScheduler;
    expect(diagnostics.candidatesCurrent).toBe(1);
    expect(diagnostics.candidatesMax).toBe(1);
    expect(diagnostics.drainCalls).toBe(1);
    expect(diagnostics.drainedBytes).toBe(4_096);
    expect(diagnostics.laneSelections.focused).toBe(1);
    expect(diagnostics.rescheduledDrains).toBe(0);
    expect(diagnostics.scanCalls).toBeGreaterThan(0);
    expect(diagnostics.scannedCandidates).toBeGreaterThan(0);
    expect(diagnostics.totalDrainDurationMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.totalScanDurationMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.lastDrainDurationMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.lastScanDurationMs).toBeGreaterThanOrEqual(0);

    resetRendererRuntimeDiagnostics();

    const resetDiagnostics = getRendererRuntimeDiagnosticsSnapshot().terminalOutputScheduler;
    expect(resetDiagnostics).toMatchObject({
      candidatesCurrent: 0,
      candidatesMax: 0,
      drainCalls: 0,
      drainedBytes: 0,
      lastDrainDurationMs: null,
      lastScanDurationMs: null,
      maxDrainDurationMs: 0,
      maxScanDurationMs: 0,
      rescheduledDrains: 0,
      scanCalls: 0,
      scannedCandidates: 0,
      totalDrainDurationMs: 0,
      totalScanDurationMs: 0,
    });
    expect(resetDiagnostics.laneSelections).toEqual({
      focused: 0,
      hidden: 0,
      visible: 0,
    });

    focused.unregister();
  });

  it('keeps focused drain cycles on the focused band during a preemption window', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      focusedPreemptionDrainScope: 'focused',
      focusedPreemptionWindowMs: 400,
    };
    resetTerminalPerformanceExperimentConfigForTests();

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
    armFocusedTerminalOutputPreemption();
    focused.requestDrain();
    vi.runOnlyPendingTimers();

    expect(drainOrder).toEqual(['focused']);

    runAnimationFrame();
    expect(drainOrder).toEqual(['focused', 'background']);

    focused.unregister();
    background.unregister();
  });

  it('can keep active visible drains in the focused preemption window', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      focusedPreemptionDrainScope: 'visible',
      focusedPreemptionWindowMs: 250,
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const drainOrder: string[] = [];
    let focusedPendingBytes = 4_096;
    let activeVisiblePendingBytes = 4_096;
    let hiddenPendingBytes = 4_096;

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
    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      () => {
        drainOrder.push('active-visible');
        activeVisiblePendingBytes = 0;
        return 4_096;
      },
    );
    const hidden = registerTerminalOutputCandidate(
      'hidden-terminal',
      () => 'hidden',
      () => hiddenPendingBytes,
      () => {
        drainOrder.push('hidden');
        hiddenPendingBytes = 0;
        return 4_096;
      },
    );

    hidden.requestDrain();
    activeVisible.requestDrain();
    armFocusedTerminalOutputPreemption();
    focused.requestDrain();
    vi.runOnlyPendingTimers();

    expect(drainOrder).toEqual(['focused', 'active-visible']);

    vi.advanceTimersByTime(48);
    expect(drainOrder).toEqual(['focused', 'active-visible', 'hidden']);

    focused.unregister();
    activeVisible.unregister();
    hidden.unregister();
  });

  it('drains switch-target-visible output on the focused lane during an active switch window', () => {
    const drainOrder: string[] = [];
    let switchTargetPendingBytes = 4_096;
    let visibleBackgroundPendingBytes = 4_096;

    const switchTargetVisible = registerTerminalOutputCandidate(
      'switch-target-terminal',
      () => 'switch-target-visible',
      () => switchTargetPendingBytes,
      () => {
        drainOrder.push('switch-target-visible');
        switchTargetPendingBytes = 0;
        return 4_096;
      },
    );
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      () => {
        drainOrder.push('visible-background');
        visibleBackgroundPendingBytes = 0;
        return 4_096;
      },
    );

    visibleBackground.requestDrain();
    beginTerminalSwitchWindow('task-1', 250);
    switchTargetVisible.requestDrain();
    vi.advanceTimersByTime(0);

    expect(drainOrder).toEqual(['switch-target-visible']);

    runAnimationFrame();
    expect(drainOrder).toEqual(['switch-target-visible']);

    markTerminalSwitchWindowFirstPaint('task-1');
    runAnimationFrame();
    expect(drainOrder).toEqual(['switch-target-visible', 'visible-background']);

    switchTargetVisible.unregister();
    visibleBackground.unregister();
  });

  it('keeps the switch target protected until input-ready when the hard switch contract is enabled', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetProtectUntilInputReady: true,
      switchTargetWindowMs: 250,
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const drainOrder: string[] = [];
    let switchTargetPendingBytes = 4_096;
    let visibleBackgroundPendingBytes = 4_096;

    const switchTargetVisible = registerTerminalOutputCandidate(
      'switch-target-terminal',
      () => 'switch-target-visible',
      () => switchTargetPendingBytes,
      () => {
        drainOrder.push('switch-target-visible');
        switchTargetPendingBytes = 0;
        return 4_096;
      },
    );
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      () => {
        drainOrder.push('visible-background');
        visibleBackgroundPendingBytes = 0;
        return 4_096;
      },
    );

    visibleBackground.requestDrain();
    beginTerminalSwitchWindow('task-1', 250);
    switchTargetVisible.requestDrain();
    vi.advanceTimersByTime(0);

    expect(drainOrder).toEqual(['switch-target-visible']);

    markTerminalSwitchWindowFirstPaint('task-1');
    runAnimationFrame();
    expect(drainOrder).toEqual(['switch-target-visible']);

    markTerminalSwitchWindowInputReady('task-1');
    runAnimationFrame();
    expect(drainOrder).toEqual(['switch-target-visible', 'visible-background']);

    switchTargetVisible.unregister();
    visibleBackground.unregister();
  });

  it('does not let the post-input-ready echo grace override steady-state drain order', () => {
    const drainOrder: string[] = [];
    let focusedPendingBytes = 4_096;
    let visibleBackgroundPendingBytes = 4_096;

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
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      () => {
        drainOrder.push('visible-background');
        visibleBackgroundPendingBytes = 0;
        return 4_096;
      },
    );

    beginTerminalSwitchEchoGrace('task-1', 120);
    activateTerminalSwitchEchoGrace('task-1');
    visibleBackground.requestDrain();
    focused.requestDrain();
    vi.runOnlyPendingTimers();

    expect(drainOrder).toEqual(['focused', 'visible-background']);

    focused.unregister();
    visibleBackground.unregister();
  });

  it('does not suppress visible output before the post-input-ready echo grace activates', () => {
    const drainOrder: string[] = [];
    let focusedPendingBytes = 4_096;
    let visibleBackgroundPendingBytes = 4_096;

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
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      () => {
        drainOrder.push('visible-background');
        visibleBackgroundPendingBytes = 0;
        return 4_096;
      },
    );

    beginTerminalSwitchEchoGrace('task-1', 120);
    visibleBackground.requestDrain();
    focused.requestDrain();
    vi.runOnlyPendingTimers();

    expect(drainOrder).toEqual(['focused', 'visible-background']);

    focused.unregister();
    visibleBackground.unregister();
  });

  it('returns switch-target-visible output to the visible lane after first paint', () => {
    const drainOrder: string[] = [];
    let switchTargetPendingBytes = 4_096;

    const switchTargetVisible = registerTerminalOutputCandidate(
      'switch-target-terminal',
      () => 'switch-target-visible',
      () => switchTargetPendingBytes,
      () => {
        drainOrder.push('switch-target-visible');
        switchTargetPendingBytes = 0;
        return 4_096;
      },
    );

    beginTerminalSwitchWindow('task-1', 250);
    markTerminalSwitchWindowFirstPaint('task-1');
    switchTargetVisible.requestDrain();

    expect(animationFrameCallbacks.filter(Boolean)).toHaveLength(1);

    vi.advanceTimersByTime(0);
    expect(drainOrder).toEqual([]);

    runAnimationFrame();
    expect(drainOrder).toEqual(['switch-target-visible']);

    switchTargetVisible.unregister();
  });

  it('downgrades a queued switch-target drain after first paint before the timeout fires', () => {
    const drainOrder: string[] = [];
    let switchTargetPendingBytes = 4_096;
    let visibleBackgroundPendingBytes = 4_096;

    const switchTargetVisible = registerTerminalOutputCandidate(
      'switch-target-terminal',
      () => 'switch-target-visible',
      () => switchTargetPendingBytes,
      () => {
        drainOrder.push('switch-target-visible');
        switchTargetPendingBytes = 0;
        return 4_096;
      },
    );
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      () => {
        drainOrder.push('visible-background');
        visibleBackgroundPendingBytes = 0;
        return 4_096;
      },
    );

    beginTerminalSwitchWindow('task-1', 250);
    switchTargetVisible.requestDrain();
    visibleBackground.requestDrain();
    markTerminalSwitchWindowFirstPaint('task-1');

    vi.runOnlyPendingTimers();

    expect(drainOrder).toEqual(['switch-target-visible', 'visible-background']);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalOutputScheduler.laneSelections.visible,
    ).toBe(1);

    switchTargetVisible.unregister();
    visibleBackground.unregister();
  });

  it('limits non-target visible drains to one candidate per frame after switch first paint', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetWindowMs: 250,
      switchWindowNonTargetVisibleCandidateLimit: 1,
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const drainOrder: string[] = [];
    let switchTargetPendingBytes = 4_096;
    let activeVisiblePendingBytes = 4_096;
    let visibleBackgroundPendingBytes = 4_096;

    const switchTargetVisible = registerTerminalOutputCandidate(
      'switch-target-terminal',
      () => 'switch-target-visible',
      () => switchTargetPendingBytes,
      () => {
        drainOrder.push('switch-target-visible');
        switchTargetPendingBytes = 0;
        return 4_096;
      },
    );
    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      () => {
        drainOrder.push('active-visible');
        activeVisiblePendingBytes = 0;
        return 4_096;
      },
    );
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      () => {
        drainOrder.push('visible-background');
        visibleBackgroundPendingBytes = 0;
        return 4_096;
      },
    );

    beginTerminalSwitchWindow('task-1', 250);
    markTerminalSwitchWindowFirstPaint('task-1');
    switchTargetVisible.requestDrain();
    activeVisible.requestDrain();
    visibleBackground.requestDrain();

    runAnimationFrame();
    expect(drainOrder).toEqual(['switch-target-visible', 'active-visible']);

    runAnimationFrame();
    expect(drainOrder).toEqual(['switch-target-visible', 'active-visible', 'visible-background']);

    switchTargetVisible.unregister();
    activeVisible.unregister();
    visibleBackground.unregister();
  });

  it('prefers exact visible-count candidate limits over density-aware candidate limits', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibilityAwareDrainCandidateLimitOverrides: {
        few: {
          'visible-background': 1,
        },
      },
      visibleCountDrainCandidateLimitOverrides: {
        '4': {
          'visible-background': 2,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = registerVisibleTerminals(4);
    const drainOrder: string[] = [];
    let firstPendingBytes = 4_096;
    let secondPendingBytes = 4_096;

    const firstVisibleBackground = registerTerminalOutputCandidate(
      'visible-background-a',
      () => 'visible-background',
      () => firstPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, firstPendingBytes);
        firstPendingBytes -= drainedBytes;
        drainOrder.push(`visible-background-a:${drainedBytes}`);
        return drainedBytes;
      },
    );
    const secondVisibleBackground = registerTerminalOutputCandidate(
      'visible-background-b',
      () => 'visible-background',
      () => secondPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, secondPendingBytes);
        secondPendingBytes -= drainedBytes;
        drainOrder.push(`visible-background-b:${drainedBytes}`);
        return drainedBytes;
      },
    );

    firstVisibleBackground.requestDrain();
    secondVisibleBackground.requestDrain();

    runAnimationFrame();

    expect(drainOrder).toEqual([`visible-background-a:${4_096}`, `visible-background-b:${4_096}`]);

    firstVisibleBackground.unregister();
    secondVisibleBackground.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('shares a visible frame budget across non-target visible priorities', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibilityAwareNonTargetVisibleFrameBudgetOverrides: {
        few: 4_096,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const drainOrder: string[] = [];
    let activeVisiblePendingBytes = 4_096;
    let visibleBackgroundPendingBytes = 4_096;

    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      () => {
        drainOrder.push('active-visible');
        activeVisiblePendingBytes = 0;
        return 4_096;
      },
    );
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      () => {
        drainOrder.push('visible-background');
        visibleBackgroundPendingBytes = 0;
        return 4_096;
      },
    );

    const firstVisible = registerTerminalVisibility('visible-a', {
      isFocused: true,
      isSelected: true,
      isVisible: true,
    });
    const secondVisible = registerTerminalVisibility('visible-b', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });
    activeVisible.requestDrain();
    visibleBackground.requestDrain();

    runAnimationFrame();
    expect(drainOrder).toEqual(['active-visible']);

    runAnimationFrame();
    expect(drainOrder).toEqual(['active-visible', 'visible-background']);

    activeVisible.unregister();
    visibleBackground.unregister();
    firstVisible.unregister();
    secondVisible.unregister();
  });

  it('prefers exact visible-count shared budgets over density-aware budgets', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibilityAwareNonTargetVisibleFrameBudgetOverrides: {
        few: 8 * 1024,
      },
      visibleCountNonTargetVisibleFrameBudgetOverrides: {
        '4': 4 * 1024,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = registerVisibleTerminals(4);
    const drainOrder: string[] = [];
    let activeVisiblePendingBytes = 8 * 1024;
    let visibleBackgroundPendingBytes = 8 * 1024;

    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, activeVisiblePendingBytes);
        activeVisiblePendingBytes -= drainedBytes;
        drainOrder.push(`active-visible:${drainedBytes}`);
        return drainedBytes;
      },
    );
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, visibleBackgroundPendingBytes);
        visibleBackgroundPendingBytes -= drainedBytes;
        drainOrder.push(`visible-background:${drainedBytes}`);
        return drainedBytes;
      },
    );

    activeVisible.requestDrain();
    visibleBackground.requestDrain();

    runAnimationFrame();

    expect(drainOrder).toEqual([`active-visible:${4 * 1024}`]);

    activeVisible.unregister();
    visibleBackground.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('prefers exact visible-count focused drain budgets over density-aware focused budgets', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibilityAwareDrainBudgetOverrides: {
        few: {
          focused: 12 * 1024,
        },
      },
      visibleCountDrainBudgetOverrides: {
        '4': {
          focused: 24 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = registerVisibleTerminals(4);
    let drainedBytes = 0;

    const focused = registerTerminalOutputCandidate(
      'focused-terminal',
      () => 'focused',
      () => (drainedBytes === 0 ? 32 * 1024 : 0),
      (maxBytes) => {
        drainedBytes = maxBytes;
        return maxBytes;
      },
    );

    focused.requestDrain();
    vi.runOnlyPendingTimers();

    expect(drainedBytes).toBe(24 * 1024);

    focused.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('lets the switch target consume its reserved visible budget before non-target visible drains', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetWindowMs: 250,
      visibilityAwareLaneFrameBudgetOverrides: {
        few: {
          visible: 8 * 1024,
        },
      },
      visibilityAwareSwitchTargetReserveBytes: {
        few: 3 * 1024,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = registerVisibleTerminals(4);
    const drainOrder: string[] = [];
    let switchTargetPendingBytes = 8 * 1024;
    let activeVisiblePendingBytes = 8 * 1024;

    const switchTargetVisible = registerTerminalOutputCandidate(
      'switch-target-terminal',
      () => 'switch-target-visible',
      () => switchTargetPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, switchTargetPendingBytes);
        switchTargetPendingBytes -= drainedBytes;
        drainOrder.push(`switch-target-visible:${drainedBytes}`);
        return drainedBytes;
      },
    );
    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, activeVisiblePendingBytes);
        activeVisiblePendingBytes -= drainedBytes;
        drainOrder.push(`active-visible:${drainedBytes}`);
        return drainedBytes;
      },
    );

    beginTerminalSwitchWindow('task-1', 250);
    markTerminalSwitchWindowFirstPaint('task-1');
    switchTargetVisible.requestDrain();
    activeVisible.requestDrain();

    runAnimationFrame();

    expect(drainOrder).toEqual([`switch-target-visible:${3 * 1024}`, `active-visible:${2560}`]);

    switchTargetVisible.unregister();
    activeVisible.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('reduces the shared non-target visible budget by the switch-target reserve', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetWindowMs: 250,
      visibilityAwareLaneFrameBudgetOverrides: {
        few: {
          visible: 10 * 1024,
        },
      },
      visibilityAwareSwitchTargetReserveBytes: {
        few: 4 * 1024,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = registerVisibleTerminals(4);
    const drainOrder: string[] = [];
    let switchTargetPendingBytes = 4 * 1024;
    let activeVisiblePendingBytes = 8 * 1024;
    let visibleBackgroundPendingBytes = 8 * 1024;

    const switchTargetVisible = registerTerminalOutputCandidate(
      'switch-target-terminal',
      () => 'switch-target-visible',
      () => switchTargetPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, switchTargetPendingBytes);
        switchTargetPendingBytes -= drainedBytes;
        drainOrder.push(`switch-target-visible:${drainedBytes}`);
        return drainedBytes;
      },
    );
    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, activeVisiblePendingBytes);
        activeVisiblePendingBytes -= drainedBytes;
        drainOrder.push(`active-visible:${drainedBytes}`);
        return drainedBytes;
      },
    );
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, visibleBackgroundPendingBytes);
        visibleBackgroundPendingBytes -= drainedBytes;
        drainOrder.push(`visible-background:${drainedBytes}`);
        return drainedBytes;
      },
    );

    beginTerminalSwitchWindow('task-1', 250);
    markTerminalSwitchWindowFirstPaint('task-1');
    switchTargetVisible.requestDrain();
    activeVisible.requestDrain();
    visibleBackground.requestDrain();

    runAnimationFrame();

    expect(drainOrder).toEqual([
      `switch-target-visible:${4 * 1024}`,
      `active-visible:${3 * 1024}`,
      `visible-background:${1024}`,
    ]);
    expect(activeVisiblePendingBytes).toBe(5 * 1024);
    expect(visibleBackgroundPendingBytes).toBe(7 * 1024);

    switchTargetVisible.unregister();
    activeVisible.unregister();
    visibleBackground.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('prefers exact visible-count switch-target reserve bytes over density-aware reserves', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetWindowMs: 250,
      visibilityAwareLaneFrameBudgetOverrides: {
        few: {
          visible: 10 * 1024,
        },
      },
      visibilityAwareSwitchTargetReserveBytes: {
        few: 4 * 1024,
      },
      visibleCountSwitchTargetReserveBytes: {
        '4': 2 * 1024,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = registerVisibleTerminals(4);
    const drainOrder: string[] = [];
    let switchTargetPendingBytes = 8 * 1024;
    let activeVisiblePendingBytes = 8 * 1024;

    const switchTargetVisible = registerTerminalOutputCandidate(
      'switch-target-terminal',
      () => 'switch-target-visible',
      () => switchTargetPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, switchTargetPendingBytes);
        switchTargetPendingBytes -= drainedBytes;
        drainOrder.push(`switch-target-visible:${drainedBytes}`);
        return drainedBytes;
      },
    );
    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, activeVisiblePendingBytes);
        activeVisiblePendingBytes -= drainedBytes;
        drainOrder.push(`active-visible:${drainedBytes}`);
        return drainedBytes;
      },
    );

    beginTerminalSwitchWindow('task-1', 250);
    markTerminalSwitchWindowFirstPaint('task-1');
    switchTargetVisible.requestDrain();
    activeVisible.requestDrain();

    runAnimationFrame();

    expect(drainOrder).toEqual([`switch-target-visible:${2 * 1024}`, `active-visible:${4 * 1024}`]);

    switchTargetVisible.unregister();
    activeVisible.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('scales the shared non-target visible budget only when multi-visible pressure tuning is active', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      multiVisiblePressureMinimumVisibleCount: 4,
      multiVisiblePressureNonTargetVisibleFrameBudgetScales: {
        critical: 0.5,
      },
      visibilityAwareNonTargetVisibleFrameBudgetOverrides: {
        few: 8 * 1024,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');

    const visibleRegistrations = registerVisibleTerminals(4);
    const drainOrder: string[] = [];
    let activeVisiblePendingBytes = 8 * 1024;
    let visibleBackgroundPendingBytes = 8 * 1024;

    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, activeVisiblePendingBytes);
        activeVisiblePendingBytes -= drainedBytes;
        drainOrder.push(`active-visible:${drainedBytes}`);
        return drainedBytes;
      },
    );
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, visibleBackgroundPendingBytes);
        visibleBackgroundPendingBytes -= drainedBytes;
        drainOrder.push(`visible-background:${drainedBytes}`);
        return drainedBytes;
      },
    );

    activeVisible.requestDrain();
    visibleBackground.requestDrain();
    runAnimationFrame();

    expect(drainOrder).toEqual([`active-visible:${4 * 1024}`]);

    activeVisible.unregister();
    visibleBackground.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('applies pressure scaling after selecting an exact visible-count shared budget', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      multiVisiblePressureMinimumVisibleCount: 4,
      multiVisiblePressureNonTargetVisibleFrameBudgetScales: {
        critical: 0.5,
      },
      visibilityAwareNonTargetVisibleFrameBudgetOverrides: {
        few: 8 * 1024,
      },
      visibleCountNonTargetVisibleFrameBudgetOverrides: {
        '4': 4 * 1024,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');

    const visibleRegistrations = registerVisibleTerminals(4);
    let drainedBytes = 0;

    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => (drainedBytes === 0 ? 8 * 1024 : 0),
      (maxBytes) => {
        drainedBytes = maxBytes;
        return maxBytes;
      },
    );

    activeVisible.requestDrain();
    runAnimationFrame();

    expect(drainedBytes).toBe(2 * 1024);

    activeVisible.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('applies an exact visible-count pressure drain scale to focused output', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibleCountDrainBudgetOverrides: {
        '4': {
          focused: 32 * 1024,
        },
      },
      visibleCountPressureDrainBudgetScales: {
        '4': {
          focused: {
            critical: 1.5,
          },
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');

    const visibleRegistrations = registerVisibleTerminals(4);
    let drainedBytes = 0;

    const focused = registerTerminalOutputCandidate(
      'focused-terminal',
      () => 'focused',
      () => (drainedBytes === 0 ? 64 * 1024 : 0),
      (maxBytes) => {
        drainedBytes = maxBytes;
        return maxBytes;
      },
    );

    focused.requestDrain();
    vi.runOnlyPendingTimers();

    expect(drainedBytes).toBe(48 * 1024);

    focused.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('does not let the visible-background minimum slice exceed the shared non-target budget', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      multiVisiblePressureMinimumVisibleCount: 4,
      multiVisiblePressureNonTargetVisibleFrameBudgetScales: {
        critical: 0.125,
      },
      visibilityAwareNonTargetVisibleFrameBudgetOverrides: {
        few: 4 * 1024,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');

    const visibleRegistrations = registerVisibleTerminals(4);
    let drainedBytes = 0;

    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => (drainedBytes === 0 ? 8 * 1024 : 0),
      (maxBytes) => {
        drainedBytes = maxBytes;
        return maxBytes;
      },
    );

    visibleBackground.requestDrain();
    runAnimationFrame();

    expect(drainedBytes).toBe(512);

    visibleBackground.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('does not apply switch-target reserve without an active switch window', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibilityAwareLaneFrameBudgetOverrides: {
        few: {
          visible: 8 * 1024,
        },
      },
      visibilityAwareSwitchTargetReserveBytes: {
        few: 3 * 1024,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = registerVisibleTerminals(4);
    const drainOrder: string[] = [];
    let switchTargetPendingBytes = 8 * 1024;
    let activeVisiblePendingBytes = 8 * 1024;

    const switchTargetVisible = registerTerminalOutputCandidate(
      'switch-target-terminal',
      () => 'switch-target-visible',
      () => switchTargetPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, switchTargetPendingBytes);
        switchTargetPendingBytes -= drainedBytes;
        drainOrder.push(`switch-target-visible:${drainedBytes}`);
        return drainedBytes;
      },
    );
    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, activeVisiblePendingBytes);
        activeVisiblePendingBytes -= drainedBytes;
        drainOrder.push(`active-visible:${drainedBytes}`);
        return drainedBytes;
      },
    );

    switchTargetVisible.requestDrain();
    activeVisible.requestDrain();

    runAnimationFrame();

    expect(drainOrder).toEqual([`switch-target-visible:${8 * 1024}`]);
    expect(activeVisiblePendingBytes).toBe(8 * 1024);

    switchTargetVisible.unregister();
    activeVisible.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('keeps the single-visible default behavior when visible reserve overrides are unset', () => {
    const visibleRegistration = registerTerminalVisibility('visible-focused', {
      isFocused: true,
      isSelected: true,
      isVisible: true,
    });
    const drainOrder: string[] = [];
    let switchTargetPendingBytes = 4_096;
    let activeVisiblePendingBytes = 4_096;

    const switchTargetVisible = registerTerminalOutputCandidate(
      'switch-target-terminal',
      () => 'switch-target-visible',
      () => switchTargetPendingBytes,
      () => {
        drainOrder.push('switch-target-visible');
        switchTargetPendingBytes = 0;
        return 4_096;
      },
    );
    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      () => {
        drainOrder.push('active-visible');
        activeVisiblePendingBytes = 0;
        return 4_096;
      },
    );

    beginTerminalSwitchWindow('task-1', 250);
    markTerminalSwitchWindowFirstPaint('task-1');
    switchTargetVisible.requestDrain();
    activeVisible.requestDrain();

    runAnimationFrame();

    expect(drainOrder).toEqual(['switch-target-visible', 'active-visible']);

    switchTargetVisible.unregister();
    activeVisible.unregister();
    visibleRegistration.unregister();
  });

  it('keeps focused output ahead of switch-target-visible output during a switch window', () => {
    const drainOrder: string[] = [];
    let focusedPendingBytes = 4_096;
    let switchTargetPendingBytes = 4_096;

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
    const switchTargetVisible = registerTerminalOutputCandidate(
      'switch-target-terminal',
      () => 'switch-target-visible',
      () => switchTargetPendingBytes,
      () => {
        drainOrder.push('switch-target-visible');
        switchTargetPendingBytes = 0;
        return 4_096;
      },
    );

    beginTerminalSwitchWindow('task-1', 250);
    switchTargetVisible.requestDrain();
    focused.requestDrain();
    vi.advanceTimersByTime(0);

    expect(drainOrder).toEqual(['focused', 'switch-target-visible']);

    focused.unregister();
    switchTargetVisible.unregister();
  });

  it('does not promote plain active-visible output onto the focused lane during a switch window', () => {
    const drainOrder: string[] = [];
    let activeVisiblePendingBytes = 4_096;
    let visibleBackgroundPendingBytes = 4_096;

    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      () => {
        drainOrder.push('active-visible');
        activeVisiblePendingBytes = 0;
        return 4_096;
      },
    );
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      () => {
        drainOrder.push('visible-background');
        visibleBackgroundPendingBytes = 0;
        return 4_096;
      },
    );

    beginTerminalSwitchWindow('task-1', 250);
    activeVisible.requestDrain();
    visibleBackground.requestDrain();

    expect(animationFrameCallbacks.filter(Boolean)).toHaveLength(1);

    runAnimationFrame();
    expect(drainOrder).toEqual(['active-visible']);

    markTerminalSwitchWindowFirstPaint('task-1');
    runAnimationFrame();
    expect(drainOrder).toEqual(['active-visible', 'visible-background']);

    activeVisible.unregister();
    visibleBackground.unregister();
  });

  it('limits active-visible drains to one candidate per visible cycle during a switch window', () => {
    const drainOrder: string[] = [];
    let firstPendingBytes = 4_096;
    let secondPendingBytes = 4_096;

    const first = registerTerminalOutputCandidate(
      'active-visible-a',
      () => 'active-visible',
      () => firstPendingBytes,
      () => {
        drainOrder.push('active-visible-a');
        firstPendingBytes = 0;
        return 4_096;
      },
    );
    const second = registerTerminalOutputCandidate(
      'active-visible-b',
      () => 'active-visible',
      () => secondPendingBytes,
      () => {
        drainOrder.push('active-visible-b');
        secondPendingBytes = 0;
        return 4_096;
      },
    );

    beginTerminalSwitchWindow('task-1', 250);
    first.requestDrain();
    second.requestDrain();

    runAnimationFrame();
    expect(drainOrder).toEqual(['active-visible-a']);

    runAnimationFrame();
    expect(drainOrder).toEqual(['active-visible-a', 'active-visible-b']);

    first.unregister();
    second.unregister();
  });

  it('limits active-visible drains to one candidate even when the switch target promotes the focused lane', () => {
    const drainOrder: string[] = [];
    let switchTargetPendingBytes = 4_096;
    let firstPendingBytes = 4_096;
    let secondPendingBytes = 4_096;

    const switchTarget = registerTerminalOutputCandidate(
      'switch-target-terminal',
      () => 'switch-target-visible',
      () => switchTargetPendingBytes,
      () => {
        drainOrder.push('switch-target-visible');
        switchTargetPendingBytes = 0;
        return 4_096;
      },
    );
    const first = registerTerminalOutputCandidate(
      'active-visible-a',
      () => 'active-visible',
      () => firstPendingBytes,
      () => {
        drainOrder.push('active-visible-a');
        firstPendingBytes = 0;
        return 4_096;
      },
    );
    const second = registerTerminalOutputCandidate(
      'active-visible-b',
      () => 'active-visible',
      () => secondPendingBytes,
      () => {
        drainOrder.push('active-visible-b');
        secondPendingBytes = 0;
        return 4_096;
      },
    );

    beginTerminalSwitchWindow('task-1', 250);
    switchTarget.requestDrain();
    first.requestDrain();
    second.requestDrain();
    vi.advanceTimersByTime(0);

    expect(drainOrder).toEqual(['switch-target-visible']);

    markTerminalSwitchWindowFirstPaint('task-1');
    runAnimationFrame();
    expect(drainOrder).toEqual(['switch-target-visible', 'active-visible-a']);

    runAnimationFrame();
    expect(drainOrder).toEqual(['switch-target-visible', 'active-visible-a', 'active-visible-b']);

    switchTarget.unregister();
    first.unregister();
    second.unregister();
  });

  it('uses the experiment hidden drain delay when background tuning is enabled', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      backgroundDrainDelayMs: 80,
    };
    resetTerminalPerformanceExperimentConfigForTests();

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

    vi.advanceTimersByTime(79);
    expect(drainedBytes).toBe(0);

    vi.advanceTimersByTime(1);
    expect(drainedBytes).toBe(2_048);

    hidden.unregister();
  });

  it('can limit the number of candidates drained per priority band in one cycle', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      drainCandidateLimitOverrides: {
        focused: 1,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const drainOrder: string[] = [];
    let firstPendingBytes = 4_096;
    let secondPendingBytes = 4_096;

    const first = registerTerminalOutputCandidate(
      'focused-a',
      () => 'focused',
      () => firstPendingBytes,
      () => {
        drainOrder.push('focused-a');
        firstPendingBytes = 0;
        return 4_096;
      },
    );
    const second = registerTerminalOutputCandidate(
      'focused-b',
      () => 'focused',
      () => secondPendingBytes,
      () => {
        drainOrder.push('focused-b');
        secondPendingBytes = 0;
        return 4_096;
      },
    );

    first.requestDrain();
    second.requestDrain();
    vi.runOnlyPendingTimers();

    expect(drainOrder).toEqual(['focused-a']);

    vi.runOnlyPendingTimers();
    expect(drainOrder).toEqual(['focused-a', 'focused-b']);

    first.unregister();
    second.unregister();
  });

  it('uses visibility-aware drain budgets when many terminals are visible', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibilityAwareDrainBudgetOverrides: {
        dense: {
          'visible-background': 2_048,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = Array.from({ length: 5 }, (_, index) =>
      registerTerminalVisibility(`visible-${index}`, {
        isFocused: index === 0,
        isSelected: index === 0,
        isVisible: true,
      }),
    );
    let drainedBytes = 0;

    const visible = registerTerminalOutputCandidate(
      'visible-terminal',
      () => 'visible-background',
      () => (drainedBytes === 0 ? 4_096 : 0),
      (maxBytes) => {
        drainedBytes = maxBytes;
        return maxBytes;
      },
    );

    visible.requestDrain();
    runAnimationFrame();

    expect(drainedBytes).toBe(2_048);

    visible.unregister();
    for (const registration of visibleRegistrations) {
      registration.unregister();
    }
  });

  it('uses visibility-aware lane frame budgets for visible drains', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibilityAwareLaneFrameBudgetOverrides: {
        few: {
          visible: 24 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = Array.from({ length: 4 }, (_, index) =>
      registerTerminalVisibility(`visible-${index}`, {
        isFocused: index === 0,
        isSelected: index === 0,
        isVisible: true,
      }),
    );
    let firstPendingBytes = 24 * 1024;
    let secondPendingBytes = 24 * 1024;
    const drainOrder: string[] = [];

    const first = registerTerminalOutputCandidate(
      'visible-terminal-a',
      () => 'active-visible',
      () => firstPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, firstPendingBytes);
        drainOrder.push(`a:${drainedBytes}`);
        firstPendingBytes -= drainedBytes;
        return drainedBytes;
      },
    );
    const second = registerTerminalOutputCandidate(
      'visible-terminal-b',
      () => 'visible-background',
      () => secondPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, secondPendingBytes);
        drainOrder.push(`b:${drainedBytes}`);
        secondPendingBytes -= drainedBytes;
        return drainedBytes;
      },
    );

    first.requestDrain();
    second.requestDrain();
    runAnimationFrame();

    expect(drainOrder).toEqual([`a:${24 * 1024}`]);
    expect(firstPendingBytes).toBe(0);
    expect(secondPendingBytes).toBe(24 * 1024);

    first.unregister();
    second.unregister();
    for (const registration of visibleRegistrations) {
      registration.unregister();
    }
  });

  it('uses visibility-aware visible-lane frame budgets before draining lower visible bands', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibilityAwareLaneFrameBudgetOverrides: {
        few: {
          visible: 6 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = Array.from({ length: 4 }, (_, index) =>
      registerTerminalVisibility(`visible-${index}`, {
        isFocused: index === 0,
        isSelected: index === 0,
        isVisible: true,
      }),
    );
    const drainOrder: string[] = [];
    let activeVisiblePendingBytes = 8 * 1024;
    let visibleBackgroundPendingBytes = 8 * 1024;

    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, activeVisiblePendingBytes);
        activeVisiblePendingBytes -= drainedBytes;
        drainOrder.push(`active-visible:${drainedBytes}`);
        return drainedBytes;
      },
    );
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, visibleBackgroundPendingBytes);
        visibleBackgroundPendingBytes -= drainedBytes;
        drainOrder.push(`visible-background:${drainedBytes}`);
        return drainedBytes;
      },
    );

    activeVisible.requestDrain();
    visibleBackground.requestDrain();
    runAnimationFrame();

    expect(drainOrder).toEqual([`active-visible:${6 * 1024}`]);

    activeVisible.unregister();
    visibleBackground.unregister();
    for (const registration of visibleRegistrations) {
      registration.unregister();
    }
  });

  it('throttles visible-background drains when adaptive frame-pressure tuning is active', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      adaptiveVisibleBackgroundThrottleMode: 'moderate',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');

    const visibleRegistrations = Array.from({ length: 4 }, (_, index) =>
      registerTerminalVisibility(`visible-${index}`, {
        isFocused: index === 0,
        isSelected: index === 0,
        isVisible: true,
      }),
    );
    let drainedBytes = 0;

    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => (drainedBytes === 0 ? 16 * 1024 : 0),
      (maxBytes) => {
        drainedBytes = maxBytes;
        return maxBytes;
      },
    );

    visibleBackground.requestDrain();
    runAnimationFrame();

    expect(drainedBytes).toBe(4 * 1024);

    visibleBackground.unregister();
    for (const registration of visibleRegistrations) {
      registration.unregister();
    }
  });

  it('does not throttle visible-background drains until the minimum visible-terminal count is met', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      adaptiveVisibleBackgroundMinimumVisibleCount: 2,
      adaptiveVisibleBackgroundThrottleMode: 'moderate',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');

    const focusedRegistration = registerTerminalVisibility('visible-0', {
      isFocused: true,
      isSelected: true,
      isVisible: true,
    });
    let drainedBytes = 0;

    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => (drainedBytes === 0 ? 16 * 1024 : 0),
      (maxBytes) => {
        drainedBytes = maxBytes;
        return maxBytes;
      },
    );

    visibleBackground.requestDrain();
    runAnimationFrame();

    expect(drainedBytes).toBe(16 * 1024);

    visibleBackground.unregister();
    focusedRegistration.unregister();
  });

  it('throttles active-visible drains under frame pressure when adaptive yielding is enabled', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      adaptiveActiveVisibleMinimumVisibleCount: 2,
      adaptiveActiveVisibleThrottleMode: 'moderate',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');

    const visibleRegistrations = Array.from({ length: 4 }, (_, index) =>
      registerTerminalVisibility(`visible-${index}`, {
        isFocused: index === 0,
        isSelected: index === 0,
        isVisible: true,
      }),
    );
    let drainedBytes = 0;

    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => (drainedBytes === 0 ? 24 * 1024 : 0),
      (maxBytes) => {
        drainedBytes = maxBytes;
        return maxBytes;
      },
    );

    activeVisible.requestDrain();
    runAnimationFrame();

    expect(drainedBytes).toBe(24 * 1024);

    activeVisible.unregister();
    for (const registration of visibleRegistrations) {
      registration.unregister();
    }
  });

  it('does not throttle active-visible drains until the minimum visible-terminal count is met', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      adaptiveActiveVisibleMinimumVisibleCount: 2,
      adaptiveActiveVisibleThrottleMode: 'moderate',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');

    const focusedRegistration = registerTerminalVisibility('visible-0', {
      isFocused: true,
      isSelected: true,
      isVisible: true,
    });
    let drainedBytes = 0;

    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => (drainedBytes === 0 ? 24 * 1024 : 0),
      (maxBytes) => {
        drainedBytes = maxBytes;
        return maxBytes;
      },
    );

    activeVisible.requestDrain();
    runAnimationFrame();

    expect(drainedBytes).toBe(48 * 1024);

    activeVisible.unregister();
    focusedRegistration.unregister();
  });

  it('throttles visible-background more aggressively than active-visible at elevated pressure', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      adaptiveActiveVisibleMinimumVisibleCount: 2,
      adaptiveActiveVisibleThrottleMode: 'moderate',
      adaptiveVisibleBackgroundMinimumVisibleCount: 2,
      adaptiveVisibleBackgroundThrottleMode: 'moderate',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('elevated');

    const visibleRegistrations = Array.from({ length: 4 }, (_, index) =>
      registerTerminalVisibility(`visible-${index}`, {
        isFocused: index === 0,
        isSelected: index === 0,
        isVisible: true,
      }),
    );
    const drainOrder: string[] = [];
    let activeVisiblePendingBytes = 48 * 1024;
    let visibleBackgroundPendingBytes = 16 * 1024;

    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, activeVisiblePendingBytes);
        activeVisiblePendingBytes -= drainedBytes;
        drainOrder.push(`active-visible:${drainedBytes}`);
        return drainedBytes;
      },
    );
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, visibleBackgroundPendingBytes);
        visibleBackgroundPendingBytes -= drainedBytes;
        drainOrder.push(`visible-background:${drainedBytes}`);
        return drainedBytes;
      },
    );

    activeVisible.requestDrain();
    visibleBackground.requestDrain();
    runAnimationFrame();

    expect(drainOrder).toEqual([`active-visible:${36 * 1024}`, `visible-background:${8 * 1024}`]);

    activeVisible.unregister();
    visibleBackground.unregister();
    for (const registration of visibleRegistrations) {
      registration.unregister();
    }
  });

  it('throttles visible-background more aggressively than active-visible at critical pressure', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      adaptiveActiveVisibleMinimumVisibleCount: 2,
      adaptiveActiveVisibleThrottleMode: 'moderate',
      adaptiveVisibleBackgroundMinimumVisibleCount: 2,
      adaptiveVisibleBackgroundThrottleMode: 'moderate',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');

    const visibleRegistrations = Array.from({ length: 4 }, (_, index) =>
      registerTerminalVisibility(`visible-${index}`, {
        isFocused: index === 0,
        isSelected: index === 0,
        isVisible: true,
      }),
    );
    const drainOrder: string[] = [];
    let activeVisiblePendingBytes = 48 * 1024;
    let visibleBackgroundPendingBytes = 16 * 1024;

    const activeVisible = registerTerminalOutputCandidate(
      'active-visible-terminal',
      () => 'active-visible',
      () => activeVisiblePendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, activeVisiblePendingBytes);
        activeVisiblePendingBytes -= drainedBytes;
        drainOrder.push(`active-visible:${drainedBytes}`);
        return drainedBytes;
      },
    );
    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, visibleBackgroundPendingBytes);
        visibleBackgroundPendingBytes -= drainedBytes;
        drainOrder.push(`visible-background:${drainedBytes}`);
        return drainedBytes;
      },
    );

    activeVisible.requestDrain();
    visibleBackground.requestDrain();
    runAnimationFrame();

    expect(drainOrder).toEqual([`active-visible:${24 * 1024}`, `visible-background:${4 * 1024}`]);

    activeVisible.unregister();
    visibleBackground.unregister();
    for (const registration of visibleRegistrations) {
      registration.unregister();
    }
  });

  it('drains only the selected task hidden backlog while selected recovery shielding is active', () => {
    const drainOrder: string[] = [];
    let selectedHiddenPendingBytes = 2_048;
    let unrelatedHiddenPendingBytes = 2_048;

    beginTerminalSwitchWindow('task-selected', 200);
    markTerminalSwitchWindowRecoveryStarted('task-selected');

    const selectedHidden = registerTerminalOutputCandidate(
      'hidden-selected',
      'task-selected',
      () => 'hidden',
      () => selectedHiddenPendingBytes,
      () => {
        drainOrder.push('selected-hidden');
        selectedHiddenPendingBytes = 0;
        return 2_048;
      },
    );
    const unrelatedHidden = registerTerminalOutputCandidate(
      'hidden-unrelated',
      'task-unrelated',
      () => 'hidden',
      () => unrelatedHiddenPendingBytes,
      () => {
        drainOrder.push('unrelated-hidden');
        unrelatedHiddenPendingBytes = 0;
        return 2_048;
      },
    );

    selectedHidden.requestDrain();
    unrelatedHidden.requestDrain();

    vi.advanceTimersByTime(48);
    expect(drainOrder).toEqual(['selected-hidden']);
    expect(unrelatedHiddenPendingBytes).toBe(2_048);

    markTerminalSwitchWindowRecoverySettled('task-selected');
    requestTerminalOutputDrain();
    vi.advanceTimersByTime(48);
    expect(drainOrder).toEqual(['selected-hidden', 'unrelated-hidden']);

    selectedHidden.unregister();
    unrelatedHidden.unregister();
  });

  it('blocks non-selected visible backlog while selected recovery shielding is active', () => {
    const drainOrder: string[] = [];
    let selectedSwitchTargetPendingBytes = 4_096;
    let unrelatedVisiblePendingBytes = 4_096;

    beginTerminalSwitchWindow('task-selected', 200);
    markTerminalSwitchWindowRecoveryStarted('task-selected');

    const selectedSwitchTarget = registerTerminalOutputCandidate(
      'switch-target-selected',
      'task-selected',
      () => 'switch-target-visible',
      () => selectedSwitchTargetPendingBytes,
      () => {
        drainOrder.push('selected-switch-target');
        selectedSwitchTargetPendingBytes = 0;
        return 4_096;
      },
    );
    const unrelatedVisibleBackground = registerTerminalOutputCandidate(
      'visible-background-unrelated',
      'task-unrelated',
      () => 'visible-background',
      () => unrelatedVisiblePendingBytes,
      () => {
        drainOrder.push('unrelated-visible-background');
        unrelatedVisiblePendingBytes = 0;
        return 4_096;
      },
    );

    selectedSwitchTarget.requestDrain();
    unrelatedVisibleBackground.requestDrain();

    vi.runOnlyPendingTimers();
    expect(animationFrameCallbacks).toHaveLength(1);
    runAnimationFrame();
    expect(drainOrder).toEqual(['selected-switch-target']);
    expect(unrelatedVisiblePendingBytes).toBe(4_096);

    markTerminalSwitchWindowRecoverySettled('task-selected');
    markTerminalSwitchWindowFirstPaint('task-selected');
    markTerminalSwitchWindowInputReady('task-selected');
    requestTerminalOutputDrain();
    runAnimationFrame();
    expect(drainOrder).toEqual(['selected-switch-target', 'unrelated-visible-background']);

    selectedSwitchTarget.unregister();
    unrelatedVisibleBackground.unregister();
  });

  it('does not tight-loop reschedule blocked non-selected visible backlog during selected recovery shielding', () => {
    beginTerminalSwitchWindow('task-selected', 200);
    markTerminalSwitchWindowRecoveryStarted('task-selected');
    const unrelatedVisiblePendingBytes = 4_096;

    const unrelatedVisibleBackground = registerTerminalOutputCandidate(
      'visible-background-unrelated',
      'task-unrelated',
      () => 'visible-background',
      () => unrelatedVisiblePendingBytes,
      () => 0,
    );

    unrelatedVisibleBackground.requestDrain();

    expect(animationFrameCallbacks.filter(Boolean)).toHaveLength(1);
    runAnimationFrame();

    expect(unrelatedVisiblePendingBytes).toBe(4_096);
    expect(animationFrameCallbacks.filter(Boolean)).toHaveLength(0);

    unrelatedVisibleBackground.unregister();
  });

  it('blocks non-selected focused backlog while selected recovery shielding is active', () => {
    const drainOrder: string[] = [];
    let selectedSwitchTargetPendingBytes = 4_096;
    let unrelatedFocusedPendingBytes = 4_096;

    beginTerminalSwitchWindow('task-selected', 200);
    markTerminalSwitchWindowRecoveryStarted('task-selected');

    const selectedSwitchTarget = registerTerminalOutputCandidate(
      'switch-target-selected',
      'task-selected',
      () => 'switch-target-visible',
      () => selectedSwitchTargetPendingBytes,
      () => {
        drainOrder.push('selected-switch-target');
        selectedSwitchTargetPendingBytes = 0;
        return 4_096;
      },
    );
    const unrelatedFocused = registerTerminalOutputCandidate(
      'focused-unrelated',
      'task-unrelated',
      () => 'focused',
      () => unrelatedFocusedPendingBytes,
      () => {
        drainOrder.push('unrelated-focused');
        unrelatedFocusedPendingBytes = 0;
        return 4_096;
      },
    );

    selectedSwitchTarget.requestDrain();
    unrelatedFocused.requestDrain();

    vi.advanceTimersByTime(0);
    expect(drainOrder).toEqual(['selected-switch-target']);
    expect(unrelatedFocusedPendingBytes).toBe(4_096);

    markTerminalSwitchWindowRecoverySettled('task-selected');
    markTerminalSwitchWindowFirstPaint('task-selected');
    markTerminalSwitchWindowInputReady('task-selected');
    requestTerminalOutputDrain();
    vi.runOnlyPendingTimers();
    expect(drainOrder).toEqual(['selected-switch-target', 'unrelated-focused']);

    selectedSwitchTarget.unregister();
    unrelatedFocused.unregister();
  });

  it('does not tight-loop reschedule zero-budget visible backlog during focused input echo reservation', () => {
    setTerminalHighLoadModeForTest(true);
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      label: 'terminal-output-scheduler-zero-budget-reschedule',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    const visibleRegistrations = registerVisibleTerminals(4);
    noteTerminalFocusedInput('task-focused');
    const visibleBackgroundPendingBytes = 4_096;

    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      'task-background',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      () => 0,
    );

    visibleBackground.requestDrain();

    expect(animationFrameCallbacks.filter(Boolean)).toHaveLength(1);
    runAnimationFrame();

    expect(visibleBackgroundPendingBytes).toBe(4_096);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalOutputScheduler.rescheduledDrains).toBe(
      0,
    );

    visibleBackground.unregister();
    settleTerminalFocusedInput('task-focused');
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('applies dense-overload visible-background budgets only after dense pressure activates', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
      denseOverloadVisibleCountLaneFrameBudgetOverrides: {
        '4': {
          visible: 8 * 1024,
        },
      },
      denseOverloadVisibleCountNonTargetVisibleFrameBudgetOverrides: {
        '4': 4 * 1024,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('stable');
    setTerminalHighLoadModeForTest(true);

    const visibleRegistrations = registerVisibleTerminals(4);
    const drainOrder: string[] = [];
    let visibleBackgroundPendingBytes = 16 * 1024;

    const visibleBackground = registerTerminalOutputCandidate(
      'visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, visibleBackgroundPendingBytes);
        visibleBackgroundPendingBytes -= drainedBytes;
        drainOrder.push(`visible-background:${drainedBytes}`);
        return drainedBytes;
      },
    );

    visibleBackground.requestDrain();
    runAnimationFrame();
    expect(drainOrder).toEqual([`visible-background:${16 * 1024}`]);

    visibleBackgroundPendingBytes = 16 * 1024;
    drainOrder.length = 0;
    setTerminalFramePressureLevelForTests('critical');

    visibleBackground.requestDrain();
    runAnimationFrame();
    expect(drainOrder).toEqual([`visible-background:${4 * 1024}`]);

    visibleBackground.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('uses the built-in high load mode visible budget when enabled at four visible terminals', () => {
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);
    setTerminalFramePressureLevelForTests('critical');

    const visibleRegistrations = registerVisibleTerminals(4);
    const drainOrder: string[] = [];
    let visibleBackgroundPendingBytes = 16 * 1024;

    const visibleBackground = registerTerminalOutputCandidate(
      'high-load-visible-background-terminal',
      () => 'visible-background',
      () => visibleBackgroundPendingBytes,
      (maxBytes) => {
        const drainedBytes = Math.min(maxBytes, visibleBackgroundPendingBytes);
        visibleBackgroundPendingBytes -= drainedBytes;
        drainOrder.push(`visible-background:${drainedBytes}`);
        return drainedBytes;
      },
    );

    visibleBackground.requestDrain();
    runAnimationFrame();

    expect(drainOrder).toEqual([`visible-background:${1024}`]);

    visibleBackground.unregister();
    unregisterVisibleTerminals(visibleRegistrations);
  });
});
