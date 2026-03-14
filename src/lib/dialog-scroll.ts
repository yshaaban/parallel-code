import { createEffect, onCleanup, type Accessor } from 'solid-js';

interface DialogScrollOptions {
  enabled: Accessor<boolean>;
  getElement: Accessor<HTMLElement | undefined>;
  step?: number;
  page?: number;
}

function applyScrollDelta(element: HTMLElement, delta: number): void {
  element.scrollTop += delta;
}

export function createDialogScroll(options: DialogScrollOptions): void {
  const step = options.step ?? 40;
  const page = options.page ?? 200;

  createEffect(() => {
    if (!options.enabled()) {
      return;
    }

    const element = options.getElement();
    if (!element) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.target !== element) {
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          applyScrollDelta(element, step);
          return;
        case 'ArrowUp':
          event.preventDefault();
          applyScrollDelta(element, -step);
          return;
        case 'PageDown':
          event.preventDefault();
          applyScrollDelta(element, page);
          return;
        case 'PageUp':
          event.preventDefault();
          applyScrollDelta(element, -page);
          return;
        case 'Home':
          event.preventDefault();
          element.scrollTop = 0;
          return;
        case 'End':
          event.preventDefault();
          element.scrollTop = element.scrollHeight;
          return;
      }
    }

    element.addEventListener('keydown', handleKeyDown);
    onCleanup(() => {
      element.removeEventListener('keydown', handleKeyDown);
    });
  });
}
