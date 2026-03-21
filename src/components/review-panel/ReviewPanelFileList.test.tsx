import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import type { ChangedFile } from '../../ipc/types';
import { ReviewPanelFileList } from './ReviewPanelFileList';

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

describe('ReviewPanelFileList', () => {
  it('renders the empty state message when there are no files', () => {
    render(() => (
      <ReviewPanelFileList
        emptyMessage="No changes"
        files={[]}
        onSelect={vi.fn()}
        selectedIndex={0}
      />
    ));

    expect(screen.getByText('No changes')).toBeDefined();
  });

  it('renders file rows and forwards selection changes', () => {
    const onSelect = vi.fn();

    render(() => (
      <ReviewPanelFileList
        emptyMessage="No changes"
        files={[createChangedFile(), createChangedFile({ path: 'src/second.ts' })]}
        onSelect={onSelect}
        selectedIndex={0}
      />
    ));

    fireEvent.click(screen.getByText('second.ts'));

    expect(onSelect).toHaveBeenCalledWith(1);
    expect(screen.getAllByText('+5')).toHaveLength(2);
    expect(screen.getAllByText('-2')).toHaveLength(2);
  });

  it('renders a stable label for paths with trailing slashes', () => {
    render(() => (
      <ReviewPanelFileList
        emptyMessage="No changes"
        files={[createChangedFile({ path: '.worktrees/task/port/' })]}
        onSelect={vi.fn()}
        selectedIndex={0}
      />
    ));

    expect(screen.getByText('port')).toBeDefined();
  });

  it('scrolls the selected row into view when keyboard selection changes', async () => {
    function Harness() {
      const [selectedIndex, setSelectedIndex] = createSignal(-1);

      return (
        <>
          <button type="button" onClick={() => setSelectedIndex(1)}>
            next
          </button>
          <ReviewPanelFileList
            emptyMessage="No changes"
            files={[createChangedFile(), createChangedFile({ path: 'src/second.ts' })]}
            onSelect={vi.fn()}
            selectedIndex={selectedIndex()}
          />
        </>
      );
    }

    render(() => <Harness />);

    const firstRow = (await screen.findByText('first.ts')).closest('div[style]') as HTMLDivElement;
    const secondRow = screen.getByText('second.ts').closest('div[style]') as HTMLDivElement;
    const firstRowScrollSpy = vi.fn();
    const secondRowScrollSpy = vi.fn();

    Object.defineProperty(firstRow, 'scrollIntoView', {
      configurable: true,
      value: firstRowScrollSpy,
    });
    Object.defineProperty(secondRow, 'scrollIntoView', {
      configurable: true,
      value: secondRowScrollSpy,
    });

    fireEvent.click(screen.getByRole('button', { name: 'next' }));

    await waitFor(() => {
      expect(secondRowScrollSpy).toHaveBeenCalledTimes(1);
    });
    expect(firstRowScrollSpy).not.toHaveBeenCalled();
  });
});
