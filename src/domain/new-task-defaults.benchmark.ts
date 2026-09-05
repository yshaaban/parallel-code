import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { copyNewTaskDefaults } from './new-task-defaults';

describe('new task default sampling benchmark', () => {
  it('copies the two-field dialog snapshot in under 0.1 ms on average', () => {
    const defaults = { skipPermissions: false, stepsTracking: true };
    const iterations = 250_000;

    for (let index = 0; index < 10_000; index += 1) {
      copyNewTaskDefaults(defaults);
    }

    let observedTrueValues = 0;
    const startedAt = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      const sample = copyNewTaskDefaults(defaults);
      observedTrueValues += Number(sample.stepsTracking);
    }
    const averageDurationMs = (performance.now() - startedAt) / iterations;

    expect(observedTrueValues).toBe(iterations);
    expect(averageDurationMs).toBeLessThan(0.1);
  });
});
