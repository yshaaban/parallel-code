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

  it('cancels stale cancel-button focus when the dialog closes before the scheduled frame', () => {
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

    const cancelButton = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    const focusSpy = vi.spyOn(cancelButton, 'focus');

    setOpen(false);
    animationFrame.flush();

    expect(animationFrame.cancelAnimationFrameMock).toHaveBeenCalledWith(1);
    expect(focusSpy).not.toHaveBeenCalled();
  });
});
