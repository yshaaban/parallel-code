import { createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTaskPanelPreviewController } from './task-panel-preview-controller';

vi.mock('./TaskPreviewSection', () => ({
  createTaskPreviewSection: vi.fn(() => ({
    content: () => null,
    id: 'preview',
    initialSize: 260,
    minSize: 120,
  })),
}));

function createControllerOptions(
  overrides: Partial<Parameters<typeof createTaskPanelPreviewController>[0]> = {},
) {
  return {
    applyTaskPortsEvent: vi.fn(),
    destroyTaskContainersForTask: vi.fn().mockResolvedValue({ status: 'ready' }),
    exposeTaskPortForTask: vi.fn().mockResolvedValue({
      exposed: [],
      observed: [],
      taskId: 'task-1',
      updatedAt: 0,
    }),
    fetchTaskContainerLogsForTask: vi.fn().mockResolvedValue({
      generatedAt: 0,
      taskId: 'task-1',
      text: '',
      truncated: false,
    }),
    fetchTaskPortExposureCandidates: vi.fn().mockResolvedValue([]),
    focusedPanel: () => null,
    getTaskPortSnapshot: vi.fn().mockReturnValue(undefined),
    inspectTaskContainerForTask: vi.fn().mockResolvedValue({
      composeFile: '/tmp/project/compose.yaml',
      issues: [],
      observedAt: 0,
      previews: [],
      projectName: 'parallel-project-task',
      publishedPorts: [],
      runtime: 'docker-compose',
      services: [],
      status: 'ready',
      taskId: 'task-1',
    }),
    isTaskPanelFocused: vi.fn().mockReturnValue(false),
    projectContainerConfig: () => undefined,
    projectPath: () => '/tmp/project',
    refreshTaskPreviewForTask: vi.fn().mockResolvedValue(undefined),
    setTaskFocusedPanel: vi.fn(),
    startTaskContainersForTask: vi.fn().mockResolvedValue({ status: 'running' }),
    stopTaskContainersForTask: vi.fn().mockResolvedValue({ status: 'ready' }),
    taskId: () => 'task-1',
    unexposeTaskPortForTask: vi.fn().mockResolvedValue(undefined),
    worktreePath: () => '/tmp/project/.worktrees/task-1',
    ...overrides,
  };
}

describe('createTaskPanelPreviewController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('inspects task containers when the preview opens without starting them', async () => {
    const options = createControllerOptions();

    createRoot((dispose) => {
      const controller = createTaskPanelPreviewController(options);
      controller.handlePreviewButtonClick();
      dispose();
    });

    await vi.runAllTimersAsync();

    expect(options.inspectTaskContainerForTask).toHaveBeenCalledTimes(1);
    expect(options.startTaskContainersForTask).not.toHaveBeenCalled();
    expect(options.setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'preview');
  });

  it('polls inspect only while the task container inspect state remains running', async () => {
    const inspectTaskContainerForTask = vi
      .fn()
      .mockResolvedValueOnce({
        composeFile: '/tmp/project/compose.yaml',
        issues: [],
        observedAt: 0,
        previews: [],
        projectName: 'parallel-project-task',
        publishedPorts: [],
        runtime: 'docker-compose',
        services: [],
        status: 'running',
        taskId: 'task-1',
      })
      .mockResolvedValueOnce({
        composeFile: '/tmp/project/compose.yaml',
        issues: [],
        observedAt: 1,
        previews: [],
        projectName: 'parallel-project-task',
        publishedPorts: [],
        runtime: 'docker-compose',
        services: [],
        status: 'ready',
        taskId: 'task-1',
      });
    const options = createControllerOptions({ inspectTaskContainerForTask });

    createRoot((dispose) => {
      const controller = createTaskPanelPreviewController(options);
      controller.handlePreviewButtonClick();
      void vi.advanceTimersByTimeAsync(5_000).then(() => dispose());
    });

    await vi.runAllTimersAsync();

    expect(inspectTaskContainerForTask).toHaveBeenCalledTimes(2);
  });
});
