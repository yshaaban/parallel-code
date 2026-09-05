import {
  createBulkTextChunks,
  createMixedWorkloadChunks,
  createStatuslineChunks,
} from '../lib/terminal-workload-fixtures';
import type { AgentOutputProcessingMode } from './agent-output-activity';

export interface AgentOutputActivityBenchmarkScenario {
  buildChunks: (terminalIndex: number) => Uint8Array[];
  getTaskId: (terminalIndex: number) => string;
  interChunkAdvanceMs: number;
  name: string;
  processingMode: AgentOutputProcessingMode;
  setupActiveTaskId: () => string | null;
}

export const AGENT_OUTPUT_ACTIVITY_BENCHMARK_SCENARIOS: readonly AgentOutputActivityBenchmarkScenario[] =
  [
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

export function buildAgentOutputActivityBenchmarkChunks(
  scenario: AgentOutputActivityBenchmarkScenario,
  terminalCount: number,
): Uint8Array[][] {
  return Array.from({ length: terminalCount }, (_, terminalIndex) =>
    scenario.buildChunks(terminalIndex),
  );
}
