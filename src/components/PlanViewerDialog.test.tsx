import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';

import { PlanViewerDialog } from './PlanViewerDialog';

describe('PlanViewerDialog', () => {
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
    });

    expect(document.querySelector('.shiki-block code span')).not.toBeNull();
  });
});
