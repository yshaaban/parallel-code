import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  admitDesktopTaskNotesRemoval,
  completeDesktopTaskNotesRemoval,
  publishDetachedDesktopTaskNotes,
  publishUnsavedDesktopTaskNotes,
  registerDesktopTaskNotesOwner,
  subscribeDetachedDesktopTaskNotesChannel,
} from './task-notes-recovery-channel';

describe('desktop task notes recovery channel', () => {
  beforeEach(() => {
    publishUnsavedDesktopTaskNotes([]);
    publishDetachedDesktopTaskNotes([]);
  });

  it('does not emit unchanged attached-task recovery projections but emits detached edits', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDetachedDesktopTaskNotesChannel(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    publishDetachedDesktopTaskNotes([]);
    publishDetachedDesktopTaskNotes([]);
    expect(listener).toHaveBeenCalledTimes(1);

    publishDetachedDesktopTaskNotes([{ draft: 'first', taskId: 'task-1', taskName: 'Task one' }]);
    expect(listener).toHaveBeenCalledTimes(2);
    publishDetachedDesktopTaskNotes([{ draft: 'first', taskId: 'task-1', taskName: 'Task one' }]);
    expect(listener).toHaveBeenCalledTimes(2);
    publishDetachedDesktopTaskNotes([{ draft: 'second', taskId: 'task-1', taskName: 'Task one' }]);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it('admits explicit discard and delegates retirement only after the caller commits removal', async () => {
    const retireRemovedTask = vi.fn();
    registerDesktopTaskNotesOwner({
      discardRecovered: vi.fn(),
      reconcileTasks: vi.fn(),
      retireRemovedTask,
    });
    publishUnsavedDesktopTaskNotes(['task-1']);
    const confirmDiscard = vi.fn().mockResolvedValue(false);

    await expect(admitDesktopTaskNotesRemoval('task-1', { confirmDiscard })).resolves.toBe(false);
    expect(retireRemovedTask).not.toHaveBeenCalled();

    confirmDiscard.mockResolvedValue(true);
    await expect(admitDesktopTaskNotesRemoval('task-1', { confirmDiscard })).resolves.toBe(true);
    expect(retireRemovedTask).not.toHaveBeenCalled();

    completeDesktopTaskNotesRemoval('task-1');
    expect(retireRemovedTask).toHaveBeenCalledWith('task-1');
  });
});
