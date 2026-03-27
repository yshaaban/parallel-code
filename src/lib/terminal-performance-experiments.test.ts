import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getTerminalExperimentDenseOverloadLaneFrameBudgetOverride,
  getTerminalExperimentDenseOverloadMinimumVisibleCount,
  getTerminalExperimentDenseOverloadNonTargetVisibleFrameBudgetOverride,
  getTerminalExperimentDenseOverloadPressureDrainBudgetScale,
  getTerminalExperimentDenseOverloadPressureFloor,
  getTerminalExperimentDenseOverloadPressureWriteBatchLimitScale,
  getTerminalExperimentDenseOverloadSwitchTargetReserveBytes,
  getTerminalExperimentDenseOverloadWriteBatchLimitOverride,
  getTerminalExperimentDrainCandidateLimitOverride,
  getTerminalExperimentLaneFrameBudgetOverride,
  getTerminalExperimentMultiVisiblePressureNonTargetVisibleFrameBudgetScale,
  getTerminalExperimentMultiVisiblePressureWriteBatchLimitScale,
  getTerminalExperimentNonTargetVisibleFrameBudgetOverride,
  getTerminalExperimentSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes,
  getTerminalExperimentSwitchPostInputReadyEchoGraceMs,
  getTerminalExperimentSwitchTargetWindowMs,
  getTerminalExperimentVisibleCountPressureDrainBudgetScale,
  getTerminalExperimentSwitchTargetReserveBytes,
  getTerminalExperimentDrainBudgetOverride,
  getTerminalExperimentWriteBatchLimitOverride,
  getTerminalPerformanceExperimentConfig,
  getTerminalVisibilityDensityForVisibleCount,
  hasTerminalFramePressureResponsiveExperimentConfig,
  resetTerminalPerformanceExperimentConfigForTests,
} from './terminal-performance-experiments';

describe('terminal-performance-experiments', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    resetTerminalPerformanceExperimentConfigForTests();
  });

  afterEach(() => {
    resetTerminalPerformanceExperimentConfigForTests();
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('preserves the focused-preemption fallback when High Load Mode is explicitly disabled', () => {
    window.__PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__ = false;
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalPerformanceExperimentConfig()).toEqual(
      expect.objectContaining({
        focusedPreemptionDrainScope: 'focused',
        focusedPreemptionWindowMs: 150,
        label: 'default',
      }),
    );
  });

  it('allows explicit experiment config to disable focused preemption', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      drainCandidateLimitOverrides: {
        focused: 1,
      },
      focusedPreemptionDrainScope: 'all',
      focusedPreemptionWindowMs: 0,
      label: 'baseline',
    };
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalPerformanceExperimentConfig()).toEqual(
      expect.objectContaining({
        drainCandidateLimitOverrides: {
          focused: 1,
        },
        focusedPreemptionDrainScope: 'all',
        focusedPreemptionWindowMs: 0,
        label: 'baseline',
      }),
    );
  });

  it('preserves the default focused preemption policy for partial configs', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibilityAwareNonTargetVisibleFrameBudgetOverrides: {
        few: 12 * 1024,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalPerformanceExperimentConfig()).toEqual(
      expect.objectContaining({
        focusedPreemptionDrainScope: 'focused',
        focusedPreemptionWindowMs: 150,
      }),
    );
  });

  it('uses the built-in high load mode profile by default in browser runtimes', () => {
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalPerformanceExperimentConfig()).toEqual(
      expect.objectContaining({
        adaptiveVisibleBackgroundMinimumVisibleCount: 2,
        adaptiveVisibleBackgroundThrottleMode: 'moderate',
        focusedPreemptionDrainScope: 'focused',
        focusedPreemptionWindowMs: 150,
        label: 'high_load_mode',
        multiVisiblePressureMinimumVisibleCount: 4,
        switchTargetWindowMs: 250,
      }),
    );
    expect(getTerminalExperimentDenseOverloadMinimumVisibleCount()).toBe(0);
    expect(getTerminalExperimentDenseOverloadPressureFloor()).toBeNull();
    expect(getTerminalExperimentLaneFrameBudgetOverride('visible', 1)).toBeNull();
    expect(getTerminalExperimentLaneFrameBudgetOverride('visible', 2)).toBe(56 * 1024);
    expect(getTerminalExperimentLaneFrameBudgetOverride('visible', 4)).toBe(56 * 1024);
    expect(getTerminalExperimentNonTargetVisibleFrameBudgetOverride(1)).toBeNull();
    expect(getTerminalExperimentNonTargetVisibleFrameBudgetOverride(2)).toBe(16 * 1024);
    expect(getTerminalExperimentNonTargetVisibleFrameBudgetOverride(4)).toBe(16 * 1024);
    expect(getTerminalExperimentSwitchTargetReserveBytes(1)).toBeNull();
    expect(getTerminalExperimentSwitchTargetReserveBytes(2)).toBe(24 * 1024);
    expect(getTerminalExperimentSwitchTargetReserveBytes(4)).toBe(24 * 1024);
    expect(getTerminalExperimentWriteBatchLimitOverride('focused', 1)).toBeNull();
    expect(getTerminalExperimentWriteBatchLimitOverride('focused', 2)).toBe(32 * 1024);
    expect(getTerminalExperimentWriteBatchLimitOverride('focused', 4)).toBe(32 * 1024);
    expect(getTerminalExperimentWriteBatchLimitOverride('active-visible', 2)).toBe(12 * 1024);
    expect(getTerminalExperimentWriteBatchLimitOverride('switch-target-visible', 4)).toBe(
      32 * 1024,
    );
    expect(
      getTerminalExperimentVisibleCountPressureDrainBudgetScale('focused', 4, 'elevated'),
    ).toBe(1.25);
    expect(
      getTerminalExperimentVisibleCountPressureDrainBudgetScale('focused', 4, 'critical'),
    ).toBe(1.5);
    expect(
      getTerminalPerformanceExperimentConfig().visibleCountPressureWriteBatchLimitScales,
    ).toEqual({
      '4': {
        focused: {
          critical: 1.5,
          elevated: 1.25,
        },
      },
    });
    expect(
      getTerminalExperimentMultiVisiblePressureWriteBatchLimitScale('focused', 4, 'elevated'),
    ).toBe(1.25);
    expect(
      getTerminalExperimentMultiVisiblePressureNonTargetVisibleFrameBudgetScale(4, 'critical'),
    ).toBe(0.125);
    expect(
      getTerminalExperimentMultiVisiblePressureWriteBatchLimitScale(
        'visible-background',
        4,
        'elevated',
      ),
    ).toBe(0.375);
    expect(getTerminalPerformanceExperimentConfig().statusFlushDelayOverridesMs).toEqual({});
    expect(
      getTerminalPerformanceExperimentConfig().visibilityAwareLaneFrameBudgetOverrides,
    ).toEqual({
      dense: {
        visible: 40 * 1024,
      },
    });
    expect(
      getTerminalPerformanceExperimentConfig().visibilityAwareNonTargetVisibleFrameBudgetOverrides,
    ).toEqual({
      dense: 8 * 1024,
    });
    expect(
      getTerminalPerformanceExperimentConfig().visibilityAwareSwitchTargetReserveBytes,
    ).toEqual({
      dense: 16 * 1024,
    });
    expect(
      getTerminalPerformanceExperimentConfig().visibilityAwareWriteBatchLimitOverrides,
    ).toEqual({
      dense: {
        'active-visible': 8 * 1024,
        focused: 24 * 1024,
        hidden: 8 * 1024,
        'switch-target-visible': 24 * 1024,
        'visible-background': 8 * 1024,
      },
    });
    expect(getTerminalExperimentSwitchTargetWindowMs(1)).toBe(250);
    expect(getTerminalExperimentSwitchTargetWindowMs(2)).toBe(250);
    expect(getTerminalExperimentSwitchTargetWindowMs(4)).toBe(250);
  });

  it('prefers injected experiments over the built-in high load mode profile', () => {
    window.__PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__ = true;
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      adaptiveVisibleBackgroundMinimumVisibleCount: 2,
      denseOverloadMinimumVisibleCount: 6,
      label: 'browser-variant',
    };
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalPerformanceExperimentConfig()).toEqual(
      expect.objectContaining({
        adaptiveVisibleBackgroundMinimumVisibleCount: 2,
        denseOverloadMinimumVisibleCount: 6,
        label: 'browser-variant',
      }),
    );
    expect(getTerminalExperimentSwitchTargetWindowMs(4)).toBe(0);
  });

  it('normalizes visibility-aware pacing overrides', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      adaptiveActiveVisibleMinimumVisibleCount: 2,
      adaptiveActiveVisibleThrottleMode: 'moderate',
      hiddenTerminalHotCount: 2,
      sidebarIntentPrewarmDelayMs: 120,
      adaptiveVisibleBackgroundThrottleMode: 'moderate',
      adaptiveVisibleBackgroundMinimumVisibleCount: 2,
      switchPostInputReadyFirstFocusedWriteBatchLimitBytes: 8 * 1024,
      switchWindowNonTargetVisibleCandidateLimit: 1,
      switchPostInputReadyEchoGraceMs: 120,
      switchWindowSettleDelayMs: 72,
      switchTargetProtectUntilInputReady: true,
      switchTargetWindowMs: 250,
      visibleCountSwitchTargetWindowMs: {
        '4': 180,
      },
      visibilityAwareLaneFrameBudgetOverrides: {
        few: {
          visible: 48 * 1024,
        },
      },
      visibilityAwareSwitchTargetReserveBytes: {
        few: 16 * 1024,
      },
      visibilityAwareNonTargetVisibleFrameBudgetOverrides: {
        dense: 24 * 1024,
        few: 32 * 1024,
      },
      visibilityAwareDrainBudgetOverrides: {
        dense: {
          'switch-target-visible': 24 * 1024,
          'visible-background': 8 * 1024,
        },
      },
      visibilityAwareWriteBatchLimitOverrides: {
        few: {
          'switch-target-visible': 24 * 1024,
          focused: 32 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalPerformanceExperimentConfig()).toEqual(
      expect.objectContaining({
        adaptiveActiveVisibleMinimumVisibleCount: 2,
        adaptiveActiveVisibleThrottleMode: 'moderate',
        hiddenTerminalHotCount: 2,
        sidebarIntentPrewarmDelayMs: 120,
        adaptiveVisibleBackgroundThrottleMode: 'moderate',
        adaptiveVisibleBackgroundMinimumVisibleCount: 2,
        switchPostInputReadyFirstFocusedWriteBatchLimitBytes: 8 * 1024,
        switchWindowNonTargetVisibleCandidateLimit: 1,
        switchPostInputReadyEchoGraceMs: 120,
        switchWindowSettleDelayMs: 72,
        switchTargetProtectUntilInputReady: true,
        switchTargetWindowMs: 250,
        visibleCountSwitchTargetWindowMs: {
          '4': 180,
        },
        visibilityAwareLaneFrameBudgetOverrides: {
          few: {
            visible: 48 * 1024,
          },
        },
        visibilityAwareSwitchTargetReserveBytes: {
          few: 16 * 1024,
        },
        visibilityAwareNonTargetVisibleFrameBudgetOverrides: {
          dense: 24 * 1024,
          few: 32 * 1024,
        },
        visibilityAwareDrainBudgetOverrides: {
          dense: {
            'switch-target-visible': 24 * 1024,
            'visible-background': 8 * 1024,
          },
        },
        visibilityAwareWriteBatchLimitOverrides: {
          few: {
            'switch-target-visible': 24 * 1024,
            focused: 32 * 1024,
          },
        },
      }),
    );
    expect(getTerminalVisibilityDensityForVisibleCount(1)).toBe('single');
    expect(getTerminalVisibilityDensityForVisibleCount(4)).toBe('few');
    expect(getTerminalVisibilityDensityForVisibleCount(8)).toBe('dense');
    expect(getTerminalExperimentDrainBudgetOverride('visible-background', 8)).toBe(8 * 1024);
    expect(getTerminalExperimentDrainBudgetOverride('switch-target-visible', 8)).toBe(24 * 1024);
    expect(getTerminalExperimentLaneFrameBudgetOverride('visible', 4)).toBe(48 * 1024);
    expect(getTerminalExperimentSwitchTargetReserveBytes(4)).toBe(16 * 1024);
    expect(getTerminalExperimentNonTargetVisibleFrameBudgetOverride(4)).toBe(32 * 1024);
    expect(getTerminalExperimentNonTargetVisibleFrameBudgetOverride(8)).toBe(24 * 1024);
    expect(getTerminalExperimentSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes(4)).toBe(
      8 * 1024,
    );
    expect(getTerminalExperimentSwitchPostInputReadyEchoGraceMs(4)).toBe(120);
    expect(getTerminalExperimentSwitchTargetWindowMs(1)).toBe(250);
    expect(getTerminalExperimentSwitchTargetWindowMs(4)).toBe(180);
    expect(getTerminalExperimentWriteBatchLimitOverride('focused', 4)).toBe(32 * 1024);
    expect(getTerminalExperimentWriteBatchLimitOverride('switch-target-visible', 4)).toBe(
      24 * 1024,
    );
  });

  it('normalizes multi-visible pressure scaling overrides', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      multiVisiblePressureMinimumVisibleCount: 4,
      multiVisiblePressureNonTargetVisibleFrameBudgetScales: {
        critical: 0.25,
        elevated: 0.5,
      },
      multiVisiblePressureWriteBatchLimitScales: {
        'visible-background': {
          critical: 0.25,
          elevated: 0.5,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalPerformanceExperimentConfig()).toEqual(
      expect.objectContaining({
        multiVisiblePressureMinimumVisibleCount: 4,
        multiVisiblePressureNonTargetVisibleFrameBudgetScales: {
          critical: 0.25,
          elevated: 0.5,
        },
        multiVisiblePressureWriteBatchLimitScales: {
          'visible-background': {
            critical: 0.25,
            elevated: 0.5,
          },
        },
      }),
    );
    expect(hasTerminalFramePressureResponsiveExperimentConfig()).toBe(true);
    expect(
      getTerminalExperimentMultiVisiblePressureNonTargetVisibleFrameBudgetScale(2, 'critical'),
    ).toBeNull();
    expect(
      getTerminalExperimentMultiVisiblePressureNonTargetVisibleFrameBudgetScale(4, 'elevated'),
    ).toBe(0.5);
    expect(
      getTerminalExperimentMultiVisiblePressureWriteBatchLimitScale(
        'visible-background',
        4,
        'critical',
      ),
    ).toBe(0.25);
    expect(
      getTerminalExperimentMultiVisiblePressureWriteBatchLimitScale(
        'active-visible',
        4,
        'critical',
      ),
    ).toBeNull();
  });

  it('normalizes visible-count overrides and ignores invalid keys', () => {
    const rawVisibleCountLaneFrameBudgetOverrides: Record<string, unknown> = {
      '0': {
        visible: 1,
      },
      '02': {
        visible: 24 * 1024,
      },
      nope: {
        visible: 1,
      },
    };
    const rawVisibleCountNonTargetVisibleFrameBudgetOverrides: Record<string, unknown> = {
      '4': 12 * 1024,
      '-1': 1,
    };
    const rawVisibleCountSwitchTargetReserveBytes: Record<string, unknown> = {
      '1': 8 * 1024,
      '1.5': 16 * 1024,
    };
    const rawVisibleCountSwitchPostInputReadyEchoGraceMs: Record<string, unknown> = {
      '2': 160,
      nope: 120,
    };
    const rawVisibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes: Record<
      string,
      unknown
    > = {
      '1': 6 * 1024,
      nope: 12 * 1024,
    };
    const rawVisibleCountWriteBatchLimitOverrides: Record<string, unknown> = {
      '04': {
        'visible-background': 6 * 1024,
      },
    };
    const rawVisibleCountDrainBudgetOverrides: Record<string, unknown> = {
      '4': {
        focused: 18 * 1024,
      },
    };
    const rawVisibleCountDrainCandidateLimitOverrides: Record<string, unknown> = {
      '2': {
        'visible-background': 2,
      },
    };

    const rawExperimentConfig = {
      visibleCountDrainBudgetOverrides: rawVisibleCountDrainBudgetOverrides,
      visibleCountDrainCandidateLimitOverrides: rawVisibleCountDrainCandidateLimitOverrides,
      visibleCountLaneFrameBudgetOverrides: rawVisibleCountLaneFrameBudgetOverrides,
      visibleCountNonTargetVisibleFrameBudgetOverrides:
        rawVisibleCountNonTargetVisibleFrameBudgetOverrides,
      visibleCountPressureNonTargetVisibleFrameBudgetScales: {
        '4': {
          critical: 0.25,
        },
        nope: {
          elevated: 0.5,
        },
      },
      visibleCountPressureDrainBudgetScales: {
        '4': {
          focused: {
            critical: 1.5,
          },
        },
      },
      visibleCountPressureWriteBatchLimitScales: {
        '4': {
          'visible-background': {
            elevated: 0.5,
          },
        },
        '-1': {
          focused: {
            critical: 0.25,
          },
        },
      },
      visibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes:
        rawVisibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes,
      visibleCountSwitchPostInputReadyEchoGraceMs: rawVisibleCountSwitchPostInputReadyEchoGraceMs,
      visibleCountSwitchTargetReserveBytes: rawVisibleCountSwitchTargetReserveBytes,
      visibleCountWriteBatchLimitOverrides: rawVisibleCountWriteBatchLimitOverrides,
    } as unknown as NonNullable<typeof window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__>;

    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = rawExperimentConfig;
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalPerformanceExperimentConfig()).toEqual(
      expect.objectContaining({
        visibleCountDrainBudgetOverrides: {
          '4': {
            focused: 18 * 1024,
          },
        },
        visibleCountDrainCandidateLimitOverrides: {
          '2': {
            'visible-background': 2,
          },
        },
        visibleCountLaneFrameBudgetOverrides: {
          '2': {
            visible: 24 * 1024,
          },
        },
        visibleCountNonTargetVisibleFrameBudgetOverrides: {
          '4': 12 * 1024,
        },
        visibleCountPressureNonTargetVisibleFrameBudgetScales: {
          '4': {
            critical: 0.25,
          },
        },
        visibleCountPressureDrainBudgetScales: {
          '4': {
            focused: {
              critical: 1.5,
            },
          },
        },
        visibleCountPressureWriteBatchLimitScales: {
          '4': {
            'visible-background': {
              elevated: 0.5,
            },
          },
        },
        visibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes: {
          '1': 6 * 1024,
        },
        visibleCountSwitchPostInputReadyEchoGraceMs: {
          '2': 160,
        },
        visibleCountSwitchTargetReserveBytes: {
          '1': 8 * 1024,
        },
        visibleCountWriteBatchLimitOverrides: {
          '4': {
            'visible-background': 6 * 1024,
          },
        },
      }),
    );
  });

  it('prefers visible-count overrides over density and global fallbacks', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      drainBudgetOverrides: {
        focused: 14 * 1024,
      },
      drainCandidateLimitOverrides: {
        'visible-background': 3,
      },
      visibilityAwareDrainBudgetOverrides: {
        few: {
          focused: 16 * 1024,
        },
      },
      visibilityAwareDrainCandidateLimitOverrides: {
        few: {
          'visible-background': 2,
        },
      },
      visibleCountDrainBudgetOverrides: {
        '4': {
          focused: 20 * 1024,
        },
      },
      visibleCountDrainCandidateLimitOverrides: {
        '4': {
          'visible-background': 1,
        },
      },
      laneFrameBudgetOverrides: {
        visible: 12 * 1024,
      },
      visibilityAwareLaneFrameBudgetOverrides: {
        few: {
          visible: 16 * 1024,
        },
      },
      visibleCountLaneFrameBudgetOverrides: {
        '4': {
          visible: 20 * 1024,
        },
      },
      visibilityAwareNonTargetVisibleFrameBudgetOverrides: {
        few: 8 * 1024,
      },
      multiVisiblePressureMinimumVisibleCount: 4,
      multiVisiblePressureNonTargetVisibleFrameBudgetScales: {
        elevated: 0.5,
      },
      visibleCountPressureDrainBudgetScales: {
        '4': {
          focused: {
            critical: 1.5,
          },
        },
      },
      multiVisiblePressureWriteBatchLimitScales: {
        'visible-background': {
          critical: 0.25,
        },
      },
      visibleCountPressureNonTargetVisibleFrameBudgetScales: {
        '4': {
          elevated: 0.25,
        },
      },
      visibleCountPressureWriteBatchLimitScales: {
        '4': {
          'visible-background': {
            critical: 0.125,
          },
        },
      },
      switchPostInputReadyFirstFocusedWriteBatchLimitBytes: 12 * 1024,
      visibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes: {
        '4': 6 * 1024,
      },
      switchPostInputReadyEchoGraceMs: 120,
      visibleCountSwitchPostInputReadyEchoGraceMs: {
        '4': 180,
      },
      visibleCountNonTargetVisibleFrameBudgetOverrides: {
        '4': 6 * 1024,
      },
      visibilityAwareSwitchTargetReserveBytes: {
        few: 4 * 1024,
      },
      visibleCountSwitchTargetReserveBytes: {
        '4': 3 * 1024,
      },
      writeBatchLimitOverrides: {
        'visible-background': 10 * 1024,
      },
      visibilityAwareWriteBatchLimitOverrides: {
        few: {
          'visible-background': 9 * 1024,
        },
      },
      visibleCountWriteBatchLimitOverrides: {
        '4': {
          'visible-background': 7 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalExperimentDrainBudgetOverride('focused', 4)).toBe(20 * 1024);
    expect(getTerminalExperimentDrainCandidateLimitOverride('visible-background', 4)).toBe(1);
    expect(getTerminalExperimentLaneFrameBudgetOverride('visible', 4)).toBe(20 * 1024);
    expect(getTerminalExperimentNonTargetVisibleFrameBudgetOverride(4)).toBe(6 * 1024);
    expect(
      getTerminalExperimentVisibleCountPressureDrainBudgetScale('focused', 4, 'critical'),
    ).toBe(1.5);
    expect(
      getTerminalExperimentMultiVisiblePressureNonTargetVisibleFrameBudgetScale(4, 'elevated'),
    ).toBe(0.25);
    expect(
      getTerminalExperimentMultiVisiblePressureWriteBatchLimitScale(
        'visible-background',
        4,
        'critical',
      ),
    ).toBe(0.125);
    expect(getTerminalExperimentSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes(4)).toBe(
      6 * 1024,
    );
    expect(getTerminalExperimentSwitchTargetReserveBytes(4)).toBe(3 * 1024);
    expect(getTerminalExperimentSwitchPostInputReadyEchoGraceMs(4)).toBe(180);
    expect(getTerminalExperimentWriteBatchLimitOverride('visible-background', 4)).toBe(7 * 1024);
  });

  it('falls back from visible-count overrides to density and then global overrides', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      drainBudgetOverrides: {
        focused: 13 * 1024,
      },
      drainCandidateLimitOverrides: {
        'visible-background': 3,
      },
      visibilityAwareDrainBudgetOverrides: {
        few: {
          focused: 15 * 1024,
        },
      },
      visibilityAwareDrainCandidateLimitOverrides: {
        few: {
          'visible-background': 2,
        },
      },
      laneFrameBudgetOverrides: {
        visible: 11 * 1024,
      },
      visibilityAwareLaneFrameBudgetOverrides: {
        few: {
          visible: 15 * 1024,
        },
      },
      visibilityAwareNonTargetVisibleFrameBudgetOverrides: {
        few: 7 * 1024,
      },
      multiVisiblePressureMinimumVisibleCount: 4,
      multiVisiblePressureNonTargetVisibleFrameBudgetScales: {
        critical: 0.25,
      },
      multiVisiblePressureWriteBatchLimitScales: {
        'visible-background': {
          elevated: 0.5,
        },
      },
      visibilityAwareSwitchTargetReserveBytes: {
        few: 5 * 1024,
      },
      switchPostInputReadyEchoGraceMs: 110,
      writeBatchLimitOverrides: {
        'visible-background': 9 * 1024,
      },
      visibilityAwareWriteBatchLimitOverrides: {
        few: {
          'visible-background': 8 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalExperimentDrainBudgetOverride('focused', 2)).toBe(15 * 1024);
    expect(getTerminalExperimentDrainCandidateLimitOverride('visible-background', 2)).toBe(2);
    expect(getTerminalExperimentLaneFrameBudgetOverride('visible', 2)).toBe(15 * 1024);
    expect(getTerminalExperimentNonTargetVisibleFrameBudgetOverride(2)).toBe(7 * 1024);
    expect(getTerminalExperimentSwitchPostInputReadyEchoGraceMs(2)).toBe(110);
    expect(getTerminalExperimentSwitchTargetReserveBytes(2)).toBe(5 * 1024);
    expect(getTerminalExperimentWriteBatchLimitOverride('visible-background', 2)).toBe(8 * 1024);
    expect(
      getTerminalExperimentMultiVisiblePressureNonTargetVisibleFrameBudgetScale(2, 'critical'),
    ).toBeNull();
    expect(
      getTerminalExperimentVisibleCountPressureDrainBudgetScale('focused', 2, 'critical'),
    ).toBeNull();
    expect(
      getTerminalExperimentMultiVisiblePressureWriteBatchLimitScale(
        'visible-background',
        2,
        'elevated',
      ),
    ).toBeNull();

    expect(getTerminalExperimentDrainBudgetOverride('focused', 6)).toBe(13 * 1024);
    expect(getTerminalExperimentDrainCandidateLimitOverride('visible-background', 6)).toBe(3);
    expect(getTerminalExperimentLaneFrameBudgetOverride('visible', 6)).toBe(11 * 1024);
    expect(getTerminalExperimentNonTargetVisibleFrameBudgetOverride(6)).toBeNull();
    expect(
      getTerminalExperimentMultiVisiblePressureNonTargetVisibleFrameBudgetScale(6, 'critical'),
    ).toBe(0.25);
    expect(
      getTerminalExperimentMultiVisiblePressureWriteBatchLimitScale(
        'visible-background',
        6,
        'elevated',
      ),
    ).toBe(0.5);
    expect(getTerminalExperimentSwitchPostInputReadyEchoGraceMs(6)).toBe(110);
    expect(getTerminalExperimentSwitchTargetReserveBytes(6)).toBeNull();
    expect(getTerminalExperimentWriteBatchLimitOverride('visible-background', 6)).toBe(9 * 1024);
  });

  it('returns dense-overload overrides independently from the normal visibility overrides', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      label: 'dense-overload-reference',
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
      denseOverloadVisibleCountLaneFrameBudgetOverrides: {
        '4': {
          visible: 56 * 1024,
        },
      },
      denseOverloadVisibleCountNonTargetVisibleFrameBudgetOverrides: {
        '4': 16 * 1024,
      },
      denseOverloadVisibleCountPressureDrainBudgetScales: {
        '4': {
          focused: {
            critical: 1.5,
            elevated: 1.25,
          },
        },
      },
      denseOverloadVisibleCountPressureWriteBatchLimitScales: {
        '4': {
          focused: {
            critical: 1.5,
            elevated: 1.25,
          },
        },
      },
      denseOverloadVisibleCountSwitchTargetReserveBytes: {
        '4': 24 * 1024,
      },
      denseOverloadVisibleCountWriteBatchLimitOverrides: {
        '4': {
          'visible-background': 8 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalExperimentDenseOverloadMinimumVisibleCount()).toBe(4);
    expect(getTerminalExperimentDenseOverloadPressureFloor()).toBe('elevated');
    expect(getTerminalExperimentDenseOverloadLaneFrameBudgetOverride('visible', 4)).toBe(56 * 1024);
    expect(getTerminalExperimentDenseOverloadNonTargetVisibleFrameBudgetOverride(4)).toBe(
      16 * 1024,
    );
    expect(
      getTerminalExperimentDenseOverloadPressureDrainBudgetScale('focused', 4, 'elevated'),
    ).toBe(1.25);
    expect(
      getTerminalExperimentDenseOverloadPressureWriteBatchLimitScale('focused', 4, 'critical'),
    ).toBe(1.5);
    expect(getTerminalExperimentDenseOverloadSwitchTargetReserveBytes(4)).toBe(24 * 1024);
    expect(getTerminalExperimentDenseOverloadWriteBatchLimitOverride('visible-background', 4)).toBe(
      8 * 1024,
    );
  });
});
