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
});
