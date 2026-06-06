import { afterEach, describe, expect, it, vi } from 'vitest';
import { COORDINATOR_LIMITS } from '../../src/domain/coordinator.js';
import {
  addCoordinatorSubtask,
  appendCoordinatorWorkflowSteps,
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

  it('backfills legacy workflow append policy, program version, and journal sequence on restore', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    createCoordinatorWorkflow({
      now: 1_010,
      runId: run.id,
      stages: [{ id: 'map', kind: 'map', name: 'Map' }],
      template: 'map_reduce',
      title: 'Legacy restore',
    });
    const persisted = getCoordinatorRuntimeState();
    const legacyState = {
      ...persisted,
      runs: persisted.runs.map((entry) => ({
        ...entry,
        workflows: entry.workflows.map((workflow) => ({
          ...workflow,
          journal: workflow.journal.map(({ seq: _seq, ...journalEntry }) => journalEntry),
          programVersion: undefined,
          appendPolicy: undefined,
        })),
      })),
    };

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(legacyState);

    const restoredWorkflow = getCoordinatorRun(run.id)?.workflows[0];
    expect(restoredWorkflow).toMatchObject({
      appendPolicy: {
        maxActionsPerDecision: COORDINATOR_LIMITS.maxWorkflowDecisionActionsPerResult,
        maxStepAppends: COORDINATOR_LIMITS.maxWorkflowStepAppends,
      },
      programVersion: 2,
    });
    expect(restoredWorkflow?.journal[0]).toMatchObject({
      kind: 'workflow-created',
      seq: 1,
    });
  });

  it('backfills legacy subtask startup state on restore', () => {
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
      kind: 'initial-assignment',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Continue',
      now: 1_200,
    });
    updateCoordinatorPrompt(run.id, prompt.requestId, {
      deliveredAt: 1_230,
      status: 'delivered',
    });
    const persisted = getCoordinatorRuntimeState();
    const legacyState = {
      ...persisted,
      runs: persisted.runs.map((entry) => ({
        ...entry,
        subtasks: entry.subtasks.map(({ startup: _startup, ...subtask }) => subtask),
      })),
    };

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(legacyState);

    expect(getCoordinatorRun(run.id)?.subtasks[0]).toMatchObject({
      startup: {
        deliveredAt: 1_230,
        followupPromptMode: 'post-ready-prompt',
        initialAssignmentMode: 'post-ready-prompt',
        initialAssignmentStatus: 'delivered',
        readinessPolicy: 'terminal-generic',
      },
      status: 'exited',
    });
  });

  it('clears stale completion reason when appending to a completed workflow', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      execution: {
        activeLaneCount: 0,
        completionReason: 'Workflow already finished.',
        lastTickAt: 1_010,
        pendingRetryLaneIds: [],
        readyStageIds: [],
      },
      now: 1_010,
      runId: run.id,
      sourceSpec: {
        steps: [
          {
            dependsOn: [],
            id: 'initial',
            kind: 'worker',
            lanes: [],
            name: 'Initial',
            resultSourceStepIds: [],
            sourceStepIds: [],
            verifiers: [],
          },
        ],
        version: 1,
      },
      stages: [{ id: 'initial', kind: 'custom', name: 'Initial', status: 'completed' }],
      status: 'completed',
      template: 'custom',
      title: 'Reopen workflow',
    });

    const reopened = appendCoordinatorWorkflowSteps({
      append: {
        appendId: 'append-1',
        createdAt: 1_020,
        payloadHash: 'hash-1',
        sourceTaskId: 'task-coordinator',
        stepIds: ['followup'],
      },
      now: 1_020,
      runId: run.id,
      sourceSpec: {
        steps: [
          {
            dependsOn: [],
            id: 'initial',
            kind: 'worker',
            lanes: [],
            name: 'Initial',
            resultSourceStepIds: [],
            sourceStepIds: [],
            verifiers: [],
          },
          {
            dependsOn: ['initial'],
            id: 'followup',
            kind: 'worker',
            lanes: [],
            name: 'Followup',
            resultSourceStepIds: [],
            sourceStepIds: [],
            verifiers: [],
          },
        ],
        version: 1,
      },
      stages: [{ dependsOn: ['initial'], id: 'followup', kind: 'custom', name: 'Followup' }],
      workflowId: workflow.id,
    });

    expect(reopened.status).toBe('running');
    expect(reopened.completedAt).toBeUndefined();
    expect(reopened.execution?.completionReason).toBeUndefined();
    expect(reopened.stages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'followup', status: 'pending' })]),
    );
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
