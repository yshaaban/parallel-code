import { describe, expect, it } from 'vitest';
import {
  isCoordinatorBootstrapSnapshot,
  isCoordinatorEventEnvelope,
  type CoordinatorRunSnapshot,
} from './coordinator';

function createCoordinatorRunSnapshot(): CoordinatorRunSnapshot {
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
  };
}

describe('coordinator domain guards', () => {
  it('accepts a valid coordinator bootstrap snapshot', () => {
    expect(
      isCoordinatorBootstrapSnapshot({
        generatedAt: 2_000,
        runs: [createCoordinatorRunSnapshot()],
        stateVersion: 1,
      }),
    ).toBe(true);
  });

  it('validates event payloads by event type', () => {
    const run = createCoordinatorRunSnapshot();

    expect(
      isCoordinatorEventEnvelope({
        categorySeq: 1,
        createdAt: 2_000,
        entityKey: 'run:run-1',
        entityVersion: 1,
        eventType: 'run-upserted',
        payload: run,
        runId: run.id,
      }),
    ).toBe(true);

    expect(
      isCoordinatorEventEnvelope({
        categorySeq: 1,
        createdAt: 2_000,
        entityKey: 'run:run-1',
        entityVersion: 1,
        eventType: 'run-upserted',
        payload: { id: 'run-1' },
        runId: run.id,
      }),
    ).toBe(false);

    expect(
      isCoordinatorEventEnvelope({
        categorySeq: 2,
        createdAt: 2_100,
        entityKey: 'run:run-1',
        entityVersion: 2,
        eventType: 'run-removed',
        payload: null,
        runId: run.id,
        tombstone: true,
      }),
    ).toBe(true);
  });
});
