import { render, screen, waitFor } from '@solidjs/testing-library';
import { Show, createEffect, type JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DiffViewerDialog } from './DiffViewerDialog';

const { fetchTaskAllDiffsMock, scrollingDiffViewPropsRef } = vi.hoisted(() => ({
  fetchTaskAllDiffsMock: vi.fn(),
  scrollingDiffViewPropsRef: {
    current: null as null | {
      files: unknown[];
      scrollToPath: string | null;
      searchQuery?: string;
    },
  },
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
  }) => {
    createEffect(() => {
      scrollingDiffViewPropsRef.current = {
        files: props.files,
        scrollToPath: props.scrollToPath,
        searchQuery: props.searchQuery,
      };
    });
    return <div>Scrolling diff view</div>;
  },
}));

describe('DiffViewerDialog', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    fetchTaskAllDiffsMock.mockReset();
    scrollingDiffViewPropsRef.current = null;
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
});
