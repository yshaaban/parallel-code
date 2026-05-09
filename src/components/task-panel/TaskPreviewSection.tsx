import { Suspense, type Accessor, type JSX } from 'solid-js';
import { ScalablePanel } from '../ScalablePanel';
import type { PanelChild } from '../ResizablePanel';
import type { PreviewPanelProps } from '../PreviewPanel';
import { lazyNamed } from '../../lib/lazy-named';

const PreviewPanel = lazyNamed(() => import('../PreviewPanel'), 'PreviewPanel');

interface TaskPreviewSectionProps {
  onFocusPreview: () => void;
  previewProps: Accessor<PreviewPanelProps>;
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
        <Suspense>
          <PreviewPanel {...props.previewProps()} />
        </Suspense>
      </div>
    </ScalablePanel>
  );
}
