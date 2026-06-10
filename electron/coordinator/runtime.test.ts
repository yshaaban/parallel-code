import { afterEach, describe, expect, it, vi } from 'vitest';
import { COORDINATOR_LIMITS } from '../../src/domain/coordinator.js';
import {
  addCoordinatorSubtask,
  appendCoordinatorWorkflowSteps,
  addCoordinatorWorkflowLane,
  addCoordinatorWorkflowPendingApproval,
  addCoordinatorWorkflowResult,
  cancelCoordinatorWorkflowLanesForTask,
  createCoordinatorWorkflow,
  createCoordinatorRun,
  enqueueCoordinatorPrompt,
  getCoordinatorBootstrapSnapshot,
  getCoordinatorDiagnostics,
  getCoordinatorRun,
  getCoordinatorRuntimeState,
  getCoordinatorSubtaskLaunch,
  getCoordinatorToolResult,
  recordCoordinatorRunResumeOutcome,
  recordCoordinatorSubtaskLaunch,
  rememberCoordinatorToolResult,
  removeCoordinatorRun,
  removeCoordinatorSubtaskLaunch,
  resetCoordinatorRuntimeForTests,
  resolveCoordinatorWorkflowPendingApproval,
  restoreCoordinatorRuntimeState,
  resumeCoordinatorRunFromStale,
  setCoordinatorRunPaused,
  subscribeCoordinatorEvents,
  updateCoordinatorPrompt,
  updateCoordinatorRunStatus,
  updateCoordinatorSubtaskStatus,
  updateCoordinatorWorkflow,
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

  it('defaults workflow budget policy fields and computes an execution budget on restore', () => {
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
      stages: [{ id: 'map', kind: 'map', name: 'Map' }],
      template: 'map_reduce',
      title: 'Budget defaults',
    });
    expect(workflow.policy).toMatchObject({
      maxTotalLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
      maxTotalRetries: COORDINATOR_LIMITS.maxWorkflowTotalRetries,
      maxTotalSteps: COORDINATOR_LIMITS.maxWorkflowTotalSteps,
      maxWallClockMs: COORDINATOR_LIMITS.workflowDefaultWallClockMs,
    });

    const persisted = getCoordinatorRuntimeState();
    const legacyState = {
      ...persisted,
      runs: persisted.runs.map((entry) => ({
        ...entry,
        workflows: entry.workflows.map((legacyWorkflow) => ({
          ...legacyWorkflow,
          execution: undefined,
          policy: {
            continueOnFailure: legacyWorkflow.policy.continueOnFailure,
            maxConcurrentLanes: legacyWorkflow.policy.maxConcurrentLanes,
            maxIterationsPerBranch: legacyWorkflow.policy.maxIterationsPerBranch,
            maxOutputBytesPerLane: legacyWorkflow.policy.maxOutputBytesPerLane,
            resultRequired: legacyWorkflow.policy.resultRequired,
            retryBackoffMs: legacyWorkflow.policy.retryBackoffMs,
            retryCount: legacyWorkflow.policy.retryCount,
            timeoutMs: legacyWorkflow.policy.timeoutMs,
          },
        })),
      })),
    };

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(legacyState);

    const restoredWorkflow = getCoordinatorRun(run.id)?.workflows[0];
    expect(restoredWorkflow?.policy).toMatchObject({
      maxTotalLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
      maxTotalRetries: COORDINATOR_LIMITS.maxWorkflowTotalRetries,
      maxTotalSteps: COORDINATOR_LIMITS.maxWorkflowTotalSteps,
      maxWallClockMs: COORDINATOR_LIMITS.workflowDefaultWallClockMs,
    });
    expect(restoredWorkflow?.execution?.budget).toMatchObject({
      deadlineAt: expect.any(Number),
      lanes: { limit: COORDINATOR_LIMITS.maxWorkflowLanes, used: 0 },
      retries: { limit: COORDINATOR_LIMITS.maxWorkflowTotalRetries, used: 0 },
      steps: { limit: COORDINATOR_LIMITS.maxWorkflowTotalSteps, used: 1 },
    });
  });

  it('preserves a non-default maxIterationsPerBranch across create and restore', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      now: 1_010,
      policy: { maxIterationsPerBranch: 5 },
      runId: run.id,
      stages: [{ id: 'map', kind: 'map', name: 'Map' }],
      template: 'map_reduce',
      title: 'Branch iteration policy',
    });
    expect(workflow.policy.maxIterationsPerBranch).toBe(5);

    const persisted = getCoordinatorRuntimeState();
    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const restoredWorkflow = getCoordinatorRun(run.id)?.workflows[0];
    expect(restoredWorkflow?.policy.maxIterationsPerBranch).toBe(5);
  });

  it('preserves the execution deadline and exhausted budget dimension across restore', () => {
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
      stages: [{ id: 'map', kind: 'map', name: 'Map' }],
      template: 'map_reduce',
      title: 'Budget restore',
    });
    updateCoordinatorWorkflow(run.id, workflow.id, {
      execution: {
        activeLaneCount: 0,
        budget: {
          deadlineAt: 4_600_000,
          exhausted: 'wall-clock',
          lanes: { limit: 12, used: 0 },
          retries: { limit: 8, used: 0 },
          steps: { limit: 24, used: 1 },
        },
        deadlineAt: 4_600_000,
        lastTickAt: 1_020,
        pendingRetryLaneIds: [],
        readyStageIds: [],
      },
      now: 1_020,
    });

    const persisted = getCoordinatorRuntimeState();
    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const restoredWorkflow = getCoordinatorRun(run.id)?.workflows[0];
    expect(restoredWorkflow?.execution).toMatchObject({
      budget: expect.objectContaining({
        deadlineAt: 4_600_000,
        exhausted: 'wall-clock',
      }),
      deadlineAt: 4_600_000,
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

  it('marks restore interruption only on unfinished subtasks and keeps completed facts intact', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-running',
      assignment: 'Keep working',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'running',
      taskId: 'task-running',
      toolTokenId: 'token-running',
      worktreePath: '/repo/task-running',
      now: 1_100,
    });
    addCoordinatorSubtask({
      agentId: 'agent-landed',
      assignment: 'Finished work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'landed',
      taskId: 'task-landed',
      toolTokenId: 'token-landed',
      worktreePath: '/repo/task-landed',
      now: 1_200,
    });
    const persisted = getCoordinatorRuntimeState();
    const landedBeforeRestore = persisted.runs[0]?.subtasks.find(
      (subtask) => subtask.taskId === 'task-landed',
    );

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const restored = getCoordinatorRun(run.id);
    expect(restored?.subtasks.find((subtask) => subtask.taskId === 'task-running')).toMatchObject({
      interruptedByRestoreAt: expect.any(Number),
      status: 'exited',
    });
    expect(restored?.subtasks.find((subtask) => subtask.taskId === 'task-landed')).toEqual(
      landedBeforeRestore,
    );
  });

  it('round-trips subtask launch payloads through runtime state without exposing them in bootstrap', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    recordCoordinatorSubtaskLaunch({
      agent: { command: 'custom-agent', env: { SECRET_FLAG: 'caller-secret' } },
      assignment: 'Do the work',
      dedupeKey: 'launch-1',
      name: 'Child',
      recordedAt: 1_100,
      runId: run.id,
      taskId: 'task-child',
    });
    const persisted = getCoordinatorRuntimeState();

    expect(persisted.subtaskLaunches).toHaveLength(1);
    expect(JSON.stringify(getCoordinatorBootstrapSnapshot())).not.toContain('caller-secret');
    expect(JSON.stringify(getCoordinatorRun(run.id))).not.toContain('caller-secret');

    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    expect(getCoordinatorSubtaskLaunch(run.id, 'task-child')).toMatchObject({
      dedupeKey: 'launch-1',
      taskId: 'task-child',
    });

    removeCoordinatorSubtaskLaunch(run.id, 'task-child');
    expect(getCoordinatorSubtaskLaunch(run.id, 'task-child')).toBeNull();

    recordCoordinatorSubtaskLaunch({
      agent: { command: 'custom-agent' },
      assignment: 'Do the work',
      dedupeKey: 'launch-2',
      name: 'Child',
      recordedAt: 1_200,
      runId: run.id,
      taskId: 'task-child',
    });
    removeCoordinatorRun(run.id);
    expect(getCoordinatorSubtaskLaunch(run.id, 'task-child')).toBeNull();
  });

  it('resumes stale runs with an appended audit entry and rejects non-stale resumes', () => {
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
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
      now: 1_100,
    });
    const persisted = getCoordinatorRuntimeState();
    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const resumed = resumeCoordinatorRunFromStale(run.id, { now: 2_000, resumeId: 'resume-1' });
    expect(resumed).toMatchObject({
      resumes: [
        {
          failedTaskIds: [],
          requestedAt: 2_000,
          respawnedTaskIds: [],
          resumeId: 'resume-1',
        },
      ],
      status: 'running',
    });

    updateCoordinatorSubtaskStatus(run.id, 'task-child', 'running', {
      interruptedByRestoreAt: undefined,
      now: 2_100,
      toolTokenId: 'token-rotated',
    });
    expect(getCoordinatorRun(run.id)?.subtasks[0]).toMatchObject({
      status: 'running',
      toolTokenId: 'token-rotated',
    });
    expect(getCoordinatorRun(run.id)?.subtasks[0]?.interruptedByRestoreAt).toBeUndefined();

    const recorded = recordCoordinatorRunResumeOutcome(
      run.id,
      'resume-1',
      {
        failedTaskIds: [],
        respawnedTaskIds: ['task-child'],
      },
      2_200,
    );
    expect(recorded.resumes).toEqual([
      {
        failedTaskIds: [],
        requestedAt: 2_000,
        respawnedTaskIds: ['task-child'],
        resumeId: 'resume-1',
      },
    ]);

    expect(() => resumeCoordinatorRunFromStale(run.id, { resumeId: 'resume-2' })).toThrow(
      'Coordinator run is running',
    );
  });

  it('sets and clears the paused marker through setCoordinatorRunPaused', () => {
    const events: unknown[] = [];
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const cleanup = subscribeCoordinatorEvents((event) => events.push(event));

    const paused = setCoordinatorRunPaused(run.id, true, 2_000);
    expect(paused).toMatchObject({ pausedAt: 2_000, status: 'paused-by-user' });

    const unpaused = setCoordinatorRunPaused(run.id, false, 3_000);
    expect(unpaused.status).toBe('running');
    expect(unpaused.pausedAt).toBeUndefined();
    expect(unpaused.eventVersion).toBeGreaterThan(paused.eventVersion);
    expect(events.map((event) => (event as { eventType: string }).eventType)).toEqual([
      'run-upserted',
      'run-upserted',
    ]);

    cleanup();
  });

  it('restores a paused run as stale with the paused marker and resumes it back to paused', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    setCoordinatorRunPaused(run.id, true, 2_000);
    const persisted = getCoordinatorRuntimeState();
    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    expect(getCoordinatorRun(run.id)).toMatchObject({
      pausedAt: 2_000,
      status: 'stale-after-restore',
    });

    const resumed = resumeCoordinatorRunFromStale(run.id, { now: 3_000, resumeId: 'resume-1' });
    expect(resumed).toMatchObject({ pausedAt: 2_000, status: 'paused-by-user' });

    const unpaused = setCoordinatorRunPaused(run.id, false, 4_000);
    expect(unpaused.status).toBe('running');
    expect(unpaused.pausedAt).toBeUndefined();
  });

  it('records pending approvals append-only and patches them on resolution', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      runId: run.id,
      stages: [{ id: 'decide', kind: 'decision', name: 'Decide' }],
      template: 'custom',
      title: 'Approval fixture',
      now: 1_000,
    });
    addCoordinatorWorkflowLane({
      assignment: 'Decide next steps.',
      id: 'lane-decide',
      name: 'Decide',
      runId: run.id,
      stageId: 'decide',
      status: 'waiting-for-result',
      taskId: 'task-decide',
      workflowId: workflow.id,
      now: 1_100,
    });

    const approval = addCoordinatorWorkflowPendingApproval({
      actions: [{ kind: 'stop_workflow', reason: 'Done.' }],
      id: 'result-1:approval',
      laneId: 'lane-decide',
      now: 1_200,
      resultId: 'result-1',
      runId: run.id,
      stageId: 'decide',
      workflowId: workflow.id,
    });
    expect(approval.status).toBe('pending');

    const duplicate = addCoordinatorWorkflowPendingApproval({
      actions: [],
      id: 'result-1:approval',
      laneId: 'lane-decide',
      now: 1_300,
      resultId: 'result-1',
      runId: run.id,
      stageId: 'decide',
      workflowId: workflow.id,
    });
    expect(duplicate).toEqual(approval);
    expect(getCoordinatorRun(run.id)?.workflows[0]?.pendingApprovals).toHaveLength(1);

    const resolved = resolveCoordinatorWorkflowPendingApproval(
      run.id,
      workflow.id,
      'result-1:approval',
      'denied',
      { now: 1_400, reason: 'Not needed.' },
    );
    expect(resolved).toMatchObject({
      reason: 'Not needed.',
      resolvedAt: 1_400,
      status: 'denied',
    });
    expect(getCoordinatorRun(run.id)?.workflows[0]?.pendingApprovals).toEqual([resolved]);
    expect(() =>
      resolveCoordinatorWorkflowPendingApproval(run.id, workflow.id, 'missing', 'cancelled'),
    ).toThrow('Coordinator workflow approval not found');
  });

  it('cancels pending approvals with a journal entry when restoring workflow state', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      runId: run.id,
      stages: [{ id: 'decide', kind: 'decision', name: 'Decide' }],
      template: 'custom',
      title: 'Approval fixture',
      now: 1_000,
    });
    addCoordinatorWorkflowPendingApproval({
      actions: [{ kind: 'stop_workflow', reason: 'Done.' }],
      id: 'result-1:approval',
      laneId: 'lane-decide',
      now: 1_200,
      resultId: 'result-1',
      runId: run.id,
      stageId: 'decide',
      workflowId: workflow.id,
    });

    const persisted = getCoordinatorRuntimeState();
    resetCoordinatorRuntimeForTests();
    restoreCoordinatorRuntimeState(persisted);

    const restored = getCoordinatorRun(run.id)?.workflows[0];
    expect(restored?.pendingApprovals).toEqual([
      expect.objectContaining({
        id: 'result-1:approval',
        reason: 'stale-after-restore',
        status: 'cancelled',
      }),
    ]);
    const cancellationEntry = restored?.journal.find(
      (entry) => entry.kind === 'decision-approval-cancelled',
    );
    expect(cancellationEntry).toMatchObject({
      laneId: 'lane-decide',
      resultId: 'result-1',
    });
    expect(cancellationEntry?.seq).toBe(restored?.journal.length ?? 0);
  });

  it('resolves pending approvals when subtask cleanup cancels the owning lane', () => {
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const workflow = createCoordinatorWorkflow({
      runId: run.id,
      stages: [{ id: 'decide', kind: 'decision', name: 'Decide' }],
      template: 'custom',
      title: 'Approval fixture',
      now: 1_000,
    });
    addCoordinatorWorkflowLane({
      assignment: 'Decide next steps.',
      id: 'lane-decide',
      name: 'Decide',
      runId: run.id,
      stageId: 'decide',
      status: 'waiting-for-result',
      taskId: 'task-decide',
      workflowId: workflow.id,
      now: 1_100,
    });
    addCoordinatorWorkflowPendingApproval({
      actions: [{ kind: 'stop_workflow', reason: 'Done.' }],
      id: 'result-1:approval',
      laneId: 'lane-decide',
      now: 1_200,
      resultId: 'result-1',
      runId: run.id,
      stageId: 'decide',
      workflowId: workflow.id,
    });

    cancelCoordinatorWorkflowLanesForTask(run.id, 'task-decide', 'subtask closed');

    const updated = getCoordinatorRun(run.id)?.workflows[0];
    expect(updated?.pendingApprovals).toEqual([
      expect.objectContaining({ reason: 'subtask closed', status: 'cancelled' }),
    ]);
    expect(updated?.journal.some((entry) => entry.kind === 'decision-approval-cancelled')).toBe(
      true,
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
