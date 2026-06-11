import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordinatorRunSnapshot } from '../domain/coordinator';

const { callCoordinatorUiToolMock, coordinatorRunRef } = vi.hoisted(() => ({
  callCoordinatorUiToolMock: vi.fn(),
  coordinatorRunRef: { current: null as CoordinatorRunSnapshot | null },
}));

vi.mock('./coordinator', () => ({
  callCoordinatorUiTool: callCoordinatorUiToolMock,
}));

vi.mock('../store/coordinator', () => ({
  getCoordinatorRunForTask: vi.fn(() => coordinatorRunRef.current),
}));

import { runCoordinatorOperatorAction } from './coordinator-operator-actions';

function createRun(): CoordinatorRunSnapshot {
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
    updatedAt: 1_200,
    workflows: [],
  };
}

describe('coordinator-operator-actions', () => {
  beforeEach(() => {
    coordinatorRunRef.current = createRun();
    callCoordinatorUiToolMock.mockReset();
    callCoordinatorUiToolMock.mockResolvedValue({
      accepted: true,
      callId: 'request-1',
      result: null,
    });
  });

  it('sends the run-scoped request shape for payload-free operator tools', async () => {
    const result = await runCoordinatorOperatorAction({
      request: { toolName: 'resume_run' },
      taskId: 'task-coordinator',
    });

    expect(result).toEqual({ accepted: true });
    expect(callCoordinatorUiToolMock).toHaveBeenCalledWith({
      controllerId: expect.any(String),
      coordinatorTaskId: 'task-coordinator',
      requestId: expect.any(String),
      runId: 'run-1',
      toolName: 'resume_run',
    });
  });

  it('carries the payload for payload-bearing operator tools', async () => {
    await runCoordinatorOperatorAction({
      request: {
        payload: { approvalId: 'approval-1', workflowId: 'workflow-1' },
        toolName: 'approve_workflow_actions',
      },
      taskId: 'task-coordinator',
    });

    expect(callCoordinatorUiToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { approvalId: 'approval-1', workflowId: 'workflow-1' },
        toolName: 'approve_workflow_actions',
      }),
    );
  });

  it('maps rejected responses to a message without throwing', async () => {
    callCoordinatorUiToolMock.mockResolvedValue({
      accepted: false,
      callId: 'request-1',
      error: 'Coordinator task command lease is required',
    });

    const result = await runCoordinatorOperatorAction({
      request: { toolName: 'pause_run' },
      taskId: 'task-coordinator',
    });

    expect(result).toEqual({
      accepted: false,
      message: 'Coordinator task command lease is required',
    });
  });

  it('maps rejections without an error string to a generic message', async () => {
    callCoordinatorUiToolMock.mockResolvedValue({ accepted: false, callId: 'request-1' });

    const result = await runCoordinatorOperatorAction({
      request: { toolName: 'unpause_run' },
      taskId: 'task-coordinator',
    });

    expect(result).toEqual({ accepted: false, message: 'Coordinator action was rejected.' });
  });

  it('maps transport failures to the thrown message', async () => {
    callCoordinatorUiToolMock.mockRejectedValue(new Error('Network unavailable'));

    const result = await runCoordinatorOperatorAction({
      request: { toolName: 'resume_run' },
      taskId: 'task-coordinator',
    });

    expect(result).toEqual({ accepted: false, message: 'Network unavailable' });
  });

  it('rejects without calling the gateway when no run is loaded for the task', async () => {
    coordinatorRunRef.current = null;

    const result = await runCoordinatorOperatorAction({
      request: { toolName: 'resume_run' },
      taskId: 'task-without-run',
    });

    expect(result).toEqual({
      accepted: false,
      message: 'No coordinator run is loaded for this task.',
    });
    expect(callCoordinatorUiToolMock).not.toHaveBeenCalled();
  });
});
