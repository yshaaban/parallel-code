import { performance as nodePerformance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseBenchmarkIterationCount,
  parseBenchmarkTerminalCounts,
  summarizeDurations,
  writeBenchmarkArtifact,
} from '../../lib/benchmark-helpers';
import { createBulkTextChunks, createStatuslineChunks } from '../../lib/terminal-workload-fixtures';
import {
  createTerminalOutputPipeline,
  type TerminalOutputPipeline,
} from './terminal-output-pipeline';

interface HistoryScenario {
  buildChunks: (terminalIndex: number) => Uint8Array[];
  name: string;
}

interface HistoryBenchmarkResult {
  appendMs: ReturnType<typeof summarizeDurations>;
  flattenMs: ReturnType<typeof summarizeDurations>;
  retainedBytes: number;
  scenario: string;
  terminals: number;
}

const HISTORY_SCENARIOS: readonly HistoryScenario[] = [
  {
    buildChunks: (terminalIndex) =>
      createBulkTextChunks({
        label: `history:bulk:${terminalIndex}`,
        paragraphBytes: 8_192,
        paragraphCount: 16,
      }),
    name: 'bulk-text-history',
  },
  {
    buildChunks: (terminalIndex) =>
      createStatuslineChunks({
        footerTopRow: 20,
        frameCount: 96,
        label: `history:status:${terminalIndex}`,
        splitSequences: true,
      }),
    name: 'statusline-history',
  },
];

const DEFAULT_ITERATIONS = 8;

interface HistoryHarness {
  pipeline: TerminalOutputPipeline;
}

describe('terminal-output-history benchmark', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: globalThis,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, 'window');
  });

  function createHistoryHarness(taskId: string, agentId: string): HistoryHarness {
    const term = {
      write: (_chunk: Uint8Array, callback: () => void) => {
        callback();
      },
    };

    return {
      pipeline: createTerminalOutputPipeline({
        agentId,
        canFlushOutput: () => true,
        channelId: `channel:${agentId}`,
        getOutputPriority: () => 'hidden',
        isDisposed: () => false,
        isSpawnFailed: () => false,
        markTerminalReady: vi.fn(),
        onChunkRendered: vi.fn(),
        onQueueEmpty: vi.fn(),
        props: {
          agentId,
          args: [],
          command: 'fixture',
          cwd: '/tmp',
          taskId,
        },
        taskId,
        term,
      }),
    };
  }

  function runScenario(
    scenario: HistoryScenario,
    terminalCount: number,
    iterations: number,
  ): HistoryBenchmarkResult {
    const appendDurationsMs: number[] = [];
    const flattenDurationsMs: number[] = [];
    let retainedBytes = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const taskId = `history:${scenario.name}:${terminalCount}:${iteration}`;
      const harnesses = Array.from({ length: terminalCount }, (_, terminalIndex) =>
        createHistoryHarness(taskId, `history-agent:${iteration}:${terminalIndex}`),
      );
      const chunksByTerminal = harnesses.map((_, terminalIndex) =>
        scenario.buildChunks(terminalIndex),
      );
      const maxChunkCount = Math.max(0, ...chunksByTerminal.map((chunks) => chunks.length));

      const appendStartedAtMs = nodePerformance.now();
      for (let chunkIndex = 0; chunkIndex < maxChunkCount; chunkIndex += 1) {
        for (let terminalIndex = 0; terminalIndex < terminalCount; terminalIndex += 1) {
          const chunk = chunksByTerminal[terminalIndex]?.[chunkIndex];
          if (!chunk) {
            continue;
          }

          harnesses[terminalIndex]?.pipeline.appendRenderedOutputHistory(chunk);
        }
      }
      appendDurationsMs.push(nodePerformance.now() - appendStartedAtMs);

      const flattenStartedAtMs = nodePerformance.now();
      retainedBytes = 0;
      for (const harness of harnesses) {
        retainedBytes += harness.pipeline.getRenderedOutputHistory().length;
      }
      flattenDurationsMs.push(nodePerformance.now() - flattenStartedAtMs);

      for (const harness of harnesses) {
        harness.pipeline.cleanup();
      }
    }

    return {
      appendMs: summarizeDurations(appendDurationsMs),
      flattenMs: summarizeDurations(flattenDurationsMs),
      retainedBytes,
      scenario: scenario.name,
      terminals: terminalCount,
    };
  }

  it('measures rendered history retention cost across verbose terminal workloads', async () => {
    const terminalCounts = parseBenchmarkTerminalCounts();
    const iterations = parseBenchmarkIterationCount(DEFAULT_ITERATIONS);
    const results: HistoryBenchmarkResult[] = [];

    for (const terminalCount of terminalCounts) {
      for (const scenario of HISTORY_SCENARIOS) {
        const result = runScenario(scenario, terminalCount, iterations);
        results.push(result);
        process.stdout.write(
          `[benchmark][history] terminals=${terminalCount} scenario=${scenario.name} retained=${result.retainedBytes}B appendAvg=${result.appendMs.avgMs}ms appendP95=${result.appendMs.p95Ms}ms flattenAvg=${result.flattenMs.avgMs}ms flattenP95=${result.flattenMs.p95Ms}ms\n`,
        );
      }
    }

    await writeBenchmarkArtifact('terminal-output-history.json', {
      generatedAt: new Date().toISOString(),
      iterations,
      results,
    });

    expect(results.length).toBe(terminalCounts.length * HISTORY_SCENARIOS.length);
  }, 30_000);
});
