import { describe, expect, it } from 'vitest';
import type {
  CoordinatorLandingStateSnapshot,
  CoordinatorPromptRequestSnapshot,
  CoordinatorRunSnapshot,
  CoordinatorSubtaskSnapshot,
  CoordinatorWorkflowSnapshot,
} from '../domain/coordinator';
import { createCoordinatorRunView, getCoordinatorSubtaskActions } from './coordinator-ui-model';

const now = 1_000;

function createSubtask(
  overrides: Partial<CoordinatorSubtaskSnapshot> = {},
): CoordinatorSubtaskSnapshot {
  return {
    agentId: overrides.agentId ?? `agent-${overrides.taskId ?? '1'}`,
    assignment: overrides.assignment ?? 'Fix parser behavior',
    createdAt: overrides.createdAt ?? now,
    parentCoordinatorTaskId: overrides.parentCoordinatorTaskId ?? 'task-coordinator',
    status: overrides.status ?? 'running',
    taskId: overrides.taskId ?? 'task-child',
    toolTokenId: overrides.toolTokenId ?? `token-${overrides.taskId ?? '1'}`,
    updatedAt: overrides.updatedAt ?? now,
    worktreePath: overrides.worktreePath ?? '/tmp/project/.worktrees/task-child',
    ...(overrides.branchName !== undefined ? { branchName: overrides.branchName } : {}),
    ...(overrides.dedupeKey !== undefined ? { dedupeKey: overrides.dedupeKey } : {}),
    ...(overrides.hiddenOutputState !== undefined
      ? { hiddenOutputState: overrides.hiddenOutputState }
      : {}),
    ...(overrides.lastPromptRequestId !== undefined
      ? { lastPromptRequestId: overrides.lastPromptRequestId }
      : {}),
    ...(overrides.result !== undefined ? { result: overrides.result } : {}),
  };
}

function createPrompt(
  overrides: Partial<CoordinatorPromptRequestSnapshot> = {},
): CoordinatorPromptRequestSnapshot {
  return {
    attempts: overrides.attempts ?? 0,
    createdAt: overrides.createdAt ?? now,
    dedupeKey: overrides.dedupeKey ?? `prompt-${overrides.targetTaskId ?? 'task-child'}`,
    deliveryJournal: overrides.deliveryJournal ?? [],
    earliestDeliveryAt: overrides.earliestDeliveryAt ?? now,
    kind: overrides.kind ?? 'follow-up',
    requestId: overrides.requestId ?? `request-${overrides.targetTaskId ?? 'task-child'}`,
    runId: overrides.runId ?? 'run-1',
    sourceTaskId: overrides.sourceTaskId ?? 'task-coordinator',
    status: overrides.status ?? 'queued',
    targetAgentId: overrides.targetAgentId ?? `agent-${overrides.targetTaskId ?? 'task-child'}`,
    targetTaskId: overrides.targetTaskId ?? 'task-child',
    text: overrides.text ?? 'Please check the parser edge case.',
    ...(overrides.deliveredAt !== undefined ? { deliveredAt: overrides.deliveredAt } : {}),
    ...(overrides.failedAt !== undefined ? { failedAt: overrides.failedAt } : {}),
    ...(overrides.waitingReason !== undefined ? { waitingReason: overrides.waitingReason } : {}),
  };
}

function createLanding(
  overrides: Partial<CoordinatorLandingStateSnapshot> = {},
): CoordinatorLandingStateSnapshot {
  return {
    requestedAt: overrides.requestedAt ?? now,
    requestedByAgentId: overrides.requestedByAgentId ?? 'agent-task-child',
    runId: overrides.runId ?? 'run-1',
    status: overrides.status ?? 'validating',
    summary: overrides.summary ?? 'Land parser fix',
    taskId: overrides.taskId ?? 'task-child',
    verification: overrides.verification ?? ['npm test'],
    ...(overrides.cleanupAttemptId !== undefined
      ? { cleanupAttemptId: overrides.cleanupAttemptId }
      : {}),
    ...(overrides.commit !== undefined ? { commit: overrides.commit } : {}),
    ...(overrides.failure !== undefined ? { failure: overrides.failure } : {}),
    ...(overrides.landedCommit !== undefined ? { landedCommit: overrides.landedCommit } : {}),
    ...(overrides.landingAttemptId !== undefined
      ? { landingAttemptId: overrides.landingAttemptId }
      : {}),
    ...(overrides.sourceBranch !== undefined ? { sourceBranch: overrides.sourceBranch } : {}),
    ...(overrides.sourceHead !== undefined ? { sourceHead: overrides.sourceHead } : {}),
    ...(overrides.targetBranch !== undefined ? { targetBranch: overrides.targetBranch } : {}),
    ...(overrides.targetHeadBefore !== undefined
      ? { targetHeadBefore: overrides.targetHeadBefore }
      : {}),
  };
}

function createWorkflow(
  overrides: Partial<CoordinatorWorkflowSnapshot> = {},
): CoordinatorWorkflowSnapshot {
  return {
    createdAt: overrides.createdAt ?? now,
    eventVersion: overrides.eventVersion ?? 2,
    id: overrides.id ?? 'workflow-1',
    journal: overrides.journal ?? [],
    lanes: overrides.lanes ?? [
      {
        agentId: 'agent-map',
        assignment: 'Map backend risks.',
        attempt: 1,
        createdAt: now,
        id: 'lane-map',
        name: 'Backend',
        role: 'map',
        stageId: 'map',
        status: 'waiting-for-result',
        taskId: 'task-map',
        updatedAt: now,
      },
    ],
    policy: overrides.policy ?? {
      continueOnFailure: true,
      maxConcurrentLanes: 3,
      maxOutputBytesPerLane: 65_536,
      resultRequired: true,
      retryBackoffMs: 1_000,
      retryCount: 0,
      timeoutMs: 900_000,
    },
    results: overrides.results ?? [
      {
        agentId: 'agent-map',
        commandsRun: ['npm test'],
        confidence: 'high',
        createdAt: now,
        evidence: [{ label: 'runtime test' }],
        findings: [{ severity: 'major', status: 'confirmed', summary: 'Risk found' }],
        id: 'result-1',
        laneId: 'lane-map',
        risks: [],
        runId: 'run-1',
        stageId: 'map',
        status: 'completed',
        summary: 'Mapped backend risk.',
        taskId: 'task-map',
        workflowId: overrides.id ?? 'workflow-1',
      },
    ],
    runId: overrides.runId ?? 'run-1',
    stages: overrides.stages ?? [
      {
        createdAt: now,
        dependsOn: [],
        id: 'map',
        kind: 'map',
        laneIds: ['lane-map'],
        name: 'Map',
        resultIds: ['result-1'],
        status: 'waiting-for-results',
        updatedAt: now,
      },
      {
        createdAt: now,
        dependsOn: ['map'],
        id: 'reduce',
        kind: 'reduce',
        laneIds: [],
        name: 'Reduce',
        resultIds: [],
        status: 'pending',
        updatedAt: now,
      },
    ],
    startedAt: overrides.startedAt ?? now,
    status: overrides.status ?? 'waiting-for-results',
    template: overrides.template ?? 'map_reduce',
    title: overrides.title ?? 'Latency review',
    updatedAt: overrides.updatedAt ?? now,
  };
}

function createRun(overrides: Partial<CoordinatorRunSnapshot> = {}): CoordinatorRunSnapshot {
  return {
    coordinatorTaskId: overrides.coordinatorTaskId ?? 'task-coordinator',
    createdAt: overrides.createdAt ?? now,
    eventVersion: overrides.eventVersion ?? 1,
    id: overrides.id ?? 'run-1',
    landing: overrides.landing ?? [],
    limits: overrides.limits ?? {
      maxActiveSubtasks: 5,
      maxPendingPromptsPerTarget: 3,
      maxQueuedSubtasks: 20,
    },
    projectId: overrides.projectId ?? 'project-1',
    projectMode: overrides.projectMode ?? 'git',
    projectRoot: overrides.projectRoot ?? '/tmp/project',
    promptQueue: overrides.promptQueue ?? [],
    status: overrides.status ?? 'running',
    subtasks: overrides.subtasks ?? [],
    updatedAt: overrides.updatedAt ?? now,
    workflows: overrides.workflows ?? [],
  };
}

function requireValue<TValue>(value: TValue | undefined): TValue {
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error('Expected value to be defined');
  }

  return value;
}

describe('coordinator UI model', () => {
  it('summarizes run health and pending prompt pressure', () => {
    const run = createRun({
      promptQueue: [
        createPrompt({ requestId: 'prompt-1', status: 'queued', targetTaskId: 'task-running' }),
        createPrompt({
          requestId: 'prompt-2',
          status: 'blocked-by-question',
          targetTaskId: 'task-blocked',
        }),
        createPrompt({
          requestId: 'prompt-3',
          status: 'delivered',
          targetTaskId: 'task-running',
        }),
      ],
      subtasks: [
        createSubtask({ status: 'running', taskId: 'task-running' }),
        createSubtask({ status: 'waiting-for-user', taskId: 'task-blocked' }),
        createSubtask({ status: 'ready-for-review', taskId: 'task-ready' }),
      ],
    });

    const view = createCoordinatorRunView(run);

    expect(view.summary.activeCount).toBe(3);
    expect(view.summary.pendingPromptCount).toBe(2);
    expect(view.summary.blockedCount).toBe(1);
    expect(view.summary.readyCount).toBe(1);
    expect(view.summary.attentionCount).toBe(2);
  });

  it('sorts failed, blocked, and ready subtasks ahead of healthy running work', () => {
    const run = createRun({
      subtasks: [
        createSubtask({ status: 'running', taskId: 'task-running', updatedAt: 40 }),
        createSubtask({ status: 'ready-for-review', taskId: 'task-ready', updatedAt: 10 }),
        createSubtask({ status: 'failed', taskId: 'task-failed', updatedAt: 20 }),
        createSubtask({ status: 'waiting-for-user', taskId: 'task-blocked', updatedAt: 30 }),
      ],
    });

    const view = createCoordinatorRunView(run);

    expect(view.chips.map((chip) => chip.taskId)).toEqual([
      'task-failed',
      'task-blocked',
      'task-ready',
      'task-running',
    ]);
  });

  it('attaches prompt beads to the matching subtask and caps the visible count', () => {
    const run = createRun({
      promptQueue: [
        createPrompt({ requestId: 'p1', targetTaskId: 'task-child', status: 'queued' }),
        createPrompt({ requestId: 'p2', targetTaskId: 'task-child', status: 'delivering' }),
        createPrompt({
          requestId: 'p3',
          targetTaskId: 'task-child',
          status: 'waiting-for-user-idle',
        }),
        createPrompt({
          requestId: 'p4',
          targetTaskId: 'task-child',
          status: 'blocked-by-question',
        }),
      ],
      subtasks: [createSubtask({ taskId: 'task-child' })],
    });

    const [chip] = createCoordinatorRunView(run).chips;

    expect(chip?.badgeText).toBe('4');
    expect(chip?.promptBeads).toHaveLength(3);
    expect(chip?.promptBeads.map((bead) => bead.tone)).toEqual(['info', 'info', 'warning']);
  });

  it('marks stale restored runs as danger and disables spawning', () => {
    const run = createRun({ status: 'stale-after-restore' });

    const view = createCoordinatorRunView(run);

    expect(view.summary.stale).toBe(true);
    expect(view.summary.runTone).toBe('danger');
    expect(view.spawnAction.disabled).toBe(true);
    expect(view.spawnAction.reason).toBe('Run is stale-after-restore.');
  });

  it('projects workflow timelines from backend-owned snapshots', () => {
    const run = createRun({
      workflows: [createWorkflow()],
    });

    const [workflow] = createCoordinatorRunView(run).workflows;

    expect(workflow).toMatchObject({
      activeLaneCount: 1,
      findingCount: 1,
      resultCount: 1,
      status: 'waiting-for-results',
      template: 'map_reduce',
      title: 'Latency review',
      tone: 'info',
    });
    expect(workflow?.stages.map((stage) => [stage.label, stage.tone, stage.laneCount])).toEqual([
      ['M', 'info', 1],
      ['R', 'normal', 0],
    ]);
  });

  it('projects landing failures as danger attention on the related chip', () => {
    const run = createRun({
      landing: [
        createLanding({
          failure: 'Project root has uncommitted changes.',
          status: 'dirty-parent-worktree',
          taskId: 'task-child',
        }),
      ],
      subtasks: [createSubtask({ status: 'running', taskId: 'task-child' })],
    });

    const [chip] = createCoordinatorRunView(run).chips;

    expect(chip?.tone).toBe('danger');
    expect(chip?.landingLabel).toBe('Dirty Parent Worktree');
    expect(chip?.diffHint).toBe(true);
    expect(createCoordinatorRunView(run).summary.attentionCount).toBe(1);
  });

  it('allows ask-to-land only for ready git-backed active subtasks', () => {
    const run = createRun({
      subtasks: [createSubtask({ status: 'ready-for-review', taskId: 'task-ready' })],
    });
    const chip = requireValue(createCoordinatorRunView(run).chips[0]);

    const actions = getCoordinatorSubtaskActions(chip, run);
    const askLand = actions.find((action) => action.id === 'ask-land');

    expect(askLand).toMatchObject({
      disabled: false,
      toolName: 'send_prompt',
    });
  });

  it('disables git-only actions for non-git coordinator runs', () => {
    const run = createRun({
      projectMode: 'non-git',
      subtasks: [createSubtask({ status: 'ready-for-review', taskId: 'task-ready' })],
    });
    const chip = requireValue(createCoordinatorRunView(run).chips[0]);

    const actions = getCoordinatorSubtaskActions(chip, run);
    const inspectDiff = actions.find((action) => action.id === 'inspect-diff');
    const askLand = actions.find((action) => action.id === 'ask-land');

    expect(inspectDiff).toMatchObject({
      disabled: true,
      reason: 'Diff inspection requires a git-backed coordinator run.',
    });
    expect(askLand).toMatchObject({
      disabled: true,
      reason: 'Landing requires a git-backed coordinator run.',
    });
  });

  it('disables backend-targeted actions for terminal subtasks', () => {
    const run = createRun({
      subtasks: [createSubtask({ status: 'failed', taskId: 'task-failed' })],
    });
    const chip = requireValue(createCoordinatorRunView(run).chips[0]);

    const actions = getCoordinatorSubtaskActions(chip, run);
    const inspectOutput = actions.find((action) => action.id === 'inspect-output');
    const inspectDiff = actions.find((action) => action.id === 'inspect-diff');
    const sendPrompt = actions.find((action) => action.id === 'send-prompt');
    const waitForIdle = actions.find((action) => action.id === 'wait-for-idle');

    expect(inspectOutput).toMatchObject({
      disabled: true,
      reason: 'Terminal subtask is no longer active.',
    });
    expect(inspectDiff).toMatchObject({
      disabled: true,
      reason: 'Terminal subtask is no longer active.',
    });
    expect(sendPrompt).toMatchObject({
      disabled: true,
      reason: 'Terminal subtask cannot receive follow-up prompts.',
    });
    expect(waitForIdle).toMatchObject({
      disabled: true,
      reason: 'Terminal subtask is no longer active.',
    });
    expect(actions.find((action) => action.id === 'ask-land')).toMatchObject({
      disabled: true,
      reason: 'Terminal subtask is no longer active.',
    });
  });

  it('disables mutating actions for inactive coordinator runs while leaving inspection available', () => {
    const run = createRun({
      status: 'completed',
      subtasks: [createSubtask({ status: 'running', taskId: 'task-running' })],
    });
    const chip = requireValue(createCoordinatorRunView(run).chips[0]);

    const actions = getCoordinatorSubtaskActions(chip, run);

    expect(actions.find((action) => action.id === 'inspect-output')).toMatchObject({
      disabled: false,
    });
    expect(actions.find((action) => action.id === 'send-prompt')).toMatchObject({
      disabled: true,
      reason: 'Run is completed.',
    });
    expect(actions.find((action) => action.id === 'close')).toMatchObject({
      disabled: true,
      reason: 'Run is completed.',
    });
  });
});
