declare global {
  interface Window {
    __PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__?: boolean;
  }
}

export function getInitialTerminalHighLoadModeEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.__PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__ !== false;
}
