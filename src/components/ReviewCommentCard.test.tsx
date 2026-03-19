import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewAnnotation } from '../app/review-session';
import { ReviewCommentCard } from './ReviewCommentCard';

function createAnnotation(overrides: Partial<ReviewAnnotation> = {}): ReviewAnnotation {
  return {
    id: 'annotation-1',
    source: 'src/example.ts',
    startLine: 4,
    endLine: 4,
    selectedText: 'const answer = 42;',
    comment: 'Rename this variable',
    ...overrides,
  };
}

describe('ReviewCommentCard', () => {
  it('saves in-place edits through the shared update handler', async () => {
    const onUpdate = vi.fn();

    render(() => (
      <ReviewCommentCard annotation={createAnnotation()} onDismiss={vi.fn()} onUpdate={onUpdate} />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const editor = screen.getByRole('textbox');
    fireEvent.input(editor, { target: { value: 'Use a clearer name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('annotation-1', 'Use a clearer name');
    });
  });

  it('does not submit blank edits', () => {
    const onUpdate = vi.fn();

    render(() => (
      <ReviewCommentCard annotation={createAnnotation()} onDismiss={vi.fn()} onUpdate={onUpdate} />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.input(screen.getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onUpdate).not.toHaveBeenCalled();
  });
});
