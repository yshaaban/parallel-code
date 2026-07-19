import { describe, expect, it } from 'vitest';

import {
  getTaskCommandActionForFocusedSurface,
  isTypingTaskCommandFocusedSurface,
} from './task-command-focus';

describe('task command focus', () => {
  it.each(['ai-terminal', 'remote-terminal', 'terminal', 'shell:0', 'shell:02'])(
    'treats %s as a typing surface',
    (surface) => {
      expect(isTypingTaskCommandFocusedSurface(surface)).toBe(true);
      expect(getTaskCommandActionForFocusedSurface(surface, 'run command')).toBe(
        'type in the terminal',
      );
    },
  );

  it.each(['shell', 'shell:0junk', 'shell:0.5', 'shell:-1', 'shell-toolbar:0'])(
    'rejects malformed or non-terminal surface %s',
    (surface) => {
      expect(isTypingTaskCommandFocusedSurface(surface)).toBe(false);
      expect(getTaskCommandActionForFocusedSurface(surface, 'run command')).toBe('run command');
    },
  );
});
