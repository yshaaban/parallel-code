import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { GitStatusSyncEvent } from '../domain/server-state';
import type { ChangedFile, FileDiffResult } from '../ipc/types';

const { getTaskConvergenceSnapshotMock, invokeMock, listenForGitStatusChangedMock } = vi.hoisted(
  () => ({
    getTaskConvergenceSnapshotMock: vi.fn(),
    invokeMock: vi.fn(),
    listenForGitStatusChangedMock: vi.fn(),
  }),
);

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../runtime/git-status-events', () => ({
  listenForGitStatusChanged: listenForGitStatusChangedMock,
}));

vi.mock('../app/task-convergence', () => ({
  getTaskConvergenceSnapshot: getTaskConvergenceSnapshotMock,
}));

vi.mock('./MonacoDiffEditor', () => ({
  MonacoDiffEditor: (props: {
    oldContent: string;
    newContent: string;
    language: string;
    sideBySide: boolean;
  }) => (
    <div data-testid="diff-editor">
      {props.language}:{props.sideBySide ? 'split' : 'unified'}:{props.newContent}
    </div>
  ),
}));

import { ReviewPanel } from './ReviewPanel';

function createChangedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    committed: false,
    lines_added: 5,
    lines_removed: 2,
    path: 'src/first.ts',
    status: 'modified',
    ...overrides,
  };
}

function createFileDiffResult(content: string): FileDiffResult {
  return {
    diff: `diff ${content}`,
    newContent: content,
    oldContent: `old ${content}`,
  };
}

describe('ReviewPanel', () => {
  let onGitStatusChanged: ((message: GitStatusSyncEvent) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    onGitStatusChanged = undefined;
    getTaskConvergenceSnapshotMock.mockReturnValue(undefined);
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

  it('refreshes the file list from pushed git-status events', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.GetProjectDiff) {
        const calls = invokeMock.mock.calls.filter(
          ([currentChannel]) => currentChannel === channel,
        );
        if (calls.length === 1) {
          return Promise.resolve({
            files: [createChangedFile({ path: 'src/first.ts' })],
            totalAdded: 5,
            totalRemoved: 2,
          });
        }

        return Promise.resolve({
          files: [createChangedFile({ path: 'src/updated.ts' })],
          totalAdded: 7,
          totalRemoved: 1,
        });
      }

      if (channel === IPC.GetFileDiff) {
        return Promise.resolve(createFileDiffResult('first'));
      }

      throw new Error(`Unexpected channel: ${channel}`);
    });

    render(() => (
      <ReviewPanel
        taskId="task-1"
        worktreePath="/tmp/task-1"
        branchName="feature/task-1"
        projectRoot="/tmp/project"
        isActive
      />
    ));

    expect(await screen.findByText('first.ts')).toBeDefined();

    onGitStatusChanged?.({
      branchName: 'feature/task-1',
      projectRoot: '/tmp/project',
      worktreePath: '/tmp/task-1',
    });

    await waitFor(() => {
      expect(screen.getByText('updated.ts')).toBeDefined();
    });
  });

  it('supports keyboard navigation through the fetched file list', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: { filePath?: string }) => {
      if (channel === IPC.GetProjectDiff) {
        return Promise.resolve({
          files: [
            createChangedFile({ path: 'src/first.ts' }),
            createChangedFile({ path: 'src/second.ts', lines_added: 1, lines_removed: 0 }),
          ],
          totalAdded: 6,
          totalRemoved: 2,
        });
      }

      if (channel === IPC.GetFileDiff) {
        return Promise.resolve(createFileDiffResult(args?.filePath ?? 'missing'));
      }

      throw new Error(`Unexpected channel: ${channel}`);
    });

    render(() => <ReviewPanel worktreePath="/tmp/task-1" branchName="feature/task-1" isActive />);

    const reviewPanel = await screen.findByText('first.ts');
    expect(reviewPanel).toBeDefined();

    const root = reviewPanel.closest('[tabindex="0"]') as HTMLElement;
    fireEvent.keyDown(root, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        IPC.GetFileDiff,
        expect.objectContaining({ filePath: 'src/second.ts', worktreePath: '/tmp/task-1' }),
      );
    });
  });

  it('shows convergence summary when task review data exists', async () => {
    getTaskConvergenceSnapshotMock.mockReturnValue({
      branchFiles: ['src/first.ts'],
      branchName: 'feature/task-1',
      changedFileCount: 1,
      commitCount: 2,
      conflictingFiles: [],
      hasCommittedChanges: true,
      hasUncommittedChanges: false,
      mainAheadCount: 0,
      overlapWarnings: [],
      projectId: 'project-1',
      state: 'review-ready',
      summary: '2 commits, 1 file changed',
      taskId: 'task-1',
      totalAdded: 5,
      totalRemoved: 1,
      updatedAt: Date.now(),
      worktreePath: '/tmp/task-1',
    });
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.GetProjectDiff) {
        return Promise.resolve({
          files: [createChangedFile({ path: 'src/first.ts' })],
          totalAdded: 5,
          totalRemoved: 1,
        });
      }

      if (channel === IPC.GetFileDiff) {
        return Promise.resolve(createFileDiffResult('first'));
      }

      throw new Error(`Unexpected channel: ${channel}`);
    });

    render(() => (
      <ReviewPanel
        taskId="task-1"
        worktreePath="/tmp/task-1"
        branchName="feature/task-1"
        projectRoot="/tmp/project"
        isActive
      />
    ));

    expect(await screen.findByText('Ready')).toBeDefined();
    expect(screen.getByText('2 commits, 1 file changed')).toBeDefined();
  });

  it('exposes a fullscreen action and keeps review navigation compact', async () => {
    const onOpenFullscreen = vi.fn();

    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.GetProjectDiff) {
        return Promise.resolve({
          files: [createChangedFile({ path: 'src/first.ts' })],
          totalAdded: 5,
          totalRemoved: 1,
        });
      }

      if (channel === IPC.GetFileDiff) {
        return Promise.resolve(createFileDiffResult('first'));
      }

      throw new Error(`Unexpected channel: ${channel}`);
    });

    render(() => (
      <ReviewPanel
        taskId="task-1"
        worktreePath="/tmp/task-1"
        branchName="feature/task-1"
        projectRoot="/tmp/project"
        isActive
        onOpenFullscreen={onOpenFullscreen}
      />
    ));

    expect(await screen.findByText('first.ts')).toBeDefined();

    fireEvent.click(screen.getByTitle('Open review fullscreen'));

    expect(onOpenFullscreen).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle('Previous file')).toBeDefined();
    expect(screen.getByTitle('Next file')).toBeDefined();
    expect(screen.getByTitle('Show split diff')).toBeDefined();
  });

  it('matches the changed-files Hydra artifact filtering behavior', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: { filePath?: string }) => {
      if (channel === IPC.GetProjectDiff) {
        return Promise.resolve({
          files: [
            createChangedFile({ path: 'docs/coordination/plan.json' }),
            createChangedFile({ path: 'src/visible.ts', lines_added: 1, lines_removed: 0 }),
          ],
          totalAdded: 6,
          totalRemoved: 2,
        });
      }

      if (channel === IPC.GetFileDiff) {
        return Promise.resolve(createFileDiffResult(args?.filePath ?? 'missing'));
      }

      throw new Error(`Unexpected channel: ${channel}`);
    });

    render(() => (
      <ReviewPanel
        worktreePath="/tmp/task-1"
        branchName="feature/task-1"
        isActive
        filterHydraArtifacts
      />
    ));

    expect(await screen.findByText('visible.ts')).toBeDefined();
    expect(screen.queryByText('plan.json')).toBeNull();
    expect(screen.getByText('Show 1 Hydra coordination files')).toBeDefined();
    expect(screen.getByTitle('Next file').getAttribute('disabled')).not.toBeNull();
  });
});
