import { fireEvent, render, screen } from '@solidjs/testing-library';
import { batch, createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { ExposePortDialog } from './ExposePortDialog';

describe('ExposePortDialog', () => {
  it('resets form state when reopened', async () => {
    const onExpose = vi.fn();
    const onClose = vi.fn();
    const onRefreshCandidates = vi.fn();
    const [open, setOpen] = createSignal(true);
    const [defaultPort, setDefaultPort] = createSignal(5173);
    const [defaultLabel, setDefaultLabel] = createSignal('Frontend');

    render(() => (
      <ExposePortDialog
        candidates={[]}
        open={open()}
        defaultPort={defaultPort()}
        defaultLabel={defaultLabel()}
        onClose={onClose}
        onExpose={onExpose}
        onRefreshCandidates={onRefreshCandidates}
        scanError={null}
        scanning={false}
      />
    ));

    const portInput = screen.getByPlaceholderText('5173') as HTMLInputElement;
    const labelInput = screen.getByPlaceholderText('Frontend dev server') as HTMLInputElement;

    fireEvent.input(portInput, { currentTarget: { value: '3000' }, target: { value: '3000' } });
    fireEvent.input(labelInput, {
      currentTarget: { value: 'Changed label' },
      target: { value: 'Changed label' },
    });

    setOpen(false);
    await Promise.resolve();
    batch(() => {
      setDefaultPort(8080);
      setDefaultLabel('Web app');
      setOpen(true);
    });
    await Promise.resolve();

    const reopenedPortInput = screen.getByPlaceholderText('5173') as HTMLInputElement;
    const reopenedLabelInput = screen.getByPlaceholderText(
      'Frontend dev server',
    ) as HTMLInputElement;

    expect(reopenedPortInput.value).toBe('8080');
    expect(reopenedLabelInput.value).toBe('Web app');
  });

  it('does not clobber in-progress edits while open when defaults change', () => {
    const onExpose = vi.fn();
    const onClose = vi.fn();
    const onRefreshCandidates = vi.fn();
    const [open] = createSignal(true);
    const [defaultPort, setDefaultPort] = createSignal(5173);
    const [defaultLabel, setDefaultLabel] = createSignal('Frontend');

    render(() => (
      <ExposePortDialog
        candidates={[]}
        open={open()}
        defaultPort={defaultPort()}
        defaultLabel={defaultLabel()}
        onClose={onClose}
        onExpose={onExpose}
        onRefreshCandidates={onRefreshCandidates}
        scanError={null}
        scanning={false}
      />
    ));

    const portInput = screen.getByPlaceholderText('5173') as HTMLInputElement;
    const labelInput = screen.getByPlaceholderText('Frontend dev server') as HTMLInputElement;

    fireEvent.input(portInput, { currentTarget: { value: '3000' }, target: { value: '3000' } });
    fireEvent.input(labelInput, {
      currentTarget: { value: 'Changed label' },
      target: { value: 'Changed label' },
    });

    batch(() => {
      setDefaultPort(8080);
      setDefaultLabel('Web app');
    });

    expect(portInput.value).toBe('3000');
    expect(labelInput.value).toBe('Changed label');
  });

  it('renders scanned candidates as the primary exposure flow', () => {
    const onExpose = vi.fn();

    render(() => (
      <ExposePortDialog
        candidates={[
          {
            host: '127.0.0.1',
            port: 5173,
            source: 'task',
            suggestion: 'Listening in this task worktree',
          },
          {
            host: '127.0.0.1',
            port: 8080,
            source: 'local',
            suggestion: 'Active local server port',
          },
        ]}
        open
        onClose={vi.fn()}
        onExpose={onExpose}
        onRefreshCandidates={vi.fn()}
        scanError={null}
        scanning={false}
      />
    ));

    expect(screen.getByText('Port 5173')).toBeDefined();
    expect(screen.getByText('Listening in this task worktree')).toBeDefined();
    expect(screen.getByText('Port 8080')).toBeDefined();
    expect(screen.getByText('Active local server port')).toBeDefined();
  });

  it('exposes a scanned candidate without relying on manual typing', () => {
    const onExpose = vi.fn();

    render(() => (
      <ExposePortDialog
        candidates={[
          {
            host: '127.0.0.1',
            port: 5173,
            source: 'task',
            suggestion: 'Listening in this task worktree',
          },
        ]}
        open
        onClose={vi.fn()}
        onExpose={onExpose}
        onRefreshCandidates={vi.fn()}
        scanError={null}
        scanning={false}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Expose port' }));
    expect(onExpose).toHaveBeenCalledWith(5173, undefined);
  });
});
