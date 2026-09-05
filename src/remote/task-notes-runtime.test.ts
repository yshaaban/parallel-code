import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  connectionListener: undefined as
    | ((status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting') => void)
    | undefined,
  get: vi.fn(),
}));

vi.mock('./client-id', () => ({ getRemoteClientId: () => 'remote-client-1' }));
vi.mock('./ws', () => ({
  subscribeRemoteConnectionStatus: (
    listener: (status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting') => void,
  ) => {
    runtimeMocks.connectionListener = listener;
    listener('connected');
    return () => undefined;
  },
}));
vi.mock('./remote-ipc', () => ({
  remoteTaskNotesTransport: {
    get: runtimeMocks.get,
    issue: vi.fn(),
    update: vi.fn(),
  },
}));

describe('remote task notes runtime', () => {
  beforeEach(() => {
    runtimeMocks.get.mockReset();
    runtimeMocks.get.mockResolvedValue({
      ok: true,
      result: {
        current: {
          currentNotes: {
            kind: 'present',
            snapshot: {
              contentVersion: 'A'.repeat(43),
              notes: 'current',
              taskId: 'task-1',
              taskIncarnation: 'B'.repeat(43),
              workspaceRevision: 1,
            },
          },
          currentTask: {
            catalogVersion: 1,
            serverInstanceId: 'server-1',
            taskClosing: false,
            taskIncarnation: 'B'.repeat(43),
            taskState: 'present',
          },
          relation: 'same-incarnation',
        },
        kind: 'loaded',
      },
    });
  });

  it('refetches mounted editors after reconnect and ignores detached drafts', async () => {
    const { confirmRemoteTaskNotesLeave, mountRemoteTaskNotes } =
      await import('./task-notes-runtime');
    const mounted = mountRemoteTaskNotes('task-1');
    await vi.waitFor(() => expect(runtimeMocks.get).toHaveBeenCalledOnce());

    runtimeMocks.connectionListener?.('reconnecting');
    runtimeMocks.connectionListener?.('connected');
    await vi.waitFor(() => expect(runtimeMocks.get).toHaveBeenCalledTimes(2));

    mounted.release();
    runtimeMocks.connectionListener?.('reconnecting');
    runtimeMocks.connectionListener?.('connected');
    await Promise.resolve();
    expect(runtimeMocks.get).toHaveBeenCalledTimes(2);
    confirmRemoteTaskNotesLeave('task-1', 'discard', () => true);
  });

  it('navigates clean removal and retains dirty removal recovery while ignoring stale lifecycle', async () => {
    const {
      applyRemoteTaskNotesCatalogLifecycle,
      confirmRemoteTaskNotesLeave,
      hasUnsavedRemoteTaskNotes,
      mountRemoteTaskNotes,
      registerRemoteTaskNotesNavigation,
    } = await import('./task-notes-runtime');
    const cleanNavigation = vi.fn();
    const clean = mountRemoteTaskNotes('task-1');
    const unregisterClean = registerRemoteTaskNotesNavigation('task-1', cleanNavigation);
    await vi.waitFor(() => expect(runtimeMocks.get).toHaveBeenCalledOnce());

    applyRemoteTaskNotesCatalogLifecycle('task-1', {
      catalogVersion: 2,
      serverInstanceId: 'server-1',
      taskClosing: false,
      taskState: 'removed',
    });

    expect(cleanNavigation).toHaveBeenCalledOnce();
    expect(hasUnsavedRemoteTaskNotes('task-1')).toBe(false);
    clean.release();
    unregisterClean();

    runtimeMocks.get.mockClear();
    const dirtyNavigation = vi.fn();
    const dirty = mountRemoteTaskNotes('task-1');
    const unregisterDirty = registerRemoteTaskNotesNavigation('task-1', dirtyNavigation);
    await vi.waitFor(() => expect(runtimeMocks.get).toHaveBeenCalledOnce());
    dirty.controller.edit('recover me');
    applyRemoteTaskNotesCatalogLifecycle('task-1', {
      catalogVersion: 4,
      serverInstanceId: 'server-1',
      taskClosing: false,
      taskState: 'removed',
    });

    expect(dirtyNavigation).not.toHaveBeenCalled();
    expect(hasUnsavedRemoteTaskNotes('task-1')).toBe(true);
    expect(dirty.controller.state).toMatchObject({ kind: 'orphaned', draft: 'recover me' });

    applyRemoteTaskNotesCatalogLifecycle('task-1', {
      catalogVersion: 3,
      serverInstanceId: 'server-1',
      taskClosing: false,
      taskState: 'present',
    });
    expect(dirty.controller.state).toMatchObject({ kind: 'orphaned', draft: 'recover me' });

    expect(confirmRemoteTaskNotesLeave('task-1', 'discard', () => true)).toBe(true);
    dirty.release();
    unregisterDirty();
  });
});
