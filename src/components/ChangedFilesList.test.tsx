import { render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { GitStatusSyncEvent } from '../domain/server-state';
import type { ChangedFile } from '../ipc/types';

const {
  getRecentTaskGitStatusPollAgeMock,
  invokeMock,
  isElectronRuntimeMock,
  listenForGitStatusChangedMock,
} = vi.hoisted(() => ({
  getRecentTaskGitStatusPollAgeMock: vi.fn(),
  invokeMock: vi.fn(),
  isElectronRuntimeMock: vi.fn(),
  listenForGitStatusChangedMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
  isElectronRuntime: isElectronRuntimeMock,
}));

vi.mock('../runtime/git-status-events', () => ({
  listenForGitStatusChanged: listenForGitStatusChangedMock,
}));

vi.mock('../store/taskStatus', () => ({
  getRecentTaskGitStatusPollAge: getRecentTaskGitStatusPollAgeMock,
}));

import { ChangedFilesList } from './ChangedFilesList';

function createChangedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    committed: false,
    lines_added: 3,
    lines_removed: 1,
    path: 'src/example.ts',
    status: 'modified',
    ...overrides,
  };
}

describe('ChangedFilesList', () => {
  let onGitStatusChanged: ((event: GitStatusSyncEvent) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    onGitStatusChanged = undefined;
    getRecentTaskGitStatusPollAgeMock.mockReturnValue(null);
    listenForGitStatusChangedMock.mockImplementation((listener) => {
      onGitStatusChanged = listener;
      return () => {
        onGitStatusChanged = undefined;
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes from pushed git-status events for task-bound lists', async () => {
    isElectronRuntimeMock.mockReturnValue(false);

    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.GetChangedFiles) {
        const calls = invokeMock.mock.calls.filter(
          ([currentChannel]) => currentChannel === channel,
        );
        if (calls.length === 1) {
          return Promise.resolve([createChangedFile({ path: 'src/first.ts' })]);
        }

        return Promise.resolve([createChangedFile({ path: 'src/second.ts' })]);
      }

      throw new Error(`Unexpected channel: ${channel}`);
    });

    render(() => <ChangedFilesList taskId="task-1" worktreePath="/tmp/task-1" isActive />);

    expect(await screen.findByText('first.ts')).toBeDefined();

    onGitStatusChanged?.({
      worktreePath: '/tmp/task-1',
    });

    await waitFor(() => {
      expect(screen.getByText('second.ts')).toBeDefined();
    });

    expect(listenForGitStatusChangedMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('polls in Electron mode and keeps Hydra artifacts hidden until requested', async () => {
    vi.useFakeTimers();
    isElectronRuntimeMock.mockReturnValue(true);

    invokeMock.mockResolvedValue([
      createChangedFile({ path: 'docs/coordination/plan.json' }),
      createChangedFile({ path: 'src/app.ts' }),
    ]);

    render(() => <ChangedFilesList worktreePath="/tmp/task-1" isActive filterHydraArtifacts />);

    expect(await screen.findByText('app.ts')).toBeDefined();
    expect(screen.queryByText('plan.json')).toBeNull();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(invokeMock).toHaveBeenCalledTimes(2);

    screen.getByRole('button', { name: /show 1 hydra coordination files/i }).click();

    expect(await screen.findByText('plan.json')).toBeDefined();
  });
});
