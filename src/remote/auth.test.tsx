import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REMOTE_TASK_CREATION_CREDENTIAL_STORAGE_KEY } from './task-creation-credentials';

describe('remote auth bootstrap', () => {
  function sessionBootstrap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      capabilities: {
        commands: ['task-notes.get', 'task-notes.issue', 'task-notes.update'],
        mutationAdmission: 'open',
      },
      csrf: 'a'.repeat(43),
      ...overrides,
    };
  }

  async function loadAuthModule(): Promise<typeof import('./auth')> {
    vi.resetModules();
    return vi.importActual<typeof import('./auth')>('./auth');
  }

  beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/remote');
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/remote');
    vi.unstubAllGlobals();
  });

  it('persists a token from the URL and strips it from the address bar', async () => {
    window.history.replaceState({}, '', '/remote?token=test-token');

    const auth = await loadAuthModule();

    expect(auth.getToken()).toBe('test-token');
    expect(window.location.search).toBe('');
  });

  it('returns a stored token when initialized after bootstrap', async () => {
    localStorage.setItem('parallel-code-token', 'stored-token');

    const auth = await loadAuthModule();

    expect(auth.initAuth()).toBe('stored-token');
  });

  it('adopts a secure cookie session, retains CSRF only in memory, and clears legacy tokens', async () => {
    localStorage.setItem('parallel-code-token', 'stale-token');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(sessionBootstrap()), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuthModule();

    await expect(auth.initializeRemoteAuthSession()).resolves.toBe('scoped');
    expect(auth.getToken()).toBeNull();
    expect(auth.getRemoteCsrfToken()).toBe('a'.repeat(43));
    expect(auth.getRemoteSessionCapabilities()).toEqual({
      commands: ['task-notes.get', 'task-notes.issue', 'task-notes.update'],
      mutationAdmission: 'open',
    });
    expect(Object.isFrozen(auth.getRemoteSessionCapabilities())).toBe(true);
    expect(Object.isFrozen(auth.getRemoteSessionCapabilities()?.commands)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/remote/auth/session',
      expect.objectContaining({ credentials: 'same-origin', method: 'GET' }),
    );
  });

  it('uses the unnamespaced secure-session route for the dedicated remote host', async () => {
    window.history.replaceState({}, '', '/');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify(
          sessionBootstrap({
            capabilities: { commands: [], mutationAdmission: 'draining' },
            csrf: 'b'.repeat(43),
          }),
        ),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuthModule();

    await expect(auth.initializeRemoteAuthSession()).resolves.toBe('scoped');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({ credentials: 'same-origin', method: 'GET' }),
    );
  });

  it('fails closed onto scoped transport when the standalone session exists but expired', async () => {
    localStorage.setItem('parallel-code-token', 'must-not-cross-authority');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: 'unauthenticated' }), {
          headers: { 'content-type': 'application/json' },
          status: 401,
        }),
      ),
    );
    const auth = await loadAuthModule();

    await expect(auth.initializeRemoteAuthSession()).resolves.toBe('scoped');
    expect(auth.isScopedRemoteSessionActive()).toBe(true);
    expect(auth.getToken()).toBeNull();
    expect(auth.getRemoteCsrfToken()).toBeNull();
    expect(auth.getRemoteSessionCapabilities()).toBeNull();
    await expect(auth.redirectToRemoteAuthGate()).resolves.toBe(false);
  });

  it('keeps legacy authentication when the scoped session route is absent', async () => {
    localStorage.setItem('parallel-code-token', 'legacy-token');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuthModule();

    await expect(auth.initializeRemoteAuthSession()).resolves.toBe('legacy');
    expect(auth.getToken()).toBe('legacy-token');
    expect(auth.getRemoteCsrfToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['array capability envelope', []],
    ['unknown capability field', { commands: [], mutationAdmission: 'open', unexpected: true }],
    ['unknown command', { commands: ['terminal.superuser'], mutationAdmission: 'open' }],
    [
      'duplicate command',
      { commands: ['task-notes.get', 'task-notes.get'], mutationAdmission: 'open' },
    ],
    ['unknown admission state', { commands: [], mutationAdmission: 'paused' }],
  ])('rejects a malformed %s without retaining authority', async (_label, capabilities) => {
    localStorage.setItem('parallel-code-token', 'must-not-cross-authority');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(sessionBootstrap({ capabilities })), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      ),
    );
    const auth = await loadAuthModule();

    await expect(auth.initializeRemoteAuthSession()).resolves.toBe('scoped');
    expect(auth.getRemoteCsrfToken()).toBeNull();
    expect(auth.getRemoteSessionCapabilities()).toBeNull();
    expect(auth.getToken()).toBeNull();
  });

  it('clears the retained snapshot before a re-probe and on logout', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sessionBootstrap()), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuthModule();

    await auth.initializeRemoteAuthSession();
    expect(auth.getRemoteSessionCapabilities()).not.toBeNull();
    await auth.initializeRemoteAuthSession();
    expect(auth.getRemoteSessionCapabilities()).toBeNull();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(sessionBootstrap()), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await auth.initializeRemoteAuthSession();
    await auth.logoutRemoteSession();
    expect(auth.getRemoteSessionCapabilities()).toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/remote/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not restore authority from a bootstrap response that settles after logout', async () => {
    let resolveSession!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveSession = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuthModule();

    const pendingBootstrap = auth.initializeRemoteAuthSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await auth.logoutRemoteSession();
    resolveSession(
      new Response(JSON.stringify(sessionBootstrap()), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );

    await expect(pendingBootstrap).resolves.toBe('legacy');
    expect(auth.getRemoteCsrfToken()).toBeNull();
    expect(auth.getRemoteSessionCapabilities()).toBeNull();
    expect(auth.isScopedRemoteSessionActive()).toBe(false);
  });

  it('clears pending creation authority on logout without clearing identity or preferences', async () => {
    sessionStorage.setItem(REMOTE_TASK_CREATION_CREDENTIAL_STORAGE_KEY, 'pending-secret');
    sessionStorage.setItem('parallel-code-client-id', 'client-identity');
    localStorage.setItem('parallel-code.remote-new-task-preferences.v1', '{"projectId":"one"}');
    vi.stubGlobal('fetch', undefined);
    const auth = await loadAuthModule();

    await auth.logoutRemoteSession();

    expect(sessionStorage.getItem(REMOTE_TASK_CREATION_CREDENTIAL_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('parallel-code-client-id')).toBe('client-identity');
    expect(localStorage.getItem('parallel-code.remote-new-task-preferences.v1')).toBe(
      '{"projectId":"one"}',
    );
  });
});
