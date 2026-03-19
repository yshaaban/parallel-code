import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Show, createEffect, type JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewSession } from '../app/review-session';
import { DiffViewerDialog } from './DiffViewerDialog';

const { fetchTaskAllDiffsMock, scrollingDiffViewPropsRef, writeTextMock } = vi.hoisted(() => ({
  fetchTaskAllDiffsMock: vi.fn(),
  scrollingDiffViewPropsRef: {
    current: null as null | {
      files: unknown[];
      scrollToPath: string | null;
      searchQuery?: string;
    },
  },
  writeTextMock: vi.fn(async () => undefined),
}));

vi.mock('../app/review-diffs', () => ({
  createTaskReviewDiffRequest: vi.fn((request) => request),
  fetchTaskAllDiffs: fetchTaskAllDiffsMock,
}));

vi.mock('./Dialog', () => ({
  Dialog: (props: { children: JSX.Element; open: boolean }) => (
    <Show when={props.open}>
      <div>{props.children}</div>
    </Show>
  ),
}));

vi.mock('./ScrollingDiffView', () => ({
  ScrollingDiffView: (props: {
    files: unknown[];
    scrollToPath: string | null;
    searchQuery?: string;
    reviewSession: ReviewSession;
  }) => {
    createEffect(() => {
      scrollingDiffViewPropsRef.current = {
        files: props.files,
        scrollToPath: props.scrollToPath,
        searchQuery: props.searchQuery,
      };
    });

    function addReviewComment(): void {
      props.reviewSession.handleSelection({
        source: props.scrollToPath ?? 'src/a.ts',
        startLine: 2,
        endLine: 2,
        selectedText: 'const value = 1;',
      });
      props.reviewSession.submitSelection('Explain this change more clearly.', 'review');
    }

    return (
      <div>
        <div>Scrolling diff view</div>
        <button onClick={addReviewComment}>Add review comment</button>
      </div>
    );
  },
}));

describe('DiffViewerDialog', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    fetchTaskAllDiffsMock.mockReset();
    scrollingDiffViewPropsRef.current = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('loads all diffs and passes the selected file path to the scrolling view', async () => {
    fetchTaskAllDiffsMock.mockResolvedValue(`diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1 @@
+beta
`);

    render(() => (
      <DiffViewerDialog
        file={{
          committed: true,
          lines_added: 1,
          lines_removed: 1,
          path: 'src/b.ts',
          status: 'A',
        }}
        worktreePath="/tmp/task"
        onClose={() => {}}
      />
    ));

    await waitFor(() => {
      expect(screen.getByText('2 files changed')).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText('Scrolling diff view')).toBeTruthy();
    });
    expect(scrollingDiffViewPropsRef.current?.scrollToPath).toBe('src/b.ts');
    expect(scrollingDiffViewPropsRef.current?.files).toHaveLength(2);
  });

  it('copies diff review comments through the shared review sidebar actions', async () => {
    fetchTaskAllDiffsMock.mockResolvedValue(`diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`);

    render(() => (
      <DiffViewerDialog
        file={{
          committed: true,
          lines_added: 1,
          lines_removed: 1,
          path: 'src/a.ts',
          status: 'M',
        }}
        worktreePath="/tmp/task"
        onClose={() => {}}
      />
    ));

    expect(await screen.findByText('Scrolling diff view')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add review comment' }));

    expect(await screen.findByRole('button', { name: 'Copy Comments' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Comments' }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        [
          'Please address these file review comments:',
          '',
          '- src/a.ts | line 2 | begins with: const value = 1;',
          '  Comment: Explain this change more clearly.',
        ].join('\n'),
      );
    });

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });
});
