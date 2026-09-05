import { describe, expect, it } from 'vitest';

import {
  ABSOLUTE_RENDERER_MAIN_GZIP_BUDGET_BYTES,
  INTEGRATED_RENDERER_MAIN_GZIP_BASELINE_BYTES,
  INTEGRATED_RENDERER_MAIN_GZIP_BUDGET_BYTES,
  INTEGRATED_RENDERER_MAIN_GZIP_DRIFT_BUDGET_BYTES,
  measureFreshRendererMainBundle,
} from './renderer-main-bundle';

// Three-run median from the exact Node 24.19.0/npm 11.17.0 dependency target build before D02.
const HISTORICAL_PRE_D02_MAIN_GZIP_BYTES = 212_701;
const HISTORICAL_D02_DELTA_BUDGET_BYTES = 1_024;
const HISTORICAL_D02_INVESTIGATION_THRESHOLD_BYTES = 512;

describe('prompt question bundle budget', () => {
  it('keeps the final integrated renderer within its shared regression budget', async () => {
    const measurement = await measureFreshRendererMainBundle();
    const integratedDeltaBytes =
      measurement.gzipBytes - INTEGRATED_RENDERER_MAIN_GZIP_BASELINE_BYTES;
    process.stdout.write(
      `${[
        'prompt-question-bundle',
        `entry=${measurement.entryRelativePath}`,
        `current=${measurement.gzipBytes}B`,
        `integrationBaseline=${INTEGRATED_RENDERER_MAIN_GZIP_BASELINE_BYTES}B`,
        `integrationDelta=${integratedDeltaBytes}B`,
        `integrationDriftBudget=${INTEGRATED_RENDERER_MAIN_GZIP_DRIFT_BUDGET_BYTES}B`,
        `historicalPreD02=${HISTORICAL_PRE_D02_MAIN_GZIP_BYTES}B`,
        `historicalD02DeltaBudget=${HISTORICAL_D02_DELTA_BUDGET_BYTES}B`,
        `historicalInvestigationThreshold=${HISTORICAL_D02_INVESTIGATION_THRESHOLD_BYTES}B`,
        'historicalAttribution=accepted-in-isolation-not-recomputed-from-final-bundle',
      ].join(' ')}\n`,
    );

    expect(measurement.gzipBytes).toBeLessThan(ABSOLUTE_RENDERER_MAIN_GZIP_BUDGET_BYTES);
    expect(measurement.gzipBytes).toBeLessThanOrEqual(INTEGRATED_RENDERER_MAIN_GZIP_BUDGET_BYTES);
  });
});
