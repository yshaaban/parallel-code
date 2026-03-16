import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReviewSession } from '../app/review-session';
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
      newContent: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n',
    });

    render(() => (
      <ScrollingDiffView
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
                oldStart: 6,
                oldCount: 2,
                newStart: 6,
                newCount: 2,
                lines: [
                  { type: 'context', content: 'line 6', oldLine: 6, newLine: 6 },
                  { type: 'context', content: 'line 7', oldLine: 7, newLine: 7 },
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

    fireEvent.click(screen.getByText('3 lines hidden'));

    await waitFor(() => {
      expect(screen.getByText('line 5')).toBeTruthy();
    });

    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
    expect(screen.getAllByText('4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('5').length).toBeGreaterThan(0);
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

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Add review comment...')).toBeTruthy();
    });

    fireEvent.input(screen.getByPlaceholderText('Add review comment...'), {
      target: { value: 'Need more context here' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Comment' })[1] as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getByText('Need more context here')).toBeTruthy();
    });
  });

  it('scrolls the diff viewer with keyboard navigation', () => {
    const reviewSession = createReviewSession();
    const { container } = render(() => (
      <ScrollingDiffView
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

  it('renders syntax-highlighted diff lines when highlighter output is available', async () => {
    highlightLinesMock.mockResolvedValue(['<span class="hl">line 6</span>']);

    const { container } = render(() => (
      <ScrollingDiffView
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
