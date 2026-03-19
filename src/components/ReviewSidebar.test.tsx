import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewAnnotation } from '../app/review-session';
import { ReviewSidebar } from './ReviewSidebar';

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

describe('ReviewSidebar', () => {
  it('edits comments in place through the shared review-session update path', async () => {
    const onUpdate = vi.fn();

    render(() => (
      <ReviewSidebar
        annotations={[createAnnotation()]}
        canSubmit
        onDismiss={vi.fn()}
        onScrollTo={vi.fn()}
        onSubmit={vi.fn()}
        onUpdate={onUpdate}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Use a clearer name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('annotation-1', 'Use a clearer name');
    });
  });

  it('keeps the dismiss and scroll actions available while not editing', () => {
    render(() => (
      <ReviewSidebar
        annotations={[createAnnotation()]}
        canSubmit={false}
        onDismiss={vi.fn()}
        onScrollTo={vi.fn()}
        onSubmit={vi.fn()}
        onUpdate={vi.fn()}
      />
    ));

    expect(screen.getByText('Review Comments (1)')).toBeDefined();
    expect(screen.getByRole('button', { name: '×' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDefined();
  });
});
