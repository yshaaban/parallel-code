import { beforeEach, describe, expect, it } from 'vitest';

import { COORDINATOR_LIMITS } from '../../src/domain/coordinator.js';
import { normalizeCoordinatorWorkflowDynamicActions } from '../../src/domain/coordinator-workflow-spec.js';
import {
  addCoordinatorWorkflowResult,
  addCoordinatorWorkflowLane,
  appendCoordinatorWorkflowJournal,
  createCoordinatorRun,
  getCoordinatorWorkflow,
  resetCoordinatorRuntimeForTests,
  updateCoordinatorWorkflow,
  updateCoordinatorWorkflowLane,
  updateCoordinatorWorkflowStage,
} from './runtime.js';
import {
  advanceCoordinatorWorkflowExecution,
  appendCoordinatorWorkflowExecutionSteps,
  cancelCoordinatorWorkflowExecution,
  startCoordinatorWorkflowExecution,
  tickCoordinatorWorkflowExecution,
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
});
