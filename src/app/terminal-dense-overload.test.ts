import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setStore } from '../store/core';
import {
  registerTerminalVisibility,
  resetTerminalVisibleSetForTests,
} from './terminal-visible-set';
import { syncTerminalHighLoadMode } from './terminal-high-load-mode';
import {
  beginTerminalSwitchWindow,
  markTerminalSwitchWindowRecoverySettled,
  markTerminalSwitchWindowRecoveryStarted,
  resetTerminalSwitchWindowForTests,
} from './terminal-switch-window';
import { isTerminalDenseOverloadActive } from './terminal-dense-overload';
import {
  resetTerminalFramePressureForTests,
  setTerminalFramePressureLevelForTests,
} from './terminal-frame-pressure';
import { resetTerminalPerformanceExperimentConfigForTests } from '../lib/terminal-performance-experiments';

describe('terminal-dense-overload', () => {
  function setTerminalHighLoadModeForTest(enabled: boolean): void {
    setStore('terminalHighLoadMode', enabled);
    syncTerminalHighLoadMode(enabled);
  }

  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalFramePressureForTests();
    resetTerminalSwitchWindowForTests();
    resetTerminalVisibleSetForTests();
    setTerminalHighLoadModeForTest(false);
  });

  afterEach(() => {
    resetTerminalVisibleSetForTests();
    resetTerminalSwitchWindowForTests();
    resetTerminalFramePressureForTests();
    resetTerminalPerformanceExperimentConfigForTests();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, 'window');
  });

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

  it('activates only when visible count and frame pressure clear the configured floor', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);
    const visibleRegistrations = registerVisibleTerminals(4);

    expect(isTerminalDenseOverloadActive()).toBe(false);

    setTerminalFramePressureLevelForTests('elevated');
    expect(isTerminalDenseOverloadActive()).toBe(true);

    setTerminalFramePressureLevelForTests('stable');
    expect(isTerminalDenseOverloadActive()).toBe(false);

    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('stays disabled while selected recovery is active', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);
    const visibleRegistrations = registerVisibleTerminals(4);
    setTerminalFramePressureLevelForTests('critical');

    beginTerminalSwitchWindow('task-1', 250);
    markTerminalSwitchWindowRecoveryStarted('task-1');
    expect(isTerminalDenseOverloadActive()).toBe(false);

    markTerminalSwitchWindowRecoverySettled('task-1');
    expect(isTerminalDenseOverloadActive()).toBe(true);

    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('stays disabled while high load mode is off', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    const visibleRegistrations = registerVisibleTerminals(4);
    setTerminalFramePressureLevelForTests('critical');

    expect(isTerminalDenseOverloadActive()).toBe(false);

    unregisterVisibleTerminals(visibleRegistrations);
  });
});
