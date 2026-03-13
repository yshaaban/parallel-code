import { render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTaskReviewEvent, replaceTaskReviewSnapshots } from '../app/task-review-state';
import type { ChangedFile } from '../ipc/types';
import { resetStoreForTest } from '../test/store-test-helpers';

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
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    getRecentTaskGitStatusPollAgeMock.mockReturnValue(null);
    listenForGitStatusChangedMock.mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes from pushed git-status events for task-bound lists using the canonical project diff', async () => {
    isElectronRuntimeMock.mockReturnValue(false);
    replaceTaskReviewSnapshots([
      {
        branchName: 'feature/task-1',
        files: [createChangedFile({ path: 'src/first.ts' })],
        projectId: 'project-1',
        revisionId: 'rev-1',
        source: 'worktree',
        taskId: 'task-1',
        totalAdded: 3,
        totalRemoved: 1,
        updatedAt: Date.now(),
        worktreePath: '/tmp/task-1',
      },
    ]);

    render(() => <ChangedFilesList taskId="task-1" worktreePath="/tmp/task-1" isActive />);

    expect(await screen.findByText('first.ts')).toBeDefined();

    applyTaskReviewEvent({
      branchName: 'feature/task-1',
      files: [createChangedFile({ path: 'src/second.ts' })],
      projectId: 'project-1',
      revisionId: 'rev-2',
      source: 'worktree',
      taskId: 'task-1',
      totalAdded: 3,
      totalRemoved: 1,
      updatedAt: Date.now(),
      worktreePath: '/tmp/task-1',
    });

    await waitFor(() => {
      expect(screen.getByText('second.ts')).toBeDefined();
    });

    expect(listenForGitStatusChangedMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('shows an unavailable message when canonical task review data is unavailable', async () => {
    isElectronRuntimeMock.mockReturnValue(false);
    replaceTaskReviewSnapshots([
      {
        branchName: 'feature/task-1',
        files: [],
        projectId: 'project-1',
        revisionId: 'rev-unavailable',
        source: 'unavailable',
        taskId: 'task-1',
        totalAdded: 0,
        totalRemoved: 0,
        updatedAt: Date.now(),
        worktreePath: '/tmp/task-1',
      },
    ]);

    render(() => <ChangedFilesList taskId="task-1" worktreePath="/tmp/task-1" isActive />);

    expect(await screen.findByText('Review data unavailable')).toBeDefined();
  });

  it('polls in Electron mode and keeps Hydra artifacts hidden until requested', async () => {
    vi.useFakeTimers();
    isElectronRuntimeMock.mockReturnValue(true);

    invokeMock.mockResolvedValue({
      files: [
        createChangedFile({ path: 'docs/coordination/plan.json' }),
        createChangedFile({ path: 'src/app.ts' }),
      ],
      totalAdded: 6,
      totalRemoved: 2,
    });

    render(() => <ChangedFilesList worktreePath="/tmp/task-1" isActive filterHydraArtifacts />);

    expect(await screen.findByText('app.ts')).toBeDefined();
    expect(screen.queryByText('plan.json')).toBeNull();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(invokeMock).toHaveBeenCalledTimes(2);

    screen.getByRole('button', { name: /show 1 hydra coordination files/i }).click();

    expect(await screen.findByText('plan.json')).toBeDefined();
  });
});
