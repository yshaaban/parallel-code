import { describe, expect, it } from 'vitest';
import {
  isCoordinatorBootstrapSnapshot,
  isCoordinatorEventEnvelope,
  isCoordinatorRunSnapshot,
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
    workflows: [],
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

  it('accepts workflow snapshots and legacy runs without workflow state', () => {
    const run = createCoordinatorRunSnapshot();
    const workflowRun: CoordinatorRunSnapshot = {
      ...run,
      workflows: [
        {
          appendPolicy: {
            maxActionsPerDecision: 8,
            maxStepAppends: 24,
          },
          createdAt: 1_000,
          eventVersion: 2,
          id: 'workflow-1',
          journal: [
            {
              at: 1_000,
              kind: 'workflow-created',
              message: 'Created map_reduce workflow.',
              seq: 1,
            },
          ],
          lanes: [
            {
              agentId: 'agent-child',
              assignment: 'Map the backend risks.',
              attempt: 1,
              createdAt: 1_010,
              id: 'lane-1',
              name: 'Backend',
              role: 'map',
              stageId: 'map',
              startedAt: 1_020,
              status: 'waiting-for-result',
              taskId: 'task-child',
              timeoutAt: 2_000,
              updatedAt: 1_020,
            },
          ],
          policy: {
            continueOnFailure: true,
            maxConcurrentLanes: 3,
            maxOutputBytesPerLane: 65_536,
            resultRequired: true,
            retryBackoffMs: 1_000,
            retryCount: 0,
            timeoutMs: 900_000,
          },
          results: [
            {
              agentId: 'agent-child',
              commandsRun: ['npm test'],
              confidence: 'high',
              createdAt: 1_200,
              evidence: [{ label: 'runtime test' }],
              findings: [{ severity: 'major', status: 'confirmed', summary: 'Risk found' }],
              id: 'result-1',
              laneId: 'lane-1',
              risks: ['follow-up needed'],
              runId: run.id,
              stageId: 'map',
              status: 'completed',
              summary: 'Backend map result',
              taskId: 'task-child',
              workflowId: 'workflow-1',
            },
          ],
          programVersion: 2,
          runId: run.id,
          stages: [
            {
              createdAt: 1_000,
              dependsOn: [],
              id: 'map',
              kind: 'map',
              laneIds: ['lane-1'],
              name: 'Map',
              resultIds: ['result-1'],
              startedAt: 1_020,
              status: 'waiting-for-results',
              updatedAt: 1_200,
            },
          ],
          startedAt: 1_000,
          status: 'running',
          template: 'map_reduce',
          title: 'Review latency',
          updatedAt: 1_200,
        },
      ],
    };
    const legacyRun = { ...run };
    delete (legacyRun as { workflows?: unknown }).workflows;

    expect(isCoordinatorRunSnapshot(workflowRun)).toBe(true);
    expect(isCoordinatorRunSnapshot(legacyRun)).toBe(true);
  });
});
