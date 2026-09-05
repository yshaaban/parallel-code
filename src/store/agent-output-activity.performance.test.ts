import { createRoot, createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';

import {
  getVisibleTerminalTextForDetection,
  hasPromptAdjacentInteractiveChoiceInVisibleTail,
  looksLikeQuestionInVisibleTail,
} from '../lib/prompt-detection';
import {
  clearLocalQuestion,
  isLocalAgentQuestionActive,
  markLocalQuestion,
  resetAgentQuestionStateForTests,
  resetLocalQuestionForGeneration,
} from './agent-question-state';
import {
  AGENT_OUTPUT_ACTIVITY_BENCHMARK_SCENARIOS,
  buildAgentOutputActivityBenchmarkChunks,
} from './agent-output-activity.benchmark-workload';

const REGRESSION_BUDGET_RATIO = 1.05;
const RUN_COUNT = 3;
const TERMINAL_COUNT = 12;
const TAIL_BUFFER_MAX = 65_536;
const VISIBLE_ANALYSIS_TAIL_MAX = 500;
const WORKLOAD_REPEATS = 2;

interface AnalysisEvent {
  agentId: string;
  chunk: Uint8Array;
}

interface AnalysisWorkload {
  events: readonly AnalysisEvent[];
  sampleCount: number;
}

function getCpuDurationMs(startedAt: NodeJS.CpuUsage): number {
  const duration = process.cpuUsage(startedAt);
  return (duration.user + duration.system) / 1_000;
}

function appendTail(previous: string, addition: string): string {
  if (addition.length >= TAIL_BUFFER_MAX) {
    return addition.slice(-TAIL_BUFFER_MAX);
  }

  const next = previous + addition;
  return next.length > TAIL_BUFFER_MAX ? next.slice(-TAIL_BUFFER_MAX) : next;
}

function buildAnalysisWorkload(): AnalysisWorkload {
  const events: AnalysisEvent[] = [];
  const scenarios = AGENT_OUTPUT_ACTIVITY_BENCHMARK_SCENARIOS.filter(
    (scenario) => scenario.processingMode === 'full',
  );

  for (const scenario of scenarios) {
    const chunksByAgent = buildAgentOutputActivityBenchmarkChunks(scenario, TERMINAL_COUNT);
    const maxChunkCount = Math.max(0, ...chunksByAgent.map((chunks) => chunks.length));

    for (let chunkIndex = 0; chunkIndex < maxChunkCount; chunkIndex += 1) {
      for (let terminalIndex = 0; terminalIndex < TERMINAL_COUNT; terminalIndex += 1) {
        const chunk = chunksByAgent[terminalIndex]?.[chunkIndex];
        if (chunk) {
          events.push({
            agentId: `${scenario.name}:${terminalIndex}`,
            chunk,
          });
        }
      }
    }
  }

  return {
    events,
    sampleCount: events.length * WORKLOAD_REPEATS,
  };
}

function getQuestionState(rawTail: string): boolean {
  const visibleTail = getVisibleTerminalTextForDetection(rawTail).slice(-VISIBLE_ANALYSIS_TAIL_MAX);
  return (
    looksLikeQuestionInVisibleTail(visibleTail) ||
    hasPromptAdjacentInteractiveChoiceInVisibleTail(visibleTail)
  );
}

function runLegacyQuestionStateWorkload(workload: AnalysisWorkload): number {
  return createRoot((dispose) => {
    // The getter is intentionally omitted: this reproduces the legacy write-only hot path.
    // eslint-disable-next-line solid/reactivity
    const [, setQuestionAgents] = createSignal<ReadonlySet<string>>(new Set());
    const tails = new Map<string, string>();
    const decoders = new Map<string, TextDecoder>();
    const startedAt = process.cpuUsage();

    for (let repeat = 0; repeat < WORKLOAD_REPEATS; repeat += 1) {
      for (const event of workload.events) {
        const decoder = decoders.get(event.agentId) ?? new TextDecoder();
        decoders.set(event.agentId, decoder);
        const nextTail = appendTail(
          tails.get(event.agentId) ?? '',
          decoder.decode(event.chunk, { stream: true }),
        );
        tails.set(event.agentId, nextTail);
        const active = getQuestionState(nextTail);

        setQuestionAgents((previous) => {
          if (previous.has(event.agentId) === active) {
            return previous;
          }

          const next = new Set(previous);
          if (active) {
            next.add(event.agentId);
          } else {
            next.delete(event.agentId);
          }
          return next;
        });
      }
    }

    const durationMs = getCpuDurationMs(startedAt);
    dispose();
    return durationMs;
  });
}

function runGenerationBoundQuestionStateWorkload(workload: AnalysisWorkload): number {
  resetAgentQuestionStateForTests();
  const tails = new Map<string, string>();
  const decoders = new Map<string, TextDecoder>();
  const evidenceRevisionByAgent = new Map<string, number>();
  const agentIds = new Set(workload.events.map((event) => event.agentId));
  for (const agentId of agentIds) {
    resetLocalQuestionForGeneration(agentId, 1);
  }

  const startedAt = process.cpuUsage();
  for (let repeat = 0; repeat < WORKLOAD_REPEATS; repeat += 1) {
    for (const event of workload.events) {
      const decoder = decoders.get(event.agentId) ?? new TextDecoder();
      decoders.set(event.agentId, decoder);
      const nextTail = appendTail(
        tails.get(event.agentId) ?? '',
        decoder.decode(event.chunk, { stream: true }),
      );
      tails.set(event.agentId, nextTail);
      const active = getQuestionState(nextTail);
      const evidenceRevision = (evidenceRevisionByAgent.get(event.agentId) ?? 0) + 1;
      evidenceRevisionByAgent.set(event.agentId, evidenceRevision);

      if (active) {
        markLocalQuestion(event.agentId, 1, evidenceRevision);
      } else {
        clearLocalQuestion(event.agentId, 1, evidenceRevision);
      }
    }
  }

  const durationMs = getCpuDurationMs(startedAt);
  for (const agentId of agentIds) {
    isLocalAgentQuestionActive(agentId, 1);
  }
  resetAgentQuestionStateForTests();
  return durationMs;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
}

describe('agent output activity performance', () => {
  it('keeps generation-bound question analysis within the 5% three-run median budget', () => {
    const workload = buildAnalysisWorkload();

    // Warm both implementations before recording the three comparable runs.
    runLegacyQuestionStateWorkload(workload);
    runGenerationBoundQuestionStateWorkload(workload);

    const baselineRunsMs: number[] = [];
    const generationBoundRunsMs: number[] = [];
    for (let run = 0; run < RUN_COUNT; run += 1) {
      if (run % 2 === 0) {
        baselineRunsMs.push(runLegacyQuestionStateWorkload(workload));
        generationBoundRunsMs.push(runGenerationBoundQuestionStateWorkload(workload));
      } else {
        generationBoundRunsMs.push(runGenerationBoundQuestionStateWorkload(workload));
        baselineRunsMs.push(runLegacyQuestionStateWorkload(workload));
      }
    }

    const baselineMedianMs = median(baselineRunsMs);
    const generationBoundMedianMs = median(generationBoundRunsMs);
    const regressionRatio = generationBoundMedianMs / baselineMedianMs;

    process.stdout.write(
      `${[
        'agent-output-activity',
        `samples=${workload.sampleCount}`,
        `runs=${RUN_COUNT}`,
        'metric=process-cpu',
        `baselineMedian=${baselineMedianMs.toFixed(3)}ms`,
        `generationBoundMedian=${generationBoundMedianMs.toFixed(3)}ms`,
        `ratio=${regressionRatio.toFixed(4)}`,
        `budget=${REGRESSION_BUDGET_RATIO.toFixed(2)}`,
      ].join(' ')}\n`,
    );

    expect(baselineRunsMs).toHaveLength(RUN_COUNT);
    expect(generationBoundRunsMs).toHaveLength(RUN_COUNT);
    expect(regressionRatio).toBeLessThanOrEqual(REGRESSION_BUDGET_RATIO);
  });
});
