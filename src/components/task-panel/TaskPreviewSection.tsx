import type { Accessor, JSX } from 'solid-js';
import { ScalablePanel } from '../ScalablePanel';
import type { PanelChild } from '../ResizablePanel';
import type { TaskPortSnapshot } from '../../domain/server-state';
import { PreviewPanel } from '../PreviewPanel';
import { setTaskFocusedPanel } from '../../store/store';

interface TaskPreviewSectionProps {
  onExposeObservedPort: (port: number) => Promise<void> | void;
  onHide: () => void;
  onOpenExposeDialog: () => void;
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
          setTaskFocusedPanel(props.taskId(), 'preview');
        }}
      >
        <PreviewPanel
          taskId={props.taskId()}
          snapshot={props.snapshot()}
          onExposeObservedPort={props.onExposeObservedPort}
          onHide={props.onHide}
          onOpenExposeDialog={props.onOpenExposeDialog}
          onRefreshPort={props.onRefreshPort}
          onUnexposePort={props.onUnexposePort}
        />
      </div>
    </ScalablePanel>
  );
}
