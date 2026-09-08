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

import { ResizablePanel, type PanelChild, type ResizablePanelHandle } from './ResizablePanel';

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

  it.each(['horizontal', 'vertical'] as const)(
    'keeps the focused middle panel connected when %s descriptors refresh',
    (direction) => {
      const [revision, setRevision] = createSignal(0);
      const panelChildren = () => {
        revision();
        return [
          { id: 'left', content: () => <div>Left</div> },
          { id: 'editor', content: () => <textarea aria-label="Focused draft" /> },
          { id: 'right', content: () => <div>Right</div> },
        ];
      };
      const result = render(() => (
        <ResizablePanel direction={direction} fitContent children={panelChildren()} />
      ));
      const textarea = screen.getByLabelText<HTMLTextAreaElement>('Focused draft');
      textarea.value = 'keep my cursor and draft';
      textarea.focus();
      textarea.setSelectionRange(5, 9);
      const handles = [...result.container.querySelectorAll('.resize-handle')];
      const blur = vi.fn();
      textarea.addEventListener('blur', blur);

      for (let revision = 1; revision <= 3; revision++) {
        setRevision(revision);
        expect(screen.getByLabelText('Focused draft')).toBe(textarea);
        expect(document.activeElement).toBe(textarea);
        expect(textarea.selectionStart).toBe(5);
        expect(textarea.selectionEnd).toBe(9);
        expect(textarea.value).toBe('keep my cursor and draft');
        expect([...result.container.querySelectorAll('.resize-handle')]).toEqual(handles);
      }
      expect(blur).not.toHaveBeenCalled();
    },
  );

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

  it('leaves manual persisted sizing alone when a one-shot request is cleared and descriptors refresh', () => {
    const [requestedSize, setRequestedSize] = createSignal<number>();
    const [revision, setRevision] = createSignal(0);
    const children = () => {
      revision();
      return [
        {
          id: 'prompt',
          initialSize: 120,
          requestSize: requestedSize,
          content: () => <textarea aria-label="Sized draft" />,
        },
        { id: 'neighbor', initialSize: 300, content: () => <div>Neighbor</div> },
      ];
    };
    const result = render(() => (
      <ResizablePanel direction="horizontal" fitContent persistKey="layout" children={children()} />
    ));
    const editor = screen.getByRole('textbox', { name: 'Sized draft' }) as HTMLTextAreaElement;
    expect(editor.parentElement?.style.width).toBe('120px');
    setRequestedSize(200);
    expect(editor.parentElement?.style.width).toBe('200px');
    setRequestedSize(undefined);
    expect(editor.parentElement?.style.width).toBe('200px');
    const handle = result.container.querySelector('.resize-handle');
    if (!(handle instanceof HTMLElement)) throw new Error('Expected panel resize handle');
    fireEvent.mouseDown(handle, { clientX: 200 });
    fireEvent.mouseMove(window, { clientX: 240 });
    fireEvent.mouseUp(window);
    expect(editor.parentElement?.style.width).toBe('240px');
    expect(store.panelSizes['layout:prompt']).toBe(240);
    editor.value = 'Keep this draft';
    editor.focus();
    editor.setSelectionRange(1, 4);
    setRevision(1);
    expect(editor.parentElement?.style.width).toBe('240px');
    expect(screen.getByRole('textbox', { name: 'Sized draft' })).toBe(editor);
    expect(editor.value).toBe('Keep this draft');
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(1);
  });

  it('preserves a stable prompt panel manual size across unrelated flex-layout descriptor refreshes', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    try {
      const [revision, setRevision] = createSignal(0);
      const children = () => {
        revision();
        return [
          {
            id: 'prompt',
            initialSize: 120,
            stable: true,
            requestSize: () => undefined,
            content: () => <textarea aria-label="Stable draft" />,
          },
          { id: 'neighbor', minSize: 50, content: () => <div>Neighbor</div> },
        ];
      };
      const result = render(() => (
        <ResizablePanel direction="vertical" persistKey="layout" children={children()} />
      ));
      const editor = screen.getByRole('textbox', { name: 'Stable draft' });
      const handle = result.container.querySelector('.resize-handle');
      if (!(handle instanceof HTMLElement)) throw new Error('Expected panel resize handle');
      fireEvent.mouseDown(handle, { clientY: 120 });
      fireEvent.mouseMove(window, { clientY: 160 });
      fireEvent.mouseUp(window);
      expect(store.panelSizes['layout:prompt']).toBe(160);
      expect(editor.parentElement?.style.flex).toBe('0 0 160px');
      setRevision(1);
      expect(editor.parentElement?.style.flex).toBe('0 0 160px');
    } finally {
      height.mockRestore();
    }
  });

  it('preserves an unpersisted disclosure size across identical geometry descriptor refreshes', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    try {
      const [requestedSize, setRequestedSize] = createSignal<number>();
      const [revision, setRevision] = createSignal(0);
      const children = () => {
        revision();
        return [
          {
            id: 'prompt',
            initialSize: 72,
            minSize: 54,
            maxSize: 300,
            stable: true,
            requestSize: requestedSize,
            content: () => <textarea aria-label="Expanded disclosure draft" />,
          },
          { id: 'neighbor', minSize: 50, content: () => <div>Neighbor</div> },
        ];
      };
      render(() => (
        <ResizablePanel direction="vertical" persistKey="layout" children={children()} />
      ));
      const editor = screen.getByRole('textbox', {
        name: 'Expanded disclosure draft',
      }) as HTMLTextAreaElement;
      expect(editor.parentElement?.style.flex).toBe('0 0 72px');
      setRequestedSize(200);
      setRequestedSize(undefined);
      expect(editor.parentElement?.style.flex).toBe('0 0 200px');
      expect(store.panelSizes['layout:prompt']).toBeUndefined();
      editor.value = 'Keep this reviewed draft visible';
      editor.focus();
      setRevision(1);
      expect(screen.getByRole('textbox', { name: 'Expanded disclosure draft' })).toBe(editor);
      expect(document.activeElement).toBe(editor);
      expect(editor.value).toBe('Keep this reviewed draft visible');
      expect(editor.parentElement?.style.flex).toBe('0 0 200px');
    } finally {
      height.mockRestore();
    }
  });

  it('restores stable persisted sizes within their bounds without changing fixed headers', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    try {
      setStore('panelSizes', { 'layout:header': 180, 'layout:prompt': 800, 'layout:footer': 2 });
      render(() => (
        <ResizablePanel
          direction="vertical"
          persistKey="layout"
          children={[
            { id: 'header', fixed: true, initialSize: 30, content: () => <div>Fixed header</div> },
            {
              id: 'prompt',
              stable: true,
              initialSize: 72,
              minSize: 54,
              maxSize: 300,
              content: () => <div>Stable prompt</div>,
            },
            {
              id: 'footer',
              stable: true,
              initialSize: 72,
              minSize: 54,
              maxSize: 300,
              content: () => <div>Stable footer</div>,
            },
            { id: 'neighbor', minSize: 50, content: () => <div>Flexible neighbor</div> },
          ]}
        />
      ));
      expect(screen.getByText('Fixed header').parentElement?.style.flex).toBe('0 0 30px');
      expect(screen.getByText('Stable prompt').parentElement?.style.flex).toBe('0 0 300px');
      expect(screen.getByText('Stable footer').parentElement?.style.flex).toBe('0 0 54px');
    } finally {
      height.mockRestore();
    }
  });

  it.each([
    ['initialSize', { initialSize: 96 }, '0 0 96px'],
    ['minSize', { minSize: 100 }, '0 0 100px'],
    ['maxSize', { maxSize: 60 }, '0 0 60px'],
    ['fixed', { fixed: true }, '0 0 72px'],
    ['stable', { stable: false }, '72 1 0px'],
    ['identity', { id: 'replacement' }, '0 0 72px'],
  ] satisfies Array<[string, Partial<PanelChild>, string]>)(
    'applies changed %s geometry after a one-shot disclosure request',
    (_field, changed, expectedFlex) => {
      const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
      try {
        const [requestedSize, setRequestedSize] = createSignal<number>();
        const [patch, setPatch] = createSignal<Partial<PanelChild>>({});
        const children = () => [
          {
            id: 'prompt',
            initialSize: 72,
            minSize: 54,
            maxSize: 300,
            stable: true,
            requestSize: requestedSize,
            content: () => <div>Geometry prompt</div>,
            ...patch(),
          },
          { id: 'neighbor', minSize: 50, content: () => <div>Neighbor</div> },
        ];
        render(() => <ResizablePanel direction="vertical" children={children()} />);
        setRequestedSize(200);
        setRequestedSize(undefined);
        expect(screen.getByText('Geometry prompt').parentElement?.style.flex).toBe('0 0 200px');
        setPatch(changed);
        expect(screen.getByText('Geometry prompt').parentElement?.style.flex).toBe(expectedFlex);
      } finally {
        height.mockRestore();
      }
    },
  );

  it.each(['direction', 'fitContent', 'persistKey', 'order'] as const)(
    'reinitializes sizing when the %s layout owner changes',
    (owner) => {
      const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
      const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
      try {
        const [requestedSize, setRequestedSize] = createSignal<number>();
        const [changed, setChanged] = createSignal(false);
        setStore('panelSizes', 'next:prompt', 156);
        const children = () => {
          const panels = [
            {
              id: 'prompt',
              initialSize: 72,
              stable: true,
              requestSize: requestedSize,
              content: () => <div>Layout prompt</div>,
            },
            { id: 'neighbor', minSize: 50, content: () => <div>Neighbor</div> },
          ];
          return owner === 'order' && changed() ? panels.reverse() : panels;
        };
        render(() => (
          <ResizablePanel
            direction={owner === 'direction' && changed() ? 'horizontal' : 'vertical'}
            fitContent={owner === 'fitContent' && changed()}
            persistKey={owner === 'persistKey' && changed() ? 'next' : 'layout'}
            children={children()}
          />
        ));
        setRequestedSize(200);
        setRequestedSize(undefined);
        expect(screen.getByText('Layout prompt').parentElement?.style.flex).toBe('0 0 200px');
        setChanged(true);
        const style = screen.getByText('Layout prompt').parentElement?.style;
        if (owner === 'fitContent') expect(style?.height).toBe('72px');
        else expect(style?.flex).toBe(`0 0 ${owner === 'persistKey' ? 156 : 72}px`);
      } finally {
        height.mockRestore();
        width.mockRestore();
      }
    },
  );
});
