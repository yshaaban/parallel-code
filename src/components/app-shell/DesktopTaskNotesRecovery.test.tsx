import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopTaskNotesRecovery } from './DesktopTaskNotesRecovery';

afterEach(() => cleanup());

describe('DesktopTaskNotesRecovery', () => {
  it('keeps a detached draft readable and falls back to selecting it when copy is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard unavailable')) },
    });
    render(() => (
      <DesktopTaskNotesRecovery
        drafts={[{ draft: 'recover this text', taskId: 'task-1', taskName: 'Removed task' }]}
      />
    ));

    const editor = screen.getByRole('textbox', {
      name: 'Recovered notes for Removed task',
    }) as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
    expect(editor.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Copy draft' }));

    await waitFor(() => expect(document.activeElement).toBe(editor));
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe('recover this text'.length);
  });
});
