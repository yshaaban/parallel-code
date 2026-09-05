import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import {
  AGENT_RESUME_FAILURE_OUTPUT_MAX_BYTES,
  classifyAgentResumeFallback,
  createBoundedAgentResumeExitFacts,
  type AgentResumeExitFacts,
} from './agent-resume.js';

const CLASSIFIER_P99_BUDGET_MS = 1;
const CLASSIFIER_REFERENCE_SAMPLE_COUNT = 100_000;
const RETAINED_ALLOCATION_BUDGET_BYTES = 32 * 1_024;
const UTF8_ENCODER = new TextEncoder();

const CAPABILITY = Object.freeze({
  resume_failure_classifier: 'claude-no-conversation-v1' as const,
  resume_failure_fallback: 'fresh-start' as const,
});

interface ClassifierFixture {
  facts: AgentResumeExitFacts;
  label: string;
  samples: number;
  sourceBytes: number;
}

function percentile(samples: Float64Array, percentileValue: number): number {
  samples.sort();
  return (
    samples[Math.max(0, Math.ceil(samples.length * percentileValue) - 1)] ??
    Number.POSITIVE_INFINITY
  );
}

function createFixture(label: string, sourceBytes: number, samples: number): ClassifierFixture {
  const finalFrame =
    '\n\u001b[2K\r\u001b[31mNo conversation found to continue\u001b[0m\n' +
    'Run claude without --continue to start a new conversation\n';
  const prefixBytes = Math.max(0, sourceBytes - UTF8_ENCODER.encode(finalFrame).byteLength);
  const output = `${'x'.repeat(prefixBytes)}${finalFrame}`;
  return {
    facts: {
      exitCode: 1,
      lastOutput: [output],
      resumed: true,
      signal: null,
    },
    label,
    samples,
    sourceBytes: UTF8_ENCODER.encode(output).byteLength,
  };
}

function measureClassifier(fixture: ClassifierFixture): number {
  for (let index = 0; index < 1_000; index += 1) {
    classifyAgentResumeFallback(CAPABILITY, fixture.facts);
  }

  const samples = new Float64Array(fixture.samples);
  for (let index = 0; index < fixture.samples; index += 1) {
    const startedAt = performance.now();
    const decision = classifyAgentResumeFallback(CAPABILITY, fixture.facts);
    samples[index] = performance.now() - startedAt;
    if (decision.kind !== 'eligible') {
      throw new Error(`${fixture.label} classifier fixture became ineligible`);
    }
  }
  return percentile(samples, 0.99);
}

describe('agent resume classifier performance', () => {
  it('classifies bounded ANSI/redraw tails within the 1 ms p99 gate', () => {
    const fixtures = [
      createFixture('1k', 1_024, 20_000),
      createFixture(
        '16k',
        AGENT_RESUME_FAILURE_OUTPUT_MAX_BYTES,
        CLASSIFIER_REFERENCE_SAMPLE_COUNT,
      ),
      createFixture('oversized', AGENT_RESUME_FAILURE_OUTPUT_MAX_BYTES * 10, 20_000),
    ];

    const scorecard = fixtures.map((fixture) => ({
      fixture,
      p99Ms: measureClassifier(fixture),
    }));

    process.stdout.write(
      `agent-resume-classifier ${scorecard
        .map(
          ({ fixture, p99Ms }) =>
            `${fixture.label}:samples=${fixture.samples},source=${fixture.sourceBytes}B,p99=${p99Ms.toFixed(6)}ms`,
        )
        .join(' ')} budget=${CLASSIFIER_P99_BUDGET_MS}ms\n`,
    );

    expect(scorecard.find(({ fixture }) => fixture.label === '16k')?.fixture.samples).toBe(
      CLASSIFIER_REFERENCE_SAMPLE_COUNT,
    );
    for (const { p99Ms } of scorecard) {
      expect(p99Ms).toBeLessThan(CLASSIFIER_P99_BUDGET_MS);
    }
  });

  it('retains one bounded tail comfortably inside the 32 KiB per-call envelope', () => {
    const fixture = createFixture(
      'retained-allocation',
      AGENT_RESUME_FAILURE_OUTPUT_MAX_BYTES * 10,
      1,
    );
    const bounded = createBoundedAgentResumeExitFacts(fixture.facts);
    const retainedTailBytes = UTF8_ENCODER.encode(bounded.lastOutput[0] ?? '').byteLength;
    // The returned object adds four scalar fields around this sole retained payload. Reserve a
    // conservative 1 KiB for that framing instead of using process heap deltas, which are GC-noisy.
    const retainedAllocationEnvelopeBytes = retainedTailBytes + 1_024;

    process.stdout.write(
      `agent-resume-retained-allocation source=${fixture.sourceBytes}B ` +
        `tail=${retainedTailBytes}B envelope=${retainedAllocationEnvelopeBytes}B ` +
        `budget=${RETAINED_ALLOCATION_BUDGET_BYTES}B\n`,
    );

    expect(bounded.lastOutput).toHaveLength(1);
    expect(retainedTailBytes).toBeLessThanOrEqual(AGENT_RESUME_FAILURE_OUTPUT_MAX_BYTES);
    expect(retainedAllocationEnvelopeBytes).toBeLessThan(RETAINED_ALLOCATION_BUDGET_BYTES);
  });
});
