import { getPersistentClientId } from './client-id';

const TOKEN_KEY = 'parallel-code-token';
const CLIENT_ID_KEY = 'parallel-code-client-id';

let browserTokenInitialized = false;

function initBrowserToken(): void {
  if (
    browserTokenInitialized ||
    typeof window === 'undefined' ||
    typeof localStorage === 'undefined'
  ) {
    return;
  }

  browserTokenInitialized = true;

  const url = new URL(window.location.href);
  const urlToken = url.searchParams.get('token');
  if (!urlToken) {
    return;
  }

  localStorage.setItem(TOKEN_KEY, urlToken);
  url.searchParams.delete('token');
  window.history.replaceState({}, '', url.pathname + url.search);
}

export function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && typeof window.electron?.ipcRenderer !== 'undefined';
}

export function getBrowserToken(): string | null {
  initBrowserToken();
  if (typeof localStorage === 'undefined') {
    return null;
  }

  return localStorage.getItem(TOKEN_KEY);
}

export function clearBrowserToken(): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return;
  }

  localStorage.removeItem(TOKEN_KEY);
}

export function getBrowserClientId(): string {
  return getPersistentClientId(CLIENT_ID_KEY, 'server');
}
