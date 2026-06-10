import { beforeEach, describe, expect, it } from 'vitest';

import {
  COORDINATOR_LIMITS,
  countCoordinatorWorkflowRetriesUsed,
} from '../../src/domain/coordinator.js';
import { normalizeCoordinatorWorkflowDynamicActions } from '../../src/domain/coordinator-workflow-spec.js';
import {
  addCoordinatorWorkflowResult,
  addCoordinatorWorkflowLane,
  appendCoordinatorWorkflowJournal,
  createCoordinatorRun,
  getCoordinatorRuntimeState,
  getCoordinatorWorkflow,
  resetCoordinatorRuntimeForTests,
  restoreCoordinatorRuntimeState,
  setCoordinatorRunPaused,
  updateCoordinatorWorkflow,
  updateCoordinatorWorkflowLane,
  updateCoordinatorWorkflowStage,
} from './runtime.js';
import {
  advanceCoordinatorWorkflowExecution,
  appendCoordinatorWorkflowExecutionSteps,
  approveCoordinatorWorkflowActions,
  cancelCoordinatorWorkflowExecution,
  denyCoordinatorWorkflowActions,
  getCoordinatorWorkflowNextTickAt,
  recordPendingWorkflowApproval,
  resumeCoordinatorWorkflowExecution,
  retryCoordinatorWorkflowLaneFromOperator,
  startCoordinatorWorkflowExecution,
  tickCoordinatorWorkflowExecution,
  tripCoordinatorWorkflowBudget,
  validateWorkflowDecisionActionsForResult,
  type RespawnCoordinatorWorkflowLane,
  type SpawnCoordinatorWorkflowLane,
} from './workflow-executor.js';

function createRun(): ReturnType<typeof createCoordinatorRun> {
  return createCoordinatorRun({
    coordinatorTaskId: 'task-coordinator',
    now: 1_000,
    projectId: 'project-1',
    projectMode: 'git',
    projectRoot: '/repo',
  });
}

function getWorkflowStageTimeoutMs(
  workflow: NonNullable<ReturnType<typeof getCoordinatorWorkflow>>,
  stageId: string,
): number {
  return (
    workflow.sourceSpec?.steps.find((step) => step.id === stageId)?.policy?.timeoutMs ??
    workflow.policy.timeoutMs
  );
}

function createFakeSpawnLane(): SpawnCoordinatorWorkflowLane {
  let index = 0;
  return async function spawnLane(workflow, stageId, lanePayload) {
    index += 1;
    const timeoutMs = getWorkflowStageTimeoutMs(workflow, stageId);
    const lane = addCoordinatorWorkflowLane({
      agentId: `agent-${index}`,
      assignment: lanePayload.assignment,
      ...(lanePayload.attempt !== undefined ? { attempt: lanePayload.attempt } : {}),
      ...(lanePayload.dedupeKey !== undefined ? { dedupeKey: lanePayload.dedupeKey } : {}),
      name: lanePayload.name,
      now: 1_000 + index,
      ...(lanePayload.role !== undefined ? { role: lanePayload.role } : {}),
      runId: workflow.runId,
      ...(lanePayload.spawnedBy !== undefined ? { spawnedBy: lanePayload.spawnedBy } : {}),
      stageId,
      status: 'waiting-for-result',
      taskId: `task-${index}`,
      timeoutAt: 1_000 + index + timeoutMs,
      workflowId: workflow.id,
    });
    updateCoordinatorWorkflowStage(workflow.runId, workflow.id, stageId, {
      startedAt: 1_000 + index,
      status: 'waiting-for-results',
    });
    appendCoordinatorWorkflowJournal(workflow.runId, workflow.id, {
      at: 1_000 + index,
      kind: 'lane-running',
      laneId: lane.id,
      message: `Lane ${lane.name} is running.`,
      stageId,
    });
    return { laneId: lane.id };
  };
}

interface HeldDecisionApprovalFixture {
  approvalId: string;
  decisionLaneId: string;
  resultId: string;
  runId: string;
  spawnLane: SpawnCoordinatorWorkflowLane;
  workflowId: string;
}

async function createHeldDecisionApproval(
  options: {
    actions?: unknown[];
    maxTotalLanes?: number;
    resultStatus?: 'blocked' | 'completed';
  } = {},
): Promise<HeldDecisionApprovalFixture> {
  const run = createRun();
  const spawnLane = createFakeSpawnLane();
  const started = await startCoordinatorWorkflowExecution({
    ...(options.maxTotalLanes !== undefined
      ? { policy: { maxTotalLanes: options.maxTotalLanes } }
      : {}),
    problem: 'Decide the next follow-up.',
    runId: run.id,
    spawnLane,
    spec: {
      steps: [
        { id: 'scout', kind: 'worker', name: 'Scout' },
        {
          dependsOn: ['scout'],
          id: 'decide',
          kind: 'decision',
          name: 'Decide',
          sourceStepIds: ['scout'],
        },
        { dependsOn: ['decide'], id: 'report', kind: 'worker', name: 'Report' },
      ],
    },
    template: 'custom',
    title: 'Gated decision workflow',
  });
  const workflowId = started.workflow.id;
  const initialWorkflow = getCoordinatorWorkflow(run.id, workflowId);
  const scoutLane = initialWorkflow?.lanes.find((lane) => lane.stageId === 'scout');
  if (!initialWorkflow || !scoutLane) {
    throw new Error('Expected scout lane');
  }
  completeWorkflowLane(initialWorkflow, scoutLane.id);
  await advanceCoordinatorWorkflowExecution({
    laneId: scoutLane.id,
    runId: run.id,
    spawnLane,
    workflowId,
  });

  const decisionWorkflow = getCoordinatorWorkflow(run.id, workflowId);
  const decisionLane = decisionWorkflow?.lanes.find((lane) => lane.stageId === 'decide');
  if (!decisionWorkflow || !decisionLane?.taskId) {
    throw new Error('Expected decision lane');
  }

  const result = addCoordinatorWorkflowResult({
    result: {
      agentId: decisionLane.agentId ?? 'agent-decision',
      commandsRun: [],
      evidence: [],
      findings: [],
      laneId: decisionLane.id,
      risks: [],
      stageId: decisionLane.stageId,
      status: options.resultStatus ?? 'completed',
      summary: 'Gated decision result.',
      taskId: decisionLane.taskId,
      workflowId,
    },
    runId: run.id,
    workflowId,
  });
  const actions = normalizeCoordinatorWorkflowDynamicActions(
    options.actions ?? [{ id: 'followup', kind: 'append_worker', name: 'Followup' }],
    {
      limits: {
        assignmentTextMaxChars: COORDINATOR_LIMITS.assignmentTextMaxChars,
        maxWorkflowLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
        maxWorkflowMetadataBytes: COORDINATOR_LIMITS.maxWorkflowMetadataBytes,
        maxWorkflowShortTextChars: COORDINATOR_LIMITS.maxWorkflowShortTextChars,
        workflowMaxLaneTimeoutMs: COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs,
      },
    },
  );
  validateWorkflowDecisionActionsForResult(decisionWorkflow, decisionLane, result.id, actions);
  const approval = recordPendingWorkflowApproval({
    actions,
    laneId: decisionLane.id,
    resultId: result.id,
    runId: run.id,
    stageId: decisionLane.stageId,
    workflowId,
  });

  return {
    approvalId: approval.id,
    decisionLaneId: decisionLane.id,
    resultId: result.id,
    runId: run.id,
    spawnLane,
    workflowId,
  };
}

function restartCoordinatorRuntime(): void {
  const persisted = getCoordinatorRuntimeState();
  resetCoordinatorRuntimeForTests();
  restoreCoordinatorRuntimeState(persisted);
}

function createRecordingRespawnLane(respawnedLaneIds: string[]): RespawnCoordinatorWorkflowLane {
  return async function respawnLane(_workflow, lane) {
    respawnedLaneIds.push(lane.id);
    return { laneId: lane.id };
  };
}

function createNeverSpawnedFirstSpawnLane(): SpawnCoordinatorWorkflowLane {
  let spawnCount = 0;
  return async function spawnLane(workflow, stageId, lanePayload) {
    spawnCount += 1;
    const existingLane = getCoordinatorWorkflow(workflow.runId, workflow.id)?.lanes.find(
      (candidate) => candidate.dedupeKey === lanePayload.dedupeKey,
    );
    if (existingLane) {
      return { laneId: existingLane.id };
    }

    const neverSpawned = spawnCount === 1;
    const lane = addCoordinatorWorkflowLane({
      assignment: lanePayload.assignment,
      ...(lanePayload.attempt !== undefined ? { attempt: lanePayload.attempt } : {}),
      ...(lanePayload.dedupeKey !== undefined ? { dedupeKey: lanePayload.dedupeKey } : {}),
      name: lanePayload.name,
      ...(lanePayload.role !== undefined ? { role: lanePayload.role } : {}),
      runId: workflow.runId,
      ...(lanePayload.spawnedBy !== undefined ? { spawnedBy: lanePayload.spawnedBy } : {}),
      stageId,
      status: neverSpawned ? 'spawning' : 'waiting-for-result',
      ...(neverSpawned ? {} : { agentId: `agent-${spawnCount}`, taskId: `task-${spawnCount}` }),
      workflowId: workflow.id,
    });
    updateCoordinatorWorkflowStage(workflow.runId, workflow.id, stageId, {
      status: 'waiting-for-results',
    });
    return { laneId: lane.id };
  };
}

function completeWorkflowLane(
  workflow: NonNullable<ReturnType<typeof getCoordinatorWorkflow>>,
  laneId: string,
): void {
  const lane = workflow.lanes.find((candidate) => candidate.id === laneId);
  if (!lane) {
    throw new Error(`Missing workflow lane ${laneId}`);
  }

  const result = addCoordinatorWorkflowResult({
    result: {
      agentId: lane.agentId ?? 'agent-unknown',
      commandsRun: [],
      evidence: [],
      findings: [],
      laneId: lane.id,
      risks: [],
      stageId: lane.stageId,
      status: 'completed',
      summary: `Completed ${lane.name}.`,
      taskId: lane.taskId ?? 'task-unknown',
      workflowId: workflow.id,
    },
    runId: workflow.runId,
    workflowId: workflow.id,
  });
  updateCoordinatorWorkflowLane(workflow.runId, workflow.id, lane.id, {
    completedAt: Date.now(),
    resultId: result.id,
    status: 'completed',
  });
  appendCoordinatorWorkflowJournal(workflow.runId, workflow.id, {
    kind: 'lane-result',
    laneId: lane.id,
    message: result.summary,
    resultId: result.id,
    stageId: lane.stageId,
  });
}

describe('coordinator workflow executor', () => {
  beforeEach(() => {
    resetCoordinatorRuntimeForTests();
  });

  it('marks timed-out lanes terminal and retries while retry budget remains', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { retryBackoffMs: 0, retryCount: 1, timeoutMs: 5 },
      problem: 'Review timeout handling.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            assignment: 'Run a slow lane.',
            id: 'worker',
            kind: 'worker',
          },
        ],
      },
      template: 'custom',
      title: 'Timeout review',
    });

    const workflowId = started.workflow.id;
    await tickCoordinatorWorkflowExecution({
      now: 2_000,
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const workflow = getCoordinatorWorkflow(run.id, workflowId);
    expect(workflow?.lanes).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: 'timed-out',
      }),
      expect.objectContaining({
        attempt: 2,
        status: 'waiting-for-result',
      }),
    ]);
    expect(workflow?.execution).toMatchObject({
      activeLaneCount: 1,
      pendingRetryLaneIds: [],
    });
  });

  it('fails the workflow when a required lane times out without retry budget', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { retryCount: 0, timeoutMs: 5 },
      problem: 'Review timeout handling.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            assignment: 'Run a slow lane.',
            id: 'worker',
            kind: 'worker',
          },
        ],
      },
      template: 'custom',
      title: 'Timeout review',
    });

    await tickCoordinatorWorkflowExecution({
      now: 2_000,
      runId: run.id,
      spawnLane,
      workflowId: started.workflow.id,
    });

    const workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    expect(workflow).toMatchObject({
      status: 'failed',
      stages: [expect.objectContaining({ status: 'failed' })],
      lanes: [expect.objectContaining({ status: 'timed-out' })],
    });
  });

  it('rejects specs with any stage wider than workflow concurrency', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();

    await expect(
      startCoordinatorWorkflowExecution({
        policy: { maxConcurrentLanes: 1 },
        problem: 'Review impossible fanout.',
        runId: run.id,
        spawnLane,
        spec: {
          steps: [
            {
              assignment: 'Prepare context.',
              id: 'prepare',
              kind: 'worker',
            },
            {
              dependsOn: ['prepare'],
              id: 'wide',
              kind: 'fanout',
              lanes: [
                { assignment: 'Lane A', id: 'lane-a', name: 'Lane A' },
                { assignment: 'Lane B', id: 'lane-b', name: 'Lane B' },
              ],
            },
          ],
        },
        template: 'custom',
        title: 'Impossible fanout',
      }),
    ).rejects.toThrow('start_workflow exceeds workflow maxConcurrentLanes');
  });

  it('counts fixed-template follow-up lanes toward the workflow lane cap', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();

    await expect(
      startCoordinatorWorkflowExecution({
        lanes: Array.from({ length: COORDINATOR_LIMITS.maxWorkflowLanes }, (_, index) => ({
          assignment: `Map lane ${index}`,
          name: `Lane ${index}`,
        })),
        problem: 'Review template lane cap.',
        runId: run.id,
        spawnLane,
        template: 'map_reduce',
        title: 'Template cap',
      }),
    ).rejects.toThrow(`above limit ${COORDINATOR_LIMITS.maxWorkflowLanes}`);
  });

  it('honors step retry policy and retry backoff', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { retryCount: 0, timeoutMs: 1_000 },
      problem: 'Review step policy.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            assignment: 'Run a step-policy lane.',
            id: 'worker',
            kind: 'worker',
            policy: {
              retryBackoffMs: 500,
              retryCount: 1,
              timeoutMs: 5,
            },
          },
        ],
      },
      template: 'custom',
      title: 'Step policy review',
    });

    await tickCoordinatorWorkflowExecution({
      now: 2_000,
      runId: run.id,
      spawnLane,
      workflowId: started.workflow.id,
    });

    let workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    expect(workflow).toMatchObject({
      status: 'running',
      stages: [expect.objectContaining({ status: 'waiting-for-results' })],
    });
    expect(workflow?.lanes).toEqual([
      expect.objectContaining({
        failure: 'Lane timed out after 5 ms.',
        status: 'timed-out',
      }),
    ]);
    expect(workflow?.execution).toMatchObject({
      nextRetryAt: 2_500,
      pendingRetryLaneIds: [expect.any(String)],
    });

    await tickCoordinatorWorkflowExecution({
      now: 2_501,
      runId: run.id,
      spawnLane,
      workflowId: started.workflow.id,
    });

    workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    expect(workflow?.lanes).toEqual([
      expect.objectContaining({ attempt: 1, status: 'timed-out' }),
      expect.objectContaining({ attempt: 2, status: 'waiting-for-result' }),
    ]);
  });

  it('rejects custom specs on fixed workflow templates', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();

    await expect(
      startCoordinatorWorkflowExecution({
        problem: 'Review template mismatch.',
        runId: run.id,
        spawnLane,
        spec: {
          steps: [{ id: 'worker', kind: 'worker' }],
        },
        template: 'map_reduce',
        title: 'Template mismatch',
      }),
    ).rejects.toThrow('spec is only supported with the custom workflow template');
  });

  it('appends dependent steps and spawns them after their dependency completes', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Explore adaptive follow-up.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ id: 'scout', kind: 'worker', name: 'Scout' }],
      },
      template: 'custom',
      title: 'Adaptive review',
    });
    const initialLane = started.workflow.lanes[0];
    if (!initialLane) {
      throw new Error('Expected initial workflow lane');
    }

    const appended = await appendCoordinatorWorkflowExecutionSteps({
      appendId: 'append-followups',
      reason: 'Scout requested parallel follow-up.',
      runId: run.id,
      sourceLaneId: initialLane.id,
      sourceTaskId: initialLane.taskId ?? 'task-1',
      spawnLane,
      steps: [
        {
          dependsOn: ['scout'],
          id: 'followups',
          kind: 'fanout',
          lanes: [
            { assignment: 'Follow backend.', id: 'backend', name: 'Backend' },
            { assignment: 'Follow UI.', id: 'ui', name: 'UI' },
          ],
        },
      ],
      workflowId: started.workflow.id,
    });

    expect(appended.lanes).toHaveLength(0);
    expect(appended.append).toMatchObject({
      appendId: 'append-followups',
      reason: 'Scout requested parallel follow-up.',
      stepIds: ['followups'],
    });
    expect(appended.workflow).toMatchObject({
      sourceSpec: {
        steps: [
          expect.objectContaining({ id: 'scout' }),
          expect.objectContaining({ dependsOn: ['scout'], id: 'followups' }),
        ],
      },
      stages: [
        expect.objectContaining({ id: 'scout' }),
        expect.objectContaining({ id: 'followups', status: 'pending' }),
      ],
      stepAppends: [expect.objectContaining({ appendId: 'append-followups' })],
    });

    const workflowBeforeCompletion = getCoordinatorWorkflow(run.id, started.workflow.id);
    if (!workflowBeforeCompletion?.lanes[0]) {
      throw new Error('Expected initial workflow lane');
    }
    completeWorkflowLane(workflowBeforeCompletion, workflowBeforeCompletion.lanes[0].id);

    await advanceCoordinatorWorkflowExecution({
      laneId: workflowBeforeCompletion.lanes[0].id,
      runId: run.id,
      spawnLane,
      workflowId: started.workflow.id,
    });

    const workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    expect(workflow?.stages).toEqual([
      expect.objectContaining({ id: 'scout', status: 'completed' }),
      expect.objectContaining({ id: 'followups', status: 'waiting-for-results' }),
    ]);
    expect(workflow?.lanes).toEqual([
      expect.objectContaining({ name: 'Scout', status: 'completed' }),
      expect.objectContaining({ name: 'Backend', stageId: 'followups' }),
      expect.objectContaining({ name: 'UI', stageId: 'followups' }),
    ]);
  });

  it('reopens completed workflows for idempotent appended steps', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Run the first step.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ id: 'first', kind: 'worker', name: 'First' }],
      },
      template: 'custom',
      title: 'Adaptive completion',
    });
    const initialWorkflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    if (!initialWorkflow?.lanes[0]) {
      throw new Error('Expected initial workflow lane');
    }
    completeWorkflowLane(initialWorkflow, initialWorkflow.lanes[0].id);

    const completed = await advanceCoordinatorWorkflowExecution({
      laneId: initialWorkflow.lanes[0].id,
      runId: run.id,
      spawnLane,
      workflowId: started.workflow.id,
    });
    expect(completed.status).toBe('completed');

    const steps = [{ id: 'second', kind: 'worker', name: 'Second' }];
    const appended = await appendCoordinatorWorkflowExecutionSteps({
      appendId: 'append-second',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      spawnLane,
      steps,
      workflowId: started.workflow.id,
    });

    expect(appended.workflow.status).toBe('running');
    expect(appended.workflow.completedAt).toBeUndefined();
    expect(appended.workflow.lanes).toEqual([
      expect.objectContaining({ name: 'First', status: 'completed' }),
      expect.objectContaining({ name: 'Second', status: 'waiting-for-result' }),
    ]);

    const repeated = await appendCoordinatorWorkflowExecutionSteps({
      appendId: 'append-second',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      spawnLane,
      steps,
      workflowId: started.workflow.id,
    });
    expect(repeated.lanes).toHaveLength(0);
    expect(repeated.workflow.lanes).toHaveLength(2);

    await expect(
      appendCoordinatorWorkflowExecutionSteps({
        appendId: 'append-second',
        runId: run.id,
        sourceTaskId: 'task-coordinator',
        spawnLane,
        steps: [{ id: 'third', kind: 'worker', name: 'Third' }],
        workflowId: started.workflow.id,
      }),
    ).rejects.toThrow('appendId was already used with different workflow steps');
  });

  it('rejects appends for failed workflows without mutating the workflow', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Run the first step.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ id: 'first', kind: 'worker', name: 'First' }],
      },
      template: 'custom',
      title: 'Adaptive failed workflow',
    });

    updateCoordinatorWorkflow(run.id, started.workflow.id, {
      completedAt: Date.now(),
      status: 'failed',
    });

    await expect(
      appendCoordinatorWorkflowExecutionSteps({
        appendId: 'append-after-failure',
        runId: run.id,
        sourceTaskId: 'task-coordinator',
        spawnLane,
        steps: [{ id: 'second', kind: 'worker', name: 'Second' }],
        workflowId: started.workflow.id,
      }),
    ).rejects.toThrow('Coordinator workflow is failed');

    const workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    expect(workflow?.status).toBe('failed');
    expect(workflow?.sourceSpec?.steps.map((step) => step.id)).toEqual(['first']);
    expect(workflow?.stages.map((stage) => stage.id)).toEqual(['first']);
    expect(workflow?.stepAppends).toBeUndefined();
  });

  it('rejects appended lane dedupe collisions without mutating the workflow', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Run the first step.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ id: 'first', kind: 'worker', name: 'First' }],
      },
      template: 'custom',
      title: 'Adaptive collision',
    });
    const existingDedupeKey = started.workflow.lanes[0]?.dedupeKey;
    if (existingDedupeKey === undefined) {
      throw new Error('Expected first lane dedupe key');
    }

    await expect(
      appendCoordinatorWorkflowExecutionSteps({
        appendId: 'append-collision',
        runId: run.id,
        sourceTaskId: 'task-coordinator',
        spawnLane,
        steps: [
          {
            id: 'collision',
            kind: 'fanout',
            lanes: [
              {
                assignment: 'Collide with the first lane.',
                dedupeKey: existingDedupeKey,
                id: 'colliding-lane',
                name: 'Colliding lane',
              },
            ],
          },
        ],
        workflowId: started.workflow.id,
      }),
    ).rejects.toThrow('reuse lane dedupeKey');

    const workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    expect(workflow?.sourceSpec?.steps.map((step) => step.id)).toEqual(['first']);
    expect(workflow?.stages.map((stage) => stage.id)).toEqual(['first']);
    expect(workflow?.stepAppends).toBeUndefined();
  });

  it('applies decision-lane append actions and records workflow expansions', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Decide the next follow-up.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          { id: 'scout', kind: 'worker', name: 'Scout' },
          {
            dependsOn: ['scout'],
            id: 'decide',
            kind: 'decision',
            name: 'Decide',
            sourceStepIds: ['scout'],
          },
        ],
      },
      template: 'custom',
      title: 'Decision workflow',
    });

    const initialWorkflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    if (!initialWorkflow?.lanes[0]) {
      throw new Error('Expected initial scout lane');
    }
    completeWorkflowLane(initialWorkflow, initialWorkflow.lanes[0].id);
    await advanceCoordinatorWorkflowExecution({
      laneId: initialWorkflow.lanes[0].id,
      runId: run.id,
      spawnLane,
      workflowId: started.workflow.id,
    });

    const decisionWorkflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    const decisionLane = decisionWorkflow?.lanes.find((lane) => lane.stageId === 'decide');
    if (!decisionWorkflow || !decisionLane?.taskId) {
      throw new Error('Expected decision lane');
    }

    const result = addCoordinatorWorkflowResult({
      result: {
        agentId: decisionLane.agentId ?? 'agent-decision',
        commandsRun: [],
        evidence: [],
        findings: [],
        laneId: decisionLane.id,
        risks: [],
        stageId: decisionLane.stageId,
        status: 'completed',
        summary: 'Append a focused follow-up.',
        taskId: decisionLane.taskId,
        workflowId: decisionWorkflow.id,
      },
      runId: run.id,
      workflowId: decisionWorkflow.id,
    });
    updateCoordinatorWorkflowLane(run.id, decisionWorkflow.id, decisionLane.id, {
      completedAt: Date.now(),
      resultId: result.id,
      status: 'completed',
    });

    const actions = normalizeCoordinatorWorkflowDynamicActions(
      [{ id: 'followup', kind: 'append_worker', name: 'Followup' }],
      {
        limits: {
          assignmentTextMaxChars: COORDINATOR_LIMITS.assignmentTextMaxChars,
          maxWorkflowLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
          maxWorkflowMetadataBytes: COORDINATOR_LIMITS.maxWorkflowMetadataBytes,
          maxWorkflowShortTextChars: COORDINATOR_LIMITS.maxWorkflowShortTextChars,
          workflowMaxLaneTimeoutMs: COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs,
        },
      },
    );

    const advanced = await advanceCoordinatorWorkflowExecution({
      laneId: decisionLane.id,
      result,
      runId: run.id,
      sourceTaskId: decisionLane.taskId,
      spawnLane,
      workflowActions: actions,
      workflowId: decisionWorkflow.id,
    });

    expect(advanced.expansions).toEqual([
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            kind: 'append_worker',
            stepIds: ['followup'],
          }),
        ],
        sourceLaneId: decisionLane.id,
        sourceResultId: result.id,
      }),
    ]);
    expect(advanced.stepAppends).toEqual([
      expect.objectContaining({
        sourceLaneId: decisionLane.id,
        stepIds: ['followup'],
      }),
    ]);
    expect(advanced.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'decide', status: 'completed' }),
        expect.objectContaining({ id: 'followup', status: 'waiting-for-results' }),
      ]),
    );
  });

  it('applies batched decision append actions atomically even when dependencies are out of order', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Decide the next follow-up.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          { id: 'scout', kind: 'worker', name: 'Scout' },
          {
            dependsOn: ['scout'],
            id: 'decide',
            kind: 'decision',
            name: 'Decide',
            sourceStepIds: ['scout'],
          },
        ],
      },
      template: 'custom',
      title: 'Decision workflow',
    });

    const initialWorkflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    if (!initialWorkflow?.lanes[0]) {
      throw new Error('Expected initial scout lane');
    }
    completeWorkflowLane(initialWorkflow, initialWorkflow.lanes[0].id);
    await advanceCoordinatorWorkflowExecution({
      laneId: initialWorkflow.lanes[0].id,
      runId: run.id,
      spawnLane,
      workflowId: started.workflow.id,
    });

    const decisionWorkflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    const decisionLane = decisionWorkflow?.lanes.find((lane) => lane.stageId === 'decide');
    if (!decisionWorkflow || !decisionLane?.taskId) {
      throw new Error('Expected decision lane');
    }

    const result = addCoordinatorWorkflowResult({
      result: {
        agentId: decisionLane.agentId ?? 'agent-decision',
        commandsRun: [],
        evidence: [],
        findings: [],
        laneId: decisionLane.id,
        risks: [],
        stageId: decisionLane.stageId,
        status: 'completed',
        summary: 'Append dependent follow-up work.',
        taskId: decisionLane.taskId,
        workflowId: decisionWorkflow.id,
      },
      runId: run.id,
      workflowId: decisionWorkflow.id,
    });
    updateCoordinatorWorkflowLane(run.id, decisionWorkflow.id, decisionLane.id, {
      completedAt: Date.now(),
      resultId: result.id,
      status: 'completed',
    });

    const actions = normalizeCoordinatorWorkflowDynamicActions(
      [
        {
          dependsOn: ['followup'],
          id: 'summary',
          kind: 'append_synthesize',
          name: 'Summary',
          sourceStepIds: ['followup'],
        },
        {
          dependsOn: ['decide'],
          id: 'followup',
          kind: 'append_worker',
          name: 'Followup',
        },
      ],
      {
        limits: {
          assignmentTextMaxChars: COORDINATOR_LIMITS.assignmentTextMaxChars,
          maxWorkflowLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
          maxWorkflowMetadataBytes: COORDINATOR_LIMITS.maxWorkflowMetadataBytes,
          maxWorkflowShortTextChars: COORDINATOR_LIMITS.maxWorkflowShortTextChars,
          workflowMaxLaneTimeoutMs: COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs,
        },
      },
    );

    const advanced = await advanceCoordinatorWorkflowExecution({
      laneId: decisionLane.id,
      result,
      runId: run.id,
      sourceTaskId: decisionLane.taskId,
      spawnLane,
      workflowActions: actions,
      workflowId: decisionWorkflow.id,
    });

    expect(advanced.stepAppends).toEqual([
      expect.objectContaining({
        appendId: `${result.id}:workflow-actions`,
        stepIds: ['summary', 'followup'],
      }),
    ]);
    expect(advanced.expansions).toEqual([
      expect.objectContaining({
        actions: [
          expect.objectContaining({ actionId: `${result.id}:action:1`, stepIds: ['summary'] }),
          expect.objectContaining({ actionId: `${result.id}:action:2`, stepIds: ['followup'] }),
        ],
      }),
    ]);
    expect(advanced.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'followup', status: 'waiting-for-results' }),
        expect.objectContaining({ id: 'summary', status: 'pending' }),
      ]),
    );
  });

  it('lets decision lanes block the workflow and skip pending stages', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Decide whether user input is required.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          { id: 'scout', kind: 'worker', name: 'Scout' },
          {
            dependsOn: ['scout'],
            id: 'decide',
            kind: 'decision',
            name: 'Decide',
            sourceStepIds: ['scout'],
          },
          {
            dependsOn: ['decide'],
            id: 'followup',
            kind: 'worker',
            name: 'Followup',
          },
        ],
      },
      template: 'custom',
      title: 'Blocking decision workflow',
    });

    const initialWorkflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    if (!initialWorkflow?.lanes[0]) {
      throw new Error('Expected initial scout lane');
    }
    completeWorkflowLane(initialWorkflow, initialWorkflow.lanes[0].id);
    await advanceCoordinatorWorkflowExecution({
      laneId: initialWorkflow.lanes[0].id,
      runId: run.id,
      spawnLane,
      workflowId: started.workflow.id,
    });

    const decisionWorkflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    const decisionLane = decisionWorkflow?.lanes.find((lane) => lane.stageId === 'decide');
    if (!decisionWorkflow || !decisionLane?.taskId) {
      throw new Error('Expected decision lane');
    }

    const result = addCoordinatorWorkflowResult({
      result: {
        agentId: decisionLane.agentId ?? 'agent-decision',
        commandsRun: [],
        evidence: [],
        findings: [],
        laneId: decisionLane.id,
        risks: [],
        stageId: decisionLane.stageId,
        status: 'blocked',
        summary: 'Need a user decision before continuing.',
        taskId: decisionLane.taskId,
        workflowId: decisionWorkflow.id,
      },
      runId: run.id,
      workflowId: decisionWorkflow.id,
    });
    updateCoordinatorWorkflowLane(run.id, decisionWorkflow.id, decisionLane.id, {
      completedAt: Date.now(),
      resultId: result.id,
      status: 'blocked',
    });

    const actions = normalizeCoordinatorWorkflowDynamicActions(
      [{ kind: 'mark_blocked', reason: 'Need user approval before the follow-up lane runs.' }],
      {
        limits: {
          assignmentTextMaxChars: COORDINATOR_LIMITS.assignmentTextMaxChars,
          maxWorkflowLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
          maxWorkflowMetadataBytes: COORDINATOR_LIMITS.maxWorkflowMetadataBytes,
          maxWorkflowShortTextChars: COORDINATOR_LIMITS.maxWorkflowShortTextChars,
          workflowMaxLaneTimeoutMs: COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs,
        },
      },
    );

    const advanced = await advanceCoordinatorWorkflowExecution({
      laneId: decisionLane.id,
      result,
      runId: run.id,
      sourceTaskId: decisionLane.taskId,
      spawnLane,
      workflowActions: actions,
      workflowId: decisionWorkflow.id,
    });

    expect(advanced.status).toBe('blocked');
    expect(advanced.execution?.blockedReason).toBe(
      'Need user approval before the follow-up lane runs.',
    );
    expect(advanced.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'decide', status: 'blocked' }),
        expect.objectContaining({ id: 'followup', status: 'skipped' }),
      ]),
    );
  });

  it('unblocks downstream work once a quorum join is satisfied even if one fanout lane is still active', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Review coordinator workflow runtime and UI gaps.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            id: 'scan',
            kind: 'fanout',
            lanes: [
              { assignment: 'Scan backend.', id: 'backend', name: 'Backend' },
              { assignment: 'Scan UI.', id: 'ui', name: 'UI' },
              { assignment: 'Scan docs.', id: 'docs', name: 'Docs' },
            ],
            policy: {
              joinMode: 'quorum',
              quorumCount: 2,
            },
          },
          {
            dependsOn: ['scan'],
            id: 'synthesize',
            kind: 'synthesize',
            sourceStepIds: ['scan'],
          },
        ],
      },
      template: 'custom',
      title: 'Quorum review',
    });

    let workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    if (!workflow) {
      throw new Error('Expected workflow');
    }

    const scanLanes = workflow.lanes.filter((lane) => lane.stageId === 'scan');
    const backendLaneId = scanLanes[0]?.id;
    const uiLaneId = scanLanes[1]?.id;
    if (!backendLaneId || !uiLaneId) {
      throw new Error('Expected quorum lanes');
    }
    completeWorkflowLane(workflow, backendLaneId);
    workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    if (!workflow) {
      throw new Error('Expected workflow after first result');
    }
    completeWorkflowLane(workflow, uiLaneId);

    await advanceCoordinatorWorkflowExecution({
      laneId: uiLaneId,
      runId: run.id,
      spawnLane,
      workflowId: started.workflow.id,
    });

    workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    expect(workflow?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'scan', status: 'waiting-for-results' }),
        expect.objectContaining({ id: 'synthesize', status: 'waiting-for-results' }),
      ]),
    );
    expect(workflow?.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stageId: 'scan', name: 'Docs', status: 'waiting-for-result' }),
        expect.objectContaining({ stageId: 'synthesize', status: 'waiting-for-result' }),
      ]),
    );
  });

  it('unblocks downstream work once a first-success join receives one completed result', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Review whether one strong repo scan can unblock a summary lane.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            id: 'scan',
            kind: 'fanout',
            lanes: [
              { assignment: 'Scan runtime changes.', id: 'runtime', name: 'Runtime' },
              { assignment: 'Scan UI changes.', id: 'ui', name: 'UI' },
            ],
            policy: {
              joinMode: 'first-success',
            },
          },
          {
            dependsOn: ['scan'],
            id: 'synthesize',
            kind: 'synthesize',
            sourceStepIds: ['scan'],
          },
        ],
      },
      template: 'custom',
      title: 'First-success review',
    });

    let workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    if (!workflow) {
      throw new Error('Expected workflow');
    }

    const runtimeLaneId = workflow.lanes.find((lane) => lane.stageId === 'scan')?.id;
    if (!runtimeLaneId) {
      throw new Error('Expected runtime scan lane');
    }
    completeWorkflowLane(workflow, runtimeLaneId);

    await advanceCoordinatorWorkflowExecution({
      laneId: runtimeLaneId,
      runId: run.id,
      spawnLane,
      workflowId: started.workflow.id,
    });

    workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    expect(workflow?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'scan', status: 'waiting-for-results' }),
        expect.objectContaining({ id: 'synthesize', status: 'waiting-for-results' }),
      ]),
    );
    expect(workflow?.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stageId: 'scan', name: 'UI', status: 'waiting-for-result' }),
        expect.objectContaining({ stageId: 'synthesize', status: 'waiting-for-result' }),
      ]),
    );
  });

  it('expands append_branch_bundle into fanout, verify, and reduce follow-up steps with iteration tracking', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Decide whether the review needs a focused second pass.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          { id: 'scan', kind: 'worker', name: 'Scan' },
          {
            dependsOn: ['scan'],
            id: 'decide',
            kind: 'decision',
            lanes: [],
            name: 'Decide',
            sourceStepIds: ['scan'],
          },
        ],
      },
      template: 'custom',
      title: 'Branch bundle review',
    });

    let workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    if (!workflow) {
      throw new Error('Expected started workflow');
    }
    const scanLane = workflow.lanes.find((lane) => lane.stageId === 'scan');
    if (!scanLane) {
      throw new Error('Expected scan lane');
    }
    completeWorkflowLane(workflow, scanLane.id);
    await advanceCoordinatorWorkflowExecution({
      laneId: scanLane.id,
      runId: run.id,
      spawnLane,
      workflowId: started.workflow.id,
    });

    workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    const decisionLane = workflow?.lanes.find((lane) => lane.stageId === 'decide');
    if (!workflow || !decisionLane || !decisionLane.taskId) {
      throw new Error('Expected decision lane');
    }
    const result = addCoordinatorWorkflowResult({
      result: {
        agentId: decisionLane.agentId ?? 'agent-decision',
        commandsRun: [],
        evidence: [],
        findings: [],
        id: 'decision-result',
        laneId: decisionLane.id,
        risks: [],
        stageId: decisionLane.stageId,
        status: 'completed',
        summary: 'Need a focused deep-dive branch.',
        taskId: decisionLane.taskId,
        workflowId: workflow.id,
      },
      runId: run.id,
      workflowId: workflow.id,
    });
    updateCoordinatorWorkflowLane(run.id, workflow.id, decisionLane.id, {
      completedAt: Date.now(),
      resultId: result.id,
      status: 'completed',
    });

    const actions = normalizeCoordinatorWorkflowDynamicActions(
      [
        {
          branchKey: 'deep-dive',
          bundleId: 'deep-dive',
          kind: 'append_branch_bundle',
          lanes: [
            { assignment: 'Dive into backend execution.', id: 'backend', name: 'Backend' },
            { assignment: 'Dive into UI blockers.', id: 'ui', name: 'UI' },
          ],
          maxIterations: 2,
          name: 'Deep dive',
          reduce: {
            name: 'Reduce',
            prompt: 'Summarize the focused branch findings.',
          },
          verify: {
            joinMode: 'quorum',
            quorumCount: 1,
            verifiers: [
              { id: 'skeptic', name: 'Skeptic' },
              { id: 'archivist', name: 'Archivist' },
            ],
          },
        },
      ],
      {
        limits: {
          assignmentTextMaxChars: COORDINATOR_LIMITS.assignmentTextMaxChars,
          maxWorkflowBranchIterations: COORDINATOR_LIMITS.maxWorkflowBranchIterations,
          maxWorkflowLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
          maxWorkflowMetadataBytes: COORDINATOR_LIMITS.maxWorkflowMetadataBytes,
          maxWorkflowShortTextChars: COORDINATOR_LIMITS.maxWorkflowShortTextChars,
          workflowMaxLaneTimeoutMs: COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs,
        },
      },
    );

    const advanced = await advanceCoordinatorWorkflowExecution({
      laneId: decisionLane.id,
      result,
      runId: run.id,
      sourceTaskId: decisionLane.taskId,
      spawnLane,
      workflowActions: actions,
      workflowId: workflow.id,
    });

    expect(advanced.expansions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actions: [
            expect.objectContaining({
              branchKey: 'deep-dive',
              bundleId: 'deep-dive',
              iteration: 1,
              kind: 'append_branch_bundle',
              stepIds: ['deep-dive-fanout', 'deep-dive-verify', 'deep-dive-reduce'],
            }),
          ],
        }),
      ]),
    );
    expect(advanced.sourceSpec?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'deep-dive-fanout', kind: 'fanout' }),
        expect.objectContaining({
          id: 'deep-dive-verify',
          kind: 'verify',
          policy: expect.objectContaining({ joinMode: 'quorum', quorumCount: 1 }),
        }),
        expect.objectContaining({ id: 'deep-dive-reduce', kind: 'synthesize' }),
      ]),
    );
  });

  it('rejects append_branch_bundle once a branch exceeds the workflow iteration budget', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Decide whether a focused repo branch should run again.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          { id: 'scan', kind: 'worker', name: 'Scan' },
          {
            dependsOn: ['scan'],
            id: 'decide',
            kind: 'decision',
            name: 'Decide',
            sourceStepIds: ['scan'],
          },
        ],
      },
      template: 'custom',
      title: 'Iteration budget review',
    });

    let workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    if (!workflow) {
      throw new Error('Expected workflow');
    }

    const scanLaneId = workflow.lanes.find((lane) => lane.stageId === 'scan')?.id;
    if (!scanLaneId) {
      throw new Error('Expected scan lane');
    }
    completeWorkflowLane(workflow, scanLaneId);
    await advanceCoordinatorWorkflowExecution({
      laneId: scanLaneId,
      runId: run.id,
      spawnLane,
      workflowId: started.workflow.id,
    });

    workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    if (!workflow) {
      throw new Error('Expected workflow after scan completion');
    }
    const decisionLane = workflow.lanes.find((lane) => lane.stageId === 'decide');
    if (!decisionLane) {
      throw new Error('Expected decision lane');
    }

    workflow = updateCoordinatorWorkflow(run.id, workflow.id, {
      expansions: [
        {
          actions: [
            {
              actionId: 'branch-1',
              branchKey: 'focused-followup',
              bundleId: 'focused-followup',
              iteration: 1,
              kind: 'append_branch_bundle',
              stepIds: ['focused-followup-fanout'],
            },
          ],
          appendId: 'append-1',
          at: Date.now(),
          laneId: decisionLane.id,
          reason: 'First focused branch.',
          resultId: 'decision-result-1',
          stepIds: ['focused-followup-fanout'],
        },
      ],
    });

    const actions = normalizeCoordinatorWorkflowDynamicActions(
      [
        {
          branchKey: 'focused-followup',
          bundleId: 'focused-followup',
          kind: 'append_branch_bundle',
          lanes: [{ assignment: 'Review the coordinator UI branch.', id: 'ui', name: 'UI' }],
          maxIterations: 1,
        },
      ],
      {
        limits: {
          assignmentTextMaxChars: COORDINATOR_LIMITS.assignmentTextMaxChars,
          maxWorkflowBranchIterations: COORDINATOR_LIMITS.maxWorkflowBranchIterations,
          maxWorkflowLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
          maxWorkflowMetadataBytes: COORDINATOR_LIMITS.maxWorkflowMetadataBytes,
          maxWorkflowShortTextChars: COORDINATOR_LIMITS.maxWorkflowShortTextChars,
          workflowMaxLaneTimeoutMs: COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs,
        },
      },
    );

    expect(() =>
      validateWorkflowDecisionActionsForResult(
        workflow,
        decisionLane,
        'decision-result-2',
        actions,
      ),
    ).toThrow('workflowActions branch focused-followup exceeds iteration limit 1');
  });

  it('cancels active lanes and prevents later scheduling', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Review cancellation.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            assignment: 'Run a cancellable lane.',
            id: 'worker',
            kind: 'worker',
          },
        ],
      },
      template: 'custom',
      title: 'Cancellation review',
    });

    const cancelled = cancelCoordinatorWorkflowExecution(
      run.id,
      started.workflow.id,
      'user-cancelled-workflow',
    );

    expect(cancelled).toMatchObject({
      execution: expect.objectContaining({
        blockedReason: 'user-cancelled-workflow',
        cancelledAt: expect.any(Number),
      }),
      status: 'cancelled',
      lanes: [expect.objectContaining({ status: 'cancelled' })],
    });
  });

  it('replays cached results and respawns only unfinished lanes with refreshed timeouts on resume', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { retryCount: 0, timeoutMs: 60_000 },
      problem: 'Review resume behavior.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            id: 'scan',
            kind: 'fanout',
            lanes: [
              { assignment: 'Scan A', id: 'lane-a', name: 'Lane A' },
              { assignment: 'Scan B', id: 'lane-b', name: 'Lane B' },
            ],
            policy: { joinMode: 'quorum', quorumCount: 1 },
          },
          {
            assignment: 'Synthesize results.',
            dependsOn: ['scan'],
            id: 'reduce',
            kind: 'worker',
          },
        ],
      },
      template: 'custom',
      title: 'Resume review',
    });
    const workflowId = started.workflow.id;
    let workflow = getCoordinatorWorkflow(run.id, workflowId);
    const completedLaneId = workflow?.lanes.find((lane) => lane.name === 'Lane A')?.id;
    if (!workflow || completedLaneId === undefined) {
      throw new Error('Missing workflow fixture lane');
    }
    completeWorkflowLane(workflow, completedLaneId);
    const resultIdBeforeRestart = getCoordinatorWorkflow(run.id, workflowId)?.results[0]?.id;

    restartCoordinatorRuntime();
    expect(getCoordinatorWorkflow(run.id, workflowId)?.status).toBe('stale-after-restore');

    const respawnedLaneIds: string[] = [];
    const resumed = await resumeCoordinatorWorkflowExecution({
      now: 50_000,
      respawnLane: createRecordingRespawnLane(respawnedLaneIds),
      runId: run.id,
      spawnLane,
      workflowId,
    });

    workflow = getCoordinatorWorkflow(run.id, workflowId);
    const completedLane = workflow?.lanes.find((lane) => lane.id === completedLaneId);
    const respawnedLane = workflow?.lanes.find((lane) => lane.name === 'Lane B');
    expect(workflow?.status).toBe('running');
    expect(completedLane).toMatchObject({
      resultId: resultIdBeforeRestart,
      status: 'completed',
    });
    expect(completedLane?.failure).toBeUndefined();
    expect(respawnedLane).toMatchObject({
      attempt: 1,
      status: 'waiting-for-result',
      timeoutAt: 50_000 + 60_000,
    });
    expect(respawnedLane?.failure).toBeUndefined();
    expect(respawnedLaneIds).toEqual([respawnedLane?.id]);
    expect(resumed.respawned).toEqual([respawnedLane?.taskId]);
    expect(resumed.failed).toEqual([]);
    expect(workflow?.results.map((result) => result.id)).toEqual([resultIdBeforeRestart]);
    expect(workflow?.journal.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(['workflow-resumed', 'lane-respawned']),
    );
    expect(workflow?.stages.find((stage) => stage.id === 'scan')?.status).toBe(
      'waiting-for-results',
    );
    expect(workflow?.stages.find((stage) => stage.id === 'reduce')).toMatchObject({
      laneIds: [expect.any(String)],
      status: 'waiting-for-results',
    });
  });

  it('isolates respawn failures to their lane and journals lane-respawn-failed', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { retryCount: 0, timeoutMs: 60_000 },
      problem: 'Review resume failure isolation.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            id: 'scan',
            kind: 'fanout',
            lanes: [
              { assignment: 'Scan A', id: 'lane-a', name: 'Lane A' },
              { assignment: 'Scan B', id: 'lane-b', name: 'Lane B' },
            ],
          },
        ],
      },
      template: 'custom',
      title: 'Resume failure isolation',
    });
    const workflowId = started.workflow.id;

    restartCoordinatorRuntime();

    const resumed = await resumeCoordinatorWorkflowExecution({
      respawnLane: async (_workflow, lane) => {
        if (lane.name === 'Lane A') {
          throw new Error('pty respawn failed');
        }
        return { laneId: lane.id };
      },
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const workflow = getCoordinatorWorkflow(run.id, workflowId);
    expect(workflow?.status).toBe('running');
    expect(workflow?.lanes.find((lane) => lane.name === 'Lane A')).toMatchObject({
      failure: 'pty respawn failed',
      status: 'failed',
    });
    expect(workflow?.lanes.find((lane) => lane.name === 'Lane B')).toMatchObject({
      status: 'waiting-for-result',
    });
    expect(workflow?.journal.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(['lane-respawn-failed']),
    );
    expect(resumed.failed).toEqual([
      expect.objectContaining({ reason: 'pty respawn failed', taskId: expect.any(String) }),
    ]);
    expect(resumed.respawned).toHaveLength(1);
  });

  it('replaces never-spawned stale lanes with deterministic resume lanes exactly once', async () => {
    const run = createRun();
    let spawnCount = 0;
    const spawnLane: SpawnCoordinatorWorkflowLane = async (workflow, stageId, lanePayload) => {
      spawnCount += 1;
      const existingLane = getCoordinatorWorkflow(workflow.runId, workflow.id)?.lanes.find(
        (candidate) => candidate.dedupeKey === lanePayload.dedupeKey,
      );
      if (existingLane) {
        return { laneId: existingLane.id };
      }

      const neverSpawned = spawnCount === 1;
      const lane = addCoordinatorWorkflowLane({
        assignment: lanePayload.assignment,
        ...(lanePayload.attempt !== undefined ? { attempt: lanePayload.attempt } : {}),
        ...(lanePayload.dedupeKey !== undefined ? { dedupeKey: lanePayload.dedupeKey } : {}),
        name: lanePayload.name,
        ...(lanePayload.role !== undefined ? { role: lanePayload.role } : {}),
        runId: workflow.runId,
        ...(lanePayload.spawnedBy !== undefined ? { spawnedBy: lanePayload.spawnedBy } : {}),
        stageId,
        status: neverSpawned ? 'spawning' : 'waiting-for-result',
        ...(neverSpawned ? {} : { agentId: `agent-${spawnCount}`, taskId: `task-${spawnCount}` }),
        workflowId: workflow.id,
      });
      updateCoordinatorWorkflowStage(workflow.runId, workflow.id, stageId, {
        status: 'waiting-for-results',
      });
      return { laneId: lane.id };
    };
    const started = await startCoordinatorWorkflowExecution({
      policy: { retryCount: 0, timeoutMs: 60_000 },
      problem: 'Review never-spawned lane replacement.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            assignment: 'Run the worker lane.',
            id: 'worker',
            kind: 'worker',
          },
        ],
      },
      template: 'custom',
      title: 'Resume replacement',
    });
    const workflowId = started.workflow.id;
    const originalLane = getCoordinatorWorkflow(run.id, workflowId)?.lanes[0];
    if (!originalLane) {
      throw new Error('Missing never-spawned lane fixture');
    }

    restartCoordinatorRuntime();
    const respawnedLaneIds: string[] = [];
    await resumeCoordinatorWorkflowExecution({
      respawnLane: createRecordingRespawnLane(respawnedLaneIds),
      runId: run.id,
      spawnLane,
      workflowId,
    });

    let workflow = getCoordinatorWorkflow(run.id, workflowId);
    const expectedDedupeKey = `${originalLane.dedupeKey ?? originalLane.id}:resume:2`;
    expect(respawnedLaneIds).toEqual([]);
    expect(workflow?.lanes.find((lane) => lane.id === originalLane.id)).toMatchObject({
      status: 'cancelled',
    });
    expect(workflow?.lanes.find((lane) => lane.dedupeKey === expectedDedupeKey)).toMatchObject({
      attempt: 2,
      spawnedBy: 'resume',
      status: 'waiting-for-result',
    });
    expect(workflow?.lanes).toHaveLength(2);

    restartCoordinatorRuntime();
    await resumeCoordinatorWorkflowExecution({
      respawnLane: createRecordingRespawnLane(respawnedLaneIds),
      runId: run.id,
      spawnLane,
      workflowId,
    });

    workflow = getCoordinatorWorkflow(run.id, workflowId);
    expect(workflow?.lanes).toHaveLength(2);
    expect(workflow?.lanes.filter((lane) => lane.dedupeKey === expectedDedupeKey)).toHaveLength(1);
  });

  it('completes the stage and workflow after a resume replacement lane submits its result', async () => {
    const run = createRun();
    const spawnLane = createNeverSpawnedFirstSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { retryCount: 0, timeoutMs: 60_000 },
      problem: 'Review resume replacement completion.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            assignment: 'Run the worker lane.',
            id: 'worker',
            kind: 'worker',
          },
        ],
      },
      template: 'custom',
      title: 'Resume replacement completion',
    });
    const workflowId = started.workflow.id;

    restartCoordinatorRuntime();
    const resumed = await resumeCoordinatorWorkflowExecution({
      respawnLane: createRecordingRespawnLane([]),
      runId: run.id,
      spawnLane,
      workflowId,
    });
    expect(resumed.failed).toEqual([]);

    let workflow = getCoordinatorWorkflow(run.id, workflowId);
    const replacement = workflow?.lanes.find((lane) => lane.spawnedBy === 'resume');
    if (!workflow || !replacement) {
      throw new Error('Missing resume replacement lane fixture');
    }
    completeWorkflowLane(workflow, replacement.id);
    await tickCoordinatorWorkflowExecution({
      now: 90_000,
      runId: run.id,
      spawnLane,
      workflowId,
    });

    workflow = getCoordinatorWorkflow(run.id, workflowId);
    expect(workflow?.lanes.map((lane) => lane.status).sort()).toEqual(['cancelled', 'completed']);
    expect(workflow?.stages.find((stage) => stage.id === 'worker')?.status).toBe('completed');
    expect(workflow?.status).toBe('completed');
    expect(workflow?.results).toHaveLength(1);
  });

  it('fails the never-spawned lane in the resumes audit when maxConcurrentLanes blocks the replacement', async () => {
    const run = createRun();
    const spawnLane = createNeverSpawnedFirstSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxConcurrentLanes: 1, retryCount: 0, timeoutMs: 60_000 },
      problem: 'Review resume replacement concurrency caps.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            assignment: 'Run the worker lane.',
            id: 'worker',
            kind: 'worker',
          },
        ],
      },
      template: 'custom',
      title: 'Resume replacement concurrency cap',
    });
    const workflowId = started.workflow.id;
    const originalLane = getCoordinatorWorkflow(run.id, workflowId)?.lanes[0];
    if (!originalLane) {
      throw new Error('Missing never-spawned lane fixture');
    }

    restartCoordinatorRuntime();
    addCoordinatorWorkflowLane({
      agentId: 'agent-pad',
      assignment: 'Keep the concurrency slot busy.',
      name: 'Pad lane',
      runId: run.id,
      stageId: 'worker',
      status: 'running',
      taskId: 'task-pad',
      workflowId,
    });
    const resumed = await resumeCoordinatorWorkflowExecution({
      respawnLane: createRecordingRespawnLane([]),
      runId: run.id,
      spawnLane,
      workflowId,
    });

    expect(resumed.failed).toEqual([
      { laneId: originalLane.id, reason: 'Workflow maxConcurrentLanes reached.' },
    ]);
    const workflow = getCoordinatorWorkflow(run.id, workflowId);
    expect(workflow?.status).toBe('running');
    expect(workflow?.lanes.find((lane) => lane.id === originalLane.id)).toMatchObject({
      failure: 'Workflow maxConcurrentLanes reached.',
      status: 'failed',
    });
    expect(workflow?.lanes.some((lane) => lane.spawnedBy === 'resume')).toBe(false);
    expect(workflow?.journal.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(['lane-respawn-failed']),
    );
  });

  it('fails the never-spawned lane in the resumes audit when the workflow lane limit blocks the replacement', async () => {
    const run = createRun();
    const spawnLane = createNeverSpawnedFirstSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { retryCount: 0, timeoutMs: 60_000 },
      problem: 'Review resume replacement lane limits.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            assignment: 'Run the worker lane.',
            id: 'worker',
            kind: 'worker',
          },
        ],
      },
      template: 'custom',
      title: 'Resume replacement lane limit',
    });
    const workflowId = started.workflow.id;
    const originalLane = getCoordinatorWorkflow(run.id, workflowId)?.lanes[0];
    if (!originalLane) {
      throw new Error('Missing never-spawned lane fixture');
    }
    for (let padIndex = 1; padIndex < COORDINATOR_LIMITS.maxWorkflowLanes; padIndex += 1) {
      addCoordinatorWorkflowLane({
        agentId: `agent-pad-${padIndex}`,
        assignment: 'Pad the workflow lane count.',
        name: `Pad lane ${padIndex}`,
        runId: run.id,
        stageId: 'worker',
        status: 'completed',
        taskId: `task-pad-${padIndex}`,
        workflowId,
      });
    }

    restartCoordinatorRuntime();
    const resumed = await resumeCoordinatorWorkflowExecution({
      respawnLane: createRecordingRespawnLane([]),
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const expectedReason = `Workflow lane limit ${COORDINATOR_LIMITS.maxWorkflowLanes} reached.`;
    expect(resumed.failed).toEqual([{ laneId: originalLane.id, reason: expectedReason }]);
    const workflow = getCoordinatorWorkflow(run.id, workflowId);
    expect(workflow?.lanes.find((lane) => lane.id === originalLane.id)).toMatchObject({
      failure: expectedReason,
      status: 'failed',
    });
    expect(workflow?.lanes.some((lane) => lane.spawnedBy === 'resume')).toBe(false);
    expect(workflow?.lanes).toHaveLength(COORDINATOR_LIMITS.maxWorkflowLanes);
  });

  it('replays recorded expansions and verdicts as immutable cached facts across restore and resume', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { retryCount: 0, timeoutMs: 60_000 },
      problem: 'Review cached-fact replay for expansions and verdicts.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            assignment: 'Run the worker lane.',
            id: 'worker',
            kind: 'worker',
          },
        ],
      },
      template: 'custom',
      title: 'Resume cached facts',
    });
    const workflowId = started.workflow.id;
    const workerLane = getCoordinatorWorkflow(run.id, workflowId)?.lanes[0];
    if (!workerLane) {
      throw new Error('Missing worker lane fixture');
    }
    updateCoordinatorWorkflow(run.id, workflowId, {
      expansions: [
        {
          actions: [
            {
              actionId: 'result-1:0',
              kind: 'append_worker',
              reason: 'Follow up on the worker findings.',
              stepIds: ['follow-up'],
            },
          ],
          createdAt: 2_000,
          id: 'result-1:expansion',
          sourceLaneId: workerLane.id,
          sourceResultId: 'result-1',
          sourceTaskId: workerLane.taskId ?? 'task-1',
        },
      ],
      verdicts: [
        {
          createdAt: 2_100,
          findingId: 'finding-1',
          id: 'verdict-1',
          reason: 'Reproduced the reported failure.',
          resultId: 'result-1',
          status: 'confirmed',
          verifierLaneId: workerLane.id,
        },
      ],
    });
    const before = getCoordinatorWorkflow(run.id, workflowId);

    restartCoordinatorRuntime();
    await resumeCoordinatorWorkflowExecution({
      respawnLane: createRecordingRespawnLane([]),
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const afterResume = getCoordinatorWorkflow(run.id, workflowId);
    expect(afterResume?.expansions).toEqual(before?.expansions);
    expect(afterResume?.verdicts).toEqual(before?.verdicts);

    restartCoordinatorRuntime();
    await resumeCoordinatorWorkflowExecution({
      respawnLane: createRecordingRespawnLane([]),
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const afterReplayedResume = getCoordinatorWorkflow(run.id, workflowId);
    expect(afterReplayedResume?.expansions).toEqual(before?.expansions);
    expect(afterReplayedResume?.verdicts).toEqual(before?.verdicts);
  });

  it('keeps appendId idempotency across restore and resume', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { retryCount: 0, timeoutMs: 60_000 },
      problem: 'Review append idempotency.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            assignment: 'Run the worker lane.',
            id: 'worker',
            kind: 'worker',
          },
        ],
      },
      template: 'custom',
      title: 'Resume appends',
    });
    const workflowId = started.workflow.id;
    const appendSteps = [
      {
        assignment: 'Follow up on the worker output.',
        dependsOn: ['worker'],
        id: 'followup',
        kind: 'worker',
      },
    ];
    const firstAppend = await appendCoordinatorWorkflowExecutionSteps({
      appendId: 'append-before-restart',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      spawnLane,
      steps: appendSteps,
      workflowId,
    });

    restartCoordinatorRuntime();
    await resumeCoordinatorWorkflowExecution({
      respawnLane: createRecordingRespawnLane([]),
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const replayed = await appendCoordinatorWorkflowExecutionSteps({
      appendId: 'append-before-restart',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      spawnLane,
      steps: appendSteps,
      workflowId,
    });
    expect(replayed.append).toEqual(firstAppend.append);
    expect(
      getCoordinatorWorkflow(run.id, workflowId)?.stages.filter((stage) => stage.id === 'followup'),
    ).toHaveLength(1);

    await expect(
      appendCoordinatorWorkflowExecutionSteps({
        appendId: 'append-before-restart',
        runId: run.id,
        sourceTaskId: 'task-coordinator',
        spawnLane,
        steps: [
          {
            assignment: 'A different follow-up.',
            dependsOn: ['worker'],
            id: 'followup-2',
            kind: 'worker',
          },
        ],
        workflowId,
      }),
    ).rejects.toThrow('appendId was already used with different workflow steps');
  });

  it('rejects resume for non-stale workflows', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Review resume rejection.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            assignment: 'Run the worker lane.',
            id: 'worker',
            kind: 'worker',
          },
        ],
      },
      template: 'custom',
      title: 'Resume rejection',
    });
    const workflowId = started.workflow.id;

    await expect(
      resumeCoordinatorWorkflowExecution({
        respawnLane: createRecordingRespawnLane([]),
        runId: run.id,
        spawnLane,
        workflowId,
      }),
    ).rejects.toThrow('Coordinator workflow is running');

    cancelCoordinatorWorkflowExecution(run.id, workflowId, 'user-cancelled-workflow');
    restartCoordinatorRuntime();

    await expect(
      resumeCoordinatorWorkflowExecution({
        respawnLane: createRecordingRespawnLane([]),
        runId: run.id,
        spawnLane,
        workflowId,
      }),
    ).rejects.toThrow('Coordinator workflow is cancelled');
  });

  it('rejects start_workflow specs above a lowered total-step budget without creating a workflow', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();

    await expect(
      startCoordinatorWorkflowExecution({
        policy: { maxTotalSteps: 1 },
        problem: 'Review the step budget.',
        runId: run.id,
        spawnLane,
        spec: {
          steps: [
            { id: 'first', kind: 'worker', name: 'First' },
            { dependsOn: ['first'], id: 'second', kind: 'worker', name: 'Second' },
          ],
        },
        template: 'custom',
        title: 'Step budget',
      }),
    ).rejects.toThrow('workflow spec creates 2 steps, above limit 1');

    const persistedRun = getCoordinatorRuntimeState().runs.find(
      (candidate) => candidate.id === run.id,
    );
    expect(persistedRun?.workflows).toHaveLength(0);
  });

  it('rejects appends above the total-step budget without mutating the workflow', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxTotalSteps: 2 },
      problem: 'Review the append step budget.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ id: 'first', kind: 'worker', name: 'First' }],
      },
      template: 'custom',
      title: 'Append step budget',
    });

    await expect(
      appendCoordinatorWorkflowExecutionSteps({
        appendId: 'append-over-step-budget',
        runId: run.id,
        sourceTaskId: 'task-coordinator',
        spawnLane,
        steps: [
          { dependsOn: ['first'], id: 'second', kind: 'worker', name: 'Second' },
          { dependsOn: ['first'], id: 'third', kind: 'worker', name: 'Third' },
        ],
        workflowId: started.workflow.id,
      }),
    ).rejects.toThrow('append_workflow_steps would exceed workflow step budget 2');

    const workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    expect(workflow?.sourceSpec?.steps.map((step) => step.id)).toEqual(['first']);
    expect(workflow?.stages.map((stage) => stage.id)).toEqual(['first']);
    expect(workflow?.stepAppends).toBeUndefined();
    expect(workflow?.journal.some((entry) => entry.kind === 'workflow-steps-appended')).toBe(false);
  });

  it('counts planned lanes of pending stages toward the append lane budget', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxTotalLanes: 4 },
      problem: 'Review committed lane counting.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          { id: 'first', kind: 'worker', name: 'First' },
          {
            dependsOn: ['first'],
            id: 'wide',
            kind: 'fanout',
            lanes: [
              { assignment: 'Lane A', id: 'lane-a', name: 'Lane A' },
              { assignment: 'Lane B', id: 'lane-b', name: 'Lane B' },
            ],
          },
        ],
      },
      template: 'custom',
      title: 'Committed lane budget',
    });

    await expect(
      appendCoordinatorWorkflowExecutionSteps({
        appendId: 'append-over-lane-budget',
        runId: run.id,
        sourceTaskId: 'task-coordinator',
        spawnLane,
        steps: [
          {
            dependsOn: ['first'],
            id: 'extra',
            kind: 'fanout',
            lanes: [
              { assignment: 'Lane C', id: 'lane-c', name: 'Lane C' },
              { assignment: 'Lane D', id: 'lane-d', name: 'Lane D' },
            ],
          },
        ],
        workflowId: started.workflow.id,
      }),
    ).rejects.toThrow('append_workflow_steps would exceed workflow lane limit 4');

    const workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    expect(workflow?.stages.map((stage) => stage.id)).toEqual(['first', 'wide']);
    expect(workflow?.stepAppends).toBeUndefined();
  });

  it('rejects decision workflowActions above the total-step budget before any result state changes', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxTotalSteps: 2 },
      problem: 'Review decision step budgets.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          { id: 'scout', kind: 'worker', name: 'Scout' },
          {
            dependsOn: ['scout'],
            id: 'decide',
            kind: 'decision',
            name: 'Decide',
          },
        ],
      },
      template: 'custom',
      title: 'Decision step budget',
    });
    let workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    const scoutLaneId = workflow?.lanes.find((lane) => lane.stageId === 'scout')?.id;
    if (!workflow || !scoutLaneId) {
      throw new Error('Expected scout lane');
    }
    completeWorkflowLane(workflow, scoutLaneId);
    await advanceCoordinatorWorkflowExecution({
      laneId: scoutLaneId,
      runId: run.id,
      spawnLane,
      workflowId: started.workflow.id,
    });
    workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    const decisionLane = workflow?.lanes.find((lane) => lane.stageId === 'decide');
    if (!workflow || !decisionLane) {
      throw new Error('Expected decision lane');
    }

    const actions = normalizeCoordinatorWorkflowDynamicActions(
      [
        {
          id: 'followup',
          kind: 'append_worker',
          name: 'Followup',
        },
      ],
      {
        limits: {
          assignmentTextMaxChars: COORDINATOR_LIMITS.assignmentTextMaxChars,
          maxWorkflowBranchIterations: COORDINATOR_LIMITS.maxWorkflowBranchIterations,
          maxWorkflowLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
          maxWorkflowMetadataBytes: COORDINATOR_LIMITS.maxWorkflowMetadataBytes,
          maxWorkflowShortTextChars: COORDINATOR_LIMITS.maxWorkflowShortTextChars,
          workflowMaxLaneTimeoutMs: COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs,
        },
      },
    );

    expect(() =>
      validateWorkflowDecisionActionsForResult(workflow, decisionLane, 'decision-result', actions),
    ).toThrow('workflowActions would exceed workflow step budget 2');
    expect(getCoordinatorWorkflow(run.id, started.workflow.id)?.expansions).toBeUndefined();
  });

  it('stops retry admission at the workflow retry budget and journals the suppression once', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxTotalRetries: 1, retryBackoffMs: 0, retryCount: 2, timeoutMs: 5 },
      problem: 'Review the retry budget.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ assignment: 'Run a slow lane.', id: 'worker', kind: 'worker' }],
      },
      template: 'custom',
      title: 'Retry budget',
    });
    const workflowId = started.workflow.id;

    await tickCoordinatorWorkflowExecution({ now: 2_000, runId: run.id, spawnLane, workflowId });
    let workflow = getCoordinatorWorkflow(run.id, workflowId);
    expect(workflow?.lanes).toEqual([
      expect.objectContaining({ attempt: 1, status: 'timed-out' }),
      expect.objectContaining({ attempt: 2, status: 'waiting-for-result' }),
    ]);

    await tickCoordinatorWorkflowExecution({ now: 3_000, runId: run.id, spawnLane, workflowId });
    await tickCoordinatorWorkflowExecution({ now: 4_000, runId: run.id, spawnLane, workflowId });

    workflow = getCoordinatorWorkflow(run.id, workflowId);
    expect(workflow?.lanes).toHaveLength(2);
    expect(workflow?.lanes[1]).toMatchObject({ attempt: 2, status: 'timed-out' });
    expect(workflow?.stages).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(workflow?.status).toBe('failed');
    expect(
      workflow?.journal.filter((entry) => entry.kind === 'workflow-budget-exhausted'),
    ).toHaveLength(1);
    expect(workflow?.execution?.pendingRetryLaneIds).toEqual([]);
  });

  it('trips the wall-clock budget at the tick head and blocks the workflow with a typed reason', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxWallClockMs: 60_000, timeoutMs: 600_000 },
      problem: 'Review the wall-clock budget.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          { id: 'first', kind: 'worker', name: 'First' },
          { dependsOn: ['first'], id: 'second', kind: 'worker', name: 'Second' },
        ],
      },
      template: 'custom',
      title: 'Wall-clock budget',
    });
    const workflowId = started.workflow.id;
    const deadlineAt = getCoordinatorWorkflow(run.id, workflowId)?.execution?.deadlineAt;
    if (deadlineAt === undefined) {
      throw new Error('Expected a seeded execution deadline');
    }

    await tickCoordinatorWorkflowExecution({
      now: deadlineAt + 1,
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const workflow = getCoordinatorWorkflow(run.id, workflowId);
    expect(workflow).toMatchObject({
      execution: expect.objectContaining({
        blockedReason: 'budget-exhausted: wall-clock (60000/60000)',
        budget: expect.objectContaining({ exhausted: 'wall-clock' }),
      }),
      status: 'blocked',
    });
    expect(workflow?.lanes).toEqual([
      expect.objectContaining({
        failure: 'budget-exhausted: wall-clock (60000/60000)',
        status: 'cancelled',
      }),
    ]);
    expect(workflow?.stages).toEqual([
      expect.objectContaining({ id: 'first' }),
      expect.objectContaining({ id: 'second', status: 'skipped' }),
    ]);
    expect(
      workflow?.journal.filter((entry) => entry.kind === 'workflow-budget-exhausted'),
    ).toHaveLength(1);

    await expect(
      appendCoordinatorWorkflowExecutionSteps({
        appendId: 'append-after-trip',
        runId: run.id,
        sourceTaskId: 'task-coordinator',
        spawnLane,
        steps: [{ dependsOn: ['first'], id: 'third', kind: 'worker', name: 'Third' }],
        workflowId,
      }),
    ).rejects.toThrow('Coordinator workflow is blocked');
  });

  it('replays an existing appendId idempotently after a wall-clock trip', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxWallClockMs: 60_000, timeoutMs: 600_000 },
      problem: 'Review append replay after a trip.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ id: 'first', kind: 'worker', name: 'First' }],
      },
      template: 'custom',
      title: 'Append replay after trip',
    });
    const workflowId = started.workflow.id;
    const appendSteps = [{ dependsOn: ['first'], id: 'second', kind: 'worker', name: 'Second' }];
    const firstAppend = await appendCoordinatorWorkflowExecutionSteps({
      appendId: 'append-before-trip',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      spawnLane,
      steps: appendSteps,
      workflowId,
    });
    const deadlineAt = getCoordinatorWorkflow(run.id, workflowId)?.execution?.deadlineAt;
    if (deadlineAt === undefined) {
      throw new Error('Expected a seeded execution deadline');
    }
    await tickCoordinatorWorkflowExecution({
      now: deadlineAt + 1,
      runId: run.id,
      spawnLane,
      workflowId,
    });
    expect(getCoordinatorWorkflow(run.id, workflowId)?.status).toBe('blocked');

    const replayed = await appendCoordinatorWorkflowExecutionSteps({
      appendId: 'append-before-trip',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      spawnLane,
      steps: appendSteps,
      workflowId,
    });
    expect(replayed.append).toEqual(firstAppend.append);
    expect(replayed.lanes).toHaveLength(0);
  });

  it('rejects a late append to a completed workflow without tripping it to blocked', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxWallClockMs: 60_000, timeoutMs: 600_000 },
      problem: 'Review late appends after completion.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ id: 'first', kind: 'worker', name: 'First' }],
      },
      template: 'custom',
      title: 'Late append after completion',
    });
    const workflowId = started.workflow.id;
    const initialWorkflow = getCoordinatorWorkflow(run.id, workflowId);
    if (!initialWorkflow?.lanes[0]) {
      throw new Error('Expected initial workflow lane');
    }
    completeWorkflowLane(initialWorkflow, initialWorkflow.lanes[0].id);
    const completed = await advanceCoordinatorWorkflowExecution({
      laneId: initialWorkflow.lanes[0].id,
      runId: run.id,
      spawnLane,
      workflowId,
    });
    expect(completed.status).toBe('completed');
    const completedWorkflow = getCoordinatorWorkflow(run.id, workflowId);
    if (completedWorkflow?.execution === undefined) {
      throw new Error('Expected completed workflow execution state');
    }
    updateCoordinatorWorkflow(run.id, workflowId, {
      execution: { ...completedWorkflow.execution, deadlineAt: 1 },
    });

    await expect(
      appendCoordinatorWorkflowExecutionSteps({
        appendId: 'append-after-completion-deadline',
        runId: run.id,
        sourceTaskId: 'task-coordinator',
        spawnLane,
        steps: [{ dependsOn: ['first'], id: 'second', kind: 'worker', name: 'Second' }],
        workflowId,
      }),
    ).rejects.toThrow('budget-exhausted: wall-clock (60000/60000)');

    const workflow = getCoordinatorWorkflow(run.id, workflowId);
    expect(workflow?.status).toBe('completed');
    expect(workflow?.completedAt).toBe(completedWorkflow.completedAt);
    expect(workflow?.execution?.blockedReason).toBeUndefined();
    expect(workflow?.lanes).toEqual([
      expect.objectContaining({ name: 'First', status: 'completed' }),
    ]);
    expect(workflow?.journal.some((entry) => entry.kind === 'workflow-budget-exhausted')).toBe(
      false,
    );
  });

  it('keeps a tripped workflow stable across later ticks without duplicate budget journal entries', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxWallClockMs: 60_000, timeoutMs: 600_000 },
      problem: 'Review trip idempotence.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          { id: 'first', kind: 'worker', name: 'First' },
          { dependsOn: ['first'], id: 'second', kind: 'worker', name: 'Second' },
        ],
      },
      template: 'custom',
      title: 'Trip idempotence',
    });
    const workflowId = started.workflow.id;
    const deadlineAt = getCoordinatorWorkflow(run.id, workflowId)?.execution?.deadlineAt;
    if (deadlineAt === undefined) {
      throw new Error('Expected a seeded execution deadline');
    }

    await tickCoordinatorWorkflowExecution({
      now: deadlineAt + 1,
      runId: run.id,
      spawnLane,
      workflowId,
    });
    const tripped = getCoordinatorWorkflow(run.id, workflowId);
    expect(tripped?.status).toBe('blocked');
    const trippedCompletedAt = tripped?.completedAt;

    await tickCoordinatorWorkflowExecution({
      now: deadlineAt + 2,
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const workflow = getCoordinatorWorkflow(run.id, workflowId);
    if (!workflow) {
      throw new Error('Expected workflow');
    }
    expect(workflow.status).toBe('blocked');
    expect(workflow.completedAt).toBe(trippedCompletedAt);
    expect(workflow.execution?.blockedReason).toBe('budget-exhausted: wall-clock (60000/60000)');
    expect(
      workflow.journal.filter((entry) => entry.kind === 'workflow-budget-exhausted'),
    ).toHaveLength(1);
    expect(getCoordinatorWorkflowNextTickAt(workflow, deadlineAt + 2)).toBeNull();
  });

  it('admits specs and appends that land exactly on the step budget', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxTotalSteps: 2 },
      problem: 'Review exact step budgets.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ id: 'first', kind: 'worker', name: 'First' }],
      },
      template: 'custom',
      title: 'Exact step budget',
    });
    const workflowId = started.workflow.id;

    const appended = await appendCoordinatorWorkflowExecutionSteps({
      appendId: 'append-exactly-at-step-budget',
      runId: run.id,
      sourceTaskId: 'task-coordinator',
      spawnLane,
      steps: [{ dependsOn: ['first'], id: 'second', kind: 'worker', name: 'Second' }],
      workflowId,
    });
    expect(appended.workflow.sourceSpec?.steps.map((step) => step.id)).toEqual(['first', 'second']);

    const exactStart = await startCoordinatorWorkflowExecution({
      policy: { maxTotalSteps: 2 },
      problem: 'Review exact step budgets at start.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          { id: 'first', kind: 'worker', name: 'First' },
          { dependsOn: ['first'], id: 'second', kind: 'worker', name: 'Second' },
        ],
      },
      template: 'custom',
      title: 'Exact step budget at start',
    });
    expect(exactStart.workflow.stages.map((stage) => stage.id)).toEqual(['first', 'second']);
  });

  it('does not trip before the deadline and trips exactly at the deadline', async () => {
    const run = createRun();
    let laneIndex = 0;
    const spawnLane: SpawnCoordinatorWorkflowLane = async (workflow, stageId, lanePayload) => {
      laneIndex += 1;
      const lane = addCoordinatorWorkflowLane({
        agentId: `agent-${laneIndex}`,
        assignment: lanePayload.assignment,
        ...(lanePayload.dedupeKey !== undefined ? { dedupeKey: lanePayload.dedupeKey } : {}),
        name: lanePayload.name,
        runId: workflow.runId,
        stageId,
        status: 'waiting-for-result',
        taskId: `task-${laneIndex}`,
        workflowId: workflow.id,
      });
      updateCoordinatorWorkflowStage(workflow.runId, workflow.id, stageId, {
        status: 'waiting-for-results',
      });
      return { laneId: lane.id };
    };
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxWallClockMs: 60_000 },
      problem: 'Review the exact deadline boundary.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ id: 'worker', kind: 'worker', name: 'Worker' }],
      },
      template: 'custom',
      title: 'Exact deadline boundary',
    });
    const workflowId = started.workflow.id;
    const deadlineAt = getCoordinatorWorkflow(run.id, workflowId)?.execution?.deadlineAt;
    if (deadlineAt === undefined) {
      throw new Error('Expected a seeded execution deadline');
    }

    const beforeDeadline = await tickCoordinatorWorkflowExecution({
      now: deadlineAt - 1,
      runId: run.id,
      spawnLane,
      workflowId,
    });
    expect(beforeDeadline.status).toBe('running');
    expect(beforeDeadline.journal.some((entry) => entry.kind === 'workflow-budget-exhausted')).toBe(
      false,
    );

    const atDeadline = await tickCoordinatorWorkflowExecution({
      now: deadlineAt,
      runId: run.id,
      spawnLane,
      workflowId,
    });
    expect(atDeadline.status).toBe('blocked');
    expect(atDeadline.execution?.blockedReason).toBe('budget-exhausted: wall-clock (60000/60000)');
  });

  it('suppresses the first retry when maxTotalRetries is zero and journals the exhaustion once', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxTotalRetries: 0, retryBackoffMs: 0, retryCount: 2, timeoutMs: 5 },
      problem: 'Review a zero retry budget.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ assignment: 'Run a slow lane.', id: 'worker', kind: 'worker' }],
      },
      template: 'custom',
      title: 'Zero retry budget',
    });
    const workflowId = started.workflow.id;

    await tickCoordinatorWorkflowExecution({ now: 2_000, runId: run.id, spawnLane, workflowId });

    const workflow = getCoordinatorWorkflow(run.id, workflowId);
    expect(workflow?.lanes).toEqual([expect.objectContaining({ attempt: 1, status: 'timed-out' })]);
    expect(workflow?.stages).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(workflow?.status).toBe('failed');
    expect(
      workflow?.journal.filter((entry) => entry.kind === 'workflow-budget-exhausted'),
    ).toHaveLength(1);
    expect(workflow?.execution?.pendingRetryLaneIds).toEqual([]);
  });

  it('wakes the scheduler at the execution deadline when no lane timeout or retry is pending', async () => {
    const run = createRun();
    let laneIndex = 0;
    const spawnLane: SpawnCoordinatorWorkflowLane = async (workflow, stageId, lanePayload) => {
      laneIndex += 1;
      const lane = addCoordinatorWorkflowLane({
        agentId: `agent-${laneIndex}`,
        assignment: lanePayload.assignment,
        ...(lanePayload.dedupeKey !== undefined ? { dedupeKey: lanePayload.dedupeKey } : {}),
        name: lanePayload.name,
        runId: workflow.runId,
        stageId,
        status: 'waiting-for-result',
        taskId: `task-${laneIndex}`,
        workflowId: workflow.id,
      });
      updateCoordinatorWorkflowStage(workflow.runId, workflow.id, stageId, {
        status: 'waiting-for-results',
      });
      return { laneId: lane.id };
    };
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxWallClockMs: 60_000 },
      problem: 'Review deadline wake-ups.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ id: 'worker', kind: 'worker', name: 'Worker' }],
      },
      template: 'custom',
      title: 'Deadline wake-up',
    });

    const workflow = getCoordinatorWorkflow(run.id, started.workflow.id);
    if (!workflow) {
      throw new Error('Expected workflow');
    }
    expect(workflow.lanes.every((lane) => lane.timeoutAt === undefined)).toBe(true);
    expect(getCoordinatorWorkflowNextTickAt(workflow, 2_000)).toBe(workflow.execution?.deadlineAt);
  });

  it('extends the execution deadline by the stale gap on resume instead of tripping instantly', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxWallClockMs: 60_000, retryCount: 0, timeoutMs: 600_000 },
      problem: 'Review wall-clock budgets across resume.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ assignment: 'Run the worker lane.', id: 'worker', kind: 'worker' }],
      },
      template: 'custom',
      title: 'Resume past deadline',
    });
    const workflowId = started.workflow.id;

    restartCoordinatorRuntime();
    const stale = getCoordinatorWorkflow(run.id, workflowId);
    const staleDeadlineAt = stale?.execution?.deadlineAt;
    if (!stale || staleDeadlineAt === undefined) {
      throw new Error('Expected stale workflow with a deadline');
    }
    const resumeNow = staleDeadlineAt + 100_000;

    const resumed = await resumeCoordinatorWorkflowExecution({
      now: resumeNow,
      respawnLane: createRecordingRespawnLane([]),
      runId: run.id,
      spawnLane,
      workflowId,
    });
    expect(resumed.workflow.status).toBe('running');
    const expectedDeadlineAt = staleDeadlineAt + (resumeNow - stale.updatedAt);
    expect(resumed.workflow.execution?.deadlineAt).toBe(expectedDeadlineAt);
    expect(resumed.workflow.execution?.budget?.exhausted).toBeUndefined();

    const ticked = await tickCoordinatorWorkflowExecution({
      now: resumeNow + 1,
      runId: run.id,
      spawnLane,
      workflowId,
    });
    expect(ticked.status).toBe('running');

    const tripped = await tickCoordinatorWorkflowExecution({
      now: expectedDeadlineAt + 1,
      runId: run.id,
      spawnLane,
      workflowId,
    });
    expect(tripped.status).toBe('blocked');
    expect(tripped.execution?.blockedReason).toBe('budget-exhausted: wall-clock (60000/60000)');
  });

  it('trips the lane budget backstop to blocked instead of failed when a ready stage cannot spawn', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Review the lane budget backstop.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          { id: 'first', kind: 'worker', name: 'First' },
          { dependsOn: ['first'], id: 'second', kind: 'worker', name: 'Second' },
        ],
      },
      template: 'custom',
      title: 'Lane budget backstop',
    });
    const workflowId = started.workflow.id;
    for (let padIndex = 1; padIndex < COORDINATOR_LIMITS.maxWorkflowLanes; padIndex += 1) {
      addCoordinatorWorkflowLane({
        agentId: `agent-pad-${padIndex}`,
        assignment: 'Pad the workflow lane count.',
        name: `Pad lane ${padIndex}`,
        runId: run.id,
        stageId: 'first',
        status: 'completed',
        taskId: `task-pad-${padIndex}`,
        workflowId,
      });
    }
    const workflow = getCoordinatorWorkflow(run.id, workflowId);
    const firstLaneId = workflow?.lanes.find((lane) => lane.stageId === 'first')?.id;
    if (!workflow || !firstLaneId) {
      throw new Error('Expected first stage lane');
    }
    completeWorkflowLane(workflow, firstLaneId);

    await advanceCoordinatorWorkflowExecution({
      laneId: firstLaneId,
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const tripped = getCoordinatorWorkflow(run.id, workflowId);
    expect(tripped).toMatchObject({
      execution: expect.objectContaining({
        blockedReason: `budget-exhausted: lanes (13/${COORDINATOR_LIMITS.maxWorkflowLanes})`,
        budget: expect.objectContaining({ exhausted: 'lanes' }),
      }),
      status: 'blocked',
    });
    expect(tripped?.stages).toEqual([
      expect.objectContaining({ id: 'first', status: 'completed' }),
      expect.objectContaining({ id: 'second', status: 'skipped' }),
    ]);
    expect(
      tripped?.journal.filter((entry) => entry.kind === 'workflow-budget-exhausted'),
    ).toHaveLength(1);
  });

  it('holds a gated decision result without a lane result so dependents stay blocked', async () => {
    const held = await createHeldDecisionApproval();

    await tickCoordinatorWorkflowExecution({
      now: Date.now() + 1_000_000,
      runId: held.runId,
      spawnLane: held.spawnLane,
      workflowId: held.workflowId,
    });

    const workflow = getCoordinatorWorkflow(held.runId, held.workflowId);
    const decisionLane = workflow?.lanes.find((lane) => lane.id === held.decisionLaneId);
    expect(decisionLane).toMatchObject({ status: 'waiting-for-result' });
    expect(decisionLane?.resultId).toBeUndefined();
    expect(decisionLane?.timeoutAt).toBeUndefined();
    expect(workflow?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'decide', status: 'waiting-for-results' }),
        expect.objectContaining({ id: 'report', status: 'pending' }),
      ]),
    );
    expect(workflow?.lanes.filter((lane) => lane.stageId === 'report')).toHaveLength(0);
    expect(workflow?.pendingApprovals).toEqual([
      expect.objectContaining({ id: held.approvalId, status: 'pending' }),
    ]);
    expect(workflow?.journal.some((entry) => entry.kind === 'decision-approval-requested')).toBe(
      true,
    );
  });

  it('applies approved workflow actions through the validated append path idempotently', async () => {
    const held = await createHeldDecisionApproval();

    const approved = await approveCoordinatorWorkflowActions({
      approvalId: held.approvalId,
      runId: held.runId,
      spawnLane: held.spawnLane,
      workflowId: held.workflowId,
    });
    expect(approved.approval.status).toBe('approved');

    const workflow = getCoordinatorWorkflow(held.runId, held.workflowId);
    expect(workflow?.lanes.find((lane) => lane.id === held.decisionLaneId)).toMatchObject({
      resultId: held.resultId,
      status: 'completed',
    });
    expect(workflow?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'decide', status: 'completed' }),
        expect.objectContaining({ id: 'followup', status: 'waiting-for-results' }),
      ]),
    );
    expect(workflow?.stepAppends).toEqual([
      expect.objectContaining({ sourceLaneId: held.decisionLaneId, stepIds: ['followup'] }),
    ]);
    expect(workflow?.expansions).toEqual([
      expect.objectContaining({ sourceResultId: held.resultId }),
    ]);
    expect(workflow?.journal.some((entry) => entry.kind === 'decision-approval-approved')).toBe(
      true,
    );

    const replay = await approveCoordinatorWorkflowActions({
      approvalId: held.approvalId,
      runId: held.runId,
      spawnLane: held.spawnLane,
      workflowId: held.workflowId,
    });
    expect(replay.approval.status).toBe('approved');
    expect(replay.workflow.stepAppends).toHaveLength(1);
  });

  it('re-validates approvals at apply time and leaves them pending on rejection', async () => {
    const held = await createHeldDecisionApproval({ maxTotalLanes: 4 });

    await appendCoordinatorWorkflowExecutionSteps({
      appendId: 'append-pad',
      runId: held.runId,
      sourceTaskId: 'task-coordinator',
      spawnLane: held.spawnLane,
      steps: [{ id: 'pad', kind: 'worker', name: 'Pad' }],
      workflowId: held.workflowId,
    });

    await expect(
      approveCoordinatorWorkflowActions({
        approvalId: held.approvalId,
        runId: held.runId,
        spawnLane: held.spawnLane,
        workflowId: held.workflowId,
      }),
    ).rejects.toThrow('workflowActions would exceed workflow lane limit 4');

    const workflow = getCoordinatorWorkflow(held.runId, held.workflowId);
    expect(workflow?.pendingApprovals).toEqual([
      expect.objectContaining({ id: held.approvalId, status: 'pending' }),
    ]);
    expect(workflow?.lanes.find((lane) => lane.id === held.decisionLaneId)?.resultId).toBe(
      undefined,
    );
  });

  it('re-validates the append budget at approve time and leaves exhausted approvals pending', async () => {
    const held = await createHeldDecisionApproval();
    const pending = getCoordinatorWorkflow(held.runId, held.workflowId);
    if (!pending) {
      throw new Error('Expected held workflow');
    }
    updateCoordinatorWorkflow(held.runId, held.workflowId, {
      appendPolicy: { ...pending.appendPolicy, maxStepAppends: 1 },
    });
    await appendCoordinatorWorkflowExecutionSteps({
      appendId: 'append-pad',
      runId: held.runId,
      sourceTaskId: 'task-coordinator',
      spawnLane: held.spawnLane,
      steps: [{ id: 'pad', kind: 'worker', name: 'Pad' }],
      workflowId: held.workflowId,
    });

    await expect(
      approveCoordinatorWorkflowActions({
        approvalId: held.approvalId,
        runId: held.runId,
        spawnLane: held.spawnLane,
        workflowId: held.workflowId,
      }),
    ).rejects.toThrow('workflowActions would exceed append limit 1');

    const workflow = getCoordinatorWorkflow(held.runId, held.workflowId);
    expect(workflow?.pendingApprovals).toEqual([
      expect.objectContaining({ id: held.approvalId, status: 'pending' }),
    ]);
    const decisionLane = workflow?.lanes.find((lane) => lane.id === held.decisionLaneId);
    expect(decisionLane).toMatchObject({ status: 'waiting-for-result' });
    expect(decisionLane?.resultId).toBeUndefined();
    expect(workflow?.stepAppends).toHaveLength(1);
    expect(workflow?.journal.some((entry) => entry.kind === 'decision-approval-approved')).toBe(
      false,
    );
  });

  it('cancels pending approvals when the workflow execution is cancelled', async () => {
    const held = await createHeldDecisionApproval();

    const cancelled = cancelCoordinatorWorkflowExecution(
      held.runId,
      held.workflowId,
      'Coordinator subtask closed',
    );

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.pendingApprovals).toEqual([
      expect.objectContaining({
        id: held.approvalId,
        reason: 'Coordinator subtask closed',
        status: 'cancelled',
      }),
    ]);
    expect(cancelled.lanes.find((lane) => lane.id === held.decisionLaneId)?.status).toBe(
      'cancelled',
    );
    expect(cancelled.journal.some((entry) => entry.kind === 'decision-approval-cancelled')).toBe(
      true,
    );
  });

  it('denies a mark_blocked-gated result by closing the lane blocked so dependents stay gated', async () => {
    const held = await createHeldDecisionApproval({
      actions: [{ kind: 'mark_blocked', reason: 'Needs human follow-up.' }],
      resultStatus: 'blocked',
    });

    const denied = await denyCoordinatorWorkflowActions({
      approvalId: held.approvalId,
      reason: 'Discard the workflow-level block.',
      runId: held.runId,
      spawnLane: held.spawnLane,
      workflowId: held.workflowId,
    });
    expect(denied.approval.status).toBe('denied');

    const workflow = getCoordinatorWorkflow(held.runId, held.workflowId);
    expect(workflow?.lanes.find((lane) => lane.id === held.decisionLaneId)).toMatchObject({
      resultId: held.resultId,
      status: 'blocked',
    });
    expect(workflow?.lanes.filter((lane) => lane.stageId === 'report')).toHaveLength(0);
    expect(workflow?.expansions).toBeUndefined();
  });

  it('denies gated actions with a journaled reason and lets dependents proceed', async () => {
    const held = await createHeldDecisionApproval({
      actions: [{ kind: 'stop_workflow', reason: 'No more work needed.' }],
    });

    const denied = await denyCoordinatorWorkflowActions({
      approvalId: held.approvalId,
      reason: 'Keep the planned report stage.',
      runId: held.runId,
      spawnLane: held.spawnLane,
      workflowId: held.workflowId,
    });
    expect(denied.approval).toMatchObject({
      reason: 'Keep the planned report stage.',
      status: 'denied',
    });

    const workflow = getCoordinatorWorkflow(held.runId, held.workflowId);
    expect(workflow?.lanes.find((lane) => lane.id === held.decisionLaneId)).toMatchObject({
      resultId: held.resultId,
      status: 'completed',
    });
    expect(workflow?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'decide', status: 'completed' }),
        expect.objectContaining({ id: 'report', status: 'waiting-for-results' }),
      ]),
    );
    expect(workflow?.status).toBe('running');
    expect(workflow?.execution?.completionReason).toBeUndefined();
    expect(
      workflow?.journal.some(
        (entry) =>
          entry.kind === 'decision-approval-denied' &&
          entry.message.includes('Keep the planned report stage.'),
      ),
    ).toBe(true);
  });

  it('cancels pending approvals when the budget close-out trips the workflow', async () => {
    const held = await createHeldDecisionApproval();

    const tripped = tripCoordinatorWorkflowBudget(
      held.runId,
      held.workflowId,
      'wall-clock',
      { limit: 60_000, used: 60_000 },
      Date.now(),
    );

    expect(tripped.status).toBe('blocked');
    expect(tripped.pendingApprovals).toEqual([
      expect.objectContaining({
        id: held.approvalId,
        reason: 'budget-exhausted: wall-clock (60000/60000)',
        status: 'cancelled',
      }),
    ]);
    expect(tripped.lanes.find((lane) => lane.id === held.decisionLaneId)?.status).toBe('cancelled');
    expect(tripped.journal.some((entry) => entry.kind === 'decision-approval-cancelled')).toBe(
      true,
    );
  });

  it('re-records restore-cancelled approvals on resume instead of replaying cached facts', async () => {
    const held = await createHeldDecisionApproval();
    restartCoordinatorRuntime();

    const respawnedLaneIds: string[] = [];
    await resumeCoordinatorWorkflowExecution({
      respawnLane: createRecordingRespawnLane(respawnedLaneIds),
      runId: held.runId,
      spawnLane: held.spawnLane,
      workflowId: held.workflowId,
    });

    const workflow = getCoordinatorWorkflow(held.runId, held.workflowId);
    expect(respawnedLaneIds).not.toContain(held.decisionLaneId);
    const decisionLane = workflow?.lanes.find((lane) => lane.id === held.decisionLaneId);
    expect(decisionLane).toMatchObject({ status: 'waiting-for-result' });
    expect(decisionLane?.resultId).toBeUndefined();
    expect(decisionLane?.timeoutAt).toBeUndefined();
    expect(workflow?.pendingApprovals).toEqual([
      expect.objectContaining({ id: held.approvalId, status: 'cancelled' }),
      expect.objectContaining({ id: `${held.resultId}:approval:2`, status: 'pending' }),
    ]);
    expect(workflow?.stages.find((stage) => stage.id === 'decide')?.status).toBe(
      'waiting-for-results',
    );
    expect(workflow?.lanes.filter((lane) => lane.stageId === 'report')).toHaveLength(0);
    expect(
      workflow?.journal.filter((entry) => entry.kind === 'decision-approval-requested'),
    ).toHaveLength(2);
  });

  it('defers retries and ready stages while the run is paused and admits them after unpause', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { retryBackoffMs: 0, retryCount: 1, timeoutMs: 5 },
      problem: 'Review pause admission.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [{ id: 'worker', kind: 'worker', name: 'Worker' }],
      },
      template: 'custom',
      title: 'Pause admission',
    });
    const workflowId = started.workflow.id;
    setCoordinatorRunPaused(run.id, true, 1_500);

    await tickCoordinatorWorkflowExecution({
      now: 2_000,
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const paused = getCoordinatorWorkflow(run.id, workflowId);
    expect(paused?.lanes).toEqual([expect.objectContaining({ status: 'timed-out' })]);
    expect(paused?.status).toBe('running');
    const pausedNextTick = getCoordinatorWorkflowNextTickAt(paused ?? started.workflow, 2_100);
    expect(pausedNextTick).toBe(paused?.execution?.deadlineAt);

    setCoordinatorRunPaused(run.id, false, 2_200);
    await tickCoordinatorWorkflowExecution({
      now: 2_300,
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const unpaused = getCoordinatorWorkflow(run.id, workflowId);
    expect(unpaused?.lanes).toEqual([
      expect.objectContaining({ attempt: 1, status: 'timed-out' }),
      expect.objectContaining({ attempt: 2, status: 'waiting-for-result' }),
    ]);
  });

  it('keeps ready dependent stages unspawned while paused and reconciles them after unpause', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      problem: 'Review pause stage admission.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          { id: 'first', kind: 'worker', name: 'First' },
          { dependsOn: ['first'], id: 'second', kind: 'worker', name: 'Second' },
        ],
      },
      template: 'custom',
      title: 'Pause stage admission',
    });
    const workflowId = started.workflow.id;
    setCoordinatorRunPaused(run.id, true, 1_500);

    const workflow = getCoordinatorWorkflow(run.id, workflowId);
    const firstLaneId = workflow?.lanes.find((lane) => lane.stageId === 'first')?.id;
    if (!workflow || !firstLaneId) {
      throw new Error('Expected first stage lane');
    }
    completeWorkflowLane(workflow, firstLaneId);
    await advanceCoordinatorWorkflowExecution({
      laneId: firstLaneId,
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const paused = getCoordinatorWorkflow(run.id, workflowId);
    expect(paused?.stages).toEqual([
      expect.objectContaining({ id: 'first', status: 'completed' }),
      expect.objectContaining({ id: 'second', status: 'pending' }),
    ]);
    expect(paused?.lanes.filter((lane) => lane.stageId === 'second')).toHaveLength(0);

    setCoordinatorRunPaused(run.id, false, 2_000);
    await tickCoordinatorWorkflowExecution({
      now: 2_100,
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const unpaused = getCoordinatorWorkflow(run.id, workflowId);
    expect(unpaused?.lanes.filter((lane) => lane.stageId === 'second')).toHaveLength(1);
  });

  it('spawns operator lane retries outside the auto-retry budget with shared dedupe keys', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { retryCount: 0 },
      problem: 'Review manual retry.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            id: 'scan',
            kind: 'fanout',
            lanes: [
              { assignment: 'Scan the backend.', id: 'lane-a', name: 'Backend' },
              { assignment: 'Scan the frontend.', id: 'lane-b', name: 'Frontend' },
            ],
            name: 'Scan',
          },
        ],
      },
      template: 'custom',
      title: 'Manual retry',
    });
    const workflowId = started.workflow.id;
    const workflow = getCoordinatorWorkflow(run.id, workflowId);
    const failedLane = workflow?.lanes.find((lane) => lane.name === 'Backend');
    if (!workflow || !failedLane) {
      throw new Error('Expected backend lane');
    }
    updateCoordinatorWorkflowLane(run.id, workflowId, failedLane.id, {
      completedAt: Date.now(),
      failure: 'agent crashed',
      status: 'failed',
    });

    const retried = await retryCoordinatorWorkflowLaneFromOperator({
      laneId: failedLane.id,
      runId: run.id,
      spawnLane,
      workflowId,
    });

    const retriedLane = retried.workflow.lanes.find(
      (lane) => lane.dedupeKey === `${failedLane.dedupeKey ?? failedLane.id}:retry:2`,
    );
    expect(retriedLane).toMatchObject({
      attempt: 2,
      spawnedBy: 'operator',
      status: 'waiting-for-result',
    });
    expect(countCoordinatorWorkflowRetriesUsed(retried.workflow)).toBe(0);
    expect(retried.workflow.journal.some((entry) => entry.kind === 'lane-manual-retry')).toBe(true);

    await expect(
      retryCoordinatorWorkflowLaneFromOperator({
        laneId: failedLane.id,
        runId: run.id,
        spawnLane,
        workflowId,
      }),
    ).rejects.toThrow('Lane retry was already scheduled');
  });

  it('rejects operator retries over the effective lane budget and for ineligible lanes', async () => {
    const run = createRun();
    const spawnLane = createFakeSpawnLane();
    const started = await startCoordinatorWorkflowExecution({
      policy: { maxTotalLanes: 2, retryCount: 0 },
      problem: 'Review manual retry caps.',
      runId: run.id,
      spawnLane,
      spec: {
        steps: [
          {
            id: 'scan',
            kind: 'fanout',
            lanes: [
              { assignment: 'Scan the backend.', id: 'lane-a', name: 'Backend' },
              { assignment: 'Scan the frontend.', id: 'lane-b', name: 'Frontend' },
            ],
            name: 'Scan',
          },
        ],
      },
      template: 'custom',
      title: 'Manual retry caps',
    });
    const workflowId = started.workflow.id;
    const workflow = getCoordinatorWorkflow(run.id, workflowId);
    const failedLane = workflow?.lanes.find((lane) => lane.name === 'Backend');
    const activeLane = workflow?.lanes.find((lane) => lane.name === 'Frontend');
    if (!workflow || !failedLane || !activeLane) {
      throw new Error('Expected scan lanes');
    }
    updateCoordinatorWorkflowLane(run.id, workflowId, failedLane.id, {
      completedAt: Date.now(),
      failure: 'agent crashed',
      status: 'failed',
    });

    await expect(
      retryCoordinatorWorkflowLaneFromOperator({
        laneId: failedLane.id,
        runId: run.id,
        spawnLane,
        workflowId,
      }),
    ).rejects.toThrow('budget-exhausted: lanes (2/2)');
    await expect(
      retryCoordinatorWorkflowLaneFromOperator({
        laneId: activeLane.id,
        runId: run.id,
        spawnLane,
        workflowId,
      }),
    ).rejects.toThrow('retry_lane requires a failed or timed-out lane');

    updateCoordinatorWorkflow(run.id, workflowId, {
      completedAt: Date.now(),
      status: 'completed',
    });
    await expect(
      retryCoordinatorWorkflowLaneFromOperator({
        laneId: failedLane.id,
        runId: run.id,
        spawnLane,
        workflowId,
      }),
    ).rejects.toThrow('Coordinator workflow is completed');
  });
});
