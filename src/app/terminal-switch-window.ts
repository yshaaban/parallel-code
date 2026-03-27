import { assertNever } from '../lib/assert-never';

export type TerminalSwitchWindowEndReason = 'cancelled' | 'completed' | 'replaced' | 'timed-out';
export type TerminalSwitchWindowPhase =
  | 'first-paint-pending'
  | 'input-ready-pending'
  | 'settled-pending'
  | 'inactive';

export interface TerminalSwitchWindowCompletion {
  durationMs: number;
  firstPaintDurationMs: number | null;
  inputReadyDurationMs: number | null;
  reason: TerminalSwitchWindowEndReason;
  taskId: string;
}

export interface TerminalSwitchWindowSnapshot {
  active: boolean;
  ageMs: number;
  firstPaintDurationMs: number | null;
  inputReadyDurationMs: number | null;
  lastCompletion: TerminalSwitchWindowCompletion | null;
  phase: TerminalSwitchWindowPhase;
  remainingMs: number;
  selectedRecoveryActive: boolean;
  targetTaskId: string | null;
}

interface TerminalSwitchWindowBaseState {
  ownerId: string | null;
  ownerPriority: number;
  owners: Map<string, number>;
  selectedRecoveryActive: boolean;
  settleDelayMs: number;
  startedAtMs: number;
  targetTaskId: string;
  timeoutAtMs: number;
}

type TerminalSwitchWindowState =
  | {
      kind: 'inactive';
    }
  | (TerminalSwitchWindowBaseState & {
      firstPaintAtMs: null;
      inputReadyAtMs: null;
      kind: 'first-paint-pending';
    })
  | (TerminalSwitchWindowBaseState & {
      firstPaintAtMs: number;
      inputReadyAtMs: null;
      kind: 'input-ready-pending';
    })
  | (TerminalSwitchWindowBaseState & {
      firstPaintAtMs: number;
      inputReadyAtMs: number;
      kind: 'settled-pending';
    });

type TerminalSwitchWindowActiveState = Exclude<TerminalSwitchWindowState, { kind: 'inactive' }>;
type TerminalSwitchWindowListener = () => void;

let switchWindowState: TerminalSwitchWindowState = { kind: 'inactive' };
let switchWindowTimer: ReturnType<typeof setTimeout> | undefined;
let lastSwitchWindowCompletion: TerminalSwitchWindowCompletion | null = null;
const switchWindowListeners = new Set<TerminalSwitchWindowListener>();

function getNowMs(): number {
  return typeof performance === 'undefined' ? 0 : performance.now();
}

function clearSwitchWindowTimer(): void {
  if (switchWindowTimer === undefined) {
    return;
  }

  clearTimeout(switchWindowTimer);
  switchWindowTimer = undefined;
}

function notifySwitchWindowListeners(): void {
  for (const listener of switchWindowListeners) {
    listener();
  }
}

function isActiveSwitchWindowState(
  state: TerminalSwitchWindowState,
): state is TerminalSwitchWindowActiveState {
  return state.kind !== 'inactive';
}

function getSwitchWindowDurationMs(
  startedAtMs: number,
  completedAtMs: number | null,
): number | null {
  if (completedAtMs === null) {
    return null;
  }

  return Math.max(0, completedAtMs - startedAtMs);
}

function getSwitchWindowPhase(
  activeWindow: TerminalSwitchWindowActiveState,
): TerminalSwitchWindowPhase {
  switch (activeWindow.kind) {
    case 'first-paint-pending':
    case 'input-ready-pending':
    case 'settled-pending':
      return activeWindow.kind;
    default:
      return assertNever(activeWindow, 'Unhandled terminal switch-window phase');
  }
}

function getSwitchWindowSettleAtMs(activeWindow: TerminalSwitchWindowActiveState): number | null {
  if (activeWindow.kind !== 'settled-pending') {
    return null;
  }

  if (activeWindow.settleDelayMs <= 0) {
    return null;
  }

  return activeWindow.inputReadyAtMs + activeWindow.settleDelayMs;
}

function getSwitchWindowDeadlineAtMs(activeWindow: TerminalSwitchWindowActiveState): number {
  const settleAtMs = getSwitchWindowSettleAtMs(activeWindow);
  if (settleAtMs === null) {
    return activeWindow.timeoutAtMs;
  }

  return Math.min(activeWindow.timeoutAtMs, settleAtMs);
}

function clearSwitchWindow(reason: TerminalSwitchWindowEndReason, expectedTaskId?: string): void {
  const activeWindow = switchWindowState;
  if (!isActiveSwitchWindowState(activeWindow)) {
    return;
  }

  if (expectedTaskId && activeWindow.targetTaskId !== expectedTaskId) {
    return;
  }

  clearSwitchWindowTimer();
  switchWindowState = { kind: 'inactive' };
  lastSwitchWindowCompletion = {
    durationMs: Math.max(0, getNowMs() - activeWindow.startedAtMs),
    firstPaintDurationMs: getSwitchWindowDurationMs(
      activeWindow.startedAtMs,
      activeWindow.firstPaintAtMs,
    ),
    inputReadyDurationMs: getSwitchWindowDurationMs(
      activeWindow.startedAtMs,
      activeWindow.inputReadyAtMs,
    ),
    reason,
    taskId: activeWindow.targetTaskId,
  };
  notifySwitchWindowListeners();
}

function matchesSwitchWindowOwner(
  activeWindow: TerminalSwitchWindowActiveState,
  ownerId?: string,
): boolean {
  if (ownerId === undefined) {
    return true;
  }

  return activeWindow.ownerId === ownerId;
}

function setSwitchWindowActiveOwner(activeWindow: TerminalSwitchWindowActiveState): boolean {
  let nextOwnerId: string | null = null;
  let nextOwnerPriority = 0;

  for (const [candidateOwnerId, candidatePriority] of activeWindow.owners) {
    if (
      nextOwnerId === null ||
      candidatePriority > nextOwnerPriority ||
      (candidatePriority === nextOwnerPriority && candidateOwnerId.localeCompare(nextOwnerId) < 0)
    ) {
      nextOwnerId = candidateOwnerId;
      nextOwnerPriority = candidatePriority;
    }
  }

  if (activeWindow.ownerId === nextOwnerId && activeWindow.ownerPriority === nextOwnerPriority) {
    return false;
  }

  activeWindow.ownerId = nextOwnerId;
  activeWindow.ownerPriority = nextOwnerPriority;
  return true;
}

function advanceSwitchWindow(expectedTaskId?: string): void {
  const activeWindow = switchWindowState;
  if (!isActiveSwitchWindowState(activeWindow)) {
    return;
  }

  if (expectedTaskId && activeWindow.targetTaskId !== expectedTaskId) {
    return;
  }

  const now = getNowMs();
  switch (activeWindow.kind) {
    case 'first-paint-pending':
    case 'input-ready-pending':
      if (now >= activeWindow.timeoutAtMs) {
        clearSwitchWindow('timed-out', activeWindow.targetTaskId);
      }
      return;
    case 'settled-pending': {
      const settleAtMs = getSwitchWindowSettleAtMs(activeWindow);
      if (settleAtMs !== null && now >= settleAtMs) {
        clearSwitchWindow('completed', activeWindow.targetTaskId);
        return;
      }

      if (now >= activeWindow.timeoutAtMs) {
        clearSwitchWindow('timed-out', activeWindow.targetTaskId);
      }
      return;
    }
    default:
      return assertNever(activeWindow, 'Unhandled terminal switch-window state');
  }
}

function scheduleSwitchWindowTimer(taskId: string): void {
  const activeWindow = switchWindowState;
  if (!isActiveSwitchWindowState(activeWindow) || activeWindow.targetTaskId !== taskId) {
    return;
  }

  clearSwitchWindowTimer();
  switchWindowTimer = globalThis.setTimeout(
    () => {
      advanceSwitchWindow(taskId);
    },
    Math.max(0, getSwitchWindowDeadlineAtMs(activeWindow) - getNowMs()),
  );
}

function clearExpiredSwitchWindow(): void {
  advanceSwitchWindow();
}

function createTerminalSwitchWindowState(
  taskId: string,
  timeoutMs: number,
  settleDelayMs: number,
  ownerId?: string,
  ownerPriority = 0,
): TerminalSwitchWindowActiveState {
  const startedAtMs = getNowMs();
  const owners = new Map<string, number>();
  if (ownerId) {
    owners.set(ownerId, Math.max(0, ownerPriority));
  }

  return {
    firstPaintAtMs: null,
    inputReadyAtMs: null,
    kind: 'first-paint-pending',
    ownerId: ownerId ?? null,
    ownerPriority: Math.max(0, ownerPriority),
    owners,
    selectedRecoveryActive: false,
    settleDelayMs: Math.max(0, settleDelayMs),
    startedAtMs,
    targetTaskId: taskId,
    timeoutAtMs: startedAtMs + timeoutMs,
  };
}

function updateSameTaskSwitchWindowOwner(
  activeWindow: TerminalSwitchWindowActiveState,
  timeoutMs: number,
  settleDelayMs: number,
  ownerId?: string,
  ownerPriority = 0,
): void {
  const now = getNowMs();
  activeWindow.timeoutAtMs = now + timeoutMs;
  activeWindow.settleDelayMs = Math.max(0, settleDelayMs);
  let didNotify = false;

  if (ownerId) {
    const nextOwnerPriority = Math.max(0, ownerPriority);
    const previousOwnerPriority = activeWindow.owners.get(ownerId);
    activeWindow.owners.set(ownerId, nextOwnerPriority);
    if (previousOwnerPriority !== nextOwnerPriority && setSwitchWindowActiveOwner(activeWindow)) {
      notifySwitchWindowListeners();
      didNotify = true;
    }
  }

  if (!didNotify) {
    notifySwitchWindowListeners();
  }

  scheduleSwitchWindowTimer(activeWindow.targetTaskId);
}

export function beginTerminalSwitchWindow(
  taskId: string,
  timeoutMs: number,
  settleDelayMs = 0,
  ownerId?: string,
  ownerPriority = 0,
): void {
  if (timeoutMs <= 0) {
    return;
  }

  clearExpiredSwitchWindow();
  if (isActiveSwitchWindowState(switchWindowState) && switchWindowState.targetTaskId === taskId) {
    updateSameTaskSwitchWindowOwner(
      switchWindowState,
      timeoutMs,
      settleDelayMs,
      ownerId,
      ownerPriority,
    );
    return;
  }

  if (isActiveSwitchWindowState(switchWindowState)) {
    clearSwitchWindow('replaced');
  }

  switchWindowState = createTerminalSwitchWindowState(
    taskId,
    timeoutMs,
    settleDelayMs,
    ownerId,
    ownerPriority,
  );
  scheduleSwitchWindowTimer(taskId);
  notifySwitchWindowListeners();
}

export function cancelTerminalSwitchWindow(taskId?: string, ownerId?: string): void {
  const activeWindow = switchWindowState;
  if (!isActiveSwitchWindowState(activeWindow)) {
    return;
  }

  if (taskId && activeWindow.targetTaskId !== taskId) {
    return;
  }

  if (ownerId !== undefined) {
    if (!activeWindow.owners.delete(ownerId)) {
      return;
    }

    if (activeWindow.owners.size > 0) {
      if (setSwitchWindowActiveOwner(activeWindow)) {
        notifySwitchWindowListeners();
      }
      return;
    }
  }

  clearSwitchWindow('cancelled', taskId);
}

export function completeTerminalSwitchWindow(taskId: string, ownerId?: string): void {
  const activeWindow = switchWindowState;
  if (!isActiveSwitchWindowState(activeWindow) || activeWindow.targetTaskId !== taskId) {
    return;
  }

  if (!matchesSwitchWindowOwner(activeWindow, ownerId)) {
    return;
  }

  clearSwitchWindow('completed', taskId);
}

export function markTerminalSwitchWindowFirstPaint(taskId: string, ownerId?: string): void {
  const activeWindow = switchWindowState;
  if (
    !isActiveSwitchWindowState(activeWindow) ||
    activeWindow.targetTaskId !== taskId ||
    activeWindow.kind !== 'first-paint-pending' ||
    !matchesSwitchWindowOwner(activeWindow, ownerId)
  ) {
    return;
  }

  switchWindowState = {
    ...activeWindow,
    firstPaintAtMs: getNowMs(),
    inputReadyAtMs: null,
    kind: 'input-ready-pending',
  };
  notifySwitchWindowListeners();
}

export function markTerminalSwitchWindowInputReady(taskId: string, ownerId?: string): void {
  const activeWindow = switchWindowState;
  if (
    !isActiveSwitchWindowState(activeWindow) ||
    activeWindow.targetTaskId !== taskId ||
    !matchesSwitchWindowOwner(activeWindow, ownerId)
  ) {
    return;
  }

  const now = getNowMs();
  const firstPaintAtMs =
    activeWindow.kind === 'first-paint-pending' ? now : activeWindow.firstPaintAtMs;
  const nextState: TerminalSwitchWindowActiveState = {
    ...activeWindow,
    firstPaintAtMs,
    inputReadyAtMs: now,
    kind: 'settled-pending',
  };

  if (activeWindow.settleDelayMs <= 0) {
    switchWindowState = nextState;
    clearSwitchWindow('completed', taskId);
    return;
  }

  switchWindowState = nextState;
  scheduleSwitchWindowTimer(taskId);
  notifySwitchWindowListeners();
}

export function markTerminalSwitchWindowRecoveryStarted(taskId: string, ownerId?: string): void {
  const activeWindow = switchWindowState;
  if (
    !isActiveSwitchWindowState(activeWindow) ||
    activeWindow.targetTaskId !== taskId ||
    activeWindow.selectedRecoveryActive ||
    !matchesSwitchWindowOwner(activeWindow, ownerId)
  ) {
    return;
  }

  switchWindowState = {
    ...activeWindow,
    selectedRecoveryActive: true,
  };
  notifySwitchWindowListeners();
}

export function markTerminalSwitchWindowRecoverySettled(taskId: string, ownerId?: string): void {
  const activeWindow = switchWindowState;
  if (
    !isActiveSwitchWindowState(activeWindow) ||
    activeWindow.targetTaskId !== taskId ||
    !activeWindow.selectedRecoveryActive ||
    !matchesSwitchWindowOwner(activeWindow, ownerId)
  ) {
    return;
  }

  switchWindowState = {
    ...activeWindow,
    selectedRecoveryActive: false,
  };
  notifySwitchWindowListeners();
}

export function getTerminalSwitchWindowSnapshot(): TerminalSwitchWindowSnapshot {
  clearExpiredSwitchWindow();
  switch (switchWindowState.kind) {
    case 'inactive':
      return {
        active: false,
        ageMs: 0,
        firstPaintDurationMs: null,
        inputReadyDurationMs: null,
        lastCompletion: lastSwitchWindowCompletion,
        phase: 'inactive',
        remainingMs: 0,
        selectedRecoveryActive: false,
        targetTaskId: null,
      };
    case 'first-paint-pending':
    case 'input-ready-pending':
    case 'settled-pending': {
      const now = getNowMs();
      const activeWindow = switchWindowState;
      return {
        active: true,
        ageMs: Math.max(0, now - activeWindow.startedAtMs),
        firstPaintDurationMs: getSwitchWindowDurationMs(
          activeWindow.startedAtMs,
          activeWindow.firstPaintAtMs,
        ),
        inputReadyDurationMs: getSwitchWindowDurationMs(
          activeWindow.startedAtMs,
          activeWindow.inputReadyAtMs,
        ),
        lastCompletion: lastSwitchWindowCompletion,
        phase: getSwitchWindowPhase(activeWindow),
        remainingMs: Math.max(0, getSwitchWindowDeadlineAtMs(activeWindow) - now),
        selectedRecoveryActive: activeWindow.selectedRecoveryActive,
        targetTaskId: activeWindow.targetTaskId,
      };
    }
    default:
      return assertNever(switchWindowState, 'Unhandled terminal switch-window snapshot state');
  }
}

export function isTerminalSwitchTarget(taskId: string, ownerId?: string): boolean {
  const activeWindow = switchWindowState;
  if (!isActiveSwitchWindowState(activeWindow)) {
    return false;
  }

  if (activeWindow.targetTaskId !== taskId) {
    return false;
  }

  if (ownerId === undefined) {
    return true;
  }

  return activeWindow.ownerId === ownerId;
}

export function isTerminalSwitchTargetTask(taskId: string): boolean {
  return isTerminalSwitchTarget(taskId);
}

export function isTerminalSwitchWindowOwner(taskId: string, ownerId: string): boolean {
  const activeWindow = switchWindowState;
  if (!isActiveSwitchWindowState(activeWindow)) {
    return false;
  }

  return activeWindow.targetTaskId === taskId && activeWindow.ownerId === ownerId;
}

export function isTerminalSwitchWindowActive(): boolean {
  return getTerminalSwitchWindowSnapshot().active;
}

export function isTerminalSwitchWindowAwaitingFirstPaint(): boolean {
  return getTerminalSwitchWindowSnapshot().phase === 'first-paint-pending';
}

export function isTerminalSwitchWindowAwaitingInputReady(): boolean {
  return getTerminalSwitchWindowSnapshot().phase === 'input-ready-pending';
}

export function isTerminalSwitchWindowSettling(): boolean {
  return getTerminalSwitchWindowSnapshot().phase === 'settled-pending';
}

export function isTerminalSwitchWindowTargetRecoveryActive(taskId?: string): boolean {
  const snapshot = getTerminalSwitchWindowSnapshot();
  if (!snapshot.selectedRecoveryActive) {
    return false;
  }

  if (taskId === undefined) {
    return true;
  }

  return snapshot.targetTaskId === taskId;
}

export function subscribeTerminalSwitchWindowChanges(
  listener: TerminalSwitchWindowListener,
): () => void {
  switchWindowListeners.add(listener);

  return function unsubscribe(): void {
    switchWindowListeners.delete(listener);
  };
}

export function resetTerminalSwitchWindowForTests(): void {
  clearSwitchWindowTimer();
  switchWindowState = { kind: 'inactive' };
  lastSwitchWindowCompletion = null;
  switchWindowListeners.clear();
}
