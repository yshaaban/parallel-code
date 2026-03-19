import type { Accessor, JSX } from 'solid-js';
import { ScalablePanel } from '../ScalablePanel';
import type { PanelChild } from '../ResizablePanel';
import type { TaskPortExposureCandidate, TaskPortSnapshot } from '../../domain/server-state';
import { PreviewPanel } from '../PreviewPanel';

interface TaskPreviewSectionProps {
  availableCandidates: Accessor<ReadonlyArray<TaskPortExposureCandidate>>;
  availableScanError: Accessor<string | null>;
  availableScanning: Accessor<boolean>;
  onExposePort: (port: number, label?: string) => Promise<void> | void;
  onFocusPreview: () => void;
  onHide: () => void;
  onRefreshAvailablePorts: () => Promise<void> | void;
  onRefreshPort: (port: number) => Promise<void> | void;
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
          taskId={props.taskId()}
          snapshot={props.snapshot()}
          onExposePort={props.onExposePort}
          onHide={props.onHide}
          onRefreshAvailablePorts={props.onRefreshAvailablePorts}
          onRefreshPort={props.onRefreshPort}
          onUnexposePort={props.onUnexposePort}
        />
      </div>
    </ScalablePanel>
  );
}
