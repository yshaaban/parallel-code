import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { GitStatusSyncEvent } from '../domain/server-state';
import type { ChangedFile, FileDiffResult } from '../ipc/types';

const { invokeMock, isElectronRuntimeMock, listenForGitStatusChangedMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isElectronRuntimeMock: vi.fn(),
  listenForGitStatusChangedMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
  isElectronRuntime: isElectronRuntimeMock,
}));

vi.mock('../runtime/git-status-events', () => ({
  listenForGitStatusChanged: listenForGitStatusChangedMock,
}));

vi.mock('./MonacoDiffEditor', () => ({
  MonacoDiffEditor: (props: {
    oldContent: string;
    newContent: string;
    language: string;
    sideBySide: boolean;
  }) => (
    <div data-testid="diff-editor">
      {props.language}:{props.sideBySide ? 'split' : 'unified'}:{props.newContent}
    </div>
  ),
}));

import { ReviewPanel } from './ReviewPanel';

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

describe('ReviewPanel', () => {
  let onGitStatusChanged: ((message: GitStatusSyncEvent) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    onGitStatusChanged = undefined;
    listenForGitStatusChangedMock.mockImplementation((listener) => {
      onGitStatusChanged = listener;
      return () => {
        onGitStatusChanged = undefined;
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes the file list from pushed git events in browser mode', async () => {
    isElectronRuntimeMock.mockReturnValue(false);

    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.GetProjectDiff) {
        const calls = invokeMock.mock.calls.filter(
          ([currentChannel]) => currentChannel === channel,
        );
        if (calls.length === 1) {
          return Promise.resolve({
            files: [createChangedFile({ path: 'src/first.ts' })],
            totalAdded: 5,
            totalRemoved: 2,
          });
        }

        return Promise.resolve({
          files: [createChangedFile({ path: 'src/updated.ts' })],
          totalAdded: 7,
          totalRemoved: 1,
        });
      }

      if (channel === IPC.GetFileDiff) {
        return Promise.resolve(createFileDiffResult('first'));
      }

      throw new Error(`Unexpected channel: ${channel}`);
    });

    render(() => (
      <ReviewPanel
        worktreePath="/tmp/task-1"
        branchName="feature/task-1"
        projectRoot="/tmp/project"
        isActive
      />
    ));

    expect(await screen.findByText('first.ts')).toBeDefined();

    onGitStatusChanged?.({
      worktreePath: '/tmp/task-1',
      branchName: 'feature/task-1',
      projectRoot: '/tmp/project',
    });

    await waitFor(() => {
      expect(screen.getByText('updated.ts')).toBeDefined();
    });
  });

  it('supports keyboard navigation and Electron polling', async () => {
    vi.useFakeTimers();
    isElectronRuntimeMock.mockReturnValue(true);

    invokeMock.mockImplementation((channel: IPC, args?: { filePath?: string }) => {
      if (channel === IPC.GetProjectDiff) {
        return Promise.resolve({
          files: [
            createChangedFile({ path: 'src/first.ts' }),
            createChangedFile({ path: 'src/second.ts', lines_added: 1, lines_removed: 0 }),
          ],
          totalAdded: 6,
          totalRemoved: 2,
        });
      }

      if (channel === IPC.GetFileDiff) {
        return Promise.resolve(createFileDiffResult(args?.filePath ?? 'missing'));
      }

      throw new Error(`Unexpected channel: ${channel}`);
    });

    render(() => <ReviewPanel worktreePath="/tmp/task-1" branchName="feature/task-1" isActive />);

    const reviewPanel = await screen.findByText('first.ts');
    expect(reviewPanel).toBeDefined();

    const root = reviewPanel.closest('[tabindex="0"]') as HTMLElement;
    fireEvent.keyDown(root, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        IPC.GetFileDiff,
        expect.objectContaining({ filePath: 'src/second.ts', worktreePath: '/tmp/task-1' }),
      );
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.GetProjectDiff),
    ).toHaveLength(2);
  });
});
