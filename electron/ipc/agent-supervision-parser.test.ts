import { describe, expect, it } from 'vitest';

import { classifyOutputState, getExitPreview } from './agent-supervision-parser.js';

describe('agent supervision parser', () => {
  it('classifies a prompt-like tail as idle at prompt', () => {
    const result = classifyOutputState(
      '\u001b[32mBuild complete\u001b[0m\nready for next input\n❯ ',
    );

    expect(result).toEqual({
      preview: 'ready for next input',
      state: 'idle-at-prompt',
    });
  });

  it('classifies an interactive question as awaiting input', () => {
    const result = classifyOutputState(
      'Choose an option\nUse arrow keys to cycle\nSelect an option',
    );

    expect(result).toEqual({
      preview: 'Select an option',
      state: 'awaiting-input',
    });
  });

  it('returns the last non-empty exit line as the exit preview', () => {
    expect(getExitPreview(['', 'first line', 'last line'])).toBe('last line');
  });
});
