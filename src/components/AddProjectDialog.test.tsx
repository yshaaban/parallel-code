import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Show, createSignal, type JSX } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredProject } from '../ipc/types';

const {
  addDiscoveredProjectMock,
  pickAndAddProjectMock,
  refreshDiscoveredProjectsMock,
  getUnaddedDiscoveredProjectsMock,
} = vi.hoisted(() => ({
  addDiscoveredProjectMock: vi.fn(),
  pickAndAddProjectMock: vi.fn(),
  refreshDiscoveredProjectsMock: vi.fn(),
  getUnaddedDiscoveredProjectsMock: vi.fn(),
}));

vi.mock('./Dialog', () => ({
  Dialog: (props: { children: JSX.Element; open: boolean }) => (
    <Show when={props.open}>{props.children}</Show>
  ),
}));

vi.mock('../app/project-workflows', () => ({
  addDiscoveredProject: addDiscoveredProjectMock,
  pickAndAddProject: pickAndAddProjectMock,
}));

vi.mock('../app/discovered-projects', () => ({
  refreshDiscoveredProjects: refreshDiscoveredProjectsMock,
  getUnaddedDiscoveredProjects: getUnaddedDiscoveredProjectsMock,
}));

import { AddProjectDialog } from './AddProjectDialog';

function discovered(overrides: Partial<DiscoveredProject> = {}): DiscoveredProject {
  return {
    path: '/Users/me/src/foo',
    name: 'foo',
    source: 'claude',
    updatedAtMs: 1_000,
    ...overrides,
  };
}

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('AddProjectDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshDiscoveredProjectsMock.mockResolvedValue(undefined);
    getUnaddedDiscoveredProjectsMock.mockReturnValue([]);
  });

  it('renders discovered proposals with their source badges', async () => {
    getUnaddedDiscoveredProjectsMock.mockReturnValue([
      discovered({ path: '/Users/me/src/foo', name: 'foo', source: 'claude' }),
      discovered({ path: '/Users/me/repos/bar', name: 'bar', source: 'git' }),
    ]);

    render(() => <AddProjectDialog open onClose={() => {}} />);

    expect(await screen.findByText('foo')).toBeDefined();
    expect(screen.getByText('bar')).toBeDefined();
    expect(screen.getByText('Claude')).toBeDefined();
    expect(screen.getByText('git')).toBeDefined();
    // Discovery is refreshed on open so newly-active projects appear.
    expect(refreshDiscoveredProjectsMock).toHaveBeenCalledWith({ force: true });
  });

  it('adds the chosen discovered project and closes', async () => {
    addDiscoveredProjectMock.mockResolvedValue('project-1');
    getUnaddedDiscoveredProjectsMock.mockReturnValue([
      discovered({ path: '/Users/me/src/foo', name: 'foo' }),
    ]);
    const onClose = vi.fn();

    render(() => <AddProjectDialog open onClose={onClose} />);

    fireEvent.click(await screen.findByText('foo'));

    await waitFor(() => {
      expect(addDiscoveredProjectMock).toHaveBeenCalledWith('/Users/me/src/foo');
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('falls back to the Browse flow on demand', async () => {
    pickAndAddProjectMock.mockResolvedValue('project-2');
    // Seed a proposal so the dialog stays put instead of auto-defaulting to Browse.
    getUnaddedDiscoveredProjectsMock.mockReturnValue([discovered()]);
    const onClose = vi.fn();

    render(() => <AddProjectDialog open onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: /Browse or clone/i }));

    expect(onClose).toHaveBeenCalled();
    await waitFor(() => {
      expect(pickAndAddProjectMock).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the empty state open when nothing is discovered', async () => {
    getUnaddedDiscoveredProjectsMock.mockReturnValue([]);
    const onClose = vi.fn();

    render(() => <AddProjectDialog open onClose={onClose} />);

    expect(
      await screen.findByText('No new projects discovered - use Browse to add one.'),
    ).toBeDefined();
    expect(pickAndAddProjectMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not auto-open Browse after the dialog is closed during discovery', async () => {
    const refresh = createDeferredPromise<undefined>();
    refreshDiscoveredProjectsMock.mockReturnValue(refresh.promise);
    getUnaddedDiscoveredProjectsMock.mockReturnValue([]);

    const [open, setOpen] = createSignal(true);
    render(() => (
      <Show when={open()}>
        <AddProjectDialog open onClose={() => setOpen(false)} />
      </Show>
    ));

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    refresh.resolve(undefined);
    await refresh.promise;
    await Promise.resolve();

    expect(pickAndAddProjectMock).not.toHaveBeenCalled();
  });
});
