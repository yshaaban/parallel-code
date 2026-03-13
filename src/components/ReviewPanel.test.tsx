import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { applyTaskReviewEvent, replaceTaskReviewSnapshots } from '../app/task-review-state';
import type { ChangedFile, FileDiffResult } from '../ipc/types';
import { resetStoreForTest } from '../test/store-test-helpers';

const { getTaskConvergenceSnapshotMock, invokeMock } = vi.hoisted(() => ({
  getTaskConvergenceSnapshotMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
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
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    getTaskConvergenceSnapshotMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes the file list from pushed task-review events', async () => {
    replaceTaskReviewSnapshots([
      {
        branchName: 'feature/task-1',
        files: [createChangedFile({ path: 'src/first.ts' })],
        projectId: 'project-1',
        revisionId: 'rev-1',
        source: 'worktree',
        taskId: 'task-1',
        totalAdded: 5,
        totalRemoved: 2,
        updatedAt: Date.now(),
        worktreePath: '/tmp/task-1',
      },
    ]);

    invokeMock.mockImplementation((channel: IPC) => {
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

    applyTaskReviewEvent({
      branchName: 'feature/task-1',
      files: [createChangedFile({ path: 'src/updated.ts' })],
      projectId: 'project-1',
      revisionId: 'rev-2',
      source: 'worktree',
      taskId: 'task-1',
      totalAdded: 7,
      totalRemoved: 1,
      updatedAt: Date.now(),
      worktreePath: '/tmp/task-1',
    });

    await waitFor(() => {
      expect(screen.getByText('updated.ts')).toBeDefined();
    });
  });

  it('refreshes non-all task review modes when pushed review state changes revision', async () => {
    replaceTaskReviewSnapshots([
      {
        branchName: 'feature/task-1',
        files: [createChangedFile({ path: 'src/summary.ts' })],
        projectId: 'project-1',
        revisionId: 'rev-1',
        source: 'worktree',
        taskId: 'task-1',
        totalAdded: 5,
        totalRemoved: 2,
        updatedAt: Date.now(),
        worktreePath: '/tmp/task-1',
      },
    ]);

    invokeMock.mockImplementation((channel: IPC, args?: { mode?: string; filePath?: string }) => {
      if (channel === IPC.GetProjectDiff) {
        if (args?.mode === 'branch') {
          return Promise.resolve({
            files: [createChangedFile({ path: 'src/branch-one.ts', committed: true })],
            totalAdded: 5,
            totalRemoved: 2,
          });
        }
        return Promise.resolve({
          files: [createChangedFile({ path: 'src/summary.ts' })],
          totalAdded: 5,
          totalRemoved: 2,
        });
      }

      if (channel === IPC.GetFileDiff || channel === IPC.GetFileDiffFromBranch) {
        return Promise.resolve(createFileDiffResult(args?.filePath ?? 'missing'));
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

    fireEvent.change(screen.getByDisplayValue('All changes'), {
      target: { value: 'branch' },
    });

    expect(await screen.findByText('branch-one.ts')).toBeDefined();

    invokeMock.mockImplementation((channel: IPC, args?: { mode?: string; filePath?: string }) => {
      if (channel === IPC.GetProjectDiff) {
        if (args?.mode === 'branch') {
          return Promise.resolve({
            files: [createChangedFile({ path: 'src/branch-two.ts', committed: true })],
            totalAdded: 6,
            totalRemoved: 1,
          });
        }
        return Promise.resolve({
          files: [createChangedFile({ path: 'src/summary.ts' })],
          totalAdded: 6,
          totalRemoved: 1,
        });
      }

      if (channel === IPC.GetFileDiff || channel === IPC.GetFileDiffFromBranch) {
        return Promise.resolve(createFileDiffResult(args?.filePath ?? 'missing'));
      }

      throw new Error(`Unexpected channel: ${channel}`);
    });

    applyTaskReviewEvent({
      branchName: 'feature/task-1',
      files: [createChangedFile({ path: 'src/summary.ts' })],
      projectId: 'project-1',
      revisionId: 'rev-2',
      source: 'worktree',
      taskId: 'task-1',
      totalAdded: 6,
      totalRemoved: 1,
      updatedAt: Date.now(),
      worktreePath: '/tmp/task-1',
    });

    await waitFor(() => {
      expect(screen.getByText('branch-two.ts')).toBeDefined();
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
    replaceTaskReviewSnapshots([
      {
        branchName: 'feature/task-1',
        files: [createChangedFile({ path: 'src/first.ts' })],
        projectId: 'project-1',
        revisionId: 'rev-1',
        source: 'worktree',
        taskId: 'task-1',
        totalAdded: 5,
        totalRemoved: 1,
        updatedAt: Date.now(),
        worktreePath: '/tmp/task-1',
      },
    ]);

    invokeMock.mockImplementation((channel: IPC) => {
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

  it('shows review unavailable when the canonical task review snapshot is unavailable', async () => {
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

    render(() => (
      <ReviewPanel
        taskId="task-1"
        worktreePath="/tmp/task-1"
        branchName="feature/task-1"
        projectRoot="/tmp/project"
        isActive
      />
    ));

    expect(await screen.findAllByText('Review data unavailable')).not.toHaveLength(0);
  });

  it('exposes a fullscreen action and keeps review navigation compact', async () => {
    const onOpenFullscreen = vi.fn();
    replaceTaskReviewSnapshots([
      {
        branchName: 'feature/task-1',
        files: [createChangedFile({ path: 'src/first.ts' })],
        projectId: 'project-1',
        revisionId: 'rev-1',
        source: 'worktree',
        taskId: 'task-1',
        totalAdded: 5,
        totalRemoved: 1,
        updatedAt: Date.now(),
        worktreePath: '/tmp/task-1',
      },
    ]);

    invokeMock.mockImplementation((channel: IPC) => {
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
