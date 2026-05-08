import { cleanup, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installManualAnimationFrame } from '../test/manual-animation-frame';
import { DisplayNameDialog } from './DisplayNameDialog';

describe('DisplayNameDialog', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders startup progress while background startup is still active', () => {
    render(() => (
      <DisplayNameDialog
        open
        allowClose={false}
        onSave={() => {}}
        startupSummary={{
          detail: 'Loading workspace state · 1 attaching',
          label: 'Restoring your workspace…',
        }}
      />
    ));

    expect(screen.getByText('Restoring your workspace…')).toBeDefined();
    expect(screen.getByText('Loading workspace state · 1 attaching')).toBeDefined();
  });

  it('keeps the startup detail line mounted even when detail is absent', () => {
    render(() => (
      <DisplayNameDialog
        open
        allowClose={false}
        onSave={() => {}}
        startupSummary={{
          detail: null,
          label: 'Restoring your workspace…',
        }}
      />
    ));

    const status = screen.getByText('Restoring your workspace…').closest('[role="status"]');
    const detailLines = status?.querySelectorAll('span') ?? [];
    const detailLine = detailLines[detailLines.length - 1] as HTMLSpanElement | undefined;
    expect(detailLine).toBeTruthy();
    expect(detailLine?.style.visibility).toBe('hidden');
  });

  it('cancels stale input focus when the dialog closes before the scheduled frame', () => {
    const animationFrame = installManualAnimationFrame();
    const [open, setOpen] = createSignal(true);

    render(() => (
      <DisplayNameDialog open={open()} allowClose={false} onSave={() => {}} initialValue="Dev" />
    ));

    const input = screen.getByLabelText('Display name') as HTMLInputElement;
    const focusSpy = vi.spyOn(input, 'focus');
    const selectSpy = vi.spyOn(input, 'select');

    setOpen(false);
    animationFrame.flush();

    expect(animationFrame.cancelAnimationFrameMock).toHaveBeenCalledWith(1);
    expect(focusSpy).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();
  });
});
