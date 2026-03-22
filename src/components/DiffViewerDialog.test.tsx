import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Show, createEffect, createSignal, type JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewSession } from '../app/review-session';
import type { ChangedFile, FileDiffResult } from '../ipc/types';
import { DiffViewerDialog } from './DiffViewerDialog';

const { fetchTaskFileDiffMock, scrollingDiffViewPropsRef, writeTextMock } = vi.hoisted(() => ({
  fetchTaskFileDiffMock: vi.fn(),
  scrollingDiffViewPropsRef: {
    current: null as null | {
      files: unknown[];
      filePaths: string[];
      scrollToPath: string | null;
      searchQuery?: string;
    },
  },
  writeTextMock: vi.fn(async () => undefined),
}));

vi.mock('../app/review-diffs', () => ({
  createTaskReviewDiffRequest: vi.fn((request) => request),
  fetchTaskFileDiff: fetchTaskFileDiffMock,
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
        filePaths: props.files.map((file) => (file as { path: string }).path),
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
    fetchTaskFileDiffMock.mockReset();
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

  function createChangedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
    return {
      committed: false,
      lines_added: 1,
      lines_removed: 1,
      path: 'src/a.ts',
      status: 'modified',
      ...overrides,
    };
  }

  function createFileDiffResult(diff: string): FileDiffResult {
    return {
      diff,
      newContent: 'new',
      oldContent: 'old',
    };
  }

  function createDeferredPromise<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
  } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    });

    return { promise, resolve };
  }

  it('loads the selected file diff and passes only that file to the scrolling view', async () => {
    fetchTaskFileDiffMock.mockResolvedValue(
      createFileDiffResult(`diff --git a/src/b.ts b/src/b.ts
new file mode 100644
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1 @@
+beta
`),
    );

    render(() => (
      <DiffViewerDialog
        file={createChangedFile({ committed: true, path: 'src/b.ts', status: 'A' })}
        worktreePath="/tmp/task"
        onClose={() => {}}
      />
    ));

    await waitFor(() => {
      expect(screen.getByText('1 file changed')).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText('Scrolling diff view')).toBeTruthy();
    });
    expect(fetchTaskFileDiffMock).toHaveBeenCalledWith(
      { worktreePath: '/tmp/task' },
      createChangedFile({ committed: true, path: 'src/b.ts', status: 'A' }),
    );
    expect(scrollingDiffViewPropsRef.current?.scrollToPath).toBe('src/b.ts');
    expect(scrollingDiffViewPropsRef.current?.files).toHaveLength(1);
    expect(scrollingDiffViewPropsRef.current?.filePaths).toEqual(['src/b.ts']);
  });

  it('copies diff review comments through the shared review sidebar actions', async () => {
    fetchTaskFileDiffMock.mockResolvedValue(
      createFileDiffResult(`diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`),
    );

    render(() => (
      <DiffViewerDialog
        file={createChangedFile({ committed: true, path: 'src/a.ts', status: 'M' })}
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

  it('ignores stale selected-file diff results when the user switches files mid-load', async () => {
    const firstDiff = createDeferredPromise<FileDiffResult>();
    const secondDiff = createDeferredPromise<FileDiffResult>();
    fetchTaskFileDiffMock
      .mockImplementationOnce(() => firstDiff.promise)
      .mockImplementationOnce(() => secondDiff.promise);

    let setFile!: (file: ChangedFile) => void;

    render(() => {
      const [file, setCurrentFile] = createSignal(
        createChangedFile({ path: 'src/first.ts', status: 'M' }),
      );
      setFile = setCurrentFile;

      return <DiffViewerDialog file={file()} worktreePath="/tmp/task" onClose={() => {}} />;
    });

    await waitFor(() => {
      expect(fetchTaskFileDiffMock).toHaveBeenCalledTimes(1);
    });

    setFile(createChangedFile({ path: 'src/second.ts', status: 'A' }));

    await waitFor(() => {
      expect(fetchTaskFileDiffMock).toHaveBeenCalledTimes(2);
    });

    secondDiff.resolve(
      createFileDiffResult(`diff --git a/src/second.ts b/src/second.ts
new file mode 100644
--- /dev/null
+++ b/src/second.ts
@@ -0,0 +1 @@
+second
`),
    );

    await waitFor(() => {
      expect(scrollingDiffViewPropsRef.current?.filePaths).toEqual(['src/second.ts']);
    });

    firstDiff.resolve(
      createFileDiffResult(`diff --git a/src/first.ts b/src/first.ts
index 1111111..2222222 100644
--- a/src/first.ts
+++ b/src/first.ts
@@ -1 +1 @@
-first
+older
`),
    );

    await waitFor(() => {
      expect(scrollingDiffViewPropsRef.current?.filePaths).toEqual(['src/second.ts']);
    });
  });
});
