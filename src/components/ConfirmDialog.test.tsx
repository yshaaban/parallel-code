import { cleanup, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installManualAnimationFrame } from '../test/manual-animation-frame';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('focuses confirm for ordinary confirms so Enter can accept', () => {
    const animationFrame = installManualAnimationFrame();

    render(() => (
      <ConfirmDialog
        open
        title="Continue?"
        message="Proceed with the operation."
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    ));

    const confirmButton = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;

    animationFrame.flush();

    expect(document.activeElement).toBe(confirmButton);
  });

  it('focuses cancel for danger confirms even when caller requests confirm focus', () => {
    const animationFrame = installManualAnimationFrame();

    render(() => (
      <ConfirmDialog
        open
        danger
        autoFocusCancel={false}
        title="Delete task?"
        message="This cannot be undone."
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    ));

    const cancelButton = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;

    animationFrame.flush();

    expect(document.activeElement).toBe(cancelButton);
  });

  it('focuses cancel while confirm is disabled', () => {
    const animationFrame = installManualAnimationFrame();

    render(() => (
      <ConfirmDialog
        open
        confirmDisabled
        title="Blocked confirm"
        message="The confirm action is not available."
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    ));

    const cancelButton = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;

    animationFrame.flush();

    expect(document.activeElement).toBe(cancelButton);
  });

  it('focuses cancel while confirm is loading', () => {
    const animationFrame = installManualAnimationFrame();

    render(() => (
      <ConfirmDialog
        open
        confirmLoading
        title="Running confirm"
        message="The confirm action is already running."
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    ));

    const cancelButton = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;

    animationFrame.flush();

    expect(document.activeElement).toBe(cancelButton);
  });

  it('does not refocus when confirm availability changes while open', () => {
    const animationFrame = installManualAnimationFrame();
    const [confirmDisabled, setConfirmDisabled] = createSignal(true);

    render(() => (
      <ConfirmDialog
        open
        confirmDisabled={confirmDisabled()}
        title="Blocked confirm"
        message="The confirm action is not available yet."
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    ));

    const cancelButton = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;

    animationFrame.flush();
    expect(document.activeElement).toBe(cancelButton);

    setConfirmDisabled(false);
    animationFrame.flush();

    expect(document.activeElement).toBe(cancelButton);
  });

  it('cancels stale confirm-button focus when the dialog closes before the scheduled frame', () => {
    const animationFrame = installManualAnimationFrame();
    const [open, setOpen] = createSignal(true);

    render(() => (
      <ConfirmDialog
        open={open()}
        title="Delete task?"
        message="This cannot be undone."
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    ));

    const confirmButton = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
    const focusSpy = vi.spyOn(confirmButton, 'focus');

    setOpen(false);
    animationFrame.flush();

    expect(animationFrame.cancelAnimationFrameMock).toHaveBeenCalledWith(1);
    expect(focusSpy).not.toHaveBeenCalled();
  });
});
