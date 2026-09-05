import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishTaskNotesInvalidation,
  resetTaskNotesInvalidationsForTests,
  subscribeTaskNotesInvalidation,
} from './task-notes-invalidation';

describe('task notes invalidation hub', () => {
  beforeEach(resetTaskNotesInvalidationsForTests);

  it('routes only validated content-free notifications to matching task subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTaskNotesInvalidation('task-1', listener);
    expect(
      publishTaskNotesInvalidation({ taskId: 'task-1', workspaceRevision: 2, sourceId: null }),
    ).toBe(true);
    expect(listener).toHaveBeenCalledWith({
      taskId: 'task-1',
      workspaceRevision: 2,
      sourceId: null,
    });
    expect(
      publishTaskNotesInvalidation({
        taskId: 'task-1',
        workspaceRevision: 3,
        sourceId: null,
        notes: 'must never be present',
      }),
    ).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    publishTaskNotesInvalidation({ taskId: 'task-1', workspaceRevision: 4, sourceId: null });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
