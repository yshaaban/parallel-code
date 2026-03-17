import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskTakeoverRequestDialog } from './TaskTakeoverRequestDialog';

describe('TaskTakeoverRequestDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders takeover actions and expires the request when the timeout elapses', async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const onExpire = vi.fn();

    render(() => (
      <TaskTakeoverRequestDialog
        request={{
          action: 'type in the terminal',
          expiresAt: Date.now() + 5_000,
          requestId: 'request-1',
          requesterClientId: 'client-b',
          requesterDisplayName: 'Sara',
          taskId: 'task-1',
        }}
        onApprove={onApprove}
        onDeny={onDeny}
        onExpire={onExpire}
      />
    ));

    expect(screen.getByText('Allow takeover?')).toBeTruthy();
    expect(screen.getByText(/Sara wants to take control/)).toBeTruthy();
    expect(screen.getByText(/Times out in 5s/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Keep Control' }));
    expect(onDeny).toHaveBeenCalledWith('request-1', 'task-1');

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onApprove).toHaveBeenCalledWith('request-1', 'task-1');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(onExpire).toHaveBeenCalledWith('request-1', 'task-1');
  });
});
