import { render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';

import type { Task } from '../../store/types';
import { resetStoreForTest } from '../../test/store-test-helpers';
import {
  applyTaskStepsEvent,
  getTaskStepsSnapshot,
  setTaskStepsSnapshot,
} from '../../store/task-steps';
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
    fetchTaskStepsSnapshotForTaskMock.mockReset();
    resetStoreForTest();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces snapshot load failures instead of leaking an unhandled rejection', async () => {
    fetchTaskStepsSnapshotForTaskMock
      .mockRejectedValueOnce(new Error('steps backend unavailable'))
      .mockImplementation(() => new Promise<void>(() => {}));

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
    expect(fetchTaskStepsSnapshotForTaskMock).toHaveBeenCalledTimes(1);
  });

  it('fetches a newer revision observed in flight exactly once after the current request settles', async () => {
    const summary = (revision: number) => ({
      errorMessage: null,
      latestStep: null,
      nextAction: null,
      preview: null,
      revisionId: String(revision),
      state: 'waiting' as const,
      stepCount: 0,
      taskId: 'task-1',
      trackingEnabled: true,
      updatedAt: revision,
    });
    const snapshot = (revision: number) => ({ ...summary(revision), steps: [] });
    applyTaskStepsEvent(summary(1));
    let finishFirst!: () => void;
    fetchTaskStepsSnapshotForTaskMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = () => {
              setTaskStepsSnapshot(snapshot(1));
              resolve();
            };
          }),
      )
      .mockImplementationOnce(async () => {
        setTaskStepsSnapshot(snapshot(2));
      });
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
    expect(fetchTaskStepsSnapshotForTaskMock).toHaveBeenCalledTimes(1);
    applyTaskStepsEvent(summary(2));
    expect(fetchTaskStepsSnapshotForTaskMock).toHaveBeenCalledTimes(1);
    finishFirst();
    await waitFor(() => expect(getTaskStepsSnapshot('task-1')?.revisionId).toBe('2'));
    expect(fetchTaskStepsSnapshotForTaskMock).toHaveBeenCalledTimes(2);
  });

  it.each([null, 'steps'])(
    'allows a failed revision to be requested again on return with panel %s',
    async (focusedPanel) => {
      fetchTaskStepsSnapshotForTaskMock.mockRejectedValue(new Error('steps unavailable'));
      const [active, setActive] = createSignal(true);
      render(() => {
        const controller = createTaskPanelStepsController({
          focusedPanel: () => focusedPanel,
          isActive: active,
          onDiffFileClick: vi.fn(),
          setTaskFocusedPanel: vi.fn(),
          task: createTask,
        });
        return controller.stepsSection()?.content();
      });
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toContain('steps unavailable'),
      );
      expect(fetchTaskStepsSnapshotForTaskMock).toHaveBeenCalledTimes(1);
      setActive(false);
      setActive(true);
      await waitFor(() => expect(fetchTaskStepsSnapshotForTaskMock).toHaveBeenCalledTimes(2));
    },
  );
});
