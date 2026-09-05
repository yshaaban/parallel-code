import { describe, expect, it } from 'vitest';

import { evaluateTaskPromptInputAdmission } from './task-prompt-input-admission.js';

const SAMPLE_COUNT = 100_000;
const P99_BUDGET_MS = 0.2;

describe('task prompt input admission performance', () => {
  it('keeps exact generation/version/question checks within the O(1) budget', () => {
    const expectation = {
      agentGeneration: 2,
      agentId: 'agent-1',
      controllerId: 'client-1',
      leaseGeneration: 3,
      leaseOwnerId: 'owner-1',
      purpose: 'ordinary-post-start' as const,
      supervisionVersion: 5,
      taskId: 'task-1',
    };
    const current = {
      agentGeneration: 2,
      state: 'idle-at-prompt' as const,
      supervisionVersion: 5,
      taskId: 'task-1',
    };
    const samples = new Float64Array(SAMPLE_COUNT);

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const startedAt = performance.now();
      evaluateTaskPromptInputAdmission(expectation, current, true, false);
      samples[index] = performance.now() - startedAt;
    }

    samples.sort();
    const p99 = samples[Math.floor(SAMPLE_COUNT * 0.99)] ?? Number.POSITIVE_INFINITY;
    process.stdout.write(
      `task-prompt-input-admission samples=${SAMPLE_COUNT} p99=${p99.toFixed(6)}ms budget=${P99_BUDGET_MS}ms\n`,
    );
    expect(p99).toBeLessThan(P99_BUDGET_MS);
  });
});
