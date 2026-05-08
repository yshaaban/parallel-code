import { fireEvent, render, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { beginPanelResizeDragMock, endPanelResizeDragMock } = vi.hoisted(() => ({
  beginPanelResizeDragMock: vi.fn(),
  endPanelResizeDragMock: vi.fn(),
}));

vi.mock('../app/panel-resize-drag', () => ({
  beginPanelResizeDrag: beginPanelResizeDragMock,
  endPanelResizeDrag: endPanelResizeDragMock,
}));

import { ResizablePanel, type ResizablePanelHandle } from './ResizablePanel';

describe('ResizablePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears the programmatic resize handle on unmount', async () => {
    const handles: Array<ResizablePanelHandle | undefined> = [];
    const result = render(() => (
      <ResizablePanel
        direction="horizontal"
        fitContent
        onHandle={(handle) => handles.push(handle)}
        children={[
          {
            id: 'panel-1',
            content: () => <div>Panel</div>,
          },
        ]}
      />
    ));

    await waitFor(() => {
      expect(handles.at(-1)?.resizeAll).toEqual(expect.any(Function));
    });

    result.unmount();

    expect(handles.at(-1)).toBeUndefined();
  });

  it('ends panel resize drag state when unmounted mid-drag', () => {
    const result = render(() => (
      <ResizablePanel
        direction="horizontal"
        fitContent
        children={[
          {
            id: 'left',
            initialSize: 120,
            content: () => <div>Left</div>,
          },
          {
            id: 'right',
            initialSize: 120,
            content: () => <div>Right</div>,
          },
        ]}
      />
    ));

    const resizeHandle = result.container.querySelector('.resize-handle');
    if (!(resizeHandle instanceof HTMLElement)) {
      throw new Error('Expected panel resize handle');
    }

    fireEvent.mouseDown(resizeHandle, { clientX: 120 });

    expect(beginPanelResizeDragMock).toHaveBeenCalledTimes(1);

    result.unmount();
    fireEvent.mouseMove(window, { clientX: 160 });
    fireEvent.mouseUp(window);

    expect(endPanelResizeDragMock).toHaveBeenCalledTimes(1);
  });
});
