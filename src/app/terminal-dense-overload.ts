import {
  getTerminalFramePressureLevel,
  subscribeTerminalFramePressureChanges,
  type TerminalFramePressureLevel,
} from './terminal-frame-pressure';
import {
  getTerminalExperimentDenseOverloadMinimumVisibleCount,
  getTerminalExperimentDenseOverloadPressureFloor,
} from '../lib/terminal-performance-experiments';
import { getVisibleTerminalCount } from './terminal-visible-set';
import {
  isTerminalHighLoadModeEnabled,
  subscribeTerminalHighLoadModeChanges,
} from './terminal-high-load-mode';
import {
  isTerminalSwitchWindowTargetRecoveryActive,
  subscribeTerminalSwitchWindowChanges,
} from './terminal-switch-window';

function doesFramePressureMeetDenseOverloadFloor(
  framePressureLevel: TerminalFramePressureLevel,
): boolean {
  const pressureFloor = getTerminalExperimentDenseOverloadPressureFloor();
  if (pressureFloor === null) {
    return false;
  }

  if (pressureFloor === 'elevated') {
    return framePressureLevel === 'elevated' || framePressureLevel === 'critical';
  }

  return framePressureLevel === 'critical';
}

export function isTerminalDenseOverloadActive(
  visibleTerminalCount = getVisibleTerminalCount(),
): boolean {
  if (!isTerminalHighLoadModeEnabled()) {
    return false;
  }

  const minimumVisibleCount = getTerminalExperimentDenseOverloadMinimumVisibleCount();
  if (minimumVisibleCount <= 0 || visibleTerminalCount < minimumVisibleCount) {
    return false;
  }

  if (isTerminalSwitchWindowTargetRecoveryActive()) {
    return false;
  }

  return doesFramePressureMeetDenseOverloadFloor(getTerminalFramePressureLevel());
}

export function subscribeTerminalDenseOverloadChanges(listener: () => void): () => void {
  let active = isTerminalDenseOverloadActive();

  function notifyIfDenseOverloadChanged(): void {
    const nextActive = isTerminalDenseOverloadActive();
    if (nextActive === active) {
      return;
    }

    active = nextActive;
    listener();
  }

  const unsubscribeFramePressure = subscribeTerminalFramePressureChanges(
    notifyIfDenseOverloadChanged,
  );
  const unsubscribeHighLoadMode = subscribeTerminalHighLoadModeChanges(
    notifyIfDenseOverloadChanged,
  );
  const unsubscribeSwitchWindow = subscribeTerminalSwitchWindowChanges(
    notifyIfDenseOverloadChanged,
  );
  return function unsubscribe(): void {
    unsubscribeFramePressure();
    unsubscribeHighLoadMode();
    unsubscribeSwitchWindow();
  };
}
