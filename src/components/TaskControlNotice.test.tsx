import { fireEvent, render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { TaskControlBanner } from './TaskControlBanner';
import { TaskControlChip } from './TaskControlChip';

describe('compact task control notices', () => {
  it('retains the full owner message and explicit takeover and dismiss actions', () => {
    const onTakeOver = vi.fn();
    const onDismiss = vi.fn();
    const message = 'A peer with a long display name is currently typing in this terminal.';
    const view = render(() => (
      <TaskControlBanner message={message} onTakeOver={onTakeOver} onDismiss={onDismiss} />
    ));

    expect(view.getByRole('status').textContent).toBe(message);
    expect(view.getByTitle(message)).toBe(view.getByRole('status'));
    expect(onTakeOver).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Take Over' }));
    expect(onTakeOver).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole('button', { name: 'Dismiss control notice' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onTakeOver).toHaveBeenCalledTimes(1);
  });

  it.each(['banner', 'chip'] as const)(
    '%s keeps takeover disabled while pending and updates the owner without remounting',
    (kind) => {
      const [busy, setBusy] = createSignal(false);
      const [label, setLabel] = createSignal('Ivan typing');
      const onTakeOver = vi.fn();
      const view = render(() =>
        kind === 'banner' ? (
          <TaskControlBanner
            busy={busy()}
            message={label()}
            onTakeOver={onTakeOver}
            takeOverLabel="Take Over Prompt"
          />
        ) : (
          <TaskControlChip
            busy={busy()}
            label={label()}
            onTakeOver={onTakeOver}
            takeOverLabel="Take Over Prompt"
          />
        ),
      );
      const button = view.getByRole('button', { name: 'Take Over Prompt' }) as HTMLButtonElement;
      expect(view.queryByRole('button', { name: 'Dismiss control notice' })).toBeNull();
      setBusy(true);
      expect(view.getByRole('button', { name: 'Taking over…' })).toBe(button);
      expect(button.disabled).toBe(true);
      button.click();
      expect(onTakeOver).not.toHaveBeenCalled();
      setBusy(false);
      setLabel('Sara typing');
      expect(view.getByRole('status').textContent).toBe('Sara typing');
      expect(view.getByRole('button', { name: 'Take Over Prompt' })).toBe(button);
      button.click();
      expect(onTakeOver).toHaveBeenCalledTimes(1);
    },
  );
});
