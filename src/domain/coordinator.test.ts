import { describe, expect, it } from 'vitest';
import {
  COORDINATOR_LIMITS,
  countCoordinatorWorkflowPendingApprovals,
  countCoordinatorWorkflowRetriesUsed,
  createCoordinatorWorkflowBudgetSnapshot,
  formatCoordinatorWorkflowBudgetExhaustedReason,
  getCommittedWorkflowLaneCount,
  getCoordinatorWorkflowBudgetLimits,
  isCoordinatorBootstrapSnapshot,
  isCoordinatorEventEnvelope,
  isCoordinatorOperatorActionName,
  isCoordinatorRunSnapshot,
  isCoordinatorSubtaskLaunchSnapshot,
  isCoordinatorSubtaskSnapshot,
  type CoordinatorRunSnapshot,
  type CoordinatorSubtaskLaunchSnapshot,
  type CoordinatorWorkflowSnapshot,
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

function createBudgetWorkflowSnapshot(): CoordinatorWorkflowSnapshot {
  return {
    appendPolicy: {
      maxActionsPerDecision: 8,
      maxStepAppends: 24,
    },
    createdAt: 1_000,
    eventVersion: 2,
    id: 'workflow-budget',
    journal: [],
    lanes: [
      {
        assignment: 'Scan the backend.',
        attempt: 1,
        createdAt: 1_010,
        id: 'lane-scan',
        name: 'Scan',
        stageId: 'scan',
        status: 'failed',
        updatedAt: 1_020,
      },
      {
        assignment: 'Scan the backend.',
        attempt: 2,
        createdAt: 1_030,
        id: 'lane-scan-retry',
        name: 'Scan',
        spawnedBy: 'scheduler',
        stageId: 'scan',
        status: 'waiting-for-result',
        updatedAt: 1_030,
      },
      {
        assignment: 'Scan the backend.',
        attempt: 2,
        createdAt: 1_040,
        id: 'lane-scan-resume',
        name: 'Scan',
        spawnedBy: 'resume',
        stageId: 'scan',
        status: 'waiting-for-result',
        updatedAt: 1_040,
      },
      {
        assignment: 'Scan the backend.',
        attempt: 2,
        createdAt: 1_050,
        id: 'lane-scan-legacy',
        name: 'Scan',
        stageId: 'scan',
        status: 'waiting-for-result',
        updatedAt: 1_050,
      },
    ],
    policy: {
      continueOnFailure: true,
      maxConcurrentLanes: 3,
      maxIterationsPerBranch: 3,
      maxOutputBytesPerLane: 65_536,
      resultRequired: true,
      retryBackoffMs: 1_000,
      retryCount: 1,
      timeoutMs: 900_000,
    },
    programVersion: 2,
    results: [],
    runId: 'run-1',
    sourceSpec: {
      steps: [
        {
          dependsOn: [],
          id: 'scan',
          kind: 'fanout',
          lanes: [{ assignment: 'Scan the backend.', id: 'scan-lane', name: 'Scan' }],
          name: 'Scan',
          resultSourceStepIds: [],
          sourceStepIds: [],
          verifiers: [],
        },
        {
          dependsOn: ['scan'],
          id: 'follow',
          kind: 'worker',
          lanes: [],
          name: 'Follow',
          resultSourceStepIds: [],
          sourceStepIds: [],
          verifiers: [],
        },
      ],
      version: 2,
    },
    stages: [
      {
        createdAt: 1_000,
        dependsOn: [],
        id: 'scan',
        kind: 'fan-out',
        laneIds: ['lane-scan', 'lane-scan-retry', 'lane-scan-resume', 'lane-scan-legacy'],
        name: 'Scan',
        resultIds: [],
        status: 'waiting-for-results',
        updatedAt: 1_040,
      },
      {
        createdAt: 1_000,
        dependsOn: ['scan'],
        id: 'follow',
        kind: 'custom',
        laneIds: [],
        name: 'Follow',
        resultIds: [],
        status: 'pending',
        updatedAt: 1_000,
      },
    ],
    startedAt: 1_000,
    status: 'running',
    template: 'custom',
    title: 'Budget fixture',
    updatedAt: 1_040,
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
              spawnedBy: 'scheduler',
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
            maxIterationsPerBranch: 3,
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

    const firstWorkflow = workflowRun.workflows[0];
    if (!firstWorkflow) {
      throw new Error('Expected a workflow snapshot fixture');
    }
    const malformedWorkflowRun = {
      ...workflowRun,
      workflows: [
        {
          ...firstWorkflow,
          sourceSpec: {
            steps: [{ id: 'broken-step' }],
            version: 1,
          },
        },
      ],
    };
    expect(isCoordinatorRunSnapshot(malformedWorkflowRun)).toBe(false);
  });

  it('classifies operator action names separately from agent tool names', () => {
    expect(isCoordinatorOperatorActionName('resume_run')).toBe(true);
    expect(isCoordinatorOperatorActionName('approve_workflow_actions')).toBe(true);
    expect(isCoordinatorOperatorActionName('deny_workflow_actions')).toBe(true);
    expect(isCoordinatorOperatorActionName('pause_run')).toBe(true);
    expect(isCoordinatorOperatorActionName('retry_lane')).toBe(true);
    expect(isCoordinatorOperatorActionName('unpause_run')).toBe(true);
    expect(isCoordinatorOperatorActionName('spawn_subtask')).toBe(false);
    expect(isCoordinatorOperatorActionName(undefined)).toBe(false);
  });

  it('accepts paused runs, approval policies, and pending approval entries', () => {
    const run = createCoordinatorRunSnapshot();
    const workflow = createBudgetWorkflowSnapshot();
    const pausedRun: CoordinatorRunSnapshot = {
      ...run,
      pausedAt: 2_000,
      status: 'paused-by-user',
      workflows: [
        {
          ...workflow,
          pendingApprovals: [
            {
              actions: [
                {
                  kind: 'append_worker',
                  step: {
                    assignment: 'Follow up.',
                    dependsOn: ['scan'],
                    id: 'follow-up',
                    kind: 'worker',
                    lanes: [{ assignment: 'Follow up.', id: 'follow-up-lane', name: 'Follow up' }],
                    name: 'Follow up',
                    resultSourceStepIds: [],
                    sourceStepIds: [],
                    verifiers: [],
                  },
                },
              ],
              createdAt: 2_000,
              id: 'result-1:approval',
              laneId: 'lane-scan',
              resultId: 'result-1',
              stageId: 'scan',
              status: 'pending',
            },
            {
              actions: [{ kind: 'stop_workflow', reason: 'Done.' }],
              createdAt: 1_500,
              id: 'result-0:approval',
              laneId: 'lane-scan',
              reason: 'stale-after-restore',
              resolvedAt: 1_900,
              resultId: 'result-0',
              stageId: 'scan',
              status: 'cancelled',
            },
          ],
          policy: { ...workflow.policy, requireDecisionApproval: true },
        },
      ],
    };
    expect(isCoordinatorRunSnapshot(pausedRun)).toBe(true);
    expect(countCoordinatorWorkflowPendingApprovals(pausedRun.workflows[0] ?? workflow)).toBe(1);
    expect(countCoordinatorWorkflowPendingApprovals(workflow)).toBe(0);

    expect(isCoordinatorRunSnapshot({ ...pausedRun, pausedAt: 'later' })).toBe(false);
    expect(
      isCoordinatorRunSnapshot({
        ...run,
        workflows: [
          {
            ...workflow,
            pendingApprovals: [
              {
                actions: [{ kind: 'stop_workflow', reason: 'Done.' }],
                createdAt: 2_000,
                id: 'result-1:approval',
                laneId: 'lane-scan',
                resultId: 'result-1',
                stageId: 'scan',
                status: 'maybe',
              },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(
      isCoordinatorRunSnapshot({
        ...run,
        workflows: [
          {
            ...workflow,
            pendingApprovals: [
              {
                actions: [{ kind: 'stop_workflow', reason: 'Done.' }],
                createdAt: 2_000,
                id: 'result-1:approval',
                laneId: 'lane-scan',
                stageId: 'scan',
                status: 'pending',
              },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(
      isCoordinatorRunSnapshot({
        ...run,
        workflows: [
          {
            ...workflow,
            policy: { ...workflow.policy, requireDecisionApproval: 'yes' },
          },
        ],
      }),
    ).toBe(false);
  });

  it('accepts optional resume audit, restore markers, and lane provenance fields', () => {
    const run = createCoordinatorRunSnapshot();
    const resumableRun: CoordinatorRunSnapshot = {
      ...run,
      resumes: [
        {
          failedTaskIds: ['task-broken'],
          requestedAt: 2_000,
          respawnedTaskIds: ['task-child'],
          resumeId: 'resume-1',
        },
      ],
      subtasks: [
        {
          agentId: 'agent-child',
          assignment: 'Do the work',
          createdAt: 1_000,
          interruptedByRestoreAt: 1_500,
          parentCoordinatorTaskId: 'task-coordinator',
          status: 'exited',
          taskId: 'task-child',
          toolTokenId: 'token-child',
          updatedAt: 1_500,
          worktreePath: '/repo/task-child',
        },
      ],
    };

    expect(isCoordinatorRunSnapshot(resumableRun)).toBe(true);
    expect(isCoordinatorSubtaskSnapshot(resumableRun.subtasks[0])).toBe(true);
    expect(
      isCoordinatorRunSnapshot({
        ...run,
        resumes: [{ requestedAt: 2_000, resumeId: 'resume-1' }],
      }),
    ).toBe(false);
    expect(
      isCoordinatorSubtaskSnapshot({
        ...resumableRun.subtasks[0],
        interruptedByRestoreAt: 'soon',
      }),
    ).toBe(false);
  });

  it('accepts workflow policies with and without optional budget fields', () => {
    const run = createCoordinatorRunSnapshot();
    const workflowRun = {
      ...run,
      workflows: [createBudgetWorkflowSnapshot()],
    };
    expect(isCoordinatorRunSnapshot(workflowRun)).toBe(true);

    const budgetRun = {
      ...run,
      workflows: [
        {
          ...createBudgetWorkflowSnapshot(),
          execution: {
            activeLaneCount: 1,
            budget: {
              deadlineAt: 3_600_000,
              exhausted: 'wall-clock',
              lanes: { limit: 12, used: 3 },
              retries: { limit: 8, used: 1 },
              steps: { limit: 24, used: 2 },
            },
            deadlineAt: 3_600_000,
            lastTickAt: 1_200,
            pendingRetryLaneIds: [],
            readyStageIds: [],
          },
          policy: {
            ...createBudgetWorkflowSnapshot().policy,
            maxTotalLanes: 6,
            maxTotalRetries: 2,
            maxTotalSteps: 8,
            maxWallClockMs: 600_000,
          },
        },
      ],
    };
    expect(isCoordinatorRunSnapshot(budgetRun)).toBe(true);
    expect(
      isCoordinatorRunSnapshot({
        ...run,
        workflows: [
          {
            ...createBudgetWorkflowSnapshot(),
            policy: {
              ...createBudgetWorkflowSnapshot().policy,
              maxTotalSteps: 'many',
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      isCoordinatorRunSnapshot({
        ...run,
        workflows: [
          {
            ...createBudgetWorkflowSnapshot(),
            execution: {
              activeLaneCount: 0,
              budget: { deadlineAt: 1_000 },
              lastTickAt: 1_000,
              pendingRetryLaneIds: [],
              readyStageIds: [],
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it('clamps workflow budget limits to server caps and applies defaults', () => {
    expect(getCoordinatorWorkflowBudgetLimits(undefined)).toEqual({
      maxTotalLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
      maxTotalRetries: COORDINATOR_LIMITS.maxWorkflowTotalRetries,
      maxTotalSteps: COORDINATOR_LIMITS.maxWorkflowTotalSteps,
      maxWallClockMs: COORDINATOR_LIMITS.workflowDefaultWallClockMs,
    });
    expect(
      getCoordinatorWorkflowBudgetLimits({
        maxTotalLanes: 4,
        maxTotalRetries: 1,
        maxTotalSteps: 6,
        maxWallClockMs: 60_000,
      }),
    ).toEqual({
      maxTotalLanes: 4,
      maxTotalRetries: 1,
      maxTotalSteps: 6,
      maxWallClockMs: 60_000,
    });
    expect(
      getCoordinatorWorkflowBudgetLimits({
        maxTotalLanes: 1_000,
        maxTotalRetries: 1_000,
        maxTotalSteps: 1_000,
        maxWallClockMs: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({
      maxTotalLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
      maxTotalRetries: COORDINATOR_LIMITS.maxWorkflowTotalRetries,
      maxTotalSteps: COORDINATOR_LIMITS.maxWorkflowTotalSteps,
      maxWallClockMs: COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs,
    });
  });

  it('computes budget usage from spec steps, committed lanes, and scheduler retries only', () => {
    const workflow = createBudgetWorkflowSnapshot();
    expect(getCommittedWorkflowLaneCount(workflow)).toBe(5);
    // lane-scan-retry has an explicit scheduler provenance; lane-scan-legacy is a restored
    // legacy lane without spawnedBy and must still consume the retry budget via the fallback.
    expect(countCoordinatorWorkflowRetriesUsed(workflow)).toBe(2);

    const budget = createCoordinatorWorkflowBudgetSnapshot(workflow);
    expect(budget).toEqual({
      deadlineAt: 1_000 + COORDINATOR_LIMITS.workflowDefaultWallClockMs,
      lanes: { limit: COORDINATOR_LIMITS.maxWorkflowLanes, used: 5 },
      retries: { limit: COORDINATOR_LIMITS.maxWorkflowTotalRetries, used: 2 },
      steps: { limit: COORDINATOR_LIMITS.maxWorkflowTotalSteps, used: 2 },
    });
    expect(
      createCoordinatorWorkflowBudgetSnapshot({
        ...workflow,
        execution: {
          activeLaneCount: 0,
          budget: {
            deadlineAt: 9_000,
            exhausted: 'lanes',
            lanes: { limit: 12, used: 12 },
            retries: { limit: 8, used: 0 },
            steps: { limit: 24, used: 2 },
          },
          deadlineAt: 9_000,
          lastTickAt: 1_000,
          pendingRetryLaneIds: [],
          readyStageIds: [],
        },
      }),
    ).toMatchObject({ deadlineAt: 9_000, exhausted: 'lanes' });
    expect(formatCoordinatorWorkflowBudgetExhaustedReason('steps', { limit: 4, used: 5 })).toBe(
      'budget-exhausted: steps (5/4)',
    );
  });

  it('validates coordinator subtask launch snapshots', () => {
    const launch: CoordinatorSubtaskLaunchSnapshot = {
      agent: {
        args: ['--model', 'fast'],
        command: 'custom-agent',
        env: { CUSTOM: '1' },
        skipPermissionsArgs: ['--unsafe'],
      },
      assignment: 'Build the slice',
      baseBranch: 'main',
      dedupeKey: 'run-1:Child Task:Build the slice',
      name: 'Child Task',
      recordedAt: 1_000,
      runId: 'run-1',
      taskId: 'task-child',
    };

    expect(isCoordinatorSubtaskLaunchSnapshot(launch)).toBe(true);
    expect(isCoordinatorSubtaskLaunchSnapshot({ ...launch, agent: { command: 42 } })).toBe(false);
    expect(isCoordinatorSubtaskLaunchSnapshot({ ...launch, dedupeKey: undefined })).toBe(false);
    expect(
      isCoordinatorSubtaskLaunchSnapshot({
        ...launch,
        agent: { ...launch.agent, env: { CUSTOM: 1 } },
      }),
    ).toBe(false);
  });
});
