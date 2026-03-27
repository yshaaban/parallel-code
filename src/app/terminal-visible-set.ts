export type TerminalVisibilityDensity = 'dense' | 'few' | 'single';

interface TerminalVisibilityState {
  isFocused: boolean;
  isSelected: boolean;
  isVisible: boolean;
}

export interface TerminalVisibilityRegistration {
  unregister: () => void;
  update: (state: TerminalVisibilityState) => void;
}

const terminalVisibilityStates = new Map<string, TerminalVisibilityState>();

function cloneTerminalVisibilityState(state: TerminalVisibilityState): TerminalVisibilityState {
  return {
    isFocused: state.isFocused,
    isSelected: state.isSelected,
    isVisible: state.isVisible,
  };
}

export function registerTerminalVisibility(
  key: string,
  initialState: TerminalVisibilityState,
): TerminalVisibilityRegistration {
  terminalVisibilityStates.set(key, cloneTerminalVisibilityState(initialState));

  function update(state: TerminalVisibilityState): void {
    terminalVisibilityStates.set(key, cloneTerminalVisibilityState(state));
  }

  function unregister(): void {
    terminalVisibilityStates.delete(key);
  }

  return {
    unregister,
    update,
  };
}

export function getVisibleTerminalCount(): number {
  let visibleTerminalCount = 0;

  for (const state of terminalVisibilityStates.values()) {
    if (state.isVisible) {
      visibleTerminalCount += 1;
    }
  }

  return visibleTerminalCount;
}

export function getTerminalVisibilityDensity(
  visibleTerminalCount = getVisibleTerminalCount(),
): TerminalVisibilityDensity {
  if (visibleTerminalCount <= 1) {
    return 'single';
  }

  if (visibleTerminalCount <= 4) {
    return 'few';
  }

  return 'dense';
}

export function resetTerminalVisibleSetForTests(): void {
  terminalVisibilityStates.clear();
}
