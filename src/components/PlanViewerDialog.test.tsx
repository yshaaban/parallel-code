import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getPlanSelectionMock, writeTextMock } = vi.hoisted(() => ({
  getPlanSelectionMock: vi.fn(),
  writeTextMock: vi.fn(async () => undefined),
}));

vi.mock('../lib/plan-selection', () => ({
  getPlanSelection: getPlanSelectionMock,
}));

import { PlanViewerDialog } from './PlanViewerDialog';

describe('PlanViewerDialog', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    getPlanSelectionMock.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('renders the plan file name and content when open', () => {
    render(() => (
      <PlanViewerDialog
        open
        onClose={() => {}}
        planContent={'# Example Plan\n\n- step one'}
        planFileName="plan.md"
      />
    ));

    expect(screen.getByText('plan.md')).toBeTruthy();
  });

  it('renders the plan markdown content when open', async () => {
    render(() => (
      <PlanViewerDialog
        open
        onClose={() => {}}
        planContent={'# Example Plan\n\n- step one'}
        planFileName="plan.md"
      />
    ));

    await waitFor(() => {
      expect(screen.getByText('Example Plan')).toBeTruthy();
      expect(screen.getByText('step one')).toBeTruthy();
    });
  });

  it('scrolls the content area with keyboard navigation', () => {
    render(() => (
      <PlanViewerDialog
        open
        onClose={() => {}}
        planContent={'# Example Plan\n\n' + 'line\n'.repeat(50)}
        planFileName="plan.md"
      />
    ));

    const content = document.querySelector('.plan-markdown-dialog') as HTMLDivElement | null;
    expect(content).not.toBeNull();

    if (!content) {
      return;
    }

    Object.defineProperty(content, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    content.scrollTop = 0;

    fireEvent.keyDown(content, { key: 'ArrowDown' });
    expect(content.scrollTop).toBe(40);

    fireEvent.keyDown(content, { key: 'PageDown' });
    expect(content.scrollTop).toBe(240);

    fireEvent.keyDown(content, { key: 'End' });
    expect(content.scrollTop).toBe(1200);

    fireEvent.keyDown(content, { key: 'Home' });
    expect(content.scrollTop).toBe(0);
  });

  it('renders fenced code blocks with syntax highlighting', async () => {
    render(() => (
      <PlanViewerDialog
        open
        onClose={() => {}}
        planContent={'```ts\nconst value = 42;\n```'}
        planFileName="plan.md"
      />
    ));

    await waitFor(() => {
      const block = document.querySelector('.shiki-block');
      expect(block).not.toBeNull();
      expect(document.querySelector('.shiki-block code span')).not.toBeNull();
    });
  }, 10_000);

  it('copies plan review comments through the shared review sidebar actions', async () => {
    getPlanSelectionMock.mockReturnValue({
      endLine: 4,
      nearestHeading: 'Execution',
      selectedText: '- run tests',
      startLine: 4,
    });

    render(() => (
      <PlanViewerDialog
        open
        onClose={() => {}}
        planContent={'# Example Plan\n\n## Execution\n\n- run tests'}
        planFileName="plan.md"
      />
    ));

    const planMarkdown = document.querySelector('.plan-markdown');
    expect(planMarkdown).toBeTruthy();
    if (!planMarkdown) {
      return;
    }

    fireEvent.mouseUp(planMarkdown);

    const input = await screen.findByPlaceholderText('Add review comment...');
    fireEvent.input(input, { target: { value: 'Explain the rollback path too.' } });
    const inlineInput = input.closest('div');
    expect(inlineInput).toBeTruthy();
    if (!inlineInput) {
      return;
    }

    const submitCommentButton = within(inlineInput as HTMLElement).getAllByRole('button', {
      name: 'Comment',
    })[1];
    expect(submitCommentButton).toBeTruthy();
    if (!submitCommentButton) {
      return;
    }

    fireEvent.click(submitCommentButton);

    expect(await screen.findByRole('button', { name: 'Copy Comments' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prompt with Comments (1)' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy Comments' }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        [
          'Feedback on the implementation plan:',
          '',
          '## plan.md § Execution',
          '> - run tests',
          '',
          'Explain the rollback path too.',
          '',
        ].join('\n'),
      );
    });
  });
});
