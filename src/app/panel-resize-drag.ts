import { batch, createSignal } from 'solid-js';

const [activePanelResizeDrags, setActivePanelResizeDrags] = createSignal(0);
const [panelResizeDragEpoch, setPanelResizeDragEpoch] = createSignal(0);

export function beginPanelResizeDrag(): void {
  setActivePanelResizeDrags((count) => count + 1);
}

export function endPanelResizeDrag(): void {
  const currentCount = activePanelResizeDrags();
  const nextCount = Math.max(0, currentCount - 1);

  batch(() => {
    setActivePanelResizeDrags(nextCount);

    if (currentCount > 0 && nextCount === 0) {
      setPanelResizeDragEpoch((epoch) => epoch + 1);
    }
  });
}

export function getPanelResizeDragEpoch(): number {
  return panelResizeDragEpoch();
}

export function isPanelResizeDragging(): boolean {
  return activePanelResizeDrags() > 0;
}

export function resetPanelResizeDragging(): void {
  batch(() => {
    setActivePanelResizeDrags(0);
    setPanelResizeDragEpoch(0);
  });
}
