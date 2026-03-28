import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPriorityDrainPlan,
  getPriorityThrottle,
  getVisibleDrainBudgetContext,
} from './terminal-output-scheduler-policy';
import {
  resetTerminalFramePressureForTests,
  setTerminalFramePressureLevelForTests,
} from './terminal-frame-pressure';
import {
  noteTerminalFocusedInput,
  resetTerminalFocusedInputForTests,
} from './terminal-focused-input';
import { syncTerminalHighLoadMode } from './terminal-high-load-mode';
import {
  beginTerminalSwitchWindow,
  markTerminalSwitchWindowFirstPaint,
  resetTerminalSwitchWindowForTests,
} from './terminal-switch-window';
import {
  registerTerminalVisibility,
  resetTerminalVisibleSetForTests,
} from './terminal-visible-set';
import { resetTerminalPerformanceExperimentConfigForTests } from '../lib/terminal-performance-experiments';
import { setStore } from '../store/core';

describe('terminal-output-scheduler-policy', () => {
  function setTerminalHighLoadModeForTest(enabled: boolean): void {
    setStore('terminalHighLoadMode', enabled);
    syncTerminalHighLoadMode(enabled);
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

  beforeEach(() => {
    vi.stubGlobal('window', {
      __PARALLEL_CODE_TERMINAL_EXPERIMENTS__: undefined,
    });
    resetTerminalFramePressureForTests();
    resetTerminalFocusedInputForTests();
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalSwitchWindowForTests();
    resetTerminalVisibleSetForTests();
    setTerminalHighLoadModeForTest(false);
  });

  afterEach(() => {
    resetTerminalFramePressureForTests();
    resetTerminalFocusedInputForTests();
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalSwitchWindowForTests();
    resetTerminalVisibleSetForTests();
    setTerminalHighLoadModeForTest(false);
    vi.unstubAllGlobals();
  });

  it('reserves focused budget and suppresses non-target visible output during dense focused input echo protection', () => {
    const visibleRegistrations = registerVisibleTerminals(4);
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      label: 'terminal-output-scheduler-policy-dense-focused-input',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);
    setTerminalFramePressureLevelForTests('critical');
    noteTerminalFocusedInput('task-focused');

    expect(getPriorityThrottle('focused', 'focused')).toEqual({
      budgetScale: 2,
      candidateLimit: null,
    });
    expect(getPriorityThrottle('active-visible', 'visible')).toEqual({
      budgetScale: 0,
      candidateLimit: 0,
    });

    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('reserves switch-target budget and limits non-target visible candidates during switch-window recovery', () => {
    const visibleRegistrations = registerVisibleTerminals(3);
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      label: 'terminal-output-scheduler-policy-switch-window',
      switchTargetProtectUntilInputReady: true,
      visibilityAwareSwitchTargetReserveBytes: {
        few: 4_096,
      },
      switchWindowNonTargetVisibleCandidateLimit: 1,
    };
    resetTerminalPerformanceExperimentConfigForTests();
    beginTerminalSwitchWindow('task-target', 1_000, 0, 'panel', 1);
    markTerminalSwitchWindowFirstPaint('task-target');

    expect(getVisibleDrainBudgetContext('visible', 3, 8_192, true)).toEqual({
      remainingNonTargetVisibleCandidateLimit: 1,
      remainingNonTargetVisibleFrameBudget: 4_096,
      remainingSwitchTargetReserveBudget: 4_096,
    });

    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('keeps a minimum visible-background budget when throttle scaling would otherwise starve it', () => {
    const visibleRegistrations = registerVisibleTerminals(3);
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      adaptiveVisibleBackgroundMinimumVisibleCount: 1,
      adaptiveVisibleBackgroundThrottleMode: 'aggressive',
      label: 'terminal-output-scheduler-policy-visible-background',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');

    const drainPlan = getPriorityDrainPlan(
      'visible-background',
      'visible',
      3,
      4_096,
      getVisibleDrainBudgetContext('visible', 3, 4_096, false),
    );

    expect(drainPlan.candidateLimit).toBe(1);
    expect(drainPlan.priorityFrameBudget).toBe(4_096);
    expect(drainPlan.remainingPriorityBudget).toBe(1_024);

    unregisterVisibleTerminals(visibleRegistrations);
  });
});
