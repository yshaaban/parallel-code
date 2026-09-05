import { describe, expect, it, vi } from 'vitest';

import { createTaskNotesEventStream } from './task-notes-event-stream.js';

describe('task notes event stream', () => {
  it('accepts only the content-free contract, isolates listener failures, and cleans up subscriptions', () => {
    const events = createTaskNotesEventStream();
    const first = vi.fn(() => {
      throw new Error('disconnected');
    });
    const second = vi.fn();
    const unsubscribeFirst = events.subscribe(first);
    events.subscribe(second);

    expect(
      events.publish({ sourceId: null, taskId: 'task-1', workspaceRevision: 3, notes: 'secret' }),
    ).toBe(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    expect(events.publish({ sourceId: null, taskId: 'task-1', workspaceRevision: 3 })).toBe(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    unsubscribeFirst();
    expect(events.publish({ sourceId: null, taskId: 'task-1', workspaceRevision: 4 })).toBe(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });
});
