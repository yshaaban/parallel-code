export type TerminalStartupPaintCoordinationRole = 'hidden' | 'selected' | 'visible-sibling';

interface TerminalStartupPaintEntry {
  ownerId?: number;
  paintReady: boolean;
  role: TerminalStartupPaintCoordinationRole;
  taskId: string;
}

export interface TerminalStartupPaintCoordinationSnapshot {
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

function summarizeTerminalStartupPaintEntries(
  predicate: (entry: TerminalStartupPaintEntry) => boolean,
): TerminalStartupPaintCoordinationSnapshot {
  let hiddenPendingCount = 0;
  let hiddenReadyCount = 0;
  let selectedPaintReady = false;
  let selectedPendingCount = 0;
  let visiblePendingCount = 0;
  let visibleReadyCount = 0;

  for (const entry of terminalStartupPaintEntries.values()) {
    if (!predicate(entry)) {
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

export function setTerminalStartupPaintCoordinationEntry(
  key: string,
  entry: Omit<TerminalStartupPaintEntry, 'ownerId'>,
  ownerId?: number,
): void {
  const previousEntry = terminalStartupPaintEntries.get(key);
  if (
    previousEntry?.ownerId === ownerId &&
    previousEntry?.taskId === entry.taskId &&
    previousEntry.role === entry.role &&
    previousEntry.paintReady === entry.paintReady
  ) {
    return;
  }

  terminalStartupPaintEntries.set(key, {
    ...entry,
    ...(ownerId === undefined ? {} : { ownerId }),
  });
  notifyTerminalStartupPaintListeners();
}

export function clearTerminalStartupPaintCoordinationEntry(key: string, ownerId?: number): void {
  const previousEntry = terminalStartupPaintEntries.get(key);
  if (!previousEntry || previousEntry.ownerId !== ownerId) {
    return;
  }

  terminalStartupPaintEntries.delete(key);
  notifyTerminalStartupPaintListeners();
}

export function getTaskTerminalStartupPaintCoordinationSnapshot(
  taskId: string,
): TerminalStartupPaintCoordinationSnapshot {
  return summarizeTerminalStartupPaintEntries((entry) => entry.taskId === taskId);
}

export function getGlobalTerminalStartupPaintCoordinationSnapshot(): TerminalStartupPaintCoordinationSnapshot {
  return summarizeTerminalStartupPaintEntries(() => true);
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
