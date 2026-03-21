import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Show, type JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestProject } from '../test/store-test-helpers';

const {
  isProjectMissingMock,
  relinkProjectMock,
  removeProjectWithTasksMock,
  saveCurrentRuntimeStateMock,
  updateProjectMock,
} = vi.hoisted(() => ({
  isProjectMissingMock: vi.fn(() => false),
  relinkProjectMock: vi.fn(),
  removeProjectWithTasksMock: vi.fn(),
  saveCurrentRuntimeStateMock: vi.fn(),
  updateProjectMock: vi.fn(),
}));

vi.mock('./Dialog', () => ({
  Dialog: (props: { children: JSX.Element; open: boolean }) => (
    <Show when={props.open}>{props.children}</Show>
  ),
}));

vi.mock('../store/store', () => ({
  PASTEL_HUES: [0, 30, 60],
  isProjectMissing: isProjectMissingMock,
  saveCurrentRuntimeState: saveCurrentRuntimeStateMock,
  updateProject: updateProjectMock,
}));

vi.mock('../app/project-workflows', () => ({
  relinkProject: relinkProjectMock,
  removeProjectWithTasks: removeProjectWithTasksMock,
}));

import { EditProjectDialog } from './EditProjectDialog';

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('EditProjectDialog', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for state sync before closing after saving a base branch override', async () => {
    const deferred = createDeferred();
    saveCurrentRuntimeStateMock.mockReturnValue(deferred.promise);
    const onClose = vi.fn();

    render(() => <EditProjectDialog project={createTestProject()} onClose={onClose} />);

    const baseBranchInput = screen.getByPlaceholderText(
      'Auto-detect from Git (for example: main, trunk, personal/main)',
    );
    fireEvent.input(baseBranchInput, {
      target: { value: 'personal/main' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateProjectMock).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        baseBranch: 'personal/main',
      }),
    );
    expect(saveCurrentRuntimeStateMock).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Saving...' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    deferred.resolve();

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('re-links a missing project through the app workflow and closes on success', async () => {
    isProjectMissingMock.mockReturnValue(true);
    relinkProjectMock.mockResolvedValue(true);
    const onClose = vi.fn();

    render(() => <EditProjectDialog project={createTestProject()} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Re-link' }));

    await waitFor(() => {
      expect(relinkProjectMock).toHaveBeenCalledWith('project-1');
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the dialog open when re-linking a missing project fails', async () => {
    isProjectMissingMock.mockReturnValue(true);
    relinkProjectMock.mockResolvedValue(false);
    const onClose = vi.fn();

    render(() => <EditProjectDialog project={createTestProject()} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Re-link' }));

    await waitFor(() => {
      expect(relinkProjectMock).toHaveBeenCalledWith('project-1');
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
