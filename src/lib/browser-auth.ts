import { getPersistentClientId } from './client-id';

const LEGACY_TOKEN_KEY = 'parallel-code-token';
const CLIENT_ID_KEY = 'parallel-code-client-id';
const AUTH_GATE_PATH = '/auth';

function clearLegacyStoredToken(): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

function getCurrentBrowserPath(): string {
  if (typeof window === 'undefined') {
    return '/';
  }

  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && typeof window.electron?.ipcRenderer !== 'undefined';
}

export function getBrowserClientId(): string {
  return getPersistentClientId(CLIENT_ID_KEY, 'server');
}

export function getBrowserToken(): string | null {
  return null;
}

export function clearBrowserToken(): void {
  clearLegacyStoredToken();
}

export function redirectToBrowserAuth(nextPath = getCurrentBrowserPath()): void {
  if (typeof window === 'undefined') {
    return;
  }

  const url = new URL(AUTH_GATE_PATH, window.location.origin);
  url.searchParams.set('next', nextPath);
  if (typeof window.location.replace === 'function') {
    window.location.replace(url.toString());
    return;
  }

  window.location.href = url.toString();
}

export function clearLegacyBrowserAuth(): void {
  clearLegacyStoredToken();
}
