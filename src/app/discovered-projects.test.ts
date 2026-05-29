import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { DiscoveredProject } from '../ipc/types';
import { setStore } from '../store/core';
import { store } from '../store/state';
import { createTestProject, resetStoreForTest } from '../test/store-test-helpers';
import {
  getUnaddedDiscoveredProjects,
  refreshDiscoveredProjects,
  resetDiscoveredProjectsRefreshForTests,
} from './discovered-projects';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function discoveredProject(name: string): DiscoveredProject {
  return {
    name,
    path: `/repo/${name}`,
    source: 'codex',
    updatedAtMs: 1_000,
  };
}

describe('discovered project projection', () => {
  beforeEach(() => {
    resetStoreForTest();
    resetDiscoveredProjectsRefreshForTests();
    vi.clearAllMocks();
  });

  it('filters already-added projects using normalized path keys', () => {
    setStore('projects', [
      createTestProject({ id: 'project-1', path: 'C:\\Users\\me\\src\\app\\' }),
    ]);
    setStore('discoveredProjects', [
      {
        name: 'app',
        path: 'c:/Users/me/src/app',
        source: 'codex',
        updatedAtMs: 1_000,
      },
      {
        name: 'other',
        path: 'C:/Users/me/src/other',
        source: 'git',
        updatedAtMs: 900,
      },
    ]);

    expect(getUnaddedDiscoveredProjects().map((project) => project.name)).toEqual(['other']);
  });

  it('keeps a slower refresh from overwriting a newer discovered-project response', async () => {
    const staleRefresh = createDeferredPromise<DiscoveredProject[]>();
    const freshRefresh = createDeferredPromise<DiscoveredProject[]>();
    invokeMock.mockReturnValueOnce(staleRefresh.promise).mockReturnValueOnce(freshRefresh.promise);

    const firstRefresh = refreshDiscoveredProjects();
    const secondRefresh = refreshDiscoveredProjects({ force: true });

    freshRefresh.resolve([discoveredProject('fresh')]);
    await secondRefresh;
    expect(store.discoveredProjects.map((project) => project.name)).toEqual(['fresh']);

    staleRefresh.resolve([discoveredProject('stale')]);
    await firstRefresh;
    expect(store.discoveredProjects.map((project) => project.name)).toEqual(['fresh']);
    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.GetDiscoveredProjects, undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.GetDiscoveredProjects, { force: true });
  });
});
