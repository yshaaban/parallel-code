import { performance as nodePerformance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTerminalOutputSchedulerForTests } from '../../app/terminal-output-scheduler';
import {
  resetTerminalFramePressureForTests,
  setTerminalFramePressureLevelForTests,
} from '../../app/terminal-frame-pressure';
import {
  resetTerminalHighLoadModeForTests,
  syncTerminalHighLoadMode,
} from '../../app/terminal-high-load-mode';
import {
  parseBenchmarkIterationCount,
  parseBenchmarkTerminalCounts,
  summarizeDurations,
  writeBenchmarkArtifact,
} from '../../lib/benchmark-helpers';
import {
  resetTerminalOutputDiagnostics,
  getTerminalOutputDiagnosticsSnapshot,
} from '../../lib/terminal-output-diagnostics';
import {
  createLineSpamChunks,
  createMixedWorkloadChunks,
  createStatuslineChunks,
} from '../../lib/terminal-workload-fixtures';
import type { TerminalOutputPriority } from '../../lib/terminal-output-priority';
import { resetTerminalPerformanceExperimentConfigForTests } from '../../lib/terminal-performance-experiments';
import { installManualAnimationFrame } from '../../test/manual-animation-frame';
import {
  createTerminalOutputPipeline,
  type TerminalOutputPipeline,
} from './terminal-output-pipeline';

interface PipelineScenario {
  buildChunks: (terminalIndex: number) => Uint8Array[];
  interChunkAdvanceMs: number;
  name: string;
}

interface PipelineBenchmarkResult {
  durationMs: ReturnType<typeof summarizeDurations>;
  scenario: string;
  terminals: number;
  totalDirectCalls: number;
  totalQueuedCalls: number;
  totalRedrawChunks: number;
  totalWriteCalls: number;
}

interface PipelineHarness {
  pipeline: TerminalOutputPipeline;
  writes: {
    bytes: number;
    calls: number;
  };
}

const PIPELINE_SCENARIOS: readonly PipelineScenario[] = [
  {
    buildChunks: (terminalIndex) => createLineSpamChunks(`plain:${terminalIndex}`, 32, 2_048),
    interChunkAdvanceMs: 0,
    name: 'plain-lines-many',
  },
  {
    buildChunks: (terminalIndex) =>
      createStatuslineChunks({
        footerTopRow: 20,
        frameCount: 24,
        label: `statusline:${terminalIndex}`,
        splitSequences: true,
      }),
    interChunkAdvanceMs: 1,
    name: 'statusline-redraw-many',
  },
  {
    buildChunks: (terminalIndex) =>
      createMixedWorkloadChunks({
        bulkText: {
          label: `mixed:${terminalIndex}`,
          paragraphBytes: 4_096,
          paragraphCount: 8,
        },
        statusline: {
          footerTopRow: 20,
          frameCount: 16,
          label: `mixed:${terminalIndex}`,
          splitSequences: true,
        },
      }),
    interChunkAdvanceMs: 1,
    name: 'mixed-verbose-many',
  },
];
const DEFAULT_ITERATIONS = 8;

describe('terminal-output-pipeline benchmark', () => {
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  let animationFrame: ReturnType<typeof installManualAnimationFrame>;
  let focusedQueuedWritePacingFallbackRuns = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    animationFrame = installManualAnimationFrame();
    focusedQueuedWritePacingFallbackRuns = 0;
    vi.stubGlobal('window', {
      __TERMINAL_OUTPUT_DIAGNOSTICS__: true,
      setTimeout: (handler: TimerHandler, timeout?: number): number => {
        if (timeout !== 100 || typeof handler !== 'function') {
          return globalThis.setTimeout(handler, timeout) as unknown as number;
        }

        return globalThis.setTimeout(() => {
          focusedQueuedWritePacingFallbackRuns += 1;
          handler();
        }, timeout) as unknown as number;
      },
    });
    syncTerminalHighLoadMode(true);
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalFramePressureForTests();
    setTerminalFramePressureLevelForTests('stable');
    resetTerminalOutputDiagnostics();
    resetTerminalOutputSchedulerForTests();
  });

  afterEach(() => {
    resetTerminalOutputDiagnostics();
    resetTerminalOutputSchedulerForTests();
    resetTerminalFramePressureForTests();
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalHighLoadModeForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  function flushScheduledWork(harnesses: readonly PipelineHarness[]): void {
    let safetyCounter = 0;

    while (safetyCounter < 4_000) {
      const outputSettled = harnesses.every(
        ({ pipeline }) => !pipeline.hasQueuedOutputBytes() && !pipeline.hasWriteInFlight(),
      );
      if (outputSettled && animationFrame.pendingCount() === 0) {
        return;
      }

      if (animationFrame.pendingCount() > 0) {
        animationFrame.flush();
      } else if (vi.getTimerCount() > 0) {
        vi.advanceTimersToNextTimer();
      } else {
        throw new Error('Pipeline benchmark output stalled without scheduled work');
      }

      safetyCounter += 1;
    }

    const pendingHarnesses = harnesses.map(({ pipeline, writes }) => ({
      queued: pipeline.hasQueuedOutputBytes(),
      writeInFlight: pipeline.hasWriteInFlight(),
      writes: writes.calls,
    }));
    throw new Error(
      `Pipeline benchmark exceeded the flush safety limit (pending frames: ${animationFrame.pendingCount()}, pending timers: ${vi.getTimerCount()}, harnesses: ${JSON.stringify(pendingHarnesses)})`,
    );
  }

  function createPipelineHarness(
    taskId: string,
    agentId: string,
    getOutputPriority: () => TerminalOutputPriority,
  ): PipelineHarness {
    const writes = {
      bytes: 0,
      calls: 0,
    };
    const term = {
      write: (chunk: Uint8Array, callback: () => void) => {
        writes.bytes += chunk.length;
        writes.calls += 1;
        callback();
      },
    };

    return {
      pipeline: createTerminalOutputPipeline({
        agentId,
        canFlushOutput: () => true,
        channelId: `channel:${agentId}`,
        getOutputPriority,
        hasObservedLocalInput: () => false,
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
      writes,
    };
  }

  function runScenario(
    scenario: PipelineScenario,
    terminalCount: number,
    iterations: number,
  ): PipelineBenchmarkResult {
    const durationsMs: number[] = [];
    let relevantDiagnostics: ReturnType<typeof getTerminalOutputDiagnosticsSnapshot>['terminals'] =
      [];

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      resetTerminalOutputDiagnostics();
      resetTerminalOutputSchedulerForTests();
      const taskId = `task:${scenario.name}:${terminalCount}:${iteration}`;
      const harnesses = Array.from({ length: terminalCount }, (_, terminalIndex) => {
        return createPipelineHarness(taskId, `agent:${iteration}:${terminalIndex}`, () => {
          return terminalIndex === 0 ? 'focused' : 'active-visible';
        });
      });
      const chunksByTerminal = harnesses.map((_, terminalIndex) =>
        scenario.buildChunks(terminalIndex),
      );
      const maxChunkCount = Math.max(0, ...chunksByTerminal.map((chunks) => chunks.length));
      let elapsedSinceAnimationFrameMs = 0;

      const startedAtMs = nodePerformance.now();
      for (let chunkIndex = 0; chunkIndex < maxChunkCount; chunkIndex += 1) {
        for (let terminalIndex = 0; terminalIndex < terminalCount; terminalIndex += 1) {
          const chunk = chunksByTerminal[terminalIndex]?.[chunkIndex];
          if (!chunk) {
            continue;
          }

          harnesses[terminalIndex]?.pipeline.enqueueOutput(chunk);
        }

        if (scenario.interChunkAdvanceMs > 0) {
          vi.advanceTimersByTime(scenario.interChunkAdvanceMs);
          elapsedSinceAnimationFrameMs += scenario.interChunkAdvanceMs;
          if (elapsedSinceAnimationFrameMs >= 16) {
            animationFrame.flush();
            elapsedSinceAnimationFrameMs %= 16;
          }
        }
      }
      flushScheduledWork(harnesses);
      durationsMs.push(nodePerformance.now() - startedAtMs);

      const diagnostics = getTerminalOutputDiagnosticsSnapshot();
      relevantDiagnostics = diagnostics.terminals.filter((terminal) => terminal.taskId === taskId);
      for (const harness of harnesses) {
        harness.pipeline.cleanup();
      }
    }

    return {
      durationMs: summarizeDurations(durationsMs),
      scenario: scenario.name,
      terminals: terminalCount,
      totalDirectCalls: relevantDiagnostics.reduce((total, terminal) => {
        return total + terminal.writes.directCalls;
      }, 0),
      totalQueuedCalls: relevantDiagnostics.reduce((total, terminal) => {
        return total + terminal.writes.queuedCalls;
      }, 0),
      totalRedrawChunks: relevantDiagnostics.reduce((total, terminal) => {
        return total + terminal.control.redrawChunks;
      }, 0),
      totalWriteCalls: relevantDiagnostics.reduce((total, terminal) => {
        return total + terminal.writes.calls;
      }, 0),
    };
  }

  it('measures write amplification across verbose terminal workloads', async () => {
    const terminalCounts = parseBenchmarkTerminalCounts();
    const iterations = parseBenchmarkIterationCount(DEFAULT_ITERATIONS);
    const results: PipelineBenchmarkResult[] = [];

    for (const terminalCount of terminalCounts) {
      for (const scenario of PIPELINE_SCENARIOS) {
        const result = runScenario(scenario, terminalCount, iterations);
        results.push(result);
        process.stdout.write(
          `[benchmark][pipeline] terminals=${terminalCount} scenario=${scenario.name} writes=${result.totalWriteCalls} direct=${result.totalDirectCalls} queued=${result.totalQueuedCalls} redrawChunks=${result.totalRedrawChunks} avg=${result.durationMs.avgMs}ms p95=${result.durationMs.p95Ms}ms\n`,
        );
      }
    }

    await writeBenchmarkArtifact('terminal-output-pipeline.json', {
      generatedAt: new Date().toISOString(),
      iterations,
      results,
    });

    expect(results.length).toBe(terminalCounts.length * PIPELINE_SCENARIOS.length);
    expect(results.every((result) => result.totalWriteCalls > 0)).toBe(true);
    expect(results.every((result) => result.totalQueuedCalls > 0)).toBe(true);
    expect(
      results
        .filter((result) => result.scenario === 'plain-lines-many')
        .every((result) => result.totalRedrawChunks === 0),
    ).toBe(true);
    expect(
      results
        .filter((result) => result.scenario !== 'plain-lines-many')
        .every((result) => result.totalRedrawChunks > 0),
    ).toBe(true);
    expect(focusedQueuedWritePacingFallbackRuns).toBe(0);
  });
});
