import type { Accessor, JSX } from 'solid-js';
import { ScalablePanel } from '../ScalablePanel';
import type { PanelChild } from '../ResizablePanel';
import type { TaskPortExposureCandidate, TaskPortSnapshot } from '../../domain/server-state';
import type {
  TaskContainerInspectResult,
  TaskContainerLogsResult,
} from '../../domain/task-containers';
import { PreviewPanel } from '../PreviewPanel';

interface TaskPreviewSectionProps {
  availableCandidates: Accessor<ReadonlyArray<TaskPortExposureCandidate>>;
  availableScanError: Accessor<string | null>;
  availableScanning: Accessor<boolean>;
  containerInspect: Accessor<TaskContainerInspectResult | null>;
  containerInspectLoading: Accessor<boolean>;
  containerLogs: Accessor<TaskContainerLogsResult | null>;
  containerLogsLoading: Accessor<boolean>;
  onDestroyContainers: () => Promise<void> | void;
  onExposePort: (port: number, label?: string) => Promise<void> | void;
  onFocusPreview: () => void;
  onHide: () => void;
  onRefreshContainerInspect: () => Promise<void> | void;
  onRefreshContainerLogs: () => Promise<void> | void;
  onRefreshAvailablePorts: () => Promise<void> | void;
  onRefreshPort: (port: number) => Promise<void> | void;
  onStartContainers: () => Promise<void> | void;
  onStopContainers: () => Promise<void> | void;
  onUnexposePort: (port: number) => Promise<void> | void;
  snapshot: Accessor<TaskPortSnapshot>;
  taskId: Accessor<string>;
}

export function createTaskPreviewSection(props: TaskPreviewSectionProps): PanelChild {
  return {
    id: 'preview',
    initialSize: 260,
    minSize: 120,
    content: () => <TaskPreviewSection {...props} />,
  };
}

export function TaskPreviewSection(props: TaskPreviewSectionProps): JSX.Element {
  return (
    <ScalablePanel panelId={`${props.taskId()}:preview`}>
      <div
        style={{ height: '100%' }}
        onClick={() => {
          props.onFocusPreview();
        }}
      >
        <PreviewPanel
          availableCandidates={props.availableCandidates()}
          availableScanError={props.availableScanError()}
          availableScanning={props.availableScanning()}
          containerInspect={props.containerInspect()}
          containerInspectLoading={props.containerInspectLoading()}
          containerLogs={props.containerLogs()}
          containerLogsLoading={props.containerLogsLoading()}
          taskId={props.taskId()}
          snapshot={props.snapshot()}
          onDestroyContainers={props.onDestroyContainers}
          onExposePort={props.onExposePort}
          onHide={props.onHide}
          onRefreshContainerInspect={props.onRefreshContainerInspect}
          onRefreshContainerLogs={props.onRefreshContainerLogs}
          onRefreshAvailablePorts={props.onRefreshAvailablePorts}
          onRefreshPort={props.onRefreshPort}
          onStartContainers={props.onStartContainers}
          onStopContainers={props.onStopContainers}
          onUnexposePort={props.onUnexposePort}
        />
      </div>
    </ScalablePanel>
  );
}
