import { beforeEach, describe, expect, it } from 'vitest';

import {
  getTerminalPerformanceExperimentConfig,
  resetTerminalPerformanceExperimentConfigForTests,
} from '../lib/terminal-performance-experiments';
import {
  resetTerminalHighLoadModeForTests,
  syncTerminalHighLoadMode,
} from './terminal-high-load-mode';

describe('terminal-high-load-mode', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    resetTerminalHighLoadModeForTests();
    resetTerminalPerformanceExperimentConfigForTests();
  });

  it('updates the built-in experiment profile when the runtime mode toggles', () => {
    expect(getTerminalPerformanceExperimentConfig().label).toBe('default');

    syncTerminalHighLoadMode(true);
    expect(window.__PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__).toBe(true);
    expect(getTerminalPerformanceExperimentConfig().label).toBe('high_load_mode');

    syncTerminalHighLoadMode(false);
    expect(window.__PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__).toBe(false);
    expect(getTerminalPerformanceExperimentConfig().label).toBe('default');
  });
});
