import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
