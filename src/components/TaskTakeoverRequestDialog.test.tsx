import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskTakeoverRequestDialog } from './TaskTakeoverRequestDialog';

describe('TaskTakeoverRequestDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('disables takeover actions while a response is in flight', () => {
    render(() => (
      <TaskTakeoverRequestDialog
        busy={true}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onExpire={vi.fn()}
        request={{
          action: 'type in the terminal',
          expiresAt: Date.now() + 5_000,
          requestId: 'request-1',
          requesterClientId: 'peer-a',
          requesterDisplayName: 'Peer A',
          taskId: 'task-1',
        }}
      />
    ));

    expect(screen.getByRole('button', { name: 'Working…' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Allow' }).hasAttribute('disabled')).toBe(true);
    expect(document.querySelector('.task-takeover-request-card')?.getAttribute('aria-busy')).toBe(
      'true',
    );
  });

  it('exposes takeover requests as named alert dialogs', () => {
    render(() => (
      <TaskTakeoverRequestDialog
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onExpire={vi.fn()}
        request={{
          action: 'type in the terminal',
          expiresAt: Date.now() + 5_000,
          requestId: 'request:1',
          requesterClientId: 'peer-a',
          requesterDisplayName: 'Peer A',
          taskId: 'task-1',
        }}
      />
    ));

    const dialog = screen.getByRole('alertdialog', { name: 'Allow takeover?' });
    expect(dialog.textContent).toContain(
      'Peer A wants to take control of this task to type in the terminal.',
    );
    expect(dialog.getAttribute('aria-describedby')).toBe('task-takeover-request-1-message');
  });

  it('routes approve and deny callbacks with the request identity', () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    render(() => (
      <TaskTakeoverRequestDialog
        onApprove={onApprove}
        onDeny={onDeny}
        onExpire={vi.fn()}
        request={{
          action: 'send a prompt',
          expiresAt: Date.now() + 5_000,
          requestId: 'request-1',
          requesterClientId: 'peer-a',
          requesterDisplayName: 'Peer A',
          taskId: 'task-1',
        }}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onApprove).toHaveBeenCalledWith('request-1', 'task-1');

    fireEvent.click(screen.getByRole('button', { name: 'Keep Control' }));
    expect(onDeny).toHaveBeenCalledWith('request-1', 'task-1');
  });
});
