import { isElectronRuntime } from './browser-auth';

let browserPagehidePending = false;
let cleanupBrowserPagehideListeners: (() => void) | null = null;

function handleBrowserPagehide(): void {
  browserPagehidePending = true;
}

function handleBrowserPageshow(): void {
  browserPagehidePending = false;
}

export function ensureBrowserPagehideTracking(): void {
  if (
    cleanupBrowserPagehideListeners !== null ||
    typeof window === 'undefined' ||
    isElectronRuntime()
  ) {
    return;
  }

  window.addEventListener('pagehide', handleBrowserPagehide);
  window.addEventListener('pageshow', handleBrowserPageshow);
  cleanupBrowserPagehideListeners = () => {
    window.removeEventListener('pagehide', handleBrowserPagehide);
    window.removeEventListener('pageshow', handleBrowserPageshow);
  };
}

export function isBrowserPagehidePending(): boolean {
  return browserPagehidePending;
}

export function resetBrowserPagehideStateForTests(): void {
  if (cleanupBrowserPagehideListeners !== null) {
    cleanupBrowserPagehideListeners();
    cleanupBrowserPagehideListeners = null;
  }
  browserPagehidePending = false;
}
