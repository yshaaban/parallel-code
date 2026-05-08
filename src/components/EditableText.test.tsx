import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installManualAnimationFrame } from '../test/manual-animation-frame';
import { EditableText, type EditableTextHandle } from './EditableText';

describe('EditableText', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('cancels stale input focus when editing is cancelled before the scheduled frame', () => {
    const animationFrame = installManualAnimationFrame();
    let handle: EditableTextHandle | undefined;

    render(() => (
      <EditableText
        value="Terminal"
        onCommit={vi.fn()}
        onHandle={(nextHandle) => (handle = nextHandle)}
      />
    ));

    handle?.startEdit();
    const input = screen.getByDisplayValue('Terminal') as HTMLInputElement;
    const focusSpy = vi.spyOn(input, 'focus');

    fireEvent.keyDown(input, { key: 'Escape' });
    animationFrame.flush();

    expect(animationFrame.cancelAnimationFrameMock).toHaveBeenCalledWith(1);
    expect(focusSpy).not.toHaveBeenCalled();
  });
});
