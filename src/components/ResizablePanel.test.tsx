import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { resetStoreForTest } from '../test/store-test-helpers';

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
    resetStoreForTest();
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

  it('preserves panel content when descriptors with the same id are regenerated', async () => {
    const [revision, setRevision] = createSignal(0);
    const panelChildren = () => {
      revision();
      return [
        {
          id: 'prompt',
          content: () => <textarea aria-label="Prompt draft" />,
        },
      ];
    };

    render(() => <ResizablePanel direction="vertical" children={panelChildren()} />);

    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Prompt draft');
    fireEvent.input(textarea, { target: { value: 'draft before reactive update' } });
    expect(textarea.value).toBe('draft before reactive update');

    setRevision(1);

    await waitFor(() => {
      expect(screen.getByLabelText('Prompt draft')).toBe(textarea);
      expect(textarea.value).toBe('draft before reactive update');
    });
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

  it('ignores invalid persisted panel sizes', async () => {
    setStore('panelSizes', {
      'layout:left': -10,
      'layout:right': Number.NaN,
    });

    render(() => (
      <ResizablePanel
        direction="horizontal"
        fitContent
        persistKey="layout"
        children={[
          {
            id: 'left',
            initialSize: 120,
            content: () => <div>Left</div>,
          },
          {
            id: 'right',
            initialSize: 140,
            content: () => <div>Right</div>,
          },
        ]}
      />
    ));

    await waitFor(() => {
      expect(screen.getByText('Left').parentElement?.style.width).toBe('120px');
      expect(screen.getByText('Right').parentElement?.style.width).toBe('140px');
    });
  });

  it('resets persisted panel sizes on handle double-click', async () => {
    render(() => (
      <ResizablePanel
        direction="horizontal"
        fitContent
        persistKey="layout"
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

    const resizeHandle = document.querySelector('.resize-handle');
    if (!(resizeHandle instanceof HTMLElement)) {
      throw new Error('Expected panel resize handle');
    }

    fireEvent.mouseDown(resizeHandle, { clientX: 120 });
    fireEvent.mouseMove(window, { clientX: 160 });
    fireEvent.mouseUp(window);

    await waitFor(() => {
      expect(screen.getByText('Left').parentElement?.style.width).toBe('160px');
    });

    fireEvent.doubleClick(resizeHandle);

    await waitFor(() => {
      expect(screen.getByText('Left').parentElement?.style.width).toBe('120px');
    });
  });

  it('never persists sizes for transient panels on drag end', async () => {
    render(() => (
      <ResizablePanel
        direction="horizontal"
        fitContent
        persistKey="layout"
        children={[
          {
            id: 'left',
            initialSize: 120,
            content: () => <div>Left</div>,
          },
          {
            id: 'pending-task:abc',
            initialSize: 120,
            transient: true,
            content: () => <div>Pending</div>,
          },
        ]}
      />
    ));

    const resizeHandle = document.querySelector('.resize-handle');
    if (!(resizeHandle instanceof HTMLElement)) {
      throw new Error('Expected panel resize handle');
    }

    fireEvent.mouseDown(resizeHandle, { clientX: 120 });
    fireEvent.mouseMove(window, { clientX: 160 });
    fireEvent.mouseUp(window);

    await waitFor(() => {
      expect(store.panelSizes['layout:left']).toBe(160);
    });
    // Provisional ids must never reach persisted panel sizes.
    expect(Object.keys(store.panelSizes)).not.toContain('layout:pending-task:abc');
  });

  it('caps request-sized panels to leave room for neighboring panel minimums', async () => {
    const [requestedSize] = createSignal(500);
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 240,
    });

    try {
      render(() => (
        <ResizablePanel
          direction="vertical"
          children={[
            {
              id: 'requested',
              initialSize: 80,
              minSize: 50,
              stable: true,
              requestSize: requestedSize,
              content: () => <div>Requested</div>,
            },
            {
              id: 'neighbor',
              minSize: 50,
              content: () => <div>Neighbor</div>,
            },
          ]}
        />
      ));

      await waitFor(() => {
        expect(screen.getByText('Requested').parentElement?.style.flex).toBe('0 0 184px');
      });
    } finally {
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
      } else {
        delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
      }
    }
  });
});
