import { render, screen, waitFor } from '@solidjs/testing-library';
import { Show, createSignal, type JSX } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';

const { closeTaskMock, refreshTaskGitStatusForTaskMock } = vi.hoisted(() => ({
  closeTaskMock: vi.fn(),
  refreshTaskGitStatusForTaskMock: vi.fn(() => Promise.resolve(true)),
}));

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

vi.mock('../app/task-workflows', () => ({
  closeTask: closeTaskMock,
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

import { CloseTaskDialog } from './CloseTaskDialog';

describe('CloseTaskDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    setStore('projects', [createTestProject({ baseBranch: 'main' })]);
  });

  it('reads warning state from shared task git status and refreshes it on open', async () => {
    render(() => (
      <CloseTaskDialog
        open
        task={createTestTask({ baseBranch: 'release/main' })}
        onDone={() => {}}
      />
    ));

    expect(refreshTaskGitStatusForTaskMock).toHaveBeenCalledWith('task-1');
    expect(closeTaskMock).not.toHaveBeenCalled();
    expect(
      screen.queryByText('Warning: There are uncommitted changes that will be permanently lost.'),
    ).toBeNull();

    setStore('taskGitStatus', 'task-1', {
      has_committed_changes: true,
      has_uncommitted_changes: true,
    });

    await waitFor(() => {
      expect(
        screen.getByText('Warning: There are uncommitted changes that will be permanently lost.'),
      ).toBeDefined();
    });
    expect(
      screen.getByText(
        'Warning: This branch has commits that have not been merged into release/main.',
      ),
    ).toBeDefined();
  });

  it('skips git status refresh for direct-mode tasks', () => {
    render(() => (
      <CloseTaskDialog open task={createTestTask({ directMode: true })} onDone={() => {}} />
    ));

    expect(refreshTaskGitStatusForTaskMock).not.toHaveBeenCalled();
  });

  it('shows non-git close copy without refreshing git status', () => {
    render(() => (
      <CloseTaskDialog
        open
        task={createTestTask({
          branchName: '',
          projectMode: 'non-git',
          worktreePath: '/tmp/folder',
        })}
        onDone={() => {}}
      />
    ));

    expect(refreshTaskGitStatusForTaskMock).not.toHaveBeenCalled();
    expect(screen.getByText(/non-git task/u)).toBeDefined();
    expect(screen.getByText(/No git operations will be performed/u)).toBeDefined();
    expect(screen.queryByText(/will be permanently deleted/u)).toBeNull();
  });

  it('skips git status refresh and deletion warning for external worktree tasks', () => {
    render(() => (
      <CloseTaskDialog
        open
        task={createTestTask({
          gitIsolation: 'existing-worktree',
          worktreeOwnership: 'external',
        })}
        onDone={() => {}}
      />
    ));

    expect(refreshTaskGitStatusForTaskMock).not.toHaveBeenCalled();
    expect(screen.getByText(/The existing worktree and branch will be kept/u)).toBeDefined();
    expect(screen.queryByText(/will be permanently deleted/u)).toBeNull();
  });

  it('hides stale warning state until the shared git status refresh completes', async () => {
    const deferredRefresh = createDeferredPromise<boolean>();
    refreshTaskGitStatusForTaskMock.mockImplementationOnce(() => deferredRefresh.promise);

    setStore('taskGitStatus', 'task-1', {
      has_committed_changes: true,
      has_uncommitted_changes: true,
    });

    render(() => <CloseTaskDialog open task={createTestTask()} onDone={() => {}} />);

    expect(
      screen.queryByText('Warning: There are uncommitted changes that will be permanently lost.'),
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
        screen.getByText('Warning: There are uncommitted changes that will be permanently lost.'),
      ).toBeDefined();
    });
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
  });

  it('ignores stale git status refresh results after switching tasks', async () => {
    const firstRefresh = createDeferredPromise<boolean>();
    const secondRefresh = createDeferredPromise<boolean>();
    refreshTaskGitStatusForTaskMock
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockImplementationOnce(() => secondRefresh.promise);
    const [task, setTask] = createSignal(createTestTask());

    render(() => <CloseTaskDialog open task={task()} onDone={() => {}} />);

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

    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      screen.queryByText(
        'Warning: Unable to verify current git status. Closing may remove uncommitted changes or unmerged commits.',
      ),
    ).toBeNull();

    secondRefresh.resolve(false);

    await waitFor(() => {
      expect(
        screen.getByText(
          'Warning: Unable to verify current git status. Closing may remove uncommitted changes or unmerged commits.',
        ),
      ).toBeDefined();
    });
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('shows an explicit warning when git status cannot be verified after refresh', async () => {
    refreshTaskGitStatusForTaskMock.mockResolvedValueOnce(false);

    render(() => <CloseTaskDialog open task={createTestTask()} onDone={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByText(
          'Warning: Unable to verify current git status. Closing may remove uncommitted changes or unmerged commits.',
        ),
      ).toBeDefined();
    });
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      false,
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

    render(() => <CloseTaskDialog open task={createTestTask()} onDone={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Details: git status failed/u)).toBeDefined();
    });
    expect(
      screen.queryByText('Warning: There are uncommitted changes that will be permanently lost.'),
    ).toBeNull();
  });
});
