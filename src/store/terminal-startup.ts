import { createSignal } from 'solid-js';

export type TerminalStartupPhase = 'queued' | 'binding' | 'attaching' | 'restoring';

interface TerminalStartupEntry {
  phase: TerminalStartupPhase;
  taskId: string;
}

export interface TaskTerminalStartupSummary {
  count: number;
  label: string;
  phase: TerminalStartupPhase;
}

export interface TerminalStartupSummary {
  attachingCount: number;
  bindingCount: number;
  detail: string | null;
  label: string;
  pendingCount: number;
  queuedCount: number;
  restoringCount: number;
}

const [terminalStartupEntries, setTerminalStartupEntries] = createSignal<
  Record<string, TerminalStartupEntry>
>({});

function listTerminalStartupEntries(): TerminalStartupEntry[] {
  return Object.values(terminalStartupEntries());
}

function formatTerminalCount(count: number): string {
  return `${count} terminal${count === 1 ? '' : 's'}`;
}

function getTerminalStartupPhasePriority(phase: TerminalStartupPhase): number {
  switch (phase) {
    case 'restoring':
      return 0;
    case 'attaching':
      return 1;
    case 'binding':
      return 2;
    case 'queued':
      return 3;
  }
}

function getDominantTerminalStartupPhase(
  entries: ReadonlyArray<TerminalStartupEntry>,
): TerminalStartupPhase | null {
  const firstEntry = entries[0];
  if (!firstEntry) {
    return null;
  }

  let dominantPhase = firstEntry.phase;
  for (const entry of entries) {
    if (
      getTerminalStartupPhasePriority(entry.phase) < getTerminalStartupPhasePriority(dominantPhase)
    ) {
      dominantPhase = entry.phase;
    }
  }

  return dominantPhase;
}

function getTerminalStartupLabel(
  pendingCount: number,
  dominantPhase: TerminalStartupPhase,
): string {
  if (pendingCount > 1) {
    return `Initializing ${formatTerminalCount(pendingCount)}`;
  }

  switch (dominantPhase) {
    case 'restoring':
      return 'Restoring terminal output…';
    case 'attaching':
      return 'Attaching terminal…';
    case 'binding':
      return 'Connecting to terminal…';
    case 'queued':
      return 'Preparing terminal…';
  }
}

function formatTerminalStartupDetailCount(count: number, noun: string): string | null {
  if (count <= 0) {
    return null;
  }

  return `${count} ${noun}`;
}

function getTerminalStartupDetail(
  summary: Omit<TerminalStartupSummary, 'detail' | 'label'>,
): string | null {
  const detailParts = [
    formatTerminalStartupDetailCount(summary.restoringCount, 'restoring'),
    formatTerminalStartupDetailCount(summary.attachingCount, 'attaching'),
    formatTerminalStartupDetailCount(summary.bindingCount, 'connecting'),
    formatTerminalStartupDetailCount(summary.queuedCount, 'queued'),
  ].filter((part): part is string => part !== null);

  if (detailParts.length === 0) {
    return null;
  }

  return detailParts.join(' · ');
}

export function registerTerminalStartupCandidate(key: string, taskId: string): void {
  setTerminalStartupEntries((previousEntries) => ({
    ...previousEntries,
    [key]: {
      phase: 'queued',
      taskId,
    },
  }));
}

export function setTerminalStartupPhase(key: string, phase: TerminalStartupPhase): void {
  setTerminalStartupEntries((previousEntries) => {
    const currentEntry = previousEntries[key];
    if (!currentEntry || currentEntry.phase === phase) {
      return previousEntries;
    }

    return {
      ...previousEntries,
      [key]: {
        ...currentEntry,
        phase,
      },
    };
  });
}

export function clearTerminalStartupEntry(key: string): void {
  setTerminalStartupEntries((previousEntries) => {
    if (!previousEntries[key]) {
      return previousEntries;
    }

    const { [key]: _omittedEntry, ...nextEntries } = previousEntries;
    return nextEntries;
  });
}

export function getTaskTerminalStartupSummary(taskId: string): TaskTerminalStartupSummary | null {
  const taskEntries = listTerminalStartupEntries().filter((entry) => entry.taskId === taskId);
  const dominantPhase = getDominantTerminalStartupPhase(taskEntries);
  if (!dominantPhase) {
    return null;
  }

  const count = taskEntries.length;
  if (count > 1) {
    return {
      count,
      label: `Initializing ${formatTerminalCount(count)}`,
      phase: dominantPhase,
    };
  }

  return {
    count,
    label: getTerminalStartupLabel(count, dominantPhase),
    phase: dominantPhase,
  };
}

export function getTerminalStartupSummary(): TerminalStartupSummary | null {
  const entries = listTerminalStartupEntries();
  const dominantPhase = getDominantTerminalStartupPhase(entries);
  if (!dominantPhase) {
    return null;
  }

  const queuedCount = entries.filter((entry) => entry.phase === 'queued').length;
  const bindingCount = entries.filter((entry) => entry.phase === 'binding').length;
  const attachingCount = entries.filter((entry) => entry.phase === 'attaching').length;
  const restoringCount = entries.filter((entry) => entry.phase === 'restoring').length;
  const pendingCount = entries.length;

  return {
    attachingCount,
    bindingCount,
    detail: getTerminalStartupDetail({
      attachingCount,
      bindingCount,
      pendingCount,
      queuedCount,
      restoringCount,
    }),
    label: getTerminalStartupLabel(pendingCount, dominantPhase),
    pendingCount,
    queuedCount,
    restoringCount,
  };
}

export function resetTerminalStartupStateForTests(): void {
  setTerminalStartupEntries({});
}
