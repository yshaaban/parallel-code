import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, readlinkSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  readlinkSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock('fs', () => ({
  default: {
    readlinkSync: readlinkSyncMock,
  },
  readlinkSync: readlinkSyncMock,
}));

import { rediscoverTaskPorts, scanTaskPortExposureCandidates } from './port-discovery.js';

describe('port rediscovery', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    readlinkSyncMock.mockReset();
  });

  it('maps listening ports to the deepest matching task worktree', () => {
    execFileSyncMock.mockReturnValue(['p100', 'n127.0.0.1:5173', 'p101', 'n*:3000', ''].join('\n'));
    readlinkSyncMock.mockImplementation((path: string) => {
      if (path === '/proc/100/cwd') {
        return '/repo/tasks/frontend';
      }
      if (path === '/proc/101/cwd') {
        return '/repo';
      }
      throw new Error('missing cwd');
    });

    expect(
      rediscoverTaskPorts([
        { taskId: 'repo-root', worktreePath: '/repo' },
        { taskId: 'frontend', worktreePath: '/repo/tasks/frontend' },
      ]),
    ).toEqual([
      {
        taskId: 'frontend',
        host: '127.0.0.1',
        port: 5173,
        suggestion: 'Rediscovered listening port 5173',
      },
      {
        taskId: 'repo-root',
        host: null,
        port: 3000,
        suggestion: 'Rediscovered listening port 3000',
      },
    ]);
  });

  it('lists task listening ports before broader local dev-port candidates', () => {
    execFileSyncMock.mockReturnValue(
      ['p100', 'n127.0.0.1:5173', 'p101', 'n*:3000', 'p102', 'n127.0.0.1:5432', ''].join('\n'),
    );
    readlinkSyncMock.mockImplementation((path: string) => {
      if (path === '/proc/100/cwd') {
        return '/repo/tasks/frontend';
      }
      if (path === '/proc/101/cwd') {
        return '/repo/other';
      }
      if (path === '/proc/102/cwd') {
        return '/repo/db';
      }
      throw new Error('missing cwd');
    });

    expect(
      scanTaskPortExposureCandidates({
        taskId: 'frontend',
        worktreePath: '/repo/tasks/frontend',
      }),
    ).toEqual([
      {
        host: '127.0.0.1',
        port: 5173,
        source: 'task',
      },
      {
        host: null,
        port: 3000,
        source: 'local',
      },
    ]);
  });
});
