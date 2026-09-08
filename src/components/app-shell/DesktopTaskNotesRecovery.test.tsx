import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopTaskNotesRecovery } from './DesktopTaskNotesRecovery';

const { confirmMock, discardMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  discardMock: vi.fn(),
}));
vi.mock('../../lib/dialog', () => ({ confirm: confirmMock }));
vi.mock('../../app/task-notes-recovery-channel', () => ({
  discardRecoveredDesktopTaskNotes: discardMock,
}));

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

  it('never applies an old discard confirmation to a replacement recovered record, even with identical text', async () => {
    let approve!: (value: boolean) => void;
    confirmMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    );
    const original = { draft: 'Same text', taskId: 'task-1', taskName: 'Task' };
    const [drafts, setDrafts] = createSignal([original]);
    const result = render(() => <DesktopTaskNotesRecovery drafts={drafts()} />);
    result.getByRole('button', { name: 'Discard draft' }).click();
    setDrafts([{ ...original }]);
    approve(true);
    await Promise.resolve();
    expect(discardMock).not.toHaveBeenCalled();
    expect((result.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Same text');
    confirmMock.mockResolvedValueOnce(true);
    result.getByRole('button', { name: 'Discard draft' }).click();
    await waitFor(() => expect(discardMock).toHaveBeenCalledWith('task-1'));
  });
});
