import { performance as nodePerformance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseBenchmarkIterationCount,
  parseBenchmarkTerminalCounts,
  summarizeDurations,
  writeBenchmarkArtifact,
} from '../lib/benchmark-helpers';
import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from './runtime-diagnostics';
import {
  registerTerminalOutputCandidate,
  resetTerminalOutputSchedulerForTests,
} from './terminal-output-scheduler';

interface SchedulerScenario {
  getPriority: (
    terminalIndex: number,
    terminalCount: number,
  ) => 'focused' | 'active-visible' | 'hidden';
  isBusy: (terminalIndex: number, terminalCount: number) => boolean;
  name: string;
  pendingBytes: number;
}

interface SchedulerBenchmarkResult {
  avgScannedCandidatesPerScan: number;
  diagnostics: ReturnType<typeof getRendererRuntimeDiagnosticsSnapshot>['terminalOutputScheduler'];
  durationMs: ReturnType<typeof summarizeDurations>;
  iterations: number;
  scenario: string;
  terminals: number;
}

const DEFAULT_ITERATIONS = 120;
const SCHEDULER_SCENARIOS: readonly SchedulerScenario[] = [
  {
    getPriority: () => 'focused',
    isBusy: (terminalIndex) => terminalIndex === 0,
    name: 'focused-single-busy',
    pendingBytes: 8 * 1024,
  },
  {
    getPriority: (terminalIndex) => {
      return terminalIndex % 3 === 0 ? 'active-visible' : 'hidden';
    },
    isBusy: (terminalIndex, terminalCount) =>
      terminalIndex < Math.max(1, Math.ceil(terminalCount / 4)),
    name: 'visible-quarter-busy',
    pendingBytes: 16 * 1024,
  },
  {
    getPriority: () => 'hidden',
    isBusy: () => true,
    name: 'hidden-all-busy',
    pendingBytes: 8 * 1024,
  },
  {
    getPriority: (terminalIndex, terminalCount) => {
      if (terminalIndex === 0) {
        return 'focused';
      }
      if (terminalIndex < Math.ceil(terminalCount / 3)) {
        return 'active-visible';
      }
      return 'hidden';
    },
    isBusy: () => true,
    name: 'mixed-priority-all-busy',
    pendingBytes: 12 * 1024,
  },
];

describe('terminal-output-scheduler benchmark', () => {
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  let animationFrameCallbacks: Array<FrameRequestCallback | undefined> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    animationFrameCallbacks = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length - 1;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((index: number) => {
        animationFrameCallbacks[index] = undefined;
      }),
    );
    resetRendererRuntimeDiagnostics();
    resetTerminalOutputSchedulerForTests();
  });

  afterEach(() => {
    resetTerminalOutputSchedulerForTests();
    resetRendererRuntimeDiagnostics();
    vi.useRealTimers();
    animationFrameCallbacks = [];
    vi.unstubAllGlobals();
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    globalThis.performance = originalPerformance;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  function flushScheduledWork(): void {
    let safetyCounter = 0;

    while (safetyCounter < 2_000) {
      let didWork = false;

      while (animationFrameCallbacks.length > 0) {
        const callback = animationFrameCallbacks.shift();
        if (!callback) {
          continue;
        }
        callback(16);
        didWork = true;
      }

      if (vi.getTimerCount() > 0) {
        vi.runOnlyPendingTimers();
        didWork = true;
      }

      if (!didWork) {
        return;
      }

      safetyCounter += 1;
    }

    throw new Error('Scheduler benchmark exceeded the flush safety limit');
  }

  function runScenario(
    scenario: SchedulerScenario,
    terminalCount: number,
    iterations: number,
  ): SchedulerBenchmarkResult {
    const pendingBytesByKey = new Map<string, number>();
    const registrations = Array.from({ length: terminalCount }, (_, terminalIndex) => {
      const key = `${scenario.name}:${terminalIndex}`;
      pendingBytesByKey.set(key, 0);
      return registerTerminalOutputCandidate(
        key,
        () => scenario.getPriority(terminalIndex, terminalCount),
        () => pendingBytesByKey.get(key) ?? 0,
        (maxBytes) => {
          const pendingBytes = pendingBytesByKey.get(key) ?? 0;
          const drainedBytes = Math.min(maxBytes, pendingBytes);
          pendingBytesByKey.set(key, pendingBytes - drainedBytes);
          return drainedBytes;
        },
      );
    });

    const busyIndexes = Array.from(
      { length: terminalCount },
      (_, terminalIndex) => terminalIndex,
    ).filter((terminalIndex) => scenario.isBusy(terminalIndex, terminalCount));
    const durationsMs: number[] = [];

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      for (const busyIndex of busyIndexes) {
        pendingBytesByKey.set(`${scenario.name}:${busyIndex}`, scenario.pendingBytes);
      }

      const startedAtMs = nodePerformance.now();
      for (const busyIndex of busyIndexes) {
        registrations[busyIndex]?.requestDrain();
      }
      flushScheduledWork();
      durationsMs.push(nodePerformance.now() - startedAtMs);
    }

    const diagnostics = getRendererRuntimeDiagnosticsSnapshot().terminalOutputScheduler;
    for (const registration of registrations) {
      registration.unregister();
    }

    return {
      avgScannedCandidatesPerScan:
        diagnostics.scanCalls > 0 ? diagnostics.scannedCandidates / diagnostics.scanCalls : 0,
      diagnostics,
      durationMs: summarizeDurations(durationsMs),
      iterations,
      scenario: scenario.name,
      terminals: terminalCount,
    };
  }

  it('measures scan and drain cost across many-terminal scenarios', async () => {
    const terminalCounts = parseBenchmarkTerminalCounts();
    const iterations = parseBenchmarkIterationCount(DEFAULT_ITERATIONS);
    const results: SchedulerBenchmarkResult[] = [];

    for (const terminalCount of terminalCounts) {
      for (const scenario of SCHEDULER_SCENARIOS) {
        resetRendererRuntimeDiagnostics();
        resetTerminalOutputSchedulerForTests();
        const result = runScenario(scenario, terminalCount, iterations);
        results.push(result);
        process.stdout.write(
          `[benchmark][scheduler] terminals=${terminalCount} scenario=${scenario.name} avg=${result.durationMs.avgMs}ms p95=${result.durationMs.p95Ms}ms scanned/scan=${result.avgScannedCandidatesPerScan.toFixed(1)}\n`,
        );
      }
    }

    await writeBenchmarkArtifact('terminal-output-scheduler.json', {
      generatedAt: new Date().toISOString(),
      iterations,
      results,
    });

    expect(results.length).toBe(terminalCounts.length * SCHEDULER_SCENARIOS.length);
  });
});
