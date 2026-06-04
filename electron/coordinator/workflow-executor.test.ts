import { beforeEach, describe, expect, it } from 'vitest';

import { COORDINATOR_LIMITS } from '../../src/domain/coordinator.js';
import {
  addCoordinatorWorkflowLane,
  appendCoordinatorWorkflowJournal,
  createCoordinatorRun,
  getCoordinatorWorkflow,
  resetCoordinatorRuntimeForTests,
  updateCoordinatorWorkflowStage,
} from './runtime.js';
import {
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
