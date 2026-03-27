import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getTerminalOutputDrainCandidateLimit,
  getTerminalOutputDrainBudget,
  getTerminalOutputPriority,
  getTerminalOutputPriorityOrder,
} from './terminal-output-priority';
import { resetTerminalPerformanceExperimentConfigForTests } from './terminal-performance-experiments';

describe('terminal-output-priority', () => {
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

  it('prioritizes focused terminals ahead of switch targets and keeps hidden switch targets hidden', () => {
    expect(
      getTerminalOutputPriority({
        isActiveTask: true,
        isFocused: true,
        isRestoring: false,
        isSwitchTarget: true,
        isVisible: true,
      }),
    ).toBe('focused');

    expect(
      getTerminalOutputPriority({
        isActiveTask: false,
        isFocused: false,
        isRestoring: false,
        isSwitchTarget: true,
        isVisible: true,
      }),
    ).toBe('switch-target-visible');

    expect(
      getTerminalOutputPriority({
        isActiveTask: false,
        isFocused: false,
        isRestoring: true,
        isSwitchTarget: true,
        isVisible: false,
      }),
    ).toBe('hidden');
  });

  it('orders switch-target-visible ahead of other visible priorities', () => {
    expect(getTerminalOutputPriorityOrder('focused')).toBeLessThan(
      getTerminalOutputPriorityOrder('switch-target-visible'),
    );
    expect(getTerminalOutputPriorityOrder('switch-target-visible')).toBeLessThan(
      getTerminalOutputPriorityOrder('active-visible'),
    );
    expect(getTerminalOutputDrainBudget('switch-target-visible')).toBeGreaterThan(
      getTerminalOutputDrainBudget('active-visible'),
    );
  });

  it('prefers exact visible-count drain budgets over density-aware budgets', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibilityAwareDrainBudgetOverrides: {
        few: {
          focused: 20 * 1024,
        },
      },
      visibleCountDrainBudgetOverrides: {
        '4': {
          focused: 24 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    expect(getTerminalOutputDrainBudget('focused', 4)).toBe(24 * 1024);
    expect(getTerminalOutputDrainBudget('focused', 2)).toBe(20 * 1024);
  });

  it('prefers exact visible-count candidate limits over density-aware limits', () => {
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

    expect(getTerminalOutputDrainCandidateLimit('visible-background', 4)).toBe(2);
    expect(getTerminalOutputDrainCandidateLimit('visible-background', 2)).toBe(1);
  });
});
