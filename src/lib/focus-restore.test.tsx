import { cleanup, render, screen } from '@solidjs/testing-library';
import { createSignal, type JSX } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installManualAnimationFrame } from '../test/manual-animation-frame';
import { createFocusRestore } from './focus-restore';

function FocusRestoreHarness(props: { open: boolean }): JSX.Element {
  createFocusRestore(() => props.open);
  return <span data-testid="focus-restore-harness" />;
}

describe('createFocusRestore', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('restores focus to the saved element after a dialog closes', () => {
    const animationFrame = installManualAnimationFrame();
    const [open, setOpen] = createSignal(false);

    render(() => (
      <>
        <button type="button">Outside</button>
        <FocusRestoreHarness open={open()} />
      </>
    ));

    const outsideButton = screen.getByRole('button', { name: 'Outside' }) as HTMLButtonElement;
    outsideButton.focus();
    const focusSpy = vi.spyOn(outsideButton, 'focus');

    setOpen(true);
    setOpen(false);
    outsideButton.blur();
    animationFrame.flush();

    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending restore when the dialog reopens before the frame runs', () => {
    const animationFrame = installManualAnimationFrame();
    const [open, setOpen] = createSignal(false);

    render(() => (
      <>
        <button type="button">Outside</button>
        <FocusRestoreHarness open={open()} />
      </>
    ));

    const outsideButton = screen.getByRole('button', { name: 'Outside' }) as HTMLButtonElement;
    outsideButton.focus();
    const focusSpy = vi.spyOn(outsideButton, 'focus');

    setOpen(true);
    setOpen(false);
    outsideButton.blur();
    setOpen(true);
    animationFrame.flush();

    expect(animationFrame.cancelAnimationFrameMock).toHaveBeenCalledWith(1);
    expect(focusSpy).not.toHaveBeenCalled();
  });
});
