import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReviewSession } from '../app/review-session';
import type { ChangedFile } from '../ipc/types';
import { ScrollingDiffView } from './ScrollingDiffView';

const {
  detectLangMock,
  fetchTaskFileDiffMock,
  getDiffSelectionMock,
  highlightLinesMock,
  openFileInEditorMock,
} = vi.hoisted(() => ({
  detectLangMock: vi.fn(() => 'typescript'),
  fetchTaskFileDiffMock: vi.fn(),
  getDiffSelectionMock: vi.fn(),
  highlightLinesMock: vi.fn().mockResolvedValue([]),
  openFileInEditorMock: vi.fn(),
}));

const startAskSessionMock = vi.fn();

async function waitForVisibleText(text: string): Promise<HTMLElement> {
  let element: HTMLElement | null = null;

  await waitFor(() => {
    element = screen.queryByText(text);
    expect(element).not.toBeNull();
  });

  if (!element) {
    throw new Error(`Expected text to be visible: ${text}`);
  }

  return element;
}

function createChangedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    committed: false,
    lines_added: 1,
    lines_removed: 0,
    path: 'src/demo.ts',
    status: 'modified',
    ...overrides,
  };
}

vi.mock('../app/review-diffs', () => ({
  fetchTaskFileDiff: fetchTaskFileDiffMock,
}));

vi.mock('../lib/diff-selection', () => ({
  getDiffSelection: getDiffSelectionMock,
}));

vi.mock('../lib/shell', () => ({
  openFileInEditor: openFileInEditorMock,
}));

vi.mock('../lib/shiki-highlighter', () => ({
  detectLang: detectLangMock,
  highlightLines: highlightLinesMock,
}));

vi.mock('./AskCodeCard', () => ({
  AskCodeCard: (props: { question: string }) => <div>Ask: {props.question}</div>,
}));

describe('ScrollingDiffView', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
    startAskSessionMock.mockReset();
    detectLangMock.mockReset();
    detectLangMock.mockReturnValue('typescript');
    fetchTaskFileDiffMock.mockReset();
    getDiffSelectionMock.mockReset();
    highlightLinesMock.mockReset();
    highlightLinesMock.mockResolvedValue([]);
    openFileInEditorMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('expands hidden context lines with the correct old line numbers', async () => {
    fetchTaskFileDiffMock.mockResolvedValue({
      diff: '',
      oldContent: '',
      newContent:
        'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n',
    });

    render(() => (
      <ScrollingDiffView
        file={createChangedFile()}
        files={[
          {
            path: 'src/demo.ts',
            status: 'M',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldCount: 2,
                newStart: 1,
                newCount: 2,
                lines: [
                  { type: 'context', content: 'line 1', oldLine: 1, newLine: 1 },
                  { type: 'context', content: 'line 2', oldLine: 2, newLine: 2 },
                ],
              },
              {
                oldStart: 9,
                oldCount: 2,
                newStart: 9,
                newCount: 2,
                lines: [
                  { type: 'context', content: 'line 9', oldLine: 9, newLine: 9 },
                  { type: 'context', content: 'line 10', oldLine: 10, newLine: 10 },
                ],
              },
            ],
          },
        ]}
        request={{ worktreePath: '/tmp/task' }}
        reviewSession={createReviewSession()}
        scrollToPath={null}
        startAskSession={startAskSessionMock}
      />
    ));

    const gapToggle = await waitForVisibleText('6 lines hidden');

    fireEvent.click(gapToggle);

    await waitForVisibleText('line 8');

    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
    expect(screen.getAllByText('4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('5').length).toBeGreaterThan(0);
  });

  it('auto-expands a small leading gap', async () => {
    fetchTaskFileDiffMock.mockResolvedValue({
      diff: '',
      oldContent: '',
      newContent: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n',
    });

    render(() => (
      <ScrollingDiffView
        file={createChangedFile()}
        files={[
          {
            path: 'src/demo.ts',
            status: 'M',
            binary: false,
            hunks: [
              {
                oldStart: 4,
                oldCount: 2,
                newStart: 4,
                newCount: 2,
                lines: [
                  { type: 'context', content: 'line 4', oldLine: 4, newLine: 4 },
                  { type: 'context', content: 'line 5', oldLine: 5, newLine: 5 },
                ],
              },
            ],
          },
        ]}
        request={{ worktreePath: '/tmp/task' }}
        reviewSession={createReviewSession()}
        scrollToPath={null}
        startAskSession={startAskSessionMock}
      />
    ));

    await waitFor(() => {
      expect(fetchTaskFileDiffMock).toHaveBeenCalled();
    });
    await waitForVisibleText('line 1');
    await waitForVisibleText('line 3');
  });

  it('auto-expands a small trailing gap', async () => {
    fetchTaskFileDiffMock.mockResolvedValue({
      diff: '',
      oldContent: '',
      newContent: 'line 1\nline 2\nline 3\nline 4\nline 5\n',
    });

    render(() => (
      <ScrollingDiffView
        file={createChangedFile()}
        files={[
          {
            path: 'src/demo.ts',
            status: 'M',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldCount: 2,
                newStart: 1,
                newCount: 2,
                lines: [
                  { type: 'context', content: 'line 1', oldLine: 1, newLine: 1 },
                  { type: 'context', content: 'line 2', oldLine: 2, newLine: 2 },
                ],
              },
            ],
          },
        ]}
        request={{ worktreePath: '/tmp/task' }}
        reviewSession={createReviewSession()}
        scrollToPath={null}
        startAskSession={startAskSessionMock}
      />
    ));

    await waitFor(() => {
      expect(fetchTaskFileDiffMock).toHaveBeenCalled();
    });
    await waitForVisibleText('line 3');
    await waitForVisibleText('line 5');
  });

  it('renders omitted lines in added files as additions', async () => {
    fetchTaskFileDiffMock.mockResolvedValue({
      diff: '',
      oldContent: '',
      newContent: 'line 1\nline 2\nline 3\nline 4\nline 5\n',
    });

    const { container } = render(() => (
      <ScrollingDiffView
        file={createChangedFile({ status: 'added' })}
        files={[
          {
            path: 'src/demo.ts',
            status: 'A',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldCount: 0,
                newStart: 3,
                newCount: 1,
                lines: [{ type: 'add', content: 'line 3', oldLine: null, newLine: 3 }],
              },
            ],
          },
        ]}
        request={{ worktreePath: '/tmp/task' }}
        reviewSession={createReviewSession()}
        scrollToPath={null}
        startAskSession={startAskSessionMock}
      />
    ));

    await waitFor(() => {
      const leadingRow = container.querySelector(
        '[data-line-content="line 1"][data-line-type="add"]',
      );
      const trailingRow = container.querySelector(
        '[data-line-content="line 5"][data-line-type="add"]',
      );
      expect(leadingRow).not.toBeNull();
      expect(trailingRow).not.toBeNull();
    });
  });

  it('adds an inline review comment from the current diff selection', async () => {
    const reviewSession = createReviewSession();
    getDiffSelectionMock.mockReturnValue({
      filePath: 'src/demo.ts',
      startLine: 6,
      endLine: 6,
      selectedText: 'line 6',
    });

    render(() => (
      <ScrollingDiffView
        file={createChangedFile()}
        files={[
          {
            path: 'src/demo.ts',
            status: 'M',
            binary: false,
            hunks: [
              {
                oldStart: 6,
                oldCount: 1,
                newStart: 6,
                newCount: 1,
                lines: [{ type: 'context', content: 'line 6', oldLine: 6, newLine: 6 }],
              },
            ],
          },
        ]}
        request={{ worktreePath: '/tmp/task' }}
        reviewSession={reviewSession}
        scrollToPath={null}
        startAskSession={startAskSessionMock}
      />
    ));

    fireEvent.mouseUp(screen.getByText('line 6'));

    const commentInput = await screen.findByPlaceholderText('Add review comment...');

    fireEvent.input(commentInput, {
      target: { value: 'Need more context here' },
    });
    fireEvent.keyDown(commentInput, { key: 'Enter' });

    await waitForVisibleText('Need more context here');
  });

  it('restores the scroll position when the first review comment opens the sidebar', async () => {
    const reviewSession = createReviewSession();
    getDiffSelectionMock.mockReturnValue({
      filePath: 'src/demo.ts',
      startLine: 6,
      endLine: 6,
      selectedText: 'line 6',
    });

    render(() => (
      <ScrollingDiffView
        file={createChangedFile()}
        files={[
          {
            path: 'src/demo.ts',
            status: 'M',
            binary: false,
            hunks: [
              {
                oldStart: 6,
                oldCount: 1,
                newStart: 6,
                newCount: 1,
                lines: [{ type: 'context', content: 'line 6', oldLine: 6, newLine: 6 }],
              },
            ],
          },
        ]}
        request={{ worktreePath: '/tmp/task' }}
        reviewSession={reviewSession}
        scrollToPath={null}
        startAskSession={startAskSessionMock}
      />
    ));

    const scrollContainer = screen.getByText('line 6').closest('[tabindex="0"]') as HTMLDivElement;
    let currentScrollTop = 120;
    Object.defineProperty(scrollContainer, 'scrollTop', {
      configurable: true,
      get: () => currentScrollTop,
      set: (value: number) => {
        currentScrollTop = value;
      },
    });
    fireEvent.mouseUp(screen.getByText('line 6'));

    const commentInput = await screen.findByPlaceholderText('Add review comment...');
    scrollContainer.scrollTop = 120;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      scrollContainer.scrollTop = 0;
      callback(0);
      return 0;
    });
    fireEvent.input(commentInput, {
      target: { value: 'Need more context here' },
    });
    fireEvent.keyDown(commentInput, { key: 'Enter' });

    await waitFor(() => {
      expect(currentScrollTop).toBe(120);
    });

    rafSpy.mockRestore();
  });

  it('scrolls the diff viewer with keyboard navigation', () => {
    const reviewSession = createReviewSession();
    const { container } = render(() => (
      <ScrollingDiffView
        file={createChangedFile()}
        files={[
          {
            path: 'src/demo.ts',
            status: 'M',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldCount: 3,
                newStart: 1,
                newCount: 3,
                lines: [
                  { type: 'context', content: 'line 1', oldLine: 1, newLine: 1 },
                  { type: 'context', content: 'line 2', oldLine: 2, newLine: 2 },
                  { type: 'context', content: 'line 3', oldLine: 3, newLine: 3 },
                ],
              },
            ],
          },
        ]}
        request={{ worktreePath: '/tmp/task' }}
        reviewSession={reviewSession}
        scrollToPath={null}
        startAskSession={startAskSessionMock}
      />
    ));

    const scrollContainer = container.querySelector('[tabindex="0"]') as HTMLDivElement | null;
    expect(scrollContainer).not.toBeNull();

    if (!scrollContainer) {
      return;
    }

    Object.defineProperty(scrollContainer, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    scrollContainer.scrollTop = 0;

    fireEvent.keyDown(scrollContainer, { key: 'ArrowDown' });
    expect(scrollContainer.scrollTop).toBe(40);

    fireEvent.keyDown(scrollContainer, { key: 'PageDown' });
    expect(scrollContainer.scrollTop).toBe(240);
  });

  it('expands hidden context with the parsed file path when rendering a branch-sourced multi-file diff', async () => {
    fetchTaskFileDiffMock.mockResolvedValue({
      diff: '',
      oldContent: '',
      newContent: 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\n',
    });

    render(() => (
      <ScrollingDiffView
        file={createChangedFile({
          committed: true,
          path: 'src/origin.ts',
          status: 'modified',
        })}
        files={[
          {
            path: 'src/other.ts',
            status: 'A',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldCount: 2,
                newStart: 1,
                newCount: 2,
                lines: [
                  { type: 'context', content: 'alpha', oldLine: 1, newLine: 1 },
                  { type: 'context', content: 'beta', oldLine: 2, newLine: 2 },
                ],
              },
              {
                oldStart: 9,
                oldCount: 2,
                newStart: 9,
                newCount: 2,
                lines: [
                  { type: 'context', content: 'iota', oldLine: 9, newLine: 9 },
                  { type: 'context', content: 'kappa', oldLine: 10, newLine: 10 },
                ],
              },
            ],
          },
        ]}
        request={{
          branchName: 'feature/demo',
          projectRoot: '/tmp/project',
          worktreePath: '/tmp/task',
        }}
        requestSource="branch"
        reviewSession={createReviewSession()}
        scrollToPath={null}
        startAskSession={startAskSessionMock}
      />
    ));

    expect(fetchTaskFileDiffMock).not.toHaveBeenCalled();

    const gapToggle = await waitForVisibleText('6 lines hidden');

    fireEvent.click(gapToggle);

    await waitFor(() => {
      expect(fetchTaskFileDiffMock).toHaveBeenCalledWith(
        { branchName: 'feature/demo', projectRoot: '/tmp/project', worktreePath: '/tmp/task' },
        {
          committed: true,
          path: 'src/other.ts',
          status: 'A',
        },
      );
    });
  });

  it('does not preload trailing gaps for non-selected files in a multi-file diff', async () => {
    render(() => (
      <ScrollingDiffView
        file={createChangedFile({
          committed: true,
          path: 'src/selected.ts',
          status: 'modified',
        })}
        files={[
          {
            path: 'src/selected.ts',
            status: 'M',
            binary: true,
            hunks: [],
          },
          {
            path: 'src/other.ts',
            status: 'M',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldCount: 1,
                newStart: 1,
                newCount: 1,
                lines: [{ type: 'context', content: 'beta', oldLine: 1, newLine: 1 }],
              },
            ],
          },
        ]}
        request={{
          branchName: 'feature/demo',
          projectRoot: '/tmp/project',
          worktreePath: '/tmp/task',
        }}
        requestSource="branch"
        reviewSession={createReviewSession()}
        scrollToPath={null}
        startAskSession={startAskSessionMock}
      />
    ));

    await Promise.resolve();

    expect(fetchTaskFileDiffMock).not.toHaveBeenCalled();
  });

  it('renders syntax-highlighted diff lines when highlighter output is available', async () => {
    highlightLinesMock.mockResolvedValue(['<span class="hl">line 6</span>']);

    const { container } = render(() => (
      <ScrollingDiffView
        file={createChangedFile()}
        files={[
          {
            path: 'src/demo.ts',
            status: 'M',
            binary: false,
            hunks: [
              {
                oldStart: 6,
                oldCount: 1,
                newStart: 6,
                newCount: 1,
                lines: [{ type: 'context', content: 'line 6', oldLine: 6, newLine: 6 }],
              },
            ],
          },
        ]}
        request={{ worktreePath: '/tmp/task' }}
        reviewSession={createReviewSession()}
        scrollToPath={null}
        startAskSession={startAskSessionMock}
      />
    ));

    await waitFor(() => {
      expect(container.querySelector('.hl')).not.toBeNull();
    });
  });
});
