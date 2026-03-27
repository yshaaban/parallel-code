import { describe, expect, it } from 'vitest';

import { evaluateSessionStressProfile } from '../../scripts/session-stress-profiles.mjs';

describe('session stress profiles', () => {
  it('fails closed when a required metric is missing', () => {
    const result = {
      phases: {
        output: {
          wallClockMs: 1_000,
        },
        mixed: {
          metrics: {},
        },
      },
    };

    const evaluation = evaluateSessionStressProfile('pr_smoke', result);

    expect(evaluation.pass).toBe(false);
    expect(evaluation.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actual: Number.NaN,
          label: 'mixed max skew',
          pass: false,
        }),
      ]),
    );
  });
});
