import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { type JSX } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordinatorRunSnapshot } from '../../domain/coordinator';
import type { Task } from '../../store/types';

const { callCoordinatorUiToolMock, coordinatorRunRef } = vi.hoisted(() => ({
  callCoordinatorUiToolMock: vi.fn(),
  coordinatorRunRef: {
    current: null as CoordinatorRunSnapshot | null,
  },
}));

vi.mock('../../app/coordinator', () => ({
  callCoordinatorUiTool: callCoordinatorUiToolMock,
}));

vi.mock('../../store/coordinator', () => ({
  getCoordinatorRunForTask: vi.fn(() => coordinatorRunRef.current),
}));

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
    updatedAt: 1_200,
    workflows: overrides.workflows ?? [],
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
    expect(screen.getAllByText('Mapped risk.').length).toBeGreaterThan(0);
    expect(screen.getByText(/Risk found/)).toBeDefined();
    expect(callCoordinatorUiToolMock).not.toHaveBeenCalled();
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
});
