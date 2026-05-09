import { createEffect, createSignal, on, onCleanup, untrack, type Accessor } from 'solid-js';
import type { PanelChild } from '../ResizablePanel';
import { createTaskPreviewSection } from './TaskPreviewSection';
import {
  createRemovedTaskPortsEvent,
  createTaskPortsSnapshotEvent,
} from '../../domain/server-state';
import type {
  TaskPortExposureCandidate,
  TaskPortSnapshot,
  TaskPortsEvent,
} from '../../domain/server-state';
import type { TaskContainerRequest } from '../../app/task-containers';
import type {
  ProjectContainerConfig,
  TaskContainerInspectResult,
  TaskContainerLogsResult,
} from '../../domain/task-containers';

interface TaskPanelPreviewControllerOptions {
  applyTaskPortsEvent: (snapshot: TaskPortsEvent) => void;
  destroyTaskContainersForTask: (
    request: TaskContainerRequest,
  ) => Promise<TaskContainerInspectResult>;
  exposeTaskPortForTask: (
    taskId: string,
    port: number,
    label?: string,
  ) => Promise<TaskPortSnapshot>;
  fetchTaskPortExposureCandidates: (
    taskId: string,
    worktreePath: string,
  ) => Promise<TaskPortExposureCandidate[]>;
  focusedPanel: Accessor<string | null>;
  fetchTaskContainerLogsForTask: (
    request: TaskContainerRequest,
    options?: { lines?: number },
  ) => Promise<TaskContainerLogsResult>;
  inspectTaskContainerForTask: (
    request: TaskContainerRequest,
  ) => Promise<TaskContainerInspectResult>;
  getTaskPortSnapshot: (taskId: string) => TaskPortSnapshot | undefined;
  isTaskPanelFocused: (taskId: string, panelId: string) => boolean;
  projectContainerConfig: Accessor<ProjectContainerConfig | undefined>;
  projectPath: Accessor<string>;
  refreshTaskPreviewForTask: (
    taskId: string,
    port: number,
  ) => Promise<TaskPortSnapshot | undefined>;
  setTaskFocusedPanel: (taskId: string, panelId: string) => void;
  startTaskContainersForTask: (
    request: TaskContainerRequest,
  ) => Promise<TaskContainerInspectResult>;
  stopTaskContainersForTask: (request: TaskContainerRequest) => Promise<TaskContainerInspectResult>;
  taskId: Accessor<string>;
  unexposeTaskPortForTask: (taskId: string, port: number) => Promise<TaskPortSnapshot | undefined>;
  worktreePath: Accessor<string>;
}

interface LatestRequestTracker {
  begin: () => number;
  invalidate: () => void;
  isCurrent: (requestId: number) => boolean;
}

function createEmptyTaskPortSnapshot(taskId: string): TaskPortSnapshot {
  return {
    exposed: [],
    observed: [],
    taskId,
    updatedAt: 0,
  };
}

function getExposePortScanErrorMessage(error: unknown): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) {
    return 'Failed to scan ports';
  }

  if (/unknown ipc channel/i.test(error.message)) {
    return 'Port scanning is unavailable because this browser tab is connected to an older server build. Restart the local server, then refresh this page.';
  }

  return error.message;
}

function createLatestRequestTracker(): LatestRequestTracker {
  let currentRequestId = 0;

  return {
    begin: () => {
      currentRequestId += 1;
      return currentRequestId;
    },
    invalidate: () => {
      currentRequestId += 1;
    },
    isCurrent: (requestId) => requestId === currentRequestId,
  };
}

export function createTaskPanelPreviewController(options: TaskPanelPreviewControllerOptions): {
  handlePreviewButtonClick: () => void;
  hasPreviewPorts: Accessor<boolean>;
  previewSection: Accessor<PanelChild | null>;
  showPreview: Accessor<boolean>;
} {
  const [showPreview, setShowPreview] = createSignal(false);
  const [exposePortCandidates, setExposePortCandidates] = createSignal<TaskPortExposureCandidate[]>(
    [],
  );
  const [scanningExposePortCandidates, setScanningExposePortCandidates] = createSignal(false);
  const [exposePortScanError, setExposePortScanError] = createSignal<string | null>(null);
  const [containerInspect, setContainerInspect] = createSignal<TaskContainerInspectResult | null>(
    null,
  );
  const [loadingContainerInspect, setLoadingContainerInspect] = createSignal(false);
  const [containerLogs, setContainerLogs] = createSignal<TaskContainerLogsResult | null>(null);
  const [loadingContainerLogs, setLoadingContainerLogs] = createSignal(false);
  const [containerInspectError, setContainerInspectError] = createSignal<string | null>(null);
  const [containerLogsError, setContainerLogsError] = createSignal<string | null>(null);
  const [containerActionError, setContainerActionError] = createSignal<string | null>(null);
  const exposePortScanRequest = createLatestRequestTracker();
  const containerInspectRequest = createLatestRequestTracker();
  const containerLogsRequest = createLatestRequestTracker();

  function createTaskContainerRequest(): TaskContainerRequest {
    const projectContainerConfig = options.projectContainerConfig();

    return {
      ...(projectContainerConfig !== undefined ? { projectContainerConfig } : {}),
      projectPath: options.projectPath(),
      taskId: options.taskId(),
      worktreePath: options.worktreePath(),
    };
  }

  const taskPortSnapshot = () => options.getTaskPortSnapshot(options.taskId());
  const hasPreviewPorts = () => {
    const snapshot = taskPortSnapshot();
    return !!snapshot && (snapshot.exposed.length > 0 || snapshot.observed.length > 0);
  };

  function focusPreview(taskId: string, wasOpen: boolean): void {
    setShowPreview(true);
    options.setTaskFocusedPanel(taskId, 'preview');
    if (wasOpen) {
      void refreshContainerInspect();
    }
  }

  function openPreview(): void {
    focusPreview(options.taskId(), showPreview());
  }

  function getContainerErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    return fallback;
  }

  function hidePreview(): void {
    const taskId = options.taskId();
    setShowPreview(false);

    if (options.isTaskPanelFocused(taskId, 'preview')) {
      options.setTaskFocusedPanel(taskId, 'prompt');
    }
  }

  function shouldFocusPreviewAfterPortAction(taskId: string): boolean {
    return (
      showPreview() && options.taskId() === taskId && options.isTaskPanelFocused(taskId, 'preview')
    );
  }

  async function refreshExposePortCandidates(): Promise<void> {
    const requestId = exposePortScanRequest.begin();
    const taskId = options.taskId();
    const worktreePath = options.worktreePath();
    setScanningExposePortCandidates(true);
    setExposePortScanError(null);
    try {
      const candidates = await options.fetchTaskPortExposureCandidates(taskId, worktreePath);
      if (!exposePortScanRequest.isCurrent(requestId)) {
        return;
      }

      setExposePortCandidates(candidates);
    } catch (error) {
      if (!exposePortScanRequest.isCurrent(requestId)) {
        return;
      }

      setExposePortCandidates([]);
      setExposePortScanError(getExposePortScanErrorMessage(error));
    } finally {
      if (exposePortScanRequest.isCurrent(requestId)) {
        setScanningExposePortCandidates(false);
      }
    }
  }

  async function refreshContainerInspect(): Promise<void> {
    const requestId = containerInspectRequest.begin();
    setLoadingContainerInspect(true);
    setContainerInspectError(null);
    try {
      const nextInspect = await options.inspectTaskContainerForTask(createTaskContainerRequest());
      if (!containerInspectRequest.isCurrent(requestId)) {
        return;
      }

      setContainerInspect(nextInspect);
      setContainerActionError(null);
    } catch (error) {
      if (!containerInspectRequest.isCurrent(requestId)) {
        return;
      }

      setContainerInspectError(
        getContainerErrorMessage(error, 'Failed to inspect the task container.'),
      );
    } finally {
      if (containerInspectRequest.isCurrent(requestId)) {
        setLoadingContainerInspect(false);
      }
    }
  }

  async function refreshContainerLogs(): Promise<void> {
    const requestId = containerLogsRequest.begin();
    setLoadingContainerLogs(true);
    setContainerLogsError(null);
    try {
      const nextLogs = await options.fetchTaskContainerLogsForTask(createTaskContainerRequest());
      if (!containerLogsRequest.isCurrent(requestId)) {
        return;
      }

      setContainerLogs(nextLogs);
    } catch (error) {
      if (!containerLogsRequest.isCurrent(requestId)) {
        return;
      }

      setContainerLogsError(getContainerErrorMessage(error, 'Failed to load task container logs.'));
    } finally {
      if (containerLogsRequest.isCurrent(requestId)) {
        setLoadingContainerLogs(false);
      }
    }
  }

  async function runContainerAction(
    action: (request: TaskContainerRequest) => Promise<TaskContainerInspectResult>,
  ): Promise<void> {
    if (loadingContainerInspect()) {
      return;
    }

    const requestId = containerInspectRequest.begin();
    containerLogsRequest.invalidate();
    setLoadingContainerLogs(false);
    setContainerActionError(null);
    setLoadingContainerInspect(true);
    try {
      const nextInspect = await action(createTaskContainerRequest());
      if (!containerInspectRequest.isCurrent(requestId)) {
        return;
      }

      setContainerInspect(nextInspect);
      setContainerInspectError(null);
      if (nextInspect.status === 'running') {
        void refreshContainerLogs();
      }
    } catch (error) {
      if (!containerInspectRequest.isCurrent(requestId)) {
        return;
      }

      setContainerActionError(
        getContainerErrorMessage(error, 'Failed to update the task container.'),
      );
    } finally {
      if (containerInspectRequest.isCurrent(requestId)) {
        setLoadingContainerInspect(false);
      }
    }
  }

  createEffect(
    on(options.focusedPanel, (focusedPanel) => {
      if (focusedPanel !== 'preview') {
        return;
      }

      setShowPreview(true);
    }),
  );

  createEffect(() => {
    if (!showPreview()) {
      return;
    }

    void refreshContainerInspect();
    const interval = window.setInterval(() => {
      if (untrack(loadingContainerInspect)) {
        return;
      }

      const currentInspect = untrack(containerInspect);
      if (currentInspect?.status === 'running') {
        void refreshContainerInspect();
      }
    }, 5_000);
    onCleanup(() => window.clearInterval(interval));
  });

  function handlePreviewButtonClick(): void {
    if (showPreview()) {
      hidePreview();
      return;
    }

    openPreview();
  }

  async function handleExposePort(port: number, label?: string): Promise<void> {
    const taskId = options.taskId();
    const wasOpen = showPreview();
    const snapshot = await options.exposeTaskPortForTask(taskId, port, label);
    options.applyTaskPortsEvent(createTaskPortsSnapshotEvent(snapshot));
    if (shouldFocusPreviewAfterPortAction(taskId)) {
      focusPreview(taskId, wasOpen);
    }
  }

  const previewSection = () => {
    if (!showPreview()) {
      return null;
    }

    return createTaskPreviewSection({
      onFocusPreview: openPreview,
      previewProps: () => ({
        availableCandidates: exposePortCandidates(),
        availableScanError: exposePortScanError(),
        availableScanning: scanningExposePortCandidates(),
        containerActionError: containerActionError(),
        containerInspect: containerInspect(),
        containerInspectError: containerInspectError(),
        containerInspectLoading: loadingContainerInspect(),
        containerLogs: containerLogs(),
        containerLogsError: containerLogsError(),
        containerLogsLoading: loadingContainerLogs(),
        onDestroyContainers: () => runContainerAction(options.destroyTaskContainersForTask),
        onExposePort: handleExposePort,
        onHide: hidePreview,
        onRefreshAvailablePorts: refreshExposePortCandidates,
        onRefreshContainerInspect: refreshContainerInspect,
        onRefreshContainerLogs: refreshContainerLogs,
        onRefreshPort: async (port) => {
          const nextSnapshot = await options.refreshTaskPreviewForTask(options.taskId(), port);
          if (nextSnapshot) {
            options.applyTaskPortsEvent(createTaskPortsSnapshotEvent(nextSnapshot));
          }
        },
        onStartContainers: () => runContainerAction(options.startTaskContainersForTask),
        onStopContainers: () => runContainerAction(options.stopTaskContainersForTask),
        onUnexposePort: async (port) => {
          const taskId = options.taskId();
          const nextSnapshot = await options.unexposeTaskPortForTask(taskId, port);
          if (nextSnapshot) {
            options.applyTaskPortsEvent(createTaskPortsSnapshotEvent(nextSnapshot));
            return;
          }

          options.applyTaskPortsEvent(createRemovedTaskPortsEvent(taskId));
        },
        snapshot: taskPortSnapshot() ?? createEmptyTaskPortSnapshot(options.taskId()),
        taskId: options.taskId(),
      }),
      taskId: options.taskId,
    });
  };

  return {
    handlePreviewButtonClick,
    hasPreviewPorts,
    previewSection,
    showPreview,
  };
}
