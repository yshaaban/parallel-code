import { afterEach, describe, expect, it, vi } from 'vitest';
import { COORDINATOR_LIMITS } from '../../src/domain/coordinator.js';
import {
  addCoordinatorSubtask,
  addCoordinatorWorkflowLane,
  addCoordinatorWorkflowResult,
  createCoordinatorWorkflow,
  createCoordinatorRun,
  enqueueCoordinatorPrompt,
  getCoordinatorBootstrapSnapshot,
  getCoordinatorDiagnostics,
  getCoordinatorRun,
  getCoordinatorRuntimeState,
  getCoordinatorToolResult,
  rememberCoordinatorToolResult,
  removeCoordinatorRun,
  resetCoordinatorRuntimeForTests,
  restoreCoordinatorRuntimeState,
  subscribeCoordinatorEvents,
  updateCoordinatorPrompt,
  updateCoordinatorRunStatus,
  updateCoordinatorWorkflowLane,
} from './runtime.js';

describe('coordinator runtime', () => {
  afterEach(() => {
    resetCoordinatorRuntimeForTests();
    vi.useRealTimers();
  });

  it('emits replayable state events and materializes run-owned entities', () => {
    const events: unknown[] = [];
    const cleanup = subscribeCoordinatorEvents((event) => events.push(event));
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });

    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-id',
      worktreePath: '/repo/task-child',
      now: 1_100,
    });
    const prompt = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Continue',
      now: 1_200,
    });

    const updatedPrompt = updateCoordinatorPrompt(run.id, prompt.requestId, {
      status: 'delivering',
      waitingReason: undefined,
    });
    const materialized = getCoordinatorRun(run.id);

    expect(updatedPrompt.waitingReason).toBeUndefined();
    expect(materialized?.subtasks).toHaveLength(1);
    expect(materialized?.promptQueue).toHaveLength(1);
    expect(events.map((event) => (event as { eventType: string }).eventType)).toContain(
      'prompt-upserted',
    );

    cleanup();
  });

  it('restores persisted runtime state and tombstones removed runs', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'non-git',
      projectRoot: '/repo',
    });
    const persisted = getCoordinatorRuntimeState();

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    expect(getCoordinatorBootstrapSnapshot().runs.map((entry) => entry.id)).toEqual([run.id]);

    removeCoordinatorRun(run.id);

    expect(getCoordinatorRun(run.id)).toBeNull();
  });

  it('normalizes restored active runs and in-flight prompts to stale recovery states', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-id',
      worktreePath: '/repo/task-child',
      now: 1_100,
    });
    const prompt = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Continue',
      now: 1_200,
    });
    updateCoordinatorPrompt(run.id, prompt.requestId, {
      status: 'delivering',
    });
    updateCoordinatorRunStatus(run.id, 'draining', 1_300);
    const persisted = getCoordinatorRuntimeState();

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const restored = getCoordinatorRun(run.id);
    expect(restored).toMatchObject({
      status: 'stale-after-restore',
    });
    expect(restored?.subtasks[0]).toMatchObject({
      result: 'Server restored coordinator state without the live PTY session.',
      status: 'exited',
    });
    expect(restored?.promptQueue[0]).toMatchObject({
      status: 'write-unknown-after-restore',
      waitingReason: 'server-restored-without-live-pty-session',
    });
  });

  it('persists workflow state and marks active restored workflow lanes stale', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      now: 1_010,
      runId: run.id,
      stages: [
        { id: 'map', kind: 'map', name: 'Map' },
        { dependsOn: ['map'], id: 'reduce', kind: 'reduce', name: 'Reduce' },
      ],
      template: 'map_reduce',
      title: 'Review startup',
    });
    const completedLane = addCoordinatorWorkflowLane({
      agentId: 'agent-complete',
      assignment: 'Map completed lane.',
      name: 'Completed',
      now: 1_020,
      runId: run.id,
      stageId: 'map',
      status: 'waiting-for-result',
      taskId: 'task-complete',
      workflowId: workflow.id,
    });
    const activeLane = addCoordinatorWorkflowLane({
      agentId: 'agent-active',
      assignment: 'Map active lane.',
      name: 'Active',
      now: 1_030,
      runId: run.id,
      stageId: 'map',
      status: 'waiting-for-result',
      taskId: 'task-active',
      workflowId: workflow.id,
    });
    const result = addCoordinatorWorkflowResult({
      now: 1_040,
      result: {
        agentId: 'agent-complete',
        commandsRun: ['npm test'],
        evidence: [{ label: 'runtime' }],
        findings: [],
        laneId: completedLane.id,
        risks: [],
        stageId: 'map',
        status: 'completed',
        summary: 'Completed lane result.',
        taskId: 'task-complete',
        workflowId: workflow.id,
      },
      runId: run.id,
      workflowId: workflow.id,
    });
    updateCoordinatorWorkflowLane(run.id, workflow.id, completedLane.id, {
      completedAt: 1_050,
      resultId: result.id,
      status: 'completed',
    });

    const persisted = getCoordinatorRuntimeState();

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const restoredWorkflow = getCoordinatorRun(run.id)?.workflows[0];
    expect(restoredWorkflow).toMatchObject({
      status: 'stale-after-restore',
      results: [expect.objectContaining({ summary: 'Completed lane result.' })],
    });
    expect(restoredWorkflow?.lanes.find((lane) => lane.id === completedLane.id)).toMatchObject({
      status: 'completed',
    });
    expect(restoredWorkflow?.lanes.find((lane) => lane.id === activeLane.id)).toMatchObject({
      failure: 'Server restored coordinator workflow state without the live PTY session.',
      status: 'stale-after-restore',
    });
    expect(restoredWorkflow?.stages.find((stage) => stage.id === 'map')).toMatchObject({
      failure: 'Server restored coordinator workflow state without the live PTY session.',
      status: 'stale-after-restore',
    });
  });

  it('bounds remembered tool-call results and evicts the oldest entries', () => {
    vi.useFakeTimers();
    for (let index = 0; index <= COORDINATOR_LIMITS.maxRememberedToolCallResults; index += 1) {
      vi.setSystemTime(index);
      rememberCoordinatorToolResult(`call-${index}`, { index });
    }

    expect(getCoordinatorToolResult('call-0')).toBeUndefined();
    expect(
      getCoordinatorToolResult(`call-${COORDINATOR_LIMITS.maxRememberedToolCallResults}`),
    ).toEqual({
      index: COORDINATOR_LIMITS.maxRememberedToolCallResults,
    });
  });

  it('counts only pending prompts in coordinator diagnostics queue depth', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-id',
      worktreePath: '/repo/task-child',
      now: 1_100,
    });
    const delivered = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      now: 1_200,
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Delivered',
    });
    const failed = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      now: 1_300,
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Failed',
    });
    enqueueCoordinatorPrompt({
      kind: 'follow-up',
      now: 1_400,
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Pending',
    });
    updateCoordinatorPrompt(run.id, delivered.requestId, { status: 'delivered' });
    updateCoordinatorPrompt(run.id, failed.requestId, { status: 'failed' });

    expect(getCoordinatorDiagnostics().promptQueueDepth).toBe(1);
  });
});
