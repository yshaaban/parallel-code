import { describe, expect, it } from 'vitest';

import { getPromptInputPolicy, type PromptInputFacts } from './prompt-input-policy';

const SAMPLE_COUNT = 100_000;
const P99_BUDGET_MS = 0.05;

describe('prompt input policy performance', () => {
  it('evaluates the frozen policy table within the O(1) p99 budget', () => {
    const facts = [
      {
        canonicalAgentState: 'ready',
        canonicalGeneration: 3,
        composing: false,
        control: 'local',
        hasText: true,
        sendInFlight: false,
      },
      {
        canonicalAgentState: 'awaiting-input',
        canonicalGeneration: 3,
        composing: false,
        control: 'local',
        hasText: true,
        localQuestionGeneration: 3,
        sendInFlight: false,
      },
      {
        canonicalAgentState: 'working',
        canonicalGeneration: 3,
        composing: false,
        control: 'peer',
        hasText: true,
        sendInFlight: true,
      },
    ] as const satisfies readonly PromptInputFacts[];
    const samples = new Float64Array(SAMPLE_COUNT);

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const startedAt = performance.now();
      getPromptInputPolicy(facts[index % facts.length] ?? facts[0]);
      samples[index] = performance.now() - startedAt;
    }

    samples.sort();
    const p99 = samples[Math.floor(SAMPLE_COUNT * 0.99)] ?? Number.POSITIVE_INFINITY;
    process.stdout.write(
      `prompt-input-policy samples=${SAMPLE_COUNT} p99=${p99.toFixed(6)}ms budget=${P99_BUDGET_MS}ms\n`,
    );
    expect(p99).toBeLessThan(P99_BUDGET_MS);
  });
});
