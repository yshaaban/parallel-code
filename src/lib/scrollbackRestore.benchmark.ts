import { performance as nodePerformance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../electron/ipc/channels';
import {
  parseBenchmarkIterationCount,
  parseBenchmarkTerminalCounts,
  roundMilliseconds,
  summarizeDurations,
  writeBenchmarkArtifact,
} from './benchmark-helpers';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('./ipc', () => ({
  invoke: invokeMock,
}));

interface RecoveryScenario {
  kind: 'attach' | 'reconnect';
  name: string;
  spacingMs: number;
}

interface RecoveryBenchmarkResult {
  avgBatchDelayMs: number;
  avgBatchSize: number;
  batchDelayMs: ReturnType<typeof summarizeDurations>;
  batchSizeMax: number;
  batchSizeMin: number;
  batchSizeP95: number;
  batchSizeTotal: number;
  batchSizeCount: number;
  durationMs: ReturnType<typeof summarizeDurations>;
  invokeCount: number;
  kind: RecoveryScenario['kind'];
  maxPendingRequests: number;
  scenario: string;
  terminals: number;
}

const DEFAULT_ITERATIONS = 48;
const RECOVERY_SCENARIOS: readonly RecoveryScenario[] = [
  {
    kind: 'attach',
    name: 'attach-burst',
    spacingMs: 0,
  },
  {
    kind: 'attach',
    name: 'attach-staggered',
    spacingMs: 4,
  },
  {
    kind: 'reconnect',
    name: 'reconnect-burst',
    spacingMs: 0,
  },
  {
    kind: 'reconnect',
    name: 'reconnect-staggered',
    spacingMs: 4,
  },
];

describe('scrollbackRestore benchmark', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        clearTimeout,
        setTimeout,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  function summarizeBatchSizes(batchSizes: readonly number[]): {
    avg: number;
    count: number;
    max: number;
    min: number;
    p95: number;
    total: number;
  } {
    if (batchSizes.length === 0) {
      return {
        avg: 0,
        count: 0,
        max: 0,
        min: 0,
        p95: 0,
        total: 0,
      };
    }

    const sorted = [...batchSizes].sort((left, right) => left - right);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    const percentileIndex = (fraction: number): number =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ??
      0;

    return {
      avg: roundMilliseconds(total / sorted.length),
      count: sorted.length,
      max: sorted[sorted.length - 1] ?? 0,
      min: sorted[0] ?? 0,
      p95: percentileIndex(0.95),
      total,
    };
  }

  async function runScenario(
    scenario: RecoveryScenario,
    terminalCount: number,
    iterations: number,
  ): Promise<RecoveryBenchmarkResult> {
    const cpuDurationsMs: number[] = [];
    const batchDelaysMs: number[] = [];
    const batchSizes: number[] = [];
    let maxPendingRequests = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      vi.resetModules();
      invokeMock.mockReset();

      const issuedAtQueue: number[] = [];
      let unresolvedRequests = 0;

      invokeMock.mockImplementation(
        async (
          _channel: IPC,
          payload: { requests: Array<{ agentId: string; requestId: string }> },
        ) => {
          const batchIssuedAtMs = issuedAtQueue.splice(0, payload.requests.length);
          const batchStartedAtMs = Date.now();
          batchSizes.push(payload.requests.length);
          batchDelaysMs.push(batchStartedAtMs - (batchIssuedAtMs[0] ?? batchStartedAtMs));

          return payload.requests.map((request, requestIndex) => ({
            agentId: request.agentId,
            cols: 80,
            outputCursor: requestIndex,
            recovery: {
              data: null,
              kind: 'snapshot' as const,
            },
            requestId: request.requestId,
          }));
        },
      );

      const { requestAttachTerminalRecovery, requestReconnectTerminalRecovery } =
        await import('./scrollbackRestore');

      const requestFn =
        scenario.kind === 'attach'
          ? requestAttachTerminalRecovery
          : requestReconnectTerminalRecovery;

      const startedAtMs = nodePerformance.now();
      const pendingPromises: Array<Promise<unknown>> = [];

      for (let terminalIndex = 0; terminalIndex < terminalCount; terminalIndex += 1) {
        issuedAtQueue.push(Date.now());
        unresolvedRequests += 1;
        maxPendingRequests = Math.max(maxPendingRequests, unresolvedRequests);

        const promise = requestFn(`agent:${iteration}:${terminalIndex}`, {
          outputCursor: terminalIndex,
        }).finally(() => {
          unresolvedRequests -= 1;
        });
        pendingPromises.push(promise);

        if (scenario.spacingMs > 0 && terminalIndex < terminalCount - 1) {
          await vi.advanceTimersByTimeAsync(scenario.spacingMs);
        }
      }

      await vi.advanceTimersByTimeAsync(25);
      await Promise.all(pendingPromises);
      cpuDurationsMs.push(nodePerformance.now() - startedAtMs);
    }

    const batchSizeSummary = summarizeBatchSizes(batchSizes);
    const batchDelaySummary = summarizeDurations(batchDelaysMs);
    const durationSummary = summarizeDurations(cpuDurationsMs);

    return {
      avgBatchDelayMs: batchDelaySummary.avgMs,
      avgBatchSize: batchSizeSummary.avg,
      batchDelayMs: batchDelaySummary,
      batchSizeCount: batchSizeSummary.count,
      batchSizeMax: batchSizeSummary.max,
      batchSizeMin: batchSizeSummary.min,
      batchSizeP95: batchSizeSummary.p95,
      batchSizeTotal: batchSizeSummary.total,
      durationMs: durationSummary,
      invokeCount: batchSizeSummary.count,
      kind: scenario.kind,
      maxPendingRequests,
      scenario: scenario.name,
      terminals: terminalCount,
    };
  }

  it('measures attach and reconnect batch throughput across bursty and staggered requests', async () => {
    const terminalCounts = parseBenchmarkTerminalCounts();
    const iterations = parseBenchmarkIterationCount(DEFAULT_ITERATIONS);
    const results: RecoveryBenchmarkResult[] = [];

    for (const terminalCount of terminalCounts) {
      for (const scenario of RECOVERY_SCENARIOS) {
        const result = await runScenario(scenario, terminalCount, iterations);
        results.push(result);
        process.stdout.write(
          `[benchmark][scrollback] kind=${scenario.kind} terminals=${terminalCount} scenario=${scenario.name} invokes=${result.invokeCount} avgBatchSize=${result.avgBatchSize} avgBatchDelay=${result.avgBatchDelayMs}ms p95BatchDelay=${result.batchDelayMs.p95Ms}ms maxPending=${result.maxPendingRequests} avgCpu=${result.durationMs.avgMs}ms\n`,
        );
      }
    }

    await writeBenchmarkArtifact('scrollback-restore.json', {
      generatedAt: new Date().toISOString(),
      iterations,
      results,
    });

    expect(results.length).toBe(terminalCounts.length * RECOVERY_SCENARIOS.length);
  });
});
