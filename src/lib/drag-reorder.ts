const DEFAULT_DRAG_THRESHOLD = 5;

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
