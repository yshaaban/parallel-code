import { describe, expect, it } from 'vitest';

import {
  createTaskNotesCapability,
  DESKTOP_TASK_NOTES_CAPABILITY,
  UNAVAILABLE_TASK_NOTES_CAPABILITY,
} from './task-notes-capability';

describe('task-notes capability defaults', () => {
  it('keeps startup dark until backend capability readiness is advertised', () => {
    expect(DESKTOP_TASK_NOTES_CAPABILITY).toEqual({ read: false, write: false });
    expect(Object.isFrozen(DESKTOP_TASK_NOTES_CAPABILITY)).toBe(true);
    expect(UNAVAILABLE_TASK_NOTES_CAPABILITY).toEqual({ read: false, write: false });
    expect(UNAVAILABLE_TASK_NOTES_CAPABILITY).toBe(DESKTOP_TASK_NOTES_CAPABILITY);
  });

  it('never advertises write without the read capability required to open notes', () => {
    expect(createTaskNotesCapability(false, true)).toEqual({ read: false, write: false });
    const writable = createTaskNotesCapability(true, true);
    expect(writable).toEqual({ read: true, write: true });
    expect(Object.isFrozen(writable)).toBe(true);
  });
});
