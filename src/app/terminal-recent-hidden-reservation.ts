type TerminalRecentHiddenReservationListener = () => void;

interface TerminalRecentHiddenReservationEntry {
  key: string;
  reservedAtMs: number;
  taskId: string;
}

const TERMINAL_RECENT_HIDDEN_RESERVATION_LIMIT = 2;

const terminalRecentHiddenReservations = new Map<string, TerminalRecentHiddenReservationEntry>();
const terminalRecentHiddenReservationListeners = new Set<TerminalRecentHiddenReservationListener>();
let lastTerminalRecentHiddenReservationNow = 0;

function getTerminalRecentHiddenReservationNow(): number {
  const candidateNow =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  const nextNow = Math.max(candidateNow, lastTerminalRecentHiddenReservationNow + 1);

  lastTerminalRecentHiddenReservationNow = nextNow;
  return nextNow;
}

function notifyTerminalRecentHiddenReservationListeners(): void {
  for (const listener of terminalRecentHiddenReservationListeners) {
    listener();
  }
}

function pruneTerminalRecentHiddenReservations(): void {
  const sortedEntries = [...terminalRecentHiddenReservations.values()].sort((left, right) => {
    const reservedAtDifference = right.reservedAtMs - left.reservedAtMs;
    if (reservedAtDifference !== 0) {
      return reservedAtDifference;
    }

    return left.key.localeCompare(right.key);
  });

  if (sortedEntries.length <= TERMINAL_RECENT_HIDDEN_RESERVATION_LIMIT) {
    return;
  }

  for (const entry of sortedEntries.slice(TERMINAL_RECENT_HIDDEN_RESERVATION_LIMIT)) {
    terminalRecentHiddenReservations.delete(entry.key);
  }
}

export function reserveTerminalRecentHiddenCandidate(key: string, taskId: string): void {
  if (key.length === 0 || taskId.length === 0) {
    return;
  }

  terminalRecentHiddenReservations.set(key, {
    key,
    reservedAtMs: getTerminalRecentHiddenReservationNow(),
    taskId,
  });
  pruneTerminalRecentHiddenReservations();
  notifyTerminalRecentHiddenReservationListeners();
}

export function clearTerminalRecentHiddenCandidate(key: string): void {
  if (!terminalRecentHiddenReservations.delete(key)) {
    return;
  }

  notifyTerminalRecentHiddenReservationListeners();
}

export function getTerminalRecentHiddenReservedKeys(): string[] {
  return [...terminalRecentHiddenReservations.values()]
    .sort((left, right) => {
      const reservedAtDifference = right.reservedAtMs - left.reservedAtMs;
      if (reservedAtDifference !== 0) {
        return reservedAtDifference;
      }

      return left.key.localeCompare(right.key);
    })
    .map((entry) => entry.key);
}

export function isTerminalRecentHiddenCandidateReserved(key: string): boolean {
  return terminalRecentHiddenReservations.has(key);
}

export function subscribeTerminalRecentHiddenReservationChanges(
  listener: TerminalRecentHiddenReservationListener,
): () => void {
  terminalRecentHiddenReservationListeners.add(listener);
  return function unsubscribe(): void {
    terminalRecentHiddenReservationListeners.delete(listener);
  };
}

export function resetTerminalRecentHiddenReservationForTests(): void {
  terminalRecentHiddenReservations.clear();
  terminalRecentHiddenReservationListeners.clear();
  lastTerminalRecentHiddenReservationNow = 0;
}
