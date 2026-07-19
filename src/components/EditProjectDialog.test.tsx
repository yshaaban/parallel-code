import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal, Show, type JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestProject } from '../test/store-test-helpers';
import { installManualAnimationFrame } from '../test/manual-animation-frame';

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
    vi.unstubAllGlobals();
  });

  it('waits for state sync before closing after saving a base branch override', async () => {
    const deferred = createDeferred();
    saveCurrentRuntimeStateMock.mockReturnValue(deferred.promise);
    const onClose = vi.fn();

    render(() => <EditProjectDialog project={createTestProject()} onClose={onClose} />);

    expect(screen.getByText('Default new tasks to the project root')).toBeDefined();

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

  it('does not expose or save git-only settings for non-git projects', async () => {
    saveCurrentRuntimeStateMock.mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(() => (
      <EditProjectDialog
        project={createTestProject({
          projectMode: 'non-git',
          baseBranch: 'personal/main',
          branchPrefix: 'feature',
          defaultTaskGitIsolation: 'current-branch',
          deleteBranchOnClose: false,
        })}
        onClose={onClose}
      />
    ));

    expect(screen.queryByText('Base branch')).toBeNull();
    expect(screen.queryByText('Branch prefix')).toBeNull();
    expect(screen.queryByText('Always delete branch and worklog on merge')).toBeNull();
    expect(screen.queryByText('Default new tasks to the project root')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    expect(updateProjectMock).toHaveBeenCalledTimes(1);
    const firstUpdateCall = updateProjectMock.mock.calls[0];
    if (!firstUpdateCall) {
      throw new Error('Expected project update call');
    }
    const [, updates] = firstUpdateCall;
    expect(updates).not.toHaveProperty('baseBranch');
    expect(updates).not.toHaveProperty('branchPrefix');
    expect(updates).not.toHaveProperty('defaultDirectMode');
    expect(updates).not.toHaveProperty('defaultTaskGitIsolation');
    expect(updates).not.toHaveProperty('deleteBranchOnClose');
  });

  it('saves Docker container agent runner settings', async () => {
    saveCurrentRuntimeStateMock.mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(() => <EditProjectDialog project={createTestProject()} onClose={onClose} />);

    fireEvent.change(screen.getByDisplayValue('Host'), {
      target: { value: 'docker-container' },
    });
    fireEvent.input(screen.getByPlaceholderText('Docker image, for example node:22-alpine'), {
      target: { value: 'parallel-code-agent:latest' },
    });
    fireEvent.input(screen.getByPlaceholderText('Optional Dockerfile path inside the worktree'), {
      target: { value: 'docker/Dockerfile' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    expect(updateProjectMock).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        agentRunnerConfig: {
          dockerfile: 'docker/Dockerfile',
          image: 'parallel-code-agent:latest',
          provider: 'docker-container',
        },
      }),
    );
  });

  it('removes legacy container runner settings when saving canonical runner config', async () => {
    saveCurrentRuntimeStateMock.mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(() => (
      <EditProjectDialog
        project={createTestProject({
          containerConfig: {
            composeFile: 'compose.yaml',
            runnerProfile: {
              image: 'legacy-agent:latest',
              kind: 'docker',
            },
          },
        })}
        onClose={onClose}
      />
    ));

    fireEvent.input(screen.getByPlaceholderText('Docker image, for example node:22-alpine'), {
      target: { value: 'parallel-code-agent:latest' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    expect(updateProjectMock).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        agentRunnerConfig: {
          image: 'parallel-code-agent:latest',
          provider: 'docker-container',
        },
        containerConfig: {
          composeFile: 'compose.yaml',
        },
      }),
    );
  });

  it('clears agent runner settings when switching back to host', async () => {
    saveCurrentRuntimeStateMock.mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(() => (
      <EditProjectDialog
        project={createTestProject({
          agentRunnerConfig: {
            image: 'parallel-code-agent:latest',
            provider: 'docker-container',
          },
        })}
        onClose={onClose}
      />
    ));

    fireEvent.change(screen.getByDisplayValue('Docker container'), {
      target: { value: 'host' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    expect(updateProjectMock).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        agentRunnerConfig: undefined,
      }),
    );
  });

  it('clears legacy container runner settings when switching back to host', async () => {
    saveCurrentRuntimeStateMock.mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(() => (
      <EditProjectDialog
        project={createTestProject({
          containerConfig: {
            composeFile: 'compose.yaml',
            runnerProfile: {
              image: 'parallel-code-agent:latest',
              kind: 'docker',
            },
          },
        })}
        onClose={onClose}
      />
    ));

    expect(screen.getByDisplayValue('Docker container')).toBeDefined();

    fireEvent.change(screen.getByDisplayValue('Docker container'), {
      target: { value: 'host' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    expect(updateProjectMock).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        agentRunnerConfig: undefined,
        containerConfig: {
          composeFile: 'compose.yaml',
        },
      }),
    );
  });

  it('blocks unsupported Docker sandbox agent runner saves', () => {
    saveCurrentRuntimeStateMock.mockResolvedValue(undefined);

    render(() => <EditProjectDialog project={createTestProject()} onClose={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue('Host'), {
      target: { value: 'docker-sandbox' },
    });

    expect(
      screen.getByText(
        'Docker sandbox runners are reserved for a future provider and are not supported by this build.',
      ),
    ).toBeDefined();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks Dockerfile paths that backend validation would reject', () => {
    saveCurrentRuntimeStateMock.mockResolvedValue(undefined);

    render(() => <EditProjectDialog project={createTestProject()} onClose={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue('Host'), {
      target: { value: 'docker-container' },
    });
    fireEvent.input(screen.getByPlaceholderText('Optional Dockerfile path inside the worktree'), {
      target: { value: '../Dockerfile' },
    });

    expect(
      screen.getByText('Dockerfile path must be relative and stay inside the worktree.'),
    ).toBeDefined();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
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

  it('cancels stale project-name focus when the dialog closes before the scheduled frame', () => {
    const animationFrame = installManualAnimationFrame();
    const [project, setProject] = createSignal<ReturnType<typeof createTestProject> | null>(
      createTestProject(),
    );

    render(() => <EditProjectDialog project={project()} onClose={vi.fn()} />);

    const nameInput = screen.getByDisplayValue('Project') as HTMLInputElement;
    const focusSpy = vi.spyOn(nameInput, 'focus');

    setProject(null);
    animationFrame.flush();

    expect(animationFrame.cancelAnimationFrameMock).toHaveBeenCalledWith(1);
    expect(focusSpy).not.toHaveBeenCalled();
  });
});
