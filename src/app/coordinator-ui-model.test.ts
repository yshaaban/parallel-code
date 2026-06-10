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
    startup: overrides.startup ?? {
      followupPromptMode: 'post-ready-prompt',
      initialAssignmentMode: 'spawn-seeded-interactive',
      initialAssignmentStatus: 'seeded-at-spawn',
      readinessPolicy: 'codex',
      seededAt: now,
    },
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
    appendPolicy: overrides.appendPolicy ?? {
      maxActionsPerDecision: 8,
      maxStepAppends: 24,
    },
    createdAt: overrides.createdAt ?? now,
    eventVersion: overrides.eventVersion ?? 2,
    ...(overrides.execution !== undefined ? { execution: overrides.execution } : {}),
    id: overrides.id ?? 'workflow-1',
    ...(overrides.expansions !== undefined ? { expansions: overrides.expansions } : {}),
    journal: overrides.journal ?? [],
    ...(overrides.pendingApprovals !== undefined
      ? { pendingApprovals: overrides.pendingApprovals }
      : {}),
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
      maxIterationsPerBranch: 3,
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
    programVersion: overrides.programVersion ?? 2,
    runId: overrides.runId ?? 'run-1',
    ...(overrides.sourceSpec !== undefined ? { sourceSpec: overrides.sourceSpec } : {}),
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
    ...(overrides.stepAppends !== undefined ? { stepAppends: overrides.stepAppends } : {}),
    template: overrides.template ?? 'map_reduce',
    title: overrides.title ?? 'Latency review',
    updatedAt: overrides.updatedAt ?? now,
    ...(overrides.verdicts !== undefined ? { verdicts: overrides.verdicts } : {}),
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
    ...(overrides.pausedAt !== undefined ? { pausedAt: overrides.pausedAt } : {}),
    promptQueue: overrides.promptQueue ?? [],
    ...(overrides.resumes !== undefined ? { resumes: overrides.resumes } : {}),
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

  it('projects seeded Codex startup and prompt-wait detail for subtasks', () => {
    const run = createRun({
      promptQueue: [
        createPrompt({
          requestId: 'prompt-followup',
          status: 'waiting-for-terminal-prompt',
          targetTaskId: 'task-codex',
          waitingReason: 'agent-quiet',
        }),
      ],
      subtasks: [
        createSubtask({
          startup: {
            followupPromptMode: 'post-ready-prompt',
            initialAssignmentMode: 'spawn-seeded-interactive',
            initialAssignmentStatus: 'seeded-at-spawn',
            readinessPolicy: 'codex',
            seededAt: now,
          },
          status: 'running',
          taskId: 'task-codex',
        }),
      ],
    });

    const [chip] = createCoordinatorRunView(run).chips;

    expect(chip).toMatchObject({
      followupPromptEnabled: true,
      followupPromptModeLabel: 'Follow-up prompts wait for readiness',
      initialAssignmentLabel: 'Initial assignment seeded at spawn',
      readinessPolicyLabel: 'Codex readiness detection',
      statusDetail: 'Waiting for the Codex composer prompt',
    });
  });

  it('marks stale restored runs as danger and disables spawning', () => {
    const run = createRun({ status: 'stale-after-restore' });

    const view = createCoordinatorRunView(run);

    expect(view.summary.stale).toBe(true);
    expect(view.summary.runTone).toBe('danger');
    expect(view.spawnAction.disabled).toBe(true);
    expect(view.spawnAction.reason).toBe('Run is stale-after-restore.');
  });

  it('enables the resume action only for stale restored runs', () => {
    const staleView = createCoordinatorRunView(createRun({ status: 'stale-after-restore' }));

    expect(staleView.resumeAction).toEqual({
      danger: false,
      disabled: false,
      id: 'resume-run',
      label: 'Resume run',
      toolName: 'resume_run',
    });

    for (const status of ['running', 'completed', 'cancelled'] as const) {
      const view = createCoordinatorRunView(createRun({ status }));
      expect(view.resumeAction).toMatchObject({
        disabled: true,
        id: 'resume-run',
        reason: `Run is ${status}; only stale runs can be resumed.`,
        toolName: 'resume_run',
      });
    }
  });

  it('offers pause for running runs and unpause for paused runs', () => {
    const runningView = createCoordinatorRunView(createRun());
    expect(runningView.pauseAction).toEqual({
      danger: false,
      disabled: false,
      id: 'pause-run',
      label: 'Pause',
      toolName: 'pause_run',
    });
    expect(runningView.summary.paused).toBe(false);

    const pausedView = createCoordinatorRunView(
      createRun({ pausedAt: now + 100, status: 'paused-by-user' }),
    );
    expect(pausedView.pauseAction).toEqual({
      danger: false,
      disabled: false,
      id: 'unpause-run',
      label: 'Unpause',
      toolName: 'unpause_run',
    });
    expect(pausedView.summary).toMatchObject({
      paused: true,
      runTone: 'warning',
      statusLabel: 'Paused By User',
    });
    expect(pausedView.spawnAction).toMatchObject({
      disabled: true,
      reason: 'Run is paused-by-user.',
    });

    for (const status of ['completed', 'cancelled', 'stale-after-restore'] as const) {
      const view = createCoordinatorRunView(createRun({ status }));
      expect(view.pauseAction).toMatchObject({
        disabled: true,
        id: 'pause-run',
        reason: `Run is ${status}; only running runs can be paused.`,
      });
    }
  });

  it('projects pending approvals as attention with legal-action gating', () => {
    const pendingApprovals: NonNullable<CoordinatorWorkflowSnapshot['pendingApprovals']> = [
      {
        actions: [
          {
            kind: 'append_worker',
            step: {
              assignment: 'Follow up.',
              dependsOn: ['map'],
              id: 'followup',
              kind: 'worker',
              lanes: [{ assignment: 'Follow up.', id: 'followup-lane', name: 'Followup' }],
              name: 'Followup',
              resultSourceStepIds: [],
              sourceStepIds: [],
              verifiers: [],
            },
          },
          { kind: 'stop_workflow', reason: 'Then stop.' },
        ],
        createdAt: now + 50,
        id: 'result-1:approval',
        laneId: 'lane-map',
        resultId: 'result-1',
        stageId: 'map',
        status: 'pending',
      },
      {
        actions: [{ kind: 'stop_workflow', reason: 'Old request.' }],
        createdAt: now,
        id: 'result-0:approval',
        laneId: 'lane-map',
        resolvedAt: now + 10,
        resultId: 'result-0',
        status: 'denied',
        stageId: 'map',
      },
    ];
    const run = createRun({ workflows: [createWorkflow({ pendingApprovals })] });

    const view = createCoordinatorRunView(run);
    const workflow = requireValue(view.workflows[0]);
    expect(view.summary.pendingApprovalCount).toBe(1);
    expect(view.summary.attentionCount).toBe(1);
    expect(workflow.tone).toBe('warning');
    expect(workflow.pendingApprovals).toEqual([
      {
        actionSummary: 'append_worker followup · stop_workflow: Then stop.',
        createdAt: now + 50,
        id: 'result-1:approval',
        laneLabel: 'Backend',
        stageLabel: 'Map',
      },
    ]);

    const pausedView = createCoordinatorRunView(
      createRun({
        pausedAt: now,
        status: 'paused-by-user',
        workflows: [createWorkflow({ pendingApprovals })],
      }),
    );
    expect(requireValue(pausedView.workflows[0]).pendingApprovals[0]?.approvalGateReason).toBe(
      undefined,
    );

    const cancelledView = createCoordinatorRunView(
      createRun({
        status: 'cancelled',
        workflows: [createWorkflow({ pendingApprovals })],
      }),
    );
    expect(requireValue(cancelledView.workflows[0]).pendingApprovals[0]).toMatchObject({
      approvalGateReason: 'Run is cancelled.',
    });
  });

  it('projects manual-retry lanes only when no retry is already scheduled', () => {
    const lanes: CoordinatorWorkflowSnapshot['lanes'] = [
      {
        assignment: 'Map backend risks.',
        attempt: 1,
        createdAt: now,
        dedupeKey: 'lane-a',
        failure: 'agent crashed',
        id: 'lane-a',
        name: 'Backend',
        stageId: 'map',
        status: 'failed',
        updatedAt: now,
      },
      {
        assignment: 'Map frontend risks.',
        attempt: 1,
        createdAt: now,
        dedupeKey: 'lane-b',
        failure: 'lane timed out',
        id: 'lane-b',
        name: 'Frontend',
        stageId: 'map',
        status: 'timed-out',
        updatedAt: now,
      },
      {
        assignment: 'Map frontend risks.',
        attempt: 2,
        createdAt: now + 10,
        dedupeKey: 'lane-b:retry:2',
        id: 'lane-b-retry',
        name: 'Frontend',
        stageId: 'map',
        status: 'waiting-for-result',
        updatedAt: now + 10,
      },
    ];
    const view = createCoordinatorRunView(
      createRun({ workflows: [createWorkflow({ lanes, status: 'running' })] }),
    );

    expect(requireValue(view.workflows[0]).retryableManualLanes).toEqual([
      {
        failure: 'agent crashed',
        laneId: 'lane-a',
        name: 'Backend',
        status: 'failed',
      },
    ]);

    const pausedView = createCoordinatorRunView(
      createRun({
        pausedAt: now,
        status: 'paused-by-user',
        workflows: [createWorkflow({ lanes, status: 'running' })],
      }),
    );
    expect(requireValue(pausedView.workflows[0]).retryableManualLanes[0]).toMatchObject({
      retryGateReason: 'Run is paused-by-user.',
    });
  });

  it('maps operator journal kinds to tones by exact kind', () => {
    const view = createCoordinatorRunView(
      createRun({
        workflows: [
          createWorkflow({
            journal: [
              { at: now, kind: 'decision-approval-requested', message: 'Requested.', seq: 1 },
              { at: now + 1, kind: 'decision-approval-approved', message: 'Approved.', seq: 2 },
              { at: now + 2, kind: 'decision-approval-denied', message: 'Denied.', seq: 3 },
              { at: now + 3, kind: 'run-paused', message: 'Paused.', seq: 4 },
              { at: now + 4, kind: 'lane-manual-retry', message: 'Retried.', seq: 5 },
            ],
          }),
        ],
      }),
    );

    const activity = requireValue(view.workflows[0]).activityPreview;
    expect(activity.map((entry) => [entry.kind, entry.tone])).toEqual([
      ['lane-manual-retry', 'info'],
      ['run-paused', 'warning'],
      ['decision-approval-denied', 'warning'],
      ['decision-approval-approved', 'success'],
      ['decision-approval-requested', 'warning'],
    ]);
  });

  it('projects respawned subtask chips with an active tone after a resume snapshot', () => {
    const run = createRun({
      resumes: [
        {
          failedTaskIds: [],
          requestedAt: now + 100,
          respawnedTaskIds: ['task-child'],
          resumeId: 'resume-1',
        },
      ],
      status: 'running',
      subtasks: [createSubtask({ status: 'running', taskId: 'task-child' })],
    });

    const view = createCoordinatorRunView(run);

    expect(view.chips[0]).toMatchObject({
      status: 'running',
      taskId: 'task-child',
      tone: 'normal',
    });
    expect(view.resumeAction.disabled).toBe(true);
  });

  it('projects workflow timelines from backend-owned snapshots', () => {
    const run = createRun({
      workflows: [
        createWorkflow({
          journal: [
            {
              at: now + 1,
              kind: 'lane-result',
              laneId: 'lane-map',
              message: 'Mapped backend risk.',
              resultId: 'result-1',
              seq: 1,
              stageId: 'map',
            },
          ],
          verdicts: [
            {
              createdAt: now + 2,
              findingId: 'finding-1',
              id: 'verdict-1',
              reason: 'Evidence matched.',
              resultId: 'result-1',
              status: 'confirmed',
              verifierLaneId: 'lane-map',
            },
          ],
        }),
      ],
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
      verdictSummary: {
        confirmed: 1,
        needsMoreEvidence: 0,
        refuted: 0,
      },
    });
    expect(workflow?.stages.map((stage) => [stage.label, stage.tone, stage.laneCount])).toEqual([
      ['M', 'info', 1],
      ['R', 'normal', 0],
    ]);
    expect(workflow?.activityPreview[0]).toMatchObject({
      kind: 'lane-result',
      laneLabel: 'Backend',
      message: 'Mapped backend risk.',
      stageLabel: 'Map',
      tone: 'success',
    });
    expect(workflow?.resultPreview[0]).toMatchObject({
      findingCount: 1,
      findingsPreview: ['Risk found'],
      laneLabel: 'Backend',
      statusLabel: 'Completed',
      summary: 'Mapped backend risk.',
    });
  });

  it('projects join progress and branch iteration counts for adaptive workflows', () => {
    const run = createRun({
      workflows: [
        createWorkflow({
          expansions: [
            {
              actions: [
                {
                  actionId: 'action-1',
                  branchKey: 'repo-followup',
                  bundleId: 'repo-followup',
                  iteration: 1,
                  kind: 'append_branch_bundle',
                  stepIds: ['repo-followup-fanout', 'repo-followup-verify'],
                },
              ],
              createdAt: now + 5,
              id: 'expansion-1',
              sourceLaneId: 'lane-map',
              sourceResultId: 'result-1',
              sourceTaskId: 'task-map',
            },
          ],
          sourceSpec: {
            steps: [
              {
                dependsOn: [],
                id: 'scan',
                kind: 'fanout',
                lanes: [
                  { id: 'backend', name: 'Backend' },
                  { id: 'ui', name: 'UI' },
                  { id: 'docs', name: 'Docs' },
                ],
                name: 'Scan',
                policy: {
                  joinMode: 'quorum',
                  quorumCount: 2,
                },
                resultSourceStepIds: [],
                sourceStepIds: [],
                verifiers: [],
              },
              {
                dependsOn: ['scan'],
                id: 'synthesize',
                kind: 'synthesize',
                lanes: [],
                name: 'Synthesize',
                resultSourceStepIds: ['scan'],
                sourceStepIds: ['scan'],
                verifiers: [],
              },
            ],
            version: 2,
          },
          stages: [
            {
              createdAt: now,
              dependsOn: [],
              id: 'scan',
              kind: 'map',
              laneIds: ['lane-backend', 'lane-ui', 'lane-docs'],
              name: 'Scan',
              resultIds: ['result-backend', 'result-ui'],
              status: 'waiting-for-results',
              updatedAt: now + 2,
            },
            {
              createdAt: now,
              dependsOn: ['scan'],
              id: 'synthesize',
              kind: 'synthesize',
              laneIds: ['lane-synthesize'],
              name: 'Synthesize',
              resultIds: [],
              status: 'waiting-for-results',
              updatedAt: now + 3,
            },
          ],
          lanes: [
            {
              agentId: 'agent-backend',
              assignment: 'Scan backend.',
              attempt: 1,
              completedAt: now + 1,
              createdAt: now,
              id: 'lane-backend',
              name: 'Backend',
              resultId: 'result-backend',
              role: 'map',
              stageId: 'scan',
              status: 'completed',
              taskId: 'task-backend',
              updatedAt: now + 1,
            },
            {
              agentId: 'agent-ui',
              assignment: 'Scan UI.',
              attempt: 1,
              completedAt: now + 2,
              createdAt: now,
              id: 'lane-ui',
              name: 'UI',
              resultId: 'result-ui',
              role: 'map',
              stageId: 'scan',
              status: 'completed',
              taskId: 'task-ui',
              updatedAt: now + 2,
            },
            {
              agentId: 'agent-docs',
              assignment: 'Scan docs.',
              attempt: 1,
              createdAt: now,
              id: 'lane-docs',
              name: 'Docs',
              role: 'map',
              stageId: 'scan',
              status: 'waiting-for-result',
              taskId: 'task-docs',
              updatedAt: now + 2,
            },
            {
              agentId: 'agent-synthesize',
              assignment: 'Synthesize findings.',
              attempt: 1,
              createdAt: now + 3,
              id: 'lane-synthesize',
              name: 'Synthesize',
              role: 'reduce',
              stageId: 'synthesize',
              status: 'waiting-for-result',
              taskId: 'task-synthesize',
              updatedAt: now + 3,
            },
          ],
          results: [
            {
              agentId: 'agent-backend',
              commandsRun: [],
              createdAt: now + 1,
              evidence: [],
              findings: [{ summary: 'Backend issue' }],
              id: 'result-backend',
              laneId: 'lane-backend',
              risks: [],
              runId: 'run-1',
              stageId: 'scan',
              status: 'completed',
              summary: 'Backend scan complete.',
              taskId: 'task-backend',
              workflowId: 'workflow-1',
            },
            {
              agentId: 'agent-ui',
              commandsRun: [],
              createdAt: now + 2,
              evidence: [],
              findings: [{ summary: 'UI issue' }],
              id: 'result-ui',
              laneId: 'lane-ui',
              risks: [],
              runId: 'run-1',
              stageId: 'scan',
              status: 'completed',
              summary: 'UI scan complete.',
              taskId: 'task-ui',
              workflowId: 'workflow-1',
            },
          ],
        }),
      ],
    });

    const [workflow] = createCoordinatorRunView(run).workflows;

    expect(workflow).toMatchObject({
      branchIterationCount: 1,
      dependencySatisfiedStageCount: 1,
    });
    expect(workflow?.stages[0]).toMatchObject({
      dependencySatisfied: true,
      dependencyStatusLabel: 'Downstream unblocked',
      joinLabel: 'Join quorum 2',
      name: 'Scan',
    });
  });

  it('projects appended workflow steps and append activity', () => {
    const run = createRun({
      workflows: [
        createWorkflow({
          journal: [
            {
              at: now + 1,
              kind: 'workflow-steps-appended',
              laneId: 'lane-map',
              message: 'Appended 1 workflow step: followup.',
              seq: 1,
            },
          ],
          sourceSpec: {
            steps: [
              {
                dependsOn: [],
                id: 'map',
                kind: 'worker',
                lanes: [],
                name: 'Map',
                resultSourceStepIds: [],
                sourceStepIds: [],
                verifiers: [],
              },
              {
                dependsOn: ['map'],
                id: 'followup',
                kind: 'worker',
                lanes: [],
                name: 'Followup',
                resultSourceStepIds: [],
                sourceStepIds: [],
                verifiers: [],
              },
            ],
            version: 2,
          },
          stepAppends: [
            {
              appendId: 'append-followup',
              createdAt: now + 1,
              payloadHash: 'hash',
              sourceLaneId: 'lane-map',
              sourceTaskId: 'task-map',
              stepIds: ['followup'],
            },
          ],
        }),
      ],
    });

    const [workflow] = createCoordinatorRunView(run).workflows;

    expect(workflow).toMatchObject({
      appendCount: 1,
      stepCount: 2,
    });
    expect(workflow?.activityPreview[0]).toMatchObject({
      kind: 'workflow-steps-appended',
      laneLabel: 'Backend',
      message: 'Appended 1 workflow step: followup.',
      tone: 'info',
    });
  });

  it('projects the workflow execution budget with derived pressure', () => {
    const baseExecution = {
      activeLaneCount: 1,
      lastTickAt: now,
      pendingRetryLaneIds: [],
      readyStageIds: [],
    };
    const okRun = createRun({
      workflows: [
        createWorkflow({
          execution: {
            ...baseExecution,
            budget: {
              deadlineAt: now + 3_600_000,
              lanes: { limit: 12, used: 2 },
              retries: { limit: 8, used: 0 },
              steps: { limit: 24, used: 2 },
            },
            deadlineAt: now + 3_600_000,
          },
        }),
      ],
    });
    const [okWorkflow] = createCoordinatorRunView(okRun).workflows;
    expect(okWorkflow?.budget).toEqual({
      deadlineAt: now + 3_600_000,
      lanes: { limit: 12, used: 2 },
      pressure: 'ok',
      retries: { limit: 8, used: 0 },
      steps: { limit: 24, used: 2 },
    });

    const highRun = createRun({
      workflows: [
        createWorkflow({
          execution: {
            ...baseExecution,
            budget: {
              deadlineAt: now + 3_600_000,
              lanes: { limit: 10, used: 8 },
              retries: { limit: 8, used: 0 },
              steps: { limit: 24, used: 2 },
            },
          },
        }),
      ],
    });
    expect(createCoordinatorRunView(highRun).workflows[0]?.budget?.pressure).toBe('high');

    const exhaustedRun = createRun({
      workflows: [
        createWorkflow({
          execution: {
            ...baseExecution,
            budget: {
              deadlineAt: now + 3_600_000,
              exhausted: 'wall-clock',
              lanes: { limit: 12, used: 2 },
              retries: { limit: 8, used: 0 },
              steps: { limit: 24, used: 2 },
            },
          },
          status: 'blocked',
        }),
      ],
    });
    expect(createCoordinatorRunView(exhaustedRun).workflows[0]?.budget).toMatchObject({
      exhaustedLabel: 'wall-clock',
      pressure: 'exhausted',
    });

    const legacyRun = createRun({
      workflows: [createWorkflow({ execution: baseExecution })],
    });
    expect(createCoordinatorRunView(legacyRun).workflows[0]?.budget).toBeUndefined();
  });

  it('maps workflow-budget-exhausted journal entries to danger tone by exact kind', () => {
    const run = createRun({
      workflows: [
        createWorkflow({
          journal: [
            {
              at: now + 1,
              kind: 'workflow-budget-exhausted',
              message: 'Budget exhausted: wall-clock (60000/60000).',
              seq: 1,
            },
          ],
        }),
      ],
    });

    const [workflow] = createCoordinatorRunView(run).workflows;
    expect(workflow?.activityPreview[0]).toMatchObject({
      kind: 'workflow-budget-exhausted',
      tone: 'danger',
    });
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
