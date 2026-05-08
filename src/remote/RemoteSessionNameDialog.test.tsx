import { cleanup, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installManualAnimationFrame } from '../test/manual-animation-frame';
import { RemoteSessionNameDialog } from './RemoteSessionNameDialog';

describe('RemoteSessionNameDialog', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('focuses the session name input when the dialog is still open', () => {
    const animationFrame = installManualAnimationFrame();

    render(() => (
      <RemoteSessionNameDialog initialValue="Mobile 1234" onSave={vi.fn()} open={true} />
    ));

    const input = screen.getByLabelText('Session name') as HTMLInputElement;
    const focusSpy = vi.spyOn(input, 'focus');
    const selectSpy = vi.spyOn(input, 'select');

    animationFrame.flush();

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels stale input focus when the dialog closes before the scheduled frame', () => {
    const animationFrame = installManualAnimationFrame();
    const [open, setOpen] = createSignal(true);

    render(() => (
      <RemoteSessionNameDialog initialValue="Mobile 1234" onSave={vi.fn()} open={open()} />
    ));

    const input = screen.getByLabelText('Session name') as HTMLInputElement;
    const focusSpy = vi.spyOn(input, 'focus');
    const selectSpy = vi.spyOn(input, 'select');

    setOpen(false);
    animationFrame.flush();

    expect(animationFrame.cancelAnimationFrameMock).toHaveBeenCalledWith(1);
    expect(focusSpy).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();
  });
});
