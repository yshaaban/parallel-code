export type TerminalVisibilityDensity = 'dense' | 'few' | 'single';

interface TerminalVisibilityState {
  isFocused: boolean;
  isSelected: boolean;
  isVisible: boolean;
  registrationId: number;
}

export interface TerminalVisibilityRegistration {
  unregister: () => void;
  update: (state: Omit<TerminalVisibilityState, 'registrationId'>) => void;
}

const terminalVisibilityStates = new Map<string, TerminalVisibilityState>();
let nextTerminalVisibilityRegistrationId = 1;

function cloneTerminalVisibilityState(
  state: Omit<TerminalVisibilityState, 'registrationId'>,
  registrationId: number,
): TerminalVisibilityState {
  return {
    isFocused: state.isFocused,
    isSelected: state.isSelected,
    isVisible: state.isVisible,
    registrationId,
  };
}

export function registerTerminalVisibility(
  key: string,
  initialState: Omit<TerminalVisibilityState, 'registrationId'>,
): TerminalVisibilityRegistration {
  const registrationId = nextTerminalVisibilityRegistrationId;
  nextTerminalVisibilityRegistrationId += 1;
  terminalVisibilityStates.set(key, cloneTerminalVisibilityState(initialState, registrationId));

  function update(state: Omit<TerminalVisibilityState, 'registrationId'>): void {
    if (terminalVisibilityStates.get(key)?.registrationId !== registrationId) {
      return;
    }

    terminalVisibilityStates.set(key, cloneTerminalVisibilityState(state, registrationId));
  }

  function unregister(): void {
    if (terminalVisibilityStates.get(key)?.registrationId !== registrationId) {
      return;
    }

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
  nextTerminalVisibilityRegistrationId = 1;
}
