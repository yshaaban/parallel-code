import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  PORT_DISCOVERY_LSOF_TIMEOUT_MS,
  rediscoverTaskPorts,
  scanTaskPortExposureCandidates,
} from './port-discovery.js';

describe('port rediscovery', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    readlinkSyncMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('falls back to lsof cwd lookup when procfs cwd lookup is unavailable', () => {
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('-iTCP')) {
        return ['p100', 'n127.0.0.1:5173', ''].join('\n');
      }
      if (args.includes('-d') && args.includes('cwd')) {
        return ['p100', 'fcwd', 'n/repo/tasks/frontend', ''].join('\n');
      }
      throw new Error('unexpected lsof call');
    });
    readlinkSyncMock.mockImplementation(() => {
      throw new Error('procfs unavailable');
    });

    expect(
      rediscoverTaskPorts([{ taskId: 'frontend', worktreePath: '/repo/tasks/frontend' }]),
    ).toEqual([
      {
        taskId: 'frontend',
        host: '127.0.0.1',
        port: 5173,
        suggestion: 'Rediscovered listening port 5173',
      },
    ]);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpPn'],
      expect.objectContaining({
        killSignal: 'SIGKILL',
        timeout: expect.any(Number),
      }),
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'lsof',
      ['-a', '-p', '100', '-d', 'cwd', '-Fn'],
      expect.objectContaining({
        killSignal: 'SIGKILL',
        timeout: expect.any(Number),
      }),
    );
  });

  it('degrades to no rediscovered ports when the bounded lsof scan times out', () => {
    execFileSyncMock.mockImplementation(() => {
      const error = new Error('spawnSync lsof ETIMEDOUT') as NodeJS.ErrnoException;
      error.code = 'ETIMEDOUT';
      throw error;
    });

    expect(rediscoverTaskPorts([{ taskId: 'frontend', worktreePath: '/repo' }])).toEqual([]);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpPn'],
      expect.objectContaining({
        killSignal: 'SIGKILL',
        timeout: expect.any(Number),
      }),
    );
    expect(readlinkSyncMock).not.toHaveBeenCalled();
  });

  it('shares one lsof deadline across pid fallbacks and stops after a timeout', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('-iTCP')) {
        vi.setSystemTime(10_750);
        return ['p100', 'n127.0.0.1:5173', 'p101', 'n127.0.0.1:5174', ''].join('\n');
      }

      vi.setSystemTime(10_000 + PORT_DISCOVERY_LSOF_TIMEOUT_MS);
      const error = new Error('spawnSync lsof ETIMEDOUT') as NodeJS.ErrnoException;
      error.code = 'ETIMEDOUT';
      throw error;
    });
    readlinkSyncMock.mockImplementation(() => {
      throw new Error('procfs unavailable');
    });

    expect(rediscoverTaskPorts([{ taskId: 'frontend', worktreePath: '/repo' }])).toEqual([]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      1,
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpPn'],
      expect.objectContaining({ timeout: PORT_DISCOVERY_LSOF_TIMEOUT_MS }),
    );
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      2,
      'lsof',
      ['-a', '-p', '100', '-d', 'cwd', '-Fn'],
      expect.objectContaining({ timeout: PORT_DISCOVERY_LSOF_TIMEOUT_MS - 750 }),
    );
  });

  it('caches fallback lsof cwd lookups by pid during one rediscovery scan', () => {
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('-iTCP')) {
        return ['p100', 'n127.0.0.1:5173', 'n127.0.0.1:5174', ''].join('\n');
      }
      if (args.includes('-d') && args.includes('cwd')) {
        return ['p100', 'fcwd', 'n/repo/tasks/frontend', ''].join('\n');
      }
      throw new Error('unexpected lsof call');
    });
    readlinkSyncMock.mockImplementation(() => {
      throw new Error('procfs unavailable');
    });

    expect(
      rediscoverTaskPorts([{ taskId: 'frontend', worktreePath: '/repo/tasks/frontend' }]),
    ).toEqual([
      {
        taskId: 'frontend',
        host: '127.0.0.1',
        port: 5173,
        suggestion: 'Rediscovered listening port 5173',
      },
      {
        taskId: 'frontend',
        host: '127.0.0.1',
        port: 5174,
        suggestion: 'Rediscovered listening port 5174',
      },
    ]);
    expect(
      execFileSyncMock.mock.calls.filter(([, args]) => args.includes('-d') && args.includes('cwd')),
    ).toHaveLength(1);
  });

  it('retries one transient cwd miss for later sockets from the same pid', () => {
    let cwdLookups = 0;
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('-iTCP')) {
        return ['p100', 'n127.0.0.1:5173', 'n127.0.0.1:5174', ''].join('\n');
      }
      if (args.includes('-d') && args.includes('cwd')) {
        cwdLookups += 1;
        return cwdLookups === 1
          ? ['p100', 'fcwd', ''].join('\n')
          : ['p100', 'fcwd', 'n/repo/tasks/frontend', ''].join('\n');
      }
      throw new Error('unexpected lsof call');
    });
    readlinkSyncMock.mockImplementation(() => {
      throw new Error('procfs unavailable');
    });

    expect(
      rediscoverTaskPorts([{ taskId: 'frontend', worktreePath: '/repo/tasks/frontend' }]),
    ).toEqual([
      {
        taskId: 'frontend',
        host: '127.0.0.1',
        port: 5174,
        suggestion: 'Rediscovered listening port 5174',
      },
    ]);
    expect(
      execFileSyncMock.mock.calls.filter(([, args]) => args.includes('-d') && args.includes('cwd')),
    ).toHaveLength(2);
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
