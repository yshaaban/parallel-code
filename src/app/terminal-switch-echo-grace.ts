import { assertNever } from '../lib/assert-never';

export type TerminalSwitchEchoGraceEndReason = 'cancelled' | 'completed' | 'replaced' | 'timed-out';

export interface TerminalSwitchEchoGraceCompletion {
  durationMs: number;
  reason: TerminalSwitchEchoGraceEndReason;
  taskId: string;
}

export interface TerminalSwitchEchoGraceSnapshot {
  active: boolean;
  ageMs: number;
  lastCompletion: TerminalSwitchEchoGraceCompletion | null;
  remainingMs: number;
  targetTaskId: string | null;
}

type TerminalSwitchEchoGraceState =
  | {
      kind: 'idle';
    }
  | {
      kind: 'pending';
      startedAtMs: number;
      targetTaskId: string;
      timeoutAtMs: number;
    }
  | {
      activatedAtMs: number;
      kind: 'active';
      startedAtMs: number;
      targetTaskId: string;
      timeoutAtMs: number;
    };

type TerminalSwitchEchoGraceListener = () => void;

let switchEchoGraceState: TerminalSwitchEchoGraceState = { kind: 'idle' };
let switchEchoGraceTimer: ReturnType<typeof setTimeout> | undefined;
let lastSwitchEchoGraceCompletion: TerminalSwitchEchoGraceCompletion | null = null;
const switchEchoGraceListeners = new Set<TerminalSwitchEchoGraceListener>();

function getNowMs(): number {
  return typeof performance === 'undefined' ? 0 : performance.now();
}

function clearSwitchEchoGraceTimer(): void {
  if (switchEchoGraceTimer === undefined) {
    return;
  }

  clearTimeout(switchEchoGraceTimer);
  switchEchoGraceTimer = undefined;
}

function notifySwitchEchoGraceListeners(): void {
  for (const listener of switchEchoGraceListeners) {
    listener();
  }
}

function clearSwitchEchoGrace(
  reason: TerminalSwitchEchoGraceEndReason,
  expectedTaskId?: string,
): void {
  const activeGrace = switchEchoGraceState;
  switch (activeGrace.kind) {
    case 'idle':
      return;
    case 'pending':
    case 'active':
      if (expectedTaskId && activeGrace.targetTaskId !== expectedTaskId) {
        return;
      }

      clearSwitchEchoGraceTimer();
      switchEchoGraceState = { kind: 'idle' };
      lastSwitchEchoGraceCompletion = {
        durationMs: Math.max(0, getNowMs() - activeGrace.startedAtMs),
        reason,
        taskId: activeGrace.targetTaskId,
      };
      notifySwitchEchoGraceListeners();
      return;
    default:
      return assertNever(activeGrace, 'Unhandled terminal switch-echo-grace state');
  }
}

function advanceSwitchEchoGrace(expectedTaskId?: string): void {
  const activeGrace = switchEchoGraceState;
  switch (activeGrace.kind) {
    case 'idle':
      return;
    case 'pending':
    case 'active':
      if (expectedTaskId && activeGrace.targetTaskId !== expectedTaskId) {
        return;
      }

      if (getNowMs() >= activeGrace.timeoutAtMs) {
        clearSwitchEchoGrace('timed-out', activeGrace.targetTaskId);
      }
      return;
    default:
      return assertNever(activeGrace, 'Unhandled terminal switch-echo-grace state');
  }
}

export function activateTerminalSwitchEchoGrace(taskId: string): void {
  const activeGrace = switchEchoGraceState;
  switch (activeGrace.kind) {
    case 'idle':
      return;
    case 'pending':
      if (activeGrace.targetTaskId !== taskId) {
        return;
      }

      switchEchoGraceState = {
        activatedAtMs: getNowMs(),
        kind: 'active',
        startedAtMs: activeGrace.startedAtMs,
        targetTaskId: activeGrace.targetTaskId,
        timeoutAtMs: activeGrace.timeoutAtMs,
      };
      notifySwitchEchoGraceListeners();
      return;
    case 'active':
      return;
    default:
      return assertNever(activeGrace, 'Unhandled terminal switch-echo-grace state');
  }
}

function scheduleSwitchEchoGraceTimer(taskId: string): void {
  const activeGrace = switchEchoGraceState;
  switch (activeGrace.kind) {
    case 'idle':
      return;
    case 'pending':
    case 'active':
      if (activeGrace.targetTaskId !== taskId) {
        return;
      }

      clearSwitchEchoGraceTimer();
      switchEchoGraceTimer = globalThis.setTimeout(
        () => {
          advanceSwitchEchoGrace(taskId);
        },
        Math.max(0, activeGrace.timeoutAtMs - getNowMs()),
      );
      return;
    default:
      return assertNever(activeGrace, 'Unhandled terminal switch-echo-grace state');
  }
}

function clearExpiredSwitchEchoGrace(): void {
  advanceSwitchEchoGrace();
}

export function beginTerminalSwitchEchoGrace(taskId: string, timeoutMs: number): void {
  if (timeoutMs <= 0) {
    return;
  }

  clearExpiredSwitchEchoGrace();
  if (switchEchoGraceState.kind !== 'idle') {
    clearSwitchEchoGrace('replaced');
  }

  const startedAtMs = getNowMs();
  switchEchoGraceState = {
    kind: 'pending',
    startedAtMs,
    targetTaskId: taskId,
    timeoutAtMs: startedAtMs + timeoutMs,
  };
  scheduleSwitchEchoGraceTimer(taskId);
  notifySwitchEchoGraceListeners();
}

export function cancelTerminalSwitchEchoGrace(taskId?: string): void {
  clearSwitchEchoGrace('cancelled', taskId);
}

export function completeTerminalSwitchEchoGrace(taskId: string): void {
  clearSwitchEchoGrace('completed', taskId);
}

export function isTerminalSwitchEchoGraceActive(): boolean {
  clearExpiredSwitchEchoGrace();
  switch (switchEchoGraceState.kind) {
    case 'idle':
    case 'pending':
      return false;
    case 'active':
      return true;
    default:
      return assertNever(switchEchoGraceState, 'Unhandled terminal switch-echo-grace state');
  }
}

export function isTerminalSwitchEchoGraceActiveForTask(taskId: string): boolean {
  clearExpiredSwitchEchoGrace();
  switch (switchEchoGraceState.kind) {
    case 'idle':
    case 'pending':
      return false;
    case 'active':
      return switchEchoGraceState.targetTaskId === taskId;
    default:
      return assertNever(switchEchoGraceState, 'Unhandled terminal switch-echo-grace state');
  }
}

export function getTerminalSwitchEchoGraceSnapshot(): TerminalSwitchEchoGraceSnapshot {
  clearExpiredSwitchEchoGrace();
  const activeGrace = switchEchoGraceState;
  switch (activeGrace.kind) {
    case 'idle':
      return {
        active: false,
        ageMs: 0,
        lastCompletion: lastSwitchEchoGraceCompletion,
        remainingMs: 0,
        targetTaskId: null,
      };
    case 'pending':
    case 'active': {
      const now = getNowMs();
      return {
        active: activeGrace.kind === 'active',
        ageMs: Math.max(0, now - activeGrace.startedAtMs),
        lastCompletion: lastSwitchEchoGraceCompletion,
        remainingMs: Math.max(0, activeGrace.timeoutAtMs - now),
        targetTaskId: activeGrace.targetTaskId,
      };
    }
    default:
      return assertNever(activeGrace, 'Unhandled terminal switch-echo-grace state');
  }
}

export function subscribeTerminalSwitchEchoGraceChanges(
  listener: TerminalSwitchEchoGraceListener,
): () => void {
  switchEchoGraceListeners.add(listener);
  return () => {
    switchEchoGraceListeners.delete(listener);
  };
}

export function resetTerminalSwitchEchoGraceForTests(): void {
  clearSwitchEchoGraceTimer();
  switchEchoGraceState = { kind: 'idle' };
  lastSwitchEchoGraceCompletion = null;
  switchEchoGraceListeners.clear();
}
