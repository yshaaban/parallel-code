import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { type JSX } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordinatorRunSnapshot } from '../../domain/coordinator';
import type { Task } from '../../store/types';

const { callCoordinatorUiToolMock, coordinatorRunRef, coordinatorRunReactivity } = vi.hoisted(
  () => ({
    callCoordinatorUiToolMock: vi.fn(),
    coordinatorRunRef: {
      current: null as CoordinatorRunSnapshot | null,
    },
    coordinatorRunReactivity: {
      bump: () => {},
    },
  }),
);

vi.mock('../../app/coordinator', () => ({
  callCoordinatorUiTool: callCoordinatorUiToolMock,
}));

vi.mock('../../store/coordinator', async () => {
  const { createSignal } = await import('solid-js');
  const [runVersion, setRunVersion] = createSignal(0);
  coordinatorRunReactivity.bump = () => setRunVersion((version) => version + 1);
  return {
    getCoordinatorRunForTask: vi.fn(() => {
      runVersion();
      return coordinatorRunRef.current;
    }),
  };
});

vi.mock('../ScalablePanel', () => ({
  ScalablePanel: (props: { children: JSX.Element }) => <div>{props.children}</div>,
}));

import { TaskCoordinatorSection } from './TaskCoordinatorSection';

function createRun(overrides: Partial<CoordinatorRunSnapshot> = {}): CoordinatorRunSnapshot {
  return {
    coordinatorTaskId: 'task-coordinator',
    createdAt: 1_000,
    eventVersion: 1,
    id: 'run-1',
    landing: overrides.landing ?? [],
    limits: {
      maxActiveSubtasks: 5,
      maxPendingPromptsPerTarget: 3,
      maxQueuedSubtasks: 20,
      ...overrides.limits,
    },
    projectId: 'project-1',
    projectMode: overrides.projectMode ?? 'git',
    projectRoot: '/repo',
    promptQueue: overrides.promptQueue ?? [
      {
        attempts: 0,
        createdAt: 1_100,
        dedupeKey: 'prompt-1',
        deliveryJournal: [],
        earliestDeliveryAt: 1_100,
        kind: 'follow-up',
        requestId: 'prompt-1',
        runId: 'run-1',
        sourceTaskId: 'task-coordinator',
        status: 'queued',
        targetAgentId: 'agent-child',
        targetTaskId: 'task-child',
        text: 'Continue',
      },
    ],
    status: overrides.status ?? 'running',
    subtasks: overrides.subtasks ?? [
      {
        agentId: 'agent-child',
        assignment: 'Fix parser behavior',
        branchName: 'task/parser',
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
        updatedAt: 1_100,
        worktreePath: '/repo/.worktrees/task-child',
      },
    ],
    updatedAt: overrides.updatedAt ?? 1_200,
    workflows: overrides.workflows ?? [],
  };
}

function createOperatorWorkflow(): NonNullable<CoordinatorRunSnapshot['workflows']>[number] {
  return {
    appendPolicy: {
      maxActionsPerDecision: 8,
      maxStepAppends: 24,
    },
    createdAt: 1_000,
    eventVersion: 2,
    id: 'workflow-1',
    journal: [],
    lanes: [
      {
        agentId: 'agent-scan',
        assignment: 'Scan the backend.',
        attempt: 1,
        createdAt: 1_000,
        dedupeKey: 'lane-failed',
        failure: 'agent crashed',
        id: 'lane-failed',
        name: 'Scan',
        stageId: 'scan',
        status: 'failed',
        updatedAt: 1_100,
      },
      {
        agentId: 'agent-decide',
        assignment: 'Decide next steps.',
        attempt: 1,
        createdAt: 1_000,
        id: 'lane-decide',
        name: 'Decide',
        stageId: 'decide',
        status: 'waiting-for-result',
        taskId: 'task-decide',
        updatedAt: 1_100,
      },
    ],
    pendingApprovals: [
      {
        actions: [
          {
            kind: 'append_worker',
            step: {
              assignment: 'Follow up.',
              dependsOn: ['decide'],
              id: 'followup',
              kind: 'worker',
              lanes: [{ assignment: 'Follow up.', id: 'followup-lane', name: 'Followup' }],
              name: 'Followup',
              resultSourceStepIds: [],
              sourceStepIds: [],
              verifiers: [],
            },
          },
        ],
        createdAt: 1_100,
        id: 'result-1:approval',
        laneId: 'lane-decide',
        resultId: 'result-1',
        stageId: 'decide',
        status: 'pending',
      },
    ],
    policy: {
      continueOnFailure: true,
      maxConcurrentLanes: 3,
      maxIterationsPerBranch: 3,
      maxOutputBytesPerLane: 65_536,
      requireDecisionApproval: true,
      resultRequired: true,
      retryBackoffMs: 1_000,
      retryCount: 0,
      timeoutMs: 900_000,
    },
    programVersion: 2,
    results: [],
    runId: 'run-1',
    stages: [
      {
        createdAt: 1_000,
        dependsOn: [],
        id: 'scan',
        kind: 'fan-out',
        laneIds: ['lane-failed'],
        name: 'Scan',
        resultIds: [],
        status: 'waiting-for-results',
        updatedAt: 1_100,
      },
      {
        createdAt: 1_000,
        dependsOn: ['scan'],
        id: 'decide',
        kind: 'decision',
        laneIds: ['lane-decide'],
        name: 'Decide',
        resultIds: ['result-1'],
        status: 'waiting-for-results',
        updatedAt: 1_100,
      },
    ],
    startedAt: 1_000,
    status: 'waiting-for-results',
    template: 'custom',
    title: 'Gated review',
    updatedAt: 1_100,
  };
}

function createTask(): Task {
  return {
    agentIds: ['agent-coordinator'],
    branchName: 'task/coordinator',
    coordinatorRole: 'coordinator',
    coordinatorRunId: 'run-1',
    coordinatorToolCommand: 'node scripts/coordinator-tool.mjs',
    id: 'task-coordinator',
    lastPrompt: '',
    name: 'Coordinator task',
    notes: '',
    projectId: 'project-1',
    shellAgentIds: [],
    worktreePath: '/repo/.worktrees/task-coordinator',
  };
}

function openSpawnForm(): void {
  fireEvent.click(screen.getByLabelText('Spawn coordinator subtask'));
}

function fillSpawnForm(
  options: { assignment?: string; command?: string; name?: string } = {},
): void {
  fireEvent.input(screen.getByLabelText('Subtask name'), {
    target: { value: options.name ?? 'Parser fix' },
  });
  fireEvent.input(screen.getByLabelText('Subtask command'), {
    target: { value: options.command ?? 'codex' },
  });
  fireEvent.input(screen.getByLabelText('Subtask assignment'), {
    target: { value: options.assignment ?? 'Fix parser edge cases.' },
  });
}

describe('TaskCoordinatorSection', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    coordinatorRunRef.current = createRun();
    callCoordinatorUiToolMock.mockReset();
    callCoordinatorUiToolMock.mockResolvedValue({
      accepted: true,
      callId: 'request-1',
      result: null,
    });
  });

  it('renders a compact run summary and subtask chip', () => {
    render(() => <TaskCoordinatorSection task={() => createTask()} />);

    expect(screen.getByText('RUN')).toBeDefined();
    expect(screen.getByText('1/5')).toBeDefined();
    expect(screen.getByText('Q1')).toBeDefined();
    expect(screen.getByLabelText('Open Fix parser behavior')).toBeDefined();
  });

  it('shows seeded startup details and disables follow-up input when prompts are disallowed', () => {
    coordinatorRunRef.current = createRun({
      promptQueue: [],
      subtasks: [
        {
          agentId: 'agent-child',
          assignment: 'Run a one-shot audit',
          createdAt: 1_000,
          parentCoordinatorTaskId: 'task-coordinator',
          startup: {
            followupPromptMode: 'disallow',
            initialAssignmentMode: 'spawn-seeded-interactive',
            initialAssignmentStatus: 'seeded-at-spawn',
            readinessPolicy: 'codex',
            seededAt: 1_000,
          },
          status: 'running',
          taskId: 'task-child',
          toolTokenId: 'token-child',
          updatedAt: 1_100,
          worktreePath: '/repo/.worktrees/task-child',
        },
      ],
    });

    render(() => <TaskCoordinatorSection task={() => createTask()} />);
    fireEvent.click(screen.getByLabelText('Open Run a one-shot audit'));
    fireEvent.click(screen.getByText('Meta'));

    expect(screen.getByText('Initial assignment seeded at spawn')).toBeDefined();
    expect(screen.getByText('Follow-up prompts disabled')).toBeDefined();
    expect(screen.getByText('Codex readiness detection')).toBeDefined();
    expect(screen.getByLabelText('Follow-up prompt')).toHaveProperty('disabled', true);
    expect(screen.getByText('Ask to land')).toHaveProperty('disabled', true);
  });

  it('renders a compact workflow timeline when workflow snapshots exist', () => {
    coordinatorRunRef.current = createRun({
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
              at: 1_100,
              kind: 'lane-result',
              laneId: 'lane-map',
              message: 'Mapped risk.',
              resultId: 'result-1',
              seq: 1,
              stageId: 'map',
            },
          ],
          lanes: [
            {
              agentId: 'agent-map',
              assignment: 'Map backend risks.',
              attempt: 1,
              createdAt: 1_000,
              id: 'lane-map',
              name: 'Backend',
              role: 'map',
              stageId: 'map',
              status: 'waiting-for-result',
              taskId: 'task-map',
              updatedAt: 1_000,
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
              agentId: 'agent-map',
              commandsRun: [],
              createdAt: 1_100,
              evidence: [],
              findings: [{ severity: 'major', status: 'confirmed', summary: 'Risk found' }],
              id: 'result-1',
              laneId: 'lane-map',
              risks: [],
              runId: 'run-1',
              stageId: 'map',
              status: 'completed',
              summary: 'Mapped risk.',
              taskId: 'task-map',
              workflowId: 'workflow-1',
            },
          ],
          programVersion: 2,
          runId: 'run-1',
          stages: [
            {
              createdAt: 1_000,
              dependsOn: [],
              id: 'map',
              kind: 'map',
              laneIds: ['lane-map'],
              name: 'Map',
              resultIds: ['result-1'],
              status: 'waiting-for-results',
              updatedAt: 1_100,
            },
            {
              createdAt: 1_000,
              dependsOn: ['map'],
              id: 'reduce',
              kind: 'reduce',
              laneIds: [],
              name: 'Reduce',
              resultIds: [],
              status: 'pending',
              updatedAt: 1_000,
            },
          ],
          startedAt: 1_000,
          status: 'waiting-for-results',
          template: 'map_reduce',
          title: 'Latency review',
          updatedAt: 1_100,
          verdicts: [
            {
              createdAt: 1_120,
              findingId: 'finding-1',
              id: 'verdict-1',
              reason: 'Evidence matched.',
              resultId: 'result-1',
              status: 'confirmed',
              verifierLaneId: 'lane-map',
            },
          ],
        },
      ],
    });

    render(() => <TaskCoordinatorSection task={() => createTask()} />);

    expect(screen.getByLabelText('Coordinator workflows')).toBeDefined();
    expect(screen.getByText('Map')).toBeDefined();
    expect(screen.getByText('!1')).toBeDefined();

    fireEvent.click(screen.getByLabelText('Open workflow Latency review'));

    expect(screen.getByText('Activity')).toBeDefined();
    expect(screen.getByText('Results')).toBeDefined();
    expect(screen.getAllByText(/Join all/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Mapped risk.').length).toBeGreaterThan(0);
    expect(screen.getByText(/Risk found/)).toBeDefined();
    expect(callCoordinatorUiToolMock).not.toHaveBeenCalled();
  });

  it('renders the workflow budget counters line in the drilldown', () => {
    coordinatorRunRef.current = createRun({
      workflows: [
        {
          appendPolicy: {
            maxActionsPerDecision: 8,
            maxStepAppends: 24,
          },
          createdAt: 1_000,
          eventVersion: 2,
          execution: {
            activeLaneCount: 0,
            blockedReason: 'budget-exhausted: wall-clock (60000/60000)',
            budget: {
              deadlineAt: 61_000,
              exhausted: 'wall-clock',
              lanes: { limit: 12, used: 1 },
              retries: { limit: 8, used: 0 },
              steps: { limit: 24, used: 1 },
            },
            deadlineAt: 61_000,
            lastTickAt: 61_001,
            pendingRetryLaneIds: [],
            readyStageIds: [],
          },
          id: 'workflow-budget',
          journal: [
            {
              at: 61_001,
              kind: 'workflow-budget-exhausted',
              message: 'Budget exhausted: wall-clock (60000/60000).',
              seq: 1,
            },
          ],
          lanes: [
            {
              agentId: 'agent-map',
              assignment: 'Map backend risks.',
              attempt: 1,
              createdAt: 1_000,
              failure: 'budget-exhausted: wall-clock (60000/60000)',
              id: 'lane-map',
              name: 'Backend',
              role: 'map',
              stageId: 'map',
              status: 'cancelled',
              taskId: 'task-map',
              updatedAt: 61_001,
            },
          ],
          policy: {
            continueOnFailure: true,
            maxConcurrentLanes: 3,
            maxIterationsPerBranch: 3,
            maxOutputBytesPerLane: 65_536,
            maxWallClockMs: 60_000,
            resultRequired: true,
            retryBackoffMs: 1_000,
            retryCount: 0,
            timeoutMs: 900_000,
          },
          programVersion: 2,
          results: [],
          runId: 'run-1',
          stages: [
            {
              createdAt: 1_000,
              dependsOn: [],
              id: 'map',
              kind: 'map',
              laneIds: ['lane-map'],
              name: 'Map',
              resultIds: [],
              status: 'waiting-for-results',
              updatedAt: 61_001,
            },
          ],
          startedAt: 1_000,
          status: 'blocked',
          template: 'map_reduce',
          title: 'Budget review',
          updatedAt: 61_001,
        },
      ],
    });

    render(() => <TaskCoordinatorSection task={() => createTask()} />);

    fireEvent.click(screen.getByLabelText('Open workflow Budget review'));

    expect(screen.getByText('Budget · Steps 1/24 · Lanes 1/12 · Retries 0/8')).toBeDefined();
    expect(
      screen.getAllByText(/budget-exhausted: wall-clock \(60000\/60000\)/).length,
    ).toBeGreaterThan(0);
  });

  it('opens the peek lens and fetches output through the coordinator UI action channel', async () => {
    callCoordinatorUiToolMock.mockResolvedValueOnce({
      accepted: true,
      callId: 'request-1',
      result: {
        output: 'hello from hidden task',
        taskId: 'task-child',
        truncatedBytes: 0,
      },
    });
    render(() => <TaskCoordinatorSection task={() => createTask()} />);

    fireEvent.click(screen.getByLabelText('Open Fix parser behavior'));
    fireEvent.click(screen.getByText('Refresh output'));

    await screen.findByText('hello from hidden task');
    expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        controllerId: expect.any(String),
        coordinatorTaskId: 'task-coordinator',
        payload: {
          maxBytes: 12_000,
          targetTaskId: 'task-child',
        },
        runId: 'run-1',
        toolName: 'get_task_output',
      }),
    );
    expect(callCoordinatorUiToolMock.mock.calls[0]?.[0].requestId).toEqual(expect.any(String));
  });

  it('queues a follow-up prompt from the peek lens', async () => {
    render(() => <TaskCoordinatorSection task={() => createTask()} />);

    fireEvent.click(screen.getByLabelText('Open Fix parser behavior'));
    fireEvent.input(screen.getByLabelText('Follow-up prompt'), {
      target: { value: 'Please add a regression test.' },
    });
    fireEvent.click(screen.getByText('Send follow-up'));

    await screen.findByText('Prompt queued.');
    expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          kind: 'follow-up',
          targetTaskId: 'task-child',
          text: 'Please add a regression test.',
        },
        toolName: 'send_prompt',
      }),
    );
  });

  it('disables backend-targeted refresh controls for terminal subtasks', () => {
    coordinatorRunRef.current = createRun({
      subtasks: [
        {
          agentId: 'agent-child',
          assignment: 'Fix parser behavior',
          branchName: 'task/parser',
          createdAt: 1_000,
          parentCoordinatorTaskId: 'task-coordinator',
          startup: {
            followupPromptMode: 'post-ready-prompt',
            initialAssignmentMode: 'spawn-seeded-interactive',
            initialAssignmentStatus: 'seeded-at-spawn',
            readinessPolicy: 'codex',
            seededAt: 1_000,
          },
          status: 'failed',
          taskId: 'task-child',
          toolTokenId: 'token-child',
          updatedAt: 1_100,
          worktreePath: '/repo/.worktrees/task-child',
        },
      ],
    });
    render(() => <TaskCoordinatorSection task={() => createTask()} />);

    fireEvent.click(screen.getByLabelText('Open Fix parser behavior'));

    expect(screen.getByText('Refresh output')).toHaveProperty('disabled', true);
    expect(screen.queryByText('Inspect output')).toBeNull();
  });

  it('disables git-only peek and landing controls for non-git coordinator runs', () => {
    coordinatorRunRef.current = createRun({
      projectMode: 'non-git',
      subtasks: [
        {
          agentId: 'agent-child',
          assignment: 'Fix parser behavior',
          createdAt: 1_000,
          parentCoordinatorTaskId: 'task-coordinator',
          startup: {
            followupPromptMode: 'post-ready-prompt',
            initialAssignmentMode: 'spawn-seeded-interactive',
            initialAssignmentStatus: 'seeded-at-spawn',
            readinessPolicy: 'codex',
            seededAt: 1_000,
          },
          status: 'ready-for-review',
          taskId: 'task-child',
          toolTokenId: 'token-child',
          updatedAt: 1_100,
          worktreePath: '/repo',
        },
      ],
    });
    render(() => <TaskCoordinatorSection task={() => createTask()} />);

    fireEvent.click(screen.getByLabelText('Open Fix parser behavior'));
    const askToLand = screen.getByText('Ask to land');
    expect(askToLand).toHaveProperty('disabled', true);
    expect(askToLand).toHaveProperty('title', 'Landing requires a git-backed coordinator run.');

    fireEvent.click(screen.getByText('Diff'));
    const refreshDiff = screen.getByText('Refresh diff');
    expect(refreshDiff).toHaveProperty('disabled', true);
    expect(refreshDiff).toHaveProperty(
      'title',
      'Diff inspection requires a git-backed coordinator run.',
    );
  });

  it('copies the debug helper command from the overflow menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(() => <TaskCoordinatorSection task={() => createTask()} />);

    fireEvent.click(screen.getByLabelText('Coordinator debug actions'));
    fireEvent.click(screen.getByText('Copy list_tasks command'));

    await screen.findByText('Copied list_tasks command.');
    expect(writeText).toHaveBeenCalledWith('node scripts/coordinator-tool.mjs list_tasks');
  });

  it('spawns a subtask from the compact spawn slit', async () => {
    render(() => <TaskCoordinatorSection task={() => createTask()} />);

    openSpawnForm();
    fillSpawnForm();
    fireEvent.click(screen.getByText('Spawn'));

    await waitFor(() => {
      expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: {
            agent: { command: 'codex' },
            assignment: 'Fix parser edge cases.',
            name: 'Parser fix',
          },
          toolName: 'spawn_subtask',
        }),
      );
    });
  });

  it('spawns coordinator subtasks with parsed command args and environment', async () => {
    render(() => <TaskCoordinatorSection task={() => createTask()} />);

    openSpawnForm();
    fillSpawnForm({
      command: 'env FOO=1 codex --model "gpt-5.5 xhigh"',
    });
    fireEvent.click(screen.getByText('Spawn'));

    await waitFor(() => {
      expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: {
            agent: {
              args: ['--model', 'gpt-5.5 xhigh'],
              command: 'codex',
              env: { FOO: '1' },
            },
            assignment: 'Fix parser edge cases.',
            name: 'Parser fix',
          },
          toolName: 'spawn_subtask',
        }),
      );
    });
  });

  it('rejects invalid coordinator subtask command syntax before calling the gateway', async () => {
    render(() => <TaskCoordinatorSection task={() => createTask()} />);

    openSpawnForm();
    fillSpawnForm({
      command: 'codex "unterminated',
    });
    fireEvent.click(screen.getByText('Spawn'));

    await screen.findByText('Command has an unterminated quote or escape.');
    expect(callCoordinatorUiToolMock).not.toHaveBeenCalled();
  });

  it('resumes a stale run through the coordinator UI action channel', async () => {
    coordinatorRunRef.current = createRun({ status: 'stale-after-restore' });

    render(() => <TaskCoordinatorSection task={() => createTask()} />);
    fireEvent.click(screen.getByLabelText('Resume coordinator run'));

    await waitFor(() => {
      expect(callCoordinatorUiToolMock).toHaveBeenCalledWith({
        controllerId: expect.any(String),
        coordinatorTaskId: 'task-coordinator',
        requestId: expect.any(String),
        runId: 'run-1',
        toolName: 'resume_run',
      });
    });
  });

  it('hides the resume control for non-stale runs', () => {
    render(() => <TaskCoordinatorSection task={() => createTask()} />);

    expect(screen.queryByLabelText('Resume coordinator run')).toBeNull();
  });

  it('pauses and unpauses the run through the coordinator UI action channel', async () => {
    const firstRender = render(() => <TaskCoordinatorSection task={() => createTask()} />);
    fireEvent.click(screen.getByLabelText('Pause coordinator run'));

    await waitFor(() => {
      expect(callCoordinatorUiToolMock).toHaveBeenCalledWith({
        controllerId: expect.any(String),
        coordinatorTaskId: 'task-coordinator',
        requestId: expect.any(String),
        runId: 'run-1',
        toolName: 'pause_run',
      });
    });
    firstRender.unmount();

    coordinatorRunRef.current = createRun({ status: 'paused-by-user' });
    callCoordinatorUiToolMock.mockClear();
    render(() => <TaskCoordinatorSection task={() => createTask()} />);
    fireEvent.click(screen.getByLabelText('Unpause coordinator run'));

    await waitFor(() => {
      expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'unpause_run' }),
      );
    });
  });

  it('derives the click intent from the optimistic flip so an "Unpause" label never re-sends pause_run', async () => {
    render(() => <TaskCoordinatorSection task={() => createTask()} />);
    const pauseButton = screen.getByLabelText('Pause coordinator run');
    fireEvent.click(pauseButton);

    // Pause accepted (mock resolves accepted: true) but the updated run
    // snapshot has not landed yet: the flip keeps the label on "Unpause".
    await waitFor(() => {
      expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'pause_run' }),
      );
    });
    await waitFor(() => {
      expect(pauseButton).toHaveProperty('disabled', false);
    });
    expect(pauseButton.textContent).toContain('Unpause');

    // Clicking the "Unpause" label must send unpause_run, not pause_run again.
    callCoordinatorUiToolMock.mockClear();
    fireEvent.click(pauseButton);
    await waitFor(() => {
      expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'unpause_run' }),
      );
    });
    expect(callCoordinatorUiToolMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'pause_run' }),
    );
  });

  it('keeps the resume control disabled after an accepted resume until a newer snapshot lands', async () => {
    coordinatorRunRef.current = createRun({ status: 'stale-after-restore' });

    render(() => <TaskCoordinatorSection task={() => createTask()} />);
    const resumeButton = screen.getByLabelText('Resume coordinator run');
    fireEvent.click(resumeButton);

    await waitFor(() => {
      expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'resume_run' }),
      );
    });

    // Accepted but the updated run snapshot has not landed: a fast second
    // click must not send a duplicate resume_run.
    expect(resumeButton).toHaveProperty('disabled', true);
    callCoordinatorUiToolMock.mockClear();
    fireEvent.click(resumeButton);
    expect(callCoordinatorUiToolMock).not.toHaveBeenCalled();

    // A newer snapshot releases the guard (here the run is still stale, so
    // the control becomes actionable again instead of wedging).
    coordinatorRunRef.current = createRun({ status: 'stale-after-restore', updatedAt: 2_400 });
    coordinatorRunReactivity.bump();
    await waitFor(() => {
      expect(resumeButton).toHaveProperty('disabled', false);
    });
  });

  it('approves, denies, and retries through workflow drilldown operator controls', async () => {
    coordinatorRunRef.current = createRun({
      workflows: [createOperatorWorkflow()],
    });
    render(() => <TaskCoordinatorSection task={() => createTask()} />);
    fireEvent.click(screen.getByLabelText('Open workflow Gated review'));
    expect(screen.getByText('A1')).toBeDefined();
    expect(screen.getByText('Pending approvals')).toBeDefined();
    expect(screen.getByText('append_worker followup')).toBeDefined();

    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => {
      expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
        expect.objectContaining({
          controllerId: expect.any(String),
          payload: { approvalId: 'result-1:approval', workflowId: 'workflow-1' },
          toolName: 'approve_workflow_actions',
        }),
      );
    });

    callCoordinatorUiToolMock.mockClear();
    fireEvent.click(screen.getByText('Deny'));
    expect(callCoordinatorUiToolMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm deny'));
    await waitFor(() => {
      expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { approvalId: 'result-1:approval', workflowId: 'workflow-1' },
          toolName: 'deny_workflow_actions',
        }),
      );
    });

    callCoordinatorUiToolMock.mockClear();
    expect(screen.getByText('Failed lanes')).toBeDefined();
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => {
      expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { laneId: 'lane-failed', workflowId: 'workflow-1' },
          toolName: 'retry_lane',
        }),
      );
    });
  });

  it('surfaces operator action rejections through the action error line', async () => {
    coordinatorRunRef.current = createRun({
      workflows: [createOperatorWorkflow()],
    });
    callCoordinatorUiToolMock.mockResolvedValue({
      accepted: false,
      callId: 'request-1',
      error: 'Coordinator task command lease is required',
    });
    render(() => <TaskCoordinatorSection task={() => createTask()} />);
    fireEvent.click(screen.getByLabelText('Open workflow Gated review'));
    fireEvent.click(screen.getByText('Approve'));

    await screen.findByText('Coordinator task command lease is required');
  });

  it('renders a rejected resume as a full-width rail alert with the full message and a working Retry', async () => {
    coordinatorRunRef.current = createRun({ status: 'stale-after-restore' });
    const rejection =
      'Coordinator resume was rejected because the task command lease is held by another session.';
    callCoordinatorUiToolMock.mockResolvedValue({
      accepted: false,
      callId: 'request-1',
      error: rejection,
    });

    render(() => <TaskCoordinatorSection task={() => createTask()} />);
    fireEvent.click(screen.getByLabelText('Resume coordinator run'));

    await screen.findByText(rejection);
    const alert = document.querySelector('[data-coordinator-rail-alert="true"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.getAttribute('title')).toBe(rejection);

    callCoordinatorUiToolMock.mockClear();
    callCoordinatorUiToolMock.mockResolvedValue({
      accepted: true,
      callId: 'request-2',
      result: null,
    });
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => {
      expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'resume_run' }),
      );
    });
    await waitFor(() => {
      expect(document.querySelector('[data-coordinator-rail-alert="true"]')).toBeNull();
    });
  });

  it('dismisses the rail alert explicitly', async () => {
    coordinatorRunRef.current = createRun({ status: 'stale-after-restore' });
    callCoordinatorUiToolMock.mockResolvedValue({
      accepted: false,
      callId: 'request-1',
      error: 'Resume rejected.',
    });

    render(() => <TaskCoordinatorSection task={() => createTask()} />);
    fireEvent.click(screen.getByLabelText('Resume coordinator run'));
    await screen.findByText('Resume rejected.');

    fireEvent.click(screen.getByLabelText('Dismiss coordinator alert'));
    expect(document.querySelector('[data-coordinator-rail-alert="true"]')).toBeNull();
  });

  it('shows a busy spinner inside the resume button while the action is in flight', async () => {
    coordinatorRunRef.current = createRun({ status: 'stale-after-restore' });
    let resolveCall: (value: unknown) => void = () => {};
    callCoordinatorUiToolMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCall = resolve;
        }),
    );

    render(() => <TaskCoordinatorSection task={() => createTask()} />);
    const resumeButton = screen.getByLabelText('Resume coordinator run');
    fireEvent.click(resumeButton);

    expect(resumeButton.querySelector('.inline-spinner')).not.toBeNull();
    expect(resumeButton).toHaveProperty('disabled', true);

    resolveCall({ accepted: true, callId: 'request-1', result: null });
    await waitFor(() => {
      expect(resumeButton.querySelector('.inline-spinner')).toBeNull();
    });
  });

  it('flips the pause control optimistically and reverts with a rail alert on rejection', async () => {
    let rejectCall: (value: unknown) => void = () => {};
    callCoordinatorUiToolMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          rejectCall = resolve;
        }),
    );

    render(() => <TaskCoordinatorSection task={() => createTask()} />);
    const pauseButton = screen.getByLabelText('Pause coordinator run');
    expect(pauseButton.textContent).toContain('Pause');
    fireEvent.click(pauseButton);

    expect(pauseButton.textContent).toContain('Unpause');
    const syncing = document.querySelector('[data-coordinator-status-syncing="true"]');
    expect(syncing?.textContent).toBe('Paused');

    rejectCall({ accepted: false, callId: 'request-1', error: 'Pause rejected.' });
    await screen.findByText('Pause rejected.');
    expect(document.querySelector('[data-coordinator-status-syncing="true"]')).toBeNull();
    expect(screen.getByText('RUN')).toBeDefined();
    expect(pauseButton.textContent).not.toContain('Unpause');
  });

  it('clears the optimistic pause flip when a newer run snapshot lands', async () => {
    render(() => <TaskCoordinatorSection task={() => createTask()} />);
    fireEvent.click(screen.getByLabelText('Pause coordinator run'));

    await waitFor(() => {
      expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'pause_run' }),
      );
    });
    expect(document.querySelector('[data-coordinator-status-syncing="true"]')).not.toBeNull();

    coordinatorRunRef.current = createRun({ status: 'paused-by-user' });
    coordinatorRunReactivity.bump();

    await waitFor(() => {
      expect(document.querySelector('[data-coordinator-status-syncing="true"]')).toBeNull();
    });
    expect(screen.getByLabelText('Unpause coordinator run')).toBeDefined();
  });

  async function flushSpawnResolution(): Promise<void> {
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
  }

  it('keeps the spawn acknowledgment visible after the popover closes and expires it after 5s', async () => {
    vi.useFakeTimers();
    try {
      render(() => <TaskCoordinatorSection task={() => createTask()} />);
      openSpawnForm();
      fillSpawnForm();
      fireEvent.click(screen.getByText('Spawn'));
      await flushSpawnResolution();

      expect(screen.queryByLabelText('Subtask name')).toBeNull();
      const ack = document.querySelector('[data-coordinator-spawn-ack="true"]');
      expect(ack).not.toBeNull();
      expect(ack?.textContent).toContain('Parser fix');
      expect(ack?.textContent).toContain('queued');

      vi.advanceTimersByTime(4_999);
      expect(document.querySelector('[data-coordinator-spawn-ack="true"]')).not.toBeNull();

      vi.advanceTimersByTime(1);
      expect(document.querySelector('[data-coordinator-spawn-ack="true"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the spawn acknowledgment when the spawned subtask lands in a run snapshot', async () => {
    render(() => <TaskCoordinatorSection task={() => createTask()} />);
    openSpawnForm();
    fillSpawnForm();
    fireEvent.click(screen.getByText('Spawn'));
    await waitFor(() => {
      expect(document.querySelector('[data-coordinator-spawn-ack="true"]')).not.toBeNull();
    });

    const baseRun = createRun();
    coordinatorRunRef.current = createRun({
      subtasks: [
        ...baseRun.subtasks,
        {
          agentId: 'agent-spawned',
          assignment: 'Fix parser edge cases.',
          createdAt: 2_000,
          parentCoordinatorTaskId: 'task-coordinator',
          status: 'spawning',
          taskId: 'task-spawned',
          toolTokenId: 'token-spawned',
          updatedAt: 2_000,
          worktreePath: '/repo/.worktrees/task-spawned',
        },
      ],
    });
    coordinatorRunReactivity.bump();

    await waitFor(() => {
      expect(document.querySelector('[data-coordinator-spawn-ack="true"]')).toBeNull();
    });
  });
});
