import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('git cache sweeping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('drops expired git query entries so the loader runs again', async () => {
    const { sweepExpiredGitCacheEntries, withGitQueryCache } = await import('./git-cache.js');
    const loader = vi.fn().mockResolvedValue('value');

    await withGitQueryCache('git-query:test', loader);
    expect(loader).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-03-21T00:00:06Z'));
    sweepExpiredGitCacheEntries();

    await withGitQueryCache('git-query:test', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('drops expired main-branch entries during a sweep', async () => {
    const { getCachedMainBranch, setCachedMainBranch, sweepExpiredGitCacheEntries } =
      await import('./git-cache.js');

    setCachedMainBranch('/repo', 'main');
    expect(getCachedMainBranch('/repo')).toBe('main');

    vi.setSystemTime(new Date('2026-03-21T00:01:01Z'));
    sweepExpiredGitCacheEntries();

    expect(getCachedMainBranch('/repo')).toBeNull();
  });

  it('does not sweep an expired in-flight git query entry', async () => {
    const { sweepExpiredGitCacheEntries, withGitQueryCache } = await import('./git-cache.js');
    let resolveLoader: ((value: string) => void) | undefined;
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoader = resolve;
        }),
    );

    const firstPromise = withGitQueryCache('git-query:pending', loader);
    const secondPromise = withGitQueryCache('git-query:pending', loader);

    expect(loader).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-03-21T00:00:06Z'));
    sweepExpiredGitCacheEntries();

    const thirdPromise = withGitQueryCache('git-query:pending', loader);

    expect(loader).toHaveBeenCalledTimes(1);

    resolveLoader?.('value');
    await expect(firstPromise).resolves.toBe('value');
    await expect(secondPromise).resolves.toBe('value');
    await expect(thirdPromise).resolves.toBe('value');
  });
});
