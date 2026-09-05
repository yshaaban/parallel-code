import { describe, expect, it } from 'vitest';

import type { TaskNotesControllerSnapshot } from './task-notes-controller';
import type { TaskNotesErrorReason } from './task-notes-draft';
import { getTaskNotesPresentation } from './task-notes-presentation';

const ERROR_MESSAGES: readonly [TaskNotesErrorReason, string][] = [
  [
    'operation-counter-exhausted',
    'Task notes operation counter is exhausted. Copy the draft and reopen the editor.',
  ],
  ['editor-generation-exhausted', 'Task notes editor generation is exhausted.'],
  ['notes-unavailable', 'Task notes are temporarily unavailable.'],
  ['invalid-draft', 'Task notes exceed the supported UTF-8 byte limit or contain invalid Unicode.'],
  ['task-unavailable', 'Task state is temporarily unavailable.'],
  [
    'terminal-facts-conflict',
    'Conflicting terminal facts were received for the same notes operation.',
  ],
  ['save-identity-expired', 'The save identity expired. Review current notes before saving again.'],
  ['request-failed', 'Task notes request failed (forbidden).'],
  ['transport-interrupted', 'Task notes transport was interrupted.'],
];

describe('task notes error presentation', () => {
  it.each(ERROR_MESSAGES)('owns exact copy for %s', (reason, message) => {
    const snapshot = {
      savedNoticeVisible: false,
      slowSaving: false,
      state: {
        draft: 'recover me',
        generation: 1,
        kind: 'error',
        reason,
        recovery: 'none',
        ...(reason === 'request-failed' ? { requestCode: 'forbidden' } : {}),
        taskId: 'task-1',
      },
    } as TaskNotesControllerSnapshot;

    expect(getTaskNotesPresentation(snapshot).message).toBe(message);
  });
});
