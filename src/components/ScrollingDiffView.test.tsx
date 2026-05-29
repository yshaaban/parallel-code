import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createReviewSession,
  type ReviewAnnotation,
  type ReviewQuestion,
  type ReviewSession,
} from '../app/review-session';
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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

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

type SingleLineDiffViewRender = ReturnType<typeof render> & {
  lineText: () => HTMLElement;
  reviewSession: ReviewSession;
  scrollContainer: () => HTMLDivElement;
};

interface SingleLineDiffViewOptions {
  highlightedHtml?: string;
  lineContent?: string;
  searchQuery?: string;
}

function mockSingleLineDiffSelection(): void {
  getDiffSelectionMock.mockReturnValue({
    filePath: 'src/demo.ts',
    startLine: 6,
    endLine: 6,
    selectedText: 'line 6',
  });
}

function renderSingleLineDiffView(
  reviewSession = createReviewSession(),
  options: SingleLineDiffViewOptions = {},
): SingleLineDiffViewRender {
  const lineContent = options.lineContent ?? 'line 6';
  if (options.highlightedHtml !== undefined) {
    highlightLinesMock.mockResolvedValueOnce([options.highlightedHtml]);
  }

  const result = render(() => (
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
              lines: [{ type: 'context', content: lineContent, oldLine: 6, newLine: 6 }],
            },
          ],
        },
      ]}
      request={{ worktreePath: '/tmp/task' }}
      reviewSession={reviewSession}
      scrollToPath={null}
      searchQuery={options.searchQuery}
      startAskSession={startAskSessionMock}
    />
  ));

  return {
    ...result,
    lineText: () => screen.getByText(lineContent),
    reviewSession,
    scrollContainer: () => result.container.querySelector('[tabindex="0"]') as HTMLDivElement,
  };
}

function getDiffLineText(container: HTMLElement): HTMLElement {
  const lineText = container.querySelector('[data-diff-line-text="true"]');
  if (!lineText) {
    throw new Error('Expected rendered diff line text');
  }

  return lineText as HTMLElement;
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

  it('does not fetch or synthesize hidden-gap context for added files', async () => {
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

    await waitForVisibleText('line 3');

    expect(
      container.querySelector('[data-line-content="line 1"][data-line-type="add"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-line-content="line 5"][data-line-type="add"]'),
    ).toBeNull();
    expect(fetchTaskFileDiffMock).not.toHaveBeenCalled();
  });

  it('soft-wraps long diff lines instead of forcing horizontal scrolling', () => {
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
                oldCount: 1,
                newStart: 1,
                newCount: 1,
                lines: [
                  {
                    type: 'context',
                    content:
                      'this is a very long diff line that should wrap instead of forcing horizontal scrolling in the review surface',
                    oldLine: 1,
                    newLine: 1,
                  },
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

    const lineSpan = screen.getByText(/this is a very long diff line/i).parentElement;
    expect(lineSpan?.getAttribute('style')).toContain('white-space:pre-wrap');
    expect(lineSpan?.getAttribute('style')).toContain('overflow-wrap:break-word');
  });

  it('shows a deleted-file banner instead of trying to render hidden-gap fetches', async () => {
    render(() => (
      <ScrollingDiffView
        file={createChangedFile({ committed: true, path: 'src/removed.ts', status: 'deleted' })}
        files={[
          {
            path: 'src/removed.ts',
            status: 'D',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldCount: 1,
                newStart: 0,
                newCount: 0,
                lines: [{ type: 'remove', content: 'removed line', oldLine: 1, newLine: null }],
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

    expect(screen.queryByText('This file was deleted')).not.toBeNull();
    await Promise.resolve();
    expect(fetchTaskFileDiffMock).not.toHaveBeenCalled();
  });

  it('adds an inline review comment from the current diff selection', async () => {
    mockSingleLineDiffSelection();
    const { lineText } = renderSingleLineDiffView();

    fireEvent.mouseDown(lineText());
    fireEvent.mouseUp(lineText());

    const commentInput = await screen.findByPlaceholderText('Add review comment...');

    fireEvent.input(commentInput, {
      target: { value: 'Need more context here' },
    });
    fireEvent.keyDown(commentInput, { key: 'Enter' });

    await waitForVisibleText('Need more context here');
  });

  it('ignores stale selections when blank diff space is clicked', async () => {
    mockSingleLineDiffSelection();
    const { reviewSession, scrollContainer } = renderSingleLineDiffView();
    const diffContainer = scrollContainer();

    fireEvent.mouseDown(diffContainer);
    fireEvent.doubleClick(diffContainer);
    fireEvent.mouseUp(diffContainer);

    expect(getDiffSelectionMock).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Add review comment...')).toBeNull();
    expect(reviewSession.pendingSelection()).toBeNull();
  });

  it('preserves normal diff text selection after the pointer starts on line text', async () => {
    mockSingleLineDiffSelection();
    const { lineText, scrollContainer } = renderSingleLineDiffView();

    fireEvent.mouseDown(lineText());
    fireEvent.mouseUp(scrollContainer());

    expect(await screen.findByPlaceholderText('Add review comment...')).toBeDefined();
  });

  it('indexes inline review insertions once for rendered diff lines', async () => {
    const annotation: ReviewAnnotation = {
      comment: 'Cached comment',
      endLine: 3,
      id: 'annotation-1',
      selectedText: 'line 3',
      source: 'src/demo.ts',
      startLine: 3,
    };
    const question: ReviewQuestion = {
      afterLine: 4,
      endLine: 4,
      id: 'question-1',
      question: 'Cached question',
      selectedText: 'line 4',
      source: 'src/demo.ts',
      startLine: 4,
    };
    const annotationsMock = vi.fn(() => [annotation]);
    const activeQuestionsMock = vi.fn(() => [question]);
    const reviewSession = {
      ...createReviewSession(),
      activeQuestions: activeQuestionsMock,
      annotations: annotationsMock,
    } satisfies ReviewSession;

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
                oldCount: 5,
                newStart: 1,
                newCount: 5,
                lines: [
                  { type: 'context', content: 'line 1', oldLine: 1, newLine: 1 },
                  { type: 'context', content: 'line 2', oldLine: 2, newLine: 2 },
                  { type: 'context', content: 'line 3', oldLine: 3, newLine: 3 },
                  { type: 'context', content: 'line 4', oldLine: 4, newLine: 4 },
                  { type: 'context', content: 'line 5', oldLine: 5, newLine: 5 },
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

    await waitForVisibleText('Cached comment');
    await waitForVisibleText('Ask: Cached question');

    expect(annotationsMock).toHaveBeenCalledTimes(1);
    expect(activeQuestionsMock).toHaveBeenCalledTimes(1);
  });

  it('restores the scroll position when the first review comment opens the sidebar', async () => {
    mockSingleLineDiffSelection();
    const { lineText, scrollContainer: getScrollContainer } = renderSingleLineDiffView();
    const scrollContainer = getScrollContainer();
    let currentScrollTop = 120;
    Object.defineProperty(scrollContainer, 'scrollTop', {
      configurable: true,
      get: () => currentScrollTop,
      set: (value: number) => {
        currentScrollTop = value;
      },
    });
    fireEvent.mouseDown(lineText());
    fireEvent.mouseUp(lineText());

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

  it('does not fetch branch-sourced hidden gaps for added files', async () => {
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

    await waitForVisibleText('alpha');

    expect(screen.queryByText('6 lines hidden')).toBeNull();
    expect(fetchTaskFileDiffMock).not.toHaveBeenCalled();
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

  it('cancels queued scroll-target frames on unmount', async () => {
    const reviewSession = createReviewSession();
    const scrollTarget = {
      comment: 'Check this line',
      endLine: 6,
      id: 'annotation-1',
      selectedText: 'line 6',
      source: 'src/demo.ts',
      startLine: 6,
    };
    const pendingFrames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const frame = nextFrame;
      nextFrame += 1;
      pendingFrames.set(frame, callback);
      return frame;
    });
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frame) => {
      pendingFrames.delete(frame);
    });

    reviewSession.setScrollTarget(scrollTarget);
    const { unmount } = render(() => (
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

    await waitFor(() => {
      expect(pendingFrames.size).toBe(1);
    });

    unmount();
    const queuedCallbacks = [...pendingFrames.values()];
    pendingFrames.clear();
    queuedCallbacks.forEach((callback) => callback(0));

    expect(cancelRafSpy).toHaveBeenCalled();
    expect(reviewSession.scrollTarget()).toBe(scrollTarget);

    rafSpy.mockRestore();
    cancelRafSpy.mockRestore();
  });

  it('renders the binary diff fallback when the selected parsed file is binary', async () => {
    render(() => (
      <ScrollingDiffView
        file={createChangedFile({
          committed: true,
          path: 'assets/logo.bin',
          status: 'modified',
        })}
        files={[
          {
            path: 'assets/logo.bin',
            status: 'M',
            binary: true,
            hunks: [],
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

    await waitForVisibleText('Binary file - cannot display diff');
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

  it('clears stale highlighted HTML while replacement diff lines are waiting for highlighting', async () => {
    const firstHighlight = createDeferred<string[]>();
    const secondHighlight = createDeferred<string[]>();
    highlightLinesMock
      .mockReturnValueOnce(firstHighlight.promise)
      .mockReturnValueOnce(secondHighlight.promise);
    const [files, setFiles] = createSignal([
      {
        path: 'src/demo.ts',
        status: 'M' as const,
        binary: false,
        hunks: [
          {
            oldStart: 6,
            oldCount: 1,
            newStart: 6,
            newCount: 1,
            lines: [{ type: 'context' as const, content: 'old line', oldLine: 6, newLine: 6 }],
          },
        ],
      },
    ]);

    const { container } = render(() => (
      <ScrollingDiffView
        file={createChangedFile()}
        files={files()}
        request={{ worktreePath: '/tmp/task' }}
        reviewSession={createReviewSession()}
        scrollToPath={null}
        startAskSession={startAskSessionMock}
      />
    ));

    firstHighlight.resolve(['<span class="old-highlight">old line</span>']);
    await waitFor(() => {
      expect(container.querySelector('.old-highlight')).not.toBeNull();
    });

    setFiles([
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
            lines: [{ type: 'context', content: 'new line', oldLine: 6, newLine: 6 }],
          },
        ],
      },
    ]);

    await waitFor(() => {
      expect(getDiffLineText(container).textContent).toBe('new line');
    });
    expect(container.querySelector('.old-highlight')).toBeNull();

    secondHighlight.resolve(['<span class="new-highlight">new line</span>']);
    await waitFor(() => {
      expect(container.querySelector('.new-highlight')).not.toBeNull();
    });
  });

  it('does not treat escaped entity source text as searchable highlighted diff text', async () => {
    const { container } = renderSingleLineDiffView(createReviewSession(), {
      highlightedHtml: 'x &amp; y',
      lineContent: 'x & y',
      searchQuery: 'amp',
    });

    await waitFor(() => {
      const lineText = getDiffLineText(container);
      expect(lineText.innerHTML).toBe('x &amp; y');
    });
    const lineText = getDiffLineText(container);
    expect(lineText.querySelector('mark')).toBeNull();
    expect(lineText.textContent).toBe('x & y');
  });

  it('marks visible entity characters without corrupting escaped highlighted diff HTML', async () => {
    const { container } = renderSingleLineDiffView(createReviewSession(), {
      highlightedHtml: 'x &amp; y',
      lineContent: 'x & y',
      searchQuery: '&',
    });

    await waitFor(() => {
      const lineText = getDiffLineText(container);
      expect(lineText.querySelector('mark')?.textContent).toBe('&');
    });
    const lineText = getDiffLineText(container);
    expect(lineText.textContent).toBe('x & y');
    expect(lineText.innerHTML).not.toContain('&<mark');
  });

  it('marks parsed text nodes inside highlighted spans instead of editing raw HTML', async () => {
    const { container } = renderSingleLineDiffView(createReviewSession(), {
      highlightedHtml: '<span class="hl">&lt;alpha&gt;</span>',
      lineContent: '<alpha>',
      searchQuery: '<al',
    });

    await waitFor(() => {
      const lineText = getDiffLineText(container);
      expect(lineText.querySelector('.hl mark')?.textContent).toBe('<al');
    });
    const lineText = getDiffLineText(container);
    expect(lineText.textContent).toBe('<alpha>');
    expect(lineText.innerHTML).toContain('&lt;');
  });
});
