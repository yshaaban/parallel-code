import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Show, type JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('PathInputDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.GetHomePath) {
        return Promise.resolve('/home/tester');
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
  });

  it('submits git SSH URLs directly in clone mode without checking path existence', async () => {
    const onSubmit = vi.fn();

    render(() => (
      <PathInputDialog open directory allowSshClone onSubmit={onSubmit} onCancel={() => {}} />
    ));

    const input = await screen.findByRole('textbox');
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('/home/tester/');
    });
    fireEvent.input(input, { target: { value: 'git@github.com:user/repo.git' } });

    await waitFor(() => {
      expect(screen.getByText(/Clone into:/)).toBeTruthy();
      expect(screen.getByText('/home/tester/repo')).toBeTruthy();
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
      expect((input as HTMLInputElement).value).toBe('/home/tester/');
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
      expect((input as HTMLInputElement).value).toBe('/home/tester/');
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
});
