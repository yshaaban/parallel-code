import { render, screen, waitFor } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
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
  relinkProject: relinkProjectMock,
  removeProjectWithTasks: removeProjectWithTasksMock,
  saveCurrentRuntimeState: saveCurrentRuntimeStateMock,
  updateProject: updateProjectMock,
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for state sync before closing after saving a base branch override', async () => {
    const deferred = createDeferred();
    saveCurrentRuntimeStateMock.mockReturnValue(deferred.promise);
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(() => <EditProjectDialog project={createTestProject()} onClose={onClose} />);

    const baseBranchInput = screen.getByPlaceholderText(
      'Auto-detect from Git (for example: main, trunk, personal/main)',
    );
    await user.type(baseBranchInput, 'personal/main');

    await user.click(screen.getByRole('button', { name: 'Save' }));

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
});
