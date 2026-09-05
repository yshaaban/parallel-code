import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installManualAnimationFrame } from '../test/manual-animation-frame';

const {
  getPlanSelectionMock,
  isElectronRuntimeMock,
  mermaidInitializeMock,
  mermaidRenderMock,
  openFileInEditorMock,
  openMarkdownViewerMock,
  showNotificationMock,
  writeTextMock,
} = vi.hoisted(() => ({
  getPlanSelectionMock: vi.fn(),
  isElectronRuntimeMock: vi.fn(() => true),
  mermaidInitializeMock: vi.fn(),
  mermaidRenderMock: vi.fn(),
  openFileInEditorMock: vi.fn(),
  openMarkdownViewerMock: vi.fn(),
  showNotificationMock: vi.fn(),
  writeTextMock: vi.fn(async () => undefined),
}));

vi.mock('../lib/plan-selection', () => ({
  getPlanSelection: getPlanSelectionMock,
}));

vi.mock('../app/markdown-viewer', () => ({
  openMarkdownViewer: openMarkdownViewerMock,
}));

vi.mock('../lib/browser-auth', async () => {
  const actual = await vi.importActual<typeof import('../lib/browser-auth')>('../lib/browser-auth');
  return {
    ...actual,
    isElectronRuntime: isElectronRuntimeMock,
  };
});

vi.mock('../lib/shell', () => ({
  openFileInEditor: openFileInEditorMock,
}));

vi.mock('../store/notification', () => ({
  showNotification: showNotificationMock,
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: mermaidInitializeMock,
    render: mermaidRenderMock,
  },
}));

import { PlanViewerDialog, resetPlanViewerDialogMermaidStateForTests } from './PlanViewerDialog';

describe('PlanViewerDialog', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetPlanViewerDialogMermaidStateForTests();
    getPlanSelectionMock.mockReset();
    mermaidInitializeMock.mockReset();
    mermaidRenderMock.mockReset();
    openFileInEditorMock.mockReset();
    openFileInEditorMock.mockResolvedValue(undefined);
    openMarkdownViewerMock.mockReset();
    openMarkdownViewerMock.mockResolvedValue(true);
    showNotificationMock.mockReset();
    isElectronRuntimeMock.mockReturnValue(true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it('shows an explicit empty state when the plan has no content', () => {
    render(() => (
      <PlanViewerDialog open onClose={() => {}} planContent={'   \n  '} planFileName="plan.md" />
    ));

    expect(screen.getByText('No plan yet')).toBeTruthy();
  });

  it('opens the backing plan file in the editor when available', async () => {
    render(() => (
      <PlanViewerDialog
        open
        onClose={() => {}}
        planContent={'# Example Plan'}
        planFileName="plan.md"
        relativePath=".parallel-code/plan.md"
        worktreePath="/tmp/task"
      />
    ));

    fireEvent.click(screen.getByLabelText('Open plan in editor'));

    await waitFor(() => {
      expect(openFileInEditorMock).toHaveBeenCalledWith('/tmp/task', '.parallel-code/plan.md');
    });
  });

  it('does not show editor actions in browser mode', () => {
    isElectronRuntimeMock.mockReturnValue(false);

    render(() => (
      <PlanViewerDialog
        open
        onClose={() => {}}
        planContent={'# Example Plan'}
        planFileName="plan.md"
        relativePath=".parallel-code/plan.md"
        worktreePath="/tmp/task"
      />
    ));

    expect(screen.queryByLabelText('Open plan in editor')).toBeNull();
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

    await waitFor(
      () => {
        const block = document.querySelector('.shiki-block');
        expect(block).not.toBeNull();
        expect(document.querySelector('.shiki-block code span')).not.toBeNull();
      },
      { timeout: 10_000 },
    );
  }, 15_000);

  it('renders Mermaid diagrams only inside the plan-viewer pipeline', async () => {
    let resolveDiagram: ((value: { svg: string }) => void) | undefined;
    mermaidRenderMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDiagram = resolve;
        }),
    );

    render(() => (
      <PlanViewerDialog
        open
        onClose={() => {}}
        planContent={'```mermaid\ngraph TD;\n  Start-->Ship\n```'}
        planFileName="plan.md"
      />
    ));

    expect(await screen.findByText(/graph TD;/, undefined, { timeout: 10_000 })).toBeTruthy();
    expect(screen.getByText(/Start-->Ship/)).toBeTruthy();

    await waitFor(
      () => {
        expect(mermaidRenderMock).toHaveBeenCalledWith(
          'plan-mermaid-1-0',
          'graph TD;\n  Start-->Ship',
        );
      },
      { timeout: 10_000 },
    );

    expect(document.querySelector('.plan-mermaid-block pre')).not.toBeNull();
    expect(mermaidInitializeMock).toHaveBeenCalledWith({
      securityLevel: 'strict',
      startOnLoad: false,
      theme: 'dark',
    });

    resolveDiagram?.({
      svg: '<svg data-testid="mermaid-diagram"><text>diagram</text></svg>',
    });

    await waitFor(
      () => {
        expect(document.querySelector('[data-testid="mermaid-diagram"]')).not.toBeNull();
      },
      { timeout: 10_000 },
    );
  }, 15_000);

  it('shows Mermaid source with an explicit error notice when rendering fails', async () => {
    mermaidRenderMock.mockRejectedValue(new Error('render failed'));

    render(() => (
      <PlanViewerDialog
        open
        onClose={() => {}}
        planContent={'```mermaid\ngraph TD;\n  Start-->Ship\n```'}
        planFileName="plan.md"
      />
    ));

    expect(await screen.findByText(/Unable to render Mermaid diagram/)).toBeTruthy();
    expect(screen.getByText(/graph TD;/)).toBeTruthy();
    expect(screen.getByText(/Start-->Ship/)).toBeTruthy();
  });

  it('initializes Mermaid only once across multiple plan renders', async () => {
    mermaidRenderMock.mockResolvedValue({
      svg: '<svg data-testid="mermaid-diagram"><text>diagram</text></svg>',
    });

    let setPlanContent!: (value: string) => void;
    render(() => {
      const [planContent, updatePlanContent] = createSignal(
        '```mermaid\ngraph TD;\n  Start-->Ship\n```',
      );
      setPlanContent = updatePlanContent;

      return (
        <PlanViewerDialog
          open
          onClose={() => {}}
          planContent={planContent()}
          planFileName="plan.md"
        />
      );
    });

    await waitFor(() => {
      expect(mermaidInitializeMock).toHaveBeenCalledTimes(1);
    });

    setPlanContent('```mermaid\ngraph TD;\n  Ship-->Done\n```');

    await waitFor(() => {
      expect(mermaidRenderMock).toHaveBeenCalledWith(
        'plan-mermaid-2-0',
        'graph TD;\n  Ship-->Done',
      );
    });
    expect(mermaidInitializeMock).toHaveBeenCalledTimes(1);
  });

  it('opens local markdown links in the shared viewer', async () => {
    render(() => (
      <PlanViewerDialog
        open
        onClose={() => {}}
        planContent={'[Guide](guide.md)'}
        planFileName="plan.md"
        relativePath="docs/plans/plan.md"
        taskId="task-1"
        worktreePath="/tmp/project"
      />
    ));

    fireEvent.click(await screen.findByText('Guide'));

    await waitFor(() => {
      expect(openMarkdownViewerMock).toHaveBeenCalledWith({
        agentId: undefined,
        relativePath: 'docs/plans/guide.md',
        taskId: 'task-1',
      });
    });
  });

  it('does not treat protocol-relative markdown links as local worktree files', async () => {
    render(() => (
      <PlanViewerDialog
        open
        onClose={() => {}}
        planContent={'[Guide](//example.com/guide.md)'}
        planFileName="plan.md"
        relativePath="docs/plans/plan.md"
        worktreePath="/tmp/project"
      />
    ));

    fireEvent.click(await screen.findByText('Guide'));

    await waitFor(() => {
      expect(openMarkdownViewerMock).not.toHaveBeenCalled();
    });
  });

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

  it('cancels stale scroll restoration when the viewer closes before the scheduled frame', async () => {
    const animationFrame = installManualAnimationFrame();
    getPlanSelectionMock.mockReturnValue({
      endLine: 4,
      nearestHeading: 'Execution',
      selectedText: '- run tests',
      startLine: 4,
    });
    const [open, setOpen] = createSignal(true);

    render(() => (
      <PlanViewerDialog
        open={open()}
        onClose={() => setOpen(false)}
        planContent={'# Example Plan\n\n## Execution\n\n- run tests'}
        planFileName="plan.md"
      />
    ));

    const scrollContainer = document.querySelector('.plan-markdown-dialog') as HTMLDivElement;
    const scrollTopSetter = vi.fn();
    Object.defineProperty(scrollContainer, 'scrollTop', {
      configurable: true,
      get: () => 240,
      set: scrollTopSetter,
    });

    const planMarkdown = document.querySelector('.plan-markdown');
    expect(planMarkdown).toBeTruthy();
    if (!planMarkdown) {
      return;
    }

    fireEvent.mouseUp(planMarkdown);
    const input = await screen.findByPlaceholderText('Add review comment...');
    animationFrame.flush();

    fireEvent.input(input, { target: { value: 'Keep scroll stable.' } });
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
    expect(animationFrame.pendingCount()).toBe(1);

    setOpen(false);
    animationFrame.flush();

    expect(animationFrame.cancelAnimationFrameMock).toHaveBeenCalled();
    expect(scrollTopSetter).not.toHaveBeenCalled();
  });
});
