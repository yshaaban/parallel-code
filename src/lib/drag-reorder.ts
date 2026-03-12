const DEFAULT_DRAG_THRESHOLD = 5;

interface HorizontalDragReorderOptions {
  getTaskOrder: () => string[];
  itemId: string;
  onReorder: (fromIdx: number, toIdx: number) => void;
  onTap: () => void;
}

interface VerticalDropIndexOptions {
  clientY: number;
  container: ParentNode | null | undefined;
  fallbackIndex: number;
  itemSelector: string;
}

interface MouseDragSessionOptions {
  event: MouseEvent;
  onDragEnd: (didDrag: boolean) => void;
  onDragMove: (event: MouseEvent) => void;
  onDragStart?: () => void;
  threshold?: number;
}

export function handleDragReorder(event: MouseEvent, options: HorizontalDragReorderOptions): void {
  if (event.button !== 0) {
    return;
  }

  const target = event.target as HTMLElement;
  if (target.closest('button') || target.tagName === 'INPUT') {
    return;
  }

  event.preventDefault();
  const startX = event.clientX;
  const titleBarElement = event.currentTarget as HTMLElement;
  const draggedColumn = titleBarElement.closest<HTMLElement>('[data-task-id]');
  if (!draggedColumn) {
    return;
  }

  const sizeWrapper = draggedColumn.parentElement;
  const columnsContainer = sizeWrapper?.parentElement;
  if (!columnsContainer) {
    return;
  }
  const dragColumnsContainer = columnsContainer;
  const dragColumn = draggedColumn;

  let didDrag = false;
  let lastDropIndex = -1;
  let indicator: HTMLElement | null = null;

  function getColumns(): HTMLElement[] {
    return Array.from(dragColumnsContainer.querySelectorAll<HTMLElement>('[data-task-id]'));
  }

  function computeDropIndex(clientX: number): number {
    const columns = getColumns();
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      if (!column) {
        continue;
      }

      const rect = column.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        return index;
      }
    }

    return columns.length;
  }

  function positionIndicator(dropIndex: number): void {
    if (!indicator) {
      return;
    }

    const columns = getColumns();
    const containerRect = dragColumnsContainer.getBoundingClientRect();
    let x = containerRect.left;

    if (dropIndex < columns.length) {
      const column = columns[dropIndex];
      const parent = column?.parentElement;
      if (!parent) {
        return;
      }

      x = parent.getBoundingClientRect().left;
    } else if (columns.length > 0) {
      const lastColumn = columns[columns.length - 1];
      const parent = lastColumn?.parentElement;
      if (!parent) {
        return;
      }

      x = parent.getBoundingClientRect().right;
    }

    indicator.style.left = `${x - 1}px`;
    indicator.style.top = `${containerRect.top}px`;
    indicator.style.height = `${containerRect.height}px`;
  }

  function onMove(nextEvent: MouseEvent): void {
    if (!didDrag && Math.abs(nextEvent.clientX - startX) < DEFAULT_DRAG_THRESHOLD) {
      return;
    }

    if (!didDrag) {
      didDrag = true;
      document.body.classList.add('dragging-task');
      dragColumn.style.opacity = '0.4';
      indicator = document.createElement('div');
      indicator.className = 'drag-drop-indicator';
      document.body.appendChild(indicator);
    }

    const dropIndex = computeDropIndex(nextEvent.clientX);
    if (dropIndex !== lastDropIndex) {
      lastDropIndex = dropIndex;
      positionIndicator(dropIndex);
    }
  }

  function onUp(): void {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);

    if (!didDrag) {
      options.onTap();
      return;
    }

    document.body.classList.remove('dragging-task');
    dragColumn.style.opacity = '';
    indicator?.remove();

    const fromIndex = options.getTaskOrder().indexOf(options.itemId);
    if (fromIndex === -1 || lastDropIndex === -1 || fromIndex === lastDropIndex) {
      return;
    }

    const adjustedToIndex = lastDropIndex > fromIndex ? lastDropIndex - 1 : lastDropIndex;
    options.onReorder(fromIndex, adjustedToIndex);
  }

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

export function computeVerticalDropIndex(options: VerticalDropIndexOptions): number {
  const { clientY, container, fallbackIndex, itemSelector } = options;
  if (!container) {
    return fallbackIndex;
  }

  const items = container.querySelectorAll<HTMLElement>(itemSelector);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    const rect = item.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      return index;
    }
  }

  return items.length;
}

export function startMouseDragSession(options: MouseDragSessionOptions): void {
  const { event, onDragEnd, onDragMove, onDragStart, threshold = DEFAULT_DRAG_THRESHOLD } = options;
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  const startX = event.clientX;
  const startY = event.clientY;
  let didDrag = false;

  function onMove(nextEvent: MouseEvent): void {
    const deltaX = nextEvent.clientX - startX;
    const deltaY = nextEvent.clientY - startY;
    if (!didDrag && Math.abs(deltaX) + Math.abs(deltaY) < threshold) {
      return;
    }

    if (!didDrag) {
      didDrag = true;
      onDragStart?.();
    }

    onDragMove(nextEvent);
  }

  function onUp(): void {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    onDragEnd(didDrag);
  }

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}
