import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFocusStateForTests, triggerFocus } from '../store/focus';

const { createTerminalMock, openNewTaskDialogMock, unfocusPlaceholderMock } = vi.hoisted(() => ({
  createTerminalMock: vi.fn(),
  openNewTaskDialogMock: vi.fn(),
  unfocusPlaceholderMock: vi.fn(),
}));

vi.mock('../app/new-task-dialog-workflows', () => ({
  openNewTaskDialog: openNewTaskDialogMock,
}));

vi.mock('../store/store', () => ({
  createTerminal: createTerminalMock,
  unfocusPlaceholder: unfocusPlaceholderMock,
}));

import { NewTaskPlaceholder } from './NewTaskPlaceholder';

describe('NewTaskPlaceholder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFocusStateForTests();
  });

  afterEach(() => {
    cleanup();
    resetFocusStateForTests();
  });

  it('keeps store navigation registration while DOM focus owns presentation', () => {
    render(() => <NewTaskPlaceholder />);
    const taskButton = screen.getByRole('button', { name: 'New task' });
    const terminalButton = screen.getByRole('button', { name: 'New terminal' });

    triggerFocus('placeholder:add-task');
    expect(document.activeElement).toBe(taskButton);
    triggerFocus('placeholder:add-terminal');
    expect(document.activeElement).toBe(terminalButton);

    expect(taskButton.getAttribute('style')).toContain('2px dashed var(--border)');
    expect(terminalButton.getAttribute('style')).toContain('2px dashed var(--border)');
  });

  it('preserves mouse and keyboard activation semantics', () => {
    render(() => <NewTaskPlaceholder />);
    const taskButton = screen.getByRole('button', { name: 'New task' });
    const terminalButton = screen.getByRole('button', { name: 'New terminal' });

    fireEvent.click(taskButton);
    fireEvent.keyDown(taskButton, { key: 'Enter' });
    expect(openNewTaskDialogMock).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(terminalButton, { key: ' ' });
    expect(unfocusPlaceholderMock).toHaveBeenCalledTimes(1);
    expect(createTerminalMock).toHaveBeenCalledTimes(1);
  });
});
