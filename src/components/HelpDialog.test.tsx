import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelpDialog } from './HelpDialog';

describe('HelpDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the onboarding section when requested', () => {
    render(() => <HelpDialog open={true} onClose={vi.fn()} showIntro={true} />);

    expect(screen.getByText('Getting Started')).toBeDefined();
    expect(
      screen.getByText(
        'Ownership follows the person currently typing. Use Take Over when another session controls a terminal or prompt.',
      ),
    ).toBeDefined();
  });

  it('hides the onboarding section by default and shows the task move shortcut', () => {
    render(() => <HelpDialog open={true} onClose={vi.fn()} />);

    expect(screen.queryByText('Getting Started')).toBeNull();
    expect(screen.getByText('Move task left or right')).toBeDefined();
    expect(screen.queryByText('Reorder tasks/terminals')).toBeNull();
  });
});
