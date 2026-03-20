import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Show, createSignal, type JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestTask } from '../test/store-test-helpers';
import type { Task } from '../store/types';

const { pushTaskMock } = vi.hoisted(() => ({
  pushTaskMock: vi.fn(),
}));

vi.mock('../app/task-workflows', () => ({
  pushTask: pushTaskMock,
}));

vi.mock('./Dialog', () => ({
  Dialog: (props: { children: JSX.Element; onClose: () => void; open: boolean }) => (
    <Show when={props.open}>
      <div>
        <button type="button" onClick={() => props.onClose()}>
          Close dialog
        </button>
        {props.children}
      </div>
    </Show>
  ),
}));

function deferredPromise(): {
  promise: Promise<void>;
  reject: (error: unknown) => void;
  resolve: () => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((innerResolve, innerReject) => {
    resolve = () => innerResolve();
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

describe('PushDialog', () => {
  beforeEach(() => {
    vi.useRealTimers();
    pushTaskMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('streams push output and reports background completion after closing mid-push', async () => {
    const pushDeferred = deferredPromise();
    let outputListener: ((text: string) => void) | undefined;
    pushTaskMock.mockImplementation((_taskId: string, onOutput?: (text: string) => void) => {
      outputListener = onOutput;
      return pushDeferred.promise;
    });

    const onClose = vi.fn();
    const onDone = vi.fn();
    const onStart = vi.fn();

    const { PushDialog } = await import('./PushDialog');
    render(() => {
      const [open, setOpen] = createSignal(true);
      return (
        <PushDialog
          open={open()}
          task={createTestTask() as Task}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          onDone={onDone}
          onStart={onStart}
        />
      );
    });

    fireEvent.click(screen.getByText('Push'));
    expect(onStart).toHaveBeenCalledOnce();
    expect(pushTaskMock).toHaveBeenCalledOnce();

    await screen.findByText('Close');
    outputListener?.('Writing objects: 100% (3/3)\n');
    expect(screen.getByText(/Writing objects: 100%/)).toBeTruthy();

    fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onDone).not.toHaveBeenCalled();

    pushDeferred.resolve();
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledWith(true);
    });
  });

  it('cancels cleanly when idle', async () => {
    const onClose = vi.fn();
    const onDone = vi.fn();
    const onStart = vi.fn();

    const { PushDialog } = await import('./PushDialog');
    render(() => (
      <PushDialog
        open
        task={createTestTask() as Task}
        onClose={onClose}
        onDone={onDone}
        onStart={onStart}
      />
    ));

    fireEvent.click(screen.getByText('Cancel'));
    expect(onDone).toHaveBeenCalledWith(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });
});
