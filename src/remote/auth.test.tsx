import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('remote auth bootstrap', () => {
  async function loadAuthModule(): Promise<typeof import('./auth')> {
    vi.resetModules();
    return vi.importActual<typeof import('./auth')>('./auth');
  }

  beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    window.history.replaceState({}, '', '/remote');
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    window.history.replaceState({}, '', '/remote');
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
});
