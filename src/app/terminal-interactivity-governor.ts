import { assertNever } from '../lib/assert-never';

type TerminalInteractivityListener = () => void;

export interface TerminalInteractivitySnapshot {
  active: boolean;
  agentId: string | null;
  ageMs: number;
  echoReservationActive: boolean;
  echoReservationRemainingMs: number;
  remainingMs: number;
  taskId: string | null;
}

const TERMINAL_TYPING_CRITICAL_WINDOW_MS = 240;
const TERMINAL_TYPING_ECHO_RESERVATION_WINDOW_MS = 160;

type TerminalInteractivityState =
  | {
      kind: 'idle';
    }
  | {
      agentId: string | null;
      expiresAtMs: number;
      kind: 'typing-critical';
      startedAtMs: number;
      taskId: string;
    };

type TerminalInteractivityEchoReservationState =
  | {
      kind: 'idle';
    }
  | {
      agentId: string | null;
      expiresAtMs: number;
      kind: 'active';
      taskId: string;
    };

let interactivityState: TerminalInteractivityState = { kind: 'idle' };
let interactivityTimer: ReturnType<typeof setTimeout> | undefined;
let echoReservationState: TerminalInteractivityEchoReservationState = {
  kind: 'idle',
};
let echoReservationTimer: ReturnType<typeof setTimeout> | undefined;
const interactivityListeners = new Set<TerminalInteractivityListener>();

function getInteractivityNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }

  return Date.now();
}

function clearInteractivityTimer(): void {
  if (interactivityTimer === undefined) {
    return;
  }

  clearTimeout(interactivityTimer);
  interactivityTimer = undefined;
}

function clearEchoReservationTimer(): void {
  if (echoReservationTimer === undefined) {
    return;
  }

  clearTimeout(echoReservationTimer);
  echoReservationTimer = undefined;
}

function notifyInteractivityListeners(): void {
  for (const listener of interactivityListeners) {
    listener();
  }
}

function clearInteractivityState(): void {
  clearInteractivityTimer();
  interactivityState = { kind: 'idle' };
}

function clearEchoReservationState(): void {
  clearEchoReservationTimer();
  echoReservationState = { kind: 'idle' };
}

function expireInteractivityIfNeeded(now = getInteractivityNow()): void {
  switch (interactivityState.kind) {
    case 'idle':
      return;
    case 'typing-critical':
      if (now < interactivityState.expiresAtMs) {
        return;
      }

      clearInteractivityState();
      notifyInteractivityListeners();
      return;
    default:
      return assertNever(interactivityState, 'Unhandled terminal interactivity state');
  }
}

function expireEchoReservationIfNeeded(now = getInteractivityNow()): void {
  switch (echoReservationState.kind) {
    case 'idle':
      return;
    case 'active':
      if (now < echoReservationState.expiresAtMs) {
        return;
      }

      clearEchoReservationState();
      notifyInteractivityListeners();
      return;
    default:
      return assertNever(
        echoReservationState,
        'Unhandled terminal interactivity echo reservation state',
      );
  }
}

function matchesInteractivityOwner(taskId?: string, agentId?: string): boolean {
  switch (interactivityState.kind) {
    case 'idle':
      return false;
    case 'typing-critical':
      if (taskId !== undefined && interactivityState.taskId !== taskId) {
        return false;
      }

      if (agentId !== undefined && interactivityState.agentId !== agentId) {
        return false;
      }

      return true;
    default:
      return assertNever(interactivityState, 'Unhandled terminal interactivity state');
  }
}

function matchesEchoReservation(taskId?: string, agentId?: string): boolean {
  switch (echoReservationState.kind) {
    case 'idle':
      return false;
    case 'active':
      if (taskId !== undefined && echoReservationState.taskId !== taskId) {
        return false;
      }

      if (agentId !== undefined && echoReservationState.agentId !== agentId) {
        return false;
      }

      return true;
    default:
      return assertNever(
        echoReservationState,
        'Unhandled terminal interactivity echo reservation state',
      );
  }
}

function getEchoReservationRemainingMs(now: number): number {
  if (echoReservationState.kind !== 'active') {
    return 0;
  }

  return Math.max(0, echoReservationState.expiresAtMs - now);
}

function isEchoReservationOwnedByInteractivity(): boolean {
  return (
    interactivityState.kind === 'typing-critical' &&
    echoReservationState.kind === 'active' &&
    echoReservationState.taskId === interactivityState.taskId &&
    echoReservationState.agentId === interactivityState.agentId
  );
}

export function noteTerminalTypingCritical(taskId: string, agentId?: string): void {
  if (taskId.length === 0 || TERMINAL_TYPING_CRITICAL_WINDOW_MS <= 0) {
    return;
  }

  const now = getInteractivityNow();
  const normalizedAgentId = agentId ?? null;
  const nextExpiresAtMs = now + TERMINAL_TYPING_CRITICAL_WINDOW_MS;
  const nextEchoReservationExpiresAtMs = now + TERMINAL_TYPING_ECHO_RESERVATION_WINDOW_MS;
  const interactivityChanged =
    interactivityState.kind !== 'typing-critical' ||
    interactivityState.taskId !== taskId ||
    interactivityState.agentId !== normalizedAgentId;
  const echoReservationChanged =
    echoReservationState.kind !== 'active' ||
    echoReservationState.taskId !== taskId ||
    echoReservationState.agentId !== normalizedAgentId;

  clearInteractivityTimer();
  interactivityState = {
    agentId: normalizedAgentId,
    expiresAtMs: nextExpiresAtMs,
    kind: 'typing-critical',
    startedAtMs: now,
    taskId,
  };
  interactivityTimer = setTimeout(() => {
    expireInteractivityIfNeeded();
  }, TERMINAL_TYPING_CRITICAL_WINDOW_MS);

  clearEchoReservationTimer();
  echoReservationState = {
    agentId: normalizedAgentId,
    expiresAtMs: nextEchoReservationExpiresAtMs,
    kind: 'active',
    taskId,
  };
  echoReservationTimer = setTimeout(() => {
    expireEchoReservationIfNeeded();
  }, TERMINAL_TYPING_ECHO_RESERVATION_WINDOW_MS);

  if (interactivityChanged || echoReservationChanged) {
    notifyInteractivityListeners();
  }
}

export function completeTerminalTypingEcho(taskId: string, agentId?: string): void {
  expireEchoReservationIfNeeded();
  if (!matchesEchoReservation(taskId, agentId)) {
    return;
  }

  clearEchoReservationState();
  notifyInteractivityListeners();
}

export function clearTerminalTypingAgent(agentId: string): void {
  expireInteractivityIfNeeded();
  expireEchoReservationIfNeeded();
  let didChange = false;

  switch (interactivityState.kind) {
    case 'idle':
      break;
    case 'typing-critical':
      if (interactivityState.agentId === agentId) {
        clearInteractivityState();
        didChange = true;
      }
      break;
    default:
      return assertNever(interactivityState, 'Unhandled terminal interactivity state');
  }

  switch (echoReservationState.kind) {
    case 'idle':
      break;
    case 'active':
      if (echoReservationState.agentId === agentId) {
        clearEchoReservationState();
        didChange = true;
      }
      break;
    default:
      return assertNever(
        echoReservationState,
        'Unhandled terminal interactivity echo reservation state',
      );
  }

  if (didChange) {
    notifyInteractivityListeners();
  }
}

export function settleTerminalTypingCritical(taskId: string, agentId?: string): void {
  expireInteractivityIfNeeded();
  expireEchoReservationIfNeeded();
  let didChange = false;

  switch (interactivityState.kind) {
    case 'idle':
      break;
    case 'typing-critical':
      if (matchesInteractivityOwner(taskId, agentId)) {
        clearInteractivityState();
        didChange = true;
      }
      break;
    default:
      return assertNever(interactivityState, 'Unhandled terminal interactivity state');
  }

  switch (echoReservationState.kind) {
    case 'idle':
      break;
    case 'active':
      if (matchesEchoReservation(taskId, agentId)) {
        clearEchoReservationState();
        didChange = true;
      }
      break;
    default:
      return assertNever(
        echoReservationState,
        'Unhandled terminal interactivity echo reservation state',
      );
  }

  if (didChange) {
    notifyInteractivityListeners();
  }
}

export function isTerminalInteractivityCriticalActive(taskId?: string, agentId?: string): boolean {
  expireInteractivityIfNeeded();
  return matchesInteractivityOwner(taskId, agentId);
}

export function isTerminalInteractivityEchoReservationActive(
  taskId?: string,
  agentId?: string,
): boolean {
  expireEchoReservationIfNeeded();
  return matchesEchoReservation(taskId, agentId);
}

export function shouldYieldToTerminalInteractivity(taskId?: string, agentId?: string): boolean {
  expireInteractivityIfNeeded();
  return (
    interactivityState.kind === 'typing-critical' && !matchesInteractivityOwner(taskId, agentId)
  );
}

export function isTerminalInteractivityPromptSuppressionActive(agentId: string): boolean {
  return isTerminalInteractivityCriticalActive(undefined, agentId);
}

export function getTerminalInteractivitySnapshot(): TerminalInteractivitySnapshot {
  expireInteractivityIfNeeded();
  expireEchoReservationIfNeeded();
  const now = getInteractivityNow();

  switch (interactivityState.kind) {
    case 'idle':
      return {
        active: false,
        agentId: null,
        ageMs: 0,
        echoReservationActive: echoReservationState.kind === 'active',
        echoReservationRemainingMs: getEchoReservationRemainingMs(now),
        remainingMs: 0,
        taskId: null,
      };
    case 'typing-critical':
      return {
        active: true,
        agentId: interactivityState.agentId,
        ageMs: Math.max(0, now - interactivityState.startedAtMs),
        echoReservationActive: isEchoReservationOwnedByInteractivity(),
        echoReservationRemainingMs: getEchoReservationRemainingMs(now),
        remainingMs: Math.max(0, interactivityState.expiresAtMs - now),
        taskId: interactivityState.taskId,
      };
    default:
      return assertNever(interactivityState, 'Unhandled terminal interactivity state');
  }
}

export function subscribeTerminalInteractivityChanges(
  listener: TerminalInteractivityListener,
): () => void {
  interactivityListeners.add(listener);
  return function unsubscribe(): void {
    interactivityListeners.delete(listener);
  };
}

export function resetTerminalInteractivityForTests(): void {
  resetTerminalInteractivityState();
  interactivityListeners.clear();
}

export function resetTerminalInteractivityState(): void {
  clearInteractivityState();
  clearEchoReservationState();
}
