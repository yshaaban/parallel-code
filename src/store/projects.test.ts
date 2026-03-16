import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../lib/dialog', () => ({
  openDialog: vi.fn(),
}));

vi.mock('./tasks', () => ({
  closeTask: vi.fn(),
}));

import { IPC } from '../../electron/ipc/channels';
import { createInitialAppStore, setStore, store } from './core';
import { validateProjectPaths } from './projects';

describe('project path validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStore(createInitialAppStore());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('validates all project paths with one bulk IPC request and marks only missing projects', async () => {
    setStore('projects', [
      { id: 'project-1', name: 'One', path: '/repo/one', color: '#111111' },
      { id: 'project-2', name: 'Two', path: '/repo/two', color: '#222222' },
      { id: 'project-3', name: 'Three', path: '/repo/one', color: '#333333' },
    ]);
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel !== IPC.CheckPathsExist) {
        throw new Error(`Unexpected IPC channel: ${channel}`);
      }

      return Promise.resolve({
        '/repo/one': true,
        '/repo/two': false,
      });
    });

    await validateProjectPaths();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(IPC.CheckPathsExist, {
      paths: ['/repo/one', '/repo/two'],
    });
    expect(store.missingProjectIds).toEqual({
      'project-2': true,
    });
  });

  it('preserves the previous missing-project state when the bulk path check fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStore('projects', [
      { id: 'project-1', name: 'One', path: '/repo/one', color: '#111111' },
      { id: 'project-2', name: 'Two', path: '/repo/two', color: '#222222' },
    ]);
    setStore('missingProjectIds', {
      'project-2': true,
    });
    invokeMock.mockRejectedValue(new Error('offline'));

    await validateProjectPaths();

    expect(store.missingProjectIds).toEqual({
      'project-2': true,
    });
    expect(warn).toHaveBeenCalled();
  });

  it('scales path validation with sync count instead of project count', async () => {
    const projectCount = 20;
    setStore(
      'projects',
      Array.from({ length: projectCount }, (_, index) => ({
        id: `project-${index}`,
        name: `Project ${index}`,
        path: `/repo/${index}`,
        color: `#${String(index).padStart(6, '0')}`,
      })),
    );
    invokeMock.mockResolvedValue(
      Object.fromEntries(
        Array.from({ length: projectCount }, (_, index) => [`/repo/${index}`, true]),
      ),
    );

    for (let index = 0; index < 10; index += 1) {
      await validateProjectPaths();
    }

    expect(invokeMock).toHaveBeenCalledTimes(10);
    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.CheckPathsExist, {
      paths: Array.from({ length: projectCount }, (_, index) => `/repo/${index}`),
    });
  });
});
