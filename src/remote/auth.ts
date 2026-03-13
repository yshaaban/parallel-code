import { redirectToBrowserAuth } from '../lib/browser-auth';

const TOKEN_KEY = 'parallel-code-token';

function bootstrapTokenFromUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');

  if (urlToken) {
    try {
      localStorage.setItem(TOKEN_KEY, urlToken);
    } catch {
      return null;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.pathname + url.search);
    return urlToken;
  }

  return null;
}

bootstrapTokenFromUrl();

/** Initialize remote auth state from URL bootstrap if needed. */
export function initAuth(): string | null {
  return getToken();
}

/** Get the stored token. */
export function getToken(): string | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  return localStorage.getItem(TOKEN_KEY);
}

/** Clear stored token. */
export function clearToken(): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  localStorage.removeItem(TOKEN_KEY);
}

export async function redirectToRemoteAuthGate(nextPath = '/remote'): Promise<boolean> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return false;
  }

  try {
    const response = await fetch('/auth', {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'manual',
    });
    if (response.status === 200 || response.status === 401) {
      redirectToBrowserAuth(nextPath);
      return true;
    }
  } catch {
    return false;
  }

  return false;
}
