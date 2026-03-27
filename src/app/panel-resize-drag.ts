import { createSignal } from 'solid-js';

const [activePanelResizeDrags, setActivePanelResizeDrags] = createSignal(0);

export function beginPanelResizeDrag(): void {
  setActivePanelResizeDrags((count) => count + 1);
}

export function endPanelResizeDrag(): void {
  setActivePanelResizeDrags((count) => Math.max(0, count - 1));
}

export function isPanelResizeDragging(): boolean {
  return activePanelResizeDrags() > 0;
}

export function resetPanelResizeDragging(): void {
  setActivePanelResizeDrags(0);
}
