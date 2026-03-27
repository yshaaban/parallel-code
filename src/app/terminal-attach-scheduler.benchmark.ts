import { performance as nodePerformance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseBenchmarkIterationCount,
  parseBenchmarkTerminalCounts,
  roundMilliseconds,
  summarizeDurations,
  writeBenchmarkArtifact,
} from '../lib/benchmark-helpers';
import {
  registerTerminalAttachCandidate,
  resetTerminalAttachSchedulerForTests,
  type TerminalAttachRegistration,
} from './terminal-attach-scheduler';

interface AttachScenario {
  holdMs: number;
  name: string;
  getPriority: (terminalIndex: number, terminalCount: number) => number;
  reprioritize?: (
    priorities: number[],
    registrations: Array<TerminalAttachRegistration | undefined>,
    terminalCount: number,
  ) => void;
}

interface AttachBenchmarkResult {
  avgQueueWaitMs: number;
  durationMs: ReturnType<typeof summarizeDurations>;
  iterations: number;
  maxConcurrentAttaches: number;
  maxConcurrentForegroundAttaches: number;
  queueSpanMs: number;
  scenario: string;
  terminals: number;
  throughputTerminalsPerSecond: number;
  p95QueueWaitMs: number;
  firstAttachPrefix: string;
}

interface AttachTerminalState {
  attachedAtMs: number | null;
  priority: number;
  registeredAtMs: number;
  releasedAtMs: number | null;
}

const DEFAULT_ITERATIONS = 48;
const ATTACH_SCENARIOS: readonly AttachScenario[] = [
  {
    getPriority: (terminalIndex) => (terminalIndex === 0 ? 0 : 2),
    holdMs: 8,
    name: 'foreground-serialized',
  },
  {
    getPriority: () => 2,
    holdMs: 8,
    name: 'background-two-slot',
  },
  {
    getPriority: (terminalIndex, terminalCount) => {
      if (terminalIndex === terminalCount - 1) {
        return 2;
      }

      if (terminalIndex < Math.ceil(terminalCount / 3)) {
        return 0;
      }

      return 1;
    },
    holdMs: 8,
    name: 'reprioritized-pending',
    reprioritize: (priorities, registrations, terminalCount) => {
      const targetIndex = terminalCount - 1;
      if (priorities[targetIndex] === undefined) {
        return;
      }

      priorities[targetIndex] = 0;
      registrations[targetIndex]?.updatePriority();
    },
  },
];

describe('terminal-attach-scheduler benchmark', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTerminalAttachSchedulerForTests();
  });

  afterEach(() => {
    resetTerminalAttachSchedulerForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function flushAttachWaves(
    scenario: AttachScenario,
    releaseCount: () => number,
    targetReleaseCount: number,
  ): Promise<void> {
    let safetyCounter = 0;

    while (releaseCount() < targetReleaseCount) {
      if (safetyCounter > targetReleaseCount * 8 + 32) {
        throw new Error('Attach benchmark exceeded the flush safety limit');
      }

      await vi.advanceTimersByTimeAsync(scenario.holdMs);
      await Promise.resolve();
      safetyCounter += 1;
    }

    await Promise.resolve();
  }

  async function runScenario(
    scenario: AttachScenario,
    terminalCount: number,
    iterations: number,
  ): Promise<AttachBenchmarkResult> {
    const cpuDurationsMs: number[] = [];
    const queueWaitsMs: number[] = [];
    const firstAttachKeys: string[] = [];
    let maxConcurrentAttaches = 0;
    let maxConcurrentForegroundAttaches = 0;
    let queueSpanMs = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      resetTerminalAttachSchedulerForTests();
      vi.clearAllTimers();

      const priorities = Array.from({ length: terminalCount }, (_, terminalIndex) =>
        scenario.getPriority(terminalIndex, terminalCount),
      );
      const terminalStates: AttachTerminalState[] = Array.from({ length: terminalCount }, () => ({
        attachedAtMs: null,
        priority: 2,
        registeredAtMs: Date.now(),
        releasedAtMs: null,
      }));
      const registrations: Array<TerminalAttachRegistration | undefined> = [];
      let activeAttaches = 0;
      let activeForegroundAttaches = 0;
      let releaseCount = 0;
      const attachOrder: string[] = [];

      for (let terminalIndex = 0; terminalIndex < terminalCount; terminalIndex += 1) {
        const key = `${scenario.name}:${iteration}:${terminalIndex}`;
        terminalStates[terminalIndex] = {
          attachedAtMs: null,
          priority: priorities[terminalIndex] ?? 2,
          registeredAtMs: Date.now(),
          releasedAtMs: null,
        };

        const registration = registerTerminalAttachCandidate({
          attach: () => {
            const state = terminalStates[terminalIndex];
            if (!state) {
              throw new Error(`Missing attach benchmark state for terminal ${terminalIndex}`);
            }
            state.attachedAtMs = Date.now();
            activeAttaches += 1;
            if (state.priority <= 1) {
              activeForegroundAttaches += 1;
            }
            maxConcurrentAttaches = Math.max(maxConcurrentAttaches, activeAttaches);
            maxConcurrentForegroundAttaches = Math.max(
              maxConcurrentForegroundAttaches,
              activeForegroundAttaches,
            );
            attachOrder.push(key);

            setTimeout(() => {
              const currentState = terminalStates[terminalIndex];
              if (!currentState) {
                throw new Error(
                  `Missing attach benchmark release state for terminal ${terminalIndex}`,
                );
              }
              currentState.releasedAtMs = Date.now();
              activeAttaches -= 1;
              if (currentState.priority <= 1) {
                activeForegroundAttaches -= 1;
              }
              releaseCount += 1;
              registration.release();
            }, scenario.holdMs);
          },
          getPriority: () => priorities[terminalIndex] ?? 2,
          key,
          taskId: `task:${scenario.name}:${iteration}`,
        });
        registrations[terminalIndex] = registration;
      }

      scenario.reprioritize?.(priorities, registrations, terminalCount);

      const scenarioStartedAtMs = nodePerformance.now();
      await Promise.resolve();
      await flushAttachWaves(scenario, () => releaseCount, terminalCount);
      cpuDurationsMs.push(nodePerformance.now() - scenarioStartedAtMs);

      queueWaitsMs.push(
        ...terminalStates.map((state) => {
          if (state.attachedAtMs === null) {
            return 0;
          }

          return state.attachedAtMs - state.registeredAtMs;
        }),
      );

      if (terminalStates.length > 0) {
        const missingAttachment = terminalStates.find((state) => state.attachedAtMs === null);
        if (missingAttachment) {
          throw new Error('Attach benchmark completed with an unattached terminal');
        }

        const firstRegisteredAtMs = terminalStates[0]?.registeredAtMs ?? Date.now();
        const lastAttachedAtMs = terminalStates.reduce((latest, state) => {
          if (state.attachedAtMs === null) {
            return latest;
          }

          return Math.max(latest, state.attachedAtMs);
        }, firstRegisteredAtMs);
        queueSpanMs = Math.max(queueSpanMs, lastAttachedAtMs - firstRegisteredAtMs);
      }

      firstAttachKeys.push(attachOrder[0] ?? 'none');

      for (const registration of registrations) {
        registration?.unregister();
      }
    }

    const durationMs = summarizeDurations(cpuDurationsMs);
    const queueWaitSummary = summarizeDurations(queueWaitsMs);
    const throughputTerminalsPerSecond =
      queueSpanMs > 0 ? roundMilliseconds((terminalCount / queueSpanMs) * 1000) : 0;

    return {
      avgQueueWaitMs: queueWaitSummary.avgMs,
      durationMs,
      firstAttachPrefix: firstAttachKeys[0] ?? 'none',
      iterations,
      maxConcurrentAttaches,
      maxConcurrentForegroundAttaches,
      p95QueueWaitMs: queueWaitSummary.p95Ms,
      queueSpanMs: roundMilliseconds(queueSpanMs),
      scenario: scenario.name,
      terminals: terminalCount,
      throughputTerminalsPerSecond,
    };
  }

  it('measures attach queue throughput across mixed priorities and release waves', async () => {
    const terminalCounts = parseBenchmarkTerminalCounts();
    const iterations = parseBenchmarkIterationCount(DEFAULT_ITERATIONS);
    const results: AttachBenchmarkResult[] = [];

    for (const terminalCount of terminalCounts) {
      for (const scenario of ATTACH_SCENARIOS) {
        const result = await runScenario(scenario, terminalCount, iterations);
        results.push(result);
        process.stdout.write(
          `[benchmark][attach] terminals=${terminalCount} scenario=${scenario.name} avgQueueWait=${result.avgQueueWaitMs}ms p95=${result.p95QueueWaitMs}ms span=${result.queueSpanMs}ms maxActive=${result.maxConcurrentAttaches} maxForeground=${result.maxConcurrentForegroundAttaches} first=${result.firstAttachPrefix} throughput=${result.throughputTerminalsPerSecond}/s\n`,
        );
      }
    }

    await writeBenchmarkArtifact('terminal-attach-scheduler.json', {
      generatedAt: new Date().toISOString(),
      iterations,
      results,
    });

    expect(results.length).toBe(terminalCounts.length * ATTACH_SCENARIOS.length);
  });
});
