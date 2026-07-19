import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../lib/ipc.js', () => ({
  invoke: invokeMock,
}));

import { setStore, store } from '../store/core.js';
import { resetStoreForTest } from '../test/store-test-helpers.js';
import {
  TASK_STEPS_INSTRUCTION,
  buildTaskStepsPrompt,
  fetchTaskStepsSnapshotForTask,
  jumpToTaskStepTarget,
  prefillTaskStepNextAction,
  prepareTaskPromptText,
} from './task-steps.js';

describe('task steps workflow helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
  });

  it('injects the steps instruction only for the first prompt on tracked tasks', () => {
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        taskMode: 'agent',
        name: 'Tracked task',
        projectId: 'project-1',
        branchName: 'task/tracked',
        worktreePath: '/tmp/task-1',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        stepsTracking: true,
      },
      'task-2': {
        id: 'task-2',
        taskMode: 'agent',
        name: 'Existing prompt task',
        projectId: 'project-1',
        branchName: 'task/existing',
        worktreePath: '/tmp/task-2',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: 'already prompted',
        stepsTracking: true,
      },
    });

    expect(prepareTaskPromptText('task-1', 'Implement the feature')).toContain(
      TASK_STEPS_INSTRUCTION,
    );
    expect(prepareTaskPromptText('task-2', 'Implement the feature')).toBe('Implement the feature');
    expect(buildTaskStepsPrompt('Implement the feature')).toContain(TASK_STEPS_INSTRUCTION);
  });

  it('stores fetched snapshots in the shared steps projection', async () => {
    invokeMock.mockResolvedValue({
      errorMessage: null,
      revisionId: 'task-1::1',
      state: 'active',
      steps: [
        {
          summary: 'Investigating the regression',
          status: 'investigating',
          timestamp: '2026-04-17T10:00:00.000Z',
        },
      ],
      taskId: 'task-1',
      trackingEnabled: true,
      updatedAt: 1_000,
    });

    const snapshot = await fetchTaskStepsSnapshotForTask('task-1');

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(snapshot).toEqual(store.taskSteps['task-1']);
  });

  it('prefills next actions and focuses the prompt panel', () => {
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        taskMode: 'agent',
        name: 'Tracked task',
        projectId: 'project-1',
        branchName: 'task/tracked',
        worktreePath: '/tmp/task-1',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });

    prefillTaskStepNextAction('task-1', 'Review the diff and send the next prompt');
    expect(store.tasks['task-1']?.prefillPrompt).toBe('Review the diff and send the next prompt');
    expect(store.focusedPanel['task-1']).toBe('prompt');

    prefillTaskStepNextAction('task-1', '   ');
    expect(store.tasks['task-1']?.prefillPrompt).toBeUndefined();
  });

  it('keeps terminal-task next actions on a real shell surface without hidden prompt state', () => {
    setStore('tasks', {
      'task-terminal': {
        id: 'task-terminal',
        taskMode: 'terminal',
        name: 'Terminal task',
        projectId: 'project-1',
        branchName: 'task/terminal',
        worktreePath: '/tmp/task-terminal',
        agentIds: [],
        shellAgentIds: ['shell-1'],
        notes: '',
        lastPrompt: '',
        prefillPrompt: 'stale prompt',
      },
    });

    prefillTaskStepNextAction('task-terminal', 'Run the verification command');

    expect(store.tasks['task-terminal']?.prefillPrompt).toBeUndefined();
    expect(store.focusedPanel['task-terminal']).toBe('shell:0');
  });

  it('jumps to the best available task surface for the current task', () => {
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        taskMode: 'agent',
        name: 'Agent task',
        projectId: 'project-1',
        branchName: 'task/agent',
        worktreePath: '/tmp/task-1',
        agentIds: ['agent-1'],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
      'task-2': {
        id: 'task-2',
        taskMode: 'agent',
        name: 'Shell task',
        projectId: 'project-1',
        branchName: 'task/shell',
        worktreePath: '/tmp/task-2',
        agentIds: [],
        shellAgentIds: ['shell-1'],
        notes: '',
        lastPrompt: '',
      },
      'task-3': {
        id: 'task-3',
        taskMode: 'agent',
        name: 'Prompt task',
        projectId: 'project-1',
        branchName: 'task/prompt',
        worktreePath: '/tmp/task-3',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
      'task-4': {
        id: 'task-4',
        taskMode: 'terminal',
        name: 'Empty terminal task',
        projectId: 'project-1',
        branchName: 'task/terminal',
        worktreePath: '/tmp/task-4',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });

    const step = {
      summary: 'Waiting',
      status: 'awaiting_review' as const,
      timestamp: '2026-04-17T10:00:00.000Z',
    };

    jumpToTaskStepTarget('task-1', step);
    expect(store.focusedPanel['task-1']).toBe('ai-terminal');

    jumpToTaskStepTarget('task-2', step);
    expect(store.focusedPanel['task-2']).toBe('shell:0');

    jumpToTaskStepTarget('task-3', step);
    expect(store.focusedPanel['task-3']).toBe('prompt');

    jumpToTaskStepTarget('task-4', step);
    expect(store.focusedPanel['task-4']).toBe('shell-toolbar:0');
  });
});
