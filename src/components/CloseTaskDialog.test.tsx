import { render, screen, waitFor } from '@solidjs/testing-library';
import { Show, type JSX } from 'solid-js';
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
    render(() => <CloseTaskDialog open task={createTestTask()} onDone={() => {}} />);

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
      screen.getByText((content) =>
        content.startsWith('Warning: This branch has commits that have not been merged into'),
      ),
    ).toBeDefined();
  });

  it('skips git status refresh for direct-mode tasks', () => {
    render(() => (
      <CloseTaskDialog open task={createTestTask({ directMode: true })} onDone={() => {}} />
    ));

    expect(refreshTaskGitStatusForTaskMock).not.toHaveBeenCalled();
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
});
