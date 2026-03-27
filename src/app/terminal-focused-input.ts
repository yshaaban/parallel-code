import { getTerminalExperimentDenseOverloadMinimumVisibleCount } from '../lib/terminal-performance-experiments';
import { isTerminalHighLoadModeEnabled } from './terminal-high-load-mode';
import { assertNever } from '../lib/assert-never';

type TerminalFocusedInputListener = () => void;

export interface TerminalFocusedInputSnapshot {
  active: boolean;
  agentId: string | null;
  ageMs: number;
  echoReservationActive: boolean;
  echoReservationRemainingMs: number;
  remainingMs: number;
  taskId: string | null;
}

const TERMINAL_FOCUSED_INPUT_WINDOW_MS = 240;
const TERMINAL_FOCUSED_INPUT_ECHO_RESERVATION_WINDOW_MS = 160;

type TerminalFocusedInputState =
  | {
      kind: 'idle';
    }
  | {
      agentId: string | null;
      expiresAtMs: number;
      kind: 'active';
      startedAtMs: number;
      taskId: string;
    };

type TerminalFocusedInputEchoReservationState =
  | {
      kind: 'idle';
    }
  | {
      agentId: string | null;
      expiresAtMs: number;
      kind: 'active';
      taskId: string;
    };

let focusedInputState: TerminalFocusedInputState = { kind: 'idle' };
let focusedInputTimer: ReturnType<typeof setTimeout> | undefined;
let focusedInputEchoReservationState: TerminalFocusedInputEchoReservationState = {
  kind: 'idle',
};
let focusedInputEchoReservationTimer: ReturnType<typeof setTimeout> | undefined;
const terminalFocusedInputListeners = new Set<TerminalFocusedInputListener>();

function getTerminalFocusedInputNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }

  return Date.now();
}

function clearTerminalFocusedInputTimer(): void {
  if (focusedInputTimer === undefined) {
    return;
  }

  clearTimeout(focusedInputTimer);
  focusedInputTimer = undefined;
}

function clearTerminalFocusedInputEchoReservationTimer(): void {
  if (focusedInputEchoReservationTimer === undefined) {
    return;
  }

  clearTimeout(focusedInputEchoReservationTimer);
  focusedInputEchoReservationTimer = undefined;
}

function notifyTerminalFocusedInputListeners(): void {
  for (const listener of terminalFocusedInputListeners) {
    listener();
  }
}

function clearTerminalFocusedInputState(): void {
  clearTerminalFocusedInputTimer();
  focusedInputState = { kind: 'idle' };
}

function clearTerminalFocusedInputEchoReservationState(): void {
  clearTerminalFocusedInputEchoReservationTimer();
  focusedInputEchoReservationState = { kind: 'idle' };
}

function expireTerminalFocusedInputIfNeeded(now = getTerminalFocusedInputNow()): void {
  switch (focusedInputState.kind) {
    case 'idle':
      return;
    case 'active':
      if (now < focusedInputState.expiresAtMs) {
        return;
      }

      clearTerminalFocusedInputState();
      notifyTerminalFocusedInputListeners();
      return;
    default:
      return assertNever(focusedInputState, 'Unhandled terminal focused-input state');
  }
}

function expireTerminalFocusedInputEchoReservationIfNeeded(
  now = getTerminalFocusedInputNow(),
): void {
  switch (focusedInputEchoReservationState.kind) {
    case 'idle':
      return;
    case 'active':
      if (now < focusedInputEchoReservationState.expiresAtMs) {
        return;
      }

      clearTerminalFocusedInputEchoReservationState();
      notifyTerminalFocusedInputListeners();
      return;
    default:
      return assertNever(
        focusedInputEchoReservationState,
        'Unhandled terminal focused-input echo reservation state',
      );
  }
}

function matchesFocusedInput(taskId?: string, agentId?: string): boolean {
  switch (focusedInputState.kind) {
    case 'idle':
      return false;
    case 'active':
      if (taskId !== undefined && focusedInputState.taskId !== taskId) {
        return false;
      }

      if (agentId !== undefined && focusedInputState.agentId !== agentId) {
        return false;
      }

      return true;
    default:
      return assertNever(focusedInputState, 'Unhandled terminal focused-input state');
  }
}

function matchesFocusedInputEchoReservation(taskId?: string, agentId?: string): boolean {
  switch (focusedInputEchoReservationState.kind) {
    case 'idle':
      return false;
    case 'active':
      if (taskId !== undefined && focusedInputEchoReservationState.taskId !== taskId) {
        return false;
      }

      if (agentId !== undefined && focusedInputEchoReservationState.agentId !== agentId) {
        return false;
      }

      return true;
    default:
      return assertNever(
        focusedInputEchoReservationState,
        'Unhandled terminal focused-input echo reservation state',
      );
  }
}

export function noteTerminalFocusedInput(taskId: string, agentId?: string): void {
  if (taskId.length === 0 || TERMINAL_FOCUSED_INPUT_WINDOW_MS <= 0) {
    return;
  }

  const now = getTerminalFocusedInputNow();
  const nextExpiresAtMs = now + TERMINAL_FOCUSED_INPUT_WINDOW_MS;
  const nextEchoReservationExpiresAtMs = now + TERMINAL_FOCUSED_INPUT_ECHO_RESERVATION_WINDOW_MS;
  const focusedStateChanged =
    focusedInputState.kind !== 'active' ||
    focusedInputState.taskId !== taskId ||
    focusedInputState.agentId !== (agentId ?? null);
  const echoReservationStateChanged =
    focusedInputEchoReservationState.kind !== 'active' ||
    focusedInputEchoReservationState.taskId !== taskId ||
    focusedInputEchoReservationState.agentId !== (agentId ?? null);

  clearTerminalFocusedInputTimer();
  focusedInputState = {
    agentId: agentId ?? null,
    expiresAtMs: nextExpiresAtMs,
    kind: 'active',
    startedAtMs: now,
    taskId,
  };
  focusedInputTimer = setTimeout(() => {
    expireTerminalFocusedInputIfNeeded();
  }, TERMINAL_FOCUSED_INPUT_WINDOW_MS);
  clearTerminalFocusedInputEchoReservationTimer();
  focusedInputEchoReservationState = {
    agentId: agentId ?? null,
    expiresAtMs: nextEchoReservationExpiresAtMs,
    kind: 'active',
    taskId,
  };
  focusedInputEchoReservationTimer = setTimeout(() => {
    expireTerminalFocusedInputEchoReservationIfNeeded();
  }, TERMINAL_FOCUSED_INPUT_ECHO_RESERVATION_WINDOW_MS);

  if (focusedStateChanged || echoReservationStateChanged) {
    notifyTerminalFocusedInputListeners();
  }
}

export function completeTerminalFocusedInputEcho(taskId: string, agentId?: string): void {
  expireTerminalFocusedInputEchoReservationIfNeeded();
  if (!matchesFocusedInputEchoReservation(taskId, agentId)) {
    return;
  }

  clearTerminalFocusedInputEchoReservationState();
  notifyTerminalFocusedInputListeners();
}

export function clearTerminalFocusedInputAgent(agentId: string): void {
  expireTerminalFocusedInputIfNeeded();
  expireTerminalFocusedInputEchoReservationIfNeeded();
  let didChangeState = false;

  switch (focusedInputState.kind) {
    case 'idle':
      break;
    case 'active':
      if (focusedInputState.agentId === agentId) {
        clearTerminalFocusedInputState();
        didChangeState = true;
      }
      break;
    default:
      return assertNever(focusedInputState, 'Unhandled terminal focused-input state');
  }

  switch (focusedInputEchoReservationState.kind) {
    case 'idle':
      break;
    case 'active':
      if (focusedInputEchoReservationState.agentId === agentId) {
        clearTerminalFocusedInputEchoReservationState();
        didChangeState = true;
      }
      break;
    default:
      return assertNever(
        focusedInputEchoReservationState,
        'Unhandled terminal focused-input echo reservation state',
      );
  }

  if (didChangeState) {
    notifyTerminalFocusedInputListeners();
  }
}

export function settleTerminalFocusedInput(taskId: string, agentId?: string): void {
  expireTerminalFocusedInputIfNeeded();
  expireTerminalFocusedInputEchoReservationIfNeeded();
  let didChangeState = false;

  switch (focusedInputState.kind) {
    case 'idle':
      break;
    case 'active':
      if (matchesFocusedInput(taskId, agentId)) {
        clearTerminalFocusedInputState();
        didChangeState = true;
      }
      break;
    default:
      return assertNever(focusedInputState, 'Unhandled terminal focused-input state');
  }

  switch (focusedInputEchoReservationState.kind) {
    case 'idle':
      break;
    case 'active':
      if (matchesFocusedInputEchoReservation(taskId, agentId)) {
        clearTerminalFocusedInputEchoReservationState();
        didChangeState = true;
      }
      break;
    default:
      return assertNever(
        focusedInputEchoReservationState,
        'Unhandled terminal focused-input echo reservation state',
      );
  }

  if (didChangeState) {
    notifyTerminalFocusedInputListeners();
  }
}

export function isTerminalFocusedInputActive(taskId?: string, agentId?: string): boolean {
  expireTerminalFocusedInputIfNeeded();
  return matchesFocusedInput(taskId, agentId);
}

export function isTerminalFocusedInputEchoReservationActive(
  taskId?: string,
  agentId?: string,
): boolean {
  expireTerminalFocusedInputEchoReservationIfNeeded();
  return matchesFocusedInputEchoReservation(taskId, agentId);
}

export function isTerminalFocusedInputPromptSuppressionActive(agentId: string): boolean {
  return isTerminalFocusedInputActive(undefined, agentId);
}

export function isTerminalDenseFocusedInputProtectionActive(visibleTerminalCount: number): boolean {
  if (!isTerminalFocusedInputActive() || !isTerminalHighLoadModeEnabled()) {
    return false;
  }

  const denseOverloadMinimumVisibleCount = getTerminalExperimentDenseOverloadMinimumVisibleCount();
  if (denseOverloadMinimumVisibleCount <= 0) {
    return false;
  }

  return visibleTerminalCount >= denseOverloadMinimumVisibleCount;
}

export function getTerminalFocusedInputSnapshot(): TerminalFocusedInputSnapshot {
  expireTerminalFocusedInputIfNeeded();
  expireTerminalFocusedInputEchoReservationIfNeeded();
  const now = getTerminalFocusedInputNow();
  switch (focusedInputState.kind) {
    case 'idle':
      return {
        active: false,
        agentId: null,
        ageMs: 0,
        echoReservationActive: focusedInputEchoReservationState.kind === 'active',
        echoReservationRemainingMs:
          focusedInputEchoReservationState.kind === 'active'
            ? Math.max(0, focusedInputEchoReservationState.expiresAtMs - now)
            : 0,
        remainingMs: 0,
        taskId: null,
      };
    case 'active':
      return {
        active: true,
        agentId: focusedInputState.agentId,
        ageMs: Math.max(0, now - focusedInputState.startedAtMs),
        echoReservationActive:
          focusedInputEchoReservationState.kind === 'active' &&
          focusedInputEchoReservationState.taskId === focusedInputState.taskId &&
          focusedInputEchoReservationState.agentId === focusedInputState.agentId,
        echoReservationRemainingMs:
          focusedInputEchoReservationState.kind === 'active'
            ? Math.max(0, focusedInputEchoReservationState.expiresAtMs - now)
            : 0,
        remainingMs: Math.max(0, focusedInputState.expiresAtMs - now),
        taskId: focusedInputState.taskId,
      };
    default:
      return assertNever(focusedInputState, 'Unhandled terminal focused-input state');
  }
}

export function subscribeTerminalFocusedInputChanges(
  listener: TerminalFocusedInputListener,
): () => void {
  terminalFocusedInputListeners.add(listener);
  return function unsubscribe(): void {
    terminalFocusedInputListeners.delete(listener);
  };
}

export function resetTerminalFocusedInputForTests(): void {
  resetTerminalFocusedInputState();
  terminalFocusedInputListeners.clear();
}

export function resetTerminalFocusedInputState(): void {
  clearTerminalFocusedInputState();
  clearTerminalFocusedInputEchoReservationState();
}
