import { describe, expect, it } from 'vitest';

import {
  MERGE_PROGRESS_SCHEMA_VERSION,
  advanceCompletedMergeProgress,
  type MergeProgressSnapshot,
} from './task-merge';

const SAMPLE_COUNT = 100_000;
const P99_BUDGET_MS = 0.1;
const SNAPSHOT_BUDGET_BYTES = 256;

function percentile(sorted: number[], percentileValue: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentileValue))] ?? 0;
}

describe('merge progress performance', () => {
  it('keeps the pure reducer and encoded snapshot within their fixed budgets', () => {
    let snapshot: MergeProgressSnapshot = {
      schemaVersion: MERGE_PROGRESS_SCHEMA_VERSION,
      version: 0,
      dateKey: '2026-08-04',
      tasksToday: 0,
      linesAdded: 0,
      linesRemoved: 0,
      updatedAt: '2026-08-04T00:00:00.000Z',
    };
    const committedAt = new Date('2026-08-04T00:00:00.000Z');
    const samples = new Array<number>(SAMPLE_COUNT);

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const startedAt = performance.now();
      snapshot = advanceCompletedMergeProgress(snapshot, {
        committedAt,
        linesAdded: index % 7,
        linesRemoved: index % 3,
      });
      samples[index] = performance.now() - startedAt;
    }

    samples.sort((left, right) => left - right);
    const p99Ms = percentile(samples, 0.99);
    const encodedBytes = Buffer.byteLength(JSON.stringify(snapshot));
    process.stdout.write(
      `merge-progress-reducer samples=${SAMPLE_COUNT} p99=${p99Ms.toFixed(6)}ms budget=${P99_BUDGET_MS}ms snapshot=${encodedBytes}B snapshotBudget=${SNAPSHOT_BUDGET_BYTES}B\n`,
    );
    expect(p99Ms).toBeLessThan(P99_BUDGET_MS);
    expect(encodedBytes).toBeLessThan(SNAPSHOT_BUDGET_BYTES);
  });
});
