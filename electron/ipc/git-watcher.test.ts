import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execGitMock } = vi.hoisted(() => ({
  execGitMock: vi.fn(),
}));

vi.mock('./git-exec.js', () => ({
  execGit: execGitMock,
}));

import { startGitWatcher, stopAllGitWatchers, stopGitWatcher } from './git-watcher.js';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createFakeWatcher(): fs.FSWatcher {
  const watcher = {
    close: vi.fn(),
    on: vi.fn(),
  };
  watcher.on.mockReturnValue(watcher);
  return watcher as unknown as fs.FSWatcher;
}

describe('git watcher lifecycle', () => {
  let watchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    execGitMock.mockReset();
    watchSpy = vi.spyOn(fs, 'watch').mockImplementation(() => createFakeWatcher());
  });

  afterEach(() => {
    stopAllGitWatchers();
    watchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('coalesces concurrent starts for one task and keeps the latest listener', async () => {
    const gitDir = createDeferred<{ stdout: string }>();
    execGitMock.mockReturnValueOnce(gitDir.promise);
    const firstListener = vi.fn();
    const latestListener = vi.fn();

    const firstStart = startGitWatcher('task-1', '/repo', firstListener);
    const secondStart = startGitWatcher('task-1', '/repo', latestListener);
    expect(secondStart).toBe(firstStart);

    gitDir.resolve({ stdout: '/repo/.git\n' });
    await Promise.all([firstStart, secondStart]);

    expect(execGitMock).toHaveBeenCalledOnce();
    expect(watchSpy).toHaveBeenCalledTimes(2);
    const trigger = watchSpy.mock.calls[0]?.[1] as (() => void) | undefined;
    trigger?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(latestListener).toHaveBeenCalledOnce();
    expect(firstListener).not.toHaveBeenCalled();
  });

  it('does not install a watcher after the task stops during Git-dir resolution', async () => {
    const gitDir = createDeferred<{ stdout: string }>();
    execGitMock.mockReturnValueOnce(gitDir.promise);

    const start = startGitWatcher('task-1', '/repo', vi.fn());
    stopGitWatcher('task-1');
    gitDir.resolve({ stdout: '/repo/.git\n' });
    await start;

    expect(watchSpy).not.toHaveBeenCalled();
  });

  it('lets a newer worktree start supersede an unresolved start for the same task', async () => {
    const firstGitDir = createDeferred<{ stdout: string }>();
    const secondGitDir = createDeferred<{ stdout: string }>();
    execGitMock.mockReturnValueOnce(firstGitDir.promise).mockReturnValueOnce(secondGitDir.promise);

    const firstStart = startGitWatcher('task-1', '/repo/old', vi.fn());
    const secondStart = startGitWatcher('task-1', '/repo/new', vi.fn());
    firstGitDir.resolve({ stdout: '/repo/old/.git\n' });
    await firstStart;
    expect(watchSpy).not.toHaveBeenCalled();

    secondGitDir.resolve({ stdout: '/repo/new/.git\n' });
    await secondStart;
    expect(watchSpy).toHaveBeenCalledTimes(2);
  });
});
