import { describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  get: vi.fn(),
  listen: vi.fn(() => vi.fn()),
}));

function loadedNotes(notes = 'base', taskIncarnation = 'B'.repeat(43)) {
  return {
    ok: true,
    result: {
      current: {
        currentNotes: {
          kind: 'present',
          snapshot: {
            contentVersion: 'A'.repeat(43),
            notes,
            taskId: 'task-1',
            taskIncarnation,
            workspaceRevision: notes === 'base' ? 1 : 2,
          },
        },
        currentTask: {
          catalogVersion: notes === 'base' ? 1 : 2,
          serverInstanceId: 'server-1',
          taskClosing: false,
          taskIncarnation,
          taskState: 'present',
        },
        relation: 'same-incarnation',
      },
      kind: 'loaded',
    },
  } as const;
}

vi.mock('../lib/ipc-events', () => ({
  listenTaskNotesChanged: runtimeMocks.listen,
}));

vi.mock('./task-notes-transport', () => ({
  desktopTaskNotesTransport: {
    get: runtimeMocks.get,
    issue: vi.fn(),
    update: vi.fn(),
  },
}));

import {
  discardRecoveredDesktopTaskNotes,
  publishDesktopTaskIds,
  publishDetachedDesktopTaskNotes,
  subscribeDetachedDesktopTaskNotesChannel,
} from './task-notes-recovery-channel';

describe('desktop task notes runtime recovery projection', () => {
  it('keeps the shared invalidation listener until every idempotent editor release completes', async () => {
    runtimeMocks.get.mockReset().mockResolvedValue(loadedNotes());
    runtimeMocks.listen.mockClear();
    const stop = vi.fn();
    runtimeMocks.listen.mockReturnValueOnce(stop);
    const { mountDesktopTaskNotes } = await import('./task-notes-runtime');
    const first = mountDesktopTaskNotes('task-1');
    const second = mountDesktopTaskNotes('task-1');

    expect(runtimeMocks.listen).toHaveBeenCalledOnce();
    first.release();
    first.release();
    expect(stop).not.toHaveBeenCalled();
    second.release();
    expect(stop).toHaveBeenCalledOnce();
    discardRecoveredDesktopTaskNotes('task-1');
  });

  it('does not acquire the shared listener when registry mounting fails', async () => {
    runtimeMocks.listen.mockClear();
    const { mountDesktopTaskNotes } = await import('./task-notes-runtime');

    expect(() => mountDesktopTaskNotes('')).toThrow('Invalid task ID');
    expect(runtimeMocks.listen).not.toHaveBeenCalled();
  });

  it('avoids app-shell emissions for attached edits and emits detached draft changes', async () => {
    runtimeMocks.get.mockResolvedValue(loadedNotes());
    publishDetachedDesktopTaskNotes([]);
    publishDesktopTaskIds(['task-1']);
    const listener = vi.fn();
    const unsubscribe = subscribeDetachedDesktopTaskNotesChannel(listener);
    const { mountDesktopTaskNotes } = await import('./task-notes-runtime');
    const mounted = mountDesktopTaskNotes('task-1', 'Task one');
    await vi.waitFor(() => expect(mounted.controller.state.kind).toBe('clean'));

    mounted.controller.edit('attached draft');
    expect(listener).toHaveBeenCalledTimes(1);

    publishDesktopTaskIds([]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith([
      { draft: 'attached draft', taskId: 'task-1', taskName: 'Task one' },
    ]);

    mounted.controller.edit('detached draft changed');
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenLastCalledWith([
      { draft: 'detached draft changed', taskId: 'task-1', taskName: 'Task one' },
    ]);

    mounted.release();
    discardRecoveredDesktopTaskNotes('task-1');
    unsubscribe();
  });

  it('projects only detached same-id replacement recovery and reloads after deliberate discard', async () => {
    runtimeMocks.get.mockReset();
    runtimeMocks.get
      .mockResolvedValueOnce(loadedNotes())
      .mockResolvedValue(loadedNotes('replacement notes', 'C'.repeat(43)));
    publishDetachedDesktopTaskNotes([]);
    publishDesktopTaskIds(['task-1']);
    const listener = vi.fn();
    const unsubscribe = subscribeDetachedDesktopTaskNotesChannel(listener);
    const { mountDesktopTaskNotes } = await import('./task-notes-runtime');
    const mounted = mountDesktopTaskNotes('task-1', 'Original task');
    await vi.waitFor(() => expect(mounted.controller.state.kind).toBe('clean'));
    mounted.controller.edit('old incarnation draft');
    expect(listener).toHaveBeenCalledTimes(1);

    mounted.controller.applyLifecycle({
      catalogVersion: 2,
      serverInstanceId: 'server-1',
      taskClosing: false,
      taskIncarnation: 'C'.repeat(43),
      taskState: 'present',
    });

    expect(mounted.controller.state).toMatchObject({
      draft: 'old incarnation draft',
      kind: 'orphaned',
      reason: 'task-replaced',
    });
    expect(listener).toHaveBeenCalledTimes(1);

    mounted.release();
    expect(listener).toHaveBeenLastCalledWith([
      { draft: 'old incarnation draft', taskId: 'task-1', taskName: 'Original task' },
    ]);

    const transitionMount = mountDesktopTaskNotes('task-1', 'Replacement task');
    expect(listener).toHaveBeenLastCalledWith([]);
    transitionMount.release();
    expect(listener).toHaveBeenLastCalledWith([
      { draft: 'old incarnation draft', taskId: 'task-1', taskName: 'Original task' },
    ]);

    discardRecoveredDesktopTaskNotes('task-1');
    expect(listener).toHaveBeenLastCalledWith([]);
    const fresh = mountDesktopTaskNotes('task-1', 'Replacement task');
    await vi.waitFor(() => expect(fresh.controller.state.kind).toBe('clean'));
    expect(fresh.controller.state.draft).toBe('replacement notes');
    expect(runtimeMocks.get).toHaveBeenCalledTimes(3);

    fresh.release();
    discardRecoveredDesktopTaskNotes('task-1');
    unsubscribe();
  });
});
