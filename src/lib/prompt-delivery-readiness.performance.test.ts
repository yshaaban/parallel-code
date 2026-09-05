import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { classifyPromptDeliveryEvidence } from './prompt-delivery-readiness.js';

describe('prompt delivery readiness performance', () => {
  it('caps a 64 KiB fixture and classifies below the 2 ms p99 budget', () => {
    const tail = `${'startup output\n'.repeat(4_700)}\n❯`.slice(-65_536);
    const samples: number[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      const startedAt = performance.now();
      const result = classifyPromptDeliveryEvidence({
        generation: 1,
        lastOutputAtMs: 0,
        nowMs: 2_000,
        previousReadyCandidate: {
          generation: 1,
          normalizedFrameFingerprint: '',
          observedAtMs: 1_000,
        },
        supervisionState: 'idle-at-prompt',
        tail,
      });
      samples.push(performance.now() - startedAt);
      expect(result.cappedByteLength).toBeLessThanOrEqual(65_536);
    }
    samples.sort((left, right) => left - right);
    const p99 = samples[Math.floor(samples.length * 0.99)] ?? Number.POSITIVE_INFINITY;
    console.warn(
      `prompt-delivery-readiness samples=${samples.length} p99=${p99.toFixed(3)}ms bytes=${new TextEncoder().encode(tail).length}`,
    );
    expect(p99).toBeLessThan(2);
  });
});
