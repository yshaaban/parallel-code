import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTaskReviewEvent, replaceTaskReviewSnapshots } from '../app/task-review-state';
import type { ReviewSession } from '../app/review-session';
import type { ChangedFile, FileDiffResult } from '../ipc/types';
import { resetStoreForTest } from '../test/store-test-helpers';

const { fetchTaskFileDiffMock, fetchTaskReviewFilesMock, getTaskConvergenceSnapshotMock } =
  vi.hoisted(() => ({
    fetchTaskFileDiffMock: vi.fn(),
    fetchTaskReviewFilesMock: vi.fn(),
    getTaskConvergenceSnapshotMock: vi.fn(),
  }));

vi.mock('../app/review-diffs', () => ({
  createTaskReviewDiffRequest: vi.fn((request: Record<string, unknown>) => request),
  fetchTaskFileDiff: fetchTaskFileDiffMock,
}));

vi.mock('../app/review-files', () => ({
  createTaskReviewFilesRequest: vi.fn((request: Record<string, unknown>) => request),
  fetchTaskReviewFiles: fetchTaskReviewFilesMock,
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

vi.mock('./ScrollingDiffView', () => ({
  ScrollingDiffView: (props: { reviewSession: ReviewSession }) => (
    <div>
      <div>Scrolling diff view</div>
      <button
        onClick={() => {
          props.reviewSession.handleSelection({
            source: 'src/first.ts',
            startLine: 4,
            endLine: 4,
            selectedText: 'const answer = 42;',
          });
          props.reviewSession.submitSelection('Use a more specific name.', 'review');
        }}
      >
        Add review comment
      </button>
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

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

describe('ReviewPanel', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    resetStoreForTest();
    getTaskConvergenceSnapshotMock.mockReturnValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
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

    fetchTaskFileDiffMock.mockResolvedValue(createFileDiffResult('first'));

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

    fetchTaskReviewFilesMock.mockImplementation((_request, mode?: string) => {
      if (mode === 'branch') {
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
    });
    fetchTaskFileDiffMock.mockImplementation((_request, file) =>
      Promise.resolve(createFileDiffResult(file.path)),
    );

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

    fetchTaskReviewFilesMock.mockImplementation((_request, mode?: string) => {
      if (mode === 'branch') {
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

  it('refreshes staged task review mode when pushed review state changes revision', async () => {
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

    fetchTaskReviewFilesMock.mockImplementation((_request, mode?: string) => {
      if (mode === 'staged') {
        return Promise.resolve({
          files: [createChangedFile({ path: 'src/staged-one.ts' })],
          totalAdded: 4,
          totalRemoved: 0,
        });
      }

      return Promise.resolve({
        files: [createChangedFile({ path: 'src/summary.ts' })],
        totalAdded: 5,
        totalRemoved: 2,
      });
    });
    fetchTaskFileDiffMock.mockImplementation((_request, file) =>
      Promise.resolve(createFileDiffResult(file.path)),
    );

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
      target: { value: 'staged' },
    });

    expect(await screen.findByText('staged-one.ts')).toBeDefined();

    fetchTaskReviewFilesMock.mockImplementation((_request, mode?: string) => {
      if (mode === 'staged') {
        return Promise.resolve({
          files: [createChangedFile({ path: 'src/staged-two.ts' })],
          totalAdded: 6,
          totalRemoved: 0,
        });
      }

      return Promise.resolve({
        files: [createChangedFile({ path: 'src/summary.ts' })],
        totalAdded: 6,
        totalRemoved: 0,
      });
    });

    applyTaskReviewEvent({
      branchName: 'feature/task-1',
      files: [createChangedFile({ path: 'src/summary.ts' })],
      projectId: 'project-1',
      revisionId: 'rev-2',
      source: 'worktree',
      taskId: 'task-1',
      totalAdded: 6,
      totalRemoved: 0,
      updatedAt: Date.now(),
      worktreePath: '/tmp/task-1',
    });

    await waitFor(() => {
      expect(screen.getByText('staged-two.ts')).toBeDefined();
    });
  });

  it('ignores stale non-all file-list responses after the user switches review mode again', async () => {
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

    const branchDeferred = createDeferredPromise<{
      files: ChangedFile[];
      totalAdded: number;
      totalRemoved: number;
    }>();
    const stagedDeferred = createDeferredPromise<{
      files: ChangedFile[];
      totalAdded: number;
      totalRemoved: number;
    }>();

    fetchTaskReviewFilesMock.mockImplementation((_request, mode?: string) => {
      switch (mode) {
        case 'branch':
          return branchDeferred.promise;
        case 'staged':
          return stagedDeferred.promise;
        default:
          return Promise.resolve({
            files: [createChangedFile({ path: 'src/summary.ts' })],
            totalAdded: 5,
            totalRemoved: 2,
          });
      }
    });
    fetchTaskFileDiffMock.mockImplementation((_request, file) =>
      Promise.resolve(createFileDiffResult(file.path)),
    );

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
    fireEvent.change(screen.getByDisplayValue('Branch'), {
      target: { value: 'staged' },
    });

    stagedDeferred.resolve({
      files: [createChangedFile({ path: 'src/staged-current.ts' })],
      totalAdded: 3,
      totalRemoved: 0,
    });

    expect(await screen.findByText('staged-current.ts')).toBeDefined();

    branchDeferred.resolve({
      files: [createChangedFile({ path: 'src/branch-stale.ts', committed: true })],
      totalAdded: 7,
      totalRemoved: 1,
    });

    await waitFor(() => {
      expect(screen.getByText('staged-current.ts')).toBeDefined();
      expect(screen.queryByText('branch-stale.ts')).toBeNull();
    });
  });

  it('refetches branch review files when the worktree path changes and ignores stale old-path results', async () => {
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

    const firstWorktreeDeferred = createDeferredPromise<{
      files: ChangedFile[];
      totalAdded: number;
      totalRemoved: number;
    }>();

    fetchTaskReviewFilesMock.mockImplementation((request, mode?: string) => {
      if (mode !== 'branch') {
        return Promise.resolve({
          files: [createChangedFile({ path: 'src/summary.ts' })],
          totalAdded: 5,
          totalRemoved: 2,
        });
      }

      if (request.worktreePath === '/tmp/task-1') {
        return firstWorktreeDeferred.promise;
      }

      if (request.worktreePath === '/tmp/task-2') {
        return Promise.resolve({
          files: [createChangedFile({ path: 'src/worktree-two.ts', committed: true })],
          totalAdded: 4,
          totalRemoved: 1,
        });
      }

      throw new Error(`Unexpected worktree path: ${request.worktreePath}`);
    });
    fetchTaskFileDiffMock.mockImplementation((_request, file) =>
      Promise.resolve(createFileDiffResult(file.path)),
    );

    const [worktreePath, setWorktreePath] = createSignal('/tmp/task-1');

    render(() => (
      <ReviewPanel
        taskId="task-1"
        worktreePath={worktreePath()}
        branchName="feature/task-1"
        projectRoot="/tmp/project"
        isActive
      />
    ));

    fireEvent.change(screen.getByDisplayValue('All changes'), {
      target: { value: 'branch' },
    });

    await waitFor(() => {
      expect(fetchTaskReviewFilesMock).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: '/tmp/task-1' }),
        'branch',
      );
    });

    setWorktreePath('/tmp/task-2');

    expect(await screen.findByText('worktree-two.ts')).toBeDefined();
    expect(fetchTaskReviewFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: '/tmp/task-2' }),
      'branch',
    );

    firstWorktreeDeferred.resolve({
      files: [createChangedFile({ path: 'src/worktree-one-stale.ts', committed: true })],
      totalAdded: 8,
      totalRemoved: 3,
    });

    await waitFor(() => {
      expect(screen.getByText('worktree-two.ts')).toBeDefined();
      expect(screen.queryByText('worktree-one-stale.ts')).toBeNull();
    });
  });

  it('refetches branch review files when the branch name changes and ignores stale old-branch results', async () => {
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

    const firstBranchDeferred = createDeferredPromise<{
      files: ChangedFile[];
      totalAdded: number;
      totalRemoved: number;
    }>();

    fetchTaskReviewFilesMock.mockImplementation((request, mode?: string) => {
      if (mode !== 'branch') {
        return Promise.resolve({
          files: [createChangedFile({ path: 'src/summary.ts' })],
          totalAdded: 5,
          totalRemoved: 2,
        });
      }

      if (request.branchName === 'feature/task-1') {
        return firstBranchDeferred.promise;
      }

      if (request.branchName === 'feature/task-2') {
        return Promise.resolve({
          files: [createChangedFile({ path: 'src/branch-two.ts', committed: true })],
          totalAdded: 6,
          totalRemoved: 0,
        });
      }

      throw new Error(`Unexpected branch name: ${request.branchName}`);
    });
    fetchTaskFileDiffMock.mockImplementation((_request, file) =>
      Promise.resolve(createFileDiffResult(file.path)),
    );

    const [branchName, setBranchName] = createSignal('feature/task-1');

    render(() => (
      <ReviewPanel
        taskId="task-1"
        worktreePath="/tmp/task-1"
        branchName={branchName()}
        projectRoot="/tmp/project"
        isActive
      />
    ));

    fireEvent.change(screen.getByDisplayValue('All changes'), {
      target: { value: 'branch' },
    });

    await waitFor(() => {
      expect(fetchTaskReviewFilesMock).toHaveBeenCalledWith(
        expect.objectContaining({ branchName: 'feature/task-1' }),
        'branch',
      );
    });

    setBranchName('feature/task-2');

    expect(await screen.findByText('branch-two.ts')).toBeDefined();
    expect(fetchTaskReviewFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feature/task-2' }),
      'branch',
    );

    firstBranchDeferred.resolve({
      files: [createChangedFile({ path: 'src/branch-one-stale.ts', committed: true })],
      totalAdded: 7,
      totalRemoved: 2,
    });

    await waitFor(() => {
      expect(screen.getByText('branch-two.ts')).toBeDefined();
      expect(screen.queryByText('branch-one-stale.ts')).toBeNull();
    });
  });

  it('keeps the selected file when refreshed branch review files still contain it', async () => {
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

    fetchTaskReviewFilesMock.mockImplementation((_request, mode?: string) => {
      if (mode === 'branch') {
        return Promise.resolve({
          files: [
            createChangedFile({ path: 'src/first.ts', committed: true }),
            createChangedFile({ path: 'src/second.ts', committed: true }),
          ],
          totalAdded: 6,
          totalRemoved: 2,
        });
      }

      return Promise.resolve({
        files: [createChangedFile({ path: 'src/summary.ts' })],
        totalAdded: 5,
        totalRemoved: 2,
      });
    });
    fetchTaskFileDiffMock.mockImplementation((_request, file) =>
      Promise.resolve(createFileDiffResult(file.path)),
    );

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

    expect(await screen.findByText('second.ts')).toBeDefined();
    fireEvent.click(screen.getByTitle('Show split diff'));
    fireEvent.click(screen.getByText('second.ts'));

    await waitFor(() => {
      expect(screen.getByTestId('diff-editor').textContent).toContain('src/second.ts');
    });

    fetchTaskReviewFilesMock.mockImplementation((_request, mode?: string) => {
      if (mode === 'branch') {
        return Promise.resolve({
          files: [
            createChangedFile({ path: 'src/first.ts', committed: true }),
            createChangedFile({ path: 'src/second.ts', committed: true }),
            createChangedFile({ path: 'src/third.ts', committed: true }),
          ],
          totalAdded: 8,
          totalRemoved: 3,
        });
      }

      return Promise.resolve({
        files: [createChangedFile({ path: 'src/summary.ts' })],
        totalAdded: 8,
        totalRemoved: 3,
      });
    });

    applyTaskReviewEvent({
      branchName: 'feature/task-1',
      files: [createChangedFile({ path: 'src/summary.ts' })],
      projectId: 'project-1',
      revisionId: 'rev-2',
      source: 'worktree',
      taskId: 'task-1',
      totalAdded: 8,
      totalRemoved: 3,
      updatedAt: Date.now(),
      worktreePath: '/tmp/task-1',
    });

    await waitFor(() => {
      expect(screen.getByText('third.ts')).toBeDefined();
      expect(screen.getByTestId('diff-editor').textContent).toContain('src/second.ts');
    });
  });

  it('supports keyboard navigation through the fetched file list', async () => {
    fetchTaskReviewFilesMock.mockResolvedValue({
      files: [
        createChangedFile({ path: 'src/first.ts' }),
        createChangedFile({ path: 'src/second.ts', lines_added: 1, lines_removed: 0 }),
      ],
      totalAdded: 6,
      totalRemoved: 2,
    });
    fetchTaskFileDiffMock.mockImplementation((_request, file) =>
      Promise.resolve(createFileDiffResult(file.path)),
    );

    render(() => <ReviewPanel worktreePath="/tmp/task-1" branchName="feature/task-1" isActive />);

    const reviewPanel = await screen.findByText('first.ts');
    expect(reviewPanel).toBeDefined();

    const root = reviewPanel.closest('[tabindex="0"]') as HTMLElement;
    fireEvent.keyDown(root, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(fetchTaskFileDiffMock).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: '/tmp/task-1' }),
        expect.objectContaining({
          committed: false,
          path: 'src/second.ts',
        }),
      );
    });
  });

  it('loads committed branch-added files through the branch diff request path', async () => {
    replaceTaskReviewSnapshots([
      {
        branchName: 'feature/task-1',
        files: [createChangedFile({ path: 'src/new-file.ts', committed: true, status: 'A' })],
        projectId: 'project-1',
        revisionId: 'rev-1',
        source: 'worktree',
        taskId: 'task-1',
        totalAdded: 8,
        totalRemoved: 0,
        updatedAt: Date.now(),
        worktreePath: '/tmp/task-1',
      },
    ]);
    fetchTaskFileDiffMock.mockResolvedValue(createFileDiffResult('new-file'));

    render(() => (
      <ReviewPanel
        taskId="task-1"
        worktreePath="/tmp/task-1"
        branchName="feature/task-1"
        projectRoot="/tmp/project"
        isActive
      />
    ));

    await waitFor(() => {
      expect(fetchTaskFileDiffMock).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: 'feature/task-1',
          projectRoot: '/tmp/project',
          worktreePath: '/tmp/task-1',
        }),
        expect.objectContaining({
          committed: true,
          path: 'src/new-file.ts',
        }),
      );
    });
  });

  it('refetches the selected file when the same path becomes committed on refresh', async () => {
    replaceTaskReviewSnapshots([
      {
        branchName: 'feature/task-1',
        files: [createChangedFile({ path: 'src/shared.ts', committed: false, status: 'M' })],
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
    fetchTaskFileDiffMock.mockImplementation((_request, file) =>
      Promise.resolve(createFileDiffResult(file.committed ? 'branch-version' : 'worktree-version')),
    );

    render(() => (
      <ReviewPanel
        taskId="task-1"
        worktreePath="/tmp/task-1"
        branchName="feature/task-1"
        projectRoot="/tmp/project"
        isActive
      />
    ));

    expect(await screen.findByText('shared.ts')).toBeDefined();
    fireEvent.click(screen.getByTitle('Show split diff'));

    await waitFor(() => {
      expect(screen.getByTestId('diff-editor').textContent).toContain('worktree-version');
    });

    applyTaskReviewEvent({
      branchName: 'feature/task-1',
      files: [createChangedFile({ path: 'src/shared.ts', committed: true, status: 'A' })],
      projectId: 'project-1',
      revisionId: 'rev-2',
      source: 'worktree',
      taskId: 'task-1',
      totalAdded: 6,
      totalRemoved: 0,
      updatedAt: Date.now(),
      worktreePath: '/tmp/task-1',
    });

    await waitFor(() => {
      expect(fetchTaskFileDiffMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          branchName: 'feature/task-1',
          projectRoot: '/tmp/project',
          worktreePath: '/tmp/task-1',
        }),
        expect.objectContaining({
          committed: true,
          path: 'src/shared.ts',
          status: 'A',
        }),
      );
      expect(screen.getByTestId('diff-editor').textContent).toContain('branch-version');
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

    fetchTaskFileDiffMock.mockResolvedValue(createFileDiffResult('first'));

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

  it('filters directory paths out of review mode snapshots before selecting a diff target', async () => {
    replaceTaskReviewSnapshots([
      {
        branchName: 'master',
        files: [
          createChangedFile({ path: '.worktrees/task/port/', status: '?' }),
          createChangedFile({ path: 'src/real-file.ts', status: 'M' }),
        ],
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

    fetchTaskFileDiffMock.mockResolvedValue(createFileDiffResult('real file'));

    render(() => (
      <ReviewPanel
        taskId="task-1"
        worktreePath="/tmp/task-1"
        branchName="master"
        projectRoot="/tmp/project"
        isActive
      />
    ));

    expect(await screen.findByText('real-file.ts')).toBeDefined();
    expect(screen.queryByTitle('.worktrees/task/port/')).toBeNull();
    expect(fetchTaskFileDiffMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        committed: false,
        path: 'src/real-file.ts',
      }),
    );
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

    fetchTaskFileDiffMock.mockResolvedValue(createFileDiffResult('first'));

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
    fetchTaskReviewFilesMock.mockResolvedValue({
      files: [
        createChangedFile({ path: 'docs/coordination/plan.json' }),
        createChangedFile({ path: 'src/visible.ts', lines_added: 1, lines_removed: 0 }),
      ],
      totalAdded: 6,
      totalRemoved: 2,
    });
    fetchTaskFileDiffMock.mockImplementation((_request, file) =>
      Promise.resolve(createFileDiffResult(file.path)),
    );

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

  it('restores contextual review comments with copy and prompt actions', async () => {
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

    fetchTaskFileDiffMock.mockResolvedValue(createFileDiffResult('first'));

    render(() => (
      <ReviewPanel
        agentId="agent-1"
        taskId="task-1"
        worktreePath="/tmp/task-1"
        branchName="feature/task-1"
        projectRoot="/tmp/project"
        isActive
      />
    ));

    expect(await screen.findByText('first.ts')).toBeDefined();

    fireEvent.click(screen.getByText('Add review comment'));

    expect(await screen.findByText('Use a more specific name.')).toBeDefined();
    expect(screen.getByText('Copy Comments')).toBeDefined();
    expect(screen.getByText('Prompt with Comments (1)')).toBeDefined();

    fireEvent.click(screen.getByText('Copy Comments'));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        [
          'Please address these file review comments:',
          '',
          '- src/first.ts | line 4 | begins with: const answer = 42;',
          '  Comment: Use a more specific name.',
        ].join('\n'),
      );
    });
  });
});
