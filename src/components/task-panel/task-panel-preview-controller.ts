import { createEffect, createSignal, on, type Accessor } from 'solid-js';
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

interface TaskPanelPreviewControllerOptions {
  applyTaskPortsEvent: (snapshot: TaskPortsEvent) => void;
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
  getTaskPortSnapshot: (taskId: string) => TaskPortSnapshot | undefined;
  isTaskPanelFocused: (taskId: string, panelId: string) => boolean;
  refreshTaskPreviewForTask: (
    taskId: string,
    port: number,
  ) => Promise<TaskPortSnapshot | undefined>;
  setTaskFocusedPanel: (taskId: string, panelId: string) => void;
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
  let exposePortScanRequestId = 0;

  const taskPortSnapshot = () => options.getTaskPortSnapshot(options.taskId());
  const hasPreviewPorts = () => {
    const snapshot = taskPortSnapshot();
    return !!snapshot && (snapshot.exposed.length > 0 || snapshot.observed.length > 0);
  };

  function openPreview(): void {
    const taskId = options.taskId();
    setShowPreview(true);
    options.setTaskFocusedPanel(taskId, 'preview');
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

  createEffect(
    on(options.focusedPanel, (focusedPanel) => {
      if (focusedPanel !== 'preview') {
        return;
      }

      setShowPreview(true);
    }),
  );

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
      onExposePort: handleExposePort,
      onFocusPreview: openPreview,
      onHide: hidePreview,
      onRefreshAvailablePorts: refreshExposePortCandidates,
      onRefreshPort: async (port) => {
        const nextSnapshot = await options.refreshTaskPreviewForTask(options.taskId(), port);
        if (nextSnapshot) {
          options.applyTaskPortsEvent(createTaskPortsSnapshotEvent(nextSnapshot));
        }
      },
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
