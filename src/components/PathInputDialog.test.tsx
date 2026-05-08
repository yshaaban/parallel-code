import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal, Show, type JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installManualAnimationFrame } from '../test/manual-animation-frame';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('./Dialog', () => ({
  Dialog: (props: { children: JSX.Element; open: boolean }) => (
    <Show when={props.open}>{props.children}</Show>
  ),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

import { IPC } from '../../electron/ipc/channels';
import { PathInputDialog } from './PathInputDialog';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('PathInputDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.GetHomePath) {
        return Promise.resolve('/home/tester');
      }
      if (channel === IPC.GetProjectBasePath) {
        return Promise.resolve('/workspace');
      }
      if (channel === IPC.ListDirectory) {
        return Promise.resolve(['projects', 'workspace']);
      }
      if (channel === IPC.GetRecentProjects) {
        return Promise.resolve(['/home/tester/projects/alpha']);
      }
      if (channel === IPC.CheckPathExists) {
        return Promise.resolve(true);
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('submits git SSH URLs directly in clone mode without checking path existence', async () => {
    const onSubmit = vi.fn();

    render(() => (
      <PathInputDialog open directory allowSshClone onSubmit={onSubmit} onCancel={() => {}} />
    ));

    const input = await screen.findByRole('textbox');
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('/workspace/');
    });
    fireEvent.input(input, { target: { value: 'git@github.com:user/repo.git' } });

    await waitFor(() => {
      expect(screen.getByText(/Clone into:/)).toBeTruthy();
      expect(screen.getByText('/workspace/repo')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Clone & Select' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clone & Select' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('git@github.com:user/repo.git');
    });
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.CheckPathExists, {
      path: 'git@github.com:user/repo.git',
    });
  });

  it('resolves home-relative paths before validating and submitting them', async () => {
    const onSubmit = vi.fn();

    render(() => <PathInputDialog open directory onSubmit={onSubmit} onCancel={() => {}} />);

    const input = await screen.findByRole('textbox');
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('/workspace/');
    });
    fireEvent.input(input, { target: { value: '~/projects/alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select Path' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC.CheckPathExists, {
        path: '/home/tester/projects/alpha',
      });
      expect(onSubmit).toHaveBeenCalledWith('/home/tester/projects/alpha');
    });
  });

  it('shows a validation error for non-absolute non-SSH input', async () => {
    const onSubmit = vi.fn();

    render(() => (
      <PathInputDialog open directory allowSshClone onSubmit={onSubmit} onCancel={() => {}} />
    ));

    const input = await screen.findByRole('textbox');
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('/workspace/');
    });
    fireEvent.input(input, { target: { value: 'relative/path' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select Path' }));

    await waitFor(() => {
      expect(screen.getByText('Path must be absolute (start with / or ~)')).toBeTruthy();
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.CheckPathExists, {
      path: 'relative/path',
    });
  });

  it('falls back to the home path when the project base path cannot be loaded', async () => {
    const onSubmit = vi.fn();
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.GetHomePath) {
        return Promise.resolve('/home/tester');
      }
      if (channel === IPC.GetProjectBasePath) {
        return Promise.reject(new Error('not available'));
      }
      if (channel === IPC.ListDirectory) {
        return Promise.resolve(['projects', 'workspace']);
      }
      if (channel === IPC.GetRecentProjects) {
        return Promise.resolve([]);
      }
      if (channel === IPC.CheckPathExists) {
        return Promise.resolve(true);
      }
      return Promise.resolve(undefined);
    });

    render(() => <PathInputDialog open directory onSubmit={onSubmit} onCancel={() => {}} />);

    const input = await screen.findByRole('textbox');
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('/home/tester/');
    });
  });

  it('cancels stale input focus when the dialog closes before the scheduled frame', async () => {
    const animationFrame = installManualAnimationFrame();
    const [open, setOpen] = createSignal(true);

    render(() => (
      <PathInputDialog open={open()} directory onSubmit={vi.fn()} onCancel={() => {}} />
    ));

    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    await waitFor(() => {
      expect(input.value).toBe('/workspace/');
    });
    const focusSpy = vi.spyOn(input, 'focus');

    setOpen(false);
    animationFrame.flush();

    expect(animationFrame.cancelAnimationFrameMock).toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('ignores stale recent project loads after the dialog closes and reopens', async () => {
    const firstRecentProjects = createDeferred<string[]>();
    let recentProjectRequestCount = 0;
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.GetHomePath) {
        return Promise.resolve('/home/tester');
      }
      if (channel === IPC.GetProjectBasePath) {
        return Promise.resolve('/workspace');
      }
      if (channel === IPC.ListDirectory) {
        return Promise.resolve(['projects', 'workspace']);
      }
      if (channel === IPC.GetRecentProjects) {
        recentProjectRequestCount += 1;
        if (recentProjectRequestCount === 1) {
          return firstRecentProjects.promise;
        }

        return Promise.resolve(['/home/tester/projects/new']);
      }
      if (channel === IPC.CheckPathExists) {
        return Promise.resolve(true);
      }
      return Promise.resolve(undefined);
    });
    const [open, setOpen] = createSignal(true);

    render(() => (
      <PathInputDialog open={open()} directory onSubmit={vi.fn()} onCancel={() => {}} />
    ));

    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    await waitFor(() => {
      expect(input.value).toBe('/workspace/');
    });

    setOpen(false);
    setOpen(true);

    await waitFor(() => {
      expect(screen.getByText('new')).toBeTruthy();
    });

    firstRecentProjects.resolve(['/home/tester/projects/old']);
    await Promise.resolve();

    expect(screen.getByText('new')).toBeTruthy();
    expect(screen.queryByText('old')).toBeNull();
  });
});
