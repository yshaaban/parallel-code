import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { TaskPortSnapshot } from '../../domain/server-state';
import { TaskPreviewSection } from './TaskPreviewSection';

vi.mock('../PreviewPanel', () => ({
  PreviewPanel: function PreviewPanel(props: {
    onHide: () => void;
    snapshot: TaskPortSnapshot;
    taskId: string;
  }) {
    return (
      <button type="button" onClick={() => props.onHide()}>
        Preview {props.taskId} exposed {props.snapshot.exposed.length}
      </button>
    );
  },
}));

describe('TaskPreviewSection', () => {
  it('loads the preview panel lazily without dropping preview callbacks', async () => {
    const onHide = vi.fn();
    function noop(): void {}
    const snapshot: TaskPortSnapshot = {
      exposed: [],
      observed: [],
      taskId: 'task-1',
      updatedAt: 0,
    };

    render(() => (
      <TaskPreviewSection
        onFocusPreview={noop}
        previewProps={() => ({
          availableCandidates: [],
          availableScanError: null,
          availableScanning: false,
          containerActionError: null,
          containerInspect: null,
          containerInspectError: null,
          containerInspectLoading: false,
          containerLogs: null,
          containerLogsError: null,
          containerLogsLoading: false,
          onDestroyContainers: noop,
          onExposePort: noop,
          onHide,
          onRefreshAvailablePorts: noop,
          onRefreshContainerInspect: noop,
          onRefreshContainerLogs: noop,
          onRefreshPort: noop,
          onStartContainers: noop,
          onStopContainers: noop,
          onUnexposePort: noop,
          snapshot,
          taskId: 'task-1',
        })}
        taskId={() => 'task-1'}
      />
    ));

    const previewButton = await screen.findByRole('button', {
      name: 'Preview task-1 exposed 0',
    });

    fireEvent.click(previewButton);

    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
