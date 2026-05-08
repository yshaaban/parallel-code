import { render, waitFor } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { TaskShellToolbar } from './TaskShellToolbar';

describe('TaskShellToolbar', () => {
  it('clears the toolbar focus ref on unmount', async () => {
    const toolbarRefs: Array<HTMLDivElement | undefined> = [];
    const result = render(() => (
      <TaskShellToolbar
        bookmarks={[]}
        focused={false}
        selectedIndex={0}
        openTerminalTitle="Open terminal"
        onToolbarClick={vi.fn()}
        onToolbarFocus={vi.fn()}
        onToolbarBlur={vi.fn()}
        onToolbarKeyDown={vi.fn()}
        onOpenTerminal={vi.fn()}
        onRunBookmark={vi.fn()}
        setToolbarRef={(element) => toolbarRefs.push(element)}
      />
    ));

    await waitFor(() => {
      expect(toolbarRefs.at(-1)).toBeInstanceOf(HTMLDivElement);
    });

    result.unmount();

    expect(toolbarRefs.at(-1)).toBeUndefined();
  });
});
