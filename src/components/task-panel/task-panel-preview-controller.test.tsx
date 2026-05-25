import { createRoot, createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskPortSnapshot } from '../../domain/server-state';
import type { TaskContainerInspectResult } from '../../domain/task-containers';
import { createTaskPanelPreviewController } from './task-panel-preview-controller';

const { createTaskPreviewSectionMock, runWithTaskCommandLeaseMock, taskCommandLeaseSkipped } =
  vi.hoisted(() => ({
    createTaskPreviewSectionMock: vi.fn(),
    runWithTaskCommandLeaseMock: vi.fn(),
    taskCommandLeaseSkipped: Symbol('task-command-lease-skipped'),
  }));

vi.mock('./TaskPreviewSection', () => ({
  createTaskPreviewSection: createTaskPreviewSectionMock,
}));

vi.mock('../../app/task-command-lease', async () => {
  return {
    TASK_COMMAND_LEASE_SKIPPED: taskCommandLeaseSkipped,
    isTaskCommandLeaseSkipped: (value: unknown) => value === taskCommandLeaseSkipped,
    runWithTaskCommandLease: runWithTaskCommandLeaseMock,
  };
});

vi.mock('../../lib/runtime-client-id', () => ({
  getRuntimeClientId: () => 'client-self',
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

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, reject, resolve };
}

function createTaskPortSnapshot(overrides: Partial<TaskPortSnapshot> = {}): TaskPortSnapshot {
  return {
    exposed: [],
    observed: [],
    taskId: 'task-1',
    updatedAt: 1,
    ...overrides,
  };
}

interface PreviewSectionPanelProps {
  availableCandidates: unknown[];
  availableScanError: string | null;
  containerActionError: string | null;
  containerInspectError: string | null;
  containerInspectLoading: boolean;
  containerLogsError: string | null;
  onRefreshAvailablePorts: () => Promise<void>;
  onRefreshContainerInspect: () => Promise<void>;
  onRefreshContainerLogs: () => Promise<void>;
  onDestroyContainers: () => Promise<void>;
  onExposePort: (port: number, label?: string) => Promise<void>;
  onStartContainers: () => Promise<void>;
  onStopContainers: () => Promise<void>;
}

interface PreviewSectionFactoryProps {
  previewProps: () => PreviewSectionPanelProps;
}

function getLatestPreviewSectionProps() {
  const calls = createTaskPreviewSectionMock.mock.calls;
  const sectionProps = calls[calls.length - 1]?.[0] as PreviewSectionFactoryProps | undefined;
  return sectionProps?.previewProps();
}

describe('createTaskPanelPreviewController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runWithTaskCommandLeaseMock.mockImplementation(
      async (_taskId: string, _action: string, run: () => Promise<unknown>) => run(),
    );
    createTaskPreviewSectionMock.mockReturnValue({
      content: () => null,
      id: 'preview',
      initialSize: 260,
      minSize: 120,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('inspects task containers when the preview opens without starting them', async () => {
    const options = createControllerOptions();
    let dispose!: () => void;

    const controller = createRoot((nextDispose) => {
      dispose = nextDispose;
      return createTaskPanelPreviewController(options);
    });

    controller.handlePreviewButtonClick();
    await Promise.resolve();
    const previewSection = controller.previewSection();
    const previewSectionProps = getLatestPreviewSectionProps();
    dispose();

    const inspectMock = vi.mocked(options.inspectTaskContainerForTask);
    expect(inspectMock.mock.calls.length).toBeGreaterThan(0);
    expect(options.startTaskContainersForTask).not.toHaveBeenCalled();
    expect(options.setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'preview');
    expect(previewSection).not.toBeNull();
    expect(previewSectionProps?.containerInspectLoading).toBe(false);
  });

  it('opens the preview without scanning available ports implicitly', async () => {
    const options = createControllerOptions();
    let dispose!: () => void;

    const controller = createRoot((nextDispose) => {
      dispose = nextDispose;
      return createTaskPanelPreviewController(options);
    });

    controller.handlePreviewButtonClick();
    await Promise.resolve();
    controller.handlePreviewButtonClick();
    controller.handlePreviewButtonClick();
    await Promise.resolve();
    dispose();

    expect(options.fetchTaskPortExposureCandidates).not.toHaveBeenCalled();
  });

  it('scans available preview ports from the explicit refresh action', async () => {
    const [worktreePath, setWorktreePath] = createSignal('/tmp/project/.worktrees/task-1');
    const options = createControllerOptions({ worktreePath });
    let dispose!: () => void;

    const controller = createRoot((nextDispose) => {
      dispose = nextDispose;
      return createTaskPanelPreviewController(options);
    });

    controller.handlePreviewButtonClick();
    await Promise.resolve();
    expect(controller.previewSection()).not.toBeNull();
    const props = getLatestPreviewSectionProps();
    expect(props).toBeDefined();

    await props?.onRefreshAvailablePorts();
    setWorktreePath('/tmp/project/.worktrees/task-2');
    await props?.onRefreshAvailablePorts();
    dispose();

    expect(options.fetchTaskPortExposureCandidates).toHaveBeenCalledTimes(2);
    expect(options.fetchTaskPortExposureCandidates).toHaveBeenLastCalledWith(
      'task-1',
      '/tmp/project/.worktrees/task-2',
    );
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
    let dispose!: () => void;

    const controller = createRoot((nextDispose) => {
      dispose = nextDispose;
      return createTaskPanelPreviewController(options);
    });

    controller.handlePreviewButtonClick();
    await vi.advanceTimersByTimeAsync(5_000);
    dispose();

    expect(inspectTaskContainerForTask).toHaveBeenCalledTimes(2);
  });

  it('surfaces inspect failures from the latest request', async () => {
    const inspectTaskContainerForTask = vi.fn().mockRejectedValue(new Error('Inspect failed'));
    let dispose!: () => void;
    const controller = createRoot((nextDispose) => {
      dispose = nextDispose;
      return createTaskPanelPreviewController(
        createControllerOptions({ inspectTaskContainerForTask }),
      );
    });

    controller.handlePreviewButtonClick();
    await Promise.resolve();
    await Promise.resolve();

    const previewSection = controller.previewSection();
    expect(previewSection).not.toBeNull();
    const props = getLatestPreviewSectionProps();

    expect(props?.containerInspectError).toBe('Inspect failed');
    expect(props?.containerInspectLoading).toBe(false);

    dispose();
  });

  it('ignores stale inspect rejections after a newer refresh succeeds', async () => {
    const firstInspect = createDeferred<TaskContainerInspectResult>();
    const inspectTaskContainerForTask = vi
      .fn()
      .mockReturnValueOnce(firstInspect.promise)
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
    let dispose!: () => void;
    const controller = createRoot((nextDispose) => {
      dispose = nextDispose;
      return createTaskPanelPreviewController(
        createControllerOptions({ inspectTaskContainerForTask }),
      );
    });

    controller.handlePreviewButtonClick();
    await Promise.resolve();
    await Promise.resolve();

    const previewSection = controller.previewSection();
    expect(previewSection).not.toBeNull();
    const props = getLatestPreviewSectionProps();

    await props?.onRefreshContainerInspect();
    firstInspect.reject(new Error('Inspect failed'));
    await Promise.resolve();

    expect(getLatestPreviewSectionProps()?.containerInspectLoading).toBe(false);
    expect(getLatestPreviewSectionProps()?.containerInspectError).toBe(null);

    dispose();
  });

  it('surfaces logs failures and action failures in the preview section', async () => {
    const fetchTaskContainerLogsForTask = vi.fn().mockRejectedValue(new Error('Logs failed'));
    const startTaskContainersForTask = vi.fn().mockRejectedValue(new Error('Start failed'));
    let dispose!: () => void;

    const controller = createRoot((nextDispose) => {
      dispose = nextDispose;
      return createTaskPanelPreviewController(
        createControllerOptions({
          fetchTaskContainerLogsForTask,
          startTaskContainersForTask,
        }),
      );
    });

    controller.handlePreviewButtonClick();
    await Promise.resolve();

    const previewSection = controller.previewSection();
    expect(previewSection).not.toBeNull();
    const props = getLatestPreviewSectionProps();

    await props?.onRefreshContainerLogs();
    await Promise.resolve();
    expect(getLatestPreviewSectionProps()?.containerLogsError).toBe('Logs failed');

    await props?.onStartContainers();
    await Promise.resolve();
    expect(runWithTaskCommandLeaseMock).toHaveBeenCalledWith(
      'task-1',
      'manage task containers',
      expect.any(Function),
    );
    expect(startTaskContainersForTask).toHaveBeenCalledWith({
      controllerId: 'client-self',
      projectPath: '/tmp/project',
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-1',
    });
    expect(getLatestPreviewSectionProps()?.containerActionError).toBe('Start failed');

    dispose();
  });

  it('does not run container mutations when the task lease is skipped', async () => {
    runWithTaskCommandLeaseMock.mockResolvedValue(taskCommandLeaseSkipped);
    const startTaskContainersForTask = vi.fn().mockResolvedValue({ status: 'running' });
    let dispose!: () => void;

    const controller = createRoot((nextDispose) => {
      dispose = nextDispose;
      return createTaskPanelPreviewController(
        createControllerOptions({
          startTaskContainersForTask,
        }),
      );
    });

    controller.handlePreviewButtonClick();
    await Promise.resolve();

    const previewSection = controller.previewSection();
    expect(previewSection).not.toBeNull();
    const props = getLatestPreviewSectionProps();
    await props?.onStartContainers();

    expect(startTaskContainersForTask).not.toHaveBeenCalled();
    expect(getLatestPreviewSectionProps()?.containerActionError).toBe(
      'Task is controlled by another client',
    );

    dispose();
  });

  it('ignores container actions while inspect work is still in flight', async () => {
    const firstInspect = createDeferred<TaskContainerInspectResult>();
    const inspectTaskContainerForTask = vi.fn().mockReturnValueOnce(firstInspect.promise);
    const startTaskContainersForTask = vi.fn().mockRejectedValue(new Error('Start failed'));
    let dispose!: () => void;

    const controller = createRoot((nextDispose) => {
      dispose = nextDispose;
      return createTaskPanelPreviewController(
        createControllerOptions({
          inspectTaskContainerForTask,
          startTaskContainersForTask,
        }),
      );
    });

    controller.handlePreviewButtonClick();
    await Promise.resolve();

    const previewSection = controller.previewSection();
    expect(previewSection).not.toBeNull();
    const props = getLatestPreviewSectionProps();

    await props?.onStartContainers();
    expect(startTaskContainersForTask).not.toHaveBeenCalled();
    expect(getLatestPreviewSectionProps()?.containerActionError).toBe(null);

    dispose();
  });

  it.each([
    ['start', 'onStartContainers', 'startTaskContainersForTask', 'Start failed'],
    ['stop', 'onStopContainers', 'stopTaskContainersForTask', 'Stop failed'],
    ['destroy', 'onDestroyContainers', 'destroyTaskContainersForTask', 'Destroy failed'],
  ] as const)(
    'keeps a deferred %s rejection current after the passive poll interval',
    async (_action, handlerName, optionName, errorMessage) => {
      const action = createDeferred<TaskContainerInspectResult>();
      const inspectTaskContainerForTask = vi.fn().mockResolvedValue({
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
      });
      const options = createControllerOptions({
        inspectTaskContainerForTask,
        [optionName]: vi.fn().mockReturnValue(action.promise),
      });
      let dispose!: () => void;

      const controller = createRoot((nextDispose) => {
        dispose = nextDispose;
        return createTaskPanelPreviewController(options);
      });

      controller.handlePreviewButtonClick();
      await Promise.resolve();

      const previewSection = controller.previewSection();
      expect(previewSection).not.toBeNull();
      const props = getLatestPreviewSectionProps();
      expect(props).toBeDefined();

      const actionPromise = props?.[handlerName]();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      action.reject(new Error(errorMessage));
      await actionPromise;

      expect(inspectTaskContainerForTask).toHaveBeenCalledTimes(1);
      expect(getLatestPreviewSectionProps()?.containerActionError).toBe(errorMessage);

      dispose();
    },
  );

  it('turns unknown browser IPC port-scan failures into a restartable recovery message', async () => {
    const fetchTaskPortExposureCandidates = vi
      .fn()
      .mockRejectedValue(new Error('unknown ipc channel'));
    let dispose!: () => void;

    const controller = createRoot((nextDispose) => {
      dispose = nextDispose;
      return createTaskPanelPreviewController(
        createControllerOptions({ fetchTaskPortExposureCandidates }),
      );
    });

    controller.handlePreviewButtonClick();
    await Promise.resolve();

    const previewSection = controller.previewSection();
    expect(previewSection).not.toBeNull();
    const props = getLatestPreviewSectionProps();

    await props?.onRefreshAvailablePorts();
    await Promise.resolve();

    expect(getLatestPreviewSectionProps()?.availableCandidates).toEqual([]);
    expect(getLatestPreviewSectionProps()?.availableScanError).toBe(
      'Port scanning is unavailable because this browser tab is connected to an older server build. Restart the local server, then refresh this page.',
    );

    dispose();
  });

  it('does not reopen the preview when expose resolves after the user hides it', async () => {
    const exposedSnapshot = createTaskPortSnapshot();
    const exposeTaskPortForTask = vi.fn().mockResolvedValue(exposedSnapshot);
    let previewFocused = true;
    const options = createControllerOptions({
      exposeTaskPortForTask,
      isTaskPanelFocused: vi.fn(() => previewFocused),
    });
    let dispose!: () => void;

    const controller = createRoot((nextDispose) => {
      dispose = nextDispose;
      return createTaskPanelPreviewController(options);
    });

    controller.handlePreviewButtonClick();
    await Promise.resolve();
    expect(controller.previewSection()).not.toBeNull();
    const props = getLatestPreviewSectionProps();
    expect(props).toBeDefined();

    const exposePromise = props?.onExposePort(5173);
    controller.handlePreviewButtonClick();
    previewFocused = false;
    await exposePromise;

    expect(options.applyTaskPortsEvent).toHaveBeenCalledWith({
      ...exposedSnapshot,
      kind: 'snapshot',
    });
    expect(controller.showPreview()).toBe(false);
    expect(options.setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'prompt');

    dispose();
  });

  it('does not steal focus back to preview when expose resolves after focus moved away', async () => {
    const exposedSnapshot = createTaskPortSnapshot();
    const exposeTaskPortForTask = vi.fn().mockResolvedValue(exposedSnapshot);
    let previewFocused = true;
    const options = createControllerOptions({
      exposeTaskPortForTask,
      isTaskPanelFocused: vi.fn(() => previewFocused),
    });
    let dispose!: () => void;

    const controller = createRoot((nextDispose) => {
      dispose = nextDispose;
      return createTaskPanelPreviewController(options);
    });

    controller.handlePreviewButtonClick();
    await Promise.resolve();
    expect(controller.previewSection()).not.toBeNull();
    const props = getLatestPreviewSectionProps();
    expect(props).toBeDefined();
    vi.mocked(options.setTaskFocusedPanel).mockClear();

    const exposePromise = props?.onExposePort(5173);
    previewFocused = false;
    await exposePromise;

    expect(controller.showPreview()).toBe(true);
    expect(options.setTaskFocusedPanel).not.toHaveBeenCalledWith('task-1', 'preview');

    dispose();
  });

  it('clears stale action errors after a later inspect succeeds', async () => {
    const inspectTaskContainerForTask = vi.fn().mockResolvedValue({
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
    const startTaskContainersForTask = vi.fn().mockRejectedValue(new Error('Start failed'));
    let dispose!: () => void;

    const controller = createRoot((nextDispose) => {
      dispose = nextDispose;
      return createTaskPanelPreviewController(
        createControllerOptions({
          inspectTaskContainerForTask,
          startTaskContainersForTask,
        }),
      );
    });

    controller.handlePreviewButtonClick();
    await Promise.resolve();

    const previewSection = controller.previewSection();
    expect(previewSection).not.toBeNull();
    const props = getLatestPreviewSectionProps();

    await props?.onStartContainers();
    await Promise.resolve();
    expect(getLatestPreviewSectionProps()?.containerActionError).toBe('Start failed');

    await props?.onRefreshContainerInspect();
    await Promise.resolve();
    expect(getLatestPreviewSectionProps()?.containerActionError).toBe(null);

    dispose();
  });
});
