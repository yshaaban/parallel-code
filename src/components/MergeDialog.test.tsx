import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Show, createSignal, type JSX } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTaskReviewEvent,
  replaceTaskReviewSnapshots,
  resetTaskReviewProjectionStateForTests,
} from '../app/task-review-state';
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
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });

  return { promise, reject, resolve };
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
    isTaskGitStatusFresh: vi.fn(
      (status: { freshness?: 'fresh' | 'stale' } | undefined) =>
        status !== undefined && status.freshness !== 'stale',
    ),
    refreshTaskGitStatusForTask: refreshTaskGitStatusForTaskMock,
  };
});

import { MergeDialog } from './MergeDialog';

describe('MergeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    resetTaskReviewProjectionStateForTests();
    setStore('projects', [createTestProject({ baseBranch: 'main' })]);
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.GetBranchLog:
          return Promise.resolve('');
        case IPC.CheckMergeStatus:
          return Promise.resolve({
            conflicting_files: [],
            current_branch: 'feature/task-1',
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
        task={createTestTask({ baseBranch: 'release/main' })}
        initialCleanup={true}
        onDone={() => {}}
        onDiffFileClick={onDiffFileClick}
      />
    ));

    expect(refreshTaskGitStatusForTaskMock).toHaveBeenCalledWith('task-1');
    expect(screen.getByText('Merge into release/main')).toBeDefined();
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
    await waitFor(() => {
      expect(refreshTaskGitStatusForTaskMock).toHaveBeenCalledWith('task-1');
    });

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

  it('ignores stale git status refresh results after switching tasks', async () => {
    invokeMock.mockImplementation((channel: IPC, payload?: { worktreePath?: string }) => {
      switch (channel) {
        case IPC.GetBranchLog:
          return Promise.resolve('');
        case IPC.CheckMergeStatus:
          return Promise.resolve({
            conflicting_files: [],
            current_branch:
              payload?.worktreePath === '/tmp/project/task-2' ? 'feature/task-2' : 'feature/task-1',
            main_ahead_count: 0,
          });
        case IPC.RebaseTask:
          return Promise.resolve(undefined);
        default:
          throw new Error(`Unexpected channel: ${channel}`);
      }
    });
    const firstRefresh = createDeferredPromise<boolean>();
    const secondRefresh = createDeferredPromise<boolean>();
    refreshTaskGitStatusForTaskMock
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockImplementationOnce(() => secondRefresh.promise);
    const [task, setTask] = createSignal(createTestTask());

    render(() => (
      <MergeDialog
        open
        task={task()}
        initialCleanup={true}
        onDone={() => {}}
        onDiffFileClick={() => {}}
      />
    ));

    await waitFor(() => {
      expect(refreshTaskGitStatusForTaskMock).toHaveBeenCalledWith('task-1');
    });

    setTask(
      createTestTask({
        branchName: 'feature/task-2',
        id: 'task-2',
        worktreePath: '/tmp/project/task-2',
      }),
    );
    await waitFor(() => {
      expect(refreshTaskGitStatusForTaskMock).toHaveBeenCalledWith('task-2');
    });

    firstRefresh.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(
      screen.queryByText(
        'Unable to verify current git status. Reopen this dialog after the worktree is available.',
      ),
    ).toBeNull();
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    secondRefresh.resolve(false);

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

  it('does not treat stale failed git status as authoritative after refresh settles', async () => {
    refreshTaskGitStatusForTaskMock.mockResolvedValueOnce(true);
    setStore('taskGitStatus', 'task-1', {
      errorMessage: 'git status failed',
      freshness: 'stale',
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

    await waitFor(() => {
      expect(screen.getByText(/Details: git status failed/u)).toBeDefined();
    });
    expect(
      screen.queryByText(
        'Warning: You have uncommitted changes that will NOT be included in this merge.',
      ),
    ).toBeNull();
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('shows a branch mismatch warning and blocks merge when the worktree branch drifted', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.GetBranchLog:
          return Promise.resolve('');
        case IPC.CheckMergeStatus:
          return Promise.resolve({
            conflicting_files: [],
            current_branch: 'feature/other-branch',
            main_ahead_count: 0,
          });
        case IPC.RebaseTask:
          return Promise.resolve(undefined);
        default:
          throw new Error(`Unexpected channel: ${channel}`);
      }
    });

    setStore('taskGitStatus', 'task-1', {
      has_committed_changes: true,
      has_uncommitted_changes: false,
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

    await waitFor(() => {
      expect(
        screen.getByText(
          'Task worktree is on feature/other-branch, expected feature/task-1. Refresh the task branch before merging.',
        ),
      ).toBeDefined();
    });
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('promotes plain rebase when the base branch is ahead without conflicts', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.GetBranchLog:
          return Promise.resolve('');
        case IPC.CheckMergeStatus:
          return Promise.resolve({
            conflicting_files: [],
            current_branch: 'feature/task-1',
            main_ahead_count: 2,
          });
        case IPC.RebaseTask:
          return Promise.resolve(undefined);
        default:
          throw new Error(`Unexpected channel: ${channel}`);
      }
    });

    setStore('agents', 'agent-1', {
      def: {
        args: [],
        command: 'claude',
        description: 'Claude',
        id: 'claude',
        name: 'Claude',
        resume_args: [],
        skip_permissions_args: [],
      },
      exitCode: null,
      generation: 0,
      id: 'agent-1',
      lastOutput: [],
      resumed: true,
      signal: null,
      status: 'running',
      taskId: 'task-1',
    });
    setStore('taskGitStatus', 'task-1', {
      has_committed_changes: true,
      has_uncommitted_changes: false,
    });

    render(() => (
      <MergeDialog
        open
        task={createTestTask({ agentIds: ['agent-1'] })}
        initialCleanup={true}
        onDone={() => {}}
        onDiffFileClick={() => {}}
      />
    ));

    const rebaseButton = await screen.findByRole('button', { name: 'Rebase onto main' });
    expect(await screen.findByRole('button', { name: 'Rebase with AI' })).toBeDefined();

    expect(rebaseButton.style.borderStyle).toBe('none');
  });

  it('ignores stale merge failures after switching tasks', async () => {
    const merge = createDeferredPromise<undefined>();
    mergeTaskMock.mockImplementationOnce(() => merge.promise);
    setStore('taskGitStatus', 'task-1', {
      has_committed_changes: true,
      has_uncommitted_changes: false,
    });
    setStore('taskGitStatus', 'task-2', {
      has_committed_changes: true,
      has_uncommitted_changes: false,
    });
    const [task, setTask] = createSignal(createTestTask());

    render(() => (
      <MergeDialog
        open
        task={task()}
        initialCleanup={true}
        onDone={() => {}}
        onDiffFileClick={() => {}}
      />
    ));

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    setTask(
      createTestTask({
        branchName: 'feature/task-2',
        id: 'task-2',
        worktreePath: '/tmp/project/task-2',
      }),
    );
    merge.reject(new Error('Old merge failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText('Error: Old merge failed')).toBeNull();
  });
});
