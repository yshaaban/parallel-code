import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTerminalPerformanceExperimentConfigForTests } from '../lib/terminal-performance-experiments';
import { setStore } from '../store/core';
import {
  noteTerminalFocusedInput,
  resetTerminalFocusedInputForTests,
} from './terminal-focused-input';
import {
  reserveTerminalRecentHiddenCandidate,
  resetTerminalRecentHiddenReservationForTests,
} from './terminal-recent-hidden-reservation';
import { syncTerminalHighLoadMode } from './terminal-high-load-mode';
import {
  beginTerminalSwitchWindow,
  markTerminalSwitchWindowRecoveryStarted,
  resetTerminalSwitchWindowForTests,
} from './terminal-switch-window';
import {
  getTerminalSurfaceTier,
  registerTerminalSurfaceTier,
  resetTerminalSurfaceTieringForTests,
} from './terminal-surface-tiering';

describe('terminal-surface-tiering', () => {
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
    resetTerminalSurfaceTieringForTests();
    resetTerminalFocusedInputForTests();
    resetTerminalRecentHiddenReservationForTests();
    setTerminalHighLoadModeForTest(false);
  });

  afterEach(() => {
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalSurfaceTieringForTests();
    resetTerminalFocusedInputForTests();
    resetTerminalRecentHiddenReservationForTests();
    Reflect.deleteProperty(globalThis, 'window');
    resetTerminalSwitchWindowForTests();
    vi.useRealTimers();
  });

  it('maps focused terminals to interactive-live and non-focused visible terminals to passive-visible by default', () => {
    const focused = registerTerminalSurfaceTier('focused', {
      isFocused: true,
      isSelected: true,
      isVisible: true,
    });
    const visible = registerTerminalSurfaceTier('visible', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });

    expect(getTerminalSurfaceTier('focused')).toBe('interactive-live');
    expect(getTerminalSurfaceTier('visible')).toBe('passive-visible');

    focused.unregister();
    visible.unregister();
  });

  it('keeps selected visible terminals in the handoff-live role', () => {
    const selected = registerTerminalSurfaceTier('selected', {
      isFocused: false,
      isSelected: true,
      isVisible: true,
    });

    expect(getTerminalSurfaceTier('selected')).toBe('handoff-live');

    selected.unregister();
  });

  it('does not keep hidden selected terminals in the handoff-live role', () => {
    const selectedHidden = registerTerminalSurfaceTier('selected-hidden', {
      isFocused: false,
      isSelected: true,
      isVisible: false,
    });

    expect(getTerminalSurfaceTier('selected-hidden')).toBe('cold-hidden');

    selectedHidden.unregister();
  });

  it('keeps visible non-focused terminals passive-visible without changing recency on reactive churn', () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      label: 'surface-tiering-passive-visible',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);

    const focused = registerTerminalSurfaceTier('focused', {
      isFocused: true,
      isSelected: true,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleOne = registerTerminalSurfaceTier('visible-one', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleTwo = registerTerminalSurfaceTier('visible-two', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleThree = registerTerminalSurfaceTier('visible-three', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });

    expect(getTerminalSurfaceTier('focused')).toBe('interactive-live');
    expect(getTerminalSurfaceTier('visible-one')).toBe('passive-visible');
    expect(getTerminalSurfaceTier('visible-two')).toBe('passive-visible');
    expect(getTerminalSurfaceTier('visible-three')).toBe('passive-visible');

    visibleOne.update({
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });

    expect(getTerminalSurfaceTier('visible-one')).toBe('passive-visible');
    expect(getTerminalSurfaceTier('visible-three')).toBe('passive-visible');

    vi.advanceTimersByTime(1);
    visibleOne.noteIntent();

    expect(getTerminalSurfaceTier('visible-one')).toBe('passive-visible');
    expect(getTerminalSurfaceTier('visible-three')).toBe('passive-visible');

    focused.unregister();
    visibleOne.unregister();
    visibleTwo.unregister();
    visibleThree.unregister();
  });

  it('keeps only the most recent hidden terminals hot when configured', () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      hiddenTerminalHotCount: 1,
      label: 'surface-tiering',
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const older = registerTerminalSurfaceTier('older', {
      isFocused: false,
      isSelected: false,
      isVisible: false,
    });
    vi.advanceTimersByTime(1);
    const newer = registerTerminalSurfaceTier('newer', {
      isFocused: false,
      isSelected: false,
      isVisible: false,
    });

    expect(getTerminalSurfaceTier('older')).toBe('cold-hidden');
    expect(getTerminalSurfaceTier('newer')).toBe('hot-hidden-live');

    vi.advanceTimersByTime(1);
    older.noteIntent();

    expect(getTerminalSurfaceTier('older')).toBe('hot-hidden-live');
    expect(getTerminalSurfaceTier('newer')).toBe('cold-hidden');

    older.unregister();
    newer.unregister();
  });

  it('keeps the most recent hidden reservations hot ahead of generic hot-hidden recency', () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      label: 'surface-tiering-recent-hidden-reservation',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);

    const focused = registerTerminalSurfaceTier('focused', {
      isFocused: true,
      isSelected: true,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleOne = registerTerminalSurfaceTier('visible-one', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleTwo = registerTerminalSurfaceTier('visible-two', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleThree = registerTerminalSurfaceTier('visible-three', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const hiddenOne = registerTerminalSurfaceTier('hidden-one', {
      isFocused: false,
      isSelected: false,
      isVisible: false,
    });
    vi.advanceTimersByTime(1);
    const hiddenTwo = registerTerminalSurfaceTier('hidden-two', {
      isFocused: false,
      isSelected: false,
      isVisible: false,
    });
    vi.advanceTimersByTime(1);
    const hiddenThree = registerTerminalSurfaceTier('hidden-three', {
      isFocused: false,
      isSelected: false,
      isVisible: false,
    });

    reserveTerminalRecentHiddenCandidate('hidden-one', 'task-hidden-one');
    vi.advanceTimersByTime(1);
    reserveTerminalRecentHiddenCandidate('hidden-two', 'task-hidden-two');
    vi.advanceTimersByTime(1);
    reserveTerminalRecentHiddenCandidate('hidden-three', 'task-hidden-three');

    expect(getTerminalSurfaceTier('hidden-one')).toBe('cold-hidden');
    expect(getTerminalSurfaceTier('hidden-two')).toBe('hot-hidden-live');
    expect(getTerminalSurfaceTier('hidden-three')).toBe('hot-hidden-live');

    focused.unregister();
    visibleOne.unregister();
    visibleTwo.unregister();
    visibleThree.unregister();
    hiddenOne.unregister();
    hiddenTwo.unregister();
    hiddenThree.unregister();
  });

  it('keeps all non-focused visible terminals passive-visible even when dense overload is active', () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      label: 'surface-tiering-dense-overload',
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);

    const focused = registerTerminalSurfaceTier('focused', {
      isFocused: true,
      isSelected: true,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleOne = registerTerminalSurfaceTier('visible-one', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleTwo = registerTerminalSurfaceTier('visible-two', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleThree = registerTerminalSurfaceTier('visible-three', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });

    expect(getTerminalSurfaceTier('visible-one')).toBe('passive-visible');
    expect(getTerminalSurfaceTier('visible-two')).toBe('passive-visible');
    expect(getTerminalSurfaceTier('visible-three')).toBe('passive-visible');

    focused.unregister();
    visibleOne.unregister();
    visibleTwo.unregister();
    visibleThree.unregister();
  });

  it('keeps visible passive demotion stable while selected recovery is active', () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      label: 'surface-tiering-dense-handoff-stable',
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);

    const focused = registerTerminalSurfaceTier('focused', {
      isFocused: true,
      isSelected: true,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleOne = registerTerminalSurfaceTier('visible-one', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleTwo = registerTerminalSurfaceTier('visible-two', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleThree = registerTerminalSurfaceTier('visible-three', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });

    expect(getTerminalSurfaceTier('visible-one')).toBe('passive-visible');
    expect(getTerminalSurfaceTier('visible-two')).toBe('passive-visible');
    expect(getTerminalSurfaceTier('visible-three')).toBe('passive-visible');

    beginTerminalSwitchWindow('focused', 250);
    markTerminalSwitchWindowRecoveryStarted('focused');

    expect(getTerminalSurfaceTier('visible-one')).toBe('passive-visible');
    expect(getTerminalSurfaceTier('visible-two')).toBe('passive-visible');
    expect(getTerminalSurfaceTier('visible-three')).toBe('passive-visible');

    focused.unregister();
    visibleOne.unregister();
    visibleTwo.unregister();
    visibleThree.unregister();
  });

  it('demotes every non-pinned visible terminal during dense focused input in High Load Mode', () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      label: 'surface-tiering-dense-focused-input',
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);

    const focused = registerTerminalSurfaceTier('focused', {
      isFocused: true,
      isSelected: true,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleOne = registerTerminalSurfaceTier('visible-one', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleTwo = registerTerminalSurfaceTier('visible-two', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });
    vi.advanceTimersByTime(1);
    const visibleThree = registerTerminalSurfaceTier('visible-three', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });

    noteTerminalFocusedInput('focused-task');

    expect(getTerminalSurfaceTier('visible-one')).toBe('passive-visible');
    expect(getTerminalSurfaceTier('visible-two')).toBe('passive-visible');
    expect(getTerminalSurfaceTier('visible-three')).toBe('passive-visible');

    focused.unregister();
    visibleOne.unregister();
    visibleTwo.unregister();
    visibleThree.unregister();
  });
});
