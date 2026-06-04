import { beforeEach, describe, expect, it } from 'vitest';
import { resetStoreForTest } from '../test/store-test-helpers';
import type { CoordinatorRunSnapshot, CoordinatorSubtaskSnapshot } from '../domain/coordinator';
import {
  applyCoordinatorEvent,
  getCoordinatorRun,
  getCoordinatorRunForTask,
  replaceCoordinatorSnapshot,
} from './coordinator';

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
