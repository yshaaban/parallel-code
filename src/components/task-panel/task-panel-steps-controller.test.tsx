import { render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../store/types';
import { resetStoreForTest } from '../../test/store-test-helpers';
import { createTaskPanelStepsController } from './task-panel-steps-controller';

const { fetchTaskStepsSnapshotForTaskMock } = vi.hoisted(() => ({
  fetchTaskStepsSnapshotForTaskMock: vi.fn(),
}));

vi.mock('../../app/task-steps', () => ({
  fetchTaskStepsSnapshotForTask: fetchTaskStepsSnapshotForTaskMock,
  jumpToTaskStepTarget: vi.fn(),
  prefillTaskStepNextAction: vi.fn(),
}));

function createTask(): Task {
  return {
    agentIds: [],
    branchName: 'task/steps',
    id: 'task-1',
    taskMode: 'agent',
    lastPrompt: '',
    name: 'Tracked task',
    notes: '',
    projectId: 'project-1',
    shellAgentIds: [],
    stepsTracking: true,
    worktreePath: '/tmp/task-1',
  };
}

describe('createTaskPanelStepsController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces snapshot load failures instead of leaking an unhandled rejection', async () => {
    fetchTaskStepsSnapshotForTaskMock.mockRejectedValue(new Error('steps backend unavailable'));

    render(() => {
      const controller = createTaskPanelStepsController({
        focusedPanel: () => null,
        isActive: () => true,
        onDiffFileClick: vi.fn(),
        setTaskFocusedPanel: vi.fn(),
        task: createTask,
      });
      return controller.stepsSection()?.content();
    });

    await waitFor(() => {
      expect(fetchTaskStepsSnapshotForTaskMock).toHaveBeenCalledWith('task-1');
      expect(screen.getByRole('status').textContent).toContain('steps backend unavailable');
    });
  });
});
