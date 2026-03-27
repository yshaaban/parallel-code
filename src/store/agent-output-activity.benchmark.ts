import { performance as nodePerformance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseBenchmarkIterationCount,
  parseBenchmarkTerminalCounts,
  summarizeDurations,
  writeBenchmarkArtifact,
} from '../lib/benchmark-helpers';
import {
  createBulkTextChunks,
  createMixedWorkloadChunks,
  createStatuslineChunks,
} from '../lib/terminal-workload-fixtures';
import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from '../app/runtime-diagnostics';
import { setStore } from './core';
import {
  clearAgentActivity,
  markAgentOutput,
  markAgentSpawned,
  resetAgentOutputActivityStateForTests,
  type AgentOutputProcessingMode,
} from './agent-output-activity';

interface ActivityScenario {
  buildChunks: (terminalIndex: number) => Uint8Array[];
  getTaskId: (terminalIndex: number) => string;
  interChunkAdvanceMs: number;
  name: string;
  processingMode: AgentOutputProcessingMode;
  setupActiveTaskId: () => string | null;
}

interface ActivityBenchmarkResult {
  diagnostics: ReturnType<typeof getRendererRuntimeDiagnosticsSnapshot>['agentOutputAnalysis'];
  durationMs: ReturnType<typeof summarizeDurations>;
  processingMode: AgentOutputProcessingMode;
  scenario: string;
  terminals: number;
}

const ACTIVITY_SCENARIOS: readonly ActivityScenario[] = [
  {
    buildChunks: (terminalIndex) =>
      createBulkTextChunks({
        label: `activity:bulk:${terminalIndex}`,
        paragraphBytes: 4_096,
        paragraphCount: 8,
      }),
    getTaskId: () => 'task-active',
    interChunkAdvanceMs: 50,
    name: 'all-active-bulk-text',
    processingMode: 'full',
    setupActiveTaskId: () => 'task-active',
  },
  {
    buildChunks: (terminalIndex) =>
      createStatuslineChunks({
        footerTopRow: 20,
        frameCount: 24,
        label: `activity:status:${terminalIndex}`,
        splitSequences: true,
      }),
    getTaskId: () => 'task-background',
    interChunkAdvanceMs: 50,
    name: 'all-background-statusline',
    processingMode: 'full',
    setupActiveTaskId: () => 'task-active',
  },
  {
    buildChunks: (terminalIndex) =>
      createMixedWorkloadChunks({
        bulkText: {
          label: `activity:mixed:${terminalIndex}`,
          paragraphBytes: 2_048,
          paragraphCount: 4,
        },
        statusline: {
          footerTopRow: 20,
          frameCount: 12,
          label: `activity:mixed:${terminalIndex}`,
          splitSequences: true,
        },
      }),
    getTaskId: (terminalIndex) => (terminalIndex === 0 ? 'task-active' : 'task-background'),
    interChunkAdvanceMs: 50,
    name: 'one-active-many-background-mixed',
    processingMode: 'full',
    setupActiveTaskId: () => 'task-active',
  },
  {
    buildChunks: (terminalIndex) =>
      createMixedWorkloadChunks({
        bulkText: {
          label: `shell:mixed:${terminalIndex}`,
          paragraphBytes: 2_048,
          paragraphCount: 4,
        },
        statusline: {
          footerTopRow: 20,
          frameCount: 12,
          label: `shell:mixed:${terminalIndex}`,
          splitSequences: true,
        },
      }),
    getTaskId: () => 'task-shell',
    interChunkAdvanceMs: 50,
    name: 'all-shell-mixed-workload',
    processingMode: 'shell',
    setupActiveTaskId: () => null,
  },
];
const DEFAULT_ITERATIONS = 8;

describe('agent-output-activity benchmark', () => {
  const originalPerformance = globalThis.performance;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetRendererRuntimeDiagnostics();
    resetAgentOutputActivityStateForTests();
    setStore('activeTaskId', null);
    vi.stubGlobal('performance', {
      now: (() => {
        let now = 0;
        return () => {
          now += 1;
          return now;
        };
      })(),
    } as Performance);
  });

  afterEach(() => {
    resetAgentOutputActivityStateForTests();
    resetRendererRuntimeDiagnostics();
    setStore('activeTaskId', null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    globalThis.performance = originalPerformance;
  });

  function runScenario(
    scenario: ActivityScenario,
    terminalCount: number,
    iterations: number,
  ): ActivityBenchmarkResult {
    const durationsMs: number[] = [];
    let diagnostics = getRendererRuntimeDiagnosticsSnapshot().agentOutputAnalysis;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      resetRendererRuntimeDiagnostics();
      resetAgentOutputActivityStateForTests();
      const agentIds = Array.from({ length: terminalCount }, (_, terminalIndex) => {
        return `agent:${scenario.name}:${iteration}:${terminalIndex}`;
      });
      for (const agentId of agentIds) {
        markAgentSpawned(agentId);
      }

      setStore('activeTaskId', scenario.setupActiveTaskId());
      const chunksByAgent = agentIds.map((_, terminalIndex) => scenario.buildChunks(terminalIndex));
      const maxChunkCount = Math.max(0, ...chunksByAgent.map((chunks) => chunks.length));
      const startedAtMs = nodePerformance.now();

      for (let chunkIndex = 0; chunkIndex < maxChunkCount; chunkIndex += 1) {
        for (let terminalIndex = 0; terminalIndex < terminalCount; terminalIndex += 1) {
          const chunk = chunksByAgent[terminalIndex]?.[chunkIndex];
          if (!chunk) {
            continue;
          }

          markAgentOutput(
            agentIds[terminalIndex] ?? `agent:${terminalIndex}`,
            chunk,
            scenario.getTaskId(terminalIndex),
            scenario.processingMode,
          );
        }

        vi.advanceTimersByTime(scenario.interChunkAdvanceMs);
      }

      vi.advanceTimersByTime(2_500);
      durationsMs.push(nodePerformance.now() - startedAtMs);
      diagnostics = getRendererRuntimeDiagnosticsSnapshot().agentOutputAnalysis;

      for (const agentId of agentIds) {
        clearAgentActivity(agentId);
      }
    }

    return {
      diagnostics,
      durationMs: summarizeDurations(durationsMs),
      processingMode: scenario.processingMode,
      scenario: scenario.name,
      terminals: terminalCount,
    };
  }

  it('measures prompt and question analysis pressure across many active terminals', async () => {
    const terminalCounts = parseBenchmarkTerminalCounts();
    const iterations = parseBenchmarkIterationCount(DEFAULT_ITERATIONS);
    const results: ActivityBenchmarkResult[] = [];

    for (const terminalCount of terminalCounts) {
      for (const scenario of ACTIVITY_SCENARIOS) {
        const result = runScenario(scenario, terminalCount, iterations);
        results.push(result);
        process.stdout.write(
          `[benchmark][activity] terminals=${terminalCount} scenario=${scenario.name} mode=${result.processingMode} analyses=${result.diagnostics.analysisCalls} schedules=${result.diagnostics.analysisSchedules} backgroundSkips=${result.diagnostics.backgroundSkips} avg=${result.durationMs.avgMs}ms p95=${result.durationMs.p95Ms}ms\n`,
        );
      }
    }

    await writeBenchmarkArtifact('agent-output-activity.json', {
      generatedAt: new Date().toISOString(),
      iterations,
      results,
    });

    expect(results.length).toBe(terminalCounts.length * ACTIVITY_SCENARIOS.length);
  }, 30_000);
});
