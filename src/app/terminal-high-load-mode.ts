import { getInitialTerminalHighLoadModeEnabled } from '../lib/terminal-high-load-mode-bootstrap';

type TerminalHighLoadModeListener = () => void;

let terminalHighLoadModeEnabled = getInitialTerminalHighLoadModeEnabled();
const terminalHighLoadModeListeners = new Set<TerminalHighLoadModeListener>();

function notifyTerminalHighLoadModeListeners(): void {
  for (const listener of terminalHighLoadModeListeners) {
    listener();
  }
}

function syncWindowTerminalHighLoadMode(enabled: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.__PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__ = enabled;
}

syncWindowTerminalHighLoadMode(terminalHighLoadModeEnabled);

export function isTerminalHighLoadModeEnabled(): boolean {
  return terminalHighLoadModeEnabled;
}

export function syncTerminalHighLoadMode(enabled: boolean): void {
  syncWindowTerminalHighLoadMode(enabled);
  if (terminalHighLoadModeEnabled === enabled) {
    return;
  }

  terminalHighLoadModeEnabled = enabled;
  notifyTerminalHighLoadModeListeners();
}

export function subscribeTerminalHighLoadModeChanges(
  listener: TerminalHighLoadModeListener,
): () => void {
  terminalHighLoadModeListeners.add(listener);
  return function unsubscribe(): void {
    terminalHighLoadModeListeners.delete(listener);
  };
}

export function resetTerminalHighLoadModeForTests(): void {
  terminalHighLoadModeEnabled = false;
  syncWindowTerminalHighLoadMode(false);
  terminalHighLoadModeListeners.clear();
}
