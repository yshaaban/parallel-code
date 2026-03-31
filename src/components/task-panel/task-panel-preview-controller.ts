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

function createEmptyTaskPortSnapshot(taskId: string): TaskPortSnapshot {
  return {
    exposed: [],
    observed: [],
    taskId,
    updatedAt: 0,
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
  let exposePortScanRequestId = 0;
  let containerInspectRequestId = 0;
  let containerLogsRequestId = 0;

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

  function openPreview(): void {
    const taskId = options.taskId();
    setShowPreview(true);
    options.setTaskFocusedPanel(taskId, 'preview');
    void refreshContainerInspect();
  }

  function hidePreview(): void {
    const taskId = options.taskId();
    setShowPreview(false);

    if (options.isTaskPanelFocused(taskId, 'preview')) {
      options.setTaskFocusedPanel(taskId, 'prompt');
    }
  }

  async function refreshExposePortCandidates(): Promise<void> {
    const requestId = ++exposePortScanRequestId;
    const taskId = options.taskId();
    const worktreePath = options.worktreePath();
    setScanningExposePortCandidates(true);
    setExposePortScanError(null);
    try {
      const candidates = await options.fetchTaskPortExposureCandidates(taskId, worktreePath);
      if (requestId !== exposePortScanRequestId) {
        return;
      }

      setExposePortCandidates(candidates);
    } catch (error) {
      if (requestId !== exposePortScanRequestId) {
        return;
      }

      setExposePortCandidates([]);
      setExposePortScanError(error instanceof Error ? error.message : 'Failed to scan ports');
    } finally {
      if (requestId === exposePortScanRequestId) {
        setScanningExposePortCandidates(false);
      }
    }
  }

  async function refreshContainerInspect(): Promise<void> {
    const requestId = ++containerInspectRequestId;
    setLoadingContainerInspect(true);
    try {
      const nextInspect = await options.inspectTaskContainerForTask(createTaskContainerRequest());
      if (requestId !== containerInspectRequestId) {
        return;
      }

      setContainerInspect(nextInspect);
    } finally {
      if (requestId === containerInspectRequestId) {
        setLoadingContainerInspect(false);
      }
    }
  }

  async function refreshContainerLogs(): Promise<void> {
    const requestId = ++containerLogsRequestId;
    setLoadingContainerLogs(true);
    try {
      const nextLogs = await options.fetchTaskContainerLogsForTask(createTaskContainerRequest());
      if (requestId !== containerLogsRequestId) {
        return;
      }

      setContainerLogs(nextLogs);
    } finally {
      if (requestId === containerLogsRequestId) {
        setLoadingContainerLogs(false);
      }
    }
  }

  async function runContainerAction(
    action: (request: TaskContainerRequest) => Promise<TaskContainerInspectResult>,
  ): Promise<void> {
    setLoadingContainerInspect(true);
    try {
      const nextInspect = await action(createTaskContainerRequest());
      setContainerInspect(nextInspect);
      if (nextInspect.status === 'running') {
        void refreshContainerLogs();
      }
    } finally {
      setLoadingContainerInspect(false);
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

  function handleExposePort(port: number, label?: string): Promise<void> {
    const taskId = options.taskId();
    return options.exposeTaskPortForTask(taskId, port, label).then((snapshot) => {
      options.applyTaskPortsEvent(createTaskPortsSnapshotEvent(snapshot));
      openPreview();
    });
  }

  const previewSection = () => {
    if (!showPreview()) {
      return null;
    }

    return createTaskPreviewSection({
      availableCandidates: exposePortCandidates,
      availableScanError: exposePortScanError,
      availableScanning: scanningExposePortCandidates,
      containerInspect,
      containerInspectLoading: loadingContainerInspect,
      containerLogs,
      containerLogsLoading: loadingContainerLogs,
      onDestroyContainers: () => runContainerAction(options.destroyTaskContainersForTask),
      onExposePort: handleExposePort,
      onFocusPreview: openPreview,
      onHide: hidePreview,
      onRefreshContainerInspect: refreshContainerInspect,
      onRefreshContainerLogs: refreshContainerLogs,
      onRefreshAvailablePorts: refreshExposePortCandidates,
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
      snapshot: () => taskPortSnapshot() ?? createEmptyTaskPortSnapshot(options.taskId()),
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
