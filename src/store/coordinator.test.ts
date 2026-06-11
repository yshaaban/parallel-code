import { beforeEach, describe, expect, it } from 'vitest';
import { resetStoreForTest } from '../test/store-test-helpers';
import type { CoordinatorRunSnapshot, CoordinatorSubtaskSnapshot } from '../domain/coordinator';
import {
  applyCoordinatorEvent,
  getCoordinatorRun,
  getCoordinatorRunForTask,
  replaceCoordinatorSnapshot,
} from './coordinator';
import { store } from './core';

function createRun(overrides: Partial<CoordinatorRunSnapshot> = {}): CoordinatorRunSnapshot {
  return {
    coordinatorTaskId: 'task-coordinator',
    createdAt: 1_000,
    eventVersion: 1,
    id: 'run-1',
    landing: [],
    limits: {
      maxActiveSubtasks: 5,
      maxPendingPromptsPerTarget: 3,
      maxQueuedSubtasks: 20,
    },
    projectId: 'project-1',
    projectMode: 'git',
    projectRoot: '/repo',
    promptQueue: [],
    status: 'running',
    subtasks: [],
    updatedAt: 1_000,
    workflows: [],
    ...overrides,
  };
}

function createSubtask(
  overrides: Partial<CoordinatorSubtaskSnapshot> = {},
): CoordinatorSubtaskSnapshot {
  return {
    agentId: 'agent-child',
    assignment: 'Do work',
    createdAt: 1_000,
    parentCoordinatorTaskId: 'task-coordinator',
    startup: {
      followupPromptMode: 'post-ready-prompt',
      initialAssignmentMode: 'spawn-seeded-interactive',
      initialAssignmentStatus: 'seeded-at-spawn',
      readinessPolicy: 'codex',
      seededAt: 1_000,
    },
    status: 'running',
    taskId: 'task-child',
    toolTokenId: 'token-child',
    updatedAt: 1_000,
    worktreePath: '/repo/task-child',
    ...overrides,
  };
}

describe('coordinator store projection', () => {
  beforeEach(() => {
    resetStoreForTest();
  });

  it('replaces bootstrap snapshots and applies live coordinator events', () => {
    const run = createRun();

    replaceCoordinatorSnapshot({
      generatedAt: 1_000,
      runs: [run],
      stateVersion: 1,
    });
    applyCoordinatorEvent({
      categorySeq: 2,
      createdAt: 1_100,
      entityKey: 'subtask:task-child',
      entityVersion: 2,
      eventType: 'subtask-upserted',
      payload: createSubtask(),
      runId: run.id,
    });

    expect(getCoordinatorRun(run.id)?.subtasks).toHaveLength(1);
    expect(getCoordinatorRunForTask('task-coordinator')?.id).toBe(run.id);
  });

  it('drops stale coordinator events and accepts equal-version replay idempotently', () => {
    const run = createRun();

    replaceCoordinatorSnapshot({
      generatedAt: 1_000,
      runs: [run],
      stateVersion: 5,
    });
    applyCoordinatorEvent({
      categorySeq: 4,
      createdAt: 1_100,
      entityKey: 'subtask:task-stale',
      entityVersion: 4,
      eventType: 'subtask-upserted',
      payload: createSubtask({ taskId: 'task-stale' }),
      runId: run.id,
    });
    applyCoordinatorEvent({
      categorySeq: 5,
      createdAt: 1_200,
      entityKey: 'subtask:task-child',
      entityVersion: 5,
      eventType: 'subtask-upserted',
      payload: createSubtask(),
      runId: run.id,
    });
    applyCoordinatorEvent({
      categorySeq: 6,
      createdAt: 1_300,
      entityKey: 'run:run-1',
      entityVersion: 6,
      eventType: 'run-removed',
      payload: null,
      runId: run.id,
      tombstone: true,
    });

    expect(getCoordinatorRun(run.id)).toBeNull();
  });
});

describe('coordinator store granular event appliers', () => {
  beforeEach(() => {
    resetStoreForTest();
  });

  function getRunMeta(
    run: CoordinatorRunSnapshot,
  ): Omit<CoordinatorRunSnapshot, 'landing' | 'promptQueue' | 'subtasks' | 'workflows'> {
    const { landing, promptQueue, subtasks, workflows, ...meta } = run;
    void landing;
    void promptQueue;
    void subtasks;
    void workflows;
    return meta;
  }

  it('merges run-meta-upserted scalars while preserving entity collections', () => {
    const run = createRun({ subtasks: [createSubtask()] });
    replaceCoordinatorSnapshot({ generatedAt: 1_000, runs: [run], stateVersion: 1 });

    applyCoordinatorEvent({
      categorySeq: 2,
      createdAt: 2_000,
      entityKey: 'run:run-1',
      entityVersion: 2,
      eventType: 'run-meta-upserted',
      payload: {
        ...getRunMeta(run),
        eventVersion: 2,
        pausedAt: 2_000,
        status: 'paused-by-user',
        updatedAt: 2_000,
      },
      runId: run.id,
    });

    const stored = getCoordinatorRun(run.id);
    expect(stored).toMatchObject({
      eventVersion: 2,
      pausedAt: 2_000,
      status: 'paused-by-user',
      updatedAt: 2_000,
    });
    expect(stored?.subtasks).toHaveLength(1);

    // Clearing the optional scalar must not leave the stale pausedAt behind.
    applyCoordinatorEvent({
      categorySeq: 3,
      createdAt: 3_000,
      entityKey: 'run:run-1',
      entityVersion: 3,
      eventType: 'run-meta-upserted',
      payload: { ...getRunMeta(run), eventVersion: 3, status: 'running', updatedAt: 3_000 },
      runId: run.id,
    });
    expect(getCoordinatorRun(run.id)?.pausedAt).toBeUndefined();
    expect(getCoordinatorRun(run.id)?.subtasks).toHaveLength(1);
  });

  it('seeds a missing run from run-meta with empty collections without marking the category current', () => {
    const run = createRun();
    applyCoordinatorEvent({
      categorySeq: 4,
      createdAt: 1_000,
      entityKey: 'run:run-1',
      entityVersion: 4,
      eventType: 'run-meta-upserted',
      payload: getRunMeta(run),
      runId: run.id,
    });

    expect(getCoordinatorRun(run.id)).toMatchObject({
      id: run.id,
      landing: [],
      promptQueue: [],
      status: 'running',
      subtasks: [],
      workflows: [],
    });
    // The seeded run is a degraded repair (collections unknown), so the
    // presented coordinator version stays stale and the next resync handshake
    // resends the full coordinator bootstrap.
    expect(store.coordinator.stateVersion).toBe(0);
  });

  it('does not adopt the category version from orphan sub-entity deltas', () => {
    const run = createRun();
    replaceCoordinatorSnapshot({ generatedAt: 1_000, runs: [run], stateVersion: 2 });

    // Compacted replay can deliver a delta for a run whose creation event was
    // superseded in the ring; skipping it must not present its categorySeq as
    // current, or a drop before the repairing bootstrap would freeze the
    // incomplete state as current truth.
    applyCoordinatorEvent({
      categorySeq: 7,
      createdAt: 1_100,
      entityKey: 'subtask:task-orphan',
      entityVersion: 7,
      eventType: 'subtask-upserted',
      payload: createSubtask({ taskId: 'task-orphan' }),
      runId: 'run-unknown',
    });

    expect(getCoordinatorRun('run-unknown')).toBeNull();
    expect(store.coordinator.stateVersion).toBe(2);

    // A fully applied event still adopts its categorySeq.
    applyCoordinatorEvent({
      categorySeq: 8,
      createdAt: 1_200,
      entityKey: 'subtask:task-child',
      entityVersion: 8,
      eventType: 'subtask-upserted',
      payload: createSubtask(),
      runId: run.id,
    });
    expect(store.coordinator.stateVersion).toBe(8);
    expect(getCoordinatorRun(run.id)?.subtasks).toHaveLength(1);
  });

  it('upserts workflow-upserted payloads into the run workflows', () => {
    const run = createRun();
    replaceCoordinatorSnapshot({ generatedAt: 1_000, runs: [run], stateVersion: 1 });

    const workflow = {
      appendPolicy: { maxActionsPerDecision: 8, maxStepAppends: 24 },
      createdAt: 1_100,
      eventVersion: 2,
      id: 'workflow-1',
      journal: [],
      lanes: [],
      policy: {
        continueOnFailure: true,
        maxConcurrentLanes: 5,
        maxIterationsPerBranch: 3,
        maxOutputBytesPerLane: 1_024,
        resultRequired: true,
        retryBackoffMs: 1_000,
        retryCount: 0,
        timeoutMs: 60_000,
      },
      programVersion: 2,
      results: [],
      runId: run.id,
      stages: [],
      status: 'running' as const,
      template: 'custom' as const,
      title: 'Scan',
      updatedAt: 1_100,
    };
    applyCoordinatorEvent({
      categorySeq: 2,
      createdAt: 1_100,
      entityKey: 'workflow:workflow-1',
      entityVersion: 2,
      eventType: 'workflow-upserted',
      payload: workflow,
      runId: run.id,
    });
    applyCoordinatorEvent({
      categorySeq: 3,
      createdAt: 1_200,
      entityKey: 'workflow:workflow-1',
      entityVersion: 3,
      eventType: 'workflow-upserted',
      payload: { ...workflow, eventVersion: 3, status: 'completed' as const, updatedAt: 1_200 },
      runId: run.id,
    });

    const stored = getCoordinatorRun(run.id);
    expect(stored?.workflows).toHaveLength(1);
    expect(stored?.workflows[0]).toMatchObject({ id: 'workflow-1', status: 'completed' });
  });

  it('projects the run header from granular event envelopes', () => {
    const run = createRun();
    replaceCoordinatorSnapshot({ generatedAt: 1_000, runs: [run], stateVersion: 1 });

    applyCoordinatorEvent({
      categorySeq: 7,
      createdAt: 9_000,
      entityKey: 'subtask:task-child',
      entityVersion: 7,
      eventType: 'subtask-upserted',
      payload: createSubtask(),
      runId: run.id,
    });

    const stored = getCoordinatorRun(run.id);
    expect(stored?.updatedAt).toBe(9_000);
    expect(stored?.eventVersion).toBe(7);
  });

  it('lands the same canonical run shape through bootstrap snapshot and granular events', () => {
    const subtask = createSubtask();
    const run = createRun({ eventVersion: 3, subtasks: [subtask], updatedAt: 2_000 });

    replaceCoordinatorSnapshot({ generatedAt: 2_000, runs: [run], stateVersion: 3 });
    const fromSnapshot = getCoordinatorRun(run.id);

    resetStoreForTest();
    applyCoordinatorEvent({
      categorySeq: 2,
      createdAt: 1_000,
      entityKey: 'run:run-1',
      entityVersion: 2,
      eventType: 'run-meta-upserted',
      payload: { ...getRunMeta(run), eventVersion: 2, updatedAt: 1_000 },
      runId: run.id,
    });
    applyCoordinatorEvent({
      categorySeq: 3,
      createdAt: 2_000,
      entityKey: 'subtask:task-child',
      entityVersion: 3,
      eventType: 'subtask-upserted',
      payload: subtask,
      runId: run.id,
    });
    const fromEvents = getCoordinatorRun(run.id);

    expect(fromEvents).toEqual(fromSnapshot);
  });
});
