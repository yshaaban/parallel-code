import { describe, expect, it } from 'vitest';

import {
  formatScorecardSummaryMarkdown,
  parseScorecardSummaryArgs,
  summarizeScorecardRuns,
} from '../../scripts/performance-scorecard-summary.mjs';

function createRun(values: { inputP95: number; launchMs: number }): {
  artifactBaseName: string;
  completedAt: string;
  environment: { commit: string };
  metrics: Array<{
    budgetMs?: number;
    journey: string;
    name: string;
    unit: 'ms';
    value: number;
  }>;
  profile: 'smoke';
  startedAt: string;
} {
  return {
    artifactBaseName: `run-${values.launchMs}`,
    completedAt: '2026-05-09T00:00:01.000Z',
    environment: { commit: 'abc123' },
    metrics: [
      {
        budgetMs: 1_500,
        journey: 'browser session launch',
        name: 'open to selected terminal interactive',
        unit: 'ms',
        value: values.launchMs,
      },
      {
        journey: 'terminal typing under browser/server transport',
        name: 'trace count',
        unit: 'count',
        value: 3,
      },
      {
        budgetMs: 75,
        journey: 'terminal typing under browser/server transport',
        name: 'end-to-end p95',
        unit: 'ms',
        value: values.inputP95,
      },
    ],
    profile: 'smoke',
    startedAt: '2026-05-09T00:00:00.000Z',
  };
}

describe('performance scorecard summary', () => {
  it('parses profile and latest-count options', () => {
    expect(parseScorecardSummaryArgs(['--profile', 'smoke', '--latest', '5'])).toEqual({
      latest: 5,
      profile: 'smoke',
    });
  });

  it('summarizes p50 and p95 by journey metric', () => {
    const summary = summarizeScorecardRuns([
      createRun({ inputP95: 30, launchMs: 1_000 }),
      createRun({ inputP95: 40, launchMs: 1_400 }),
      createRun({ inputP95: 90, launchMs: 1_800 }),
    ]);

    expect(summary.runCount).toBe(3);
    expect(summary.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          journey: 'browser session launch',
          max: 1_800,
          name: 'open to selected terminal interactive',
          p50: 1_400,
          p95: 1_800,
          status: 'provisional-fail',
        }),
        expect.objectContaining({
          journey: 'terminal typing under browser/server transport',
          max: 90,
          name: 'end-to-end p95',
          p50: 40,
          p95: 90,
          status: 'provisional-fail',
        }),
        expect.objectContaining({
          journey: 'terminal typing under browser/server transport',
          name: 'trace count',
          status: 'unbudgeted',
        }),
      ]),
    );
  });

  it('formats a markdown table for scorecard review', () => {
    const summary = summarizeScorecardRuns([createRun({ inputP95: 30, launchMs: 1_000 })]);
    const markdown = formatScorecardSummaryMarkdown(summary);

    expect(markdown).toContain(
      '| Journey | Metric | Samples | p50 | p95 | Max | Budget | Status |',
    );
    expect(markdown).toContain('browser session launch');
    expect(markdown).toContain('1000.00ms');
  });
});
