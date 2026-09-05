import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../electron/ipc/channels.js';

const { invokeMock, notificationMock, state } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  notificationMock: vi.fn(),
  state: { markdownViewer: null as unknown },
}));

vi.mock('../lib/ipc.js', () => ({ invoke: invokeMock }));
vi.mock('../store/notification.js', () => ({ showNotification: notificationMock }));
vi.mock('../store/state.js', () => ({
  setStore: (key: string, value: unknown) => {
    if (key === 'markdownViewer') {
      state.markdownViewer = value;
    }
  },
  store: state,
}));

import { closeMarkdownViewer, openMarkdownViewer } from './markdown-viewer.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('markdown viewer request ownership', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    notificationMock.mockReset();
    state.markdownViewer = null;
    closeMarkdownViewer();
  });

  it('opens inline content without a backend read', async () => {
    await expect(openMarkdownViewer({ content: '# Inline', fileName: 'inline.md' })).resolves.toBe(
      'opened',
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(state.markdownViewer).toMatchObject({ content: '# Inline', fileName: 'inline.md' });
  });

  it('sends task identity and projects the authoritative backend root', async () => {
    invokeMock.mockResolvedValue({
      content: '# File',
      fileName: 'guide.md',
      relativePath: 'docs/guide.md',
      worktreePath: '/backend/root',
    });

    await expect(
      openMarkdownViewer({ agentId: 'agent-1', relativePath: 'docs/guide.md', taskId: 'task-1' }),
    ).resolves.toBe('opened');
    expect(invokeMock).toHaveBeenCalledWith(IPC.ReadMarkdownFile, {
      agentId: 'agent-1',
      relativePath: 'docs/guide.md',
      taskId: 'task-1',
    });
    expect(state.markdownViewer).toMatchObject({
      content: '# File',
      taskId: 'task-1',
      worktreePath: '/backend/root',
    });
  });

  it('ignores reverse-order stale completions', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    invokeMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstOpen = openMarkdownViewer({ relativePath: 'first.md', taskId: 'task-1' });
    const secondOpen = openMarkdownViewer({ relativePath: 'second.md', taskId: 'task-1' });
    second.resolve({
      content: 'second',
      fileName: 'second.md',
      relativePath: 'second.md',
      worktreePath: '/root',
    });
    await expect(secondOpen).resolves.toBe('opened');
    first.resolve({
      content: 'first',
      fileName: 'first.md',
      relativePath: 'first.md',
      worktreePath: '/root',
    });
    await expect(firstOpen).resolves.toBe('superseded');
    expect(state.markdownViewer).toMatchObject({ content: 'second' });
  });

  it('does not reopen or notify after close while reading', async () => {
    const pending = deferred<unknown>();
    invokeMock.mockReturnValue(pending.promise);
    const opening = openMarkdownViewer({ relativePath: 'guide.md', taskId: 'task-1' });
    closeMarkdownViewer();
    pending.resolve(null);

    await expect(opening).resolves.toBe('superseded');
    expect(state.markdownViewer).toBeNull();
    expect(notificationMock).not.toHaveBeenCalled();
  });
});
