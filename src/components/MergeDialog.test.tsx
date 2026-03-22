import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Show, type JSX } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTaskReviewEvent, replaceTaskReviewSnapshots } from '../app/task-review-state';
import { IPC } from '../../electron/ipc/channels';
import { setStore } from '../store/core';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';

const { invokeMock, mergeTaskMock, refreshTaskGitStatusForTaskMock, sendPromptMock } = vi.hoisted(
  () => ({
    invokeMock: vi.fn(),
    mergeTaskMock: vi.fn(),
    refreshTaskGitStatusForTaskMock: vi.fn(() => Promise.resolve(true)),
    sendPromptMock: vi.fn(),
  }),
);

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

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../app/task-workflows', () => ({
  mergeTask: mergeTaskMock,
  sendPrompt: sendPromptMock,
}));

vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: (props: {
    message: JSX.Element | string;
    onCancel: () => void;
    onConfirm: () => void;
    confirmDisabled?: boolean;
    open: boolean;
    title: string;
  }) => (
    <Show when={props.open}>
      <div>
        <div>{props.title}</div>
        <div>{props.message}</div>
        <button disabled={props.confirmDisabled} onClick={() => props.onConfirm()}>
          Confirm
        </button>
        <button onClick={() => props.onCancel()}>Cancel</button>
      </div>
    </Show>
  ),
}));

vi.mock('../store/task-git-status', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');

  return {
    getTaskGitStatus: vi.fn((taskId: string) => core.store.taskGitStatus[taskId]),
    refreshTaskGitStatusForTask: refreshTaskGitStatusForTaskMock,
  };
});

import { MergeDialog } from './MergeDialog';

describe('MergeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    setStore('projects', [createTestProject({ baseBranch: 'main' })]);
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.GetBranchLog:
          return Promise.resolve('');
        case IPC.CheckMergeStatus:
          return Promise.resolve({
            conflicting_files: [],
            main_ahead_count: 0,
          });
        case IPC.RebaseTask:
          return Promise.resolve(undefined);
        default:
          throw new Error(`Unexpected channel: ${channel}`);
      }
    });
  });

  it('renders task-bound changed files from canonical review snapshots and reacts to shared git status', async () => {
    const onDiffFileClick = vi.fn();
    replaceTaskReviewSnapshots([
      {
        branchName: 'feature/task-1',
        files: [
          {
            committed: false,
            lines_added: 4,
            lines_removed: 1,
            path: 'src/merge.ts',
            status: 'modified',
          },
        ],
        projectId: 'project-1',
        revisionId: 'rev-1',
        source: 'worktree',
        taskId: 'task-1',
        totalAdded: 4,
        totalRemoved: 1,
        updatedAt: Date.now(),
        worktreePath: '/tmp/project/task-1',
      },
    ]);

    render(() => (
      <MergeDialog
        open
        task={createTestTask()}
        initialCleanup={true}
        onDone={() => {}}
        onDiffFileClick={onDiffFileClick}
      />
    ));

    expect(refreshTaskGitStatusForTaskMock).toHaveBeenCalledWith('task-1');
    expect(await screen.findByText('merge.ts')).toBeDefined();

    fireEvent.click(screen.getByText('merge.ts'));
    expect(onDiffFileClick).toHaveBeenCalledWith({
      committed: false,
      lines_added: 4,
      lines_removed: 1,
      path: 'src/merge.ts',
      status: 'modified',
    });

    setStore('taskGitStatus', 'task-1', {
      has_committed_changes: false,
      has_uncommitted_changes: true,
    });

    await waitFor(() => {
      expect(
        screen.getByText(
          'Warning: You have uncommitted changes that will NOT be included in this merge.',
        ),
      ).toBeDefined();
    });

    applyTaskReviewEvent({
      branchName: 'feature/task-1',
      files: [
        {
          committed: false,
          lines_added: 2,
          lines_removed: 0,
          path: 'src/updated.ts',
          status: 'A',
        },
      ],
      projectId: 'project-1',
      revisionId: 'rev-2',
      source: 'worktree',
      taskId: 'task-1',
      totalAdded: 2,
      totalRemoved: 0,
      updatedAt: Date.now(),
      worktreePath: '/tmp/project/task-1',
    });

    await waitFor(() => {
      expect(screen.getByText('updated.ts')).toBeDefined();
    });

    expect(mergeTaskMock).not.toHaveBeenCalled();
    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  it('hides stale git status until refresh completes and blocks confirm while loading', async () => {
    const deferredRefresh = createDeferredPromise<boolean>();
    refreshTaskGitStatusForTaskMock.mockImplementationOnce(() => deferredRefresh.promise);

    setStore('taskGitStatus', 'task-1', {
      has_committed_changes: true,
      has_uncommitted_changes: true,
    });

    render(() => (
      <MergeDialog
        open
        task={createTestTask()}
        initialCleanup={true}
        onDone={() => {}}
        onDiffFileClick={() => {}}
      />
    ));

    expect(
      screen.queryByText(
        'Warning: You have uncommitted changes that will NOT be included in this merge.',
      ),
    ).toBeNull();
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    deferredRefresh.resolve(true);

    await waitFor(() => {
      expect(
        screen.getByText(
          'Warning: You have uncommitted changes that will NOT be included in this merge.',
        ),
      ).toBeDefined();
    });
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
  });

  it('shows an explicit warning and keeps merge blocked when git status cannot be verified', async () => {
    refreshTaskGitStatusForTaskMock.mockResolvedValueOnce(false);

    render(() => (
      <MergeDialog
        open
        task={createTestTask()}
        initialCleanup={true}
        onDone={() => {}}
        onDiffFileClick={() => {}}
      />
    ));

    await waitFor(() => {
      expect(
        screen.getByText(
          'Unable to verify current git status. Reopen this dialog after the worktree is available.',
        ),
      ).toBeDefined();
    });
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
