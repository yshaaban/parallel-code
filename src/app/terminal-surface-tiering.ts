import {
  getTerminalExperimentDenseOverloadMinimumVisibleCount,
  getTerminalPerformanceExperimentConfig,
} from '../lib/terminal-performance-experiments';
import { getTerminalRecentHiddenReservedKeys } from './terminal-recent-hidden-reservation';
import { isTerminalHighLoadModeEnabled } from './terminal-high-load-mode';

interface TerminalSurfaceTierState {
  isFocused: boolean;
  isSelected: boolean;
  isVisible: boolean;
  lastIntentAtMs: number;
}

export interface TerminalSurfaceTierRegistration {
  noteIntent: () => void;
  unregister: () => void;
  update: (state: Omit<TerminalSurfaceTierState, 'lastIntentAtMs'>) => void;
}

export type TerminalSurfaceTier =
  | 'cold-hidden'
  | 'hot-hidden-live'
  | 'handoff-live'
  | 'interactive-live'
  | 'passive-visible';

const terminalSurfaceTierStates = new Map<string, TerminalSurfaceTierState>();
const terminalSurfaceTierListeners = new Set<() => void>();
const TERMINAL_RECENT_HIDDEN_RESERVATION_LIMIT = 2;
let lastTerminalSurfaceTierNow = 0;

function getTerminalSurfaceTierNow(): number {
  const candidateNow =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  const nextNow = Math.max(candidateNow, lastTerminalSurfaceTierNow + 1);

  lastTerminalSurfaceTierNow = nextNow;
  return nextNow;
}

function notifyTerminalSurfaceTierListeners(): void {
  for (const listener of terminalSurfaceTierListeners) {
    listener();
  }
}

function cloneTerminalSurfaceTierState(
  state: Omit<TerminalSurfaceTierState, 'lastIntentAtMs'>,
): TerminalSurfaceTierState {
  return {
    isFocused: state.isFocused,
    isSelected: state.isSelected,
    isVisible: state.isVisible,
    lastIntentAtMs: getTerminalSurfaceTierNow(),
  };
}

function promoteTerminalSurfaceTierIntent(key: string): void {
  const existingState = terminalSurfaceTierStates.get(key);
  if (!existingState) {
    return;
  }

  existingState.lastIntentAtMs = getTerminalSurfaceTierNow();
  notifyTerminalSurfaceTierListeners();
}

function isVisibleTerminalState(
  state: Pick<TerminalSurfaceTierState, 'isFocused' | 'isSelected' | 'isVisible'>,
): boolean {
  return state.isFocused || state.isVisible;
}

function getHotHiddenTerminalKeys(): Set<string> {
  const visibleTerminalCount = getVisibleTerminalCount();
  const hiddenTerminalHotCount =
    getTerminalPerformanceExperimentConfig().hiddenTerminalHotCount ?? 0;
  const reservedHiddenKeys = getReservedHiddenTerminalKeys(visibleTerminalCount);
  const hotHiddenTargetCount = Math.max(hiddenTerminalHotCount, reservedHiddenKeys.size);
  if (hotHiddenTargetCount <= 0) {
    return reservedHiddenKeys;
  }

  const rankedHiddenEntries = [...terminalSurfaceTierStates.entries()]
    .filter(([, state]) => !isVisibleTerminalState(state))
    .sort((left, right) => {
      const lastIntentDifference = right[1].lastIntentAtMs - left[1].lastIntentAtMs;
      if (lastIntentDifference !== 0) {
        return lastIntentDifference;
      }

      return left[0].localeCompare(right[0]);
    })
    .map(([key]) => key);
  const hotHiddenKeys = new Set(reservedHiddenKeys);
  if (hotHiddenKeys.size >= hotHiddenTargetCount) {
    return hotHiddenKeys;
  }

  for (const key of rankedHiddenEntries) {
    if (hotHiddenKeys.size >= hotHiddenTargetCount) {
      break;
    }

    if (hotHiddenKeys.has(key)) {
      continue;
    }

    hotHiddenKeys.add(key);
  }

  return hotHiddenKeys;
}

function getVisibleTerminalCount(): number {
  let visibleTerminalCount = 0;

  for (const state of terminalSurfaceTierStates.values()) {
    if (state.isVisible) {
      visibleTerminalCount += 1;
    }
  }

  return visibleTerminalCount;
}

function getReservedHiddenTerminalKeys(visibleTerminalCount: number): Set<string> {
  if (!shouldApplyRecentHiddenReservation(visibleTerminalCount)) {
    return new Set();
  }

  const reservedKeys = getTerminalRecentHiddenReservedKeys();
  if (reservedKeys.length === 0) {
    return new Set();
  }

  const hotHiddenReservedKeys = new Set<string>();
  for (const key of reservedKeys) {
    const state = terminalSurfaceTierStates.get(key);
    if (!state || isVisibleTerminalState(state)) {
      continue;
    }

    hotHiddenReservedKeys.add(key);
    if (hotHiddenReservedKeys.size >= TERMINAL_RECENT_HIDDEN_RESERVATION_LIMIT) {
      break;
    }
  }

  return hotHiddenReservedKeys;
}

function shouldApplyRecentHiddenReservation(visibleTerminalCount: number): boolean {
  if (!isTerminalHighLoadModeEnabled()) {
    return false;
  }

  const denseOverloadMinimumVisibleCount = getTerminalExperimentDenseOverloadMinimumVisibleCount();
  if (denseOverloadMinimumVisibleCount <= 0) {
    return false;
  }

  return visibleTerminalCount >= denseOverloadMinimumVisibleCount;
}

export function registerTerminalSurfaceTier(
  key: string,
  initialState: Omit<TerminalSurfaceTierState, 'lastIntentAtMs'>,
): TerminalSurfaceTierRegistration {
  terminalSurfaceTierStates.set(key, cloneTerminalSurfaceTierState(initialState));
  notifyTerminalSurfaceTierListeners();

  function noteIntent(): void {
    promoteTerminalSurfaceTierIntent(key);
  }

  function update(state: Omit<TerminalSurfaceTierState, 'lastIntentAtMs'>): void {
    const existingState = terminalSurfaceTierStates.get(key);
    const nextState = {
      ...state,
      lastIntentAtMs: existingState?.lastIntentAtMs ?? getTerminalSurfaceTierNow(),
    };
    terminalSurfaceTierStates.set(key, nextState);
    notifyTerminalSurfaceTierListeners();
  }

  function unregister(): void {
    terminalSurfaceTierStates.delete(key);
    notifyTerminalSurfaceTierListeners();
  }

  return {
    noteIntent,
    unregister,
    update,
  };
}

export function getTerminalSurfaceTier(key: string): TerminalSurfaceTier {
  const state = terminalSurfaceTierStates.get(key);
  if (!state) {
    return 'cold-hidden';
  }

  if (state.isFocused) {
    return 'interactive-live';
  }

  if (state.isSelected && state.isVisible) {
    return 'handoff-live';
  }

  if (state.isVisible) {
    return 'passive-visible';
  }

  return getHotHiddenTerminalKeys().has(key) ? 'hot-hidden-live' : 'cold-hidden';
}

export function subscribeTerminalSurfaceTierChanges(callback: () => void): () => void {
  terminalSurfaceTierListeners.add(callback);
  return () => {
    terminalSurfaceTierListeners.delete(callback);
  };
}

export function resetTerminalSurfaceTieringForTests(): void {
  terminalSurfaceTierStates.clear();
  terminalSurfaceTierListeners.clear();
  lastTerminalSurfaceTierNow = 0;
}
