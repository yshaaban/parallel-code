import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal, onMount } from 'solid-js';
import { resetDialogStackForTests } from '../lib/dialog-stack';
import { Dialog } from './Dialog';

describe('Dialog', () => {
  afterEach(() => {
    cleanup();
    resetDialogStackForTests();
  });

  it('exposes accessible dialog semantics and labels the topmost dialog as modal', () => {
    render(() => (
      <>
        <Dialog open={true} onClose={vi.fn()} labelledBy="first-title">
          <h2 id="first-title">First Dialog</h2>
        </Dialog>
        <Dialog open={true} onClose={vi.fn()} labelledBy="second-title">
          <h2 id="second-title">Second Dialog</h2>
        </Dialog>
      </>
    ));

    const dialogs = screen.getAllByRole('dialog');

    expect(dialogs).toHaveLength(2);
    expect(dialogs[0].getAttribute('aria-labelledby')).toBe('first-title');
    expect(dialogs[0].hasAttribute('aria-modal')).toBe(false);
    expect(dialogs[1].getAttribute('aria-labelledby')).toBe('second-title');
    expect(dialogs[1].getAttribute('aria-modal')).toBe('true');
  });

  it('only lets the topmost dialog handle Escape', () => {
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    render(() => (
      <>
        <Dialog open={true} onClose={closeFirst} labelledBy="first-title">
          <h2 id="first-title">First Dialog</h2>
        </Dialog>
        <Dialog open={true} onClose={closeSecond} labelledBy="second-title">
          <h2 id="second-title">Second Dialog</h2>
        </Dialog>
      </>
    ));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(closeFirst).not.toHaveBeenCalled();
    expect(closeSecond).toHaveBeenCalledTimes(1);
  });

  it('takes initial focus from terminal input so Escape reaches the dialog instead of the PTY', async () => {
    const [open, setOpen] = createSignal(false);
    const terminalKeys = vi.fn();
    render(() => (
      <>
        <textarea
          aria-label="Terminal input"
          onKeyDown={(event) => {
            terminalKeys(event.key);
            event.stopPropagation();
          }}
        />
        <Dialog open={open()} onClose={() => setOpen(false)}>
          <h2>Help</h2>
        </Dialog>
      </>
    ));
    screen.getByRole('textbox', { name: 'Terminal input' }).focus();
    setOpen(true);
    const dialog = screen.getByRole('dialog');

    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(terminalKeys).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Terminal input' })),
    );
  });

  it("preserves a child control's explicit initial focus", () => {
    function AutofocusInput() {
      let input: HTMLInputElement | undefined;
      onMount(() => input?.focus());
      return <input ref={input} aria-label="Project name" />;
    }
    render(() => (
      <Dialog open={true} onClose={vi.fn()}>
        <AutofocusInput />
      </Dialog>
    ));

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Project name' }));
  });

  it('only lets the topmost dialog trap Tab focus', () => {
    render(() => (
      <>
        <Dialog open={true} onClose={vi.fn()} labelledBy="first-title">
          <>
            <h2 id="first-title">First Dialog</h2>
            <button type="button">First A</button>
            <button type="button">First B</button>
          </>
        </Dialog>
        <Dialog open={true} onClose={vi.fn()} labelledBy="second-title">
          <>
            <h2 id="second-title">Second Dialog</h2>
            <button type="button">Second A</button>
            <button type="button">Second B</button>
          </>
        </Dialog>
      </>
    ));

    const secondA = screen.getByRole('button', { name: 'Second A' });
    const secondB = screen.getByRole('button', { name: 'Second B' });
    secondA.focus();

    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement).toBe(secondB);
  });
});
