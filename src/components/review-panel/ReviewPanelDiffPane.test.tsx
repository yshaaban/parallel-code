import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { createReviewSession } from '../../app/review-session';
import type { ChangedFile, FileDiffResult } from '../../ipc/types';

vi.mock('../MonacoDiffEditor', () => ({
  MonacoDiffEditor: () => <div>Monaco diff editor</div>,
}));

vi.mock('../ScrollingDiffView', () => ({
  ScrollingDiffView: () => <div>Scrolling diff view</div>,
}));

import { ReviewPanelDiffPane } from './ReviewPanelDiffPane';

function createChangedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    committed: false,
    lines_added: 5,
    lines_removed: 2,
    path: 'src/first.ts',
    status: 'modified',
    ...overrides,
  };
}

function createFileDiffResult(content: string): FileDiffResult {
  return {
    diff: `diff ${content}`,
    newContent: content,
    oldContent: `old ${content}`,
  };
}

describe('ReviewPanelDiffPane', () => {
  it('renders the fallback message when no diff is selected', () => {
    render(() => (
      <ReviewPanelDiffPane
        diff={null}
        emptyMessage="Select a file"
        loading={false}
        monacoRevealLine={null}
        parsedDiffFiles={[]}
        reviewDiffRequest={{ worktreePath: '/tmp/task-1' }}
        reviewSession={createReviewSession()}
        reviewSidebarProps={{
          annotations: [],
          canSubmit: false,
          onDismiss: vi.fn(),
          onScrollTo: vi.fn(),
          onUpdate: vi.fn(),
          onSubmit: vi.fn(),
        }}
        selectedFile={undefined}
        showSidebar={false}
        sideBySide={false}
        startAskSession={vi.fn()}
      />
    ));

    expect(screen.getByText('Select a file')).toBeDefined();
  });

  it('renders the diff body and sidebar from pre-derived props', () => {
    const reviewSession = createReviewSession();

    render(() => (
      <ReviewPanelDiffPane
        diff={createFileDiffResult('first')}
        emptyMessage="Select a file"
        loading={false}
        monacoRevealLine={null}
        parsedDiffFiles={[]}
        reviewDiffRequest={{ worktreePath: '/tmp/task-1' }}
        reviewSession={reviewSession}
        reviewSidebarProps={{
          annotations: [
            {
              comment: 'Use a more specific name.',
              endLine: 4,
              id: 'annotation-1',
              selectedText: 'const answer = 42;',
              source: 'src/first.ts',
              startLine: 4,
            },
          ],
          canSubmit: true,
          onDismiss: vi.fn(),
          onScrollTo: vi.fn(),
          onUpdate: vi.fn(),
          onSubmit: vi.fn(),
        }}
        selectedFile={createChangedFile()}
        showSidebar
        sideBySide={false}
        startAskSession={vi.fn()}
      />
    ));

    expect(screen.getByText('src/first.ts')).toBeDefined();
    expect(screen.getByText('Scrolling diff view')).toBeDefined();
    expect(screen.getByText('Review Comments (1)')).toBeDefined();
  });
});
