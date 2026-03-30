export type TerminalStartupPaintCoordinationRole = 'hidden' | 'selected' | 'visible-sibling';

interface TerminalStartupPaintEntry {
  paintReady: boolean;
  role: TerminalStartupPaintCoordinationRole;
  taskId: string;
}

export interface TaskTerminalStartupPaintCoordinationSnapshot {
  hiddenPendingCount: number;
  hiddenReadyCount: number;
  selectedPaintReady: boolean;
  selectedPendingCount: number;
  visiblePendingCount: number;
  visibleReadyCount: number;
}

type TerminalStartupPaintListener = () => void;

const terminalStartupPaintEntries = new Map<string, TerminalStartupPaintEntry>();
const terminalStartupPaintListeners = new Set<TerminalStartupPaintListener>();

function notifyTerminalStartupPaintListeners(): void {
  for (const listener of terminalStartupPaintListeners) {
    listener();
  }
}

export function setTerminalStartupPaintCoordinationEntry(
  key: string,
  entry: TerminalStartupPaintEntry,
): void {
  const previousEntry = terminalStartupPaintEntries.get(key);
  if (
    previousEntry?.taskId === entry.taskId &&
    previousEntry.role === entry.role &&
    previousEntry.paintReady === entry.paintReady
  ) {
    return;
  }

  terminalStartupPaintEntries.set(key, entry);
  notifyTerminalStartupPaintListeners();
}

export function clearTerminalStartupPaintCoordinationEntry(key: string): void {
  if (!terminalStartupPaintEntries.delete(key)) {
    return;
  }

  notifyTerminalStartupPaintListeners();
}

export function getTaskTerminalStartupPaintCoordinationSnapshot(
  taskId: string,
): TaskTerminalStartupPaintCoordinationSnapshot {
  let hiddenPendingCount = 0;
  let hiddenReadyCount = 0;
  let selectedPaintReady = false;
  let selectedPendingCount = 0;
  let visiblePendingCount = 0;
  let visibleReadyCount = 0;

  for (const entry of terminalStartupPaintEntries.values()) {
    if (entry.taskId !== taskId) {
      continue;
    }

    switch (entry.role) {
      case 'selected':
        if (entry.paintReady) {
          selectedPaintReady = true;
          visibleReadyCount += 1;
        } else {
          selectedPendingCount += 1;
          visiblePendingCount += 1;
        }
        break;
      case 'visible-sibling':
        if (entry.paintReady) {
          visibleReadyCount += 1;
        } else {
          visiblePendingCount += 1;
        }
        break;
      case 'hidden':
        if (entry.paintReady) {
          hiddenReadyCount += 1;
        } else {
          hiddenPendingCount += 1;
        }
        break;
    }
  }

  return {
    hiddenPendingCount,
    hiddenReadyCount,
    selectedPaintReady,
    selectedPendingCount,
    visiblePendingCount,
    visibleReadyCount,
  };
}

export function subscribeTerminalStartupPaintCoordinationChanges(
  listener: TerminalStartupPaintListener,
): () => void {
  terminalStartupPaintListeners.add(listener);
  return () => {
    terminalStartupPaintListeners.delete(listener);
  };
}

export function resetTerminalStartupPaintCoordinationForTests(): void {
  terminalStartupPaintEntries.clear();
  terminalStartupPaintListeners.clear();
}
