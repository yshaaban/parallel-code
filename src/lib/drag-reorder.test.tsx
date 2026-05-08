import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleDragReorder, startMouseDragSession } from './drag-reorder';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('drag-reorder', () => {
  afterEach(() => {
    document.body.classList.remove('dragging-task');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('cancels mouse drag sessions without firing the drag-end callback', () => {
    const onDragCancel = vi.fn();
    const onDragEnd = vi.fn();
    const onDragMove = vi.fn();
    const cleanup = startMouseDragSession({
      event: new MouseEvent('mousedown', { button: 0, clientX: 0, clientY: 0 }),
      onDragCancel,
      onDragEnd,
      onDragMove,
      threshold: 0,
    });
    if (!cleanup) {
      throw new Error('Expected active mouse drag cleanup');
    }

    cleanup();
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup'));

    expect(onDragCancel).toHaveBeenCalledWith(false);
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(onDragMove).not.toHaveBeenCalled();
  });

  it('cancels reorder sessions and clears transient drag presentation', () => {
    const onReorder = vi.fn();
    const onSessionEnd = vi.fn();
    const onTap = vi.fn();
    const container = document.createElement('div');
    const wrapper = document.createElement('div');
    const column = document.createElement('div');
    const title = document.createElement('div');
    let cleanup: (() => void) | undefined;

    column.dataset.taskId = 'task-1';
    column.append(title);
    wrapper.append(column);
    container.append(wrapper);
    document.body.append(container);

    container.getBoundingClientRect = () => rect(0, 0, 240, 100);
    wrapper.getBoundingClientRect = () => rect(0, 0, 120, 100);
    column.getBoundingClientRect = () => rect(0, 0, 120, 100);

    title.addEventListener('mousedown', (event) => {
      cleanup = handleDragReorder(event, {
        getTaskOrder: () => ['task-1'],
        itemId: 'task-1',
        onReorder,
        onSessionEnd,
        onTap,
      });
    });

    title.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 24 }));

    expect(document.body.classList.contains('dragging-task')).toBe(true);
    expect(document.querySelector('.drag-drop-indicator')).not.toBeNull();
    expect(column.style.opacity).toBe('0.4');

    if (!cleanup) {
      throw new Error('Expected active reorder cleanup');
    }
    cleanup();
    window.dispatchEvent(new MouseEvent('mouseup'));

    expect(document.body.classList.contains('dragging-task')).toBe(false);
    expect(document.querySelector('.drag-drop-indicator')).toBeNull();
    expect(column.style.opacity).toBe('');
    expect(onReorder).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });
});
