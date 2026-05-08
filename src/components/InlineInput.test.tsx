import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineInput } from './InlineInput';

describe('InlineInput', () => {
  afterEach(() => {
    cleanup();
  });

  it('dismisses from the explicit cancel button', () => {
    const onDismiss = vi.fn();
    render(() => <InlineInput onDismiss={onDismiss} onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('Cancel'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses from global Escape even when the text input is not focused', () => {
    const onDismiss = vi.fn();
    render(() => <InlineInput onDismiss={onDismiss} onSubmit={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not double-dismiss when Escape starts inside the text input', () => {
    const onDismiss = vi.fn();
    render(() => <InlineInput onDismiss={onDismiss} onSubmit={vi.fn()} />);

    fireEvent.keyDown(screen.getByPlaceholderText('Add review comment...'), { key: 'Escape' });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
