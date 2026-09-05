import { redirectToBrowserAuth } from '../lib/browser-auth';
import {
  getSafeLocalStorage,
  getSafeStorageItem,
  removeSafeStorageItem,
  setSafeStorageItem,
} from '../lib/browser-storage';
import { clearRemoteTaskCreationCredential } from './task-creation-credentials';

const TOKEN_KEY = 'parallel-code-token';
const CSRF_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const REMOTE_SESSION_COMMANDS = [
  'task-catalog.get-deltas',
  'task-catalog.get-manifest',
  'task-catalog.get-page',
  'task-creation.cancel',
  'task-creation.create',
  'task-creation.get',
  'task-creation.get-capabilities',
  'task-creation.get-picker-page',
  'task-creation.get-worktree-link-candidates',
  'task-creation.issue',
  'task-creation.retry-shell',
  'task-notes.get',
  'task-notes.issue',
  'task-notes.update',
  'terminal.acquire-control',
  'terminal.attach',
  'terminal.detach',
  'terminal.input',
  'terminal.kill',
  'terminal.pause',
  'terminal.release-control',
  'terminal.resize',
  'terminal.resume',
] as const;

export type RemoteSessionCommand = (typeof REMOTE_SESSION_COMMANDS)[number];

export interface RemoteSessionCapabilitySnapshot {
  readonly commands: readonly RemoteSessionCommand[];
  readonly mutationAdmission: 'draining' | 'open';
}

const REMOTE_SESSION_COMMAND_SET = new Set<string>(REMOTE_SESSION_COMMANDS);

interface RemoteAuthPaths {
  logout: string;
  session: string;
}

const DEFAULT_REMOTE_AUTH_PATHS = Object.freeze({
  logout: '/api/auth/logout',
  session: '/api/auth/session',
}) satisfies RemoteAuthPaths;
const STANDALONE_REMOTE_AUTH_PATHS = Object.freeze({
  logout: '/api/remote/auth/logout',
  session: '/api/remote/auth/session',
}) satisfies RemoteAuthPaths;

let csrfToken: string | null = null;
let remoteAuthMode: 'legacy' | 'scoped' = 'legacy';
let activeRemoteAuthPaths: RemoteAuthPaths = DEFAULT_REMOTE_AUTH_PATHS;
let remoteSessionCapabilities: RemoteSessionCapabilitySnapshot | null = null;
let remoteAuthGeneration = 0;

function isStandaloneRemoteLocation(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname === '/remote' || window.location.pathname.startsWith('/remote/');
}

function getRemoteAuthPathCandidates(): readonly RemoteAuthPaths[] {
  return isStandaloneRemoteLocation()
    ? [STANDALONE_REMOTE_AUTH_PATHS, DEFAULT_REMOTE_AUTH_PATHS]
    : [DEFAULT_REMOTE_AUTH_PATHS];
}

function bootstrapTokenFromUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');

  if (urlToken) {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return null;
    }

    if (!setSafeStorageItem(storage, TOKEN_KEY, urlToken)) {
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
  return getSafeStorageItem(getSafeLocalStorage(), TOKEN_KEY);
}

/** Clear stored token. */
export function clearToken(): void {
  removeSafeStorageItem(getSafeLocalStorage(), TOKEN_KEY);
}

export function getRemoteCsrfToken(): string | null {
  return csrfToken;
}

export function isScopedRemoteSessionActive(): boolean {
  return remoteAuthMode === 'scoped';
}

export function getRemoteSessionCapabilities(): RemoteSessionCapabilitySnapshot | null {
  return remoteSessionCapabilities;
}

export function remoteSessionAllows(command: RemoteSessionCommand): boolean {
  return remoteSessionCapabilities?.commands.includes(command) === true;
}

function readCapabilities(value: unknown): RemoteSessionCapabilitySnapshot | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2
  ) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.commands) ||
    (record.mutationAdmission !== 'open' && record.mutationAdmission !== 'draining')
  ) {
    return null;
  }

  const commands: RemoteSessionCommand[] = [];
  const seen = new Set<string>();
  for (const command of record.commands) {
    if (
      typeof command !== 'string' ||
      !REMOTE_SESSION_COMMAND_SET.has(command) ||
      seen.has(command)
    ) {
      return null;
    }
    seen.add(command);
    commands.push(command as RemoteSessionCommand);
  }

  return Object.freeze({
    commands: Object.freeze(commands),
    mutationAdmission: record.mutationAdmission,
  });
}

function readSessionBootstrap(
  value: unknown,
): { capabilities: RemoteSessionCapabilitySnapshot; csrf: string } | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.csrf !== 'string' || !CSRF_PATTERN.test(record.csrf)) return null;
  const capabilities = readCapabilities(record.capabilities);
  return capabilities ? { capabilities, csrf: record.csrf } : null;
}

/**
 * Adopts the short-lived secure cookie session before WebSocket creation.
 * Legacy token mode remains available only when the host has no scoped route.
 */
export async function initializeRemoteAuthSession(): Promise<'legacy' | 'scoped'> {
  const generation = ++remoteAuthGeneration;
  csrfToken = null;
  remoteSessionCapabilities = null;
  if (typeof fetch !== 'function') {
    remoteAuthMode = 'legacy';
    return remoteAuthMode;
  }
  for (const paths of getRemoteAuthPathCandidates()) {
    try {
      const response = await fetch(paths.session, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        method: 'GET',
      });
      if (generation !== remoteAuthGeneration) return remoteAuthMode;
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        if (generation !== remoteAuthGeneration) return remoteAuthMode;
        const session = readSessionBootstrap(payload);
        if (session) {
          activeRemoteAuthPaths = paths;
          csrfToken = session.csrf;
          remoteSessionCapabilities = session.capabilities;
          clearToken();
          remoteAuthMode = 'scoped';
          return remoteAuthMode;
        }
      }

      const routeExists =
        response.status !== 404 &&
        (paths === STANDALONE_REMOTE_AUTH_PATHS ||
          response.headers.get('content-type')?.includes('application/json') === true);
      if (routeExists) {
        activeRemoteAuthPaths = paths;
        clearToken();
        remoteAuthMode = 'scoped';
        return remoteAuthMode;
      }
    } catch {
      if (generation !== remoteAuthGeneration) return remoteAuthMode;
      // A failed probe does not prove which host owns the page. Preserve the
      // legacy fallback only after every applicable endpoint has been tried.
    }
  }
  if (generation !== remoteAuthGeneration) return remoteAuthMode;
  activeRemoteAuthPaths = DEFAULT_REMOTE_AUTH_PATHS;
  remoteAuthMode = 'legacy';
  return remoteAuthMode;
}

export async function logoutRemoteSession(): Promise<void> {
  remoteAuthGeneration += 1;
  const csrf = csrfToken;
  csrfToken = null;
  remoteSessionCapabilities = null;
  remoteAuthMode = 'legacy';
  clearToken();
  clearRemoteTaskCreationCredential();
  if (!csrf || typeof fetch !== 'function') return;
  await fetch(activeRemoteAuthPaths.logout, {
    credentials: 'same-origin',
    headers: { 'X-Parallel-Code-CSRF': csrf },
    method: 'POST',
  }).then(
    () => undefined,
    () => undefined,
  );
}

export async function redirectToRemoteAuthGate(nextPath = '/remote'): Promise<boolean> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return false;
  }
  if (remoteAuthMode === 'scoped') return false;

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
