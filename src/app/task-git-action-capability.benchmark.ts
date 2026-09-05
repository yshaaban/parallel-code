import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { createTestTask } from '../test/store-test-helpers';
import { getTaskGitActionDecision } from './task-git-action-capability';

const SAMPLE_COUNT = 10_000;
const P95_BUDGET_MS = 1;

describe('task Git action capability benchmark', () => {
  it('classifies denied intents synchronously below the p95 budget', () => {
    const task = createTestTask({ projectMode: 'non-git' });
    const samples = new Float64Array(SAMPLE_COUNT);

    for (let index = 0; index < 1_000; index += 1) {
      getTaskGitActionDecision(index % 2 === 0 ? 'merge' : 'push', task, {
        projectPathAvailable: true,
      });
    }

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const startedAt = performance.now();
      const decision = getTaskGitActionDecision(index % 2 === 0 ? 'merge' : 'push', task, {
        projectPathAvailable: true,
      });
      samples[index] = performance.now() - startedAt;
      expect(decision).toMatchObject({ allowed: false, reason: 'non_git_task' });
    }

    samples.sort();
    const p95 = samples[Math.ceil(SAMPLE_COUNT * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    process.stdout.write(
      `task-git-action-capability samples=${SAMPLE_COUNT} p95=${p95.toFixed(6)}ms budget=${P95_BUDGET_MS}ms\n`,
    );
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  });
});
