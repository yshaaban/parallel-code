import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
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

vi.mock('../store/task-git-status', () => ({
  getRecentTaskGitStatusPollAge: getRecentTaskGitStatusPollAgeMock,
  gitStatusEventMatchesTarget: vi.fn(() => true),
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
    vi.useRealTimers();
    vi.clearAllMocks();
    resetStoreForTest();
    getRecentTaskGitStatusPollAgeMock.mockReturnValue(null);
    listenForGitStatusChangedMock.mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
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

    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByText('app.ts')).toBeDefined();
    expect(screen.queryByText('plan.json')).toBeNull();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(invokeMock).toHaveBeenCalledTimes(2);

    screen.getByRole('button', { name: /show 1 hydra coordination files/i }).click();

    expect(await screen.findByText('plan.json')).toBeDefined();
  });

  it('scrolls the selected file into view while navigating by keyboard', async () => {
    isElectronRuntimeMock.mockReturnValue(false);
    replaceTaskReviewSnapshots([
      {
        branchName: 'feature/task-1',
        files: [
          createChangedFile({ path: 'src/first.ts' }),
          createChangedFile({ path: 'src/second.ts' }),
          createChangedFile({ path: 'src/third.ts' }),
        ],
        projectId: 'project-1',
        revisionId: 'rev-1',
        source: 'worktree',
        taskId: 'task-1',
        totalAdded: 9,
        totalRemoved: 3,
        updatedAt: Date.now(),
        worktreePath: '/tmp/task-1',
      },
    ]);

    render(() => <ChangedFilesList taskId="task-1" worktreePath="/tmp/task-1" isActive />);

    const firstRow = (await screen.findByText('first.ts')).closest('.file-row') as HTMLDivElement;
    const secondRow = screen.getByText('second.ts').closest('.file-row') as HTMLDivElement;
    const thirdRow = screen.getByText('third.ts').closest('.file-row') as HTMLDivElement;
    const panel = firstRow.closest('[tabindex="0"]') as HTMLElement;
    const firstRowScrollSpy = vi.fn();
    const secondRowScrollSpy = vi.fn();
    const thirdRowScrollSpy = vi.fn();

    Object.defineProperty(firstRow, 'scrollIntoView', {
      configurable: true,
      value: firstRowScrollSpy,
    });
    Object.defineProperty(secondRow, 'scrollIntoView', {
      configurable: true,
      value: secondRowScrollSpy,
    });
    Object.defineProperty(thirdRow, 'scrollIntoView', {
      configurable: true,
      value: thirdRowScrollSpy,
    });

    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    fireEvent.keyDown(panel, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(firstRowScrollSpy).toHaveBeenCalledTimes(1);
      expect(secondRowScrollSpy).toHaveBeenCalledTimes(1);
    });
    expect(thirdRowScrollSpy).not.toHaveBeenCalled();
  });
});
